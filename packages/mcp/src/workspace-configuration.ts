import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ConfiguredProvider, WorkspaceConfiguration } from '@workbench/shared'
import { discoverProviderManifests, type ProviderDiscoveryFailure, type ProviderDiscoveryCandidate, type WorkbenchProviderCategory } from './provider-discovery.js'

export const WORKSPACE_CONFIGURATION_VERSION = 1 as const
export const WORKSPACE_CONFIGURATION_FILENAME = 'workspace-config.json' as const
const ID = /^[a-z][a-z0-9._-]{0,159}$/
const OWNER_ID = /^[a-zA-Z0-9._:@/-]{1,160}$/
const MAX_PROVIDERS = 128
const MAX_WORKSPACES = 64

export type WorkspaceConfigurationOptions = {
  configPath?: string
  configDir?: string
  maxProviders?: number
  maxWorkspaces?: number
  now?: () => string
}

export type WorkspaceConfigurationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: 'configuration_missing' | 'configuration_unreadable' | 'configuration_invalid'; message: string }

export type ConfiguredProviderObservation = {
  providerId: string
  category: 'knowledge' | 'capability'
  enabled: boolean
  manifestPath: string
  state: 'disabled' | 'discovered' | 'unavailable' | 'invalid' | 'not_configured'
  candidate?: ProviderDiscoveryCandidate
  failure?: ProviderDiscoveryFailure
}

export type WorkspaceProviderRuntime = {
  configurationPath: string
  configuration: WorkspaceConfiguration
  workspaces: WorkspaceConfiguration['workspaces']
  knowledgeProviders: ConfiguredProviderObservation[]
  capabilityProviders: ConfiguredProviderObservation[]
  observedAt: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function expandTilde(value: string): string {
  return value.startsWith('~') ? path.join(os.homedir(), value.slice(1)) : value
}

function defaultConfigPath(options: WorkspaceConfigurationOptions = {}): string {
  if (options.configPath) return path.resolve(expandTilde(options.configPath))
  const dir = options.configDir ?? process.env.WORKBENCH_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'workbench')
  return path.join(path.resolve(expandTilde(dir)), WORKSPACE_CONFIGURATION_FILENAME)
}

function validWorkspace(value: unknown): boolean {
  if (!isRecord(value) || !ID.test(String(value.workspaceId ?? '')) || !boundedString(value.root, 2048) || !boundedString(value.name, 256)) return false
  return typeof value.enabled === 'boolean' && ['read_only', 'default'].includes(String(value.mode))
}

function validConfiguredProvider(value: unknown): value is ConfiguredProvider {
  if (!isRecord(value) || !ID.test(String(value.providerId ?? '')) || !boundedString(value.manifestPath, 2048) || !OWNER_ID.test(String(value.ownerId ?? ''))) return false
  return typeof value.enabled === 'boolean' && ['user', 'workspace', 'organization'].includes(String(value.ownerType))
}

export function validateWorkspaceConfiguration(value: unknown, options: WorkspaceConfigurationOptions = {}): value is WorkspaceConfiguration {
  if (!isRecord(value) || value.schemaVersion !== WORKSPACE_CONFIGURATION_VERSION || !Array.isArray(value.workspaces) || !Array.isArray(value.knowledgeProviders) || !Array.isArray(value.capabilityProviders)) return false
  const maxWorkspaces = Math.max(1, Math.min(options.maxWorkspaces ?? MAX_WORKSPACES, MAX_WORKSPACES))
  const maxProviders = Math.max(1, Math.min(options.maxProviders ?? MAX_PROVIDERS, MAX_PROVIDERS))
  const workspaces = value.workspaces as unknown[]
  const knowledge = value.knowledgeProviders as unknown[]
  const capability = value.capabilityProviders as unknown[]
  if (workspaces.length > maxWorkspaces || knowledge.length > maxProviders || capability.length > maxProviders) return false
  if (!workspaces.every(validWorkspace) || !knowledge.every(validConfiguredProvider) || !capability.every(validConfiguredProvider)) return false
  const ids = [...knowledge, ...capability].map(item => String((item as ConfiguredProvider).providerId))
  return new Set(ids).size === ids.length
}

export function emptyWorkspaceConfiguration(): WorkspaceConfiguration {
  return { schemaVersion: WORKSPACE_CONFIGURATION_VERSION, workspaces: [], knowledgeProviders: [], capabilityProviders: [] }
}

export function loadWorkspaceConfiguration(options: WorkspaceConfigurationOptions = {}): WorkspaceConfigurationResult<{ path: string; value: WorkspaceConfiguration }> {
  const configurationPath = defaultConfigPath(options)
  if (!fs.existsSync(configurationPath)) return { ok: true, value: { path: configurationPath, value: emptyWorkspaceConfiguration() } }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configurationPath, 'utf8'))
    if (!validateWorkspaceConfiguration(parsed, options)) return { ok: false, code: 'configuration_invalid', message: 'Workspace configuration failed bounded validation.' }
    return { ok: true, value: { path: configurationPath, value: parsed } }
  } catch {
    return { ok: false, code: 'configuration_unreadable', message: 'Workspace configuration could not be read safely.' }
  }
}

function observeConfiguredProvider(provider: ConfiguredProvider, category: 'knowledge' | 'capability', now: string): ConfiguredProviderObservation {
  const manifestPath = path.resolve(expandTilde(provider.manifestPath))
  if (!provider.enabled) return { providerId: provider.providerId, category, enabled: false, manifestPath, state: 'disabled' }
  const discovery = discoverProviderManifests([{ path: manifestPath }], { maxLocations: 1, now: () => now })
  const candidate = discovery.candidates[0]
  const failure = discovery.failures[0]
  if (!candidate) return { providerId: provider.providerId, category, enabled: true, manifestPath, state: failure?.code === 'location_unavailable' ? 'unavailable' : 'invalid', ...(failure ? { failure } : {}) }
  const expectedType: WorkbenchProviderCategory = category
  if (candidate.providerId !== provider.providerId || candidate.manifest.providerType !== expectedType) {
    return { providerId: provider.providerId, category, enabled: true, manifestPath, state: 'invalid', failure: { code: 'manifest_invalid', location: manifestPath, manifestPath, reason: 'configured provider identity or category does not match its manifest' } }
  }
  return { providerId: provider.providerId, category, enabled: true, manifestPath, state: candidate.manifest.health.state === 'unreachable' ? 'unavailable' : 'discovered', candidate }
}

export function loadConfiguredProviderRuntime(options: WorkspaceConfigurationOptions = {}): WorkspaceConfigurationResult<WorkspaceProviderRuntime> {
  const loaded = loadWorkspaceConfiguration(options)
  if (!loaded.ok) return loaded
  const now = (options.now ?? (() => new Date().toISOString()))()
  const configuration = loaded.value.value
  return { ok: true, value: { configurationPath: loaded.value.path, configuration, workspaces: [...configuration.workspaces].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)), knowledgeProviders: configuration.knowledgeProviders.map(item => observeConfiguredProvider(item, 'knowledge', now)).sort((a, b) => a.providerId.localeCompare(b.providerId)), capabilityProviders: configuration.capabilityProviders.map(item => observeConfiguredProvider(item, 'capability', now)).sort((a, b) => a.providerId.localeCompare(b.providerId)), observedAt: now } }
}
