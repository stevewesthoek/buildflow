import {
  WorkbenchMcpAdapterContractError,
  executeWorkbenchMcpAdapterRequest,
  type WorkbenchMcpAdapterErrorCode,
  type WorkbenchMcpAdapterMutationEvidence,
  type WorkbenchMcpAdapterResult,
  type WorkbenchMcpClientAdapter,
  type WorkbenchMcpExecutableAdapterCapabilities
} from './adapter-contract.js'
import {
  WORKBENCH_MCP_REGISTRATION_API_VERSION,
  parseWorkbenchMcpRegistrationRequest,
  type WorkbenchMcpRegistrationOperation,
  type WorkbenchMcpRegistrationRequest,
  type WorkbenchMcpRegistrationSelector
} from './registration-manifest.js'

export const WORKBENCH_MCP_ORCHESTRATION_VERSION = '1.0.0' as const
export const WORKBENCH_MCP_REGISTER_COMMAND = 'mcp register' as const
const MAX_ADAPTERS = 16
const MAX_TARGETS = 16
const MAX_DIAGNOSTICS = 32
const MAX_PATHS = 64
const MAX_MESSAGE = 512

type AdapterIdentity = { adapterId: string; clientId: string }

export type WorkbenchMcpSingleCommand = {
  orchestrationVersion: typeof WORKBENCH_MCP_ORCHESTRATION_VERSION
  command: typeof WORKBENCH_MCP_REGISTER_COMMAND
  mode: 'single'
  adapterId?: string
  request: unknown
}

export type WorkbenchMcpSummaryTarget = {
  adapterId: string
  clientId: string
  selector: WorkbenchMcpRegistrationSelector
}

export type WorkbenchMcpSummaryCommand = {
  orchestrationVersion: typeof WORKBENCH_MCP_ORCHESTRATION_VERSION
  command: typeof WORKBENCH_MCP_REGISTER_COMMAND
  mode: 'summary'
  operation: 'status' | 'audit'
  requestId: string
  targets: WorkbenchMcpSummaryTarget[]
}

export type WorkbenchMcpRegisterCommand = WorkbenchMcpSingleCommand | WorkbenchMcpSummaryCommand

export type WorkbenchMcpOrchestrationError = {
  code: WorkbenchMcpAdapterErrorCode
  message: string
  retryable: boolean
  adapterId?: string
  clientId?: string
  operation?: WorkbenchMcpRegistrationOperation
  mutation?: WorkbenchMcpAdapterMutationEvidence
}

export type WorkbenchMcpSingleResult = {
  orchestrationVersion: typeof WORKBENCH_MCP_ORCHESTRATION_VERSION
  command: typeof WORKBENCH_MCP_REGISTER_COMMAND
  mode: 'single'
  ok: boolean
  requestId?: string
  operation?: WorkbenchMcpRegistrationOperation
  adapterId?: string
  clientId?: string
  result?: WorkbenchMcpExecutableAdapterCapabilities | WorkbenchMcpAdapterResult
  error?: WorkbenchMcpOrchestrationError
}

export type WorkbenchMcpSummaryItem = {
  adapterId: string
  clientId: string
  registrationId: string
  profile: WorkbenchMcpRegistrationSelector['profile']
  ok: boolean
  result?: WorkbenchMcpAdapterResult<'status' | 'audit'>
  error?: WorkbenchMcpOrchestrationError
}

export type WorkbenchMcpSummaryResult = {
  orchestrationVersion: typeof WORKBENCH_MCP_ORCHESTRATION_VERSION
  command: typeof WORKBENCH_MCP_REGISTER_COMMAND
  mode: 'summary'
  ok: boolean
  requestId: string
  operation: 'status' | 'audit'
  total: number
  succeeded: number
  failed: number
  items: WorkbenchMcpSummaryItem[]
}

export type WorkbenchMcpOrchestrationResult = WorkbenchMcpSingleResult | WorkbenchMcpSummaryResult

function key(adapterId: string, clientId: string): string {
  return `${clientId}\u0000${adapterId}`
}

function boundedText(value: string): string {
  return value
    .replace(/wbmcp_v1_[A-Za-z0-9._-]+/g, '[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .slice(0, MAX_MESSAGE)
}

function hasSecretMaterial(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === 'string') return /wbmcp_v1_[A-Za-z0-9._-]+|Bearer\s+[A-Za-z0-9._~+\/-]+/i.test(value)
  if (!value || typeof value !== 'object' || seen.has(value)) return false
  seen.add(value)
  if (Array.isArray(value)) return value.some(item => hasSecretMaterial(item, seen))
  for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = name.toLowerCase().replace(/[-_]/g, '')
    if (['token', 'secret', 'password', 'authorization', 'bearer', 'apikey', 'credentialvalue'].includes(normalized)) return true
    if (hasSecretMaterial(child, seen)) return true
  }
  return false
}

