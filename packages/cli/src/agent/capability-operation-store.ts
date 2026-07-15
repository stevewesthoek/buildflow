import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getConfigDir } from '../utils/paths'
import {
  isControlledWorkflowMigrationStateTransition,
  type ControlledWorkflowMigrationEvidence,
  type ControlledWorkflowMigrationOperation,
  type ControlledWorkflowMigrationReasonCode
} from '@workbench/shared'

export const CAPABILITY_OPERATION_STORE_VERSION = 1 as const

export type CapabilityOperationStatus =
  | 'prepared'
  | 'queued'
  | 'running'
  | 'reconciling'
  | 'rolling_back'
  | 'completed'
  | 'rolled_back'
  | 'failed'
  | 'manual_intervention_required'
  | 'expired'

export type CapabilityOperationBinding = {
  sourceId: string
  sourceRootFingerprint: string
  grantId: string
  grantVersion: number
  workflowId: string
  mode: 'apply' | 'rollback'
  candidatePath: string
  candidateSha256: string
  rollbackPath: string
  rollbackSha256: string
  manifestPath: string
  manifestSha256: string
  wrapperPath: string
  wrapperSha256: string
  canonicalizationVersion: 1
  candidateCanonicalSha256: string
  rollbackCanonicalSha256: string
  expectedLiveCanonicalSha256: string
  apiOriginFingerprint?: string
}

export type CapabilityOperationLease = {
  leaseProof: string
  owner: string
  acquiredAt: string
  expiresAt: string
}

export type CapabilityOperationRecord = {
  storeVersion: typeof CAPABILITY_OPERATION_STORE_VERSION
  operationId: string
  status: CapabilityOperationStatus
  binding: CapabilityOperationBinding
  confirmationTokenHash: string
  confirmationExpiresAt: string
  confirmationConsumedAt?: string
  createdAt: string
  updatedAt: string
  lease?: CapabilityOperationLease
  candidateUpdateRequests: 0 | 1
  rollbackUpdateRequests: 0 | 1
  readbackRequests: number
  reason?: string
  reasonCode?: ControlledWorkflowMigrationReasonCode
  evidence?: ControlledWorkflowMigrationEvidence
  /** Monotonic CAS revision.  It is never supplied by a state-machine effect. */
  revision: number
}

type CapabilityOperationStore = {
  version: typeof CAPABILITY_OPERATION_STORE_VERSION
  updatedAt: string
  operations: CapabilityOperationRecord[]
}

export type CompactCapabilityOperation = Omit<CapabilityOperationRecord, 'confirmationTokenHash' | 'lease'> & {
  lease?: Omit<CapabilityOperationLease, 'leaseProof'>
}

export type CapabilityStoreFailure = {
  ok: false
  code:
    | 'CAPABILITY_OPERATION_STORE_BUSY'
    | 'CAPABILITY_OPERATION_NOT_FOUND'
    | 'CAPABILITY_OPERATION_INVALID_STATE'
    | 'CAPABILITY_OPERATION_CONFIRMATION_INVALID'
    | 'CAPABILITY_OPERATION_CONFIRMATION_EXPIRED'
    | 'CAPABILITY_OPERATION_CONFIRMATION_REPLAYED'
    | 'CAPABILITY_OPERATION_LEASE_CONFLICT'
    | 'CAPABILITY_OPERATION_REVISION_CONFLICT'
    | 'CAPABILITY_OPERATION_IMMUTABLE_MISMATCH'
    | 'CAPABILITY_OPERATION_LEASE_INVALID'
    | 'CAPABILITY_OPERATION_STORE_CORRUPT'
  message: string
}

export type CapabilityOperationStoreOptions = {
  rootDir?: string
}

const MAX_OPERATION_RECORDS = 300
const MIN_LEASE_MS = 5_000
const MAX_LEASE_MS = 930_000

function resolvedRoot(options?: CapabilityOperationStoreOptions): string {
  return options?.rootDir ? path.resolve(options.rootDir) : getConfigDir()
}

function storePath(options?: CapabilityOperationStoreOptions): string {
  return path.join(resolvedRoot(options), 'workbench-capability-operations.json')
}

function lockPath(options?: CapabilityOperationStoreOptions): string {
  return `${storePath(options)}.lock`
}

