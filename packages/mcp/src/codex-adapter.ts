import fs from 'node:fs'
import os from 'node:os'
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
  configureCodex,
  inspectCodexRegistration,
  previewCodexConfiguration,
  previewCodexRemoval,
  removeCodex,
  resolveCodexRegistrationPaths,
  type CodexRegistrationStatus,
  type ConfigureHooks,
  type ConfigureOptions,
  type RemoveHooks
} from './configure-codex.js'
import {
  PROFILE_AVAILABILITY,
  buildWorkbenchMcpServerSpec,
  canonicalNodeExecutable,
  canonicalProjectRoot
} from './configure-core.js'
import type { WorkbenchMcpRegistrationManifest, WorkbenchMcpRegistrationSelector } from './registration-manifest.js'

export const CODEX_MCP_ADAPTER_ID = 'codex-project-v1' as const
export const CODEX_MCP_CLIENT_ID = 'codex' as const
export const CODEX_MCP_REGISTRATION_ID = 'workbench' as const

export type CodexMcpAdapterOptions = Omit<ConfigureOptions, 'profile'> & {
  configureHooks?: ConfigureHooks
  removeHooks?: RemoveHooks
}

type FileSnapshot = { exists: boolean; content?: Buffer; mode?: number }
type WriteEvidence = { credentialWritten: boolean; projectWritten: boolean }

function snapshotFile(file: string): FileSnapshot {
  try {
    const stat = fs.statSync(file)
    return { exists: true, content: fs.readFileSync(file), mode: stat.mode & 0o777 }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false }
    throw error
  }
}

function snapshots(files: readonly string[]): Record<string, FileSnapshot> {
  return Object.fromEntries(files.map(file => [file, snapshotFile(file)]))
}

function snapshotsEqual(left: FileSnapshot, right: FileSnapshot): boolean {
  if (left.exists !== right.exists || left.mode !== right.mode) return false
  if (!left.exists || !right.exists) return true
  return left.content?.equals(right.content ?? Buffer.alloc(0)) ?? false
}

function changedPaths(before: Record<string, FileSnapshot>): string[] {
  return Object.entries(before).filter(([file, value]) => !snapshotsEqual(value, snapshotFile(file))).map(([file]) => file)
}

function fileMode(file: string): string | undefined {
  try {
    return (fs.statSync(file).mode & 0o777).toString(8).padStart(4, '0')
  } catch {
    return undefined
  }
}

function noMutation(): WorkbenchMcpAdapterMutationEvidence {
  return {
    state: 'none',
    changedPaths: [],
    rollback: { supported: true, attempted: false, status: 'not_required', restoredPaths: [] }
  }
}

function plannedMutation(): WorkbenchMcpAdapterMutationEvidence {
  return {
    state: 'planned',
    changedPaths: [],
    rollback: { supported: true, attempted: false, status: 'not_required', restoredPaths: [] }
  }
}

function diagnosticsForStatus(status: CodexRegistrationStatus, globalMode: string | undefined, expectation: 'present' | 'absent'): WorkbenchMcpAdapterDiagnostic[] {
  const diagnostics: WorkbenchMcpAdapterDiagnostic[] = []
  if (globalMode !== '0600') diagnostics.push({ code: 'codex_global_config_mode', message: `Expected global config mode 0600; found ${globalMode ?? 'missing'}.` })
  const total = status.globalMatchCount + status.projectMatchCount
  if (expectation === 'present' && total !== 1) diagnostics.push({ code: 'codex_scope_count', message: `Expected exactly one Workbench definition in global or project scope; found ${total}.` })
  if (expectation === 'absent' && total !== 0) diagnostics.push({ code: 'codex_scope_count', message: `Expected no Workbench definition in global or project scope; found ${total}.` })
  if (expectation === 'present' && !status.configured && total > 0) diagnostics.push({ code: 'codex_registration_mismatch', message: 'Workbench definition does not match the selected profile.' })
  if (expectation === 'present' && status.scope === 'project' && status.configMode !== '0600') diagnostics.push({ code: 'codex_project_config_mode', message: `Expected project config mode 0600; found ${status.configMode ?? 'missing'}.` })
  if (expectation === 'present' && status.credentialMode !== '0600') diagnostics.push({ code: 'codex_credential_mode', message: `Expected shared credential mode 0600; found ${status.credentialMode ?? 'missing'}.` })
  return diagnostics
}

