import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { CapabilityPermission } from './capability-resolution.js'
import type { CapabilityGrantSnapshot, CapabilityPlan } from './capability-planning.js'
import type { ProviderInventoryRecord } from './provider-inventory.js'
import { recordCapabilityAuditEvent } from './capability-audit.js'

export const WORKBENCH_EXECUTION_VALIDATION_VERSION = 1 as const
export const WORKBENCH_EXECUTION_VALIDATION_AUDIT_FILENAME = 'workbench-capability-validation-audit.json' as const

export type ExecutionValidationRequest = {
  capabilityPlanId: string
  contextSessionId: string
  providerId: string
  capabilityId: string
  manifestDigest: string
  requestedOperation: string
  timestamp: string
}

export type ExecutionValidationReason =
  | 'context_expired'
  | 'context_missing'
  | 'context_not_confirmed'
  | 'source_binding_changed'
  | 'provider_missing'
  | 'provider_changed'
  | 'provider_disabled'
  | 'provider_unhealthy'
  | 'capability_changed'
  | 'capability_unavailable'
  | 'grant_invalid'
  | 'budget_exceeded'
  | 'permission_denied'
  | 'approval_missing'
  | 'risk_policy_denied'
  | 'operation_not_allowed'
  | 'stale_plan'
  | 'validation_expired'

export type ValidationEvidence = { check: string; passed: boolean; detail: string }
export type ExecutionValidationResult = {
  validationId: string
  outcome: 'allowed' | 'denied' | 'invalidated'
  allowed: boolean
  reasons: ExecutionValidationReason[]
  evidence: ValidationEvidence[]
  expiresAt: string
  auditIdentity: { validationId: string; planId: string; occurredAt: string }
}

export type ExecutionValidationState = {
  plan?: CapabilityPlan
  context?: { sessionId: string; status: 'proposed' | 'confirmed' | 'expired' | 'cleared'; sourceIds: string[] }
  provider?: ProviderInventoryRecord
  grant?: CapabilityGrantSnapshot
  advertisedCapabilities?: string[]
  operationAllowed?: boolean
  riskPolicy?: { allowLowRisk: boolean; allowMediumRisk: boolean; allowHighRisk: boolean }
}

export type ValidationAuditEvent = {
  eventId: string
  eventType: 'validation.requested' | 'validation.passed' | 'validation.denied' | 'validation.invalidated'
  validationId: string
  planId: string
  occurredAt: string
  reasons: ExecutionValidationReason[]
}
export type ValidationAuditStore = { version: typeof WORKBENCH_EXECUTION_VALIDATION_VERSION; updatedAt: string; events: ValidationAuditEvent[] }
export type ExecutionValidationOptions = { rootDir?: string; maxEvents?: number }
export type ExecutionValidationFailure = { ok: false; code: 'audit_store_busy' | 'audit_store_corrupt'; message: string }
export type ExecutionValidationAuditResult<T> = { ok: true; value: T } | ExecutionValidationFailure

const MAX_EVENTS = 500
const LOCK_WAIT_MS = 250
const LOCK_STALE_MS = 30_000
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const SHA256 = /^[a-f0-9]{64}$/
const PERMISSIONS: readonly CapabilityPermission[] = ['read', 'write', 'command', 'git', 'network', 'capability']

function bounded(value: unknown, max = 2_000): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max }
function iso(value: unknown): value is string { return typeof value === 'string' && ISO_DATE.test(value) && Number.isFinite(Date.parse(value)) }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function failure(code: ExecutionValidationFailure['code'], message: string): ExecutionValidationFailure { return { ok: false, code, message } }
function auditRoot(options?: ExecutionValidationOptions): string { return path.resolve(options?.rootDir ?? path.join(process.cwd(), '.workbench-provider-state')) }
export function getExecutionValidationAuditPath(options?: ExecutionValidationOptions): string { return path.join(auditRoot(options), WORKBENCH_EXECUTION_VALIDATION_AUDIT_FILENAME) }
function lockPath(options?: ExecutionValidationOptions): string { return `${getExecutionValidationAuditPath(options)}.lock` }

