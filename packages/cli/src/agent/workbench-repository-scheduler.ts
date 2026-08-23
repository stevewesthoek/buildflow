import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getConfigDir } from '../utils/paths'
import { getWorkbenchSession, type WorkbenchSessionStoreFailure, type WorkbenchSessionStoreOptions } from './workbench-session-store'

export const WORKBENCH_REPOSITORY_SCHEDULER_VERSION = 1 as const

export type RepositoryScheduleClass = 'read_shared' | 'mutation_exclusive'
export type RepositoryScheduleStatus = 'queued' | 'leased' | 'completed' | 'cancelled' | 'timed_out'

export type RepositoryScheduleRequest = {
  requestId: string
  sessionId: string
  sourceId: string
  class: RepositoryScheduleClass
  operationKind: string
  status: RepositoryScheduleStatus
  enqueuedAt: string
  updatedAt: string
  leaseOwner?: string
  leaseProofHash?: string
  leaseAcquiredAt?: string
  leaseExpiresAt?: string
  completedAt?: string
  cancelledAt?: string
  timedOutAt?: string
}

type RepositorySchedulerStore = {
  version: typeof WORKBENCH_REPOSITORY_SCHEDULER_VERSION
  updatedAt: string
  requests: RepositoryScheduleRequest[]
}

export type RepositorySchedulerOptions = WorkbenchSessionStoreOptions & {
  maxRequests?: number
  now?: () => Date
}

export type RepositorySchedulerFailure = {
  ok: false
  code:
    | 'SCHEDULER_BUSY'
    | 'SCHEDULER_CORRUPT'
    | 'SCHEDULER_INVALID_INPUT'
    | 'SCHEDULER_SESSION_NOT_FOUND'
    | 'SCHEDULER_SOURCE_NOT_OWNED'
    | 'SCHEDULER_DUPLICATE_CONFLICT'
    | 'SCHEDULER_REQUEST_NOT_FOUND'
    | 'SCHEDULER_NOT_ELIGIBLE'
    | 'SCHEDULER_LEASE_CONFLICT'
    | 'SCHEDULER_LEASE_PROOF_INVALID'
  message: string
}

function isSchedulerFailure(value: RepositorySchedulerStore | RepositorySchedulerFailure): value is RepositorySchedulerFailure {
  return 'ok' in value && value.ok === false
}

function isSessionFailure(value: WorkbenchSessionStoreFailure | { lockedSourceIds: string[] }): value is WorkbenchSessionStoreFailure {
  return 'ok' in value && value.ok === false
}

const DEFAULT_MAX_REQUESTS = 1000
const DEFAULT_LEASE_MS = 60_000
const MAX_LEASE_MS = 16 * 60_000
const QUEUED_REQUEST_EXPIRY_MS = 15 * 60_000       // queued requests waiting longer than this are timed out
const TERMINAL_REQUEST_RETENTION_MS = 2 * 60 * 60_000  // terminal entries older than this are pruned
const LOCK_WAIT_MS = 250
const LOCK_STALE_MS = 30_000
const MAX_IDENTIFIER = 200
const MAX_OPERATION_KIND = 120

function rootDir(options?: RepositorySchedulerOptions): string {
  return options?.rootDir ? path.resolve(options.rootDir) : getConfigDir()
}

function schedulerPath(options?: RepositorySchedulerOptions): string {
  return path.join(rootDir(options), 'workbench-repository-scheduler.json')
}

function schedulerLockPath(options?: RepositorySchedulerOptions): string {
  return `${schedulerPath(options)}.lock`
}

function nowIso(options?: RepositorySchedulerOptions): string {
  return (options?.now?.() || new Date()).toISOString()
}

function emptyStore(): RepositorySchedulerStore {
  return { version: WORKBENCH_REPOSITORY_SCHEDULER_VERSION, updatedAt: new Date(0).toISOString(), requests: [] }
}

function validId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_IDENTIFIER
    && /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
}

function validRequest(value: unknown): value is RepositoryScheduleRequest {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<RepositoryScheduleRequest>
  return validId(item.requestId)
    && validId(item.sessionId)
    && validId(item.sourceId)
    && ['read_shared', 'mutation_exclusive'].includes(String(item.class))
    && typeof item.operationKind === 'string'
    && item.operationKind.length > 0
    && item.operationKind.length <= MAX_OPERATION_KIND
    && ['queued', 'leased', 'completed', 'cancelled', 'timed_out'].includes(String(item.status))
    && validIso(item.enqueuedAt)
    && validIso(item.updatedAt)
    && (item.leaseOwner === undefined || validId(item.leaseOwner))
    && (item.leaseProofHash === undefined || /^[a-f0-9]{64}$/.test(item.leaseProofHash))
    && (item.leaseAcquiredAt === undefined || validIso(item.leaseAcquiredAt))
    && (item.leaseExpiresAt === undefined || validIso(item.leaseExpiresAt))
}

