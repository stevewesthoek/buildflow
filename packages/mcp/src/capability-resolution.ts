import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { ProviderInventoryRecord, ProviderInventoryStoreOptions } from './provider-inventory.js'
import { listProviderInventory } from './provider-inventory.js'
import type { WorkbenchProviderCategory } from './provider-discovery.js'

export const WORKBENCH_CAPABILITY_RESOLUTION_VERSION = 1 as const
export const WORKBENCH_CAPABILITY_RESOLUTION_FILENAME = 'workbench-capability-decisions.json' as const

export type CapabilityPermission = 'read' | 'write' | 'command' | 'git' | 'network' | 'capability'
export type CapabilityMatch = {
  capabilityId: string
  displayName?: string
  description?: string
  providerType?: WorkbenchProviderCategory
  requiredPermissions?: CapabilityPermission[]
  supportedContext?: string[]
}

export type CapabilityResolutionContext = {
  sessionId: string
  status: 'proposed' | 'confirmed' | 'expired' | 'cleared'
  sourceIds: string[]
  allowedProviderIds?: string[]
  allowedPermissions?: CapabilityPermission[]
  contextTags?: string[]
}

export type CapabilityTaskIntent = {
  query: string
  requestedCapabilities?: string[]
  providerTypes?: WorkbenchProviderCategory[]
  requiredPermissions?: CapabilityPermission[]
  contextTags?: string[]
}

export type CapabilityRejectionReason =
  | 'provider_not_registered'
  | 'provider_disabled'
  | 'provider_unhealthy'
  | 'capability_unavailable'
  | 'context_not_allowed'
  | 'permissions_incompatible'
  | 'context_not_confirmed'

export type CapabilityCandidate = {
  providerId: string
  capabilityId: string
  score: number
  eligible: boolean
  matchReasons: string[]
  rejectionReasons: CapabilityRejectionReason[]
}

export type CapabilityResolution = {
  resolutionId: string
  sessionId: string
  requested: CapabilityTaskIntent
  candidates: CapabilityCandidate[]
  availableCapabilities: string[]
  unavailableCapabilities: string[]
  providerHealthImpact: Array<{ providerId: string; health: ProviderInventoryRecord['health']; impact: 'available' | 'unavailable' }>
  resolvedAt: string
}

export type CapabilityDecisionRecord = CapabilityResolution
export type CapabilityDecisionStore = { version: typeof WORKBENCH_CAPABILITY_RESOLUTION_VERSION; updatedAt: string; decisions: CapabilityDecisionRecord[] }
export type CapabilityResolutionOptions = ProviderInventoryStoreOptions & { maxDecisions?: number; now?: () => Date }
export type CapabilityResolutionFailure = { ok: false; code: 'inventory_unavailable' | 'decision_store_corrupt' | 'decision_store_busy'; message: string }
export type CapabilityResolutionResult<T> = { ok: true; value: T } | CapabilityResolutionFailure

const MAX_DECISIONS = 300
const MAX_CANDIDATES = 500
const LOCK_WAIT_MS = 250
const LOCK_STALE_MS = 30_000
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const PERMISSIONS: readonly CapabilityPermission[] = ['read', 'write', 'command', 'git', 'network', 'capability']

function decisionRoot(options?: CapabilityResolutionOptions): string { return path.resolve(options?.rootDir ?? path.join(process.cwd(), '.workbench-provider-state')) }
export function getCapabilityDecisionStorePath(options?: CapabilityResolutionOptions): string { return path.join(decisionRoot(options), WORKBENCH_CAPABILITY_RESOLUTION_FILENAME) }
function lockPath(options?: CapabilityResolutionOptions): string { return `${getCapabilityDecisionStorePath(options)}.lock` }
function timestamp(options?: CapabilityResolutionOptions): string { return (options?.now ?? (() => new Date()))().toISOString() }
function failure(code: CapabilityResolutionFailure['code'], message: string): CapabilityResolutionFailure { return { ok: false, code, message } }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function isIso(value: unknown): value is string { return typeof value === 'string' && ISO_DATE.test(value) && Number.isFinite(Date.parse(value)) }
function bounded(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max }
function validPermissions(value: unknown): value is CapabilityPermission[] { return Array.isArray(value) && value.length <= PERMISSIONS.length && value.every(item => PERMISSIONS.includes(item as CapabilityPermission)) }

function normalize(value: string): string[] { return value.toLocaleLowerCase().split(/[^a-z0-9]+/).filter(Boolean) }
function overlap(left: string[], right: string[]): number { const r = new Set(right); return left.filter(item => r.has(item)).length }
function sortedUnique(values: string[]): string[] { return [...new Set(values)].sort() }

function permissionCheck(required: CapabilityPermission[], allowed: CapabilityPermission[] | undefined): boolean {
  return required.every(permission => allowed?.includes(permission) ?? permission === 'read')
}

