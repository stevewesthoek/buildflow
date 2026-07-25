import fs from 'node:fs'
import path from 'node:path'

const MAX_CONFIG_BYTES = 1_000_000
const MAX_CREDENTIAL_BYTES = 4096
const CONFIG_KEYS = new Set(['N8N_API_URL', 'N8N_API_KEY'])

export type N8nRuntimeConfiguration = {
  environment: NodeJS.ProcessEnv
  credentialValues: string[]
}

export type N8nRuntimeConfigurationErrorCode =
  | 'CONFIG_FILE_UNAVAILABLE'
  | 'CONFIG_FILE_UNSAFE'
  | 'CONFIG_FILE_INVALID'
  | 'API_URL_MISSING'
  | 'API_URL_INVALID'
  | 'API_KEY_MISSING'
  | 'API_KEY_INVALID'

export class N8nRuntimeConfigurationError extends Error {
  constructor(readonly code: N8nRuntimeConfigurationErrorCode) {
    super('Guarded n8n runtime configuration is unavailable.')
  }
}

function fail(code: N8nRuntimeConfigurationErrorCode): never {
  throw new N8nRuntimeConfigurationError(code)
}

function parseValue(raw: string): string {
  const value = raw.trim()
  if (!value) return ''
  if (value.startsWith('"') || value.startsWith("'")) {
    const quoted = value.match(/^(['"])(.*?)\1(?:\s+#.*)?$/)
    if (!quoted) fail('CONFIG_FILE_INVALID')
    return quoted[2]
  }
  return value.replace(/\s+#.*$/, '').trim()
}

function parseConfigFile(raw: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/)
    if (!match || !CONFIG_KEYS.has(match[1])) continue
    if (values.has(match[1])) fail('CONFIG_FILE_INVALID')
    values.set(match[1], parseValue(match[2]))
  }
  return values
}

function readOwnerLocalConfig(configPath: string): Map<string, string> {
  if (!path.isAbsolute(configPath)) fail('CONFIG_FILE_UNSAFE')
  let descriptor: number | undefined
  try {
    const stat = fs.lstatSync(configPath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES || (stat.mode & 0o077) !== 0) {
      fail('CONFIG_FILE_UNSAFE')
    }
    descriptor = fs.openSync(configPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    const opened = fs.fstatSync(descriptor)
    if (!opened.isFile() || opened.size > MAX_CONFIG_BYTES || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      fail('CONFIG_FILE_UNSAFE')
    }
    const bytes = fs.readFileSync(descriptor)
    if (bytes.byteLength > MAX_CONFIG_BYTES) fail('CONFIG_FILE_UNSAFE')
    return parseConfigFile(bytes.toString('utf8'))
  } catch (error) {
    if (error instanceof N8nRuntimeConfigurationError) throw error
    fail('CONFIG_FILE_UNAVAILABLE')
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

function validateApiUrl(raw: string | undefined): string {
  if (!raw) return fail('API_URL_MISSING')
  if (raw.length > 2048 || /\s/.test(raw) || raw.includes('\\')) return fail('API_URL_INVALID')
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return fail('API_URL_INVALID')
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    return fail('API_URL_INVALID')
  }
  return raw.replace(/\/+$/, '')
}

function validateApiKey(raw: string | undefined): string {
  if (!raw) return fail('API_KEY_MISSING')
  if (raw.length < 4 || Buffer.byteLength(raw, 'utf8') > MAX_CREDENTIAL_BYTES || /\s/.test(raw) || /^<.*>$/.test(raw)) {
    return fail('API_KEY_INVALID')
  }
  return raw
}

export function loadOwnerLocalN8nRuntimeConfiguration(
  env: NodeJS.ProcessEnv = process.env
): N8nRuntimeConfiguration {
  const home = env.HOME || ''
  const configPath = env.N8N_CONFIG_FILE || (home ? path.join(home, '.config', 'n8n', '.env') : '')
  const fileValues = configPath ? readOwnerLocalConfig(configPath) : fail('CONFIG_FILE_UNAVAILABLE')
  const apiUrl = validateApiUrl(fileValues.get('N8N_API_URL'))
  const runtimeValue = validateApiKey(fileValues.get('N8N_API_KEY'))

  return {
    environment: {
      PATH: env.PATH || '',
      HOME: home,
      CI: '1',
      NO_COLOR: '1',
      N8N_API_URL: apiUrl,
      N8N_API_KEY: runtimeValue
    },
    credentialValues: [runtimeValue]
  }
}

export function createOwnerLocalN8nRuntimeConfigurationSnapshot(
  env: NodeJS.ProcessEnv = process.env
): () => N8nRuntimeConfiguration {
  const ownerEnvironment: NodeJS.ProcessEnv = {
    HOME: env.HOME,
    PATH: env.PATH,
    N8N_CONFIG_FILE: env.N8N_CONFIG_FILE
  }
  let resolved = false
  let configuration: N8nRuntimeConfiguration | undefined
  let failure: unknown

  return () => {
    if (!resolved) {
      resolved = true
      try {
        configuration = loadOwnerLocalN8nRuntimeConfiguration(ownerEnvironment)
      } catch (error) {
        failure = error
      }
    }
    if (failure) throw failure
    if (!configuration) fail('CONFIG_FILE_UNAVAILABLE')
    return configuration
  }
}
