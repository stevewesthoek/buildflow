import fs from 'node:fs'
import path from 'node:path'
import {
  WORKBENCH_MCP_ADAPTER_CONTRACT_VERSION,
  WorkbenchMcpAdapterContractError,
  createWorkbenchMcpAdapterResult,
  parseWorkbenchMcpExecutableAdapterCapabilities,
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
  buildWorkbenchMcpServerSpec,
  canonicalNodeExecutable,
  canonicalProjectRoot
} from './configure-core.js'
import {
  WORKBENCH_MCP_REGISTRATION_API_VERSION,
  WORKBENCH_MCP_REGISTRATION_SCHEMA_VERSION,
  type WorkbenchMcpRegistrationManifest,
  type WorkbenchMcpRegistrationSelector
} from './registration-manifest.js'

export const VSCODE_MCP_ADAPTER_ID = 'vscode-workspace-v1' as const
export const VSCODE_MCP_CLIENT_ID = 'vscode' as const
export const CURSOR_MCP_ADAPTER_ID = 'cursor-project-v1' as const
export const CURSOR_MCP_CLIENT_ID = 'cursor' as const
export const JETBRAINS_MCP_ADAPTER_ID = 'jetbrains-project-v1' as const
export const JETBRAINS_MCP_CLIENT_ID = 'jetbrains' as const
export const IDE_MCP_REGISTRATION_ID = 'workbench' as const

const SERVER_NAME = 'workbench'

type JsonObject = Record<string, unknown>
type Snapshot = { exists: boolean; content?: Buffer; mode?: number }

export type VSCodeProjectMcpAdapterOptions = {
  workbenchRepoRoot: string
  targetProjectRoot: string
  nodeExecutable?: string
}

function snapshot(file: string): Snapshot {
  try {
    const stat = fs.statSync(file)
    return { exists: true, content: fs.readFileSync(file), mode: stat.mode & 0o777 }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false }
    throw error
  }
}

function equalSnapshot(left: Snapshot, right: Snapshot): boolean {
  if (left.exists !== right.exists || left.mode !== right.mode) return false
  if (!left.exists || !right.exists) return true
  return left.content?.equals(right.content ?? Buffer.alloc(0)) ?? false
}

function writeJsonAtomic(file: string, value: JsonObject): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.tmp-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, file)
  fs.chmodSync(file, 0o600)
}

function restore(file: string, before: Snapshot): void {
  if (!before.exists) {
    if (fs.existsSync(file)) fs.unlinkSync(file)
    return
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, before.content ?? Buffer.alloc(0), { mode: before.mode ?? 0o600 })
  fs.chmodSync(file, before.mode ?? 0o600)
}

function readDocument(file: string): JsonObject {
  if (!fs.existsSync(file)) return {}
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('MCP configuration must be a JSON object.')
  return parsed as JsonObject
}

function noMutation(): WorkbenchMcpAdapterMutationEvidence {
  return {
    state: 'none',
    changedPaths: [],
    rollback: { supported: true, attempted: false, status: 'not_required', restoredPaths: [] }
  }
}

function unsupportedCapabilities(adapterId: string, clientId: string): WorkbenchMcpExecutableAdapterCapabilities {
  return parseWorkbenchMcpExecutableAdapterCapabilities({
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    contractVersion: WORKBENCH_MCP_ADAPTER_CONTRACT_VERSION,
    adapterId,
    clientId,
    registrationApiVersions: [WORKBENCH_MCP_REGISTRATION_API_VERSION],
    manifestSchemaVersions: [WORKBENCH_MCP_REGISTRATION_SCHEMA_VERSION],
    adapterApiVersions: [WORKBENCH_MCP_ADAPTER_CONTRACT_VERSION],
    operations: ['inspect_capabilities'],
    transports: ['stdio'],
    scopeDimensions: ['client', 'project', 'profile'],
    availabilityModes: ['optional'],
    credentialReferenceKinds: ['file'],
    supports: { capabilityInspection: true, atomicConfigure: false, rollback: false, dryRun: false }
  })
}

abstract class UnsupportedIdeMcpAdapter implements WorkbenchMcpClientAdapter {
  abstract readonly adapterId: string
  abstract readonly clientId: string
  protected abstract readonly reason: string

  inspectCapabilities(): WorkbenchMcpExecutableAdapterCapabilities {
    return unsupportedCapabilities(this.adapterId, this.clientId)
  }

  configure(_request: WorkbenchMcpConfigureRequest): never { return this.unsupported('configure') }
  remove(_request: WorkbenchMcpRemoveRequest): never { return this.unsupported('remove') }
  status(_request: WorkbenchMcpStatusRequest): never { return this.unsupported('status') }
  audit(_request: WorkbenchMcpAuditRequest): never { return this.unsupported('audit') }

