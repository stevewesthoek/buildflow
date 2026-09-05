import crypto from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { WorkbenchEvidenceMetadata } from '@workbench/shared'
import { getConfigDir } from '../utils/paths'
import { appendOrReuseWorkbenchEvidence } from './workbench-evidence-producers'
import type { WorkbenchEvidenceStoreOptions } from './workbench-evidence-store'

export const LOCAL_SERVER_DECLARATION_SCHEMA_VERSION = 1 as const
export const LOCAL_SERVER_LIFECYCLE_SCHEMA_VERSION = 1 as const

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/
const SAFE_ENV_KEY = /^(?:NODE_ENV|HOST|HOSTNAME|PORT|WORKBENCH_SERVER_[A-Z0-9_]{1,64})$/
const SAFE_PACKAGE_SCRIPT = /^[a-z0-9][a-z0-9:_-]{0,79}$/i
const MAX_ARGS = 32
const MAX_ARG_LENGTH = 500
const MAX_ENV_ENTRIES = 12
const MAX_ENV_VALUE_LENGTH = 500
const MAX_OUTPUT_BYTES = 8_000
const MAX_EVIDENCE_BYTES = 8_000
const MIN_PORT = 1_024
const MAX_PORT = 65_535
const MAX_STARTUP_MS = 120_000
const MAX_SHUTDOWN_MS = 60_000
const MAX_RESTARTS = 3
const LOCK_STALE_MS = 15_000
const LOCK_WAIT_MS = 2_000
const RETRY_WAIT_MS = 10

export type LocalServerCommand = {
  executable: 'node' | 'pnpm'
  /** For node this is a repository-relative script; for pnpm it is `run <script>`. */
  args: string[]
}

export type LocalServerPortPolicy =
  | {
      strategy: 'fixed'
      port: number
      onConflict: 'fail' | 'select_next'
      fallbackRange?: { min: number; max: number }
    }
  | {
      strategy: 'range'
      min: number
      max: number
      preferredPort?: number
      onConflict: 'fail' | 'select_next'
    }

export type LocalServerReadiness =
  | { kind: 'process' }
  | { kind: 'tcp'; host: '127.0.0.1' }
  | { kind: 'http'; path: string; expectedStatus?: number }
  | { kind: 'stdout'; matcher: string }

export type LocalServerDeclaration = {
  schemaVersion: typeof LOCAL_SERVER_DECLARATION_SCHEMA_VERSION
  serverId: string
  cwd: string
  command: LocalServerCommand
  port: LocalServerPortPolicy
  readiness: LocalServerReadiness
  networkScope: 'loopback' | 'external'
  budgets: {
    startupMs: number
    shutdownMs: number
    maxRestarts: number
  }
  environment?: Record<string, string>
}

export type LocalServerLifecycleStatus = 'STARTING' | 'READY' | 'CRASHED' | 'RECOVERING' | 'STOPPING' | 'STOPPED' | 'FAILED'

export type LocalServerLifecycleMetrics = {
  requestToReadyMs?: number
  startupMs?: number
  warmReuseMs?: number
  pollingCycles: number
  retryWaits: number
  fixedSleepCount: number
  starts: number
  modelDecisions: number
  prompts: number
  shutdownPolls: number
  recoveryCount: number
}

export type LocalServerLifecycleRecord = {
  schemaVersion: typeof LOCAL_SERVER_LIFECYCLE_SCHEMA_VERSION
  identity: string
  declarationDigest: string
  serverId: string
  sourceId: string
  sourceRoot: string
  runId: string
  sessionId?: string
  taskId?: string
  packetId?: string
  budgets: LocalServerDeclaration['budgets']
  status: LocalServerLifecycleStatus
  pid?: number
  processGroupId?: number
  processStartIdentity?: string
  commandMarker: string
  port: number
  createdAt: string
  startedAt?: string
  readyAt?: string
  crashedAt?: string
  stoppedAt?: string
  failureReason?: string
  lastExitCode?: number | null
  lastSignal?: NodeJS.Signals | null
  restartCount: number
  stdoutTail: string
  stderrTail: string
  readinessProbes: number
  evidenceRefs: WorkbenchEvidenceMetadata[]
  metrics: LocalServerLifecycleMetrics
}

export type LocalServerLifecycleEvent = {
  phase: 'started' | 'reused' | 'ready' | 'crashed' | 'recovered' | 'stopped' | 'failed'
  record: LocalServerLifecycleRecord
  evidenceRefs: WorkbenchEvidenceMetadata[]
}

export type LocalServerLifecycleOptions = {
  stateDir?: string
  evidenceStore?: WorkbenchEvidenceStoreOptions
  now?: () => Date
  onEvent?: (event: LocalServerLifecycleEvent) => void
}

export type LocalServerLifecycleFailureCode =
  | 'DECLARATION_INVALID'
  | 'SOURCE_ROOT_INVALID'
  | 'STATE_CORRUPT'
  | 'LIFECYCLE_BUSY'
  | 'SERVER_OWNED_BY_OTHER_RUN'
  | 'PORT_CONFLICT'
  | 'PORT_POLICY_EXHAUSTED'
  | 'SERVER_ENTRYPOINT_INVALID'
  | 'SERVER_ENTRYPOINT_NOT_FOUND'
  | 'NETWORK_SCOPE_BLOCKED'
  | 'READINESS_TIMEOUT'
  | 'PROCESS_EXITED_BEFORE_READY'
  | 'PROCESS_IDENTITY_MISMATCH'
  | 'RECOVERY_EXHAUSTED'
  | 'SHUTDOWN_TIMEOUT'
  | 'SHUTDOWN_IDENTITY_MISMATCH'
  | 'SERVER_NOT_FOUND'

export type LocalServerLifecycleFailure = {
  ok: false
  code: LocalServerLifecycleFailureCode
  message: string
  record?: LocalServerLifecycleRecord
}

export type LocalServerHandle = {
  readonly identity: string
  readonly pid?: number
  status(): LocalServerLifecycleRecord | undefined
  stop(reason?: string): Promise<LocalServerStopResult>
}

