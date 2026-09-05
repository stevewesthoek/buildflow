import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { CapabilityPermission, CapabilityResolution } from './capability-resolution.js'
import type { ProviderInventoryRecord, ProviderInventoryStoreOptions } from './provider-inventory.js'
import { recordCapabilityAuditEvent } from './capability-audit.js'

export const WORKBENCH_CAPABILITY_PLAN_VERSION = 1 as const
export const WORKBENCH_CAPABILITY_PLAN_FILENAME = 'workbench-capability-plans.json' as const

export type CapabilityPlanApprovalState = 'proposed' | 'reviewed' | 'approved' | 'rejected' | 'expired' | 'cancelled'
export type CapabilityPlanValidity = 'valid' | 'invalidated'
export type CapabilityRisk = 'low' | 'medium' | 'high'
export type CapabilityBudget = { maximumBytes: number; maximumDurationMs: number; maximumQueries: number }
export type CapabilityGrantSnapshot = {
  grantId: string
  grantVersion: number
  state: 'active' | 'expired' | 'revoked' | 'denied'
  permissions: CapabilityPermission[]
  allowedProviderIds?: string[]
  allowedCapabilityIds?: string[]
  budgets: CapabilityBudget
  expiresAt?: string
}

export type CapabilityPlan = {
  planId: string
  contextSessionId: string
  sourceIds: string[]
  providerId: string
  capabilityId: string
  capabilityManifestDigest: string
  selectedCandidateReason: string
  requestedOperation: string
  requiredPermissions: CapabilityPermission[]
  requiredBudgets: CapabilityBudget
  riskClassification: CapabilityRisk
  expiresAt: string
  approvalState: CapabilityPlanApprovalState
  validity: CapabilityPlanValidity
  invalidationReason?: 'provider_changed' | 'capability_changed' | 'context_expired' | 'permissions_changed' | 'grant_expired' | 'plan_expired'
  auditIdentity: { resolutionId: string; grantId: string; createdAt: string; createdBy: string }
  grantBinding: { grantId: string; grantVersion: number; permissionDigest: string; budgetDigest: string }
}

export type CapabilityPlanInput = {
  context: { sessionId: string; status: 'proposed' | 'confirmed' | 'expired' | 'cleared'; sourceIds: string[] }
  resolution: CapabilityResolution
  providers: readonly ProviderInventoryRecord[]
  grants: readonly CapabilityGrantSnapshot[]
  selectedProviderId?: string
  selectedCapabilityId?: string
  requestedOperation: string
  requiredPermissions?: CapabilityPermission[]
  requiredBudgets: CapabilityBudget
  riskClassification?: CapabilityRisk
  expiresAt: string
  createdBy: string
  now: string
}

export type CapabilityPlanFailureCode = 'resolution_mismatch' | 'candidate_ineligible' | 'provider_missing' | 'grant_missing' | 'grant_incompatible' | 'context_invalid' | 'invalid_expiry' | 'plan_store_corrupt' | 'plan_store_busy' | 'plan_not_found' | 'invalid_transition'
export type CapabilityPlanFailure = { ok: false; code: CapabilityPlanFailureCode; message: string }
export type CapabilityPlanResult<T> = { ok: true; value: T } | CapabilityPlanFailure
export type CapabilityPlanStore = { version: typeof WORKBENCH_CAPABILITY_PLAN_VERSION; updatedAt: string; plans: CapabilityPlan[] }
export type CapabilityPlanStoreOptions = ProviderInventoryStoreOptions & { maxPlans?: number }

const MAX_PLANS = 300
const MAX_STRING = 2_000
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const LOCK_WAIT_MS = 250
const LOCK_STALE_MS = 30_000
const PERMISSIONS: readonly CapabilityPermission[] = ['read', 'write', 'command', 'git', 'network', 'capability']
const STATES: readonly CapabilityPlanApprovalState[] = ['proposed', 'reviewed', 'approved', 'rejected', 'expired', 'cancelled']

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function bounded(value: unknown, max = MAX_STRING): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max }
function iso(value: unknown): value is string { return typeof value === 'string' && ISO_DATE.test(value) && Number.isFinite(Date.parse(value)) }
function failure(code: CapabilityPlanFailureCode, message: string): CapabilityPlanFailure { return { ok: false, code, message } }
function sortedUnique(values: string[]): string[] { return [...new Set(values)].sort() }
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}
function digest(value: unknown): string { return crypto.createHash('sha256').update(canonical(value)).digest('hex') }
function planRoot(options?: CapabilityPlanStoreOptions): string { return path.resolve(options?.rootDir ?? path.join(process.cwd(), '.workbench-provider-state')) }
export function getCapabilityPlanStorePath(options?: CapabilityPlanStoreOptions): string { return path.join(planRoot(options), WORKBENCH_CAPABILITY_PLAN_FILENAME) }
function lockPath(options?: CapabilityPlanStoreOptions): string { return `${getCapabilityPlanStorePath(options)}.lock` }

