import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { WorkbenchMcpRegistrationManifest } from './registration-manifest.js'
import {
  buildProviderInventory,
  type ProviderDiscoveryCandidate,
  type ProviderDiscoveryResult,
  type WorkbenchProviderCategory,
  type WorkbenchProviderHealthMetadata
} from './provider-discovery.js'

export const WORKBENCH_PROVIDER_INVENTORY_VERSION = 1 as const
export const WORKBENCH_PROVIDER_INVENTORY_FILENAME = 'workbench-provider-inventory.json' as const

export type ProviderRegistrationState = 'discovered' | 'reviewed' | 'registered' | 'enabled' | 'disabled'
export type ProviderInventoryFailureCode =
  | 'inventory_busy'
  | 'inventory_corrupt'
  | 'provider_not_found'
  | 'invalid_transition'
  | 'duplicate_provider'
  | 'inventory_limit'

export type ProviderInventoryRecord = {
  providerId: string
  providerType: WorkbenchProviderCategory
  manifestIdentity: {
    manifestVersion: number
    digest: string
    providerVersion: string
    contractVersion: string
  }
  location: { kind: 'local-path' | 'url' | 'opaque-reference'; value: string }
  enabled: boolean
  health: WorkbenchProviderHealthMetadata
  discoverySource: string
  capabilities: string[]
  ownership: { ownerType: 'user' | 'workspace' | 'organization'; ownerId: string }
  lastValidationTime: string
  registrationState: ProviderRegistrationState
  displayName: string
  operationMetadata?: Array<{ operationId: string; description: string; permission: string; inputSchemaVersion: string }>
  mcp?: WorkbenchMcpProviderMetadata
}

export type WorkbenchMcpProviderMetadata = {
  endpointIdentity: string
  transport: 'stdio' | 'sse' | 'streamable-http' | 'unknown'
  authentication: 'required' | 'optional' | 'none' | 'unknown'
  advertisedCapabilities: string[]
}

export type ProviderInventoryStore = {
  version: typeof WORKBENCH_PROVIDER_INVENTORY_VERSION
  updatedAt: string
  providers: ProviderInventoryRecord[]
}

export type ProviderInventoryStoreOptions = {
  rootDir?: string
  maxProviders?: number
  now?: () => Date
}

export type ProviderInventoryFailure = { ok: false; code: ProviderInventoryFailureCode; message: string }
export type ProviderInventoryResult<T> = { ok: true; value: T } | ProviderInventoryFailure

const MAX_PROVIDERS = 500
const LOCK_WAIT_MS = 250
const LOCK_STALE_MS = 30_000
const PROVIDER_ID = /^[a-z][a-z0-9._-]{0,159}$/
const SHA256 = /^[a-f0-9]{64}$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const STATES: readonly ProviderRegistrationState[] = ['discovered', 'reviewed', 'registered', 'enabled', 'disabled']

function root(options?: ProviderInventoryStoreOptions): string {
  return path.resolve(options?.rootDir ?? path.join(process.cwd(), '.workbench-provider-state'))
}

export function getProviderInventoryStorePath(options?: ProviderInventoryStoreOptions): string {
  return path.join(root(options), WORKBENCH_PROVIDER_INVENTORY_FILENAME)
}

function lockPath(options?: ProviderInventoryStoreOptions): string { return `${getProviderInventoryStorePath(options)}.lock` }
function now(options?: ProviderInventoryStoreOptions): string { return (options?.now ?? (() => new Date()))().toISOString() }
function failure(code: ProviderInventoryFailureCode, message: string): ProviderInventoryFailure { return { ok: false, code, message } }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function boundedString(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max }
function isTimestamp(value: unknown): value is string { return typeof value === 'string' && ISO_DATE.test(value) && Number.isFinite(Date.parse(value)) }

function isInventoryRecord(value: unknown): value is ProviderInventoryRecord {
  if (!isRecord(value) || !PROVIDER_ID.test(String(value.providerId ?? '')) || !['workspace', 'knowledge', 'capability'].includes(String(value.providerType))) return false
  const identity = value.manifestIdentity
  const location = value.location
  const owner = value.ownership
  return isRecord(identity) && identity.manifestVersion === 1 && SHA256.test(String(identity.digest ?? '')) && boundedString(identity.providerVersion, 64) && boundedString(identity.contractVersion, 32)
    && isRecord(location) && ['local-path', 'url', 'opaque-reference'].includes(String(location.kind)) && boundedString(location.value, 2048)
    && typeof value.enabled === 'boolean'
    && ['unknown', 'healthy', 'stale', 'degraded', 'unreachable'].includes(String(value.health))
    && boundedString(value.discoverySource, 2048)
    && Array.isArray(value.capabilities) && value.capabilities.length <= 128 && value.capabilities.every(item => boundedString(item, 160))
    && isRecord(owner) && ['user', 'workspace', 'organization'].includes(String(owner.ownerType)) && boundedString(owner.ownerId, 160)
    && isTimestamp(value.lastValidationTime) && STATES.includes(value.registrationState as ProviderRegistrationState)
    && boundedString(value.displayName, 256)
}