function emptyStore(): CapabilityOperationStore {
  return { version: CAPABILITY_OPERATION_STORE_VERSION, updatedAt: new Date().toISOString(), operations: [] }
}

const STATUS_VALUES = new Set<CapabilityOperationStatus>([
  'prepared', 'queued', 'running', 'reconciling', 'rolling_back', 'completed', 'rolled_back', 'failed', 'manual_intervention_required', 'expired'
])
const SHA256 = /^[a-f0-9]{64}$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && ISO_DATE.test(value) && Number.isFinite(Date.parse(value))
}

function isBinding(value: unknown): value is CapabilityOperationBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const binding = value as Partial<CapabilityOperationBinding>
  return typeof binding.sourceId === 'string' && binding.sourceId.length > 0
    && typeof binding.sourceRootFingerprint === 'string' && SHA256.test(binding.sourceRootFingerprint)
    && typeof binding.grantId === 'string' && binding.grantId.length > 0
    && Number.isInteger(binding.grantVersion) && (binding.grantVersion || 0) >= 1
    && typeof binding.workflowId === 'string' && binding.workflowId.length > 0
    && (binding.mode === 'apply' || binding.mode === 'rollback')
    && typeof binding.candidatePath === 'string' && binding.candidatePath.length > 0
    && typeof binding.rollbackPath === 'string' && binding.rollbackPath.length > 0
    && typeof binding.manifestPath === 'string' && binding.manifestPath.length > 0
    && typeof binding.wrapperPath === 'string' && binding.wrapperPath.length > 0
    && binding.canonicalizationVersion === 1
    && [binding.candidateSha256, binding.rollbackSha256, binding.manifestSha256, binding.wrapperSha256, binding.candidateCanonicalSha256, binding.rollbackCanonicalSha256, binding.expectedLiveCanonicalSha256].every(item => typeof item === 'string' && SHA256.test(item))
    && (binding.apiOriginFingerprint === undefined || (typeof binding.apiOriginFingerprint === 'string' && SHA256.test(binding.apiOriginFingerprint)))
}

function isEvidence(value: unknown): value is ControlledWorkflowMigrationEvidence | undefined {
  if (value === undefined) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const evidence = value as ControlledWorkflowMigrationEvidence
  return (evidence.observedCanonicalSha256 === undefined || SHA256.test(evidence.observedCanonicalSha256))
    && (evidence.protectedDomains === undefined || evidence.protectedDomains === 'unchanged' || evidence.protectedDomains === 'unverified')
    && (evidence.mutationResult === undefined || ['not_started', 'succeeded', 'definitively_failed', 'ambiguous', 'timed_out'].includes(evidence.mutationResult))
    && (evidence.readbackResult === undefined || ['matches_candidate', 'matches_rollback', 'matches_pre_mutation', 'unexpected_state', 'unavailable'].includes(evidence.readbackResult))
    && (evidence.rollbackResult === undefined || ['not_attempted', 'succeeded', 'definitively_failed', 'ambiguous', 'timed_out'].includes(evidence.rollbackResult))
    && (evidence.durationMs === undefined || (Number.isInteger(evidence.durationMs) && evidence.durationMs >= 0 && evidence.durationMs <= 900_000))
}

function isLease(value: unknown): value is CapabilityOperationLease | undefined {
  if (value === undefined) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const lease = value as Partial<CapabilityOperationLease>
  return typeof lease.leaseProof === 'string' && lease.leaseProof.length >= 20 && lease.leaseProof.length <= 300
    && typeof lease.owner === 'string' && lease.owner.length > 0 && lease.owner.length <= 160
    && isIsoDate(lease.acquiredAt) && isIsoDate(lease.expiresAt)
    && Date.parse(lease.expiresAt) > Date.parse(lease.acquiredAt)
}