export type LocalServerStartResult =
  | {
      ok: true
      handle: LocalServerHandle
      record: LocalServerLifecycleRecord
      reused: boolean
      recovered: boolean
    }
  | LocalServerLifecycleFailure

export type LocalServerStopResult =
  | { ok: true; alreadyStopped: boolean; record: LocalServerLifecycleRecord }
  | LocalServerLifecycleFailure

export type LocalServerReconciliationResult =
  | { ok: true; status: 'missing' | 'stopped' | 'live' | 'stale'; record?: LocalServerLifecycleRecord; reason?: string }
  | LocalServerLifecycleFailure

type Owner = {
  sourceId: string
  runId: string
  sessionId?: string
  taskId?: string
  packetId?: string
}

type StartParams = Owner & {
  sourceRoot: string
  declaration: LocalServerDeclaration
  allowRecovery?: boolean
}

type RuntimeHandle = {
  child?: ChildProcess
  output: string
  errorOutput: string
}

const activeHandles = new Map<string, RuntimeHandle>()

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(object[key])}`).join(',')}}`
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(stableSerialize(value), 'utf8').digest('hex')
}

function compact(value: string, limit: number): string {
  const text = String(value || '')
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 3))}...` : text
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value)
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys)
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('declaration contains an undeclared field')
}

function port(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < MIN_PORT || Number(value) > MAX_PORT) throw new Error(`${label} must be an integer between ${MIN_PORT} and ${MAX_PORT}`)
  return Number(value)
}

function normalizeRange(value: unknown, label: string): { min: number; max: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an explicit port range`)
  const item = value as Record<string, unknown>
  onlyKeys(item, ['min', 'max'])
  const min = port(item.min, `${label}.min`)
  const max = port(item.max, `${label}.max`)
  if (min > max) throw new Error(`${label} min must not exceed max`)
  if (max - min > 128) throw new Error(`${label} is outside the bounded candidate range`)
  return { min, max }
}

