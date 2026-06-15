import fs from 'fs'
import path from 'path'
import { getConfigPath, expandTilde } from '../utils/paths'
import type { Workspace, KnowledgeSource, ActiveSourcesMode, WriteMode, DiscoveredRepository, SourceDiscoverySettings } from '@workbench/shared'
import { getIndexRecord, upsertIndexState, type SourceIndexStatus } from './index-state'

export const DEFAULT_AUTO_INDEX_ENABLED = false
export const DEFAULT_AUTO_INDEX_INTERVAL_MINUTES = 5
export const MIN_AUTO_INDEX_INTERVAL_MINUTES = 1
export const MAX_AUTO_INDEX_INTERVAL_MINUTES = 60
export const DEFAULT_REPO_DISCOVERY_INTERVAL_MINUTES = 30
export const MIN_REPO_DISCOVERY_INTERVAL_MINUTES = 10
export const MAX_REPO_DISCOVERY_INTERVAL_MINUTES = 60

export function normalizeAutoIndexIntervalMinutes(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_AUTO_INDEX_INTERVAL_MINUTES
  return Math.min(MAX_AUTO_INDEX_INTERVAL_MINUTES, Math.max(MIN_AUTO_INDEX_INTERVAL_MINUTES, Math.round(numeric)))
}

export function withSourceDefaults(source: KnowledgeSource): KnowledgeSource {
  return {
    ...source,
    autoIndexEnabled: typeof source.autoIndexEnabled === 'boolean' ? source.autoIndexEnabled : DEFAULT_AUTO_INDEX_ENABLED,
    autoIndexIntervalMinutes: normalizeAutoIndexIntervalMinutes(source.autoIndexIntervalMinutes)
  }
}

export interface AgentConfig {
  userId: string
  deviceId: string
  deviceToken: string
  apiBaseUrl: string
  vaultPath?: string
  inboxSourceId?: string
  sources?: KnowledgeSource[]
  activeSourceIds?: string[]
  activeSourcesMode?: ActiveSourcesMode
  writeMode?: WriteMode
  localPort?: number
  sourceDiscovery?: SourceDiscoverySettings
  mode: 'read_create_append'
  allowedExtensions: string[]
  ignorePatterns: string[]
  workspaces?: Workspace[]
  autoIndexDefaultMigratedAt?: string
}

export function loadConfig(): AgentConfig | null {
  const configPath = getConfigPath()
  if (!fs.existsSync(configPath)) {
    return null
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8')
    const config = JSON.parse(content) as AgentConfig

    // One-time migration: disable auto-index for existing sources (prevent surprise background reindexing)
    // Only run if not already migrated (check for marker: autoIndexDefaultMigratedAt)
    if (config.sources && !config.autoIndexDefaultMigratedAt) {
      let changed = false
      config.sources = config.sources.map(source => {
        if (source.autoIndexEnabled === true) {
          changed = true
          return { ...source, autoIndexEnabled: false }
        }
        return source
      })
      if (changed) {
        console.log('[Config] One-time migration: disabling auto-index for existing sources')
        config.autoIndexDefaultMigratedAt = new Date().toISOString()
        saveConfig(config)
      } else if (config.sources.length > 0) {
        // Mark migration as done even if no changes (avoid repeated checks)
        config.autoIndexDefaultMigratedAt = new Date().toISOString()
        saveConfig(config)
      }
    }

    return config
  } catch (err) {
    return null
  }
}

export function saveConfig(config: AgentConfig): void {
  const configPath = getConfigPath()
  const dir = path.dirname(configPath)

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
}

function ensureSources(config: AgentConfig): KnowledgeSource[] {
  if (config.sources !== undefined) {
    return config.sources.map(withSourceDefaults)
  }

  if (config.vaultPath) {
    return [
      withSourceDefaults({
        id: 'vault',
        label: 'Vault',
        path: config.vaultPath,
        enabled: true
      })
    ]
  }

  return []
}