  private unsupported(operation: 'configure' | 'remove' | 'status' | 'audit'): never {
    throw new WorkbenchMcpAdapterContractError('unsupported_capability', this.reason, {
      adapterId: this.adapterId,
      clientId: this.clientId,
      operation,
      mutation: noMutation()
    })
  }
}

export class CursorProjectMcpAdapter extends UnsupportedIdeMcpAdapter {
  readonly adapterId = CURSOR_MCP_ADAPTER_ID
  readonly clientId = CURSOR_MCP_CLIENT_ID
  protected readonly reason = 'Cursor project MCP configuration does not document cwd or required-startup semantics needed by the Workbench contract.'
}

export class JetBrainsProjectMcpAdapter extends UnsupportedIdeMcpAdapter {
  readonly adapterId = JETBRAINS_MCP_ADAPTER_ID
  readonly clientId = JETBRAINS_MCP_CLIENT_ID
  protected readonly reason = 'JetBrains documents UI-managed project MCP entries but no stable project configuration file or required-startup lifecycle contract.'
}

export class VSCodeProjectMcpAdapter implements WorkbenchMcpClientAdapter {
  readonly adapterId = VSCODE_MCP_ADAPTER_ID
  readonly clientId = VSCODE_MCP_CLIENT_ID
  private readonly workbenchRepoRoot: string
  private readonly targetProjectRoot: string
  private readonly nodeExecutable: string
  private readonly configPath: string

  constructor(options: VSCodeProjectMcpAdapterOptions) {
    this.workbenchRepoRoot = canonicalProjectRoot(options.workbenchRepoRoot, 'Workbench repository root')
    this.targetProjectRoot = canonicalProjectRoot(options.targetProjectRoot, 'Target project root')
    this.nodeExecutable = canonicalNodeExecutable(options.nodeExecutable ?? process.execPath)
    this.configPath = path.join(this.targetProjectRoot, '.vscode', 'mcp.json')
  }

  inspectCapabilities(): WorkbenchMcpExecutableAdapterCapabilities {
    return parseWorkbenchMcpExecutableAdapterCapabilities({
      apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
      contractVersion: WORKBENCH_MCP_ADAPTER_CONTRACT_VERSION,
      adapterId: this.adapterId,
      clientId: this.clientId,
      registrationApiVersions: [WORKBENCH_MCP_REGISTRATION_API_VERSION],
      manifestSchemaVersions: [WORKBENCH_MCP_REGISTRATION_SCHEMA_VERSION],
      adapterApiVersions: [WORKBENCH_MCP_ADAPTER_CONTRACT_VERSION],
      operations: ['inspect_capabilities', 'configure', 'remove', 'status', 'audit'],
      transports: ['stdio'],
      scopeDimensions: ['client', 'project', 'profile'],
      availabilityModes: ['optional'],
      credentialReferenceKinds: ['file'],
      supports: { capabilityInspection: true, atomicConfigure: true, rollback: true, dryRun: true }
    })
  }

  configure(request: WorkbenchMcpConfigureRequest): WorkbenchMcpAdapterResult<'configure'> {
    this.assertManifest(request.manifest)
    const before = snapshot(this.configPath)
    const document = readDocument(this.configPath)
    const servers = this.servers(document)
    this.assertNoConflict(servers)
    const expected = this.expectedEntry(request.manifest)
    const unchanged = JSON.stringify(servers[SERVER_NAME]) === JSON.stringify(expected) && before.exists && before.mode === 0o600
    if (request.dryRun) return this.result(request, unchanged ? 'unchanged' : 'configured', unchanged ? 'none' : 'planned', [])
    if (unchanged) return this.result(request, 'unchanged', 'none', [])

    servers[SERVER_NAME] = expected
    document.servers = servers
    try {
      writeJsonAtomic(this.configPath, document)
      const status = this.inspect(request.manifest.target.profile)
      if (!status.compliant) throw new Error('VS Code MCP post-write validation failed.')
      return this.result(request, before.exists ? 'updated' : 'configured', 'complete', [this.configPath])
    } catch (error) {
      restore(this.configPath, before)
      throw new WorkbenchMcpAdapterContractError('partial_mutation', error instanceof Error ? error.message : String(error), {
        adapterId: this.adapterId,
        clientId: this.clientId,
        operation: 'configure',
        mutation: {
          state: equalSnapshot(before, snapshot(this.configPath)) ? 'none' : 'partial',
          changedPaths: equalSnapshot(before, snapshot(this.configPath)) ? [] : [this.configPath],
          rollback: { supported: true, attempted: true, status: equalSnapshot(before, snapshot(this.configPath)) ? 'succeeded' : 'failed', restoredPaths: equalSnapshot(before, snapshot(this.configPath)) ? [this.configPath] : [] }
        },
        cause: error
      })
    }
  }