function readStore(options?: RepositorySchedulerOptions): RepositorySchedulerStore | RepositorySchedulerFailure {
  try {
    const target = schedulerPath(options)
    if (!fs.existsSync(target)) return emptyStore()
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as Partial<RepositorySchedulerStore>
    if (parsed.version !== WORKBENCH_REPOSITORY_SCHEDULER_VERSION || !Array.isArray(parsed.requests) || !parsed.requests.every(validRequest)) {
      return { ok: false, code: 'SCHEDULER_CORRUPT', message: 'Repository scheduler store is invalid or unsupported.' }
    }
    return {
      version: WORKBENCH_REPOSITORY_SCHEDULER_VERSION,
      updatedAt: validIso(parsed.updatedAt) ? parsed.updatedAt : new Date(0).toISOString(),
      requests: parsed.requests
    }
  } catch {
    return { ok: false, code: 'SCHEDULER_CORRUPT', message: 'Repository scheduler store could not be read safely.' }
  }
}

function persistStore(store: RepositorySchedulerStore, options?: RepositorySchedulerOptions): void {
  const target = schedulerPath(options)
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  const maxRequests = Math.max(20, Math.min(options?.maxRequests || DEFAULT_MAX_REQUESTS, 5000))
  const terminal = store.requests.filter(item => ['completed', 'cancelled', 'timed_out'].includes(item.status))
  const active = store.requests.filter(item => !['completed', 'cancelled', 'timed_out'].includes(item.status))
  const retained = [...terminal.sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt)).slice(-maxRequests), ...active]
  const payload: RepositorySchedulerStore = {
    version: WORKBENCH_REPOSITORY_SCHEDULER_VERSION,
    updatedAt: nowIso(options),
    requests: retained.sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt) || a.requestId.localeCompare(b.requestId))
  }
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  fs.renameSync(temporary, target)
  fs.chmodSync(target, 0o600)
}

function acquireLock(options?: RepositorySchedulerOptions): number | undefined {
  const target = schedulerLockPath(options)
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + LOCK_WAIT_MS
  while (Date.now() <= deadline) {
    try {
      return fs.openSync(target, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        if (Date.now() - fs.statSync(target).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(target, { force: true })
          continue
        }
      } catch {}
    }
  }
  return undefined
}

function withStore<T>(options: RepositorySchedulerOptions | undefined, callback: (store: RepositorySchedulerStore) => T): T | RepositorySchedulerFailure {
  let descriptor: number | undefined
  try {
    descriptor = acquireLock(options)
    if (descriptor === undefined) return { ok: false, code: 'SCHEDULER_BUSY', message: 'Repository scheduler is busy.' }
    const store = readStore(options)
    if (isSchedulerFailure(store)) return store
    const now = nowIso(options)
    recoverExpiredLeasesInStore(store, now)
    pruneTerminalEntries(store, now)
    return callback(store)
  } catch {
    return { ok: false, code: 'SCHEDULER_CORRUPT', message: 'Repository scheduler operation failed safely.' }
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch {}
      try { fs.rmSync(schedulerLockPath(options), { force: true }) } catch {}
    }
  }
}

function leaseHash(proof: string): string {
  return crypto.createHash('sha256').update(proof).digest('hex')
}

function recoverExpiredLeasesInStore(store: RepositorySchedulerStore, now: string): void {
  const nowMs = Date.parse(now)
  for (const request of store.requests) {
    if (request.status === 'leased' && request.leaseExpiresAt && Date.parse(request.leaseExpiresAt) <= nowMs) {
      request.status = 'queued'
      request.updatedAt = now
      request.leaseOwner = undefined
      request.leaseProofHash = undefined
      request.leaseAcquiredAt = undefined
      request.leaseExpiresAt = undefined
    }
    if (request.status === 'queued' && Date.parse(request.enqueuedAt) + QUEUED_REQUEST_EXPIRY_MS <= nowMs) {
      request.status = 'timed_out'
      request.timedOutAt = now
      request.updatedAt = now
    }
  }
}

function pruneTerminalEntries(store: RepositorySchedulerStore, now: string): void {
  const cutoffMs = Date.parse(now) - TERMINAL_REQUEST_RETENTION_MS
  store.requests = store.requests.filter(request => {
    if (!['completed', 'cancelled', 'timed_out'].includes(request.status)) return true
    return Date.parse(request.updatedAt) > cutoffMs
  })
}

