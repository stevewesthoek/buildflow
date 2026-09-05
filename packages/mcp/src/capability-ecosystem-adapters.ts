import {
  CAPABILITY_PROVIDER_MANIFEST_KIND,
  CAPABILITY_PROVIDER_MANIFEST_VERSION,
  type CapabilityOperation,
  type CapabilityProviderManifest,
  type CapabilityDiscoveryInput,
  discoverCapabilityProviders,
  validateCapabilityProviderManifest,
  type CapabilityDiscoveryResult
} from './capability-provider.js'
import { WORKBENCH_PROVIDER_CONTRACT_VERSION } from './provider-lifecycle.js'

export const CAPABILITY_ECOSYSTEMS = ['cli', 'skill', 'orchestrator'] as const
export type CapabilityEcosystem = typeof CAPABILITY_ECOSYSTEMS[number]
export type CapabilityPermission = { permission: string; description?: string }
export type CapabilityRequirement = { requirementId: string; description: string }
export type CapabilityAdapterBase = { providerId: string; displayName: string; providerVersion: string; ownerId: string; capabilities: string[]; permissions: CapabilityPermission[]; requirements?: CapabilityRequirement[]; health?: CapabilityProviderManifest['health']; compatibility?: CapabilityProviderManifest['compatibility'] }
export type CliCapabilityInput = CapabilityAdapterBase & { commands: Array<{ commandId: string; description: string; permission: string; inputSchemaVersion: string }> }
export type SkillCapabilityInput = CapabilityAdapterBase & { skillDescription: string; lifecycle: 'discovered' | 'reviewed' | 'registered' | 'enabled' | 'disabled' }
export type OrchestratorCapabilityInput = CapabilityAdapterBase & { workflows: Array<{ operationId: string; description: string; permission: string; inputSchemaVersion: string }> }
export type CapabilityAdapterResult = { ok: true; value: CapabilityProviderManifest } | { ok: false; code: 'invalid_metadata'; message: string }

const ID = /^[a-z][a-z0-9._-]{0,159}$/
const bounded = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
const list = (value: unknown, max: number): value is unknown[] => Array.isArray(value) && value.length <= max
const nowHealth = (): CapabilityProviderManifest['health'] => ({ state: 'unknown', observedAt: new Date().toISOString() })
const base = (ecosystem: CapabilityEcosystem, input: CapabilityAdapterBase, operations: CapabilityOperation[]): CapabilityAdapterResult => {
  if (!ID.test(input.providerId) || !bounded(input.displayName, 256) || !bounded(input.providerVersion, 64) || !bounded(input.ownerId, 160) || !list(input.capabilities, 128) || !input.capabilities.every(item => bounded(item, 160)) || !list(input.permissions, 128) || !input.permissions.every(item => bounded(item.permission, 160))) return { ok: false, code: 'invalid_metadata', message: `${ecosystem} capability metadata failed bounded validation.` }
  if (!list(operations, 128) || !operations.every(item => ID.test(item.operationId) && bounded(item.description, 500) && bounded(item.permission, 160) && bounded(item.inputSchemaVersion, 32))) return { ok: false, code: 'invalid_metadata', message: `${ecosystem} operation metadata failed bounded validation.` }
  const manifest: CapabilityProviderManifest = { kind: CAPABILITY_PROVIDER_MANIFEST_KIND, manifestVersion: CAPABILITY_PROVIDER_MANIFEST_VERSION, providerId: input.providerId, providerType: 'capability', displayName: input.displayName, providerVersion: input.providerVersion, location: { kind: 'opaque-reference', value: `ecosystem://${ecosystem}/${input.providerId}` }, ownership: { ownerType: 'user', ownerId: input.ownerId }, capabilities: [...new Set(input.capabilities)].sort(), health: input.health ?? nowHealth(), compatibility: input.compatibility ?? { contractVersion: WORKBENCH_PROVIDER_CONTRACT_VERSION }, operations: operations.slice().sort((a, b) => a.operationId.localeCompare(b.operationId)) }
  return validateCapabilityProviderManifest(manifest) ? { ok: true, value: manifest } : { ok: false, code: 'invalid_metadata', message: `${ecosystem} capability manifest failed generic validation.` }
}
export function createCliCapabilityManifest(input: CliCapabilityInput): CapabilityAdapterResult { return base('cli', input, input.commands.map(item => ({ operationId: item.commandId, description: item.description, permission: item.permission, inputSchemaVersion: item.inputSchemaVersion }))) }
export function createSkillCapabilityManifest(input: SkillCapabilityInput): CapabilityAdapterResult { if (!bounded(input.skillDescription, 1_000) || !['discovered', 'reviewed', 'registered', 'enabled', 'disabled'].includes(input.lifecycle)) return { ok: false, code: 'invalid_metadata', message: 'Skill metadata failed bounded lifecycle validation.' }; return base('skill', input, [{ operationId: 'describe', description: input.skillDescription, permission: input.permissions[0]?.permission || 'skill.metadata.read', inputSchemaVersion: '1' }]) }
export function createOrchestratorCapabilityManifest(input: OrchestratorCapabilityInput): CapabilityAdapterResult { return base('orchestrator', input, input.workflows.map(item => ({ operationId: item.operationId, description: item.description, permission: item.permission, inputSchemaVersion: item.inputSchemaVersion }))) }
export function discoverCapabilityEcosystemMetadata(inputs: readonly ({ ecosystem: CapabilityEcosystem; manifest: CapabilityProviderManifest })[], now = new Date()): CapabilityDiscoveryResult { const normalized: CapabilityDiscoveryInput[] = inputs.slice(0, 64).map(item => ({ source: item.ecosystem, manifest: item.manifest })); return discoverCapabilityProviders(normalized, now) }