  remove(request: WorkbenchMcpRemoveRequest): WorkbenchMcpAdapterResult<'remove'> {
    this.assertSelector(request.selector)
    const before = snapshot(this.configPath)
    const document = readDocument(this.configPath)
    const servers = this.servers(document)
    this.assertNoConflict(servers)
    if (!(SERVER_NAME in servers)) return this.result(request, 'not_found', 'none', [])
    if (request.dryRun) return this.result(request, 'removed', 'planned', [])
    delete servers[SERVER_NAME]
    document.servers = servers
    try {
      writeJsonAtomic(this.configPath, document)
      if (this.inspect(request.selector.profile).present) throw new Error('VS Code MCP post-remove validation failed.')
      return this.result(request, 'removed', 'complete', [this.configPath])
    } catch (error) {
      restore(this.configPath, before)
      throw new WorkbenchMcpAdapterContractError('partial_mutation', error instanceof Error ? error.message : String(error), {
        adapterId: this.adapterId,
        clientId: this.clientId,
        operation: 'remove',
        mutation: { state: 'none', changedPaths: [], rollback: { supported: true, attempted: true, status: 'succeeded', restoredPaths: [this.configPath] } },
        cause: error
      })
    }
  }

  status(request: WorkbenchMcpStatusRequest): WorkbenchMcpAdapterResult<'status'> {
    this.assertSelector(request.selector)
    const inspected = this.inspect(request.selector.profile)
    return this.result(request, inspected.present ? 'present' : 'absent', 'none', [], inspected.compliant ? [] : [{ code: 'vscode_registration_drift', message: 'VS Code project MCP registration is absent or does not match the selected profile.' }])
  }

  audit(request: WorkbenchMcpAuditRequest): WorkbenchMcpAdapterResult<'audit'> {
    this.assertSelector(request.selector)
    const inspected = this.inspect(request.selector.profile)
    return this.result(request, inspected.compliant ? 'compliant' : 'drifted', 'none', [], inspected.compliant ? [] : [{ code: 'vscode_registration_drift', message: 'VS Code project MCP registration is absent or does not match the selected profile.' }])
  }

  private assertManifest(manifest: WorkbenchMcpRegistrationManifest): void {
    if (manifest.target.profile !== 'brain') this.unsupportedRequired('configure')
    if (manifest.registrationId !== IDE_MCP_REGISTRATION_ID || manifest.target.client.id !== this.clientId || manifest.target.client.adapterId !== this.adapterId) {
      throw new WorkbenchMcpAdapterContractError('identity_mismatch', 'VS Code manifest identity does not match this adapter.', { adapterId: this.adapterId, clientId: this.clientId, operation: 'configure', mutation: noMutation() })
    }
    if (canonicalProjectRoot(manifest.target.project.root, 'Target project root') !== this.targetProjectRoot) {
      throw new WorkbenchMcpAdapterContractError('identity_mismatch', 'VS Code manifest project root does not match this adapter.', { adapterId: this.adapterId, clientId: this.clientId, operation: 'configure', mutation: noMutation() })
    }
    const expected = buildWorkbenchMcpServerSpec(this.workbenchRepoRoot, manifest.server.credentialReferences[0]?.path ?? '', this.nodeExecutable, 'brain')
    if (manifest.server.executable.command !== expected.command || JSON.stringify(manifest.server.executable.args) !== JSON.stringify(expected.args) || manifest.server.executable.cwd !== expected.cwd || manifest.server.credentialReferences.length !== 1 || manifest.server.credentialReferences[0].kind !== 'file') {
      throw new WorkbenchMcpAdapterContractError('invalid_request', 'VS Code manifest does not match the canonical Workbench server specification.', { adapterId: this.adapterId, clientId: this.clientId, operation: 'configure', mutation: noMutation() })
    }
  }

  private assertSelector(selector: WorkbenchMcpRegistrationSelector): void {
    if (selector.profile !== 'brain') this.unsupportedRequired('status')
    if (selector.registrationId !== IDE_MCP_REGISTRATION_ID || selector.clientId !== this.clientId || canonicalProjectRoot(selector.projectRoot, 'Target project root') !== this.targetProjectRoot) {
      throw new WorkbenchMcpAdapterContractError('identity_mismatch', 'VS Code selector identity does not match this adapter.', { adapterId: this.adapterId, clientId: this.clientId, operation: 'status', mutation: noMutation() })
    }
  }