function boundedMutation(value: WorkbenchMcpAdapterMutationEvidence): WorkbenchMcpAdapterMutationEvidence {
  return {
    state: value.state,
    changedPaths: [...value.changedPaths].sort().slice(0, MAX_PATHS),
    rollback: {
      supported: value.rollback.supported,
      attempted: value.rollback.attempted,
      status: value.rollback.status,
      restoredPaths: [...value.rollback.restoredPaths].sort().slice(0, MAX_PATHS),
      ...(value.rollback.message ? { message: boundedText(value.rollback.message) } : {})
    }
  }
}

function boundedResult(value: WorkbenchMcpAdapterResult): WorkbenchMcpAdapterResult {
  return {
    ...value,
    mutation: boundedMutation(value.mutation),
    diagnostics: value.diagnostics
      .map(item => ({ code: boundedText(item.code), message: boundedText(item.message) }))
      .sort((left, right) => left.code.localeCompare(right.code) || left.message.localeCompare(right.message))
      .slice(0, MAX_DIAGNOSTICS)
  }
}

function normalizeError(
  error: unknown,
  fallback: { adapterId?: string; clientId?: string; operation?: WorkbenchMcpRegistrationOperation } = {}
): WorkbenchMcpOrchestrationError {
  if (error instanceof WorkbenchMcpAdapterContractError) {
    const adapterId = error.adapterId ?? fallback.adapterId
    const clientId = error.clientId ?? fallback.clientId
    const operation = error.operation ?? fallback.operation
    return {
      code: error.code,
      message: boundedText(error.message),
      retryable: error.retryable,
      ...(adapterId ? { adapterId } : {}),
      ...(clientId ? { clientId } : {}),
      ...(operation ? { operation } : {}),
      ...(error.mutation ? { mutation: boundedMutation(error.mutation) } : {})
    }
  }
  return {
    code: 'internal',
    message: boundedText(error instanceof Error ? error.message : String(error)),
    retryable: false,
    ...fallback
  }
}

export class WorkbenchMcpAdapterRegistry {
  private readonly byIdentity = new Map<string, WorkbenchMcpClientAdapter>()
  private readonly byClient = new Map<string, WorkbenchMcpClientAdapter[]>()

  constructor(adapters: readonly WorkbenchMcpClientAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter)
  }

  register(adapter: WorkbenchMcpClientAdapter): void {
    if (this.byIdentity.size >= MAX_ADAPTERS) {
      throw new WorkbenchMcpAdapterContractError('invalid_request', `Adapter registry limit ${MAX_ADAPTERS} exceeded.`)
    }
    const identity = key(adapter.adapterId, adapter.clientId)
    if (this.byIdentity.has(identity)) {
      throw new WorkbenchMcpAdapterContractError('conflict', `Adapter ${adapter.adapterId} for client ${adapter.clientId} is already registered.`)
    }
    this.byIdentity.set(identity, adapter)
    const clientAdapters = this.byClient.get(adapter.clientId) ?? []
    clientAdapters.push(adapter)
    clientAdapters.sort((left, right) => left.adapterId.localeCompare(right.adapterId))
    this.byClient.set(adapter.clientId, clientAdapters)
  }

  list(): AdapterIdentity[] {
    return [...this.byIdentity.values()]
      .map(adapter => ({ adapterId: adapter.adapterId, clientId: adapter.clientId }))
      .sort((left, right) => left.clientId.localeCompare(right.clientId) || left.adapterId.localeCompare(right.adapterId))
  }

  resolve(clientId: string, adapterId?: string): WorkbenchMcpClientAdapter {
    if (adapterId) {
      const adapter = this.byIdentity.get(key(adapterId, clientId))
      if (!adapter) throw new WorkbenchMcpAdapterContractError('not_found', `Adapter ${adapterId} for client ${clientId} is not registered.`, { adapterId, clientId })
      return adapter
    }
    const adapters = this.byClient.get(clientId) ?? []
    if (adapters.length === 0) throw new WorkbenchMcpAdapterContractError('not_found', `No adapter is registered for client ${clientId}.`, { clientId })
    if (adapters.length > 1) throw new WorkbenchMcpAdapterContractError('conflict', `Client ${clientId} has multiple adapters; adapterId is required.`, { clientId })
    return adapters[0]
  }
}

function requestIdentity(request: WorkbenchMcpRegistrationRequest, explicitAdapterId?: string): AdapterIdentity {
  if (request.operation === 'inspect_capabilities') return { adapterId: request.adapterId, clientId: request.clientId }
  if (request.operation === 'configure') return { adapterId: request.manifest.target.client.adapterId, clientId: request.manifest.target.client.id }
  return { adapterId: explicitAdapterId ?? '', clientId: request.selector.clientId }
}

