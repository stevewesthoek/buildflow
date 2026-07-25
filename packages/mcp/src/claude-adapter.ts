import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  WorkbenchMcpAdapterContractError,
  createWorkbenchMcpAdapterResult,
  defaultWorkbenchMcpExecutableAdapterCapabilities,
  type WorkbenchMcpAdapterDiagnostic,
  type WorkbenchMcpAdapterErrorCode,
  type WorkbenchMcpAdapterMutationEvidence,
  type WorkbenchMcpAdapterResult,
  type WorkbenchMcpAuditRequest,
  type WorkbenchMcpClientAdapter,
  type WorkbenchMcpConfigureRequest,
  type WorkbenchMcpExecutableAdapterCapabilities,
  type WorkbenchMcpRemoveRequest,
  type WorkbenchMcpStatusRequest
} from './adapter-contract.js'
import {
  configureClaude,
  inspectClaudeRegistration,
  removeClaude,
  type ClaudeConfigureHooks,
  type ClaudeConfigureOptions,
  type ClaudeRegistrationStatus
} from './configure-claude.js'
import {
  PROFILE_AVAILABILITY,
  WORKBENCH_CREDENTIAL_FILE_NAME,
  buildWorkbenchMcpServerSpec,
  canonicalNodeExecutable,
  canonicalProjectRoot
} from './configure-core.js'
import type {
  WorkbenchMcpRegistrationManifest,
  WorkbenchMcpRegistrationSelector
} from './registration-manifest.js'

export const CLAUDE_MCP_ADAPTER_ID = 'claude-code-local-v1' as const
export const CLAUDE_MCP_CLIENT_ID = 'claude-code' as const
export const CLAUDE_MCP_REGISTRATION_ID = 'workbench' as const

export type ClaudeMcpAdapterOptions = Omit<ClaudeConfigureOptions, 'profile'> & {
  configureHooks?: ClaudeConfigureHooks
  removeHooks?: { afterCliRemove?: () => void }
}

type FileSnapshot = {
  exists: boolean
  content?: Buffer
  mode?: number
}

function snapshotFile(file: string): FileSnapshot {
  try {
    const stat = fs.statSync(file)
    return { exists: true, content: fs.readFileSync(file), mode: stat.mode & 0o777 }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false }
    throw error
  }
}

function snapshotChanged(before: FileSnapshot, after: FileSnapshot): boolean {
  if (before.exists !== after.exists || before.mode !== after.mode) return true
  if (!before.exists || !after.exists) return false
  return !before.content?.equals(after.content ?? Buffer.alloc(0))
}

function noMutation(rollbackSupported = true): WorkbenchMcpAdapterMutationEvidence {
  return {
    state: 'none',
    changedPaths: [],
    rollback: {
      supported: rollbackSupported,
      attempted: false,
      status: 'not_required',
      restoredPaths: []
    }
  }
}

function diagnosticsForStatus(status: ClaudeRegistrationStatus): WorkbenchMcpAdapterDiagnostic[] {
  const diagnostics: WorkbenchMcpAdapterDiagnostic[] = []
  if (!status.configured && status.localMatchCount > 0) {
    diagnostics.push({ code: 'claude_registration_mismatch', message: 'Local Workbench entry does not match the selected profile.' })
  }
  if (status.userMatchCount !== 0) {
    diagnostics.push({ code: 'claude_user_scope_duplicate', message: `Found ${status.userMatchCount} user-scope Workbench definition(s).` })
  }
  if (status.localMatchCount !== 1) {
    diagnostics.push({ code: 'claude_local_scope_count', message: `Expected 1 local Workbench definition; found ${status.localMatchCount}.` })
  }
  if (status.claudeJsonMode !== '0600') {
    diagnostics.push({ code: 'claude_config_mode', message: `Expected ~/.claude.json mode 0600; found ${status.claudeJsonMode ?? 'missing'}.` })
  }
  if (status.credentialMode !== '0600') {
    diagnostics.push({ code: 'claude_credential_mode', message: `Expected shared credential mode 0600; found ${status.credentialMode ?? 'missing'}.` })
  }
  return diagnostics
}

