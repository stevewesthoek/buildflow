import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  capabilityManifestIdentity,
  formatCapabilityManifestInspection,
  formatCliCapabilityManifestInspection,
  inspectCapabilityManifest,
  inspectCliCapabilityManifest,
  validateCapabilityManifest,
  validateCliCapabilityManifest,
  type CapabilityManifest,
  type CapabilityManifestInspection,
  type CliCapabilityManifestInspection,
  type CapabilityManifestValidationIssue
} from '@workbench/shared'
import type { CapabilityJobHandler } from './capability-execution-coordinator.js'
import { validateReadOnlyCliCapabilityManifest } from './capability-read-only-cli.js'
import { validateIsolatedOutputCliCapabilityManifest } from './capability-isolated-output-cli.js'
import { validateWriteCapableCliCapabilityManifest } from './capability-write-capable-cli.js'
import type { ProviderInventoryRecord } from './provider-inventory.js'

export const WORKBENCH_CAPABILITY_REGISTRY_VERSION = 1 as const
export const WORKBENCH_CAPABILITY_REGISTRY_FILENAME = 'workbench-capability-registry.json' as const
export const CAPABILITY_REGISTRY_MAX_ENTRIES = 300
export const CAPABILITY_REGISTRY_MAX_LIST = 64

export type ConfiguredCapabilityBinding = {
  manifest: unknown
  providerId: string
  bindingId: string
  configured: boolean
  handler: CapabilityJobHandler
  executionMode?: 'generic' | 'read-only-cli' | 'isolated-output-cli' | 'write-capable-cli'
}

export type CapabilityRegistryListItem = {
  id: string
  version: string
  name: string
  description: string
  risk: CapabilityManifest['risk']
  configured: true
  available: true
  writes: boolean
  network: 'none' | 'bounded'
  confirmation: 'no' | 'yes' | 'unavailable'
}

export type CapabilityRegistryInspection = (CapabilityManifestInspection | CliCapabilityManifestInspection) & {
  summary: string
  configured: boolean
  available: boolean
  providerId: string
  bindingId: string
  executionMode?: ConfiguredCapabilityBinding['executionMode']
  availabilityReasons: string[]
  contractConsequences: {
    writes: boolean
    network: 'none' | 'bounded'
    confirmation: 'no' | 'yes' | 'unavailable'
    timeout: string
    validation: string
    redaction: string
    outputLimit: string
  }
}

export type CapabilityRegistryFailureCode = 'capability_unknown' | 'capability_invalid' | 'capability_unavailable' | 'registry_corrupt'
export type CapabilityRegistryFailure = { ok: false; code: CapabilityRegistryFailureCode; message: string; issues?: readonly CapabilityManifestValidationIssue[] }
export type CapabilityRegistryResult<T> = { ok: true; value: T } | CapabilityRegistryFailure
export type CapabilityRegistrySnapshotEntry = {
  identity: string
  providerId: string
  bindingId: string
  configured: boolean
  valid: boolean
  available: boolean
  executionMode?: ConfiguredCapabilityBinding['executionMode']
  availabilityReasons: string[]
  manifest?: CapabilityManifest
  invalidIssuePaths?: string[]
}
export type CapabilityRegistrySnapshot = {
  version: typeof WORKBENCH_CAPABILITY_REGISTRY_VERSION
  updatedAt: string
  entries: CapabilityRegistrySnapshotEntry[]
}

type RegistryEntry = {
  binding: ConfiguredCapabilityBinding
  manifest?: CapabilityManifest
  issues: readonly CapabilityManifestValidationIssue[]
  provider?: ProviderInventoryRecord
  reasons: string[]
  identity: string
}

export type CapabilityRegistryOptions = {
  rootDir?: string
  now?: () => Date
  providers: readonly ProviderInventoryRecord[]
  configured: readonly ConfiguredCapabilityBinding[]
  persist?: boolean
}

function registryRoot(options: Pick<CapabilityRegistryOptions, 'rootDir'> = {}): string {
  return path.resolve(options.rootDir ?? path.join(process.cwd(), '.workbench-provider-state'))
}

export function getCapabilityRegistryStorePath(options: Pick<CapabilityRegistryOptions, 'rootDir'> = {}): string {
  return path.join(registryRoot(options), WORKBENCH_CAPABILITY_REGISTRY_FILENAME)
}

function safeString(value: unknown, max = 256): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max }

function providerReasons(provider: ProviderInventoryRecord | undefined, capabilityId: string): string[] {
  if (!provider) return ['provider_not_configured']
  const reasons: string[] = []
  if (!provider.enabled || provider.registrationState !== 'enabled') reasons.push('provider_disabled')
  if (provider.health !== 'healthy') reasons.push(`provider_${provider.health}`)
  if (!provider.capabilities.includes(capabilityId)) reasons.push('capability_not_advertised_by_provider')
  return reasons
}