async function executeSingle(registry: WorkbenchMcpAdapterRegistry, command: WorkbenchMcpSingleCommand): Promise<WorkbenchMcpSingleResult> {
  if (hasSecretMaterial(command.request)) {
    return {
      orchestrationVersion: WORKBENCH_MCP_ORCHESTRATION_VERSION,
      command: WORKBENCH_MCP_REGISTER_COMMAND,
      mode: 'single',
      ok: false,
      error: normalizeError(new WorkbenchMcpAdapterContractError('invalid_request', 'Secret values are not allowed in registration command input.'))
    }
  }

  let request: WorkbenchMcpRegistrationRequest
  try {
    request = parseWorkbenchMcpRegistrationRequest(command.request)
  } catch (error) {
    return {
      orchestrationVersion: WORKBENCH_MCP_ORCHESTRATION_VERSION,
      command: WORKBENCH_MCP_REGISTER_COMMAND,
      mode: 'single',
      ok: false,
      error: normalizeError(new WorkbenchMcpAdapterContractError('invalid_request', error instanceof Error ? error.message : 'Invalid registration request.', { cause: error }))
    }
  }

  const identity = requestIdentity(request, command.adapterId)
  try {
    const adapter = registry.resolve(identity.clientId, identity.adapterId || undefined)
    const executed = await executeWorkbenchMcpAdapterRequest(adapter, request)
    return {
      orchestrationVersion: WORKBENCH_MCP_ORCHESTRATION_VERSION,
      command: WORKBENCH_MCP_REGISTER_COMMAND,
      mode: 'single',
      ok: true,
      requestId: request.requestId,
      operation: request.operation,
      adapterId: adapter.adapterId,
      clientId: adapter.clientId,
      result: 'operation' in executed ? boundedResult(executed) : executed
    }
  } catch (error) {
    return {
      orchestrationVersion: WORKBENCH_MCP_ORCHESTRATION_VERSION,
      command: WORKBENCH_MCP_REGISTER_COMMAND,
      mode: 'single',
      ok: false,
      requestId: request.requestId,
      operation: request.operation,
      adapterId: identity.adapterId || undefined,
      clientId: identity.clientId,
      error: normalizeError(error, { adapterId: identity.adapterId || undefined, clientId: identity.clientId, operation: request.operation })
    }
  }
}

async function executeSummary(registry: WorkbenchMcpAdapterRegistry, command: WorkbenchMcpSummaryCommand): Promise<WorkbenchMcpSummaryResult> {
  if (command.targets.length > MAX_TARGETS) {
    return {
      orchestrationVersion: WORKBENCH_MCP_ORCHESTRATION_VERSION,
      command: WORKBENCH_MCP_REGISTER_COMMAND,
      mode: 'summary',
      ok: false,
      requestId: command.requestId,
      operation: command.operation,
      total: command.targets.length,
      succeeded: 0,
      failed: command.targets.length,
      items: []
    }
  }

  const targets = [...command.targets].sort((left, right) =>
    left.clientId.localeCompare(right.clientId) || left.adapterId.localeCompare(right.adapterId) || left.selector.registrationId.localeCompare(right.selector.registrationId)
  )
  const items: WorkbenchMcpSummaryItem[] = []
  for (const target of targets) {
    const request = {
      apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
      requestId: `${command.requestId}:${target.clientId}:${target.adapterId}`.slice(0, 160),
      operation: command.operation,
      selector: target.selector
    } as WorkbenchMcpRegistrationRequest
    const single = await executeSingle(registry, {
      orchestrationVersion: WORKBENCH_MCP_ORCHESTRATION_VERSION,
      command: WORKBENCH_MCP_REGISTER_COMMAND,
      mode: 'single',
      adapterId: target.adapterId,
      request
    })
    const base = {
      adapterId: target.adapterId,
      clientId: target.clientId,
      registrationId: target.selector.registrationId,
      profile: target.selector.profile
    }
    if (single.ok && single.result && 'operation' in single.result) {
      items.push({ ...base, ok: true, result: single.result as WorkbenchMcpAdapterResult<'status' | 'audit'> })
    } else {
      items.push({ ...base, ok: false, error: single.error ?? normalizeError(new Error('Missing orchestration result.')) })
    }
  }
  const succeeded = items.filter(item => item.ok).length
  return {
    orchestrationVersion: WORKBENCH_MCP_ORCHESTRATION_VERSION,
    command: WORKBENCH_MCP_REGISTER_COMMAND,
    mode: 'summary',
    ok: succeeded === items.length,
    requestId: command.requestId,
    operation: command.operation,
    total: items.length,
    succeeded,
    failed: items.length - succeeded,
    items
  }
}

export async function executeWorkbenchMcpRegisterCommand(
  registry: WorkbenchMcpAdapterRegistry,
  command: WorkbenchMcpRegisterCommand
): Promise<WorkbenchMcpOrchestrationResult> {
  if (command.orchestrationVersion !== WORKBENCH_MCP_ORCHESTRATION_VERSION || command.command !== WORKBENCH_MCP_REGISTER_COMMAND) {
    return {
      orchestrationVersion: WORKBENCH_MCP_ORCHESTRATION_VERSION,
      command: WORKBENCH_MCP_REGISTER_COMMAND,
      mode: 'single',
      ok: false,
      error: normalizeError(new WorkbenchMcpAdapterContractError('incompatible_version', 'Unsupported MCP registration orchestration command.'))
    }
  }
  return command.mode === 'single' ? executeSingle(registry, command) : executeSummary(registry, command)
}