function classifyClaudeError(error: unknown): WorkbenchMcpAdapterErrorCode {
  if (error instanceof WorkbenchMcpAdapterContractError) return error.code
  const message = error instanceof Error ? error.message : String(error)
  if (/already exists|duplicate|conflicting|processes are running|quiescence/i.test(message)) return 'conflict'
  if (/EACCES|EPERM|permission/i.test(message)) return 'permission_denied'
  if (/not found|ENOENT|timed out|timeout|Claude CLI/i.test(message)) return 'io_error'
  if (/must be|does not exist|invalid|validation failed/i.test(message)) return 'invalid_request'
  return 'internal'
}

export class ClaudeCodeMcpAdapter implements WorkbenchMcpClientAdapter {
  readonly adapterId = CLAUDE_MCP_ADAPTER_ID
  readonly clientId = CLAUDE_MCP_CLIENT_ID

  private readonly options: Omit<ClaudeConfigureOptions, 'profile'>
  private readonly configureHooks?: ClaudeConfigureHooks
  private readonly removeHooks?: { afterCliRemove?: () => void }
  private readonly workbenchRepoRoot: string
  private readonly targetProjectRoot: string
  private readonly homeDir: string
  private readonly nodeExecutable: string
  private readonly claudeJsonPath: string
  private readonly credentialFile: string

  constructor(options: ClaudeMcpAdapterOptions) {
    this.workbenchRepoRoot = canonicalProjectRoot(options.workbenchRepoRoot, 'Workbench repository root')
    this.targetProjectRoot = canonicalProjectRoot(
      options.targetProjectRoot ?? options.workbenchRepoRoot,
      'Target project root'
    )
    this.homeDir = options.homeDir ?? os.userInfo().homedir
    this.nodeExecutable = canonicalNodeExecutable(options.nodeExecutable ?? process.execPath)
    this.claudeJsonPath = path.join(this.homeDir, '.claude.json')
    this.credentialFile = path.join(this.homeDir, '.buildflow', WORKBENCH_CREDENTIAL_FILE_NAME)
    this.configureHooks = options.configureHooks
    this.removeHooks = options.removeHooks
    this.options = {
      workbenchRepoRoot: this.workbenchRepoRoot,
      targetProjectRoot: this.targetProjectRoot,
      homeDir: this.homeDir,
      now: options.now,
      nodeExecutable: this.nodeExecutable,
      claudeBin: options.claudeBin,
      checkProcesses: options.checkProcesses
    }
  }

  inspectCapabilities(): WorkbenchMcpExecutableAdapterCapabilities {
    return defaultWorkbenchMcpExecutableAdapterCapabilities({
      adapterId: this.adapterId,
      clientId: this.clientId,
      atomicConfigure: false,
      rollback: true,
      dryRun: false
    })
  }

  configure(request: WorkbenchMcpConfigureRequest): WorkbenchMcpAdapterResult<'configure'> {
    this.assertManifest(request.manifest)
    if (request.dryRun) this.fail('unsupported_capability', 'Claude Code registration does not support dry-run.', 'configure')
    const before = this.snapshots()
    try {
      const beforeStatus = inspectClaudeRegistration({ ...this.options, profile: request.manifest.target.profile })
      const status = configureClaude(
        { ...this.options, profile: request.manifest.target.profile },
        this.configureHooks
      )
      const changedPaths = this.changedPaths(before)
      const outcome = changedPaths.length === 0
        ? 'unchanged'
        : beforeStatus.localMatchCount > 0
          ? 'updated'
          : 'configured'
      return createWorkbenchMcpAdapterResult({
        adapterId: this.adapterId,
        clientId: this.clientId,
        operation: 'configure',
        requestId: request.requestId,
        registrationId: request.manifest.registrationId,
        profile: request.manifest.target.profile,
        outcome,
        mutation: changedPaths.length === 0
          ? noMutation()
          : {
              state: 'complete',
              changedPaths,
              rollback: { supported: true, attempted: false, status: 'not_attempted', restoredPaths: [] }
            },
        diagnostics: diagnosticsForStatus(status)
      })
    } catch (error) {
      throw this.wrapClaudeError(error, 'configure', before)
    }
  }

