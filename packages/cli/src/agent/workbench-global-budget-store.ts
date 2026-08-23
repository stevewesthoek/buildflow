import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { getConfigDir } from '../utils/paths'

export const WORKBENCH_GLOBAL_BUDGET_VERSION = 1 as const

export type WorkbenchWorkerClass = 'status' | 'approval' | 'read' | 'mutation'
export type WorkbenchBudgetLeaseStatus = 'active' | 'released' | 'expired' | 'cancelled'

export type WorkbenchBudgetLimits = {
  global: number
  perRepository: number
  perClass: Record<WorkbenchWorkerClass, number>
}

export type WorkbenchBudgetLease = {
  leaseId: string
  requestId: string
  sessionId: string
  sourceId: string
  workerClass: WorkbenchWorkerClass
  cost: number
  status: WorkbenchBudgetLeaseStatus
  acquiredAt: string
  updatedAt: string
  expiresAt: string
  leaseProofHash: string
  releasedAt?: string
  expiredAt?: string
  cancelledAt?: string
}

type WorkbenchBudgetStore = {
  version: typeof WORKBENCH_GLOBAL_BUDGET_VERSION
  updatedAt: string
  limits: WorkbenchBudgetLimits
  leases: WorkbenchBudgetLease[]
}

function isBudgetFailure(value: WorkbenchBudgetStore | WorkbenchBudgetFailure): value is WorkbenchBudgetFailure {
  return 'ok' in value && value.ok === false
}

export type WorkbenchBudgetOptions = {
  rootDir?: string
  now?: () => Date
  limits?: Partial<WorkbenchBudgetLimits> & { perClass?: Partial<Record<WorkbenchWorkerClass, number>> }
  maxLeases?: number
}

export type WorkbenchBudgetFailure = {
  ok: false
  code:
    | 'BUDGET_BUSY'
    | 'BUDGET_CORRUPT'
    | 'BUDGET_INVALID_INPUT'
    | 'BUDGET_EXHAUSTED'
    | 'BUDGET_DUPLICATE_CONFLICT'
    | 'BUDGET_LEASE_NOT_FOUND'
    | 'BUDGET_LEASE_PROOF_INVALID'
  message: string
}

const DEFAULT_LIMITS: WorkbenchBudgetLimits = {
  global: 8,
  perRepository: 4,
  perClass: { status: 2, approval: 2, read: 4, mutation: 2 }
}

const DEFAULT_MAX_LEASES = 1000
const DEFAULT_LEASE_MS = 60_000
const MAX_LEASE_MS = 16 * 60_000
const TERMINAL_LEASE_RETENTION_MS = 60 * 60_000    // terminal leases older than this are pruned
const LOCK_WAIT_MS = 250
const LOCK_STALE_MS = 30_000
const MAX_ID = 200

function rootDir(options?: WorkbenchBudgetOptions): string {
  return options?.rootDir ? path.resolve(options.rootDir) : getConfigDir()
}

function storePath(options?: WorkbenchBudgetOptions): string {
  return path.join(rootDir(options), 'workbench-global-budgets.json')
}

function lockPath(options?: WorkbenchBudgetOptions): string {
  return `${storePath(options)}.lock`
}

function nowIso(options?: WorkbenchBudgetOptions): string {
  return (options?.now?.() || new Date()).toISOString()
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID && /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
}

function validPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 10_000
}

function limitsFor(options?: WorkbenchBudgetOptions): WorkbenchBudgetLimits {
  const configured = options?.limits
  return {
    global: configured?.global ?? DEFAULT_LIMITS.global,
    perRepository: configured?.perRepository ?? DEFAULT_LIMITS.perRepository,
    perClass: {
      status: configured?.perClass?.status ?? DEFAULT_LIMITS.perClass.status,
      approval: configured?.perClass?.approval ?? DEFAULT_LIMITS.perClass.approval,
      read: configured?.perClass?.read ?? DEFAULT_LIMITS.perClass.read,
      mutation: configured?.perClass?.mutation ?? DEFAULT_LIMITS.perClass.mutation
    }
  }
}

