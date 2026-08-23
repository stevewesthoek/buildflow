import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getConfigDir } from '../utils/paths'

export const WORKBENCH_APPROVAL_INTENT_STORE_VERSION = 1 as const
const DEFAULT_TTL_MS = 15 * 60_000
const MAX_RECORDS = 500
const LOCK_WAIT_MS = 250
const LOCK_STALE_MS = 30_000

export type WorkbenchApprovalIntentStatus = 'pending' | 'approved' | 'denied' | 'consumed' | 'expired'

export type WorkbenchApprovalIntentRecord = {
  storeVersion: typeof WORKBENCH_APPROVAL_INTENT_STORE_VERSION
  approvalId: string
  sourceId: string
  runId: string
  sessionId?: string
  requestId?: string
  operationKind: string
  paths: string[]
  reason: string
  requestDigest: string
  status: WorkbenchApprovalIntentStatus
  createdAt: string
  updatedAt: string
  expiresAt: string
  decidedAt?: string
  consumedAt?: string
}

type ApprovalIntentStore = {
  version: typeof WORKBENCH_APPROVAL_INTENT_STORE_VERSION
  updatedAt: string
  approvals: WorkbenchApprovalIntentRecord[]
}

export type WorkbenchApprovalIntentStoreOptions = {
  rootDir?: string
  now?: () => Date
}

export type ApprovalIntentFailure = {
  ok: false
  code: 'APPROVAL_INTENT_STORE_BUSY' | 'APPROVAL_INTENT_STORE_CORRUPT' | 'APPROVAL_INTENT_NOT_FOUND' | 'APPROVAL_INTENT_BINDING_MISMATCH' | 'APPROVAL_INTENT_NOT_PENDING' | 'APPROVAL_INTENT_NOT_APPROVED'
  message: string
}

function resolvedRoot(options?: WorkbenchApprovalIntentStoreOptions): string {
  return options?.rootDir ? path.resolve(options.rootDir) : getConfigDir()
}

function storePath(options?: WorkbenchApprovalIntentStoreOptions): string {
  return path.join(resolvedRoot(options), 'workbench-approval-intents.json')
}

function lockPath(options?: WorkbenchApprovalIntentStoreOptions): string {
  return `${storePath(options)}.lock`
}

function nowIso(options?: WorkbenchApprovalIntentStoreOptions): string {
  return (options?.now?.() || new Date()).toISOString()
}

function emptyStore(): ApprovalIntentStore {
  return { version: WORKBENCH_APPROVAL_INTENT_STORE_VERSION, updatedAt: new Date(0).toISOString(), approvals: [] }
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
}

function validText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function validRecord(value: unknown): value is WorkbenchApprovalIntentRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<WorkbenchApprovalIntentRecord>
  return record.storeVersion === WORKBENCH_APPROVAL_INTENT_STORE_VERSION
    && validText(record.approvalId, 200)
    && validText(record.sourceId, 200)
    && validText(record.runId, 200)
    && (record.sessionId === undefined || validText(record.sessionId, 200))
    && (record.requestId === undefined || validText(record.requestId, 200))
    && validText(record.operationKind, 120)
    && Array.isArray(record.paths) && record.paths.length <= 32 && record.paths.every(item => typeof item === 'string' && item.length <= 500)
    && validText(record.reason, 160)
    && typeof record.requestDigest === 'string' && /^[a-f0-9]{64}$/.test(record.requestDigest)
    && ['pending', 'approved', 'denied', 'consumed', 'expired'].includes(String(record.status))
    && validIso(record.createdAt)
    && validIso(record.updatedAt)
    && validIso(record.expiresAt)
    && (record.decidedAt === undefined || validIso(record.decidedAt))
    && (record.consumedAt === undefined || validIso(record.consumedAt))
}

function readStore(options?: WorkbenchApprovalIntentStoreOptions): ApprovalIntentStore | ApprovalIntentFailure {
  try {
    const target = storePath(options)
    if (!fs.existsSync(target)) return emptyStore()
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as Partial<ApprovalIntentStore>
    if (parsed.version !== WORKBENCH_APPROVAL_INTENT_STORE_VERSION || !Array.isArray(parsed.approvals) || !parsed.approvals.every(validRecord)) {
      return { ok: false, code: 'APPROVAL_INTENT_STORE_CORRUPT', message: 'Approval intent store has an invalid shape.' }
    }
    return { version: WORKBENCH_APPROVAL_INTENT_STORE_VERSION, updatedAt: validIso(parsed.updatedAt) ? parsed.updatedAt : new Date(0).toISOString(), approvals: parsed.approvals.map(item => ({ ...item, paths: [...item.paths] })) }
  } catch {
    return { ok: false, code: 'APPROVAL_INTENT_STORE_CORRUPT', message: 'Approval intent store could not be read safely.' }
  }
}