  remove(request: WorkbenchMcpRemoveRequest): WorkbenchMcpAdapterResult<'remove'> {
    this.assertSelector(request.selector)
    if (request.dryRun) this.fail('unsupported_capability', 'Claude Code registration does not support dry-run.', 'remove')
    const before = this.snapshots()
    try {
      const beforeStatus = inspectClaudeRegistration({ ...this.options, profile: request.selector.profile })
      const status = removeClaude(
        { ...this.options, profile: request.selector.profile },
        this.removeHooks
      )
      const changedPaths = this.changedPaths(before)
      return createWorkbenchMcpAdapterResult({
        adapterId: this.adapterId,
        clientId: this.clientId,
        operation: 'remove',
        requestId: request.requestId,
        registrationId: request.selector.registrationId,
        profile: request.selector.profile,
        outcome: beforeStatus.localMatchCount > 0 ? 'removed' : 'not_found',
        mutation: changedPaths.length === 0
          ? noMutation()
          : {
              state: 'complete',
              changedPaths,
              rollback: { supported: true, attempted: false, status: 'not_attempted', restoredPaths: [] }
            },
        diagnostics: diagnosticsForStatus(status)
      })
    } catch (error) {
      throw this.wrapClaudeError(error, 'remove', before)
    }
  }

  status(request: WorkbenchMcpStatusRequest): WorkbenchMcpAdapterResult<'status'> {
    this.assertSelector(request.selector)
    try {
      const status = inspectClaudeRegistration({ ...this.options, profile: request.selector.profile })
      return createWorkbenchMcpAdapterResult({
        adapterId: this.adapterId,
        clientId: this.clientId,
        operation: 'status',
        requestId: request.requestId,
        registrationId: request.selector.registrationId,
        profile: request.selector.profile,
        outcome: status.localMatchCount > 0 ? 'present' : 'absent',
        mutation: noMutation(),
        diagnostics: diagnosticsForStatus(status)
      })
    } catch (error) {
      throw this.wrapClaudeError(error, 'status', this.snapshots())
    }
  }

  audit(request: WorkbenchMcpAuditRequest): WorkbenchMcpAdapterResult<'audit'> {
    this.assertSelector(request.selector)
    try {
      const status = inspectClaudeRegistration({ ...this.options, profile: request.selector.profile })
      const compliant = status.configured &&
        status.userMatchCount === 0 &&
        status.localMatchCount === 1 &&
        status.claudeJsonMode === '0600' &&
        status.credentialMode === '0600'
      return createWorkbenchMcpAdapterResult({
        adapterId: this.adapterId,
        clientId: this.clientId,
        operation: 'audit',
        requestId: request.requestId,
        registrationId: request.selector.registrationId,
        profile: request.selector.profile,
        outcome: compliant ? 'compliant' : 'drifted',
        mutation: noMutation(),
        diagnostics: diagnosticsForStatus(status)
      })
    } catch (error) {
      throw this.wrapClaudeError(error, 'audit', this.snapshots())
    }
  }

