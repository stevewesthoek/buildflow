import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  buildPersistedAutonomyDecision,
  isPersistedAutonomyDecision,
  type AutonomyDecisionEvidenceReference,
  type AutonomyDecisionRequest,
  type PersistedAutonomyDecision,
  type PersistedAutonomyDecisionValue
} from '@workbench/shared'
import { getConfigDir } from '../utils/paths'

export const WORKBENCH_AUTONOMY_DECISION_STORE_VERSION = 1 as const
export const WORKBENCH_AUTONOMY_DECISION_FILENAME = 'workbench-autonomy-decisions.json' as const

const DEFAULT_MAX_RECORDS = 500
const MAX_STORE_BYTES = 2 * 1024 * 1024
const LOCK_WAIT_MS = 250
const LOCK_STALE_MS = 30_000
const RETENTION_AFTER_EXPIRY_MS = 7 * 24 * 60 * 60_000

type AutonomyDecisionStore = {
  version: typeof WORKBENCH_AUTONOMY_DECISION_STORE_VERSION
  updatedAt: string
  decisions: PersistedAutonomyDecision[]
}

export type AutonomyDecisionStoreOptions = {
  rootDir?: string
  storePath?: string
  maxRecords?: number
  now?: () => Date
}

export type AutonomyDecisionStoreFailure = {
  ok: false
  code:
    | 'AUTONOMY_DECISION_INVALID'
    | 'AUTONOMY_DECISION_STORE_BUSY'
    | 'AUTONOMY_DECISION_STORE_CORRUPT'
    | 'AUTONOMY_DECISION_STORE_UNAVAILABLE'
    | 'AUTONOMY_DECISION_CONFLICT'
    | 'AUTONOMY_DECISION_STORE_FULL'
    | 'AUTONOMY_DECISION_STORE_WRITE_FAILED'
  message: string
}

export type AutonomyDecisionLookup =
  | { ok: true; state: 'none' | 'matched' | 'expired' | 'policy_changed'; decision?: PersistedAutonomyDecision }
  | AutonomyDecisionStoreFailure

export type AutonomyDecisionSaveResult =
  | { ok: true; created: boolean; record: PersistedAutonomyDecision }
  | AutonomyDecisionStoreFailure

function target(options: AutonomyDecisionStoreOptions = {}): string {
  if (options.storePath) return path.resolve(options.storePath)
  return path.join(path.resolve(options.rootDir || getConfigDir()), WORKBENCH_AUTONOMY_DECISION_FILENAME)
}

function lockTarget(options: AutonomyDecisionStoreOptions = {}): string {
  return `${target(options)}.lock`
}

function nowIso(options: AutonomyDecisionStoreOptions = {}): string {
  return (options.now || (() => new Date()))().toISOString()
}

function failure(code: AutonomyDecisionStoreFailure['code'], message: string): AutonomyDecisionStoreFailure {
  return { ok: false, code, message }
}

function isFailure(value: AutonomyDecisionStore | AutonomyDecisionStoreFailure): value is AutonomyDecisionStoreFailure {
  return 'ok' in value && value.ok === false
}

function emptyStore(options: AutonomyDecisionStoreOptions = {}): AutonomyDecisionStore {
  return { version: WORKBENCH_AUTONOMY_DECISION_STORE_VERSION, updatedAt: nowIso(options), decisions: [] }
}

function maxRecords(options: AutonomyDecisionStoreOptions): number {
  return Math.min(DEFAULT_MAX_RECORDS, Math.max(1, Math.trunc(options.maxRecords || DEFAULT_MAX_RECORDS)))
}

function storeBytes(store: AutonomyDecisionStore): number {
  return Buffer.byteLength(JSON.stringify(store), 'utf8')
}

