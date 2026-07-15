import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getConfigDir } from '../utils/paths'

export const CAPABILITY_MUTATION_DISPATCH_STORE_VERSION = 1 as const
export type MutationDispatchKind = 'candidate' | 'rollback'
export type MutationDispatchStatus = 'reserved' | 'dispatched' | 'outcome_recorded' | 'reconciliation_required'

export type CapabilityMutationDispatchRecord = {
  dispatchVersion: typeof CAPABILITY_MUTATION_DISPATCH_STORE_VERSION
  dispatchId: string
  operationId: string
  sourceId: string
  workflowId: string
  kind: MutationDispatchKind
  status: MutationDispatchStatus
  artifactSha256: string
  wrapperSha256: string
  authorizationDigest: string
  createdAt: string
  updatedAt: string
  outcome?: 'succeeded' | 'definitively_failed' | 'ambiguous' | 'timed_out'
}

export type CompactCapabilityMutationDispatch = Omit<CapabilityMutationDispatchRecord, 'authorizationDigest'>
export type CapabilityMutationDispatchStoreOptions = { rootDir?: string; now?: () => Date; randomBytes?: (size: number) => Buffer }
type Store = { version: 1; updatedAt: string; records: CapabilityMutationDispatchRecord[] }
export type DispatchFailureCode =
  | 'MUTATION_DISPATCH_STORE_BUSY' | 'MUTATION_DISPATCH_STORE_CORRUPT' | 'MUTATION_DISPATCH_NOT_FOUND'
  | 'MUTATION_DISPATCH_CONFLICT' | 'MUTATION_DISPATCH_AUTHORIZATION_INVALID' | 'MUTATION_DISPATCH_REPLAYED'
  | 'MUTATION_DISPATCH_BINDING_MISMATCH' | 'MUTATION_DISPATCH_INVALID_STATE'
export type DispatchFailure = { ok: false; code: DispatchFailureCode; message: string }

const MAX_RECORDS = 300
const SHA256 = /^[a-f0-9]{64}$/
const id = (value: string) => value.length > 0 && value.length <= 200
const now = (options?: CapabilityMutationDispatchStoreOptions) => (options?.now || (() => new Date()))().toISOString()
const root = (options?: CapabilityMutationDispatchStoreOptions) => path.resolve(options?.rootDir || getConfigDir())
const file = (options?: CapabilityMutationDispatchStoreOptions) => path.join(root(options), 'workbench-capability-mutation-dispatches.json')
const lockFile = (options?: CapabilityMutationDispatchStoreOptions) => `${file(options)}.lock`
const digest = (value: string) => crypto.createHash('sha256').update(value, 'utf8').digest('hex')
const same = (value: string, expected: string) => {
  const a = Buffer.from(digest(value), 'hex'); const b = Buffer.from(expected, 'hex')
  return a.byteLength === b.byteLength && crypto.timingSafeEqual(a, b)
}
const compact = (record: CapabilityMutationDispatchRecord): CompactCapabilityMutationDispatch => {
  const { authorizationDigest: _authorizationDigest, ...publicRecord } = record
  return publicRecord
}
function recordValid(value: unknown): value is CapabilityMutationDispatchRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Partial<CapabilityMutationDispatchRecord>
  return item.dispatchVersion === 1 && id(item.dispatchId || '') && id(item.operationId || '')
    && id(item.sourceId || '') && id(item.workflowId || '') && (item.kind === 'candidate' || item.kind === 'rollback')
    && ['reserved', 'dispatched', 'outcome_recorded', 'reconciliation_required'].includes(item.status || '')
    && SHA256.test(item.artifactSha256 || '') && SHA256.test(item.wrapperSha256 || '') && SHA256.test(item.authorizationDigest || '')
    && typeof item.createdAt === 'string' && typeof item.updatedAt === 'string'
    && (item.outcome === undefined || ['succeeded', 'definitively_failed', 'ambiguous', 'timed_out'].includes(item.outcome))
}
function read(options?: CapabilityMutationDispatchStoreOptions): Store | DispatchFailure {
  const target = file(options)
  if (!fs.existsSync(target)) return { version: 1, updatedAt: now(options), records: [] }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(target, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid store')
    const store = parsed as Partial<Store>
    if (store.version !== 1 || !Array.isArray(store.records) || !store.records.every(recordValid)) throw new Error('invalid store')
    return { version: 1, updatedAt: typeof store.updatedAt === 'string' ? store.updatedAt : now(options), records: store.records }
  } catch {
    return { ok: false, code: 'MUTATION_DISPATCH_STORE_CORRUPT', message: 'Mutation dispatch ledger is corrupt and requires manual intervention.' }
  }
}
function persist(store: Store, options?: CapabilityMutationDispatchStoreOptions) {
  const target = file(options); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  const payload: Store = { version: 1, updatedAt: now(options), records: [...store.records].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-MAX_RECORDS) }
  const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temp, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 }); fs.renameSync(temp, target); fs.chmodSync(target, 0o600)
}
function locked<T>(options: CapabilityMutationDispatchStoreOptions | undefined, callback: (store: Store) => T): T | DispatchFailure {
  const targetLock = lockFile(options); fs.mkdirSync(path.dirname(targetLock), { recursive: true, mode: 0o700 }); let descriptor: number | undefined
  try {
    descriptor = fs.openSync(targetLock, 'wx', 0o600)
    const store = read(options); if ('ok' in store) return store
    const result = callback(store); persist(store, options); return result
  } catch (error) {
    if (error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false, code: 'MUTATION_DISPATCH_STORE_BUSY', message: 'Mutation dispatch ledger is busy.' }
    throw error
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); if (descriptor !== undefined) try { fs.unlinkSync(targetLock) } catch {} }
}
function failure(code: DispatchFailureCode, message: string): DispatchFailure { return { ok: false, code, message } }

