import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import type { KnowledgeManifest, KnowledgeProvider, KnowledgeRegistryOptions } from './knowledge-provider.js'
import { listKnowledgeProviders, registerKnowledgeProvider, removeKnowledgeProvider, transitionKnowledgeProvider, updateKnowledgeProviderHealth } from './knowledge-provider.js'
import { FilesystemKnowledgeProvider } from './filesystem-knowledge-provider.js'
import type { ProviderInventoryRecord, ProviderInventoryStoreOptions, ProviderRegistrationState } from './provider-inventory.js'
import { discoverIntoProviderInventory, inspectProviderInventory, listProviderInventory, removeProviderInventory, transitionProviderRegistration } from './provider-inventory.js'
import type { ProviderDiscoveryResult, WorkbenchProviderManifest } from './provider-discovery.js'
import { decideProviderActivation, requestProviderActivation, type ProviderActivationOptions } from './provider-activation.js'

export type ProviderOnboardingOptions = ProviderInventoryStoreOptions & {
  knowledgeRegistry?: KnowledgeRegistryOptions
  authorizedBy: string
  activationApprovedBy?: string
  now?: () => Date
}

export type ProviderIdentity = {
  providerId: string
  manifestDigest: string
  manifestVersion: number
  providerVersion: string
  contractVersion: string
}

export type ProviderOnboardingFailureCode =
  | 'invalid_manifest'
  | 'identity_mismatch'
  | 'provider_missing'
  | 'invalid_transition'
  | 'provider_unavailable'
  | 'activation_required'
  | 'activation_failed'
  | 'registry_failure'

export type ProviderOnboardingFailure = { ok: false; code: ProviderOnboardingFailureCode; message: string }
export type ProviderOnboardingResult<T> = { ok: true; value: T } | ProviderOnboardingFailure

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

function digestManifest(manifest: WorkbenchProviderManifest): string {
  return crypto.createHash('sha256').update(canonicalJson(manifest)).digest('hex')
}

function failure(code: ProviderOnboardingFailureCode, message: string): ProviderOnboardingFailure { return { ok: false, code, message } }

export function verifyProviderIdentity(manifest: WorkbenchProviderManifest, expectedDigest?: string): ProviderOnboardingResult<ProviderIdentity> {
  const digest = digestManifest(manifest)
  if (expectedDigest !== undefined && expectedDigest !== digest) return failure('identity_mismatch', 'Provider manifest identity does not match the expected digest.')
  return { ok: true, value: { providerId: manifest.providerId, manifestDigest: digest, manifestVersion: manifest.manifestVersion, providerVersion: manifest.providerVersion, contractVersion: manifest.compatibility.contractVersion } }
}

export function registerProvider(discovery: ProviderDiscoveryResult, discoverySource: string, options: ProviderOnboardingOptions): ProviderOnboardingResult<ProviderInventoryRecord[]> {
  if (!options.authorizedBy || options.authorizedBy.length > 160) return failure('invalid_manifest', 'Provider registration requires a bounded authorization identity.')
  const result = discoverIntoProviderInventory(discovery, discoverySource, options)
  return result.ok ? result : failure('registry_failure', result.message)
}

export function transitionProvider(providerId: string, next: ProviderRegistrationState, options: ProviderOnboardingOptions): ProviderOnboardingResult<ProviderInventoryRecord> {
  const result = transitionProviderRegistration(providerId, next, options)
  return result.ok ? result : failure(result.code === 'provider_not_found' ? 'provider_missing' : result.code === 'invalid_transition' ? 'invalid_transition' : 'registry_failure', result.message)
}

export function listProviders(options: ProviderOnboardingOptions): ProviderOnboardingResult<ProviderInventoryRecord[]> {
  const result = listProviderInventory(options)
  return result.ok ? result : failure('registry_failure', result.message)
}

export function inspectProvider(providerId: string, options: ProviderOnboardingOptions): ProviderOnboardingResult<ProviderInventoryRecord | undefined> {
  const result = inspectProviderInventory(providerId, options)
  return result.ok ? result : failure(result.code === 'provider_not_found' ? 'provider_missing' : 'registry_failure', result.message)
}

export function removeProvider(providerId: string, options: ProviderOnboardingOptions): ProviderOnboardingResult<boolean> {
  const result = removeProviderInventory(providerId, options)
  if (!result.ok) return failure(result.code === 'provider_not_found' ? 'provider_missing' : 'registry_failure', result.message)
  const knowledge = listKnowledgeProviders({ ...options.knowledgeRegistry, now: options.now ?? options.knowledgeRegistry?.now })
  if (knowledge.ok && knowledge.value.some(item => item.providerId === providerId)) {
    const removed = removeKnowledgeProvider(providerId, { ...options.knowledgeRegistry, now: options.now ?? options.knowledgeRegistry?.now })
    if (!removed.ok) return failure('registry_failure', removed.message)
  }
  return { ok: true, value: true }
}