function planMatches(request: ExecutionValidationRequest, plan: CapabilityPlan): boolean {
  return request.capabilityPlanId === plan.planId && request.contextSessionId === plan.contextSessionId && request.providerId === plan.providerId && request.capabilityId === plan.capabilityId && request.manifestDigest === plan.capabilityManifestDigest && request.requestedOperation === plan.requestedOperation
}
function permissionDigest(value: CapabilityPermission[]): string { return crypto.createHash('sha256').update(JSON.stringify([...value].sort())).digest('hex') }
function canonical(value: unknown): string { return JSON.stringify(value, Object.keys((value && typeof value === 'object') ? value as object : {}).sort()) }
function budgetDigest(value: unknown): string { return crypto.createHash('sha256').update(canonical(value)).digest('hex') }
function evidence(check: string, passed: boolean, detail: string): ValidationEvidence { return { check, passed, detail } }

export function validateCapabilityBeforeExecution(request: ExecutionValidationRequest, state: ExecutionValidationState): ExecutionValidationResult {
  const validationId = `execution-validation-${crypto.randomUUID()}`
  const reasons: ExecutionValidationReason[] = []
  const evidenceItems: ValidationEvidence[] = []
  const plan = state.plan
  if (!plan) { reasons.push('stale_plan'); evidenceItems.push(evidence('plan_exists', false, 'Capability plan was not supplied.')) }
  else {
    const matches = planMatches(request, plan); evidenceItems.push(evidence('plan_binding', matches, matches ? 'Request matches plan identity and operation.' : 'Request does not match the approved plan binding.')); if (!matches) reasons.push('stale_plan')
    const approved = plan.approvalState === 'approved' && plan.validity === 'valid'; evidenceItems.push(evidence('approval', approved, approved ? 'Plan is approved and valid.' : 'Plan is not approved or has been invalidated.')); if (!approved) reasons.push(plan.approvalState === 'approved' ? 'stale_plan' : 'approval_missing')
    const unexpired = Date.parse(request.timestamp) < Date.parse(plan.expiresAt); evidenceItems.push(evidence('plan_expiry', unexpired, unexpired ? 'Plan has not expired.' : 'Plan expiry has passed.')); if (!unexpired) reasons.push('validation_expired')
    if (state.context?.status === 'expired' || state.context?.status === 'cleared') reasons.push('context_expired')
    else if (!state.context) reasons.push('context_missing')
    else if (state.context.status !== 'confirmed') reasons.push('context_not_confirmed')
    const contextValid = !!state.context && state.context.sessionId === plan.contextSessionId && JSON.stringify([...state.context.sourceIds].sort()) === JSON.stringify(plan.sourceIds)
    evidenceItems.push(evidence('context_binding', contextValid, contextValid ? 'Context session and source binding match.' : 'Context session or source binding changed.')); if (!contextValid) reasons.push(state.context?.status === 'expired' || state.context?.status === 'cleared' ? 'context_expired' : 'source_binding_changed')
    const provider = state.provider; const providerExists = !!provider; evidenceItems.push(evidence('provider_exists', providerExists, providerExists ? 'Provider is present.' : 'Provider is missing.')); if (!provider) reasons.push('provider_missing')
    else {
      const identity = provider.providerId === plan.providerId; evidenceItems.push(evidence('provider_identity', identity, identity ? 'Provider identity matches.' : 'Provider identity changed.')); if (!identity) reasons.push('provider_changed')
      const digestMatches = provider.manifestIdentity.digest === plan.capabilityManifestDigest && request.manifestDigest === provider.manifestIdentity.digest; evidenceItems.push(evidence('manifest_digest', digestMatches, digestMatches ? 'Manifest digest matches.' : 'Manifest digest changed.')); if (!digestMatches) reasons.push('provider_changed')
      const enabled = provider.enabled && provider.registrationState !== 'disabled'; evidenceItems.push(evidence('provider_enabled', enabled, enabled ? 'Provider is enabled.' : 'Provider is disabled.')); if (!enabled) reasons.push('provider_disabled')
      const healthy = provider.health === 'healthy'; evidenceItems.push(evidence('provider_health', healthy, healthy ? 'Provider health is healthy.' : `Provider health is ${provider.health}.`)); if (!healthy) reasons.push('provider_unhealthy')
      const capability = state.advertisedCapabilities?.includes(plan.capabilityId) ?? provider.capabilities.includes(plan.capabilityId); evidenceItems.push(evidence('capability_advertised', capability, capability ? 'Capability remains advertised.' : 'Capability is no longer advertised.')); if (!capability) reasons.push('capability_unavailable')
    }
    const grant = state.grant; const grantValid = !!grant && grant.state === 'active' && grant.grantId === plan.grantBinding.grantId && grant.grantVersion === plan.grantBinding.grantVersion; evidenceItems.push(evidence('grant_identity', grantValid, grantValid ? 'Grant identity is active and matches.' : 'Grant is missing, inactive, or changed.')); if (!grantValid) reasons.push('grant_invalid')
    if (grant) {
      const permissionsMatch = permissionDigest(grant.permissions) === plan.grantBinding.permissionDigest && plan.requiredPermissions.every(permission => grant.permissions.includes(permission)); evidenceItems.push(evidence('permissions', permissionsMatch, permissionsMatch ? 'Permissions remain compatible.' : 'Permissions changed or are insufficient.')); if (!permissionsMatch) reasons.push('permission_denied')
      const budgetsMatch = budgetDigest(grant.budgets) === plan.grantBinding.budgetDigest && plan.requiredBudgets.maximumBytes <= grant.budgets.maximumBytes && plan.requiredBudgets.maximumDurationMs <= grant.budgets.maximumDurationMs && plan.requiredBudgets.maximumQueries <= grant.budgets.maximumQueries; evidenceItems.push(evidence('budgets', budgetsMatch, budgetsMatch ? 'Budgets remain available.' : 'Budgets are changed or exceeded.')); if (!budgetsMatch) reasons.push('budget_exceeded')
    }
    const operationAllowed = state.operationAllowed !== false; evidenceItems.push(evidence('operation_policy', operationAllowed, operationAllowed ? 'Operation is allowed by policy.' : 'Operation is denied by policy.')); if (!operationAllowed) reasons.push('operation_not_allowed')
    const riskAllowed = state.riskPolicy ? state.riskPolicy[ `allow${plan.riskClassification[0].toUpperCase()}${plan.riskClassification.slice(1)}Risk` as 'allowLowRisk' | 'allowMediumRisk' | 'allowHighRisk'] : true; evidenceItems.push(evidence('risk_policy', riskAllowed, riskAllowed ? 'Risk policy permits the plan.' : 'Risk policy denies the plan.')); if (!riskAllowed) reasons.push('risk_policy_denied')
  }
  const uniqueReasons = [...new Set(reasons)]
  const invalidated = uniqueReasons.some(reason => ['stale_plan', 'provider_changed', 'context_expired', 'capability_changed'].includes(reason))
  const outcome = invalidated ? 'invalidated' : uniqueReasons.length > 0 ? 'denied' : 'allowed'
  return { validationId, outcome, allowed: outcome === 'allowed', reasons: uniqueReasons, evidence: evidenceItems, expiresAt: plan?.expiresAt ?? request.timestamp, auditIdentity: { validationId, planId: request.capabilityPlanId, occurredAt: request.timestamp } }
}