function isRecord(value: unknown): value is CapabilityOperationRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<CapabilityOperationRecord>
  return record.storeVersion === CAPABILITY_OPERATION_STORE_VERSION
    && typeof record.operationId === 'string'
    && typeof record.operationId === 'string' && record.operationId.length > 0 && record.operationId.length <= 200
    && typeof record.status === 'string' && STATUS_VALUES.has(record.status as CapabilityOperationStatus)
    && isBinding(record.binding)
    && typeof record.confirmationTokenHash === 'string' && SHA256.test(record.confirmationTokenHash)
    && isIsoDate(record.confirmationExpiresAt)
    && (record.confirmationConsumedAt === undefined || isIsoDate(record.confirmationConsumedAt))
    && isIsoDate(record.createdAt) && isIsoDate(record.updatedAt)
    && isLease(record.lease)
    && record.candidateUpdateRequests !== undefined && (record.candidateUpdateRequests === 0 || record.candidateUpdateRequests === 1)
    && record.rollbackUpdateRequests !== undefined && (record.rollbackUpdateRequests === 0 || record.rollbackUpdateRequests === 1)
    && Number.isInteger(record.readbackRequests) && (record.readbackRequests || 0) >= 0 && (record.readbackRequests || 0) <= 10
    && Number.isInteger(record.revision) && (record.revision || 0) >= 0 && (record.revision || 0) <= Number.MAX_SAFE_INTEGER
    && (record.reason === undefined || (typeof record.reason === 'string' && record.reason.length <= 500))
    && isEvidence(record.evidence)
}

function storeCorrupt(): CapabilityStoreFailure {
  return { ok: false, code: 'CAPABILITY_OPERATION_STORE_CORRUPT', message: 'The capability operation store is corrupt and requires manual recovery.' }
}

function readStore(options?: CapabilityOperationStoreOptions): CapabilityOperationStore | CapabilityStoreFailure {
  try {
    const filePath = storePath(options)
    if (!fs.existsSync(filePath)) return emptyStore()
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<CapabilityOperationStore>
    if (parsed.version !== CAPABILITY_OPERATION_STORE_VERSION
      || typeof parsed.updatedAt !== 'string'
      || !Array.isArray(parsed.operations)
      || !parsed.operations.every(isRecord)) return storeCorrupt()
    return {
      version: CAPABILITY_OPERATION_STORE_VERSION,
      updatedAt: parsed.updatedAt,
      operations: parsed.operations
    }
  } catch {
    return storeCorrupt()
  }
}

function persistStore(store: CapabilityOperationStore, options?: CapabilityOperationStoreOptions): void {
  const filePath = storePath(options)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const payload: CapabilityOperationStore = {
    version: CAPABILITY_OPERATION_STORE_VERSION,
    updatedAt: new Date().toISOString(),
    operations: [...store.operations]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-MAX_OPERATION_RECORDS)
  }
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temporaryPath, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(temporaryPath, filePath)
  fs.chmodSync(filePath, 0o600)
}

function withExclusiveStoreLock<T>(options: CapabilityOperationStoreOptions | undefined, callback: (store: CapabilityOperationStore) => T): T | CapabilityStoreFailure | undefined {
  const filePath = storePath(options)
  const fileLockPath = lockPath(options)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(fileLockPath, 'wx', 0o600)
    const store = readStore(options)
    if ('ok' in store) return store
    const result = callback(store)
    persistStore(store, options)
    return result
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code)
      : ''
    if (code === 'EEXIST') return undefined
    throw error
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    try {
      if (descriptor !== undefined && fs.existsSync(fileLockPath)) fs.unlinkSync(fileLockPath)
    } catch {
      // Unknown lock state requires explicit operator recovery.
    }
  }
}