function eligible(request: RepositoryScheduleRequest, requests: RepositoryScheduleRequest[]): boolean {
  if (request.status !== 'queued') return false
  const sameSource = requests.filter(item => item.sourceId === request.sourceId)
  const earlier = sameSource.filter(item => item.enqueuedAt < request.enqueuedAt || (item.enqueuedAt === request.enqueuedAt && item.requestId < request.requestId))
  if (request.class === 'mutation_exclusive') {
    return !sameSource.some(item => item.status === 'leased') && !earlier.some(item => item.status === 'queued')
  }
  const earlierMutation = earlier.some(item => item.class === 'mutation_exclusive' && item.status === 'queued')
  const activeMutation = sameSource.some(item => item.class === 'mutation_exclusive' && item.status === 'leased')
  return !earlierMutation && !activeMutation
}

export function enqueueRepositoryWork(input: {
  requestId?: string
  sessionId: string
  sourceId: string
  class: RepositoryScheduleClass
  operationKind: string
  now?: string
}, options?: RepositorySchedulerOptions): { ok: true; created: boolean; request: RepositoryScheduleRequest } | RepositorySchedulerFailure {
  const requestId = input.requestId || `schedule-${crypto.randomUUID()}`
  const timestamp = input.now || nowIso(options)
  if (!validId(requestId) || !validId(input.sessionId) || !validId(input.sourceId) || !['read_shared', 'mutation_exclusive'].includes(input.class)
    || typeof input.operationKind !== 'string' || input.operationKind.length === 0 || input.operationKind.length > MAX_OPERATION_KIND || !validIso(timestamp)) {
    return { ok: false, code: 'SCHEDULER_INVALID_INPUT', message: 'Repository schedule request is invalid or unbounded.' }
  }
  const session = getWorkbenchSession(input.sessionId, options)
  if (!session || isSessionFailure(session)) {
    return { ok: false, code: 'SCHEDULER_SESSION_NOT_FOUND', message: 'Scheduling requires a valid durable session.' }
  }
  if (!session.lockedSourceIds.includes(input.sourceId)) {
    return { ok: false, code: 'SCHEDULER_SOURCE_NOT_OWNED', message: 'Session does not own the requested source.' }
  }
  return withStore<{ ok: true; created: boolean; request: RepositoryScheduleRequest } | RepositorySchedulerFailure>(options, store => {
    const existing = store.requests.find(item => item.requestId === requestId)
    if (existing) {
      const isTerminal = ['completed', 'cancelled', 'timed_out'].includes(existing.status)
      if (isTerminal) return { ok: true, created: false, request: existing }
      const same = existing.sessionId === input.sessionId && existing.sourceId === input.sourceId && existing.class === input.class && existing.operationKind === input.operationKind
      return same
        ? { ok: true, created: false, request: existing }
        : { ok: false, code: 'SCHEDULER_DUPLICATE_CONFLICT', message: 'Schedule request identity is already bound to different work.' }
    }
    const request: RepositoryScheduleRequest = {
      requestId,
      sessionId: input.sessionId,
      sourceId: input.sourceId,
      class: input.class,
      operationKind: input.operationKind,
      status: 'queued',
      enqueuedAt: timestamp,
      updatedAt: timestamp
    }
    store.requests.push(request)
    persistStore(store, options)
    return { ok: true, created: true, request }
  })
}

export function claimRepositoryWork(input: {
  requestId: string
  workerId: string
  leaseMs?: number
  now?: string
}, options?: RepositorySchedulerOptions): { ok: true; request: RepositoryScheduleRequest; leaseProof: string } | RepositorySchedulerFailure {
  const timestamp = input.now || nowIso(options)
  const leaseMs = Math.max(5_000, Math.min(input.leaseMs || DEFAULT_LEASE_MS, MAX_LEASE_MS))
  if (!validId(input.requestId) || !validId(input.workerId) || !validIso(timestamp)) {
    return { ok: false, code: 'SCHEDULER_INVALID_INPUT', message: 'Repository lease request is invalid.' }
  }
  return withStore<{ ok: true; request: RepositoryScheduleRequest; leaseProof: string } | RepositorySchedulerFailure>(options, store => {
    const request = store.requests.find(item => item.requestId === input.requestId)
    if (!request) return { ok: false, code: 'SCHEDULER_REQUEST_NOT_FOUND', message: 'Schedule request was not found.' }
    if (!eligible(request, store.requests)) return { ok: false, code: 'SCHEDULER_NOT_ELIGIBLE', message: 'Schedule request is not currently eligible.' }
    const leaseProof = crypto.randomBytes(32).toString('hex')
    request.status = 'leased'
    request.leaseOwner = input.workerId
    request.leaseProofHash = leaseHash(leaseProof)
    request.leaseAcquiredAt = timestamp
    request.leaseExpiresAt = new Date(Date.parse(timestamp) + leaseMs).toISOString()
    request.updatedAt = timestamp
    persistStore(store, options)
    return { ok: true, request, leaseProof }
  })
}