function readStore(options: AutonomyDecisionStoreOptions = {}): AutonomyDecisionStore | AutonomyDecisionStoreFailure {
  const file = target(options)
  try {
    if (!fs.existsSync(file)) return emptyStore(options)
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      return failure('AUTONOMY_DECISION_STORE_UNAVAILABLE', 'The autonomy decision store is not a private regular file.')
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AutonomyDecisionStore>
    const limit = maxRecords(options)
    if (parsed.version !== WORKBENCH_AUTONOMY_DECISION_STORE_VERSION
      || typeof parsed.updatedAt !== 'string'
      || !Number.isFinite(Date.parse(parsed.updatedAt))
      || !Array.isArray(parsed.decisions)
      || parsed.decisions.length > limit
      || parsed.decisions.some(item => !isPersistedAutonomyDecision(item))) {
      return failure('AUTONOMY_DECISION_STORE_CORRUPT', 'The autonomy decision store is corrupt and requires recovery.')
    }
    const decisions = parsed.decisions as PersistedAutonomyDecision[]
    const byId = new Set<string>()
    const byFingerprint = new Map<string, PersistedAutonomyDecisionValue>()
    for (const decision of decisions) {
      if (byId.has(decision.decisionId)) return failure('AUTONOMY_DECISION_STORE_CORRUPT', 'The autonomy decision store contains duplicate decision IDs.')
      byId.add(decision.decisionId)
      const previous = byFingerprint.get(decision.requestFingerprint)
      if (previous && previous !== decision.decision) return failure('AUTONOMY_DECISION_STORE_CORRUPT', 'The autonomy decision store contains contradictory decisions.')
      byFingerprint.set(decision.requestFingerprint, decision.decision)
    }
    const store: AutonomyDecisionStore = {
      version: WORKBENCH_AUTONOMY_DECISION_STORE_VERSION,
      updatedAt: parsed.updatedAt,
      decisions: decisions.map(item => ({ ...item, paths: [...item.paths], evidenceRef: { ...item.evidenceRef }, policy: { ...item.policy } }))
    }
    if (storeBytes(store) > MAX_STORE_BYTES) return failure('AUTONOMY_DECISION_STORE_CORRUPT', 'The autonomy decision store exceeds its bounded size.')
    return store
  } catch {
    return failure('AUTONOMY_DECISION_STORE_CORRUPT', 'The autonomy decision store could not be read safely.')
  }
}

function persistStore(store: AutonomyDecisionStore, options: AutonomyDecisionStoreOptions = {}): void {
  const file = target(options)
  const retained = [...store.decisions].sort((left, right) => {
    const byTime = left.createdAt.localeCompare(right.createdAt)
    return byTime !== 0 ? byTime : left.decisionId.localeCompare(right.decisionId)
  })
  const payload: AutonomyDecisionStore = {
    version: WORKBENCH_AUTONOMY_DECISION_STORE_VERSION,
    updatedAt: nowIso(options),
    decisions: retained
  }
  if (payload.decisions.length > maxRecords(options) || storeBytes(payload) > MAX_STORE_BYTES) throw new Error('autonomy decision store size limit exceeded')
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  try {
    fs.writeFileSync(temporary, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    fs.renameSync(temporary, file)
    fs.chmodSync(file, 0o600)
  } finally {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) } catch {}
  }
}

function acquireLock(options: AutonomyDecisionStoreOptions = {}): number | undefined {
  const file = lockTarget(options)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + LOCK_WAIT_MS
  while (Date.now() <= deadline) {
    try { return fs.openSync(file, 'wx', 0o600) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(file); continue }
      } catch {}
    }
  }
  return undefined
}

function withLock<T>(options: AutonomyDecisionStoreOptions, callback: (store: AutonomyDecisionStore) => T): T | AutonomyDecisionStoreFailure {
  let descriptor: number | undefined
  try {
    descriptor = acquireLock(options)
    if (descriptor === undefined) return failure('AUTONOMY_DECISION_STORE_BUSY', 'The autonomy decision store is busy.')
    const store = readStore(options)
    if (isFailure(store)) return store
    return callback(store)
  } catch {
    return failure('AUTONOMY_DECISION_STORE_WRITE_FAILED', 'The autonomy decision store could not be written safely.')
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch {}
      try { fs.unlinkSync(lockTarget(options)) } catch {}
    }
  }
}

function expired(record: PersistedAutonomyDecision, now: string): boolean {
  return Date.parse(record.expiresAt) <= Date.parse(now)
}

function oldExpired(record: PersistedAutonomyDecision, now: string): boolean {
  return Date.parse(record.expiresAt) + RETENTION_AFTER_EXPIRY_MS <= Date.parse(now)
}