function persistSources(config: AgentConfig, sources: KnowledgeSource[]): void {
  config.sources = sources.map(withSourceDefaults)
  saveConfig(config)
}

function persistConfig(config: AgentConfig): void {
  saveConfig(config)
}

function getAllConfiguredSources(config: AgentConfig): KnowledgeSource[] {
  return ensureSources(config).map(source => ({
    ...source,
    path: expandTilde(source.path)
  }))
}

function getSourceIndexStatus(source: KnowledgeSource): {
  indexed?: boolean
  indexStatus: SourceIndexStatus
  indexedFileCount?: number
  lastIndexedAt?: string
  indexError?: string
} {
  const record = getIndexRecord(source.id)
  if (source.enabled === false) {
    return {
      indexed: false,
      indexStatus: 'disabled',
      indexedFileCount: record?.indexedFileCount,
      lastIndexedAt: record?.lastIndexedAt,
      indexError: record?.indexError
    }
  }
  if (record) {
    return record
  }
  return {
    indexed: false,
    indexStatus: 'unknown'
  }
}

export function withSourceIndexState(source: KnowledgeSource): KnowledgeSource & {
  indexed?: boolean
  indexStatus: SourceIndexStatus
  indexedFileCount?: number
  lastIndexedAt?: string
  indexError?: string
} {
  return { ...source, ...getSourceIndexStatus(source) }
}

export function getSourceIndexState(sourceId: string): ReturnType<typeof getSourceIndexStatus> | null {
  const sources = getAllConfiguredSources(loadConfig() ?? ({} as AgentConfig))
  const source = sources.find(item => item.id === sourceId)
  if (!source) return null
  return getSourceIndexStatus(source)
}

export function reconcileActiveSources(config: AgentConfig): { mode: ActiveSourcesMode; activeSourceIds: string[]; sources: KnowledgeSource[] } {
  const allSources = getAllConfiguredSources(config)
  const enabledSources = allSources.filter(source => source.enabled)
  const enabledIds = new Set(enabledSources.map(source => source.id))
  const currentMode = config.activeSourcesMode || 'all'
  const currentActiveIds = Array.from(new Set((config.activeSourceIds || []).filter(id => typeof id === 'string' && id.length > 0)))
  const filteredActiveIds = currentActiveIds.filter(id => enabledIds.has(id))

  let nextMode: ActiveSourcesMode = currentMode
  let nextActiveIds: string[] = []

  if (enabledSources.length === 0) {
    nextMode = 'all'
    nextActiveIds = []
  } else if (currentMode === 'all') {
    nextActiveIds = enabledSources.map(source => source.id)
  } else if (currentMode === 'single') {
    nextActiveIds = filteredActiveIds.slice(0, 1)
    if (nextActiveIds.length === 0) {
      nextActiveIds = [enabledSources[0].id]
    }
  } else {
    nextActiveIds = filteredActiveIds.slice(0, 10)
    if (nextActiveIds.length === 0) {
      nextMode = 'all'
      nextActiveIds = enabledSources.map(source => source.id)
    }
  }

  config.activeSourcesMode = nextMode
  config.activeSourceIds = nextActiveIds
  persistConfig(config)

  const activeIds = new Set(nextActiveIds)
  const hydrated = allSources.map(source => ({ ...withSourceIndexState(source), active: source.enabled && activeIds.has(source.id) } as KnowledgeSource & { active?: boolean }))
  return { mode: nextMode, activeSourceIds: nextActiveIds, sources: hydrated }
}

export function generateSourceIdFromPath(sourcePath: string): string {
  return path.basename(sourcePath).toLowerCase().replace(/[^a-z0-9-]/g, '-')
}

function normalizeDiscoveryIntervalMinutes(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_REPO_DISCOVERY_INTERVAL_MINUTES
  return Math.min(MAX_REPO_DISCOVERY_INTERVAL_MINUTES, Math.max(MIN_REPO_DISCOVERY_INTERVAL_MINUTES, Math.round(numeric)))
}