function classifyCodexError(error: unknown): WorkbenchMcpAdapterErrorCode {
  if (error instanceof WorkbenchMcpAdapterContractError) return error.code
  const message = error instanceof Error ? error.message : String(error)
  if (/already exists|duplicate|conflicting|does not match/i.test(message)) return 'conflict'
  if (/EACCES|EPERM|permission|mode 0600/i.test(message)) return 'permission_denied'
  if (/not found|ENOENT|unavailable/i.test(message)) return 'io_error'
  if (/must be|does not exist|absolute path|symlink|regular non-symlink|invalid|validation failed/i.test(message)) return 'invalid_request'
  return 'internal'
}

export class CodexProjectMcpAdapter implements WorkbenchMcpClientAdapter {
  readonly adapterId = CODEX_MCP_ADAPTER_ID
  readonly clientId = CODEX_MCP_CLIENT_ID
  private readonly options: Omit<ConfigureOptions, 'profile'>
  private readonly configureHooks?: ConfigureHooks
  private readonly removeHooks?: RemoveHooks
  private readonly workbenchRepoRoot: string
  private readonly targetProjectRoot: string
  private readonly nodeExecutable: string
  private readonly paths: ReturnType<typeof resolveCodexRegistrationPaths>

  constructor(options: CodexMcpAdapterOptions) {
    this.workbenchRepoRoot = canonicalProjectRoot(options.workbenchRepoRoot, 'Workbench repository root')
    this.targetProjectRoot = canonicalProjectRoot(options.targetProjectRoot ?? options.workbenchRepoRoot, 'Target project root')
    this.nodeExecutable = canonicalNodeExecutable(options.nodeExecutable ?? process.execPath)
    this.options = {
      workbenchRepoRoot: this.workbenchRepoRoot,
      targetProjectRoot: this.targetProjectRoot,
      codexHome: options.codexHome,
      homeDir: options.homeDir ?? os.userInfo().homedir,
      now: options.now,
      nodeExecutable: this.nodeExecutable
    }
    this.configureHooks = options.configureHooks
    this.removeHooks = options.removeHooks
    this.paths = resolveCodexRegistrationPaths(this.options)
  }

  inspectCapabilities(): WorkbenchMcpExecutableAdapterCapabilities {
    return defaultWorkbenchMcpExecutableAdapterCapabilities({ adapterId: this.adapterId, clientId: this.clientId, atomicConfigure: true, rollback: true, dryRun: true })
  }

  configure(request: WorkbenchMcpConfigureRequest): WorkbenchMcpAdapterResult<'configure'> {
    this.assertManifest(request.manifest)
    const options = this.operationOptions(request.manifest.target.profile)
    let preview: ReturnType<typeof previewCodexConfiguration>
    try { preview = previewCodexConfiguration(options) } catch (error) { throw this.wrapPreflightError(error, 'configure') }
    if (request.dryRun) {
      return createWorkbenchMcpAdapterResult({
        adapterId: this.adapterId, clientId: this.clientId, operation: 'configure', requestId: request.requestId,
        registrationId: request.manifest.registrationId, profile: request.manifest.target.profile,
        outcome: preview.changed ? preview.projectMatchCount > 0 ? 'updated' : 'configured' : 'unchanged',
        dryRun: true, mutation: preview.changed ? plannedMutation() : noMutation(),
        diagnostics: diagnosticsForStatus(preview, fileMode(this.paths.globalConfigPath), 'present')
      })
    }
    const before = snapshots([this.paths.globalConfigPath, this.paths.projectConfigPath, this.paths.credentialFile, preview.backupPath])
    const writes: WriteEvidence = { credentialWritten: false, projectWritten: false }
    const hooks: ConfigureHooks = {
      afterCredentialWrite: () => { writes.credentialWritten = true; this.configureHooks?.afterCredentialWrite?.() },
      afterProjectConfigWrite: () => { writes.projectWritten = true; this.configureHooks?.afterProjectConfigWrite?.() }
    }
    try {
      const status = configureCodex(options, hooks)
      const changed = changedPaths(before)
      return createWorkbenchMcpAdapterResult({
        adapterId: this.adapterId, clientId: this.clientId, operation: 'configure', requestId: request.requestId,
        registrationId: request.manifest.registrationId, profile: request.manifest.target.profile,
        outcome: preview.projectMatchCount > 0 ? 'updated' : 'configured',
        mutation: changed.length === 0 ? noMutation() : { state: 'complete', changedPaths: changed, rollback: { supported: true, attempted: false, status: 'not_attempted', restoredPaths: [] } },
        diagnostics: diagnosticsForStatus(status, fileMode(this.paths.globalConfigPath), 'present')
      })
    } catch (error) { throw this.wrapMutationError(error, 'configure', before, writes) }
  }