function validEvent(value: unknown): value is ValidationAuditEvent { return record(value) && bounded(value.eventId) && ['validation.requested', 'validation.passed', 'validation.denied', 'validation.invalidated'].includes(String(value.eventType)) && bounded(value.validationId) && bounded(value.planId) && iso(value.occurredAt) && Array.isArray(value.reasons) && value.reasons.every(item => bounded(item, 100)) }
function readAudit(options?: ExecutionValidationOptions): ValidationAuditStore | ExecutionValidationFailure {
  try { const file = getExecutionValidationAuditPath(options); if (!fs.existsSync(file)) return { version: 1, updatedAt: new Date(0).toISOString(), events: [] }; const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ValidationAuditStore>; if (parsed.version !== 1 || !iso(parsed.updatedAt) || !Array.isArray(parsed.events) || parsed.events.length > MAX_EVENTS || !parsed.events.every(validEvent)) return failure('audit_store_corrupt', 'Execution validation audit store is invalid.'); return { version: 1, updatedAt: parsed.updatedAt, events: parsed.events } } catch { return failure('audit_store_corrupt', 'Execution validation audit store could not be read safely.') }
}
function persistAudit(store: ValidationAuditStore, options: ExecutionValidationOptions, at: string): void { const file = getExecutionValidationAuditPath(options); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const events = store.events.slice(-Math.min(MAX_EVENTS, Math.max(1, options.maxEvents ?? MAX_EVENTS))); const temp = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`; fs.writeFileSync(temp, JSON.stringify({ version: 1, updatedAt: at, events }), { encoding: 'utf8', mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); fs.chmodSync(file, 0o600) }

export function validateAndAuditCapability(request: ExecutionValidationRequest, state: ExecutionValidationState, options: ExecutionValidationOptions = {}): ExecutionValidationAuditResult<ExecutionValidationResult> {
  const lock = lockPath(options); let fd: number | undefined
  try { fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 }); const deadline = Date.now() + LOCK_WAIT_MS; while (Date.now() <= deadline) { try { fd = fs.openSync(lock, 'wx', 0o600); break } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { force: true }) } catch {} } } if (fd === undefined) return failure('audit_store_busy', 'Execution validation audit store is busy.'); const store = readAudit(options); if ('ok' in store) return store; const result = validateCapabilityBeforeExecution(request, state); store.events.push({ eventId: `validation-event-${crypto.randomUUID()}`, eventType: 'validation.requested', validationId: result.validationId, planId: request.capabilityPlanId, occurredAt: request.timestamp, reasons: [] }); store.events.push({ eventId: `validation-event-${crypto.randomUUID()}`, eventType: result.outcome === 'allowed' ? 'validation.passed' : result.outcome === 'invalidated' ? 'validation.invalidated' : 'validation.denied', validationId: result.validationId, planId: request.capabilityPlanId, occurredAt: request.timestamp, reasons: result.reasons }); persistAudit(store, options, request.timestamp); recordCapabilityAuditEvent({ eventType: 'validation.requested', validationId: result.validationId, planId: request.capabilityPlanId, occurredAt: request.timestamp }, options); recordCapabilityAuditEvent({ eventType: result.allowed ? 'validation.approved' : 'validation.rejected', validationId: result.validationId, planId: request.capabilityPlanId, occurredAt: request.timestamp, ...(result.reasons[0] ? { reason: result.reasons[0] } : {}) }, options); return { ok: true, value: result } } catch { return failure('audit_store_corrupt', 'Execution validation audit persistence failed safely.') } finally { if (fd !== undefined) { try { fs.closeSync(fd) } catch {} ; try { fs.rmSync(lock, { force: true }) } catch {} } }
}

export function listValidationAudit(options?: ExecutionValidationOptions): ExecutionValidationAuditResult<ValidationAuditEvent[]> { const store = readAudit(options); return 'ok' in store ? store : { ok: true, value: store.events } }
export function validationDiagnostics(options?: ExecutionValidationOptions): ExecutionValidationAuditResult<{ pending: string[]; denied: string[]; invalidated: string[]; commonFailureReasons: string[] }> {
  const result = listValidationAudit(options)
  if (!result.ok) return result
  const latest = new Map<string, ValidationAuditEvent>()
  for (const event of result.value) latest.set(event.validationId, event)
  return {
    ok: true,
    value: {
      pending: [...latest.values()].filter(event => event.eventType === 'validation.requested').map(event => event.validationId).sort(),
      denied: [...latest.values()].filter(event => event.eventType === 'validation.denied').map(event => event.validationId).sort(),
      invalidated: [...latest.values()].filter(event => event.eventType === 'validation.invalidated').map(event => event.validationId).sort(),
      commonFailureReasons: [...new Set(result.value.flatMap(event => event.reasons))].sort()
    }
  }
}