function prettifyRepoLabel(name: string): string {
  return name
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, char => char.toUpperCase()) || name
}

export function getSourceDiscoverySettings(): SourceDiscoverySettings {
  const config = loadConfig()
  return {
    rootPath: config?.sourceDiscovery?.rootPath ? expandTilde(config.sourceDiscovery.rootPath) : undefined,
    intervalMinutes: normalizeDiscoveryIntervalMinutes(config?.sourceDiscovery?.intervalMinutes),
    lastScannedAt: config?.sourceDiscovery?.lastScannedAt
  }
}

export function setSourceDiscoverySettings(settings: { rootPath?: string; intervalMinutes?: number; lastScannedAt?: string }): SourceDiscoverySettings {
  const config = loadConfig()
  if (!config) throw new Error('Please run: buildflow init')
  const current = getSourceDiscoverySettings()
  const rootPath = settings.rootPath !== undefined ? expandTilde(settings.rootPath.trim()) : current.rootPath
  if (rootPath) {
    if (!fs.existsSync(rootPath)) throw new Error(`Repository root folder not found: ${rootPath}`)
    if (!fs.statSync(rootPath).isDirectory()) throw new Error(`Repository root is not a directory: ${rootPath}`)
    fs.accessSync(rootPath, fs.constants.R_OK)
  }
  config.sourceDiscovery = {
    ...(rootPath ? { rootPath } : {}),
    intervalMinutes: normalizeDiscoveryIntervalMinutes(settings.intervalMinutes ?? current.intervalMinutes),
    ...(settings.lastScannedAt || current.lastScannedAt ? { lastScannedAt: settings.lastScannedAt ?? current.lastScannedAt } : {})
  }
  saveConfig(config)
  return getSourceDiscoverySettings()
}

export function discoverRepositories(rootPathInput?: string): { settings: SourceDiscoverySettings; repositories: DiscoveredRepository[] } {
  const settings = rootPathInput ? setSourceDiscoverySettings({ rootPath: rootPathInput }) : getSourceDiscoverySettings()
  if (!settings.rootPath) return { settings, repositories: [] }
  const rootPath = expandTilde(settings.rootPath)
  const configured = getSourcesSafe()
  const configuredByPath = new Map(configured.map(source => [path.resolve(source.path), source]))
  const repositories: DiscoveredRepository[] = []
  const seen = new Set<string>()
  const maxDepth = 5

  const walk = (current: string, depth: number) => {
    if (depth > maxDepth) return
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    if (entries.some(entry => entry.isDirectory() && entry.name === '.git')) {
      const resolved = path.resolve(current)
      if (!seen.has(resolved)) {
        seen.add(resolved)
        const relativePath = path.relative(rootPath, resolved) || path.basename(resolved)
        const [account = 'Root'] = relativePath.split(path.sep)
        const existing = configuredByPath.get(resolved)
        repositories.push({
          path: resolved,
          label: prettifyRepoLabel(path.basename(resolved)),
          id: `${generateSourceIdFromPath(account)}-${generateSourceIdFromPath(resolved)}`,
          account,
          relativePath,
          alreadyAdded: !!existing,
          sourceId: existing?.id
        })
      }
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.cache', '.turbo'].includes(entry.name)) continue
      walk(path.join(current, entry.name), depth + 1)
    }
  }

  walk(rootPath, 0)
  const nextSettings = setSourceDiscoverySettings({ rootPath, intervalMinutes: settings.intervalMinutes, lastScannedAt: new Date().toISOString() })
  return { settings: nextSettings, repositories: repositories.sort((a, b) => `${a.account}/${a.label}`.localeCompare(`${b.account}/${b.label}`)) }
}

export function getSources(): KnowledgeSource[] {
  const config = loadConfig()
  const sources = ensureSources(config ?? ({} as AgentConfig))
  if (sources.length === 0 && !(config && config.sources !== undefined)) {
    throw new Error('No knowledge sources configured. Run: buildflow connect <folder>')
  }

  return sources.map(s => withSourceIndexState({
    ...s,
    path: expandTilde(s.path)
  }))
}