function validLimits(value: unknown): value is WorkbenchBudgetLimits {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<WorkbenchBudgetLimits>
  return validPositiveInteger(item.global)
    && validPositiveInteger(item.perRepository)
    && !!item.perClass
    && validPositiveInteger(item.perClass.status)
    && validPositiveInteger(item.perClass.approval)
    && validPositiveInteger(item.perClass.read)
    && validPositiveInteger(item.perClass.mutation)
}

function validLease(value: unknown): value is WorkbenchBudgetLease {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<WorkbenchBudgetLease>
  return validId(item.leaseId)
    && validId(item.requestId)
    && validId(item.sessionId)
    && validId(item.sourceId)
    && ['status', 'approval', 'read', 'mutation'].includes(String(item.workerClass))
    && validPositiveInteger(item.cost)
    && ['active', 'released', 'expired', 'cancelled'].includes(String(item.status))
    && validIso(item.acquiredAt)
    && validIso(item.updatedAt)
    && validIso(item.expiresAt)
    && typeof item.leaseProofHash === 'string'
    && /^[a-f0-9]{64}$/.test(item.leaseProofHash)
    && (item.releasedAt === undefined || validIso(item.releasedAt))
    && (item.expiredAt === undefined || validIso(item.expiredAt))
    && (item.cancelledAt === undefined || validIso(item.cancelledAt))
}

function readStore(options?: WorkbenchBudgetOptions): WorkbenchBudgetStore | WorkbenchBudgetFailure {
  const file = storePath(options)
  if (!fs.existsSync(file)) return { version: WORKBENCH_GLOBAL_BUDGET_VERSION, updatedAt: new Date(0).toISOString(), limits: limitsFor(options), leases: [] }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<WorkbenchBudgetStore>
    if (parsed.version !== WORKBENCH_GLOBAL_BUDGET_VERSION || !validIso(parsed.updatedAt) || !validLimits(parsed.limits) || !Array.isArray(parsed.leases) || !parsed.leases.every(validLease)) {
      return { ok: false, code: 'BUDGET_CORRUPT', message: 'Global budget store is corrupt or unsupported.' }
    }
    return parsed as WorkbenchBudgetStore
  } catch {
    return { ok: false, code: 'BUDGET_CORRUPT', message: 'Global budget store is corrupt or unreadable.' }
  }
}

function writeStore(store: WorkbenchBudgetStore, options?: WorkbenchBudgetOptions): void {
  const file = storePath(options)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
  fs.chmodSync(temp, 0o600)
  fs.renameSync(temp, file)
  fs.chmodSync(file, 0o600)
}

function withLock<T>(options: WorkbenchBudgetOptions | undefined, callback: () => T): T | WorkbenchBudgetFailure {
  const file = lockPath(options)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const started = Date.now()
  while (true) {
    try {
      const handle = fs.openSync(file, 'wx', 0o600)
      try { return callback() } finally { fs.closeSync(handle); fs.rmSync(file, { force: true }) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > LOCK_STALE_MS) { fs.rmSync(file, { force: true }); continue }
      } catch {}
      if (Date.now() - started >= LOCK_WAIT_MS) return { ok: false, code: 'BUDGET_BUSY', message: 'Global budget store is busy.' }
    }
  }
}

function expireLeases(store: WorkbenchBudgetStore, now: string): void {
  for (const lease of store.leases) {
    if (lease.status === 'active' && Date.parse(lease.expiresAt) <= Date.parse(now)) {
      lease.status = 'expired'
      lease.updatedAt = now
      lease.expiredAt = now
    }
  }
}

function pruneTerminalLeases(store: WorkbenchBudgetStore, now: string): void {
  const cutoffMs = Date.parse(now) - TERMINAL_LEASE_RETENTION_MS
  store.leases = store.leases.filter(lease => {
    if (lease.status === 'active') return true
    return Date.parse(lease.updatedAt) > cutoffMs
  })
}