/** Reserve once per operation/kind. The only plaintext authorization is returned here. */
export function reserveCapabilityMutationDispatch(params: {
  operationId: string; sourceId: string; workflowId: string; kind: MutationDispatchKind; artifactSha256: string; wrapperSha256: string; store?: CapabilityMutationDispatchStoreOptions
}): { ok: true; authorization: string; dispatch: CompactCapabilityMutationDispatch } | DispatchFailure {
  if (![params.operationId, params.sourceId, params.workflowId].every(id) || !SHA256.test(params.artifactSha256) || !SHA256.test(params.wrapperSha256)) return failure('MUTATION_DISPATCH_BINDING_MISMATCH', 'Mutation dispatch binding is invalid.')
  const random = params.store?.randomBytes || crypto.randomBytes; const authorization = random(32).toString('base64url')
  return locked(params.store, store => {
    if (store.records.some(record => record.operationId === params.operationId && record.kind === params.kind)) return failure('MUTATION_DISPATCH_CONFLICT', 'A dispatch was already reserved for this operation and mutation kind.')
    const timestamp = now(params.store)
    const record: CapabilityMutationDispatchRecord = { dispatchVersion: 1, dispatchId: `dispatch-${crypto.randomUUID()}`, operationId: params.operationId, sourceId: params.sourceId, workflowId: params.workflowId, kind: params.kind, status: 'reserved', artifactSha256: params.artifactSha256, wrapperSha256: params.wrapperSha256, authorizationDigest: digest(authorization), createdAt: timestamp, updatedAt: timestamp }
    store.records.push(record); return { ok: true as const, authorization, dispatch: compact(record) }
  }) as { ok: true; authorization: string; dispatch: CompactCapabilityMutationDispatch } | DispatchFailure
}

/** Consumes authority before spawn. A crash thereafter is conservatively reconciliation-required. */
export function consumeCapabilityMutationDispatch(params: {
  dispatchId: string; authorization: string; operationId: string; sourceId: string; workflowId: string; kind: MutationDispatchKind; artifactSha256: string; wrapperSha256: string; store?: CapabilityMutationDispatchStoreOptions
}): { ok: true; dispatch: CompactCapabilityMutationDispatch } | DispatchFailure {
  return locked(params.store, store => {
    const record = store.records.find(item => item.dispatchId === params.dispatchId)
    if (!record) return failure('MUTATION_DISPATCH_NOT_FOUND', 'Mutation dispatch was not found.')
    if (record.status !== 'reserved') return failure('MUTATION_DISPATCH_REPLAYED', 'Mutation dispatch authorization was already consumed.')
    if (record.operationId !== params.operationId || record.sourceId !== params.sourceId || record.workflowId !== params.workflowId || record.kind !== params.kind || record.artifactSha256 !== params.artifactSha256 || record.wrapperSha256 !== params.wrapperSha256) return failure('MUTATION_DISPATCH_BINDING_MISMATCH', 'Mutation dispatch binding does not match.')
    if (!same(params.authorization, record.authorizationDigest)) return failure('MUTATION_DISPATCH_AUTHORIZATION_INVALID', 'Mutation dispatch authorization is invalid.')
    record.status = 'dispatched'; record.updatedAt = now(params.store); return { ok: true as const, dispatch: compact(record) }
  }) as { ok: true; dispatch: CompactCapabilityMutationDispatch } | DispatchFailure
}

/**
 * Records only that a consumed dispatch reached a host-observed terminal
 * outcome. The outcome classification itself stays in the operation state
 * machine; this ledger must not become a second mutation-policy store.
 */
