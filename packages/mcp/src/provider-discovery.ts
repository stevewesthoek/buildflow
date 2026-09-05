import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { WORKBENCH_PROVIDER_CONTRACT_VERSION } from './provider-lifecycle.js'

export const WORKBENCH_PROVIDER_MANIFEST_KIND = 'workbench.provider.manifest' as const
export const WORKBENCH_PROVIDER_MANIFEST_VERSION = 1 as const
export const WORKBENCH_PROVIDER_CATEGORIES = ['workspace', 'knowledge', 'capability'] as const
export const WORKBENCH_PROVIDER_HEALTH_METADATA = ['unknown', 'healthy', 'stale', 'degraded', 'unreachable'] as const

export type WorkbenchProviderCategory = typeof WORKBENCH_PROVIDER_CATEGORIES[number]
export type WorkbenchProviderHealthMetadata = typeof WORKBENCH_PROVIDER_HEALTH_METADATA[number]

export type WorkbenchProviderManifest = {
  kind: typeof WORKBENCH_PROVIDER_MANIFEST_KIND
  manifestVersion: typeof WORKBENCH_PROVIDER_MANIFEST_VERSION
  providerId: string
  providerType: WorkbenchProviderCategory
  displayName: string
  providerVersion: string
  location: {
    kind: 'local-path' | 'url' | 'opaque-reference'
    value: string
  }
  ownership: {
    ownerType: 'user' | 'workspace' | 'organization'
    ownerId: string
  }
  capabilities: string[]
  health: {
    state: WorkbenchProviderHealthMetadata
    observedAt: string
    revision?: string
  }
  compatibility: {
    contractVersion: string
    workbenchMinVersion?: string
    workbenchMaxVersion?: string
  }
}

export type ProviderDiscoveryLocation = {
  path: string
  label?: string
}

export type ProviderDiscoveryOptions = {
  maxLocations?: number
  maxManifestBytes?: number
  manifestNames?: ReadonlySet<string>
  now?: () => string
}

export type ProviderDiscoveryFailureCode =
  | 'location_unavailable'
  | 'manifest_not_found'
  | 'manifest_unreadable'
  | 'manifest_unavailable'
  | 'manifest_too_large'
  | 'manifest_invalid_json'
  | 'manifest_invalid'
  | 'duplicate_provider'

export type ProviderDiscoveryCandidate = {
  providerId: string
  manifest: WorkbenchProviderManifest
  manifestPath: string
  manifestDigest: string
  discoveredAt: string
  warnings: string[]
}

export type ProviderDiscoveryFailure = {
  code: ProviderDiscoveryFailureCode
  location: string
  manifestPath?: string
  reason: string
}

export type ProviderDiscoveryResult = {
  candidates: ProviderDiscoveryCandidate[]
  failures: ProviderDiscoveryFailure[]
}

export type ProviderInventoryEntry = ProviderDiscoveryCandidate & {
  availability: 'available' | 'unavailable' | 'duplicate'
  health: WorkbenchProviderHealthMetadata
}

export type ProviderInventory = {
  providers: ProviderInventoryEntry[]
  failures: ProviderDiscoveryFailure[]
  duplicateProviderIds: string[]
  observedAt: string
}

const DEFAULT_MANIFEST_NAMES = new Set(['workbench.provider.json', 'provider.manifest.json'])
const DEFAULT_MAX_LOCATIONS = 32
const DEFAULT_MAX_MANIFEST_BYTES = 256 * 1024
const PROVIDER_ID = /^[a-z][a-z0-9._-]{0,159}$/
const BOUNDED_STRING = (max: number) => (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= max

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}

function isStringArray(value: unknown, maxItems: number): value is string[] {
  return Array.isArray(value) && value.length <= maxItems && value.every(item => BOUNDED_STRING(160)(item))
}