function confirmationDigest(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

function safeConfirmationMatch(value: string, expectedHash: string): boolean {
  const actual = Buffer.from(confirmationDigest(value), 'hex')
  const expected = Buffer.from(expectedHash, 'hex')
  return actual.byteLength === expected.byteLength && crypto.timingSafeEqual(actual, expected)
}

function safeLeaseProofMatch(value: string, expected: string): boolean {
  const actualBytes = Buffer.from(value, 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  return actualBytes.byteLength === expectedBytes.byteLength && crypto.timingSafeEqual(actualBytes, expectedBytes)
}

function compact(record: CapabilityOperationRecord): CompactCapabilityOperation {
  const { confirmationTokenHash: _confirmationTokenHash, lease, ...rest } = record
  return {
    ...rest,
    lease: lease ? { owner: lease.owner, acquiredAt: lease.acquiredAt, expiresAt: lease.expiresAt } : undefined
  }
}

function storeBusy(): CapabilityStoreFailure {
  return { ok: false, code: 'CAPABILITY_OPERATION_STORE_BUSY', message: 'The capability operation store is busy.' }
}

export function createPreparedCapabilityOperation(params: {
  binding: CapabilityOperationBinding
  confirmationTtlSeconds: number
  now?: Date
  store?: CapabilityOperationStoreOptions
}): { ok: true; confirmationToken: string; operation: CompactCapabilityOperation } | CapabilityStoreFailure {
  const now = params.now || new Date()
  const ttlSeconds = Math.max(30, Math.min(Math.trunc(params.confirmationTtlSeconds), 3600))
  const confirmationToken = crypto.randomBytes(32).toString('base64url')
  const operationId = `cap-op-${crypto.randomUUID()}`
  const created = withExclusiveStoreLock(params.store, store => {
    const record: CapabilityOperationRecord = {
      storeVersion: CAPABILITY_OPERATION_STORE_VERSION,
      operationId,
      status: 'prepared',
      binding: { ...params.binding },
      confirmationTokenHash: confirmationDigest(confirmationToken),
      confirmationExpiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      candidateUpdateRequests: 0,
      rollbackUpdateRequests: 0,
      readbackRequests: 0,
      revision: 0
    }
    store.operations.push(record)
    return compact(record)
  })
  if (!created) return storeBusy()
  if ('ok' in created) return created
  return { ok: true, confirmationToken, operation: created }
}

/** Persist the exact prepared operation produced by the portable state machine. */
export function persistPreparedCapabilityOperation(params: {
  operation: ControlledWorkflowMigrationOperation
  confirmationToken: string
  store?: CapabilityOperationStoreOptions
}): { ok: true; operation: CompactCapabilityOperation } | CapabilityStoreFailure {
  const created = withExclusiveStoreLock(params.store, store => {
    if (store.operations.some(item => item.operationId === params.operation.operationId)) {
      return { ok: false, code: 'CAPABILITY_OPERATION_INVALID_STATE', message: 'Capability operation already exists.' } as CapabilityStoreFailure
    }
    const record: CapabilityOperationRecord = {
      ...params.operation,
      binding: { ...params.operation.binding },
      confirmationTokenHash: confirmationDigest(params.confirmationToken),
      lease: undefined,
      revision: 0
    }
    if (record.status !== 'prepared' || !isRecord(record)) {
      return { ok: false, code: 'CAPABILITY_OPERATION_INVALID_STATE', message: 'Portable prepared operation is invalid.' } as CapabilityStoreFailure
    }
    store.operations.push(record)
    return { ok: true, operation: compact(record) } as const
  })
  if (!created) return storeBusy()
  return 'ok' in created ? created : { ok: true, operation: created }
}

export function consumeCapabilityOperationConfirmation(params: {
  operationId: string
  confirmationToken: string
  now?: Date
  store?: CapabilityOperationStoreOptions
}): { ok: true; operation: CompactCapabilityOperation } | CapabilityStoreFailure {
  const now = params.now || new Date()
  const result = withExclusiveStoreLock(params.store, store => {
    const record = store.operations.find(item => item.operationId === params.operationId)
    if (!record) return { ok: false, code: 'CAPABILITY_OPERATION_NOT_FOUND', message: 'Capability operation not found.' } as CapabilityStoreFailure
    if (record.confirmationConsumedAt) return { ok: false, code: 'CAPABILITY_OPERATION_CONFIRMATION_REPLAYED', message: 'Confirmation was already consumed.' } as CapabilityStoreFailure
    if (Date.parse(record.confirmationExpiresAt) <= now.getTime()) {
      record.status = 'expired'
      record.updatedAt = now.toISOString()
      return { ok: false, code: 'CAPABILITY_OPERATION_CONFIRMATION_EXPIRED', message: 'Confirmation has expired.' } as CapabilityStoreFailure
    }
    if (record.status !== 'prepared') return { ok: false, code: 'CAPABILITY_OPERATION_INVALID_STATE', message: 'Operation is not prepared.' } as CapabilityStoreFailure
    if (!safeConfirmationMatch(params.confirmationToken, record.confirmationTokenHash)) {
      return { ok: false, code: 'CAPABILITY_OPERATION_CONFIRMATION_INVALID', message: 'Confirmation token is invalid.' } as CapabilityStoreFailure
    }
    record.confirmationConsumedAt = now.toISOString()
    record.status = 'queued'
    record.updatedAt = now.toISOString()
    record.revision += 1
    return { ok: true, operation: compact(record) } as const
  })
  return !result ? storeBusy() : result
}

export function acquireCapabilityOperationLease(params: {
  operationId: string
  owner: string
  leaseMs: number
  now?: Date
  store?: CapabilityOperationStoreOptions
}): { ok: true; leaseProof: string; operation: CompactCapabilityOperation } | CapabilityStoreFailure {
  const now = params.now || new Date()
  const leaseMs = Math.max(MIN_LEASE_MS, Math.min(Math.trunc(params.leaseMs), MAX_LEASE_MS))
  const result = withExclusiveStoreLock(params.store, store => {
    const record = store.operations.find(item => item.operationId === params.operationId)
    if (!record) return { ok: false, code: 'CAPABILITY_OPERATION_NOT_FOUND', message: 'Capability operation not found.' } as CapabilityStoreFailure
    if (record.lease && Date.parse(record.lease.expiresAt) > now.getTime()) {
      return { ok: false, code: 'CAPABILITY_OPERATION_LEASE_CONFLICT', message: 'Another invocation holds the active operation lease.' } as CapabilityStoreFailure
    }
    const expiredOwnLease = Boolean(record.lease && Date.parse(record.lease.expiresAt) <= now.getTime())
    if (expiredOwnLease) {
      record.status = 'reconciling'
      record.lease = undefined
    }
    if (record.status !== 'queued' && record.status !== 'reconciling') {
      return { ok: false, code: 'CAPABILITY_OPERATION_INVALID_STATE', message: 'Operation is not eligible for execution.' } as CapabilityStoreFailure
    }
    const conflicting = store.operations.find(item => {
      if (item.operationId === record.operationId || !item.lease) return false
      if (item.binding.sourceId !== record.binding.sourceId || item.binding.workflowId !== record.binding.workflowId) return false
      return Date.parse(item.lease.expiresAt) > now.getTime()
    })
    if (conflicting) return { ok: false, code: 'CAPABILITY_OPERATION_LEASE_CONFLICT', message: 'Another operation holds the workflow lease.' } as CapabilityStoreFailure
    const leaseProof = `cap-lease-${crypto.randomUUID()}`
    record.lease = {
      leaseProof,
      owner: params.owner.slice(0, 160),
      acquiredAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + leaseMs).toISOString()
    }
    record.status = expiredOwnLease || record.status === 'reconciling' ? 'reconciling' : 'running'
    record.updatedAt = now.toISOString()
    record.revision += 1
    return { ok: true, leaseProof, operation: compact(record) } as const
  })
  return !result ? storeBusy() : result
}

/** Extend only the caller-owned active lease using the current CAS revision. */
export function renewCapabilityOperationLease(params: {
  operationId: string
  sourceId: string
  workflowId: string
  expectedRevision: number
  leaseProof: string
  leaseMs: number
  now?: Date
  store?: CapabilityOperationStoreOptions
}): { ok: true; operation: CompactCapabilityOperation } | CapabilityStoreFailure {
  const now = params.now || new Date()
  const leaseMs = Math.max(MIN_LEASE_MS, Math.min(Math.trunc(params.leaseMs), MAX_LEASE_MS))
  const result = withExclusiveStoreLock(params.store, store => {
    const record = store.operations.find(item => item.operationId === params.operationId)
    if (!record) return { ok: false, code: 'CAPABILITY_OPERATION_NOT_FOUND', message: 'Capability operation not found.' } as CapabilityStoreFailure
    if (record.binding.sourceId !== params.sourceId || record.binding.workflowId !== params.workflowId) return { ok: false, code: 'CAPABILITY_OPERATION_IMMUTABLE_MISMATCH', message: 'Operation binding does not match.' } as CapabilityStoreFailure
    if (record.revision !== params.expectedRevision) return { ok: false, code: 'CAPABILITY_OPERATION_REVISION_CONFLICT', message: 'Capability operation revision is stale.' } as CapabilityStoreFailure
    if (!record.lease || Date.parse(record.lease.expiresAt) <= now.getTime() || !safeLeaseProofMatch(params.leaseProof, record.lease.leaseProof)) {
      return { ok: false, code: 'CAPABILITY_OPERATION_LEASE_INVALID', message: 'The active lease proof is invalid or expired.' } as CapabilityStoreFailure
    }
    if (record.status !== 'running' && record.status !== 'reconciling' && record.status !== 'rolling_back') {
      return { ok: false, code: 'CAPABILITY_OPERATION_INVALID_STATE', message: 'Operation is not actively leased.' } as CapabilityStoreFailure
    }
    record.lease.expiresAt = new Date(now.getTime() + leaseMs).toISOString()
    record.updatedAt = now.toISOString()
    record.revision += 1
    return { ok: true, operation: compact(record) } as const
  })
  return !result ? storeBusy() : result
}

export function getCompactCapabilityOperation(operationId: string, options?: CapabilityOperationStoreOptions): CompactCapabilityOperation | CapabilityStoreFailure | undefined {
  const store = readStore(options)
  if ('ok' in store) return store
  const record = store.operations.find(item => item.operationId === operationId)
  return record ? compact(record) : undefined
}

/** Host-only authoritative read. Never project this record through an adapter. */
export function getCapabilityOperationRecord(operationId: string, options?: CapabilityOperationStoreOptions): CapabilityOperationRecord | CapabilityStoreFailure | undefined {
  const store = readStore(options)
  if ('ok' in store) return store
  const record = store.operations.find(item => item.operationId === operationId)
  return record ? structuredClone(record) : undefined
}

type PortableOperationUpdate = Omit<CapabilityOperationRecord, 'confirmationTokenHash' | 'lease' | 'revision'> & {
  /** A supplied hash must match; callers normally omit this host-only field. */
  confirmationTokenHash?: string
  /** A portable state may include lease metadata but never controls its proof. */
  lease?: Omit<CapabilityOperationLease, 'leaseProof'>
}

function equalBinding(left: CapabilityOperationBinding, right: CapabilityOperationBinding): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function immutableMatches(current: CapabilityOperationRecord, next: PortableOperationUpdate): boolean {
  return current.operationId === next.operationId
    && equalBinding(current.binding, next.binding)
    && current.confirmationExpiresAt === next.confirmationExpiresAt
    && current.createdAt === next.createdAt
    && (next.confirmationTokenHash === undefined || next.confirmationTokenHash === current.confirmationTokenHash)
    && (next.confirmationConsumedAt === undefined || next.confirmationConsumedAt === current.confirmationConsumedAt)
}

function safeMutableRecord(current: CapabilityOperationRecord, next: PortableOperationUpdate): CapabilityOperationRecord {
  return {
    ...current,
    status: next.status,
    updatedAt: next.updatedAt,
    candidateUpdateRequests: next.candidateUpdateRequests,
    rollbackUpdateRequests: next.rollbackUpdateRequests,
    readbackRequests: next.readbackRequests,
    ...(next.reason === undefined ? { reason: undefined } : { reason: next.reason.slice(0, 500) }),
    ...(next.reasonCode === undefined ? { reasonCode: undefined } : { reasonCode: next.reasonCode }),
    ...(next.evidence === undefined ? { evidence: undefined } : { evidence: next.evidence }),
    ...(next.lease === undefined ? {} : { lease: current.lease })
  }
}

/**
 * Persist an already-decided portable state-machine transition using a
 * compare-and-set revision.  The host may not write arbitrary state patches.
 */
export function transitionCapabilityOperation(params: {
  operationId: string
  sourceId: string
  workflowId: string
  expectedStatus: CapabilityOperationStatus
  expectedRevision: number
  next: PortableOperationUpdate
  leaseProof?: string
  now?: Date
  store?: CapabilityOperationStoreOptions
}): { ok: true; operation: CompactCapabilityOperation } | CapabilityStoreFailure {
  const now = params.now || new Date()
  const result = withExclusiveStoreLock(params.store, store => {
    const current = store.operations.find(item => item.operationId === params.operationId)
    if (!current) return { ok: false, code: 'CAPABILITY_OPERATION_NOT_FOUND', message: 'Capability operation not found.' } as CapabilityStoreFailure
    if (current.binding.sourceId !== params.sourceId || current.binding.workflowId !== params.workflowId) return { ok: false, code: 'CAPABILITY_OPERATION_IMMUTABLE_MISMATCH', message: 'Operation binding does not match.' } as CapabilityStoreFailure
    if (current.revision !== params.expectedRevision) return { ok: false, code: 'CAPABILITY_OPERATION_REVISION_CONFLICT', message: 'Capability operation revision is stale.' } as CapabilityStoreFailure
    if (current.status !== params.expectedStatus) return { ok: false, code: 'CAPABILITY_OPERATION_INVALID_STATE', message: 'Capability operation status is stale.' } as CapabilityStoreFailure
    if (!immutableMatches(current, params.next)) return { ok: false, code: 'CAPABILITY_OPERATION_IMMUTABLE_MISMATCH', message: 'Immutable operation authority cannot change.' } as CapabilityStoreFailure
    if (!isControlledWorkflowMigrationStateTransition(current.status, params.next.status)) return { ok: false, code: 'CAPABILITY_OPERATION_INVALID_STATE', message: 'The requested state transition is not legal.' } as CapabilityStoreFailure
    if (current.status !== params.next.status && ['completed', 'rolled_back', 'failed', 'manual_intervention_required', 'expired'].includes(current.status)) return { ok: false, code: 'CAPABILITY_OPERATION_INVALID_STATE', message: 'Terminal operations cannot transition.' } as CapabilityStoreFailure
    const requiresLease = current.status === 'running' || current.status === 'reconciling' || current.status === 'rolling_back'
    if (requiresLease) {
      if (!current.lease || !params.leaseProof || !safeLeaseProofMatch(params.leaseProof, current.lease.leaseProof) || Date.parse(current.lease.expiresAt) <= now.getTime()) {
        return { ok: false, code: 'CAPABILITY_OPERATION_LEASE_INVALID', message: 'A valid active lease is required.' } as CapabilityStoreFailure
      }
    }
    const replacement = safeMutableRecord(current, params.next)
    replacement.updatedAt = now.toISOString()
    replacement.revision = current.revision + 1
    const index = store.operations.findIndex(item => item.operationId === current.operationId)
    store.operations[index] = replacement
    return { ok: true, operation: compact(replacement) } as const
  })
  return !result ? storeBusy() : result
}

/** Release exactly the caller-owned active lease with a CAS revision. */
export function releaseCapabilityOperationLease(params: {
  operationId: string
  sourceId: string
  workflowId: string
  expectedRevision: number
  leaseProof: string
  now?: Date
  store?: CapabilityOperationStoreOptions
}): { ok: true; operation: CompactCapabilityOperation } | CapabilityStoreFailure {
  const now = params.now || new Date()
  const result = withExclusiveStoreLock(params.store, store => {
    const record = store.operations.find(item => item.operationId === params.operationId)
    if (!record) return { ok: false, code: 'CAPABILITY_OPERATION_NOT_FOUND', message: 'Capability operation not found.' } as CapabilityStoreFailure
    if (record.binding.sourceId !== params.sourceId || record.binding.workflowId !== params.workflowId) return { ok: false, code: 'CAPABILITY_OPERATION_IMMUTABLE_MISMATCH', message: 'Operation binding does not match.' } as CapabilityStoreFailure
    if (record.revision !== params.expectedRevision) return { ok: false, code: 'CAPABILITY_OPERATION_REVISION_CONFLICT', message: 'Capability operation revision is stale.' } as CapabilityStoreFailure
    if (!record.lease || Date.parse(record.lease.expiresAt) <= now.getTime() || !safeLeaseProofMatch(params.leaseProof, record.lease.leaseProof)) {
      return { ok: false, code: 'CAPABILITY_OPERATION_LEASE_INVALID', message: 'The active lease proof is invalid or expired.' } as CapabilityStoreFailure
    }
    record.lease = undefined
    record.updatedAt = now.toISOString()
    record.revision += 1
    return { ok: true, operation: compact(record) } as const
  })
  return !result ? storeBusy() : result
}
