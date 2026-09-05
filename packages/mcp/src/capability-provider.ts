import crypto from 'node:crypto'
import type { WorkbenchProviderManifest } from './provider-discovery.js'
import { discoverIntoProviderInventory, inspectProviderInventory, listProviderInventory, transitionProviderRegistration, type ProviderInventoryRecord, type ProviderInventoryStoreOptions, type ProviderRegistrationState } from './provider-inventory.js'
import { decideProviderActivation, getProviderActivationDiagnostics, requestProviderActivation, type ProviderActivationOptions, type ProviderActivationRecord, type ProviderActivationResult } from './provider-activation.js'

export const CAPABILITY_PROVIDER_MANIFEST_KIND = 'workbench.capability-provider.manifest' as const
export const CAPABILITY_PROVIDER_MANIFEST_VERSION = 1 as const
export const CAPABILITY_DISCOVERY_SOURCES = ['mcp', 'cli', 'skill', 'orchestrator'] as const
export type CapabilityDiscoverySource = typeof CAPABILITY_DISCOVERY_SOURCES[number]
export type CapabilityOperation = { operationId: string; description: string; permission: string; inputSchemaVersion: string }
export type CapabilityProviderManifest = Omit<WorkbenchProviderManifest, 'kind' | 'manifestVersion' | 'providerType' | 'capabilities'> & {
  kind: typeof CAPABILITY_PROVIDER_MANIFEST_KIND
  manifestVersion: typeof CAPABILITY_PROVIDER_MANIFEST_VERSION
  providerType: 'capability'
  capabilities: string[]
  operations: CapabilityOperation[]
}
export type CapabilityDiscoveryInput = { source: CapabilityDiscoverySource; manifest: CapabilityProviderManifest }
export type CapabilityDiscoveryCandidate = { source: CapabilityDiscoverySource; providerId: string; manifest: CapabilityProviderManifest; manifestDigest: string; discoveredAt: string }
export type CapabilityDiscoveryFailure = { source: string; providerId?: string; code: 'invalid_manifest' | 'duplicate_provider'; message: string }
export type CapabilityDiscoveryResult = { candidates: CapabilityDiscoveryCandidate[]; failures: CapabilityDiscoveryFailure[]; observedAt: string }
export type CapabilityProviderOptions = ProviderInventoryStoreOptions & { now?: () => Date; activation?: ProviderActivationOptions }
export type CapabilityProviderResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string }