function requiredPermissionSet(plan: CapabilityPlanInput): CapabilityPermission[] { return sortedUnique(plan.requiredPermissions ?? []) as CapabilityPermission[] }
function grantFor(input: CapabilityPlanInput, providerId: string, capabilityId: string): CapabilityGrantSnapshot | undefined {
  return input.grants.find(grant => grant.state === 'active'
    && (!grant.allowedProviderIds || grant.allowedProviderIds.includes(providerId))
    && (!grant.allowedCapabilityIds || grant.allowedCapabilityIds.includes(capabilityId)))
}
function grantSupports(grant: CapabilityGrantSnapshot, permissions: CapabilityPermission[], budget: CapabilityBudget): boolean {
  return permissions.every(permission => grant.permissions.includes(permission))
    && budget.maximumBytes <= grant.budgets.maximumBytes
    && budget.maximumDurationMs <= grant.budgets.maximumDurationMs
    && budget.maximumQueries <= grant.budgets.maximumQueries
}
function riskFor(permissions: CapabilityPermission[], requested: CapabilityRisk | undefined): CapabilityRisk {
  if (requested) return requested
  if (permissions.some(permission => ['write', 'command', 'network'].includes(permission))) return 'high'
  if (permissions.includes('capability')) return 'medium'
  return 'low'
}

export function createCapabilityPlan(input: CapabilityPlanInput): CapabilityPlanResult<CapabilityPlan> {
  if (input.context.status === 'expired' || input.context.status === 'cleared') return failure('context_invalid', 'Context session is not available for planning.')
  if (input.resolution.sessionId !== input.context.sessionId) return failure('resolution_mismatch', 'Resolution does not belong to the supplied context session.')
  if (!iso(input.expiresAt) || Date.parse(input.expiresAt) <= Date.parse(input.now)) return failure('invalid_expiry', 'Capability plan expiry must be a future canonical timestamp.')
  const selected = input.resolution.candidates.find(candidate => candidate.eligible
    && (!input.selectedProviderId || candidate.providerId === input.selectedProviderId)
    && (!input.selectedCapabilityId || candidate.capabilityId === input.selectedCapabilityId))
  if (!selected) return failure('candidate_ineligible', 'No eligible resolved capability candidate matches the requested selection.')
  const provider = input.providers.find(item => item.providerId === selected.providerId)
  if (!provider) return failure('provider_missing', `Provider ${selected.providerId} is not present in the inventory.`)
  const grant = grantFor(input, selected.providerId, selected.capabilityId)
  if (!grant) return failure('grant_missing', 'No active grant covers the selected provider and capability.')
  const permissions = requiredPermissionSet(input)
  if (!grantSupports(grant, permissions, input.requiredBudgets)) return failure('grant_incompatible', 'Grant permissions or budgets do not cover the capability plan.')
  const reason = selected.matchReasons.length > 0 ? selected.matchReasons.join(',') : 'eligible_capability_candidate'
  return { ok: true, value: {
    planId: `capability-plan-${crypto.randomUUID()}`,
    contextSessionId: input.context.sessionId,
    sourceIds: [...input.context.sourceIds].sort(),
    providerId: provider.providerId,
    capabilityId: selected.capabilityId,
    capabilityManifestDigest: provider.manifestIdentity.digest,
    selectedCandidateReason: reason,
    requestedOperation: input.requestedOperation,
    requiredPermissions: permissions,
    requiredBudgets: input.requiredBudgets,
    riskClassification: riskFor(permissions, input.riskClassification),
    expiresAt: input.expiresAt,
    approvalState: 'proposed',
    validity: 'valid',
    auditIdentity: { resolutionId: input.resolution.resolutionId, grantId: grant.grantId, createdAt: input.now, createdBy: input.createdBy },
    grantBinding: { grantId: grant.grantId, grantVersion: grant.grantVersion, permissionDigest: digest(grant.permissions), budgetDigest: digest(grant.budgets) }
  } }
}