function persistStore(store: ApprovalIntentStore, options?: WorkbenchApprovalIntentStoreOptions): void {
  const target = storePath(options)
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  const retained = [...store.approvals].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-MAX_RECORDS)
  const payload: ApprovalIntentStore = { version: WORKBENCH_APPROVAL_INTENT_STORE_VERSION, updatedAt: nowIso(options), approvals: retained }
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  fs.renameSync(temporary, target)
  fs.chmodSync(target, 0o600)
}

function acquireLock(options?: WorkbenchApprovalIntentStoreOptions): number | undefined {
  const target = lockPath(options)
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + LOCK_WAIT_MS
  while (Date.now() <= deadline) {
    try { return fs.openSync(target, 'wx', 0o600) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        if (Date.now() - fs.statSync(target).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(target); continue }
      } catch {}
    }
  }
  return undefined
}

function withLock<T>(options: WorkbenchApprovalIntentStoreOptions | undefined, callback: (store: ApprovalIntentStore) => T): T | ApprovalIntentFailure {
  let fd: number | undefined
  try {
    fd = acquireLock(options)
    if (fd === undefined) return { ok: false, code: 'APPROVAL_INTENT_STORE_BUSY', message: 'Approval intent store is busy.' }
    const store = readStore(options)
    if ('ok' in store && store.ok === false) return store
    return callback(store as ApprovalIntentStore)
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch {}
      try { fs.unlinkSync(lockPath(options)) } catch {}
    }
  }
}

function expireRecords(store: ApprovalIntentStore, now: string): void {
  const nowMs = Date.parse(now)
  for (const record of store.approvals) {
    if ((record.status === 'pending' || record.status === 'approved') && Date.parse(record.expiresAt) <= nowMs) {
      record.status = 'expired'
      record.updatedAt = now
    }
  }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !['confirmationToken', 'confirmedByUser', 'signal', 'approvalId'].includes(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, stable(item)]))
}

export function buildApprovalRequestDigest(operationKind: string, request: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify({ operationKind, request: stable(request) })).digest('hex')
}

export function ensurePendingApprovalIntent(params: {
  sourceId: string
  runId: string
  sessionId?: string
  requestId?: string
  operationKind: string
  paths: string[]
  reason: string
  requestDigest: string
  ttlMs?: number
  options?: WorkbenchApprovalIntentStoreOptions
}): { ok: true; created: boolean; record: WorkbenchApprovalIntentRecord } | ApprovalIntentFailure {
  const result = withLock(params.options, store => {
    const now = nowIso(params.options)
    expireRecords(store, now)
    const existing = store.approvals.find(item => item.sourceId === params.sourceId && item.runId === params.runId && item.sessionId === params.sessionId && item.operationKind === params.operationKind && item.requestDigest === params.requestDigest && (item.status === 'pending' || item.status === 'approved'))
    if (existing) {
      persistStore(store, params.options)
      return { ok: true as const, created: false, record: { ...existing, paths: [...existing.paths] } }
    }
    const ttlMs = Math.max(30_000, Math.min(params.ttlMs || DEFAULT_TTL_MS, 60 * 60_000))
    const record: WorkbenchApprovalIntentRecord = {
      storeVersion: WORKBENCH_APPROVAL_INTENT_STORE_VERSION,
      approvalId: `approval-${crypto.randomUUID()}`,
      sourceId: params.sourceId,
      runId: params.runId,
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      ...(params.requestId ? { requestId: params.requestId } : {}),
      operationKind: params.operationKind.slice(0, 120),
      paths: [...new Set(params.paths)].slice(0, 32),
      reason: params.reason.slice(0, 160),
      requestDigest: params.requestDigest,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(Date.parse(now) + ttlMs).toISOString()
    }
    store.approvals.push(record)
    persistStore(store, params.options)
    return { ok: true as const, created: true, record: { ...record, paths: [...record.paths] } }
  })
  return result as { ok: true; created: boolean; record: WorkbenchApprovalIntentRecord } | ApprovalIntentFailure
}