const ID = /^[a-z][a-z0-9._-]{0,159}$/
const bounded = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
const iso = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function canonical(value: unknown): string { if (value === null || typeof value !== 'object') return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; const object = value as Record<string, unknown>; return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}` }
function digest(manifest: CapabilityProviderManifest): string { return crypto.createHash('sha256').update(canonical(manifest)).digest('hex') }
function validManifest(value: unknown): value is CapabilityProviderManifest {
  if (!record(value) || value.kind !== CAPABILITY_PROVIDER_MANIFEST_KIND || value.manifestVersion !== CAPABILITY_PROVIDER_MANIFEST_VERSION || value.providerType !== 'capability' || !ID.test(String(value.providerId ?? '')) || !bounded(value.displayName, 256) || !bounded(value.providerVersion, 64)) return false
  const location = value.location as Record<string, unknown>; const ownership = value.ownership as Record<string, unknown>; const health = value.health as Record<string, unknown>; const compatibility = value.compatibility as Record<string, unknown>
  const operations = value.operations
  return record(location) && ['local-path', 'url', 'opaque-reference'].includes(String(location.kind)) && bounded(location.value, 2048) && record(ownership) && ['user', 'workspace', 'organization'].includes(String(ownership.ownerType)) && bounded(ownership.ownerId, 160) && Array.isArray(value.capabilities) && value.capabilities.length <= 128 && value.capabilities.every(item => bounded(item, 160)) && record(health) && ['unknown', 'healthy', 'stale', 'degraded', 'unreachable'].includes(String(health.state)) && iso(health.observedAt) && record(compatibility) && bounded(compatibility.contractVersion, 32) && Array.isArray(operations) && operations.length <= 128 && operations.every(item => record(item) && ID.test(String(item.operationId ?? '')) && bounded(item.description, 500) && bounded(item.permission, 160) && bounded(item.inputSchemaVersion, 32))
}
export function validateCapabilityProviderManifest(value: unknown): value is CapabilityProviderManifest { return validManifest(value) }

export function discoverCapabilityProviders(inputs: readonly CapabilityDiscoveryInput[], now = new Date()): CapabilityDiscoveryResult {
  const observedAt = now.toISOString(); const candidates: CapabilityDiscoveryCandidate[] = []; const failures: CapabilityDiscoveryFailure[] = []; const seen = new Set<string>()
  for (const input of inputs.slice(0, 64)) {
    if (!validManifest(input.manifest)) { failures.push({ source: input.source, code: 'invalid_manifest', message: 'Capability manifest failed bounded validation.' }); continue }
    if (seen.has(input.manifest.providerId)) { failures.push({ source: input.source, providerId: input.manifest.providerId, code: 'duplicate_provider', message: 'Capability provider identity was discovered more than once.' }); continue }
    seen.add(input.manifest.providerId); candidates.push({ source: input.source, providerId: input.manifest.providerId, manifest: input.manifest, manifestDigest: digest(input.manifest), discoveredAt: observedAt })
  }
  return { candidates: candidates.sort((a, b) => a.providerId.localeCompare(b.providerId)), failures, observedAt }
}

export function registerCapabilityProvider(candidate: CapabilityDiscoveryCandidate, options: CapabilityProviderOptions): CapabilityProviderResult<ProviderInventoryRecord> {
  const result = discoverIntoProviderInventory({ candidates: [{ providerId: candidate.providerId, manifest: candidate.manifest as unknown as WorkbenchProviderManifest, manifestPath: `capability://${candidate.source}/${candidate.providerId}`, manifestDigest: candidate.manifestDigest, discoveredAt: candidate.discoveredAt, warnings: [] }], failures: [] }, `capability:${candidate.source}`, options)
  if (!result.ok) return result
  const record = result.value.find(item => item.providerId === candidate.providerId)
  return record ? { ok: true, value: record } : { ok: false, code: 'provider_missing', message: 'Capability provider was not persisted.' }
}
export function inspectCapabilityProvider(providerId: string, options?: CapabilityProviderOptions): CapabilityProviderResult<ProviderInventoryRecord | undefined> { const result = inspectProviderInventory(providerId, options); return result.ok && (!result.value || result.value.providerType === 'capability') ? result : { ok: false, code: 'not_capability_provider', message: 'Provider is not a capability provider.' } }
export function listCapabilityProviders(options?: CapabilityProviderOptions): CapabilityProviderResult<ProviderInventoryRecord[]> { const result = listProviderInventory(options); return result.ok ? { ok: true, value: result.value.filter(item => item.providerType === 'capability') } : result }
export function transitionCapabilityProvider(providerId: string, next: ProviderRegistrationState, options?: CapabilityProviderOptions): CapabilityProviderResult<ProviderInventoryRecord> { const inspected = inspectCapabilityProvider(providerId, options); if (!inspected.ok || !inspected.value) return { ok: false, code: inspected.ok ? 'provider_missing' : inspected.code, message: inspected.ok ? 'Capability provider was not found.' : inspected.message }; return transitionProviderRegistration(providerId, next, options) }
export function requestCapabilityProviderActivation(providerId: string, actorId: string, sessionId?: string, options?: CapabilityProviderOptions): ProviderActivationResult<ProviderActivationRecord> { return requestProviderActivation(providerId, actorId, sessionId, options?.activation ?? options) }
export function decideCapabilityProviderActivation(activationId: string, approved: boolean, actorId: string, reason: string, options?: CapabilityProviderOptions): ProviderActivationResult<ProviderActivationRecord> { return decideProviderActivation(activationId, approved, actorId, reason, options?.activation ?? options) }
export function getCapabilityProviderDiagnostics(options?: CapabilityProviderOptions): { providers: ProviderInventoryRecord[]; activeProviderIds: string[]; unavailableProviderIds: string[]; availableCapabilities: string[]; permissionState: Record<string, string[]>; activation: ReturnType<typeof getProviderActivationDiagnostics> } {
  const providers = listCapabilityProviders(options); const values = providers.ok ? providers.value : []; const activation = getProviderActivationDiagnostics(options?.activation ?? options); const active = new Set(activation.activeProviderIds); return { providers: values.slice(0, 64), activeProviderIds: [...active].sort(), unavailableProviderIds: values.filter(item => item.health === 'unreachable' || item.registrationState === 'disabled').map(item => item.providerId).sort(), availableCapabilities: [...new Set(values.filter(item => active.has(item.providerId) && item.health === 'healthy').flatMap(item => item.capabilities))].sort().slice(0, 256), permissionState: Object.fromEntries(values.slice(0, 64).map(item => [item.providerId, active.has(item.providerId) ? ['registered', 'approved'] : [item.registrationState]])), activation }
}