function isManifest(value: unknown): value is WorkbenchProviderManifest {
  if (!isRecord(value)) return false
  const location = value.location
  const ownership = value.ownership
  const health = value.health
  const compatibility = value.compatibility
  return value.kind === WORKBENCH_PROVIDER_MANIFEST_KIND
    && value.manifestVersion === WORKBENCH_PROVIDER_MANIFEST_VERSION
    && typeof value.providerId === 'string' && PROVIDER_ID.test(value.providerId)
    && WORKBENCH_PROVIDER_CATEGORIES.includes(value.providerType as WorkbenchProviderCategory)
    && BOUNDED_STRING(256)(value.displayName)
    && BOUNDED_STRING(64)(value.providerVersion)
    && isRecord(location)
    && ['local-path', 'url', 'opaque-reference'].includes(location.kind as string)
    && BOUNDED_STRING(2048)(location.value)
    && isRecord(ownership)
    && ['user', 'workspace', 'organization'].includes(ownership.ownerType as string)
    && BOUNDED_STRING(160)(ownership.ownerId)
    && isStringArray(value.capabilities, 128)
    && isRecord(health)
    && WORKBENCH_PROVIDER_HEALTH_METADATA.includes(health.state as WorkbenchProviderHealthMetadata)
    && isIsoTimestamp(health.observedAt)
    && (health.revision === undefined || BOUNDED_STRING(256)(health.revision))
    && isRecord(compatibility)
    && BOUNDED_STRING(32)(compatibility.contractVersion)
    && (compatibility.workbenchMinVersion === undefined || BOUNDED_STRING(32)(compatibility.workbenchMinVersion))
    && (compatibility.workbenchMaxVersion === undefined || BOUNDED_STRING(32)(compatibility.workbenchMaxVersion))
}

function manifestError(value: unknown): string {
  if (!isRecord(value)) return 'manifest must be a JSON object'
  if (value.kind !== WORKBENCH_PROVIDER_MANIFEST_KIND) return 'invalid manifest kind'
  if (value.manifestVersion !== WORKBENCH_PROVIDER_MANIFEST_VERSION) return 'unsupported manifest version'
  if (typeof value.providerId !== 'string' || !PROVIDER_ID.test(value.providerId)) return 'invalid providerId'
  if (!WORKBENCH_PROVIDER_CATEGORIES.includes(value.providerType as WorkbenchProviderCategory)) return 'invalid providerType'
  if (!BOUNDED_STRING(256)(value.displayName)) return 'invalid displayName'
  if (!BOUNDED_STRING(64)(value.providerVersion)) return 'invalid providerVersion'
  if (!isRecord(value.location) || !['local-path', 'url', 'opaque-reference'].includes(value.location.kind as string) || !BOUNDED_STRING(2048)(value.location.value)) return 'invalid location'
  if (!isRecord(value.ownership) || !['user', 'workspace', 'organization'].includes(value.ownership.ownerType as string) || !BOUNDED_STRING(160)(value.ownership.ownerId)) return 'invalid ownership'
  if (!isStringArray(value.capabilities, 128)) return 'invalid capabilities'
  if (!isRecord(value.health) || !WORKBENCH_PROVIDER_HEALTH_METADATA.includes(value.health.state as WorkbenchProviderHealthMetadata) || !isIsoTimestamp(value.health.observedAt)) return 'invalid health metadata'
  if (!isRecord(value.compatibility) || !BOUNDED_STRING(32)(value.compatibility.contractVersion)) return 'invalid compatibility'
  return 'invalid manifest'
}

export function validateProviderManifest(value: unknown): value is WorkbenchProviderManifest {
  return isManifest(value)
}