function emptyStore(): ProviderInventoryStore { return { version: WORKBENCH_PROVIDER_INVENTORY_VERSION, updatedAt: new Date(0).toISOString(), providers: [] } }

function readStore(options?: ProviderInventoryStoreOptions): ProviderInventoryStore | ProviderInventoryFailure {
  try {
    const target = getProviderInventoryStorePath(options)
    if (!fs.existsSync(target)) return emptyStore()
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as Partial<ProviderInventoryStore>
    if (parsed.version !== WORKBENCH_PROVIDER_INVENTORY_VERSION || !isTimestamp(parsed.updatedAt) || !Array.isArray(parsed.providers) || parsed.providers.length > MAX_PROVIDERS || !parsed.providers.every(isInventoryRecord)) return failure('inventory_corrupt', 'Provider inventory has an unsupported or invalid shape.')
    const providers = [...parsed.providers].sort((a, b) => a.providerId.localeCompare(b.providerId))
    if (new Set(providers.map(item => item.providerId)).size !== providers.length) return failure('inventory_corrupt', 'Provider inventory contains duplicate provider IDs.')
    return { version: WORKBENCH_PROVIDER_INVENTORY_VERSION, updatedAt: parsed.updatedAt, providers }
  } catch { return failure('inventory_corrupt', 'Provider inventory could not be read safely.') }
}