  private unsupportedRequired(operation: 'configure' | 'remove' | 'status' | 'audit'): never {
    throw new WorkbenchMcpAdapterContractError('unsupported_capability', 'VS Code workspace MCP configuration has no required-startup field; only the optional Brain profile is supported.', { adapterId: this.adapterId, clientId: this.clientId, operation, mutation: noMutation() })
  }

  private expectedEntry(manifest: WorkbenchMcpRegistrationManifest): JsonObject {
    const spec = buildWorkbenchMcpServerSpec(this.workbenchRepoRoot, manifest.server.credentialReferences[0].path, this.nodeExecutable, 'brain')
    return { type: 'stdio', command: spec.command, args: spec.args, cwd: spec.cwd, env: spec.env }
  }

  private servers(document: JsonObject): Record<string, unknown> {
    const value = document.servers
    if (value === undefined) return {}
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('VS Code MCP servers must be an object.')
    return value as Record<string, unknown>
  }

  private assertNoConflict(servers: Record<string, unknown>): void {
    const matches = Object.entries(servers).filter(([name, entry]) => name === SERVER_NAME || this.looksLikeWorkbench(entry))
    if (matches.length > 1 || (matches.length === 1 && matches[0][0] !== SERVER_NAME)) {
      throw new WorkbenchMcpAdapterContractError('conflict', 'Duplicate or conflicting Workbench MCP definitions found in VS Code workspace configuration.', { adapterId: this.adapterId, clientId: this.clientId, mutation: noMutation() })
    }
  }

  private looksLikeWorkbench(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const entry = value as JsonObject
    const args = Array.isArray(entry.args) ? entry.args : []
    return entry.command === this.nodeExecutable && args.includes(path.join(this.workbenchRepoRoot, 'packages', 'mcp', 'dist', 'server.js'))
  }

  private inspect(profile: 'workbench' | 'brain'): { present: boolean; compliant: boolean } {
    const document = readDocument(this.configPath)
    const servers = this.servers(document)
    this.assertNoConflict(servers)
    const present = SERVER_NAME in servers
    if (!present) return { present: false, compliant: false }
    const reference = path.join(path.dirname(path.dirname(this.configPath)), '.buildflow-placeholder')
    const entry = servers[SERVER_NAME] as JsonObject
    const env = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry.env as JsonObject : {}
    const expectedServer = path.join(this.workbenchRepoRoot, 'packages', 'mcp', 'dist', 'server.js')
    return {
      present: true,
      compliant: entry.type === 'stdio' && entry.command === this.nodeExecutable && Array.isArray(entry.args) && entry.args[0] === expectedServer && entry.cwd === this.workbenchRepoRoot && typeof env?.WORKBENCH_MCP_CREDENTIAL_FILE === 'string' && env.WORKBENCH_MCP_ALLOWED_TOOLS === 'getWorkbenchStatus,readWorkbenchContext,runWorkbenchCommand' && env.WORKBENCH_MCP_ALLOWED_COMMAND_KINDS === 'n8n_workflow_migration' && profile === 'brain' && reference.length > 0 && snapshot(this.configPath).mode === 0o600
    }
  }

  private result<Operation extends 'configure' | 'remove' | 'status' | 'audit'>(
    request: Operation extends 'configure' ? WorkbenchMcpConfigureRequest : Operation extends 'remove' ? WorkbenchMcpRemoveRequest : Operation extends 'status' ? WorkbenchMcpStatusRequest : WorkbenchMcpAuditRequest,
    outcome: WorkbenchMcpAdapterResult<Operation>['outcome'],
    state: WorkbenchMcpAdapterMutationEvidence['state'],
    changedPaths: string[],
    diagnostics: { code: string; message: string }[] = []
  ): WorkbenchMcpAdapterResult<Operation> {
    const registrationId = request.operation === 'configure' ? request.manifest.registrationId : request.selector.registrationId
    const profile = request.operation === 'configure' ? request.manifest.target.profile : request.selector.profile
    return createWorkbenchMcpAdapterResult({
      adapterId: this.adapterId,
      clientId: this.clientId,
      operation: request.operation as Operation,
      requestId: request.requestId,
      registrationId,
      profile,
      outcome,
      dryRun: 'dryRun' in request ? request.dryRun : false,
      mutation: state === 'none'
        ? noMutation()
        : { state, changedPaths, rollback: { supported: true, attempted: false, status: state === 'planned' ? 'not_required' : 'not_attempted', restoredPaths: [] } },
      diagnostics
    }) as WorkbenchMcpAdapterResult<Operation>
  }
}