export async function activateKnowledgeProvider(manifest: KnowledgeManifest, options: ProviderOnboardingOptions): Promise<ProviderOnboardingResult<KnowledgeProvider>> {
  if (!options.authorizedBy || manifest.permissions.length === 0 || !manifest.permissions.includes('read')) return failure('invalid_manifest', 'Knowledge provider activation requires an authorized read permission.')
  const identity = verifyProviderIdentity(manifest as unknown as WorkbenchProviderManifest)
  if (!identity.ok) return identity
  const registryOptions = { ...options.knowledgeRegistry, now: options.now ?? options.knowledgeRegistry?.now }
  const existing = listKnowledgeProviders(registryOptions)
  let registered: KnowledgeProvider | undefined = existing.ok ? existing.value.find(item => item.providerId === manifest.providerId) : undefined
  if (!existing.ok) return failure('registry_failure', existing.message)
  if (!registered) {
    const created = registerKnowledgeProvider(manifest, options.authorizedBy, registryOptions)
    if (!created.ok) return failure('registry_failure', created.message)
    registered = created.value
  }
  const current = registered.lifecycle === 'registered' ? transitionKnowledgeProvider(registered.providerId, 'enabled', registryOptions) : { ok: true as const, value: registered }
  if (!current.ok) return failure('registry_failure', current.message)
  if (current.value.providerType === 'filesystem' && current.value.location.kind === 'local-path') {
    const provider = new FilesystemKnowledgeProvider({ rootPath: current.value.location.value, providerId: current.value.providerId, providerVersion: current.value.providerVersion, now: options.now })
    const health = await provider.connect()
    if (!health.ok || !health.value.available) {
      updateKnowledgeProviderHealth(current.value.providerId, 'unavailable', undefined, registryOptions)
      return failure('provider_unavailable', health.ok ? (health.value.message ?? 'Knowledge provider is unavailable.') : health.message)
    }
    const freshness = await provider.observeFreshness()
    const updated = updateKnowledgeProviderHealth(current.value.providerId, 'healthy', freshness.ok ? freshness.value.revision : undefined, registryOptions)
    if (!updated.ok) return failure('registry_failure', updated.message)
    const activationOptions: ProviderActivationOptions = { rootDir: options.rootDir, knowledgeRootDir: options.knowledgeRegistry?.rootDir ?? options.rootDir, now: options.now }
    const request = requestProviderActivation(current.value.providerId, options.authorizedBy, undefined, activationOptions)
    if (!request.ok) return failure('activation_failed', request.message)
    if (!options.activationApprovedBy) return failure('activation_required', 'Provider is registered and healthy; explicit activation approval is required.')
    const approved = decideProviderActivation(request.value.activationId, true, options.activationApprovedBy, 'approved for bounded knowledge context use', activationOptions)
    return approved.ok ? { ok: true, value: updated.value } : failure('activation_failed', approved.message)
  }
  updateKnowledgeProviderHealth(current.value.providerId, 'unavailable', undefined, registryOptions)
  return failure('provider_unavailable', 'Provider type is not supported by the generic local activation adapter.')
}

export function getProviderRuntimeProjection(options: ProviderOnboardingOptions): ProviderOnboardingResult<{ enabled: string[]; unavailable: string[]; health: Record<string, string> }> {
  const inventory = listProviderInventory(options)
  if (!inventory.ok) return failure('registry_failure', inventory.message)
  const knowledge = listKnowledgeProviders({ ...options.knowledgeRegistry, now: options.now ?? options.knowledgeRegistry?.now })
  if (!knowledge.ok) return failure('registry_failure', knowledge.message)
  const enabled = knowledge.value.filter(item => item.lifecycle === 'enabled').map(item => item.providerId)
  const unavailable = knowledge.value.filter(item => item.health === 'unavailable').map(item => item.providerId)
  const inventoryIds = new Set(inventory.value.filter(item => item.registrationState === 'enabled').map(item => item.providerId))
  return { ok: true, value: { enabled: [...new Set([...enabled, ...inventoryIds])].sort(), unavailable: unavailable.sort(), health: Object.fromEntries(knowledge.value.map(item => [item.providerId, item.health])) } }
}

export async function verifyProviderPath(location: string): Promise<boolean> {
  try { return (await fs.stat(location)).isDirectory() } catch { return false }
}