export function completeRepositoryWork(input: {
  requestId: string
  leaseProof: string
  now?: string
}, options?: RepositorySchedulerOptions): { ok: true; request: RepositoryScheduleRequest } | RepositorySchedulerFailure {
  const timestamp = input.now || nowIso(options)
  if (!validId(input.requestId) || typeof input.leaseProof !== 'string' || input.leaseProof.length < 32 || !validIso(timestamp)) {
    return { ok: false, code: 'SCHEDULER_INVALID_INPUT', message: 'Repository completion request is invalid.' }
  }
  return withStore<{ ok: true; request: RepositoryScheduleRequest } | RepositorySchedulerFailure>(options, store => {
    const request = store.requests.find(item => item.requestId === input.requestId)
    if (!request) return { ok: false, code: 'SCHEDULER_REQUEST_NOT_FOUND', message: 'Schedule request was not found.' }
    if (request.status !== 'leased') return { ok: false, code: 'SCHEDULER_LEASE_CONFLICT', message: 'Schedule request is not leased.' }
    if (request.leaseProofHash !== leaseHash(input.leaseProof)) return { ok: false, code: 'SCHEDULER_LEASE_PROOF_INVALID', message: 'Repository lease proof is invalid.' }
    request.status = 'completed'
    request.completedAt = timestamp
    request.updatedAt = timestamp
    request.leaseOwner = undefined
    request.leaseProofHash = undefined
    request.leaseAcquiredAt = undefined
    request.leaseExpiresAt = undefined
    persistStore(store, options)
    return { ok: true, request }
  })
}

export function cancelRepositoryWork(input: { requestId: string; now?: string }, options?: RepositorySchedulerOptions): { ok: true; request: RepositoryScheduleRequest } | RepositorySchedulerFailure {
  const timestamp = input.now || nowIso(options)
  if (!validId(input.requestId) || !validIso(timestamp)) return { ok: false, code: 'SCHEDULER_INVALID_INPUT', message: 'Repository cancellation request is invalid.' }
  return withStore<{ ok: true; request: RepositoryScheduleRequest } | RepositorySchedulerFailure>(options, store => {
    const request = store.requests.find(item => item.requestId === input.requestId)
    if (!request) return { ok: false, code: 'SCHEDULER_REQUEST_NOT_FOUND', message: 'Schedule request was not found.' }
    if (['completed', 'cancelled', 'timed_out'].includes(request.status)) return { ok: true, request }
    request.status = 'cancelled'
    request.cancelledAt = timestamp
    request.updatedAt = timestamp
    request.leaseOwner = undefined
    request.leaseProofHash = undefined
    request.leaseAcquiredAt = undefined
    request.leaseExpiresAt = undefined
    persistStore(store, options)
    return { ok: true, request }
  })
}

export function cancelSessionSchedulerRequests(sessionId: string, options?: RepositorySchedulerOptions): { ok: true; cancelled: string[] } | RepositorySchedulerFailure {
  if (!validId(sessionId)) return { ok: false, code: 'SCHEDULER_INVALID_INPUT', message: 'Session ID is invalid.' }
  return withStore<{ ok: true; cancelled: string[] } | RepositorySchedulerFailure>(options, store => {
    const now = nowIso(options)
    const cancelled: string[] = []
    for (const request of store.requests) {
      if (request.sessionId !== sessionId) continue
      if (['completed', 'cancelled', 'timed_out'].includes(request.status)) continue
      request.status = 'cancelled'
      request.cancelledAt = now
      request.updatedAt = now
      request.leaseOwner = undefined
      request.leaseProofHash = undefined
      request.leaseAcquiredAt = undefined
      request.leaseExpiresAt = undefined
      cancelled.push(request.requestId)
    }
    if (cancelled.length > 0) persistStore(store, options)
    return { ok: true, cancelled }
  })
}

export function listRepositorySchedule(sourceId?: string, options?: RepositorySchedulerOptions): RepositoryScheduleRequest[] | RepositorySchedulerFailure {
  const store = readStore(options)
  if (isSchedulerFailure(store)) return store
  recoverExpiredLeasesInStore(store, nowIso(options))
  return store.requests.filter(item => !sourceId || item.sourceId === sourceId)
}

export function recoverRepositoryScheduler(options?: RepositorySchedulerOptions): { ok: true; queued: string[]; active: RepositoryScheduleRequest[] } | RepositorySchedulerFailure {
  return withStore<{ ok: true; queued: string[]; active: RepositoryScheduleRequest[] } | RepositorySchedulerFailure>(options, store => {
    persistStore(store, options)
    return {
      ok: true,
      queued: store.requests.filter(item => item.status === 'queued').map(item => item.requestId),
      active: store.requests.filter(item => item.status === 'queued' || item.status === 'leased')
    }
  })
}
