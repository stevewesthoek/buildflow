import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export type CbmBackend = 'disabled' | 'cbm'
export type CbmCacheLayout = 'repository' | 'identity'

export type CbmProviderConfiguration = {
  providerId: string
  executable: string
  cacheRoot?: string
  cacheLayout?: CbmCacheLayout
}

const CONFIG_FILE = 'graph-backend.json'
const ALLOWED_VALUES: ReadonlySet<string> = new Set(['disabled', 'cbm'])
const OWNER_DIR_MODE = 0o700
const OWNER_FILE_MODE = 0o600
const PROVIDER_ID = /^[a-z][a-z0-9._-]{0,159}$/

export type CbmConfigResult =
  | { backend: CbmBackend; source: 'config' | 'default'; provider?: CbmProviderConfiguration }
  | { backend: 'disabled'; source: 'default'; reason: string }

function parseProvider(value: unknown): CbmProviderConfiguration | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('config_invalid_provider')
  const record = value as Record<string, unknown>
  const providerId = typeof record.providerId === 'string' ? record.providerId.trim() : ''
  const executable = typeof record.executable === 'string' ? record.executable.trim() : ''
  const cacheRoot = typeof record.cacheRoot === 'string' ? record.cacheRoot.trim() : undefined
  const cacheLayout: CbmCacheLayout | undefined = record.cacheLayout === undefined
    ? undefined
    : record.cacheLayout === 'repository' || record.cacheLayout === 'identity'
      ? record.cacheLayout
      : undefined
  if (!PROVIDER_ID.test(providerId) || !executable || executable.length > 2048) throw new Error('config_invalid_provider')
  if (cacheRoot !== undefined && (!cacheRoot || cacheRoot.length > 2048 || !path.isAbsolute(cacheRoot))) throw new Error('config_invalid_provider')
  if (record.cacheLayout !== undefined && cacheLayout === undefined) throw new Error('config_invalid_provider')
  return { providerId, executable, ...(cacheRoot ? { cacheRoot } : {}), ...(cacheLayout ? { cacheLayout } : {}) }
}

function configDir(): string {
  const override = (process.env.WORKBENCH_CONFIG_DIR ?? '').trim()
  if (override) return path.resolve(override.startsWith('~') ? path.join(os.homedir(), override.slice(1)) : override)
  return path.join(os.homedir(), '.buildflow')
}

function configPath(dir?: string): string {
  return path.join(dir ?? configDir(), CONFIG_FILE)
}

function failClosed(reason: string): CbmConfigResult {
  return { backend: 'disabled', source: 'default', reason }
}

export function readCbmConfig(configDirOverride?: string): CbmConfigResult {
  const dir = configDirOverride ?? configDir()
  const file = configPath(dir)

  if (!fs.existsSync(file)) {
    return { backend: 'disabled', source: 'default' }
  }

  // Reject symlinked config file
  let fileStat: fs.Stats
  try { fileStat = fs.lstatSync(file) }
  catch { return failClosed('config_unreadable') }
  if (fileStat.isSymbolicLink()) return failClosed('config_is_symlink')

  // Reject symlinked config directory
  let dirStat: fs.Stats
  try { dirStat = fs.lstatSync(dir) }
  catch { return failClosed('config_dir_unreadable') }
  if (dirStat.isSymbolicLink()) return failClosed('config_dir_is_symlink')

  // Owner-only dir: reject group/world readable (0o700 required)
  const dirMode = dirStat.mode & 0o777
  if ((dirMode & 0o077) !== 0) return failClosed('config_dir_unsafe_permissions')

  // Owner-only file: reject group/world readable (0o600 required)
  const fileMode = fileStat.mode & 0o777
  if ((fileMode & 0o077) !== 0) return failClosed('config_file_unsafe_permissions')

  let raw: string
  try { raw = fs.readFileSync(file, 'utf-8') }
  catch { return failClosed('config_unreadable') }

  let parsed: unknown
  try { parsed = JSON.parse(raw) }
  catch { return failClosed('config_invalid_json') }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return failClosed('config_invalid_format')
  }

  const value = (parsed as Record<string, unknown>).backend
  if (typeof value !== 'string') return failClosed('config_missing_backend_field')
  const trimmed = value.trim().toLowerCase()
  if (!ALLOWED_VALUES.has(trimmed)) return failClosed(`config_invalid_value:${trimmed}`)

  try {
    const provider = parseProvider((parsed as Record<string, unknown>).provider)
    return { backend: trimmed as CbmBackend, source: 'config', ...(provider ? { provider } : {}) }
  } catch (error) {
    return failClosed(error instanceof Error ? error.message : 'config_invalid_provider')
  }
}

export function writeCbmConfig(backend: CbmBackend, configDirOverride?: string, provider?: CbmProviderConfiguration): void {
  if (!ALLOWED_VALUES.has(backend)) throw new Error(`Invalid CBM backend value: ${backend}`)
  if (provider) parseProvider(provider)
  const dir = configDirOverride ?? configDir()
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: OWNER_DIR_MODE })
    fs.chmodSync(dir, OWNER_DIR_MODE)
  }
  const actualDirMode = fs.statSync(dir).mode & 0o777
  if ((actualDirMode & 0o077) !== 0) throw new Error('Config directory has unsafe permissions; refusing to write')
  const file = configPath(dir)
  const tmp = `${file}.tmp.${process.pid}`
  try {
    fs.writeFileSync(tmp, JSON.stringify({ backend, ...(provider ? { provider } : {}) }, null, 2) + '\n', { mode: OWNER_FILE_MODE })
    fs.chmodSync(tmp, OWNER_FILE_MODE)
    const tmpMode = fs.statSync(tmp).mode & 0o777
    if (tmpMode !== OWNER_FILE_MODE) throw new Error(`chmod verify failed: expected 0o${OWNER_FILE_MODE.toString(8)}, got 0o${tmpMode.toString(8)}`)
    fs.renameSync(tmp, file)
    fs.chmodSync(file, OWNER_FILE_MODE)
    const finalMode = fs.statSync(file).mode & 0o777
    if (finalMode !== OWNER_FILE_MODE) throw new Error(`final chmod verify failed: expected 0o${OWNER_FILE_MODE.toString(8)}, got 0o${finalMode.toString(8)}`)
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch { /* ignore */ }
  }
}

export function resolvedBackendEnv(configDirOverride?: string): { WORKBENCH_GRAPH_BACKEND: string } {
  const result = readCbmConfig(configDirOverride)
  return { WORKBENCH_GRAPH_BACKEND: result.backend }
}