function validPlan(value: unknown): value is CapabilityPlan {
  if (!isRecord(value)) return false
  return bounded(value.planId) && bounded(value.contextSessionId) && Array.isArray(value.sourceIds) && value.sourceIds.every(item => bounded(item, 200)) && bounded(value.providerId, 160) && bounded(value.capabilityId, 160) && /^[a-f0-9]{64}$/.test(String(value.capabilityManifestDigest)) && bounded(value.selectedCandidateReason) && bounded(value.requestedOperation) && Array.isArray(value.requiredPermissions) && value.requiredPermissions.every(item => PERMISSIONS.includes(item as CapabilityPermission)) && isRecord(value.requiredBudgets) && Object.values(value.requiredBudgets).every(item => typeof item === 'number' && item >= 0) && ['low', 'medium', 'high'].includes(String(value.riskClassification)) && iso(value.expiresAt) && STATES.includes(value.approvalState as CapabilityPlanApprovalState) && ['valid', 'invalidated'].includes(String(value.validity)) && isRecord(value.auditIdentity) && bounded(value.auditIdentity.resolutionId) && bounded(value.auditIdentity.grantId) && iso(value.auditIdentity.createdAt) && bounded(value.auditIdentity.createdBy) && isRecord(value.grantBinding) && bounded(value.grantBinding.grantId) && Number.isInteger(value.grantBinding.grantVersion) && /^[a-f0-9]{64}$/.test(String(value.grantBinding.permissionDigest)) && /^[a-f0-9]{64}$/.test(String(value.grantBinding.budgetDigest))
}
function emptyStore(): CapabilityPlanStore { return { version: WORKBENCH_CAPABILITY_PLAN_VERSION, updatedAt: new Date(0).toISOString(), plans: [] } }
function readStore(options?: CapabilityPlanStoreOptions): CapabilityPlanStore | CapabilityPlanFailure {
  try {
    const file = getCapabilityPlanStorePath(options)
    if (!fs.existsSync(file)) return emptyStore()
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<CapabilityPlanStore>
    if (parsed.version !== WORKBENCH_CAPABILITY_PLAN_VERSION || !iso(parsed.updatedAt) || !Array.isArray(parsed.plans) || parsed.plans.length > MAX_PLANS || !parsed.plans.every(validPlan)) return failure('plan_store_corrupt', 'Capability plan store is invalid.')
    return { version: WORKBENCH_CAPABILITY_PLAN_VERSION, updatedAt: parsed.updatedAt, plans: [...parsed.plans].sort((a, b) => a.planId.localeCompare(b.planId)) }
  } catch { return failure('plan_store_corrupt', 'Capability plan store could not be read safely.') }
}
function persistStore(store: CapabilityPlanStore, options: CapabilityPlanStoreOptions, at: string): void {
  const file = getCapabilityPlanStorePath(options)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const plans = [...store.plans].sort((a, b) => a.planId.localeCompare(b.planId)).slice(-Math.min(MAX_PLANS, Math.max(1, options.maxPlans ?? MAX_PLANS)))
  const temp = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  fs.writeFileSync(temp, JSON.stringify({ version: WORKBENCH_CAPABILITY_PLAN_VERSION, updatedAt: at, plans }), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  fs.renameSync(temp, file); fs.chmodSync(file, 0o600)
}
function withLock<T>(options: CapabilityPlanStoreOptions, callback: (store: CapabilityPlanStore, at: string) => CapabilityPlanResult<T>): CapabilityPlanResult<T> {
  const lock = lockPath(options); let fd: number | undefined
  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 }); const deadline = Date.now() + LOCK_WAIT_MS
    while (Date.now() <= deadline) { try { fd = fs.openSync(lock, 'wx', 0o600); break } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { force: true }) } catch {} } }
    if (fd === undefined) return failure('plan_store_busy', 'Capability plan store is busy.')
    const store = readStore(options); if ('ok' in store) return store
    const at = new Date().toISOString(); const result = callback(store, at); if (result.ok) persistStore(store, options, at); return result
  } catch { return failure('plan_store_corrupt', 'Capability plan persistence failed safely.') } finally { if (fd !== undefined) { try { fs.closeSync(fd) } catch {} ; try { fs.rmSync(lock, { force: true }) } catch {} } }
}

export function createAndPersistCapabilityPlan(input: CapabilityPlanInput, options: CapabilityPlanStoreOptions): CapabilityPlanResult<CapabilityPlan> {
  const plan = createCapabilityPlan(input); if (!plan.ok) return plan
  const result = withLock(options, store => { store.plans.push(plan.value); return { ok: true, value: plan.value } })
  if (result.ok) recordCapabilityAuditEvent({ eventType: 'capability.planned', planId: plan.value.planId, providerId: plan.value.providerId, capabilityId: plan.value.capabilityId, occurredAt: input.now }, options)
  return result
}

