import {
  createAndPersistCapabilityPlan,
  listCapabilityPlans,
  transitionCapabilityPlan,
  type CapabilityBudget,
  type CapabilityGrantSnapshot,
  type CapabilityPlan,
  type CapabilityPlanResult
} from '../../../mcp/dist/capability-planning.js'
import { resolveCapabilities, type CapabilityMatch, type CapabilityPermission, type CapabilityResolution } from '../../../mcp/dist/capability-resolution.js'
import { listCapabilityProviders } from '../../../mcp/dist/capability-provider.js'
import { createCapabilityRuntimeGateway, type ExecutionGatewayResult, type ExecutionFailure, type RuntimeContextSnapshot } from '../../../mcp/dist/capability-runtime-gateway.js'
import type { ExecutableCapabilityAdapter, ExecutionOwner } from '../../../mcp/dist/capability-execution-coordinator.js'
import { getClientWorkflowSession, type ClientWorkflowStoreOptions } from '../../../mcp/dist/client-capability-workflow.js'
import { attachWorkbenchEvidence, type WorkbenchEvidenceAttachment } from './workbench-evidence-producers'

export type McpClientCapabilityWorkflowOptions = ClientWorkflowStoreOptions & {
  capabilityRootDir?: string
  adapters: readonly ExecutableCapabilityAdapter[]
  resolveContext: (clientSessionId: string) => RuntimeContextSnapshot | undefined
  grantsFor: (clientSessionId: string, capabilityId: string) => readonly CapabilityGrantSnapshot[]
  catalog?: readonly CapabilityMatch[]
  now?: () => Date
  evidenceStorePath?: string
}

export type ClientPlanRequest = {
  clientSessionId: string
  query: string
  capabilityId?: string
  operation: string
  permissions?: CapabilityPermission[]
  budgets: CapabilityBudget
  expiresAt: string
  createdBy: string
}

export type ClientExecutionRequest = {
  clientSessionId: string
  planId: string
  requestId: string
  requestedBy: string
  runtimeId: string
  timeoutMs?: number
}

function failure(code: string, message: string) { return { ok: false as const, code, message } }
function gatewayFailure(code: ExecutionFailure, message: string): ExecutionGatewayResult { return { ok: false, code, message } }
function session(options: McpClientCapabilityWorkflowOptions, clientSessionId: string) {
  const result = getClientWorkflowSession(clientSessionId, options)
  return result.ok ? result.value : undefined
}

function capabilityEvidence(params: {
  sourceIds: string[]
  clientSessionId: string
  sessionId?: string
  requestId?: string
  operationId: string
  providerId?: string
  content: string
}, options: McpClientCapabilityWorkflowOptions): WorkbenchEvidenceAttachment {
  const scopedSourceIds = params.sourceIds.length > 0
    ? params.sourceIds
    : [`capability-session:${params.clientSessionId}`]
  return attachWorkbenchEvidence({
    entries: scopedSourceIds.map(sourceId => ({
      kind: 'capability_result' as const,
      owner: {
        sourceId,
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        ...(params.requestId ? { requestId: params.requestId } : {}),
        operationId: params.operationId,
        ...(params.providerId ? { providerId: params.providerId } : {})
      },
      retentionClass: params.sessionId ? 'active_run' as const : 'standard' as const,
      content: params.content
    }))
  }, options.evidenceStorePath ? { storePath: options.evidenceStorePath } : {})
}

function capabilityEvidenceContent(value: unknown): string {
  let serialized: string
  try {
    serialized = JSON.stringify(value) || '{}'
  } catch {
    serialized = '{}'
  }
  return serialized.slice(0, 16_000)
}