export function getSourcesSafe(): KnowledgeSource[] {
  const config = loadConfig()
  const sources = ensureSources(config ?? ({} as AgentConfig))

  return sources.map(s => withSourceIndexState({
    ...s,
    path: expandTilde(s.path)
  }))
}

export function getEnabledSources(): KnowledgeSource[] {
  return getSources().filter(s => s.enabled)
}

export function getActiveSourceContext(): { mode: ActiveSourcesMode; activeSourceIds: string[]; sources: KnowledgeSource[] } {
  const config = loadConfig()
  if (!config) {
    return { mode: 'all', activeSourceIds: [], sources: [] }
  }

  return reconcileActiveSources(config)
}

export function setActiveSourceContext(mode: ActiveSourcesMode, activeSourceIds: string[] = []): { mode: ActiveSourcesMode; activeSourceIds: string[]; sources: KnowledgeSource[] } {
  const config = loadConfig()
  if (!config) throw new Error('Please run: buildflow init')
  const sources = getEnabledSources()
  const ids = new Set(sources.map(s => s.id))
  const uniqueIds = Array.from(new Set(activeSourceIds.filter(id => typeof id === 'string' && id.length > 0)))
  const invalidIds = uniqueIds.filter(id => !ids.has(id))
  if (invalidIds.length > 0) {
    throw new Error(`Unknown or disabled sourceId(s): ${invalidIds.join(', ')}`)
  }
  if (mode === 'single' && uniqueIds.length !== 1) throw new Error('single mode requires exactly one activeSourceId')
  if (mode === 'multi' && uniqueIds.length === 0) throw new Error('multi mode requires one or more activeSourceIds')
  config.activeSourcesMode = mode
  config.activeSourceIds = mode === 'all' ? sources.map(s => s.id) : uniqueIds.slice(0, 10)
  persistConfig(config)
  return reconcileActiveSources(config)
}

export function getWriteMode(): WriteMode {
  const config = loadConfig()
  return config?.writeMode || 'safeWrites'
}

export function setWriteMode(writeMode: WriteMode): WriteMode {
  const config = loadConfig()
  if (!config) throw new Error('Please run: buildflow init')
  config.writeMode = writeMode
  persistConfig(config)
  return getWriteMode()
}

export function addSource(pathInput: string, label?: string, id?: string): KnowledgeSource[] {
  const config = loadConfig()
  if (!config) {
    throw new Error('Please run: buildflow init')
  }

  if (!pathInput) {
    throw new Error('Knowledge source path required')
  }

  const expanded = expandTilde(pathInput)
  if (!fs.existsSync(expanded)) {
    throw new Error(`Knowledge source folder not found: ${expanded}`)
  }
  if (!fs.statSync(expanded).isDirectory()) {
    throw new Error(`Not a directory: ${expanded}`)
  }
  fs.accessSync(expanded, fs.constants.R_OK)

  const sources = ensureSources(config)
  const sourceId = id || generateSourceIdFromPath(expanded)
  if (sources.some(source => source.id === sourceId)) {
    throw new Error(`Knowledge source with ID "${sourceId}" already exists`)
  }

  sources.push(withSourceDefaults({
    id: sourceId,
    label: label || path.basename(expanded),
    path: expanded,
    enabled: true,
    type: 'unknown'
  }))

  persistSources(config, sources)
  if (!config.vaultPath) {
    config.vaultPath = expanded
  }
  saveConfig(config)

  return getSources()
}

export function removeSource(sourceId: string): KnowledgeSource[] {
  const config = loadConfig()
  if (!config) {
    throw new Error('Please run: buildflow init')
  }

  const sources = ensureSources(config)
  const nextSources = sources.filter(source => source.id !== sourceId)
  if (nextSources.length === sources.length) {
    throw new Error(`Knowledge source not found: ${sourceId}`)
  }

  persistSources(config, nextSources)
  return getSources()
}

