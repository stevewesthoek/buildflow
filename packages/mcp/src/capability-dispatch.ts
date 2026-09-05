import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { CapabilityPlan } from './capability-planning.js'
import type { ExecutionValidationResult } from './capability-pre-execution.js'
import type { ProviderInventoryRecord } from './provider-inventory.js'

export const WORKBENCH_CAPABILITY_DISPATCH_VERSION = 1 as const
export const WORKBENCH_CAPABILITY_DISPATCH_AUDIT_FILENAME = 'workbench-capability-dispatch-audit.json' as const

export type DispatchRequest = {
  capabilityPlanId: string
  validationId: string
  providerId: string
  capabilityId: string
  requestedOperation: string
  contextSessionId: string
  auditIdentity: { requestedBy: string; requestedAt: string }
}

export type DispatchRejectionReason = 'missing_validation' | 'validation_denied' | 'validation_expired' | 'provider_changed' | 'capability_changed' | 'invalid_plan' | 'missing_adapter' | 'adapter_unavailable' | 'dispatch_policy_denied'
export type DispatchEvidence = { check: string; passed: boolean; detail: string }
export type DispatchDecision = {
  dispatchId: string
  status: 'accepted' | 'rejected'
  adapterId?: string
  rejectionReason?: DispatchRejectionReason
  evidence: DispatchEvidence[]
  auditIdentity: { dispatchId: string; planId: string; requestedAt: string }
}

export type CapabilityAdapterHealth = { available: boolean; detail: string }
export type CapabilityAdapterValidation = { valid: boolean; detail: string }
export type DispatchPlaceholder = { executed: false; reason: 'execution_not_implemented' }
export type CapabilityAdapter = {
  adapterId: string
  supportedProviderTypes: ProviderInventoryRecord['providerType'][]
  capabilityTypes: string[]
  healthCheck: () => CapabilityAdapterHealth
  validate: (request: DispatchRequest) => CapabilityAdapterValidation
  dispatch: (request: DispatchRequest) => DispatchPlaceholder
}

export type DispatchAuditEvent = {
  eventId: string
  eventType: 'dispatch_requested' | 'validation_checked' | 'adapter_selected' | 'dispatch_rejected' | 'dispatch_ready'
  dispatchId: string
  planId: string
  occurredAt: string
  adapterId?: string
  reason?: DispatchRejectionReason
}
export type DispatchAuditStore = { version: typeof WORKBENCH_CAPABILITY_DISPATCH_VERSION; updatedAt: string; events: DispatchAuditEvent[] }
export type DispatchOptions = { rootDir?: string; maxEvents?: number }
export type DispatchResult<T> = { ok: true; value: T } | { ok: false; code: 'dispatch_audit_busy' | 'dispatch_audit_corrupt'; message: string }

const MAX_EVENTS = 500
const LOCK_WAIT_MS = 250
const LOCK_STALE_MS = 30_000
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function root(options?: DispatchOptions): string { return path.resolve(options?.rootDir ?? path.join(process.cwd(), '.workbench-provider-state')) }
export function getDispatchAuditPath(options?: DispatchOptions): string { return path.join(root(options), WORKBENCH_CAPABILITY_DISPATCH_AUDIT_FILENAME) }
function lockPath(options?: DispatchOptions): string { return `${getDispatchAuditPath(options)}.lock` }
function bounded(value: unknown, max = 2_000): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max }
function iso(value: unknown): value is string { return typeof value === 'string' && ISO_DATE.test(value) && Number.isFinite(Date.parse(value)) }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function auditFailure(code: 'dispatch_audit_busy' | 'dispatch_audit_corrupt', message: string) { return { ok: false as const, code, message } }