  remove(request: WorkbenchMcpRemoveRequest): WorkbenchMcpAdapterResult<'remove'> {
    this.assertSelector(request.selector, 'remove')
    const options = this.operationOptions(request.selector.profile)
    let preview: ReturnType<typeof previewCodexRemoval>
    try { preview = previewCodexRemoval(options) } catch (error) { throw this.wrapPreflightError(error, 'remove') }
    if (request.dryRun) {
      return createWorkbenchMcpAdapterResult({
        adapterId: this.adapterId, clientId: this.clientId, operation: 'remove', requestId: request.requestId,
        registrationId: request.selector.registrationId, profile: request.selector.profile,
        outcome: preview.changed ? 'removed' : 'not_found', dryRun: true,
        mutation: preview.changed ? plannedMutation() : noMutation(),
        diagnostics: diagnosticsForStatus(preview, fileMode(this.paths.globalConfigPath), 'absent')
      })
    }
    const files = [this.paths.globalConfigPath, this.paths.projectConfigPath, this.paths.credentialFile]
    if (preview.backupPath) files.push(preview.backupPath)
    const before = snapshots(files)
    const writes: WriteEvidence = { credentialWritten: false, projectWritten: false }
    const hooks: RemoveHooks = { afterProjectConfigWrite: () => { writes.projectWritten = true; this.removeHooks?.afterProjectConfigWrite?.() } }
    try {
      const status = removeCodex(options, hooks)
      const changed = changedPaths(before)
      return createWorkbenchMcpAdapterResult({
        adapterId: this.adapterId, clientId: this.clientId, operation: 'remove', requestId: request.requestId,
        registrationId: request.selector.registrationId, profile: request.selector.profile,
        outcome: preview.changed ? 'removed' : 'not_found',
        mutation: changed.length === 0 ? noMutation() : { state: 'complete', changedPaths: changed, rollback: { supported: true, attempted: false, status: 'not_attempted', restoredPaths: [] } },
        diagnostics: diagnosticsForStatus(status, fileMode(this.paths.globalConfigPath), 'absent')
      })
    } catch (error) { throw this.wrapMutationError(error, 'remove', before, writes) }
  }

  status(request: WorkbenchMcpStatusRequest): WorkbenchMcpAdapterResult<'status'> {
    this.assertSelector(request.selector, 'status')
    try {
      const status = inspectCodexRegistration(this.operationOptions(request.selector.profile))
      return createWorkbenchMcpAdapterResult({
        adapterId: this.adapterId, clientId: this.clientId, operation: 'status', requestId: request.requestId,
        registrationId: request.selector.registrationId, profile: request.selector.profile,
        outcome: status.globalMatchCount + status.projectMatchCount > 0 ? 'present' : 'absent', mutation: noMutation(),
        diagnostics: diagnosticsForStatus(status, fileMode(this.paths.globalConfigPath), 'present')
      })
    } catch (error) { throw this.wrapPreflightError(error, 'status') }
  }

  audit(request: WorkbenchMcpAuditRequest): WorkbenchMcpAdapterResult<'audit'> {
    this.assertSelector(request.selector, 'audit')
    try {
      const status = inspectCodexRegistration(this.operationOptions(request.selector.profile))
      const oneUnambiguousScope = (status.globalMatchCount === 1 && status.projectMatchCount === 0) || (status.globalMatchCount === 0 && status.projectMatchCount === 1)
      const registrationConfigMode = status.scope === 'global' ? fileMode(this.paths.globalConfigPath) : fileMode(this.paths.projectConfigPath)
      const compliant = status.configured && status.duplicateCount === 1 && oneUnambiguousScope && status.configMode === '0600' && registrationConfigMode === '0600' && status.credentialMode === '0600' && fileMode(this.paths.globalConfigPath) === '0600'
      return createWorkbenchMcpAdapterResult({
        adapterId: this.adapterId, clientId: this.clientId, operation: 'audit', requestId: request.requestId,
        registrationId: request.selector.registrationId, profile: request.selector.profile,
        outcome: compliant ? 'compliant' : 'drifted', mutation: noMutation(),
        diagnostics: diagnosticsForStatus(status, fileMode(this.paths.globalConfigPath), 'present')
      })
    } catch (error) { throw this.wrapPreflightError(error, 'audit') }
  }

  private operationOptions(profile: 'workbench' | 'brain'): ConfigureOptions {
    return { ...this.options, profile, now: this.options.now ?? new Date() }
  }