export function parseProviderManifest(value: unknown): WorkbenchProviderManifest {
  if (!isManifest(value)) throw new Error(manifestError(value))
  return value
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

function digestManifest(value: WorkbenchProviderManifest): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function failure(code: ProviderDiscoveryFailureCode, location: string, reason: string, manifestPath?: string): ProviderDiscoveryFailure {
  return { code, location, ...(manifestPath ? { manifestPath } : {}), reason }
}

function locateManifest(location: ProviderDiscoveryLocation, names: ReadonlySet<string>): { manifestPath?: string; error?: ProviderDiscoveryFailure } {
  const resolved = path.resolve(location.path)
  let stat: fs.Stats
  try {
    stat = fs.statSync(resolved)
  } catch {
    return { error: failure('location_unavailable', location.path, 'configured discovery location is unavailable') }
  }
  if (stat.isFile()) return { manifestPath: resolved }
  if (!stat.isDirectory()) return { error: failure('manifest_not_found', location.path, 'configured location is not a file or directory') }
  for (const name of names) {
    const candidate = path.join(resolved, name)
    try {
      if (fs.statSync(candidate).isFile()) return { manifestPath: candidate }
    } catch {
      // A missing candidate is expected while checking bounded manifest names.
    }
  }
  return { error: failure('manifest_not_found', location.path, 'no supported provider manifest found') }
}

export function discoverProviderManifests(
  locations: readonly ProviderDiscoveryLocation[],
  options: ProviderDiscoveryOptions = {}
): ProviderDiscoveryResult {
  const maxLocations = options.maxLocations ?? DEFAULT_MAX_LOCATIONS
  const maxManifestBytes = options.maxManifestBytes ?? DEFAULT_MAX_MANIFEST_BYTES
  const names = options.manifestNames ?? DEFAULT_MANIFEST_NAMES
  const now = options.now ?? (() => new Date().toISOString())
  const candidates: ProviderDiscoveryCandidate[] = []
  const failures: ProviderDiscoveryFailure[] = []

  for (const location of locations.slice(0, maxLocations)) {
    const located = locateManifest(location, names)
    if (!located.manifestPath) {
      failures.push(located.error ?? failure('manifest_not_found', location.path, 'manifest not found'))
      continue
    }
    const manifestPath = located.manifestPath
    let stat: fs.Stats
    try {
      stat = fs.statSync(manifestPath)
      if (stat.size > maxManifestBytes) {
        failures.push(failure('manifest_too_large', location.path, `manifest exceeds ${maxManifestBytes} bytes`, manifestPath))
        continue
      }
    } catch {
      failures.push(failure('manifest_unavailable', location.path, 'manifest became unavailable during discovery', manifestPath))
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    } catch (error) {
      const code = error instanceof SyntaxError ? 'manifest_invalid_json' : 'manifest_unreadable'
      failures.push(failure(code, location.path, 'manifest could not be read as bounded JSON', manifestPath))
      continue
    }
    if (!isManifest(parsed)) {
      failures.push(failure('manifest_invalid', location.path, manifestError(parsed), manifestPath))
      continue
    }
    candidates.push({
      providerId: parsed.providerId,
      manifest: parsed,
      manifestPath,
      manifestDigest: digestManifest(parsed),
      discoveredAt: now(),
      warnings: parsed.compatibility.contractVersion !== WORKBENCH_PROVIDER_CONTRACT_VERSION
        ? [`provider contract ${parsed.compatibility.contractVersion} is not supported by this Workbench`] : []
    })
  }
  return { candidates, failures }
}

export function buildProviderInventory(
  discovery: ProviderDiscoveryResult,
  now: string = new Date().toISOString()
): ProviderInventory {
  const counts = new Map<string, number>()
  for (const candidate of discovery.candidates) counts.set(candidate.providerId, (counts.get(candidate.providerId) ?? 0) + 1)
  const duplicateProviderIds = [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id).sort()
  const providers = discovery.candidates
    .map(candidate => ({
      ...candidate,
      availability: duplicateProviderIds.includes(candidate.providerId) ? 'duplicate' as const
        : candidate.manifest.health.state === 'unreachable' ? 'unavailable' as const : 'available' as const,
      health: candidate.manifest.health.state
    }))
    .sort((a, b) => a.providerId.localeCompare(b.providerId) || a.manifestPath.localeCompare(b.manifestPath))
  const failures = [...discovery.failures]
  for (const providerId of duplicateProviderIds) {
    failures.push(failure('duplicate_provider', providerId, `providerId ${providerId} was discovered more than once`))
  }
  return { providers, failures, duplicateProviderIds, observedAt: now }
}