export function createMcpClientCapabilityWorkflow(options: McpClientCapabilityWorkflowOptions) {
  const rootDir = options.capabilityRootDir ?? options.rootDir
  const planOptions = { rootDir }

  function discover(clientSessionId: string) {
    if (!session(options, clientSessionId)) return failure('session_unavailable', 'External MCP client session is unavailable.')
    const inventory = listCapabilityProviders({ rootDir })
    if (!inventory.ok) return inventory
    const value = inventory.value.filter(item => item.enabled && item.registrationState === 'enabled' && item.health === 'healthy').slice(0, 64).map(item => ({ providerId: item.providerId, displayName: item.displayName, capabilities: item.capabilities.slice(0, 128), health: item.health }))
    const context = options.resolveContext(clientSessionId)
    const evidence = capabilityEvidence({
      sourceIds: context?.sourceIds || [],
      clientSessionId,
      sessionId: context?.sessionId,
      operationId: `capability-discover:${clientSessionId}`,
      content: capabilityEvidenceContent({ operation: 'discover', providers: value })
    }, options)
    return { ok: true as const, value, ...evidence }
  }

  function plan(input: ClientPlanRequest) {
    const external = session(options, input.clientSessionId)
    if (!external) return failure('session_unavailable', 'External MCP client session is unavailable.') as CapabilityPlanResult<CapabilityPlan>
    const context = options.resolveContext(input.clientSessionId)
    if (!context || context.status !== 'confirmed') return failure('context_not_confirmed', 'A confirmed internal context session is required.') as CapabilityPlanResult<CapabilityPlan>
    const providers = listCapabilityProviders({ rootDir })
    if (!providers.ok) return failure('provider_unavailable', 'Capability provider inventory is unavailable.') as CapabilityPlanResult<CapabilityPlan>
    const resolution: CapabilityResolution = resolveCapabilities({ context: { sessionId: context.sessionId, status: context.status, sourceIds: context.sourceIds, allowedPermissions: input.permissions }, intent: { query: input.query, ...(input.capabilityId ? { requestedCapabilities: [input.capabilityId] } : {}), requiredPermissions: input.permissions }, providers: providers.value, catalog: options.catalog, now: (options.now ?? (() => new Date()))().toISOString() })
    const grants = options.grantsFor(input.clientSessionId, input.capabilityId ?? resolution.candidates[0]?.capabilityId ?? '')
    const result = createAndPersistCapabilityPlan({ context: { sessionId: context.sessionId, status: context.status, sourceIds: context.sourceIds }, resolution, providers: providers.value, grants, selectedCapabilityId: input.capabilityId, requestedOperation: input.operation, requiredPermissions: input.permissions, requiredBudgets: input.budgets, expiresAt: input.expiresAt, createdBy: input.createdBy, now: (options.now ?? (() => new Date()))().toISOString() }, planOptions)
    if (!result.ok) return result
    const evidence = capabilityEvidence({
      sourceIds: result.value.sourceIds,
      clientSessionId: input.clientSessionId,
      sessionId: result.value.contextSessionId,
      operationId: `capability-plan:${result.value.planId}`,
      providerId: result.value.providerId,
      content: capabilityEvidenceContent({ operation: 'plan', plan: result.value })
    }, options)
    return { ...result, evidenceRefs: evidence.evidenceRefs, evidenceUnavailable: evidence.evidenceUnavailable }
  }

  function approve(clientSessionId: string, planId: string): CapabilityPlanResult<CapabilityPlan> {
    if (!session(options, clientSessionId)) return failure('session_unavailable', 'External MCP client session is unavailable.') as CapabilityPlanResult<CapabilityPlan>
    const plans = listCapabilityPlans(planOptions)
    if ('code' in plans) return failure(plans.code, plans.message) as CapabilityPlanResult<CapabilityPlan>
    const stored = plans.value.find(item => item.planId === planId)
    if (!stored) return failure('plan_not_found', 'Capability plan was not found.') as CapabilityPlanResult<CapabilityPlan>
    if (stored.contextSessionId !== options.resolveContext(clientSessionId)?.sessionId) return failure('owner_mismatch', 'Capability plan does not belong to this client session.') as CapabilityPlanResult<CapabilityPlan>
    const reviewed = transitionCapabilityPlan(planId, 'reviewed', planOptions)
    if (!reviewed.ok) return reviewed
    return transitionCapabilityPlan(planId, 'approved', planOptions)
  }

  async function execute(input: ClientExecutionRequest): Promise<ExecutionGatewayResult> {
    const external = session(options, input.clientSessionId)
    if (!external) return gatewayFailure('context_missing', 'External MCP client session is unavailable.')
    const plans = listCapabilityPlans(planOptions)
    if ('code' in plans) return gatewayFailure('execution_failed', plans.message)
    const planRecord = plans.value.find(item => item.planId === input.planId)
    if (!planRecord) return gatewayFailure('plan_missing', 'Capability plan was not found.')
    if (planRecord.contextSessionId !== options.resolveContext(input.clientSessionId)?.sessionId) return gatewayFailure('owner_mismatch', 'Capability plan does not belong to this client session.')
    const providers = listCapabilityProviders({ rootDir })
    if (!providers.ok) return gatewayFailure('provider_missing', 'Capability provider inventory is unavailable.')
    const provider = providers.value.find(item => item.providerId === planRecord.providerId)
    const context = options.resolveContext(input.clientSessionId)
    if (!provider || !context) return gatewayFailure('provider_missing', 'Capability provider or context is unavailable.')
    const grant = options.grantsFor(input.clientSessionId, planRecord.capabilityId).find(item => item.grantId === planRecord.grantBinding.grantId)
    const gateway = createCapabilityRuntimeGateway({ rootDir, adapters: options.adapters, resolveContext: options.resolveContext, resolvePlan: planId => { const current = listCapabilityPlans(planOptions); return current.ok ? current.value.find(item => item.planId === planId) : undefined }, resolveProvider: providerId => providers.value.find(item => item.providerId === providerId), resolveValidationState: request => ({ context, provider, grant, advertisedCapabilities: provider.capabilities, operationAllowed: true, riskPolicy: { allowLowRisk: true, allowMediumRisk: true, allowHighRisk: true } }) })
    const owner: ExecutionOwner = { runtimeId: input.runtimeId, clientId: external.clientId, sessionId: input.clientSessionId, requestId: input.requestId }
    const result = await gateway.execute({ capabilityPlanId: planRecord.planId, contextSessionId: context.sessionId, providerId: planRecord.providerId, capabilityId: planRecord.capabilityId, operation: planRecord.requestedOperation, requestIdentity: { requestedBy: input.requestedBy, requestedAt: (options.now ?? (() => new Date()))().toISOString() }, owner, timeoutMs: input.timeoutMs })
    const executionId = result.ok === true
      ? result.value.executionId
      : ('executionId' in result && result.executionId) || `request:${input.requestId}`
    const evidence = capabilityEvidence({
      sourceIds: planRecord.sourceIds,
      clientSessionId: input.clientSessionId,
      sessionId: context.sessionId,
      requestId: input.requestId,
      operationId: `capability-execution:${executionId}`,
      providerId: planRecord.providerId,
      content: capabilityEvidenceContent({ operation: 'execute', result })
    }, options)
    return { ...result, ...evidence }
  }

  function result(executionId: string) { return failure('result_unavailable', `Execution result retrieval for ${executionId} is not yet exposed by the existing execution store.`) }
  return { discover, plan, approve, execute, result }
}