  private assertManifest(manifest: WorkbenchMcpRegistrationManifest): void {
    this.assertIdentity(manifest.registrationId, manifest.target.client.id, manifest.target.client.adapterId, manifest.target.project.root, 'configure')
    const spec = buildWorkbenchMcpServerSpec(this.workbenchRepoRoot, this.paths.credentialFile, this.nodeExecutable, manifest.target.profile)
    const reference = manifest.server.credentialReferences[0]
    if (manifest.server.id !== 'workbench' || manifest.server.transport !== 'stdio' || manifest.server.executable.command !== spec.command || JSON.stringify(manifest.server.executable.args) !== JSON.stringify(spec.args) || manifest.server.executable.cwd !== spec.cwd || manifest.server.credentialReferences.length !== 1 || reference?.kind !== 'file' || reference.path !== this.paths.credentialFile || reference.inject.kind !== 'environment' || reference.inject.name !== 'WORKBENCH_MCP_CREDENTIAL_FILE' || manifest.availability.startup !== PROFILE_AVAILABILITY[manifest.target.profile] || manifest.availability.onUnavailable !== (manifest.target.profile === 'brain' ? 'continue_without_workbench' : 'block_startup') || manifest.rollback.backupRequired !== true) {
      this.fail('invalid_request', 'Codex manifest does not match the canonical Workbench server specification.', 'configure')
    }
  }

  private assertSelector(selector: WorkbenchMcpRegistrationSelector, operation: 'remove' | 'status' | 'audit'): void {
    this.assertIdentity(selector.registrationId, selector.clientId, this.adapterId, selector.projectRoot, operation)
  }

  private assertIdentity(registrationId: string, clientId: string, adapterId: string, projectRoot: string, operation: 'configure' | 'remove' | 'status' | 'audit'): void {
    if (registrationId !== CODEX_MCP_REGISTRATION_ID) this.fail('identity_mismatch', `Codex registration ID must be ${CODEX_MCP_REGISTRATION_ID}.`, operation)
    if (clientId !== this.clientId || adapterId !== this.adapterId) this.fail('identity_mismatch', 'Codex adapter or client identity does not match.', operation)
    let canonical: string
    try { canonical = canonicalProjectRoot(projectRoot, 'Target project root') } catch (error) { this.fail('invalid_request', error instanceof Error ? error.message : 'Invalid target project root.', operation) }
    if (canonical !== this.targetProjectRoot) this.fail('identity_mismatch', 'Codex registration project root does not match the adapter target.', operation)
  }

  private wrapPreflightError(error: unknown, operation: 'configure' | 'remove' | 'status' | 'audit'): WorkbenchMcpAdapterContractError {
    if (error instanceof WorkbenchMcpAdapterContractError) return error
    return new WorkbenchMcpAdapterContractError(classifyCodexError(error), error instanceof Error ? error.message : String(error), { retryable: false, adapterId: this.adapterId, clientId: this.clientId, operation, mutation: noMutation(), cause: error })
  }

  private wrapMutationError(error: unknown, operation: 'configure' | 'remove', before: Record<string, FileSnapshot>, writes: WriteEvidence): WorkbenchMcpAdapterContractError {
    if (error instanceof WorkbenchMcpAdapterContractError) return error
    const changed = changedPaths(before)
    const attemptedPaths = [...(writes.credentialWritten ? [this.paths.credentialFile] : []), ...(writes.projectWritten ? [this.paths.projectConfigPath] : [])]
    const restoredPaths = attemptedPaths.filter(file => snapshotsEqual(before[file], snapshotFile(file)))
    const attempted = attemptedPaths.length > 0
    const succeeded = attempted && restoredPaths.length === attemptedPaths.length
    const code: WorkbenchMcpAdapterErrorCode = attempted && !succeeded ? 'rollback_failed' : changed.length > 0 ? 'partial_mutation' : classifyCodexError(error)
    return new WorkbenchMcpAdapterContractError(code, error instanceof Error ? error.message : String(error), {
      retryable: false, adapterId: this.adapterId, clientId: this.clientId, operation,
      mutation: {
        state: changed.length > 0 ? 'partial' : 'none', changedPaths: changed,
        rollback: { supported: true, attempted, status: attempted ? succeeded ? 'succeeded' : 'failed' : 'not_required', restoredPaths, message: attempted ? succeeded ? 'Managed Codex config and credential content and modes were restored exactly.' : 'Managed Codex rollback did not restore every written path.' : 'No managed Codex file write was observed.' }
      }, cause: error
    })
  }

  private fail(code: WorkbenchMcpAdapterErrorCode, message: string, operation: 'configure' | 'remove' | 'status' | 'audit'): never {
    throw new WorkbenchMcpAdapterContractError(code, message, { adapterId: this.adapterId, clientId: this.clientId, operation, mutation: noMutation() })
  }
}