function sameCanonicalRecord(left: PersistedAutonomyDecision, right: PersistedAutonomyDecision): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function lookupAutonomyDecision(request: AutonomyDecisionRequest, options: AutonomyDecisionStoreOptions = {}): AutonomyDecisionLookup {
  const result = withLock(options, store => {
    const now = nowIso(options)
    const exact = store.decisions.find(item => item.requestFingerprint === request.requestFingerprint)
    if (exact) return expired(exact, now) ? { ok: true as const, state: 'expired', decision: exact } : { ok: true as const, state: 'matched', decision: exact }
    const priorScope = store.decisions.find(item => item.scopeFingerprint === request.scopeFingerprint && !expired(item, now))
    if (priorScope) return { ok: true as const, state: 'policy_changed' as const, decision: priorScope }
    return { ok: true as const, state: 'none' as const }
  })
  return result as AutonomyDecisionLookup
}

export function saveAutonomyDecision(params: {
  request: AutonomyDecisionRequest
  decision: PersistedAutonomyDecisionValue
  evidenceRef: AutonomyDecisionEvidenceReference
  actorId: string
  createdAt?: string
  expiresAt: string
  options?: AutonomyDecisionStoreOptions
}): AutonomyDecisionSaveResult {
  const options = params.options || {}
  const createdAt = params.createdAt || nowIso(options)
  let candidate: PersistedAutonomyDecision
  try {
    candidate = buildPersistedAutonomyDecision({
      decisionId: `autonomy-decision-${crypto.randomUUID()}`,
      decision: params.decision,
      request: params.request,
      actorId: params.actorId,
      evidenceRef: params.evidenceRef,
      createdAt,
      expiresAt: params.expiresAt
    })
  } catch (error) {
    return failure('AUTONOMY_DECISION_INVALID', error instanceof Error ? error.message : 'Autonomy decision is invalid.')
  }

  const result = withLock(options, store => {
    const now = nowIso(options)
    const exactIndex = store.decisions.findIndex(item => item.requestFingerprint === candidate.requestFingerprint)
    if (exactIndex >= 0) {
      const existing = store.decisions[exactIndex]
      if (!expired(existing, now)) {
        if (existing.decision !== candidate.decision || !sameCanonicalRecord({ ...existing, decisionId: candidate.decisionId }, { ...candidate, decisionId: candidate.decisionId })) {
          return failure('AUTONOMY_DECISION_CONFLICT', 'A valid exact request already has a different or incompatible decision.')
        }
        return { ok: true as const, created: false, record: { ...existing, paths: [...existing.paths] } }
      }
      store.decisions.splice(exactIndex, 1)
    }
    store.decisions = store.decisions.filter(item => !oldExpired(item, now))
    if (store.decisions.length >= maxRecords(options)) return failure('AUTONOMY_DECISION_STORE_FULL', 'The autonomy decision store has no capacity after expired retention pruning.')
    const priorScope = store.decisions.find(item => item.scopeFingerprint === candidate.scopeFingerprint && !expired(item, now))
    if (priorScope && priorScope.policy.fingerprint !== candidate.policy.fingerprint) {
      return failure('AUTONOMY_DECISION_CONFLICT', 'A valid decision exists for this exact scope under a different policy context.')
    }
    store.decisions.push(candidate)
    persistStore(store, options)
    return { ok: true as const, created: true, record: { ...candidate, paths: [...candidate.paths] } }
  })
  return result as AutonomyDecisionSaveResult
}

export function pruneAutonomyDecisions(options: AutonomyDecisionStoreOptions = {}): { ok: true; scanned: number; deleted: number; retained: number } | AutonomyDecisionStoreFailure {
  const result = withLock(options, store => {
    const now = nowIso(options)
    const before = store.decisions.length
    store.decisions = store.decisions.filter(item => !oldExpired(item, now))
    persistStore(store, options)
    return { ok: true as const, scanned: before, deleted: before - store.decisions.length, retained: store.decisions.length }
  })
  return result as { ok: true; scanned: number; deleted: number; retained: number } | AutonomyDecisionStoreFailure
}

export function listAutonomyDecisions(options: AutonomyDecisionStoreOptions = {}): PersistedAutonomyDecision[] | AutonomyDecisionStoreFailure {
  const store = readStore(options)
  if (isFailure(store)) return store
  return store.decisions.map(item => ({ ...item, paths: [...item.paths] }))
}