function scoreCapability(intent: CapabilityTaskIntent, capability: CapabilityMatch, provider: ProviderInventoryRecord): { score: number; reasons: string[] } {
  const queryTokens = normalize(`${intent.query} ${(intent.requestedCapabilities ?? []).join(' ')}`)
  const idTokens = normalize(capability.capabilityId)
  const textTokens = normalize(`${capability.displayName ?? ''} ${capability.description ?? ''}`)
  const exact = (intent.requestedCapabilities ?? []).some(item => item.toLocaleLowerCase() === capability.capabilityId.toLocaleLowerCase())
  const nameOverlap = overlap(queryTokens, idTokens)
  const textOverlap = overlap(queryTokens, textTokens)
  const typeMatch = intent.providerTypes?.includes(provider.providerType) ?? false
  const contextMatch = capability.supportedContext?.some(tag => intent.contextTags?.includes(tag)) ?? false
  const reasons: string[] = []
  let score = 0
  if (exact) { score += 60; reasons.push('exact_capability_match') }
  if (nameOverlap > 0) { score += Math.min(24, nameOverlap * 12); reasons.push('capability_name_overlap') }
  if (textOverlap > 0) { score += Math.min(16, textOverlap * 4); reasons.push('description_overlap') }
  if (typeMatch) { score += 12; reasons.push('provider_type_match') }
  if (contextMatch) { score += 12; reasons.push('supported_context_match') }
  if (provider.health === 'healthy') { score += 8; reasons.push('healthy_provider') }
  return { score: Math.min(100, score), reasons }
}

function eligible(context: CapabilityResolutionContext, intent: CapabilityTaskIntent, provider: ProviderInventoryRecord, capability: CapabilityMatch): { eligible: boolean; reasons: CapabilityRejectionReason[] } {
  const reasons: CapabilityRejectionReason[] = []
  if (!['registered', 'enabled'].includes(provider.registrationState)) reasons.push('provider_not_registered')
  if (provider.registrationState === 'disabled' || !provider.enabled) reasons.push('provider_disabled')
  if (!['healthy'].includes(provider.health)) reasons.push('provider_unhealthy')
  if (!provider.capabilities.includes(capability.capabilityId)) reasons.push('capability_unavailable')
  if (context.allowedProviderIds && !context.allowedProviderIds.includes(provider.providerId)) reasons.push('context_not_allowed')
  const required = sortedUnique([...(intent.requiredPermissions ?? []), ...(capability.requiredPermissions ?? [])]) as CapabilityPermission[]
  if (!permissionCheck(required, context.allowedPermissions)) reasons.push('permissions_incompatible')
  if (context.status !== 'confirmed' && context.status !== 'proposed') reasons.push('context_not_confirmed')
  return { eligible: reasons.length === 0, reasons }
}

function inventoryCapabilities(provider: ProviderInventoryRecord, catalog: readonly CapabilityMatch[]): CapabilityMatch[] {
  const entries = catalog.filter(item => item.providerType === undefined || item.providerType === provider.providerType)
  return provider.capabilities.map(capabilityId => entries.find(item => item.capabilityId === capabilityId) ?? { capabilityId, providerType: provider.providerType })
}

export function resolveCapabilities(input: { context: CapabilityResolutionContext; intent: CapabilityTaskIntent; providers: readonly ProviderInventoryRecord[]; catalog?: readonly CapabilityMatch[]; now?: string }): CapabilityResolution {
  const resolvedAt = input.now ?? new Date().toISOString()
  const catalog = input.catalog ?? []
  const candidates: CapabilityCandidate[] = []
  for (const provider of input.providers) {
    for (const capability of inventoryCapabilities(provider, catalog)) {
      const match = scoreCapability(input.intent, capability, provider)
      const access = eligible(input.context, input.intent, provider, capability)
      candidates.push({ providerId: provider.providerId, capabilityId: capability.capabilityId, score: match.score, eligible: access.eligible, matchReasons: match.reasons, rejectionReasons: access.reasons })
    }
  }
  candidates.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score || a.providerId.localeCompare(b.providerId) || a.capabilityId.localeCompare(b.capabilityId))
  const boundedCandidates = candidates.slice(0, MAX_CANDIDATES)
  const availableCapabilities = sortedUnique(boundedCandidates.filter(item => item.eligible).map(item => item.capabilityId))
  const unavailableCapabilities = sortedUnique(boundedCandidates.filter(item => !item.eligible).map(item => item.capabilityId))
  const providerHealthImpact = input.providers.map(provider => ({ providerId: provider.providerId, health: provider.health, impact: provider.health === 'healthy' ? 'available' as const : 'unavailable' as const })).sort((a, b) => a.providerId.localeCompare(b.providerId))
  return { resolutionId: `capability-resolution-${crypto.randomUUID()}`, sessionId: input.context.sessionId, requested: input.intent, candidates: boundedCandidates, availableCapabilities, unavailableCapabilities, providerHealthImpact, resolvedAt }
}