export function getPendingApprovalIntent(approvalId: string, options?: WorkbenchApprovalIntentStoreOptions): WorkbenchApprovalIntentRecord | ApprovalIntentFailure | undefined {
  const result = withLock(options, store => {
    const now = nowIso(options)
    const record = store.approvals.find(item => item.approvalId === approvalId)
    if (!record) return undefined
    if ((record.status === 'pending' || record.status === 'approved') && Date.parse(record.expiresAt) <= Date.parse(now)) {
      record.status = 'expired'
      record.updatedAt = now
      persistStore(store, options)
    }
    return { ...record, paths: [...record.paths] }
  })
  return result as WorkbenchApprovalIntentRecord | ApprovalIntentFailure | undefined
}

export function decidePendingApprovalIntent(params: { approvalId: string; sourceId: string; runId: string; sessionId?: string; decision: 'approve' | 'deny'; options?: WorkbenchApprovalIntentStoreOptions }): { ok: true; changed: boolean; record: WorkbenchApprovalIntentRecord } | ApprovalIntentFailure {
  const result = withLock(params.options, store => {
    const now = nowIso(params.options)
    expireRecords(store, now)
    const record = store.approvals.find(item => item.approvalId === params.approvalId)
    if (!record) return { ok: false as const, code: 'APPROVAL_INTENT_NOT_FOUND' as const, message: 'Approval intent was not found.' }
    if (record.sourceId !== params.sourceId || record.runId !== params.runId || record.sessionId !== params.sessionId) return { ok: false as const, code: 'APPROVAL_INTENT_BINDING_MISMATCH' as const, message: 'Approval intent binding does not match.' }
    if (record.status === (params.decision === 'approve' ? 'approved' : 'denied')) return { ok: true as const, changed: false, record: { ...record, paths: [...record.paths] } }
    if (record.status !== 'pending') {
      if (record.status === 'expired') persistStore(store, params.options)
      return { ok: false as const, code: 'APPROVAL_INTENT_NOT_PENDING' as const, message: `Approval intent is ${record.status}.` }
    }
    record.status = params.decision === 'approve' ? 'approved' : 'denied'
    record.decidedAt = now
    record.updatedAt = now
    persistStore(store, params.options)
    return { ok: true as const, changed: true, record: { ...record, paths: [...record.paths] } }
  })
  return result as { ok: true; changed: boolean; record: WorkbenchApprovalIntentRecord } | ApprovalIntentFailure
}

export function consumeMatchingApprovalIntentAfterConfirmedSuccess(params: { sourceId: string; runId: string; sessionId?: string; operationKind: string; requestDigest: string; options?: WorkbenchApprovalIntentStoreOptions }): { ok: true; consumed: boolean; record?: WorkbenchApprovalIntentRecord } | ApprovalIntentFailure {
  const result = withLock(params.options, store => {
    const now = nowIso(params.options)
    expireRecords(store, now)
    const record = store.approvals.find(item => item.sourceId === params.sourceId && item.runId === params.runId && item.sessionId === params.sessionId && item.operationKind === params.operationKind && item.requestDigest === params.requestDigest && (item.status === 'pending' || item.status === 'approved'))
    if (!record) return { ok: true as const, consumed: false }
    record.status = 'consumed'
    record.consumedAt = now
    record.updatedAt = now
    persistStore(store, params.options)
    return { ok: true as const, consumed: true, record: { ...record, paths: [...record.paths] } }
  })
  return result as { ok: true; consumed: boolean; record?: WorkbenchApprovalIntentRecord } | ApprovalIntentFailure
}

export function consumeApprovedApprovalIntent(params: { sourceId: string; runId: string; sessionId?: string; operationKind: string; requestDigest: string; options?: WorkbenchApprovalIntentStoreOptions }): { ok: true; consumed: boolean; record?: WorkbenchApprovalIntentRecord } | ApprovalIntentFailure {
  const result = withLock(params.options, store => {
    const now = nowIso(params.options)
    expireRecords(store, now)
    const record = store.approvals.find(item => item.sourceId === params.sourceId && item.runId === params.runId && item.sessionId === params.sessionId && item.operationKind === params.operationKind && item.requestDigest === params.requestDigest && item.status === 'approved')
    if (!record) {
      persistStore(store, params.options)
      return { ok: true as const, consumed: false }
    }
    record.status = 'consumed'
    record.consumedAt = now
    record.updatedAt = now
    persistStore(store, params.options)
    return { ok: true as const, consumed: true, record: { ...record, paths: [...record.paths] } }
  })
  return result as { ok: true; consumed: boolean; record?: WorkbenchApprovalIntentRecord } | ApprovalIntentFailure
}