export function setSourceEnabled(sourceId: string, enabled: boolean): KnowledgeSource[] {
  const config = loadConfig()
  if (!config) {
    throw new Error('Please run: buildflow init')
  }

  const sources = ensureSources(config)
  const nextSources = sources.map(source => {
    if (source.id !== sourceId) {
      return source
    }

    return withSourceDefaults({ ...source, enabled })
  })

  if (!sources.some(source => source.id === sourceId)) {
    throw new Error(`Knowledge source not found: ${sourceId}`)
  }

  persistSources(config, nextSources)
  if (enabled) {
    upsertIndexState(sourceId, {
      indexed: false,
      indexStatus: 'pending',
      indexedFileCount: 0,
      indexError: undefined
    })
  } else {
    upsertIndexState(sourceId, {
      indexed: false,
      indexStatus: 'disabled',
      indexError: undefined
    })
  }
  return reconcileActiveSources(config).sources
}

export function setSourceAutoIndex(sourceId: string, settings: { enabled?: boolean; intervalMinutes?: number }): KnowledgeSource[] {
  const config = loadConfig()
  if (!config) {
    throw new Error('Please run: buildflow init')
  }

  const sources = ensureSources(config)
  let found = false
  const nextSources = sources.map(source => {
    if (source.id !== sourceId) return source
    found = true
    return withSourceDefaults({
      ...source,
      autoIndexEnabled: typeof settings.enabled === 'boolean' ? settings.enabled : source.autoIndexEnabled,
      autoIndexIntervalMinutes: settings.intervalMinutes === undefined ? source.autoIndexIntervalMinutes : normalizeAutoIndexIntervalMinutes(settings.intervalMinutes)
    })
  })

  if (!found) {
    throw new Error(`Knowledge source not found: ${sourceId}`)
  }

  persistSources(config, nextSources)
  return reconcileActiveSources(config).sources
}

export function markSourceAutoIndexed(sourceId: string, timestamp = new Date().toISOString()): KnowledgeSource[] {
  const config = loadConfig()
  if (!config) {
    throw new Error('Please run: buildflow init')
  }

  const sources = ensureSources(config)
  let changed = false
  const nextSources = sources.map(source => {
    if (source.id !== sourceId) return source
    changed = true
    return withSourceDefaults({ ...source, lastAutoIndexedAt: timestamp })
  })

  if (changed) {
    persistSources(config, nextSources)
  }

  return getSourcesSafe()
}

export function setSourceIndexStatus(
  sourceId: string,
  record: {
    indexed?: boolean
    indexStatus: SourceIndexStatus
    indexedFileCount?: number
    lastIndexedAt?: string
    indexError?: string
  }
): void {
  upsertIndexState(sourceId, record)
}

export function markSourceIndexPending(sourceId: string): void {
  upsertIndexState(sourceId, {
    indexed: false,
    indexStatus: 'pending',
    indexedFileCount: 0,
    indexError: undefined
  })
}

export function getVaultPath(): string {
  const config = loadConfig()
  if (!config?.vaultPath) {
    throw new Error('No vault path configured. Run: buildflow connect <folder>')
  }

  return expandTilde(config.vaultPath)
}

export function getInboxSourceId(): string {
  const config = loadConfig()
  return config?.inboxSourceId || 'mind'
}

export function getLocalPort(): number {
  const config = loadConfig()
  return config?.localPort ?? 3052
}

export function getWorkspaces(): Workspace[] {
  const config = loadConfig()
  if (config?.workspaces && config.workspaces.length > 0) {
    return config.workspaces
  }

  if (config?.vaultPath) {
    return [
      {
        name: 'vault',
        root: config.vaultPath,
        mode: 'default'
      }
    ]
  }

  return []
}

export function getWorkspace(name: string): Workspace | null {
  const workspaces = getWorkspaces()
  return workspaces.find(ws => ws.name === name) ?? null
}