function validCandidate(value: unknown): value is CapabilityCandidate {
  if (!isRecord(value)) return false
  return bounded(value.providerId, 160) && bounded(value.capabilityId, 160) && typeof value.score === 'number' && value.score >= 0 && value.score <= 100 && typeof value.eligible === 'boolean' && Array.isArray(value.matchReasons) && value.matchReasons.every(item => bounded(item, 100)) && Array.isArray(value.rejectionReasons)
}

function validDecision(value: unknown): value is CapabilityDecisionRecord {
  if (!isRecord(value)) return false
  return bounded(value.resolutionId, 200) && bounded(value.sessionId, 200) && isRecord(value.requested) && bounded(value.requested.query, 2_000) && Array.isArray(value.candidates) && value.candidates.length <= MAX_CANDIDATES && value.candidates.every(validCandidate) && Array.isArray(value.availableCapabilities) && Array.isArray(value.unavailableCapabilities) && Array.isArray(value.providerHealthImpact) && isIso(value.resolvedAt)
}

function readDecisions(options?: CapabilityResolutionOptions): CapabilityDecisionStore | CapabilityResolutionFailure {
  try {
    const file = getCapabilityDecisionStorePath(options)
    if (!fs.existsSync(file)) return { version: WORKBENCH_CAPABILITY_RESOLUTION_VERSION, updatedAt: new Date(0).toISOString(), decisions: [] }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<CapabilityDecisionStore>
    if (parsed.version !== WORKBENCH_CAPABILITY_RESOLUTION_VERSION || !isIso(parsed.updatedAt) || !Array.isArray(parsed.decisions) || parsed.decisions.length > MAX_DECISIONS || !parsed.decisions.every(validDecision)) return failure('decision_store_corrupt', 'Capability decision store is invalid.')
    return { version: WORKBENCH_CAPABILITY_RESOLUTION_VERSION, updatedAt: parsed.updatedAt, decisions: parsed.decisions }
  } catch { return failure('decision_store_corrupt', 'Capability decision store could not be read safely.') }
}

function persistDecisions(store: CapabilityDecisionStore, options: CapabilityResolutionOptions, at: string): void {
  const file = getCapabilityDecisionStorePath(options)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const decisions = [...store.decisions].sort((a, b) => a.resolvedAt.localeCompare(b.resolvedAt)).slice(-Math.min(MAX_DECISIONS, Math.max(1, options.maxDecisions ?? MAX_DECISIONS)))
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  fs.writeFileSync(temporary, JSON.stringify({ version: WORKBENCH_CAPABILITY_RESOLUTION_VERSION, updatedAt: at, decisions }), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  fs.renameSync(temporary, file)
  fs.chmodSync(file, 0o600)
}

function withDecisionLock<T>(options: CapabilityResolutionOptions, callback: (store: CapabilityDecisionStore, at: string) => T): CapabilityResolutionResult<T> {
  const lock = lockPath(options)
  let fd: number | undefined
  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 })
    const deadline = Date.now() + LOCK_WAIT_MS
    while (Date.now() <= deadline) {
      try { fd = fs.openSync(lock, 'wx', 0o600); break } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { force: true }) } catch {}
      }
    }
    if (fd === undefined) return failure('decision_store_busy', 'Capability decision store is busy.')
    const store = readDecisions(options)
    if ('ok' in store) return store
    const at = timestamp(options)
    const value = callback(store, at)
    persistDecisions(store, options, at)
    return { ok: true, value }
  } catch { return failure('decision_store_corrupt', 'Capability decision persistence failed safely.') } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch {} ; try { fs.rmSync(lock, { force: true }) } catch {} }
  }
}

export function resolveAndRecordCapabilities(input: { context: CapabilityResolutionContext; intent: CapabilityTaskIntent; catalog?: readonly CapabilityMatch[]; options?: CapabilityResolutionOptions }): CapabilityResolutionResult<CapabilityResolution> {
  const inventory = listProviderInventory(input.options)
  if (!inventory.ok) return failure('inventory_unavailable', inventory.message)
  const resolution = resolveCapabilities({ context: input.context, intent: input.intent, providers: inventory.value, catalog: input.catalog, now: timestamp(input.options) })
  return withDecisionLock(input.options ?? {}, store => { store.decisions.push(resolution); return resolution })
}

export function listCapabilityDecisions(options?: CapabilityResolutionOptions): CapabilityResolutionResult<CapabilityDecisionRecord[]> {
  const store = readDecisions(options)
  return 'ok' in store ? store : { ok: true, value: store.decisions }
}
