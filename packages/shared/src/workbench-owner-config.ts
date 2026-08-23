import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TextDecoder } from 'node:util'

const MAX_CONFIG_BYTES = 64 * 1024
const MIN_TOKEN_LENGTH = 16
const MAX_TOKEN_LENGTH = 4096
const CANONICAL_KEY = 'WORKBENCH_ACTION_TOKEN'
const LEGACY_KEY = 'BUILDFLOW_ACTION_TOKEN'

export type WorkbenchOwnerConfigErrorCode =
  | 'CONFIG_UNAVAILABLE'
  | 'CONFIG_UNSAFE'
  | 'CONFIG_INVALID'
  | 'TOKEN_MISSING'
  | 'TOKEN_INVALID'
  | 'LEGACY_KEY_NOT_ALLOWED'

export class WorkbenchOwnerConfigError extends Error {
  constructor(readonly code: WorkbenchOwnerConfigErrorCode) {
    super('Workbench action authentication configuration is unavailable or invalid.')
  }
}

export type WorkbenchOwnerConfig = {
  actionToken: string
  configPath: string
  mode: '0600'
}

type ReadOptions = {
  allowLegacy?: boolean
  allowUnknown?: boolean
  expectedUid?: number
}

function fail(code: WorkbenchOwnerConfigErrorCode): never {
  throw new WorkbenchOwnerConfigError(code)
}

function expectedOwner(options: ReadOptions): number | undefined {
  return options.expectedUid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined)
}

function parseValue(raw: string): string {
  const value = raw.trim()
  if (!value) return ''
  if (value.startsWith('"') || value.startsWith("'")) {
    const quoted = value.match(/^(['"])(.*?)\1(?:\s+#.*)?$/)
    if (!quoted) fail('CONFIG_INVALID')
    return quoted[2]
  }
  return value.replace(/\s+#.*$/, '').trim()
}

function parseAssignments(raw: string, options: ReadOptions): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/)
    if (!match) {
      if (options.allowUnknown) continue
      fail('CONFIG_INVALID')
    }
    if (match[1] !== CANONICAL_KEY && match[1] !== LEGACY_KEY) {
      if (options.allowUnknown) continue
      fail('CONFIG_INVALID')
    }
    if (values.has(match[1])) fail('CONFIG_INVALID')
    values.set(match[1], parseValue(match[2]))
  }
  return values
}

function validateToken(value: string | undefined): string {
  if (!value) return fail('TOKEN_MISSING')
  if (value.length < MIN_TOKEN_LENGTH
    || Buffer.byteLength(value, 'utf8') > MAX_TOKEN_LENGTH
    || /[\s\0]/.test(value)
    || /^<.*>$/.test(value)) {
    return fail('TOKEN_INVALID')
  }
  return value
}

function readOwnerFile(file: string, options: ReadOptions): string {
  if (!path.isAbsolute(file)) fail('CONFIG_UNSAFE')
  let descriptor: number | undefined
  try {
    const stat = fs.lstatSync(file)
    const owner = expectedOwner(options)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES
      || (stat.mode & 0o077) !== 0 || (owner !== undefined && stat.uid !== owner)) {
      fail('CONFIG_UNSAFE')
    }
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    const opened = fs.fstatSync(descriptor)
    if (!opened.isFile() || opened.size > MAX_CONFIG_BYTES || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      fail('CONFIG_UNSAFE')
    }
    const bytes = fs.readFileSync(descriptor)
    if (bytes.byteLength > MAX_CONFIG_BYTES) fail('CONFIG_UNSAFE')
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return fail('CONFIG_INVALID')
    }
  } catch (error) {
    if (error instanceof WorkbenchOwnerConfigError) throw error
    return fail('CONFIG_UNAVAILABLE')
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

export function resolveWorkbenchOwnerConfigPath(homeDir = os.userInfo().homedir): string {
  if (!path.isAbsolute(homeDir)) fail('CONFIG_UNSAFE')
  return path.join(homeDir, '.config', 'workbench', 'runtime.env')
}

export function readWorkbenchActionTokenSource(file: string, options: ReadOptions = {}): string {
  const values = parseAssignments(readOwnerFile(file, options), options)
  const canonical = values.get(CANONICAL_KEY)
  const legacy = values.get(LEGACY_KEY)
  if (canonical && legacy) fail('CONFIG_INVALID')
  if (legacy && !options.allowLegacy) fail('LEGACY_KEY_NOT_ALLOWED')
  return validateToken(canonical || legacy)
}

export function loadWorkbenchOwnerConfig(options: { homeDir?: string; expectedUid?: number } = {}): WorkbenchOwnerConfig {
  const configPath = resolveWorkbenchOwnerConfigPath(options.homeDir)
  return {
    actionToken: readWorkbenchActionTokenSource(configPath, { expectedUid: options.expectedUid }),
    configPath,
    mode: '0600'
  }
}

export function installWorkbenchOwnerConfig(options: {
  actionToken: string
  homeDir?: string
  expectedUid?: number
}): WorkbenchOwnerConfig {
  const actionToken = validateToken(options.actionToken)
  const configPath = resolveWorkbenchOwnerConfigPath(options.homeDir)
  const directory = path.dirname(configPath)
  const owner = expectedOwner(options)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const directoryStat = fs.lstatSync(directory)
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
    || (owner !== undefined && directoryStat.uid !== owner)) {
    fail('CONFIG_UNSAFE')
  }
  fs.chmodSync(directory, 0o700)
  if (fs.existsSync(configPath)) {
    const current = fs.lstatSync(configPath)
    if (!current.isFile() || current.isSymbolicLink()
      || (owner !== undefined && current.uid !== owner)) {
      fail('CONFIG_UNSAFE')
    }
  }
  const temporary = `${configPath}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(temporary, `${CANONICAL_KEY}=${actionToken}\n`, { encoding: 'utf8', mode: 0o600 })
    fs.chmodSync(temporary, 0o600)
    fs.renameSync(temporary, configPath)
    fs.chmodSync(configPath, 0o600)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
  return loadWorkbenchOwnerConfig({ homeDir: options.homeDir, expectedUid: options.expectedUid })
}