const TRANSITIONS: Record<CapabilityPlanApprovalState, readonly CapabilityPlanApprovalState[]> = {
  proposed: ['reviewed', 'rejected', 'cancelled'], reviewed: ['approved', 'rejected', 'cancelled'], approved: ['expired', 'cancelled'], rejected: [], expired: [], cancelled: []
}

export function transitionCapabilityPlan(planId: string, next: CapabilityPlanApprovalState, options: CapabilityPlanStoreOptions): CapabilityPlanResult<CapabilityPlan> {
  return withLock(options, store => {
    const plan = store.plans.find(item => item.planId === planId)
    if (!plan) return failure('plan_not_found', `Capability plan ${planId} was not found.`)
    if (!TRANSITIONS[plan.approvalState].includes(next)) return failure('invalid_transition', `Capability plan cannot transition from ${plan.approvalState} to ${next}.`)
    plan.approvalState = next; return { ok: true, value: plan }
  })
}

export function validateCapabilityPlan(plan: CapabilityPlan, current: { contextSessionId: string; contextStatus: CapabilityPlanInput['context']['status']; sourceIds: string[]; provider?: ProviderInventoryRecord; grant?: CapabilityGrantSnapshot; now: string }): { valid: true; plan: CapabilityPlan } | { valid: false; reason: NonNullable<CapabilityPlan['invalidationReason']> } {
  let reason: NonNullable<CapabilityPlan['invalidationReason']> | undefined
  if (plan.contextSessionId !== current.contextSessionId || current.contextStatus === 'expired' || current.contextStatus === 'cleared' || canonical(plan.sourceIds) !== canonical([...current.sourceIds].sort())) reason = current.contextStatus === 'expired' || current.contextStatus === 'cleared' ? 'context_expired' : 'provider_changed'
  else if (!current.provider || current.provider.manifestIdentity.digest !== plan.capabilityManifestDigest) reason = 'provider_changed'
  else if (!current.grant || current.grant.state !== 'active' || current.grant.grantId !== plan.grantBinding.grantId || current.grant.grantVersion !== plan.grantBinding.grantVersion || digest(current.grant.permissions) !== plan.grantBinding.permissionDigest || digest(current.grant.budgets) !== plan.grantBinding.budgetDigest) reason = current.grant?.state !== 'active' ? 'grant_expired' : 'permissions_changed'
  else if (Date.parse(current.now) >= Date.parse(plan.expiresAt)) reason = 'plan_expired'
  if (reason) { plan.validity = 'invalidated'; plan.invalidationReason = reason; return { valid: false, reason } }
  return { valid: true, plan }
}

export function revalidateCapabilityPlan(planId: string, current: Parameters<typeof validateCapabilityPlan>[1], options: CapabilityPlanStoreOptions): CapabilityPlanResult<CapabilityPlan> {
  const result = withLock(options, store => {
    const plan = store.plans.find(item => item.planId === planId)
    if (!plan) return failure('plan_not_found', `Capability plan ${planId} was not found.`)
    const validation = validateCapabilityPlan(plan, current)
    return { ok: true, value: plan }
  })
  if (!result.ok) return result
  return result.value.validity === 'invalidated'
    ? failure('invalid_transition', `Capability plan was invalidated: ${result.value.invalidationReason}.`)
    : result
}

export function listCapabilityPlans(options?: CapabilityPlanStoreOptions): CapabilityPlanResult<CapabilityPlan[]> {
  const store = readStore(options); return 'ok' in store ? store : { ok: true, value: store.plans }
}

export function capabilityPlanDiagnostics(options?: CapabilityPlanStoreOptions): CapabilityPlanResult<{ pending: string[]; approved: string[]; rejected: string[]; expired: string[]; invalidated: string[] }> {
  const result = listCapabilityPlans(options); if (!result.ok) return result
  return { ok: true, value: { pending: result.value.filter(item => ['proposed', 'reviewed'].includes(item.approvalState)).map(item => item.planId), approved: result.value.filter(item => item.approvalState === 'approved' && item.validity === 'valid').map(item => item.planId), rejected: result.value.filter(item => item.approvalState === 'rejected').map(item => item.planId), expired: result.value.filter(item => item.approvalState === 'expired' || item.invalidationReason === 'plan_expired').map(item => item.planId), invalidated: result.value.filter(item => item.validity === 'invalidated').map(item => item.planId) } }
}