function hasCliDeclaration(value: unknown): boolean {
  return !!value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'cli')
}

function modeAdmissionReasons(binding: ConfiguredCapabilityBinding): string[] {
  const mode = binding.executionMode as string | undefined
  const known = mode === undefined || mode === 'generic' || mode === 'read-only-cli' || mode === 'isolated-output-cli' || mode === 'write-capable-cli'
  if (!known) return ['execution_mode_invalid']
  if (hasCliDeclaration(binding.manifest) && (mode === undefined || mode === 'generic')) return ['cli_execution_mode_required']
  return []
}

function validateConfiguredManifest(value: unknown): { ok: true; value: CapabilityManifest } | { ok: false; issues: readonly CapabilityManifestValidationIssue[] } {
  const result = hasCliDeclaration(value) ? validateCliCapabilityManifest(value) : validateCapabilityManifest(value)
  return result.ok ? result : { ok: false, issues: result.issues }
}

function inspectConfiguredManifest(manifest: CapabilityManifest): CapabilityManifestInspection | CliCapabilityManifestInspection {
  return hasCliDeclaration(manifest)
    ? inspectCliCapabilityManifest(manifest as import('@workbench/shared').CliCapabilityManifest)
    : inspectCapabilityManifest(manifest)
}

function formatConfiguredManifest(manifest: CapabilityManifest): string {
  return hasCliDeclaration(manifest)
    ? formatCliCapabilityManifestInspection(manifest as import('@workbench/shared').CliCapabilityManifest)
    : formatCapabilityManifestInspection(manifest)
}

function entryFor(binding: ConfiguredCapabilityBinding, providers: readonly ProviderInventoryRecord[]): RegistryEntry {
  const validation = binding.executionMode === 'read-only-cli'
    ? validateReadOnlyCliCapabilityManifest(binding.manifest)
    : binding.executionMode === 'isolated-output-cli'
      ? validateIsolatedOutputCliCapabilityManifest(binding.manifest)
      : binding.executionMode === 'write-capable-cli'
        ? validateWriteCapableCliCapabilityManifest(binding.manifest)
    : validateConfiguredManifest(binding.manifest)
  const manifest = validation.ok ? validation.value : undefined
  const identity = manifest
    ? capabilityManifestIdentity(manifest)
    : `${typeof (binding.manifest as Record<string, unknown> | undefined)?.id === 'string' ? (binding.manifest as Record<string, unknown>).id : 'invalid'}@${typeof (binding.manifest as Record<string, unknown> | undefined)?.version === 'string' ? (binding.manifest as Record<string, unknown>).version : 'unknown'}`
  const provider = providers.find(item => item.providerId === binding.providerId)
  const reasons = !manifest
    ? ['manifest_invalid']
    : [...modeAdmissionReasons(binding), ...(!binding.configured ? ['not_configured'] : []), ...(!safeString(binding.bindingId) ? ['binding_invalid'] : []), ...providerReasons(provider, manifest.id)]
  return { binding, manifest, issues: validation.ok ? [] : validation.issues, provider, reasons, identity }
}

function active(entry: RegistryEntry): entry is RegistryEntry & { manifest: CapabilityManifest; provider: ProviderInventoryRecord } {
  return !!entry.manifest && entry.reasons.length === 0 && typeof entry.binding.handler === 'function'
}

function snapshotEntry(entry: RegistryEntry, duplicate: boolean): CapabilityRegistrySnapshotEntry {
  const reasons = duplicate ? [...new Set([...entry.reasons, 'duplicate_identity'])] : entry.reasons
  return {
    identity: entry.identity,
    providerId: entry.binding.providerId,
    bindingId: entry.binding.bindingId,
    configured: entry.binding.configured,
    valid: !!entry.manifest,
    available: !!entry.manifest && reasons.length === 0 && typeof entry.binding.handler === 'function',
    ...(entry.binding.executionMode ? { executionMode: entry.binding.executionMode } : {}),
    availabilityReasons: reasons,
    ...(entry.manifest ? { manifest: entry.manifest } : {}),
    ...(entry.issues.length > 0 ? { invalidIssuePaths: entry.issues.slice(0, 24).map(issue => issue.path) } : {})
  }
}

function persistSnapshot(snapshot: CapabilityRegistrySnapshot, options: CapabilityRegistryOptions): void {
  const target = getCapabilityRegistryStorePath(options)
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  fs.renameSync(temporary, target)
  fs.chmodSync(target, 0o600)
}

export class CapabilityRegistry {
  private readonly entries: readonly RegistryEntry[]
  private readonly duplicates: ReadonlySet<string>
  readonly storePath: string
  readonly snapshot: CapabilityRegistrySnapshot