function emptyStore(): DispatchAuditStore { return { version: WORKBENCH_CAPABILITY_DISPATCH_VERSION, updatedAt: new Date(0).toISOString(), events: [] } }
function validEvent(value: unknown): value is DispatchAuditEvent { return record(value) && bounded(value.eventId) && ['dispatch_requested', 'validation_checked', 'adapter_selected', 'dispatch_rejected', 'dispatch_ready'].includes(String(value.eventType)) && bounded(value.dispatchId) && bounded(value.planId) && iso(value.occurredAt) && (value.adapterId === undefined || bounded(value.adapterId)) && (value.reason === undefined || bounded(value.reason, 100)) }
function readStore(options?: DispatchOptions): DispatchAuditStore | ReturnType<typeof auditFailure> {
  try { const file = getDispatchAuditPath(options); if (!fs.existsSync(file)) return emptyStore(); const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DispatchAuditStore>; if (parsed.version !== WORKBENCH_CAPABILITY_DISPATCH_VERSION || !iso(parsed.updatedAt) || !Array.isArray(parsed.events) || parsed.events.length > MAX_EVENTS || !parsed.events.every(validEvent)) return auditFailure('dispatch_audit_corrupt', 'Dispatch audit store is invalid.'); return { version: 1, updatedAt: parsed.updatedAt, events: parsed.events } } catch { return auditFailure('dispatch_audit_corrupt', 'Dispatch audit store could not be read safely.') }
}
function persistStore(store: DispatchAuditStore, options: DispatchOptions, at: string): void { const file = getDispatchAuditPath(options); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const events = store.events.slice(-Math.min(MAX_EVENTS, Math.max(1, options.maxEvents ?? MAX_EVENTS))); const temp = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`; fs.writeFileSync(temp, JSON.stringify({ version: 1, updatedAt: at, events }), { encoding: 'utf8', mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); fs.chmodSync(file, 0o600) }

function selectAdapter(provider: ProviderInventoryRecord, request: DispatchRequest, adapters: readonly CapabilityAdapter[]): { adapter?: CapabilityAdapter; reason?: DispatchRejectionReason; evidence: DispatchEvidence } {
  for (const adapter of adapters) {
    if (!adapter.supportedProviderTypes.includes(provider.providerType)) continue
    if (!(adapter.capabilityTypes.includes('*') || adapter.capabilityTypes.includes(request.capabilityId))) continue
    const health = adapter.healthCheck()
    if (!health.available) return { reason: 'adapter_unavailable', evidence: { check: 'adapter_health', passed: false, detail: health.detail } }
    const adapterValidation = adapter.validate(request)
    if (!adapterValidation.valid) return { reason: 'adapter_unavailable', evidence: { check: 'adapter_validation', passed: false, detail: adapterValidation.detail } }
    return { adapter, evidence: { check: 'adapter_health', passed: true, detail: health.detail } }
  }
  return { reason: 'missing_adapter', evidence: { check: 'adapter_selection', passed: false, detail: 'No registered adapter supports this provider type and capability.' } }
}

export function dispatchCapability(request: DispatchRequest, input: { plan?: CapabilityPlan; validation?: ExecutionValidationResult; provider?: ProviderInventoryRecord; adapters: readonly CapabilityAdapter[]; policyAllowed?: boolean }, options: DispatchOptions = {}): DispatchResult<DispatchDecision> {
  const dispatchId = `capability-dispatch-${crypto.randomUUID()}`
  const evidence: DispatchEvidence[] = []
  const plan = input.plan
  const validation = input.validation
  let reason: DispatchRejectionReason | undefined
  if (!plan) reason = 'invalid_plan'
  else if (!validation) reason = 'missing_validation'
  else if (!validation.allowed || validation.outcome !== 'allowed' || validation.validationId !== request.validationId) reason = validation.outcome === 'invalidated' ? 'provider_changed' : validation.outcome === 'denied' ? 'validation_denied' : 'missing_validation'
  else if (Date.parse(request.auditIdentity.requestedAt) >= Date.parse(validation.expiresAt)) reason = 'validation_expired'
  else if (!input.provider || input.provider.providerId !== request.providerId) reason = 'provider_changed'
  else if (!input.provider.capabilities.includes(request.capabilityId)) reason = 'capability_changed'
  else if (input.policyAllowed === false) reason = 'dispatch_policy_denied'
  const binding = !!plan && plan.planId === request.capabilityPlanId && plan.contextSessionId === request.contextSessionId && plan.providerId === request.providerId && plan.capabilityId === request.capabilityId && plan.requestedOperation === request.requestedOperation
  evidence.push({ check: 'request_binding', passed: binding, detail: binding ? 'Dispatch request matches plan identity.' : 'Dispatch request does not match plan identity.' }); if (!binding && !reason) reason = 'invalid_plan'
  if (reason) return recordDispatch(request, { dispatchId, status: 'rejected', rejectionReason: reason, evidence }, options)
  const selected = selectAdapter(input.provider!, request, input.adapters)
  evidence.push(selected.evidence)
  if (!selected.adapter) return recordDispatch(request, { dispatchId, status: 'rejected', rejectionReason: selected.reason, evidence }, options)
  evidence.push({ check: 'adapter_selected', passed: true, detail: `Adapter ${selected.adapter.adapterId} selected without execution.` })
  return recordDispatch(request, { dispatchId, status: 'accepted', adapterId: selected.adapter.adapterId, evidence }, options)
}

function recordDispatch(request: DispatchRequest, decision: Omit<DispatchDecision, 'auditIdentity'>, options: DispatchOptions): DispatchResult<DispatchDecision> {
  const result: DispatchDecision = { ...decision, auditIdentity: { dispatchId: decision.dispatchId, planId: request.capabilityPlanId, requestedAt: request.auditIdentity.requestedAt } }
  const lock = lockPath(options); let fd: number | undefined
  try { fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 }); const deadline = Date.now() + LOCK_WAIT_MS; while (Date.now() <= deadline) { try { fd = fs.openSync(lock, 'wx', 0o600); break } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { force: true }) } catch {} } } if (fd === undefined) return auditFailure('dispatch_audit_busy', 'Dispatch audit store is busy.'); const store = readStore(options); if ('ok' in store) return store; const at = request.auditIdentity.requestedAt; const events: DispatchAuditEvent[] = [{ eventId: `dispatch-event-${crypto.randomUUID()}`, eventType: 'dispatch_requested', dispatchId: result.dispatchId, planId: request.capabilityPlanId, occurredAt: at }, { eventId: `dispatch-event-${crypto.randomUUID()}`, eventType: 'validation_checked', dispatchId: result.dispatchId, planId: request.capabilityPlanId, occurredAt: at }]; if (result.status === 'accepted') { events.push({ eventId: `dispatch-event-${crypto.randomUUID()}`, eventType: 'adapter_selected', dispatchId: result.dispatchId, planId: request.capabilityPlanId, occurredAt: at, adapterId: result.adapterId }, { eventId: `dispatch-event-${crypto.randomUUID()}`, eventType: 'dispatch_ready', dispatchId: result.dispatchId, planId: request.capabilityPlanId, occurredAt: at, adapterId: result.adapterId }) } else events.push({ eventId: `dispatch-event-${crypto.randomUUID()}`, eventType: 'dispatch_rejected', dispatchId: result.dispatchId, planId: request.capabilityPlanId, occurredAt: at, reason: result.rejectionReason }); store.events.push(...events); persistStore(store, options, at); return { ok: true, value: result } } catch { return auditFailure('dispatch_audit_corrupt', 'Dispatch audit persistence failed safely.') } finally { if (fd !== undefined) { try { fs.closeSync(fd) } catch {} ; try { fs.rmSync(lock, { force: true }) } catch {} } }
}

export function listDispatchAudit(options?: DispatchOptions): DispatchResult<DispatchAuditEvent[]> { const store = readStore(options); return 'ok' in store ? store : { ok: true, value: store.events } }
export function dispatchDiagnostics(options?: DispatchOptions): DispatchResult<{ pending: string[]; rejected: string[]; unavailableAdapters: string[] }> { const result = listDispatchAudit(options); if (!result.ok) return result; const terminal = new Map<string, DispatchAuditEvent>(); for (const event of result.value) if (['dispatch_ready', 'dispatch_rejected'].includes(event.eventType)) terminal.set(event.dispatchId, event); return { ok: true, value: { pending: [...result.value.filter(event => event.eventType === 'dispatch_requested').map(event => event.dispatchId)].filter(id => !terminal.has(id)), rejected: [...terminal.values()].filter(event => event.eventType === 'dispatch_rejected').map(event => event.dispatchId), unavailableAdapters: [...terminal.values()].filter(event => event.reason === 'missing_adapter' || event.reason === 'adapter_unavailable').map(event => event.dispatchId) } } }
