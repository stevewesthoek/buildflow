import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TextDecoder } from 'node:util'

const MAX_TRANSPORT_CONFIG_BYTES = 4 * 1024
const TRANSPORT_KEY = 'WORKBENCH_TRANSPORT'
const TRANSPORT_VALUES = new Set(['typescript_agent', 'native_helper'])

export type WorkbenchTransport = 'typescript_agent' | 'native_helper'
export type WorkbenchTransportConfig = { transport: WorkbenchTransport; configPath: string; mode: '0600' }
export type WorkbenchTransportConfigErrorCode = 'CONFIG_UNSAFE' | 'CONFIG_INVALID'

export class WorkbenchTransportConfigError extends Error {
  constructor(readonly code: WorkbenchTransportConfigErrorCode) {
    super('Workbench owner-local transport configuration is unavailable or invalid.')
  }
}

function fail(code: WorkbenchTransportConfigErrorCode): never { throw new WorkbenchTransportConfigError(code) }

function owner(expectedUid?: number): number | undefined {
  return expectedUid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined)
}

function assertDirectory(directory: string, expectedUid?: number): void {
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (owner(expectedUid) !== undefined && stat.uid !== owner(expectedUid))) fail('CONFIG_UNSAFE')
}

function readFileStrict(file: string, expectedUid?: number): string | undefined {
  if (!path.isAbsolute(file)) fail('CONFIG_UNSAFE')
  let descriptor: number | undefined
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TRANSPORT_CONFIG_BYTES || (stat.mode & 0o077) !== 0 || (owner(expectedUid) !== undefined && stat.uid !== owner(expectedUid))) fail('CONFIG_UNSAFE')
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    const opened = fs.fstatSync(descriptor)
    if (!opened.isFile() || opened.size > MAX_TRANSPORT_CONFIG_BYTES || opened.dev !== stat.dev || opened.ino !== stat.ino) fail('CONFIG_UNSAFE')
    return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(descriptor))
  } catch (error) {
    if (error instanceof WorkbenchTransportConfigError) throw error
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined
    fail('CONFIG_INVALID')
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

function parseTransport(text: string | undefined): WorkbenchTransport {
  if (text === undefined) return 'typescript_agent'
  let value: WorkbenchTransport | undefined
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^WORKBENCH_TRANSPORT=(typescript_agent|native_helper)$/)
    if (!match || value !== undefined) fail('CONFIG_INVALID')
    value = match[1] as WorkbenchTransport
  }
  return value ?? 'typescript_agent'
}

export function resolveWorkbenchTransportConfigPath(homeDir = os.userInfo().homedir): string {
  if (!path.isAbsolute(homeDir)) fail('CONFIG_UNSAFE')
  return path.join(homeDir, '.config', 'workbench', 'transport.env')
}

export function loadWorkbenchTransportConfig(options: { homeDir?: string; expectedUid?: number } = {}): WorkbenchTransportConfig {
  const configPath = resolveWorkbenchTransportConfigPath(options.homeDir)
  const directory = path.dirname(configPath)
  if (fs.existsSync(directory)) assertDirectory(directory, options.expectedUid)
  return { transport: parseTransport(readFileStrict(configPath, options.expectedUid)), configPath, mode: '0600' }
}

export function writeWorkbenchTransportConfig(transport: WorkbenchTransport, options: { homeDir?: string; expectedUid?: number } = {}): WorkbenchTransportConfig {
  if (!TRANSPORT_VALUES.has(transport)) fail('CONFIG_INVALID')
  const configPath = resolveWorkbenchTransportConfigPath(options.homeDir)
  const directory = path.dirname(configPath)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  assertDirectory(directory, options.expectedUid)
  fs.chmodSync(directory, 0o700)
  readFileStrict(configPath, options.expectedUid)
  const temporary = `${configPath}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(temporary, `${TRANSPORT_KEY}=${transport}\n`, { encoding: 'utf8', mode: 0o600 })
    fs.chmodSync(temporary, 0o600)
    fs.renameSync(temporary, configPath)
    fs.chmodSync(configPath, 0o600)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
  return loadWorkbenchTransportConfig(options)
}