  private assertManifest(manifest: WorkbenchMcpRegistrationManifest): void {
    this.assertIdentity(
      manifest.registrationId,
      manifest.target.client.id,
      manifest.target.client.adapterId,
      manifest.target.project.root,
      'configure'
    )
    const spec = buildWorkbenchMcpServerSpec(
      this.workbenchRepoRoot,
      this.credentialFile,
      this.nodeExecutable,
      manifest.target.profile
    )
    const reference = manifest.server.credentialReferences[0]
    if (
      manifest.server.id !== 'workbench' ||
      manifest.server.transport !== 'stdio' ||
      manifest.server.executable.command !== spec.command ||
      JSON.stringify(manifest.server.executable.args) !== JSON.stringify(spec.args) ||
      manifest.server.executable.cwd !== spec.cwd ||
      manifest.server.credentialReferences.length !== 1 ||
      reference?.kind !== 'file' ||
      reference.path !== this.credentialFile ||
      reference.inject.kind !== 'environment' ||
      reference.inject.name !== 'WORKBENCH_MCP_CREDENTIAL_FILE' ||
      manifest.availability.startup !== PROFILE_AVAILABILITY[manifest.target.profile] ||
      manifest.availability.onUnavailable !== (manifest.target.profile === 'brain'
        ? 'continue_without_workbench'
        : 'block_startup')
    ) {
      this.fail('invalid_request', 'Claude manifest does not match the canonical Workbench server specification.', 'configure')
    }
  }

  private assertSelector(selector: WorkbenchMcpRegistrationSelector): void {
    this.assertIdentity(
      selector.registrationId,
      selector.clientId,
      this.adapterId,
      selector.projectRoot,
      'status'
    )
  }

  private assertIdentity(
    registrationId: string,
    clientId: string,
    adapterId: string,
    projectRoot: string,
    operation: 'configure' | 'status'
  ): void {
    if (registrationId !== CLAUDE_MCP_REGISTRATION_ID) {
      this.fail('identity_mismatch', `Claude registration ID must be ${CLAUDE_MCP_REGISTRATION_ID}.`, operation)
    }
    if (clientId !== this.clientId || adapterId !== this.adapterId) {
      this.fail('identity_mismatch', 'Claude adapter or client identity does not match.', operation)
    }
    let canonical: string
    try {
      canonical = canonicalProjectRoot(projectRoot, 'Target project root')
    } catch (error) {
      this.fail('invalid_request', error instanceof Error ? error.message : 'Invalid target project root.', operation)
    }
    if (canonical !== this.targetProjectRoot) {
      this.fail('identity_mismatch', 'Claude registration project root does not match the adapter target.', operation)
    }
  }

  private snapshots(): Record<string, FileSnapshot> {
    return {
      [this.claudeJsonPath]: snapshotFile(this.claudeJsonPath),
      [this.credentialFile]: snapshotFile(this.credentialFile)
    }
  }

  private changedPaths(before: Record<string, FileSnapshot>): string[] {
    return Object.entries(before)
      .filter(([file, snapshot]) => snapshotChanged(snapshot, snapshotFile(file)))
      .map(([file]) => file)
  }

  private wrapClaudeError(
    error: unknown,
    operation: 'configure' | 'remove' | 'status' | 'audit',
    before: Record<string, FileSnapshot>
  ): WorkbenchMcpAdapterContractError {
    if (error instanceof WorkbenchMcpAdapterContractError) return error
    const changedPaths = this.changedPaths(before)
    const partial = changedPaths.length > 0
    return new WorkbenchMcpAdapterContractError(
      partial ? 'partial_mutation' : classifyClaudeError(error),
      error instanceof Error ? error.message : String(error),
      {
        retryable: false,
        adapterId: this.adapterId,
        clientId: this.clientId,
        operation,
        mutation: partial
          ? {
              state: 'partial',
              changedPaths,
              rollback: {
                supported: true,
                attempted: false,
                status: 'not_attempted',
                restoredPaths: [],
                message: 'Claude CLI mutation is inspected conservatively and is not overwritten automatically.'
              }
            }
          : noMutation(),
        cause: error
      }
    )
  }

  private fail(
    code: WorkbenchMcpAdapterErrorCode,
    message: string,
    operation: 'configure' | 'remove' | 'status' | 'audit'
  ): never {
    throw new WorkbenchMcpAdapterContractError(code, message, {
      adapterId: this.adapterId,
      clientId: this.clientId,
      operation,
      mutation: noMutation()
    })
  }
}