export function recordCapabilityMutationDispatchOutcome(params: {
  dispatchId: string; operationId: string; sourceId: string; workflowId: string; kind: MutationDispatchKind; artifactSha256: string; wrapperSha256: string; outcome: NonNullable<CapabilityMutationDispatchRecord['outcome']>; store?: CapabilityMutationDispatchStoreOptions
}): { ok: true; dispatch: CompactCapabilityMutationDispatch } | DispatchFailure {
  return locked(params.store, store => {
    const record = store.records.find(item => item.dispatchId === params.dispatchId)
    if (!record) return failure('MUTATION_DISPATCH_NOT_FOUND', 'Mutation dispatch was not found.')
    if (record.status !== 'dispatched') return failure('MUTATION_DISPATCH_INVALID_STATE', 'Only a consumed dispatch can record an outcome.')
    if (record.operationId !== params.operationId || record.sourceId !== params.sourceId || record.workflowId !== params.workflowId || record.kind !== params.kind || record.artifactSha256 !== params.artifactSha256 || record.wrapperSha256 !== params.wrapperSha256) {
      return failure('MUTATION_DISPATCH_BINDING_MISMATCH', 'Mutation dispatch binding does not match.')
    }
    record.status = 'outcome_recorded'; record.outcome = params.outcome; record.updatedAt = now(params.store)
    return { ok: true as const, dispatch: compact(record) }
  }) as { ok: true; dispatch: CompactCapabilityMutationDispatch } | DispatchFailure
}

/**
 * Host adapters retain the short-lived plaintext authorization in memory and
 * expose only this narrow consumption closure to the executor. It cannot mint
 * or replace authority after a crash.
 */
export function createCapabilityMutationDispatchConsumer(params: {
  dispatchId: string; authorization: string; store?: CapabilityMutationDispatchStoreOptions
}): (binding: {
  operationId: string; sourceId: string; workflowId: string; kind: MutationDispatchKind; artifactSha256: string; wrapperSha256: string
}) => { ok: true } | { ok: false; code: string } {
  let authorization = params.authorization
  return binding => {
    if (!authorization) return { ok: false, code: 'MUTATION_DISPATCH_REPLAYED' }
    const result = consumeCapabilityMutationDispatch({ dispatchId: params.dispatchId, authorization, ...binding, store: params.store })
    authorization = ''
    return result.ok ? { ok: true } : { ok: false, code: (result as DispatchFailure).code }
  }
}

export function requireMutationDispatchReconciliation(dispatchId: string, store?: CapabilityMutationDispatchStoreOptions): { ok: true; dispatch: CompactCapabilityMutationDispatch } | DispatchFailure {
  return locked(store, records => { const record = records.records.find(item => item.dispatchId === dispatchId); if (!record) return failure('MUTATION_DISPATCH_NOT_FOUND', 'Mutation dispatch was not found.'); record.status = 'reconciliation_required'; record.updatedAt = now(store); return { ok: true as const, dispatch: compact(record) } }) as { ok: true; dispatch: CompactCapabilityMutationDispatch } | DispatchFailure
}

/** Recovery policy: persisted reserved/dispatched records have lost trustworthy in-memory authority. */
export function reconcilePendingCapabilityMutationDispatches(store?: CapabilityMutationDispatchStoreOptions): { ok: true; dispatches: CompactCapabilityMutationDispatch[] } | DispatchFailure {
  return locked(store, ledger => {
    const updated: CompactCapabilityMutationDispatch[] = []
    for (const record of ledger.records) {
      if (record.status !== 'reserved' && record.status !== 'dispatched') continue
      record.status = 'reconciliation_required'; record.updatedAt = now(store); updated.push(compact(record))
    }
    return { ok: true as const, dispatches: updated }
  }) as { ok: true; dispatches: CompactCapabilityMutationDispatch[] } | DispatchFailure
}

export function getCompactCapabilityMutationDispatch(dispatchId: string, store?: CapabilityMutationDispatchStoreOptions): CompactCapabilityMutationDispatch | DispatchFailure | undefined {
  const ledger = read(store); if ('ok' in ledger) return ledger; const record = ledger.records.find(item => item.dispatchId === dispatchId); return record && compact(record)
}

/** Host-only authoritative read for crash recovery; never expose authorizationDigest publicly. */
export function getCapabilityMutationDispatchRecord(dispatchId: string, store?: CapabilityMutationDispatchStoreOptions): CapabilityMutationDispatchRecord | DispatchFailure | undefined {
  const ledger = read(store); if ('ok' in ledger) return ledger
  const record = ledger.records.find(item => item.dispatchId === dispatchId)
  return record && structuredClone(record)
}

/** Host-only lookup by the operation/kind uniqueness binding used for recovery. */
export function findCapabilityMutationDispatchRecord(operationId: string, kind: MutationDispatchKind, store?: CapabilityMutationDispatchStoreOptions): CapabilityMutationDispatchRecord | DispatchFailure | undefined {
  const ledger = read(store); if ('ok' in ledger) return ledger
  const record = ledger.records.find(item => item.operationId === operationId && item.kind === kind)
  return record && structuredClone(record)
}