function persistStore(store: ProviderInventoryStore, options?: ProviderInventoryStoreOptions, timestamp = now(options)): void {
  const target = getProviderInventoryStorePath(options)
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  const providers = [...store.providers].sort((a, b) => a.providerId.localeCompare(b.providerId))
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  fs.writeFileSync(temporary, JSON.stringify({ version: WORKBENCH_PROVIDER_INVENTORY_VERSION, updatedAt: timestamp, providers }), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  fs.renameSync(temporary, target)
  fs.chmodSync(target, 0o600)
}

function acquireLock(options?: ProviderInventoryStoreOptions): number | undefined {
  const target = lockPath(options)
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + LOCK_WAIT_MS
  while (Date.now() <= deadline) {
    try { return fs.openSync(target, 'wx', 0o600) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try { if (Date.now() - fs.statSync(target).mtimeMs > LOCK_STALE_MS) fs.rmSync(target, { force: true }) } catch {}
    }
  }
  return undefined
}

function withLock<T>(options: ProviderInventoryStoreOptions | undefined, callback: (store: ProviderInventoryStore, timestamp: string) => ProviderInventoryResult<T>): ProviderInventoryResult<T> {
  let descriptor: number | undefined
  try {
    descriptor = acquireLock(options)
    if (descriptor === undefined) return failure('inventory_busy', 'Provider inventory is busy.')
    const store = readStore(options)
    if ('ok' in store) return store
    const timestamp = now(options)
    const result = callback(store, timestamp)
    if (result.ok) persistStore(store, options, timestamp)
    return result
  } catch { return failure('inventory_corrupt', 'Provider inventory operation failed safely.') } finally {
    if (descriptor !== undefined) { try { fs.closeSync(descriptor) } catch {} ; try { fs.rmSync(lockPath(options), { force: true }) } catch {} }
  }
}

function toRecord(candidate: ProviderDiscoveryCandidate, source: string, timestamp: string): ProviderInventoryRecord {
  return {
    providerId: candidate.providerId,
    providerType: candidate.manifest.providerType,
    manifestIdentity: { manifestVersion: candidate.manifest.manifestVersion, digest: candidate.manifestDigest, providerVersion: candidate.manifest.providerVersion, contractVersion: candidate.manifest.compatibility.contractVersion },
    location: candidate.manifest.location,
    enabled: false,
    health: candidate.manifest.health.state,
    discoverySource: source,
    capabilities: [...candidate.manifest.capabilities].sort(),
    ownership: candidate.manifest.ownership,
    lastValidationTime: timestamp,
    registrationState: 'discovered',
    displayName: candidate.manifest.displayName,
    ...((candidate.manifest as unknown as { operations?: Array<{ operationId: string; description: string; permission: string; inputSchemaVersion: string }> }).operations ? { operationMetadata: (candidate.manifest as unknown as { operations: Array<{ operationId: string; description: string; permission: string; inputSchemaVersion: string }> }).operations.slice(0, 128) } : {})
  }
}

export function discoverIntoProviderInventory(discovery: ProviderDiscoveryResult, discoverySource: string, options?: ProviderInventoryStoreOptions): ProviderInventoryResult<ProviderInventoryRecord[]> {
  return withLock(options, (store, timestamp) => {
    const inventory = buildProviderInventory(discovery, timestamp)
    const existing = new Map(store.providers.map(item => [item.providerId, item]))
    const duplicateIds = new Set(inventory.duplicateProviderIds)
    for (const candidate of inventory.providers) {
      if (duplicateIds.has(candidate.providerId)) continue
      const current = existing.get(candidate.providerId)
      if (current && current.manifestIdentity.digest !== candidate.manifestDigest && ['registered', 'enabled'].includes(current.registrationState)) continue
      existing.set(candidate.providerId, { ...(current ?? toRecord(candidate, discoverySource, timestamp)), ...toRecord(candidate, discoverySource, timestamp), registrationState: current?.registrationState ?? 'discovered', enabled: current?.enabled ?? false })
    }
    const max = Math.max(1, Math.min(options?.maxProviders ?? MAX_PROVIDERS, MAX_PROVIDERS))
    if (existing.size > max) return failure('inventory_limit', `Provider inventory exceeds the configured limit of ${max}.`)
    store.providers = [...existing.values()].sort((a, b) => a.providerId.localeCompare(b.providerId))
    return { ok: true, value: store.providers }
  })
}

export function readProviderInventory(options?: ProviderInventoryStoreOptions): ProviderInventoryResult<ProviderInventoryStore> {
  const store = readStore(options)
  return 'ok' in store ? store : { ok: true, value: store }
}

export function listProviderInventory(options?: ProviderInventoryStoreOptions): ProviderInventoryResult<ProviderInventoryRecord[]> {
  const result = readProviderInventory(options)
  return result.ok ? { ok: true, value: result.value.providers } : result
}

export function inspectProviderInventory(providerId: string, options?: ProviderInventoryStoreOptions): ProviderInventoryResult<ProviderInventoryRecord | undefined> {
  const result = listProviderInventory(options)
  return result.ok ? { ok: true, value: result.value.find(item => item.providerId === providerId) } : result
}

export function removeProviderInventory(providerId: string, options?: ProviderInventoryStoreOptions): ProviderInventoryResult<boolean> {
  return withLock(options, (store) => {
    const before = store.providers.length
    store.providers = store.providers.filter(item => item.providerId !== providerId)
    return before === store.providers.length ? failure('provider_not_found', `Provider ${providerId} was not found.`) : { ok: true, value: true }
  })
}

const TRANSITIONS: Record<ProviderRegistrationState, readonly ProviderRegistrationState[]> = {
  discovered: ['reviewed'],
  reviewed: ['registered'],
  registered: ['enabled', 'disabled'],
  enabled: ['disabled'],
  disabled: ['enabled']
}

export function transitionProviderRegistration(providerId: string, next: ProviderRegistrationState, options?: ProviderInventoryStoreOptions): ProviderInventoryResult<ProviderInventoryRecord> {
  return withLock(options, (store, timestamp) => {
    const provider = store.providers.find(item => item.providerId === providerId)
    if (!provider) return failure('provider_not_found', `Provider ${providerId} was not found.`)
    if (!TRANSITIONS[provider.registrationState].includes(next)) return failure('invalid_transition', `Provider ${providerId} cannot transition from ${provider.registrationState} to ${next}.`)
    provider.registrationState = next
    provider.enabled = next === 'enabled'
    provider.lastValidationTime = timestamp
    return { ok: true, value: provider }
  })
}

export function describeMcpProvider(manifest: WorkbenchMcpRegistrationManifest): WorkbenchMcpProviderMetadata {
  const transport = manifest.server.transport
  const authentication = manifest.server.credentialReferences.length > 0 ? 'required' : 'none'
  return {
    endpointIdentity: `mcp:${manifest.server.id}:${manifest.registrationId}:${manifest.target.client.id}:${manifest.target.project.root}`,
    transport: transport === 'stdio' ? 'stdio' : 'unknown',
    authentication,
    advertisedCapabilities: [...new Set([...manifest.admission.tools, ...manifest.admission.commandKinds])].sort()
  }
}

export function projectProviderContext(options?: ProviderInventoryStoreOptions): { availableProviderIds: string[]; capabilities: string[]; trustedProviderIds: string[] } | ProviderInventoryFailure {
  const result = listProviderInventory(options)
  if (!result.ok) return result
  const available = result.value.filter(item => item.health !== 'unreachable' && item.registrationState !== 'disabled')
  return {
    availableProviderIds: available.map(item => item.providerId),
    capabilities: [...new Set(available.flatMap(item => item.capabilities))].sort(),
    trustedProviderIds: result.value.filter(item => ['registered', 'enabled'].includes(item.registrationState)).map(item => item.providerId)
  }
}