function activeCost(store: WorkbenchBudgetStore, predicate?: (lease: WorkbenchBudgetLease) => boolean): number {
  return store.leases.filter((lease) => lease.status === 'active' && (!predicate || predicate(lease))).reduce((sum, lease) => sum + lease.cost, 0)
}

function hashProof(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

export function acquireWorkbenchBudget(input: {
  requestId: string
  sessionId: string
  sourceId: string
  workerClass: WorkbenchWorkerClass
  cost?: number
  leaseMs?: number
  now?: string
}, options?: WorkbenchBudgetOptions): { ok: true; lease: WorkbenchBudgetLease; leaseProof: string; utilization: ReturnType<typeof projectWorkbenchBudgetUtilization> } | WorkbenchBudgetFailure {
  if (!validId(input.requestId) || !validId(input.sessionId) || !validId(input.sourceId) || !['status', 'approval', 'read', 'mutation'].includes(input.workerClass)) {
    return { ok: false, code: 'BUDGET_INVALID_INPUT', message: 'Budget request identifiers or class are invalid.' }
  }
  const cost = input.cost ?? 1
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS
  if (!validPositiveInteger(cost) || !Number.isInteger(leaseMs) || leaseMs <= 0 || leaseMs > MAX_LEASE_MS) return { ok: false, code: 'BUDGET_INVALID_INPUT', message: 'Budget cost or lease duration is invalid.' }
  const result = withLock(options, () => {
    const store = readStore(options)
    if (isBudgetFailure(store)) return store
    const now = input.now ?? nowIso(options)
    expireLeases(store, now)
    pruneTerminalLeases(store, now)
    const duplicate = store.leases.find((lease) => lease.requestId === input.requestId && lease.status === 'active')
    if (duplicate) return { ok: false, code: 'BUDGET_DUPLICATE_CONFLICT', message: 'Budget request already has an active lease.' } as WorkbenchBudgetFailure
    const limits = store.limits
    const globalUsed = activeCost(store)
    const repoUsed = activeCost(store, (lease) => lease.sourceId === input.sourceId)
    const classUsed = activeCost(store, (lease) => lease.workerClass === input.workerClass)
    if (globalUsed + cost > limits.global || repoUsed + cost > limits.perRepository || classUsed + cost > limits.perClass[input.workerClass]) {
      return { ok: false, code: 'BUDGET_EXHAUSTED', message: 'Global, repository, or worker-class budget is exhausted.' } as WorkbenchBudgetFailure
    }
    const leaseProof = crypto.randomBytes(32).toString('hex')
    const lease: WorkbenchBudgetLease = {
      leaseId: crypto.randomUUID(), requestId: input.requestId, sessionId: input.sessionId, sourceId: input.sourceId,
      workerClass: input.workerClass, cost, status: 'active', acquiredAt: now, updatedAt: now,
      expiresAt: new Date(Date.parse(now) + leaseMs).toISOString(), leaseProofHash: hashProof(leaseProof)
    }
    store.leases.push(lease)
    const maxLeases = options?.maxLeases ?? DEFAULT_MAX_LEASES
    if (store.leases.length > maxLeases) store.leases = store.leases.slice(-maxLeases)
    store.updatedAt = now
    writeStore(store, options)
    return { ok: true as const, lease, leaseProof, utilization: projectWorkbenchBudgetUtilization(store) }
  })
  return result
}

export function releaseWorkbenchBudget(input: { leaseId: string; leaseProof: string; outcome?: 'released' | 'cancelled'; now?: string }, options?: WorkbenchBudgetOptions): { ok: true; lease: WorkbenchBudgetLease } | WorkbenchBudgetFailure {
  if (!validId(input.leaseId) || typeof input.leaseProof !== 'string' || input.leaseProof.length < 32) return { ok: false, code: 'BUDGET_INVALID_INPUT', message: 'Lease release input is invalid.' }
  const result = withLock(options, () => {
    const store = readStore(options)
    if (isBudgetFailure(store)) return store
    const now = input.now ?? nowIso(options)
    expireLeases(store, now)
    pruneTerminalLeases(store, now)
    const lease = store.leases.find((item) => item.leaseId === input.leaseId)
    if (!lease) return { ok: false, code: 'BUDGET_LEASE_NOT_FOUND', message: 'Budget lease was not found.' } as WorkbenchBudgetFailure
    if (lease.leaseProofHash !== hashProof(input.leaseProof)) return { ok: false, code: 'BUDGET_LEASE_PROOF_INVALID', message: 'Budget lease proof is invalid.' } as WorkbenchBudgetFailure
    if (lease.status !== 'active') {
      store.updatedAt = now
      writeStore(store, options)
      return { ok: true as const, lease }
    }
    lease.status = input.outcome === 'cancelled' ? 'cancelled' : 'released'
    lease.updatedAt = now
    if (lease.status === 'cancelled') lease.cancelledAt = now
    else lease.releasedAt = now
    store.updatedAt = now
    writeStore(store, options)
    return { ok: true as const, lease }
  })
  return result
}

export function expireSessionBudgetLeases(sessionId: string, options?: WorkbenchBudgetOptions): { ok: true; expired: number } | WorkbenchBudgetFailure {
  if (!validId(sessionId)) return { ok: false, code: 'BUDGET_INVALID_INPUT', message: 'Session ID is invalid.' }
  const result = withLock(options, () => {
    const store = readStore(options)
    if (isBudgetFailure(store)) return store
    const now = nowIso(options)
    expireLeases(store, now)
    pruneTerminalLeases(store, now)
    let expired = 0
    for (const lease of store.leases) {
      if (lease.sessionId === sessionId && lease.status === 'active') {
        lease.status = 'expired'
        lease.updatedAt = now
        lease.expiredAt = now
        expired++
      }
    }
    if (expired > 0) {
      store.updatedAt = now
      writeStore(store, options)
    }
    return { ok: true as const, expired }
  })
  return result
}

export function recoverWorkbenchBudgets(options?: WorkbenchBudgetOptions): { ok: true; recovered: number; utilization: ReturnType<typeof projectWorkbenchBudgetUtilization> } | WorkbenchBudgetFailure {
  const result = withLock(options, () => {
    const store = readStore(options)
    if (isBudgetFailure(store)) return store
    const now = nowIso(options)
    const before = store.leases.filter((lease) => lease.status === 'active').length
    expireLeases(store, now)
    pruneTerminalLeases(store, now)
    const after = store.leases.filter((lease) => lease.status === 'active').length
    store.updatedAt = now
    writeStore(store, options)
    return { ok: true as const, recovered: before - after, utilization: projectWorkbenchBudgetUtilization(store) }
  })
  return result
}

export function projectWorkbenchBudgetUtilization(storeOrOptions?: WorkbenchBudgetStore | WorkbenchBudgetOptions) {
  const store = storeOrOptions && 'version' in storeOrOptions ? storeOrOptions : readStore(storeOrOptions)
  if (isBudgetFailure(store)) return store
  const byClass = {
    status: activeCost(store, (lease) => lease.workerClass === 'status'),
    approval: activeCost(store, (lease) => lease.workerClass === 'approval'),
    read: activeCost(store, (lease) => lease.workerClass === 'read'),
    mutation: activeCost(store, (lease) => lease.workerClass === 'mutation')
  }
  const byRepository: Record<string, number> = {}
  for (const lease of store.leases.filter((item) => item.status === 'active')) byRepository[lease.sourceId] = (byRepository[lease.sourceId] || 0) + lease.cost
  return { ok: true as const, version: store.version, global: { used: activeCost(store), limit: store.limits.global }, byClass, classLimits: store.limits.perClass, byRepository, perRepositoryLimit: store.limits.perRepository }
}