function normalizeCommand(value: unknown): LocalServerCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('command is required')
  const item = value as Record<string, unknown>
  onlyKeys(item, ['executable', 'args'])
  if (item.executable !== 'node' && item.executable !== 'pnpm') throw new Error('command executable must be node or pnpm')
  if (!Array.isArray(item.args) || item.args.length < 1 || item.args.length > MAX_ARGS) throw new Error(`command args must contain 1-${MAX_ARGS} values`)
  const args = item.args.map((raw, index) => {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_ARG_LENGTH) throw new Error(`command arg ${index} is invalid`)
    if (/\0|[\r\n]|;|&&|\|\||\||>|<|`|\$\(/.test(raw)) throw new Error(`command arg ${index} contains shell syntax`)
    if (raw.startsWith('/') || raw.startsWith('~') || raw.split('/').includes('..')) {
      if (index === 0 && item.executable === 'node') throw new Error('node entrypoint must be repository-relative')
      if (raw.startsWith('/') || raw.startsWith('~')) throw new Error(`command arg ${index} contains an absolute path`)
    }
    return raw
  })
  if (item.executable === 'node') {
    if (args[0]!.startsWith('-') || args[0] === '${PORT}' || args[0] === '${HOST}') throw new Error('node command must begin with a repository-relative script')
  } else if (args[0] !== 'run' || !args[1] || !SAFE_PACKAGE_SCRIPT.test(args[1])) {
    throw new Error('pnpm command must be the bounded form `run <script>`')
  }
  return { executable: item.executable, args }
}

function normalizePortPolicy(value: unknown): LocalServerPortPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('port policy is required')
  const item = value as Record<string, unknown>
  if (item.strategy === 'fixed') {
    onlyKeys(item, ['strategy', 'port', 'onConflict', 'fallbackRange'])
    if (item.onConflict !== 'fail' && item.onConflict !== 'select_next') throw new Error('fixed port onConflict is invalid')
    const fixed = port(item.port, 'port')
    const fallbackRange = item.fallbackRange === undefined ? undefined : normalizeRange(item.fallbackRange, 'fallbackRange')
    if (item.onConflict === 'select_next' && !fallbackRange) throw new Error('select_next fixed port policy requires fallbackRange')
    if (fallbackRange && (fixed < fallbackRange.min || fixed > fallbackRange.max)) throw new Error('fixed port must be inside fallbackRange')
    return { strategy: 'fixed', port: fixed, onConflict: item.onConflict, ...(fallbackRange ? { fallbackRange } : {}) }
  }
  if (item.strategy === 'range') {
    onlyKeys(item, ['strategy', 'min', 'max', 'preferredPort', 'onConflict'])
    if (item.onConflict !== 'fail' && item.onConflict !== 'select_next') throw new Error('range port onConflict is invalid')
    const range = normalizeRange({ min: item.min, max: item.max }, 'port')
    const preferredPort = item.preferredPort === undefined ? undefined : port(item.preferredPort, 'preferredPort')
    if (preferredPort !== undefined && (preferredPort < range.min || preferredPort > range.max)) throw new Error('preferredPort must be inside the declared range')
    return { strategy: 'range', ...range, ...(preferredPort === undefined ? {} : { preferredPort }), onConflict: item.onConflict }
  }
  throw new Error('port strategy must be fixed or range')
}

function normalizeReadiness(value: unknown): LocalServerReadiness {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('readiness is required')
  const item = value as Record<string, unknown>
  if (item.kind === 'process') {
    onlyKeys(item, ['kind'])
    return { kind: 'process' }
  }
  if (item.kind === 'tcp') {
    onlyKeys(item, ['kind', 'host'])
    if (item.host !== '127.0.0.1') throw new Error('tcp readiness must use loopback')
    return { kind: 'tcp', host: '127.0.0.1' }
  }
  if (item.kind === 'http') {
    onlyKeys(item, ['kind', 'path', 'expectedStatus'])
    if (typeof item.path !== 'string' || !/^\/[A-Za-z0-9._~:/?&=-]{0,190}$/.test(item.path)) throw new Error('http readiness path is invalid')
    if (item.expectedStatus !== undefined && (!Number.isInteger(item.expectedStatus) || Number(item.expectedStatus) < 100 || Number(item.expectedStatus) > 599)) throw new Error('http expectedStatus is invalid')
    return { kind: 'http', path: item.path, ...(item.expectedStatus === undefined ? {} : { expectedStatus: Number(item.expectedStatus) }) }
  }
  if (item.kind === 'stdout') {
    onlyKeys(item, ['kind', 'matcher'])
    if (typeof item.matcher !== 'string' || item.matcher.length < 1 || item.matcher.length > 200 || /[\r\n]/.test(item.matcher)) throw new Error('stdout readiness matcher is invalid')
    return { kind: 'stdout', matcher: item.matcher }
  }
  throw new Error('readiness kind is invalid')
}

export function normalizeLocalServerDeclaration(value: unknown): LocalServerDeclaration {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('local server declaration is required')
    const item = value as Record<string, unknown>
    onlyKeys(item, ['schemaVersion', 'serverId', 'cwd', 'command', 'port', 'readiness', 'networkScope', 'budgets', 'environment'])
    if (item.schemaVersion !== LOCAL_SERVER_DECLARATION_SCHEMA_VERSION) throw new Error(`schemaVersion must be ${LOCAL_SERVER_DECLARATION_SCHEMA_VERSION}`)
    if (!validId(item.serverId) || item.serverId.length > 80) throw new Error('serverId is invalid')
    if (typeof item.cwd !== 'string' || item.cwd.length > 500 || item.cwd.startsWith('/') || item.cwd.startsWith('~') || item.cwd.split('/').includes('..')) throw new Error('cwd must be repository-relative')
    const cwd = item.cwd.replace(/\\/g, '/').replace(/^\.\//, '') || '.'
    const command = normalizeCommand(item.command)
    const portPolicy = normalizePortPolicy(item.port)
    const readiness = normalizeReadiness(item.readiness)
    if (item.networkScope !== 'loopback' && item.networkScope !== 'external') throw new Error('networkScope must be loopback or external')
    if (!item.budgets || typeof item.budgets !== 'object' || Array.isArray(item.budgets)) throw new Error('budgets are required')
    const budgets = item.budgets as Record<string, unknown>
    onlyKeys(budgets, ['startupMs', 'shutdownMs', 'maxRestarts'])
    if (!Number.isInteger(budgets.startupMs) || Number(budgets.startupMs) < 1_000 || Number(budgets.startupMs) > MAX_STARTUP_MS) throw new Error(`startupMs must be 1000-${MAX_STARTUP_MS}`)
    if (!Number.isInteger(budgets.shutdownMs) || Number(budgets.shutdownMs) < 1_000 || Number(budgets.shutdownMs) > MAX_SHUTDOWN_MS) throw new Error(`shutdownMs must be 1000-${MAX_SHUTDOWN_MS}`)
    if (!Number.isInteger(budgets.maxRestarts) || Number(budgets.maxRestarts) < 0 || Number(budgets.maxRestarts) > MAX_RESTARTS) throw new Error(`maxRestarts must be 0-${MAX_RESTARTS}`)
    let environment: Record<string, string> | undefined
    if (item.environment !== undefined) {
      if (!item.environment || typeof item.environment !== 'object' || Array.isArray(item.environment)) throw new Error('environment must be a bounded object')
      const entries = Object.entries(item.environment)
      if (entries.length > MAX_ENV_ENTRIES) throw new Error('environment contains too many entries')
      environment = {}
      for (const [key, raw] of entries.sort(([left], [right]) => left.localeCompare(right))) {
        if (!SAFE_ENV_KEY.test(key) || key === 'PORT' || key === 'HOST' || key === 'HOSTNAME' || /(?:TOKEN|SECRET|PASSWORD|PRIVATE|CREDENTIAL|API[_-]?KEY)/i.test(key)) throw new Error(`environment key ${key} is not allowlisted`)
        if (typeof raw !== 'string' || raw.length > MAX_ENV_VALUE_LENGTH || /\0|[\r\n]/.test(raw)) throw new Error(`environment value ${key} is invalid`)
        environment[key] = raw
      }
    }
    return {
      schemaVersion: LOCAL_SERVER_DECLARATION_SCHEMA_VERSION,
      serverId: item.serverId,
      cwd,
      command,
      port: portPolicy,
      readiness,
      networkScope: item.networkScope,
      budgets: { startupMs: Number(budgets.startupMs), shutdownMs: Number(budgets.shutdownMs), maxRestarts: Number(budgets.maxRestarts) },
      ...(environment && Object.keys(environment).length > 0 ? { environment } : {})
    }
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error))
  }
}

export function localServerDeclarationDigest(declaration: LocalServerDeclaration): string {
  return digest(normalizeLocalServerDeclaration(declaration))
}

function rootFor(sourceRoot: string): string | LocalServerLifecycleFailure {
  try {
    const resolved = path.resolve(sourceRoot)
    const real = fs.realpathSync(resolved)
    if (!fs.statSync(real).isDirectory()) throw new Error('source root is not a directory')
    return real
  } catch {
    return { ok: false, code: 'SOURCE_ROOT_INVALID', message: 'Local server source root is unavailable or not a directory.' }
  }
}

function stateDirectory(options: LocalServerLifecycleOptions): string {
  return path.resolve(options.stateDir || path.join(getConfigDir(), 'local-server-lifecycle'))
}

function statePath(root: string, declaration: LocalServerDeclaration, options: LocalServerLifecycleOptions): string {
  const key = digest({ root, serverId: declaration.serverId, declaration: normalizeLocalServerDeclaration(declaration) })
  return path.join(stateDirectory(options), `${key}.json`)
}

function lockPath(state: string): string {
  return `${state}.lock`
}

function timestamp(options: LocalServerLifecycleOptions): string {
  return (options.now?.() || new Date()).toISOString()
}

function writeRecord(target: string, record: LocalServerLifecycleRecord): void {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(record), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  fs.renameSync(temporary, target)
  try { fs.chmodSync(target, 0o600) } catch { /* best effort on non-POSIX hosts */ }
}

function readRecord(target: string): LocalServerLifecycleRecord | undefined | LocalServerLifecycleFailure {
  if (!fs.existsSync(target)) return undefined
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as Partial<LocalServerLifecycleRecord>
    if (parsed.schemaVersion !== LOCAL_SERVER_LIFECYCLE_SCHEMA_VERSION || typeof parsed.identity !== 'string' || typeof parsed.sourceRoot !== 'string' || typeof parsed.serverId !== 'string' || typeof parsed.status !== 'string' || typeof parsed.port !== 'number' || typeof parsed.commandMarker !== 'string' || !Array.isArray(parsed.evidenceRefs) || !parsed.metrics || typeof parsed.metrics.pollingCycles !== 'number') throw new Error('state schema is unsupported')
    return parsed as LocalServerLifecycleRecord
  } catch {
    return { ok: false, code: 'STATE_CORRUPT', message: 'Local server lifecycle state is corrupt and requires explicit recovery.' }
  }
}

function isFailure(value: unknown): value is LocalServerLifecycleFailure {
  return Boolean(value && typeof value === 'object' && (value as { ok?: unknown }).ok === false)
}

async function withLock<T>(target: string, callback: () => T | Promise<T>): Promise<T | LocalServerLifecycleFailure> {
  const lock = lockPath(target)
  const deadline = Date.now() + LOCK_WAIT_MS
  let descriptor: number | undefined
  while (Date.now() <= deadline) {
    try {
      fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 })
      descriptor = fs.openSync(lock, 'wx', 0o600)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return { ok: false, code: 'LIFECYCLE_BUSY', message: 'Local server lifecycle lock could not be acquired.' }
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { force: true })
      } catch { /* retain unknown lock */ }
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  }
  if (descriptor === undefined) return { ok: false, code: 'LIFECYCLE_BUSY', message: 'Local server lifecycle lock remained busy.' }
  try {
    return await callback()
  } finally {
    try { fs.closeSync(descriptor) } catch { /* best effort */ }
    try { fs.rmSync(lock, { force: true }) } catch { /* preserve unknown lock state */ }
  }
}

function processStartIdentity(pid: number): string | undefined {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 1_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined
  } catch {
    return undefined
  }
}

function processGroupId(pid: number): number | undefined {
  try {
    const value = execFileSync('ps', ['-p', String(pid), '-o', 'pgid='], { encoding: 'utf8', timeout: 1_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
  } catch {
    return undefined
  }
}

function processCommand(pid: number): string | undefined {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 1_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined
  } catch {
    return undefined
  }
}

function processState(pid: number): string | undefined {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8', timeout: 1_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined
  } catch {
    return undefined
  }
}

function processCwd(pid: number): string | undefined {
  if (process.platform !== 'win32') {
    const procCwd = `/proc/${pid}/cwd`
    try { if (fs.existsSync(procCwd)) return fs.realpathSync(procCwd) } catch { /* try lsof on macOS */ }
    try {
      const output = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 1_000, stdio: ['ignore', 'pipe', 'ignore'] })
      const line = output.split(/\r?\n/).find(value => value.startsWith('n'))
      return line ? fs.realpathSync(line.slice(1)) : undefined
    } catch { /* best effort; PID/start/process-group/command still bind ownership */ }
  }
  return undefined
}

function observe(record: LocalServerLifecycleRecord): { live: boolean; reason?: string; ambiguous?: boolean } {
  if (!record.pid || !Number.isInteger(record.pid) || record.pid <= 0) return { live: false, reason: 'pid_missing' }
  try { process.kill(record.pid, 0) } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
      ? { live: false, reason: 'permission_denied', ambiguous: true }
      : { live: false, reason: 'process_missing' }
  }
  const startIdentity = processStartIdentity(record.pid)
  const state = processState(record.pid)
  if (!state || /^Z/.test(state)) return { live: false, reason: 'process_missing' }
  if (!record.processStartIdentity || !startIdentity) return { live: false, reason: 'process_identity_unavailable', ambiguous: true }
  if (record.processStartIdentity !== startIdentity) return { live: false, reason: 'pid_reused' }
  const group = processGroupId(record.pid)
  if (!record.processGroupId || !group) return { live: false, reason: 'process_group_unavailable', ambiguous: true }
  if (record.processGroupId !== group) return { live: false, reason: 'process_group_mismatch' }
  const command = processCommand(record.pid)
  if (!command) return { live: false, reason: 'process_missing' }
  if (command && record.commandMarker && !command.includes(record.commandMarker)) return { live: false, reason: 'command_mismatch' }
  const cwd = processCwd(record.pid)
  if (cwd && cwd !== record.sourceRoot && !cwd.startsWith(`${record.sourceRoot}${path.sep}`)) return { live: false, reason: 'cwd_mismatch' }
  return { live: true }
}

function appendOutput(current: string, chunk: unknown): string {
  const next = `${current}${Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)}`
  return next.length > MAX_OUTPUT_BYTES ? next.slice(-MAX_OUTPUT_BYTES) : next
}

function candidatePorts(policy: LocalServerPortPolicy): number[] {
  if (policy.strategy === 'fixed') {
    if (policy.onConflict === 'fail') return [policy.port]
    const range = policy.fallbackRange!
    return [policy.port, ...Array.from({ length: range.max - range.min + 1 }, (_, index) => range.min + index).filter(value => value !== policy.port)]
  }
  const first = policy.preferredPort === undefined ? policy.min : policy.preferredPort
  return [first, ...Array.from({ length: policy.max - policy.min + 1 }, (_, index) => policy.min + index).filter(value => value !== first)]
}

async function portAvailable(portNumber: number): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const server = net.createServer()
    server.once('error', error => {
      server.close()
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') resolve(false)
      else reject(error)
    })
    server.listen({ host: '127.0.0.1', port: portNumber }, () => server.close(() => resolve(true)))
  })
}

function commandResolution(root: string, declaration: LocalServerDeclaration): { executable: string; args: string[]; marker: string; cwd: string } | LocalServerLifecycleFailure {
  const cwd = path.resolve(root, declaration.cwd)
  if (cwd !== root && !cwd.startsWith(`${root}${path.sep}`)) return { ok: false, code: 'SERVER_ENTRYPOINT_INVALID', message: 'Server cwd escaped the source root.' }
  let realCwd: string
  try { realCwd = fs.realpathSync(cwd) } catch { return { ok: false, code: 'SERVER_ENTRYPOINT_NOT_FOUND', message: `Server cwd does not exist: ${declaration.cwd}` } }
  if (declaration.command.executable === 'node') {
    const script = path.resolve(realCwd, declaration.command.args[0]!)
    if (script !== root && !script.startsWith(`${root}${path.sep}`)) return { ok: false, code: 'SERVER_ENTRYPOINT_INVALID', message: 'Server entrypoint escaped the source root.' }
    let realScript: string
    try { realScript = fs.realpathSync(script) } catch { return { ok: false, code: 'SERVER_ENTRYPOINT_NOT_FOUND', message: `Server entrypoint does not exist: ${declaration.command.args[0]}` } }
    if (!fs.statSync(realScript).isFile()) return { ok: false, code: 'SERVER_ENTRYPOINT_INVALID', message: 'Server entrypoint is not a regular file.' }
    return { executable: process.execPath, args: [realScript, ...declaration.command.args.slice(1)], marker: realScript, cwd: realCwd }
  }
  const pathEntries = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  const pnpm = pathEntries.map(entry => path.join(entry, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')).find(candidate => fs.existsSync(candidate))
  if (!pnpm) return { ok: false, code: 'SERVER_ENTRYPOINT_NOT_FOUND', message: 'Allowlisted pnpm executable could not be resolved.' }
  return { executable: pnpm, args: declaration.command.args, marker: `pnpm run ${declaration.command.args[1]}`, cwd: realCwd }
}

function initialRecord(params: StartParams, root: string, identity: string, declarationDigest: string, portNumber: number, marker: string, recovered: boolean, now: string): LocalServerLifecycleRecord {
  return {
    schemaVersion: LOCAL_SERVER_LIFECYCLE_SCHEMA_VERSION,
    identity,
    declarationDigest,
    serverId: params.declaration.serverId,
    sourceId: params.sourceId,
    sourceRoot: root,
    runId: params.runId,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.taskId ? { taskId: params.taskId } : {}),
    ...(params.packetId ? { packetId: params.packetId } : {}),
    budgets: params.declaration.budgets,
    status: recovered ? 'RECOVERING' : 'STARTING',
    commandMarker: marker,
    port: portNumber,
    createdAt: now,
    startedAt: now,
    restartCount: recovered ? 1 : 0,
    stdoutTail: '',
    stderrTail: '',
    readinessProbes: 0,
    evidenceRefs: [],
    metrics: {
      pollingCycles: 0,
      retryWaits: 0,
      fixedSleepCount: 0,
      starts: 1,
      modelDecisions: 0,
      prompts: 0,
      shutdownPolls: 0,
      recoveryCount: recovered ? 1 : 0
    }
  }
}

function evidenceOwner(record: LocalServerLifecycleRecord, phase: string): { sourceId: string; sessionId?: string; runId: string; taskId?: string; packetId?: string; operationId: string } {
  return {
    sourceId: record.sourceId,
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    runId: record.runId,
    ...(record.taskId ? { taskId: record.taskId } : {}),
    ...(record.packetId ? { packetId: record.packetId } : {}),
    operationId: `local-server:${record.identity.slice(0, 32)}:${phase}:${record.status}:${record.readinessProbes}`
  }
}

function emit(record: LocalServerLifecycleRecord, phase: LocalServerLifecycleEvent['phase'], options: LocalServerLifecycleOptions, reason?: string): LocalServerLifecycleRecord {
  const content = compact(JSON.stringify({
    serverId: record.serverId,
    status: record.status,
    phase,
    port: record.port,
    pid: record.pid,
    processGroupId: record.processGroupId,
    restartCount: record.restartCount,
    readinessProbes: record.readinessProbes,
    reason,
    stdoutTail: record.stdoutTail,
    stderrTail: record.stderrTail,
    metrics: record.metrics
  }), MAX_EVIDENCE_BYTES)
  const attached = appendOrReuseWorkbenchEvidence({
    kind: 'capability_result',
    owner: evidenceOwner(record, phase),
    content,
    retentionClass: 'active_run'
  }, options.evidenceStore)
  const refs = attached.ok === true ? [attached.metadata] : []
  const next = refs.length > 0
    ? { ...record, evidenceRefs: [...record.evidenceRefs, ...refs.filter(ref => !record.evidenceRefs.some(existing => existing.evidenceId === ref.evidenceId))].slice(-24) }
    : record
  options.onEvent?.({ phase, record: next, evidenceRefs: refs })
  return next
}

function runtimeFor(state: string): RuntimeHandle {
  const existing = activeHandles.get(state)
  if (existing) return existing
  const runtime = { output: '', errorOutput: '' }
  activeHandles.set(state, runtime)
  return runtime
}

function handleFor(state: string, record: LocalServerLifecycleRecord, options: LocalServerLifecycleOptions): LocalServerHandle {
  return {
    identity: record.identity,
    pid: record.pid,
    status: () => {
      const current = readRecord(state)
      return !current || isFailure(current) ? undefined : current
    },
    stop: reason => stopLocalServer({ statePath: state, identity: record.identity, options, reason })
  }
}

function failure(code: LocalServerLifecycleFailureCode, message: string, record?: LocalServerLifecycleRecord): LocalServerLifecycleFailure {
  return { ok: false, code, message, ...(record ? { record } : {}) }
}

function markFailed(state: string, record: LocalServerLifecycleRecord, options: LocalServerLifecycleOptions, reason: string): LocalServerLifecycleRecord {
  const next = emit({ ...record, status: 'FAILED', failureReason: compact(reason, 500), stoppedAt: timestamp(options) }, 'failed', options, reason)
  writeRecord(state, next)
  return next
}

function attachChild(state: string, record: LocalServerLifecycleRecord, child: ChildProcess, runtime: RuntimeHandle, options: LocalServerLifecycleOptions): LocalServerLifecycleRecord {
  runtime.child = child
  const pid = child.pid!
  const next: LocalServerLifecycleRecord = {
    ...record,
    pid,
    processGroupId: processGroupId(pid) || pid,
    processStartIdentity: processStartIdentity(pid)
  }
  writeRecord(state, next)
  child.stdout?.on('data', chunk => {
    runtime.output = appendOutput(runtime.output, chunk)
    const current = readRecord(state)
    if (!current || isFailure(current)) return
    const updated = { ...current, stdoutTail: appendOutput(current.stdoutTail, chunk) }
    writeRecord(state, updated)
  })
  child.stderr?.on('data', chunk => {
    runtime.errorOutput = appendOutput(runtime.errorOutput, chunk)
    const current = readRecord(state)
    if (!current || isFailure(current)) return
    writeRecord(state, { ...current, stderrTail: appendOutput(current.stderrTail, chunk) })
  })
  child.once('error', error => {
    const current = readRecord(state)
    if (!current || isFailure(current) || current.pid !== pid || current.status === 'STOPPING' || current.status === 'STOPPED') return
    markFailed(state, current, options, error instanceof Error ? error.message : String(error))
  })
  child.once('exit', (exitCode, signal) => {
    const current = readRecord(state)
    if (!current || isFailure(current) || current.pid !== pid || current.status === 'STOPPING' || current.status === 'STOPPED') return
    const crashed = current.readyAt !== undefined
    const nextRecord = emit({ ...current, status: crashed ? 'CRASHED' : 'FAILED', crashedAt: crashed ? timestamp(options) : current.crashedAt, failureReason: crashed ? 'Owned server process exited after readiness.' : 'Owned server process exited before readiness.', lastExitCode: exitCode, lastSignal: signal }, crashed ? 'crashed' : 'failed', options, crashed ? 'process_exit_after_ready' : 'process_exit_before_ready')
    writeRecord(state, nextRecord)
  })
  return next
}

async function choosePort(policy: LocalServerPortPolicy): Promise<number | LocalServerLifecycleFailure> {
  for (const candidate of candidatePorts(policy)) {
    if (await portAvailable(candidate)) return candidate
  }
  return policy.strategy === 'fixed' ? failure('PORT_CONFLICT', `Port ${policy.port} is already in use and the declaration forbids an alternate port.`) : failure('PORT_POLICY_EXHAUSTED', 'No authorized port in the declared range is available.')
}

function spawnEnvironment(declaration: LocalServerDeclaration, portNumber: number): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || os.homedir(),
    CI: '1',
    NO_COLOR: '1',
    HOST: '127.0.0.1',
    HOSTNAME: '127.0.0.1',
    PORT: String(portNumber),
    WORKBENCH_SERVER_ID: declaration.serverId
  }
  for (const [key, value] of Object.entries(declaration.environment || {})) environment[key] = value
  return environment
}

async function probeReadiness(record: LocalServerLifecycleRecord, declaration: LocalServerDeclaration, runtime: RuntimeHandle): Promise<{ ready: boolean; reason?: string }> {
  if (!record.pid) return { ready: false, reason: 'pid_missing' }
  const ownership = observe(record)
  if (!ownership.live) return { ready: false, reason: ownership.reason || 'process_missing' }
  const readiness = declaration.readiness
  if (readiness.kind === 'process') return { ready: true }
  if (readiness.kind === 'stdout') return (runtime.output || record.stdoutTail).includes(readiness.matcher) ? { ready: true } : { ready: false, reason: 'stdout_matcher_not_seen' }
  if (readiness.kind === 'tcp') {
    return await new Promise(resolve => {
      const socket = net.createConnection({ host: readiness.host, port: record.port })
      const finish = (ready: boolean) => { socket.destroy(); resolve(ready ? { ready: true } : { ready: false, reason: 'tcp_not_ready' }) }
      socket.once('connect', () => finish(true))
      socket.once('error', () => finish(false))
      socket.setTimeout(250, () => finish(false))
    })
  }
  const httpReadiness = readiness
  return await new Promise(resolve => {
    const request = http.request({ host: '127.0.0.1', port: record.port, path: httpReadiness.path, method: 'GET', timeout: 250 }, response => {
      const expected = httpReadiness.expectedStatus || 200
      response.resume()
      response.once('end', () => resolve(response.statusCode === expected ? { ready: true } : { ready: false, reason: `http_status_${response.statusCode || 'unknown'}` }))
    })
    request.once('error', () => resolve({ ready: false, reason: 'http_not_ready' }))
    request.once('timeout', () => { request.destroy(); resolve({ ready: false, reason: 'http_timeout' }) })
    request.end()
  })
}

async function waitForReady(state: string, record: LocalServerLifecycleRecord, declaration: LocalServerDeclaration, runtime: RuntimeHandle, options: LocalServerLifecycleOptions, startedAtMs: number, reused: boolean): Promise<{ ok: true; record: LocalServerLifecycleRecord } | LocalServerLifecycleFailure> {
  const deadline = startedAtMs + declaration.budgets.startupMs
  let current = record
  while (Date.now() <= deadline) {
    const result = await probeReadiness(current, declaration, runtime)
    const observedRecord = readRecord(state)
    if (!observedRecord || isFailure(observedRecord)) return failure('STATE_CORRUPT', 'Local server state disappeared during readiness.')
    current = observedRecord
    current = { ...current, readinessProbes: current.readinessProbes + 1, metrics: { ...current.metrics, pollingCycles: current.metrics.pollingCycles + 1 } }
    writeRecord(state, current)
    if (result.ready) {
      const readyAt = timestamp(options)
      current = emit({ ...current, status: 'READY', readyAt, metrics: { ...current.metrics, ...(reused ? { warmReuseMs: Math.max(0, Date.now() - startedAtMs) } : { startupMs: Math.max(0, Date.now() - startedAtMs), requestToReadyMs: Math.max(0, Date.now() - startedAtMs) }) } }, reused ? 'reused' : current.restartCount > 0 ? 'recovered' : 'ready', options)
      writeRecord(state, current)
      return { ok: true, record: current }
    }
    const latest = readRecord(state)
    if (!latest || isFailure(latest)) return failure('STATE_CORRUPT', 'Local server state disappeared during readiness.')
    current = latest
    if (current.status === 'CRASHED' || current.status === 'FAILED') {
      return failure('PROCESS_EXITED_BEFORE_READY', `Server process exited before readiness (${result.reason || 'unknown'}).`, current)
    }
    if (Date.now() >= deadline) break
    current = { ...current, metrics: { ...current.metrics, retryWaits: current.metrics.retryWaits + 1 } }
    writeRecord(state, current)
    await new Promise<void>(resolve => setTimeout(resolve, RETRY_WAIT_MS))
  }
  return failure('READINESS_TIMEOUT', `Server did not produce ${declaration.readiness.kind} readiness within ${declaration.budgets.startupMs}ms.`, current)
}

async function stopLocalServerUnlocked(params: { statePath: string; identity: string; options: LocalServerLifecycleOptions; reason?: string }): Promise<LocalServerStopResult> {
  const currentResult = readRecord(params.statePath)
  if (!currentResult) return failure('SERVER_NOT_FOUND', 'Local server lifecycle state was not found.')
  if (isFailure(currentResult)) return currentResult
  let current = currentResult
  if (current.identity !== params.identity) return failure('SHUTDOWN_IDENTITY_MISMATCH', 'Local server identity does not match the requested shutdown.', current)
  if (current.status === 'STOPPED') return { ok: true, alreadyStopped: true, record: current }
  if (current.pid) {
    const ownership = observe(current)
    if (!ownership.live && ['pid_reused', 'process_group_mismatch', 'command_mismatch', 'cwd_mismatch', 'permission_denied', 'process_identity_unavailable', 'process_group_unavailable'].includes(ownership.reason || '')) return failure('SHUTDOWN_IDENTITY_MISMATCH', `Shutdown refused: ${ownership.reason}.`, current)
    if (ownership.ambiguous) return failure('SHUTDOWN_IDENTITY_MISMATCH', `Shutdown refused: ${ownership.reason || 'process ownership is ambiguous'}.`, current)
    if (ownership.live) {
      current = { ...current, status: 'STOPPING' }
      writeRecord(params.statePath, current)
      const signal = (kind: NodeJS.Signals) => {
        if (!current.pid) return
        try { process.kill(-(current.processGroupId || current.pid), kind) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            try { process.kill(current.pid, kind) } catch { /* report through exit wait */ }
          }
        }
      }
      signal('SIGTERM')
      const shutdownDeadline = Date.now() + Math.max(1_000, Math.min(MAX_SHUTDOWN_MS, current.budgets.shutdownMs))
      let exited = false
      while (Date.now() <= shutdownDeadline) {
        const observed = observe(current)
        const observedRecord = readRecord(params.statePath)
        if (!observedRecord || isFailure(observedRecord)) return failure('STATE_CORRUPT', 'Local server state disappeared during shutdown.')
        current = observedRecord
        current = { ...current, metrics: { ...current.metrics, shutdownPolls: current.metrics.shutdownPolls + 1 } }
        writeRecord(params.statePath, current)
        if (!observed.live) { exited = true; break }
        await new Promise<void>(resolve => setTimeout(resolve, 25))
      }
      if (!exited) {
        signal('SIGKILL')
        const killDeadline = Date.now() + 1_000
        while (Date.now() <= killDeadline) {
          const observed = observe(current)
          const observedRecord = readRecord(params.statePath)
          if (!observedRecord || isFailure(observedRecord)) return failure('STATE_CORRUPT', 'Local server state disappeared during shutdown.')
          current = observedRecord
          current = { ...current, metrics: { ...current.metrics, shutdownPolls: current.metrics.shutdownPolls + 1 } }
          writeRecord(params.statePath, current)
          if (!observed.live) { exited = true; break }
          await new Promise<void>(resolve => setTimeout(resolve, 25))
        }
      }
      if (!exited) return failure('SHUTDOWN_TIMEOUT', 'Owned server process remained alive after graceful shutdown and one escalation.', current)
    }
  }
  current = emit({ ...current, status: 'STOPPED', stoppedAt: timestamp(params.options), failureReason: params.reason ? compact(params.reason, 500) : current.failureReason }, 'stopped', params.options, params.reason)
  writeRecord(params.statePath, current)
  activeHandles.delete(params.statePath)
  return { ok: true, alreadyStopped: false, record: current }
}

async function stopLocalServer(params: { statePath: string; identity: string; options: LocalServerLifecycleOptions; reason?: string }): Promise<LocalServerStopResult> {
  const result = await withLock(params.statePath, () => stopLocalServerUnlocked(params))
  return result as LocalServerStopResult
}

export async function reconcileLocalServer(params: { sourceRoot: string; declaration: LocalServerDeclaration } & Partial<Owner>, options: LocalServerLifecycleOptions = {}): Promise<LocalServerReconciliationResult> {
  const root = rootFor(params.sourceRoot)
  if (typeof root !== 'string') return root
  const declaration = (() => { try { return normalizeLocalServerDeclaration(params.declaration) } catch (error) { return error } })()
  if (declaration instanceof Error) return failure('DECLARATION_INVALID', declaration.message)
  const target = statePath(root, declaration, options)
  const current = readRecord(target)
  if (!current) return { ok: true, status: 'missing' }
  if (isFailure(current)) return current
  const ownership = observe(current)
  if (ownership.live) return { ok: true, status: 'live', record: current }
  if (ownership.ambiguous) return failure('PROCESS_IDENTITY_MISMATCH', `Local server ownership could not be reconciled: ${ownership.reason || 'ambiguous_process'}.`, current)
  return { ok: true, status: current.status === 'STOPPED' ? 'stopped' : 'stale', record: current, reason: ownership.reason }
}

export async function startLocalServer(params: StartParams, options: LocalServerLifecycleOptions = {}): Promise<LocalServerStartResult> {
  const root = rootFor(params.sourceRoot)
  if (typeof root !== 'string') return root
  let declaration: LocalServerDeclaration
  try { declaration = normalizeLocalServerDeclaration(params.declaration) } catch (error) { return failure('DECLARATION_INVALID', error instanceof Error ? error.message : String(error)) }
  if (declaration.networkScope !== 'loopback') return failure('NETWORK_SCOPE_BLOCKED', 'External-scope server declarations are gated by R19.2 and cannot run in the local lifecycle.')
  const resolution = commandResolution(root, declaration)
  if (isFailure(resolution)) return resolution
  const declarationDigest = localServerDeclarationDigest(declaration)
  const identity = digest({ sourceRoot: root, serverId: declaration.serverId, declarationDigest })
  const target = statePath(root, declaration, options)
  const prepared = await withLock(target, async () => {
    const existingValue = readRecord(target)
    if (isFailure(existingValue)) return existingValue
    const existing = existingValue
    if (existing) {
      const ownership = observe(existing)
      if (ownership.ambiguous) return failure('PROCESS_IDENTITY_MISMATCH', `Local server ownership could not be verified: ${ownership.reason || 'ambiguous_process'}.`, existing)
      if (ownership.live) {
        if (existing.runId !== params.runId) return failure('SERVER_OWNED_BY_OTHER_RUN', `Server ${declaration.serverId} is owned by another active run.`, existing)
        const runtime = runtimeFor(target)
        const handle = handleFor(target, existing, options)
        const reused = emit({ ...existing, metrics: { ...existing.metrics, warmReuseMs: 0 } }, 'reused', options, 'deterministic_identity_reuse')
        writeRecord(target, reused)
        return { ok: true as const, handle, record: reused, reused: true, recovered: false }
      }
      if (existing.status === 'CRASHED' && (params.allowRecovery !== false)) {
        if (existing.restartCount >= declaration.budgets.maxRestarts) return failure('RECOVERY_EXHAUSTED', `Server recovery budget exhausted after ${existing.restartCount} restart(s).`, existing)
      } else if (existing.status === 'STARTING' || existing.status === 'READY' || existing.status === 'RECOVERING') {
        const crashed = { ...existing, status: 'CRASHED' as const, crashedAt: timestamp(options), failureReason: ownership.reason || 'stale_process' }
        writeRecord(target, crashed)
      }
    }
    const currentValue = readRecord(target)
    if (isFailure(currentValue)) return currentValue
    const current = currentValue
    const recovered = Boolean(current && current.status === 'CRASHED')
    if (recovered && current && current.restartCount >= declaration.budgets.maxRestarts) return failure('RECOVERY_EXHAUSTED', `Server recovery budget exhausted after ${current.restartCount} restart(s).`, current)
    const selected = await choosePort(declaration.port)
    if (typeof selected !== 'number') {
      const failedRecord = current
        ? markFailed(target, current, options, selected.message)
        : markFailed(target, initialRecord(params, root, identity, declarationDigest, declaration.port.strategy === 'fixed' ? declaration.port.port : (declaration.port.preferredPort || declaration.port.min), resolution.marker, false, timestamp(options)), options, selected.message)
      return { ...selected, ...(failedRecord ? { record: failedRecord } : {}) }
    }
    const now = timestamp(options)
    let record = initialRecord(params, root, identity, declarationDigest, selected, resolution.marker, recovered, now)
    if (recovered && current && !isFailure(current)) record = { ...record, restartCount: current.restartCount + 1, metrics: { ...record.metrics, starts: current.metrics.starts + 1, recoveryCount: current.metrics.recoveryCount + 1 } }
    const args = resolution.args.map(value => value === '${PORT}' ? String(selected) : value === '${HOST}' ? '127.0.0.1' : value)
    const child = spawn(resolution.executable, args, {
      cwd: resolution.cwd,
      shell: false,
      detached: process.platform !== 'win32',
      env: spawnEnvironment(declaration, selected),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    record = attachChild(target, record, child, runtimeFor(target), options)
    record = emit(record, recovered ? 'recovered' : 'started', options, recovered ? 'bounded_recovery' : undefined)
    writeRecord(target, record)
    return { ok: true as const, handle: handleFor(target, record, options), record, reused: false, recovered }
  })
  if (!prepared || isFailure(prepared)) return prepared as LocalServerLifecycleFailure
  if (!prepared.ok) return failure('LIFECYCLE_BUSY', 'Local server lifecycle preparation failed.')
  const runtime = runtimeFor(target)
  const ready = await waitForReady(target, prepared.record, declaration, runtime, options, prepared.reused ? Date.now() : (Date.parse(prepared.record.startedAt || '') || Date.now()), prepared.reused)
  if (ready.ok === false) {
    const current = readRecord(target)
    if (current && !isFailure(current) && current.status !== 'CRASHED') {
      await stopLocalServer({ statePath: target, identity, options, reason: ready.message })
      const failed = readRecord(target)
      if (failed && !isFailure(failed)) markFailed(target, failed, options, ready.message)
    }
    return ready
  }
  return { ...prepared, record: ready.record }
}

export async function recoverLocalServer(params: StartParams, options: LocalServerLifecycleOptions = {}): Promise<LocalServerStartResult> {
  return startLocalServer({ ...params, allowRecovery: true }, options)
}

export async function stopLocalServerByDeclaration(params: { sourceRoot: string; declaration: LocalServerDeclaration; identity?: string; reason?: string }, options: LocalServerLifecycleOptions = {}): Promise<LocalServerStopResult> {
  const root = rootFor(params.sourceRoot)
  if (typeof root !== 'string') return root
  let declaration: LocalServerDeclaration
  try { declaration = normalizeLocalServerDeclaration(params.declaration) } catch (error) { return failure('DECLARATION_INVALID', error instanceof Error ? error.message : String(error)) }
  const target = statePath(root, declaration, options)
  const current = readRecord(target)
  if (!current) return failure('SERVER_NOT_FOUND', 'Local server lifecycle state was not found.')
  if (isFailure(current)) return current
  return stopLocalServer({ statePath: target, identity: params.identity || current.identity, options, reason: params.reason })
}

export function localServerStatePath(params: { sourceRoot: string; declaration: LocalServerDeclaration }, options: LocalServerLifecycleOptions = {}): string {
  const root = fs.realpathSync(path.resolve(params.sourceRoot))
  return statePath(root, normalizeLocalServerDeclaration(params.declaration), options)
}
