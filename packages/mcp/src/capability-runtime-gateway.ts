import crypto from 'node:crypto'
import { executeCapability, executionCoordinatorDiagnostics, type ExecutionCoordinatorOptions, type ExecutionOwner, type ExecutionRecord, type ExecutionRequest, type ExecutionResult } from './capability-execution-coordinator.js'
import type { CapabilityPlan } from './capability-planning.js'
import type { ExecutionValidationState } from './capability-pre-execution.js'
import type { ProviderInventoryRecord } from './provider-inventory.js'

export type RuntimeContextSnapshot = { sessionId: string; status: 'proposed' | 'confirmed' | 'expired' | 'cleared'; sourceIds: string[]; clientId?: string; expiresAt?: string }
export type ExecutionGatewayRequest = { capabilityPlanId: string; contextSessionId: string; providerId: string; capabilityId: string; operation: string; requestIdentity: { requestedBy: string; requestedAt: string }; owner: ExecutionOwner; timeoutMs?: number; signal?: AbortSignal }
export type ExecutionFailure = 'invalid_request' | 'context_missing' | 'context_not_confirmed' | 'context_expired' | 'owner_mismatch' | 'provider_missing' | 'plan_missing' | 'execution_failed' | 'cancellation_not_owned'
export type ExecutionGatewayResult = { ok: true; value: ExecutionRecord } | { ok: false; code: ExecutionFailure; message: string; executionId?: string }
export type ExecutionGatewayOptions = ExecutionCoordinatorOptions & { resolveContext: (sessionId: string) => RuntimeContextSnapshot | undefined; resolvePlan: (planId: string) => CapabilityPlan | undefined; resolveProvider: (providerId: string) => ProviderInventoryRecord | undefined; resolveValidationState: (request: ExecutionGatewayRequest, plan: CapabilityPlan, context: RuntimeContextSnapshot, provider: ProviderInventoryRecord) => ExecutionValidationState }

function sameOwner(left: ExecutionOwner | undefined, right: ExecutionOwner): boolean { return !!left && left.runtimeId === right.runtimeId && left.clientId === right.clientId && left.sessionId === right.sessionId && left.requestId === right.requestId }
function validOwner(owner: ExecutionOwner): boolean { return [owner.runtimeId, owner.clientId, owner.sessionId, owner.requestId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 256) }

export class CapabilityRuntimeGateway {
  private readonly active = new Map<string, { owner: ExecutionOwner; controller: AbortController }>()
  constructor(private readonly options: ExecutionGatewayOptions) {}

  async execute(request: ExecutionGatewayRequest): Promise<ExecutionGatewayResult> {
    if (!validOwner(request.owner) || !request.capabilityPlanId || !request.contextSessionId || !request.providerId || !request.capabilityId || !request.operation) return { ok: false, code: 'invalid_request', message: 'Execution gateway request is incomplete.' }
    const context = this.options.resolveContext(request.contextSessionId)
    if (!context) return { ok: false, code: 'context_missing', message: 'Execution context session is unavailable.' }
    if (context.sessionId !== request.contextSessionId || context.status !== 'confirmed') return { ok: false, code: context.status === 'expired' || context.status === 'cleared' ? 'context_expired' : 'context_not_confirmed', message: 'Execution requires a confirmed active context session.' }
    if (context.expiresAt && Date.parse(context.expiresAt) <= Date.parse(request.requestIdentity.requestedAt)) return { ok: false, code: 'context_expired', message: 'Execution context session has expired.' }
    if (context.clientId && context.clientId !== request.owner.clientId) return { ok: false, code: 'owner_mismatch', message: 'Execution owner does not match the context client.' }
    const plan = this.options.resolvePlan(request.capabilityPlanId)
    if (!plan) return { ok: false, code: 'plan_missing', message: 'Capability plan is unavailable.' }
    const provider = this.options.resolveProvider(request.providerId)
    if (!provider) return { ok: false, code: 'provider_missing', message: 'Capability provider is unavailable.' }
    const controller = new AbortController(); const forwardAbort = () => controller.abort(); request.signal?.addEventListener('abort', forwardAbort, { once: true })
    const executionId = `capability-execution-${crypto.randomUUID()}`
    const executionRequest: ExecutionRequest = { ...request, executionId, owner: request.owner, signal: controller.signal }
    this.active.set(executionId, { owner: request.owner, controller })
    try {
      const result = await executeCapability(executionRequest, { plan, provider, validationState: this.options.resolveValidationState(request, plan, context, provider) }, this.options)
      if (!result.ok) return { ok: false, code: 'execution_failed', message: result.message }
      this.active.delete(executionId)
      return { ok: true, value: result.value }
    } finally { request.signal?.removeEventListener('abort', forwardAbort); this.active.delete(executionId) }
  }

  cancel(executionId: string, owner: ExecutionOwner): { ok: true } | { ok: false; code: 'cancellation_not_owned' | 'execution_not_active'; message: string } {
    const active = this.active.get(executionId)
    if (active) {
      if (!sameOwner(active.owner, owner)) return { ok: false, code: 'cancellation_not_owned', message: 'Only the execution owner may cancel this execution.' }
      active.controller.abort()
      return { ok: true }
    }
    return { ok: false, code: 'execution_not_active', message: `Execution ${executionId} is not active or is not owned by the caller.` }
  }

  diagnostics() { return executionCoordinatorDiagnostics(this.options) }
}

export function createCapabilityRuntimeGateway(options: ExecutionGatewayOptions): CapabilityRuntimeGateway { return new CapabilityRuntimeGateway(options) }