  constructor(private readonly options: CapabilityRegistryOptions) {
    this.entries = options.configured.slice(0, CAPABILITY_REGISTRY_MAX_ENTRIES).map(binding => entryFor(binding, options.providers))
    const counts = new Map<string, number>()
    for (const entry of this.entries) counts.set(entry.identity, (counts.get(entry.identity) ?? 0) + 1)
    this.duplicates = new Set([...counts.entries()].filter(([, count]) => count > 1).map(([identity]) => identity))
    this.storePath = getCapabilityRegistryStorePath(options)
    this.snapshot = {
      version: WORKBENCH_CAPABILITY_REGISTRY_VERSION,
      updatedAt: (options.now ?? (() => new Date()))().toISOString(),
      entries: this.entries.map(entry => snapshotEntry(entry, this.duplicates.has(entry.identity))).sort((left, right) => `${left.identity}:${left.bindingId}`.localeCompare(`${right.identity}:${right.bindingId}`))
    }
    if (options.persist !== false) {
      try { persistSnapshot(this.snapshot, options) } catch { /* registry admission remains fail-closed in memory */ }
    }
  }

  list(): CapabilityRegistryListItem[] {
    return this.entries.flatMap(entry => {
      if (this.duplicates.has(entry.identity) || !active(entry)) return []
      const manifest = entry.manifest
      const inspection = inspectConfiguredManifest(manifest)
      return [{
        id: manifest.id,
        version: manifest.version,
        name: manifest.name,
        description: manifest.description,
        risk: manifest.risk,
        configured: true as const,
        available: true as const,
        writes: inspection.writes,
        network: inspection.network,
        confirmation: inspection.confirmation
      }]
    }).sort((left, right) => `${left.id}@${left.version}`.localeCompare(`${right.id}@${right.version}`)).slice(0, CAPABILITY_REGISTRY_MAX_LIST)
  }

  inspect(id: string, version?: string): CapabilityRegistryResult<CapabilityRegistryInspection> {
    const entry = this.find(id, version)
    if (!entry) return { ok: false, code: 'capability_unknown', message: `Capability ${id}${version ? `@${version}` : ''} is not configured.` }
    if (!entry.manifest) return { ok: false, code: 'capability_invalid', message: `Capability ${entry.identity} has an invalid configured manifest.`, issues: entry.issues }
    const inspection = inspectConfiguredManifest(entry.manifest)
    return { ok: true, value: {
      ...inspection,
      summary: formatConfiguredManifest(entry.manifest),
      configured: entry.binding.configured,
      available: !this.duplicates.has(entry.identity) && active(entry),
      providerId: entry.binding.providerId,
      bindingId: entry.binding.bindingId,
      ...(entry.binding.executionMode ? { executionMode: entry.binding.executionMode } : {}),
      availabilityReasons: this.duplicates.has(entry.identity) ? [...new Set([...entry.reasons, 'duplicate_identity'])] : [...entry.reasons],
      contractConsequences: {
        writes: inspection.writes,
        network: inspection.network,
        confirmation: inspection.confirmation,
        timeout: inspection.timeout,
        validation: inspection.validation,
        redaction: inspection.redaction,
        outputLimit: inspection.outputLimit
      }
    } }
  }

  resolve(id: string, version?: string): CapabilityRegistryResult<{ manifest: CapabilityManifest; provider: ProviderInventoryRecord; bindingId: string; handler: CapabilityJobHandler; executionMode?: ConfiguredCapabilityBinding['executionMode'] }> {
    const entry = this.find(id, version)
    if (!entry) return { ok: false, code: 'capability_unknown', message: `Capability ${id}${version ? `@${version}` : ''} is not configured.` }
    if (!entry.manifest) return { ok: false, code: 'capability_invalid', message: `Capability ${entry.identity} has an invalid configured manifest.`, issues: entry.issues }
    if (this.duplicates.has(entry.identity) || entry.reasons.length > 0 || typeof entry.binding.handler !== 'function' || !entry.provider) return { ok: false, code: 'capability_unavailable', message: `Capability ${entry.identity} is not available: ${[...new Set([...entry.reasons, ...(this.duplicates.has(entry.identity) ? ['duplicate_identity'] : [])])].join(', ') || 'implementation_binding_missing'}.` }
    return { ok: true, value: { manifest: entry.manifest, provider: entry.provider, bindingId: entry.binding.bindingId, handler: entry.binding.handler, ...(entry.binding.executionMode ? { executionMode: entry.binding.executionMode } : {}) } }
  }

  private find(id: string, version?: string): RegistryEntry | undefined {
    return this.entries.find(entry => entry.manifest?.id === id && (version === undefined || entry.manifest.version === version))
      ?? this.entries.find(entry => entry.identity === `${id}@${version ?? 'unknown'}`)
  }
}

export function createCapabilityRegistry(options: CapabilityRegistryOptions): CapabilityRegistry { return new CapabilityRegistry(options) }
