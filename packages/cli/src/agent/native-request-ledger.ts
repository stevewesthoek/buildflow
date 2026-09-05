import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getConfigDir } from '../utils/paths'
import type { WorkbenchOperationId } from '../../../../apps/web/src/lib/actions/portable-operation-contract'

export const NATIVE_REQUEST_LEDGER_VERSION = 1 as const
export const NATIVE_REQUEST_LEDGER_MAX_RECORDS = 500
export const NATIVE_REQUEST_LEDGER_MAX_REPLAY_BYTES = 16_384

export type NativeRequestLedgerStatus = 'in_flight' | 'completed' | 'failed'

export type NativeRequestLedgerRecord = {
  version: typeof NATIVE_REQUEST_LEDGER_VERSION
  requestId: string
  fingerprint: string
  operationId: WorkbenchOperationId
  sourceId?: string
  sessionId?: string
  status: NativeRequestLedgerStatus
  httpStatus?: number
  responseBody?: unknown
  startedAt: string
  updatedAt: string
}

type NativeRequestLedger = {
  version: typeof NATIVE_REQUEST_LEDGER_VERSION
  updatedAt: string
  records: NativeRequestLedgerRecord[]
}

export type NativeRequestLedgerBeginResult =
  | { decision: 'accepted'; requestId: string }
  | { decision: 'in_flight'; record: NativeRequestLedgerRecord }
  | { decision: 'replay'; record: NativeRequestLedgerRecord }
  | { decision: 'recorded_without_body'; record: NativeRequestLedgerRecord }
  | { decision: 'conflict'; record: NativeRequestLedgerRecord }

export class NativeRequestLedgerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NativeRequestLedgerError'
  }
}

function ledgerPath(configDir?: string): string {
  return path.join(configDir || getConfigDir(), 'runtime-state', 'native-request-ledger.json')
}

function emptyLedger(): NativeRequestLedger {
  return {
    version: NATIVE_REQUEST_LEDGER_VERSION,
    updatedAt: new Date().toISOString(),
    records: []
  }
}

function isLedgerRecord(value: unknown): value is NativeRequestLedgerRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<NativeRequestLedgerRecord>
  return record.version === NATIVE_REQUEST_LEDGER_VERSION
    && typeof record.requestId === 'string'
    && typeof record.fingerprint === 'string'
    && typeof record.operationId === 'string'
    && (record.status === 'in_flight' || record.status === 'completed' || record.status === 'failed')
    && typeof record.startedAt === 'string'
    && typeof record.updatedAt === 'string'
}

function readLedger(configDir?: string): NativeRequestLedger {
  const target = ledgerPath(configDir)
  if (!fs.existsSync(target)) return emptyLedger()

  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(target, 'utf8'))
  } catch {
    throw new NativeRequestLedgerError('Native request ledger is unreadable; mutation admission is blocked for recovery.')
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new NativeRequestLedgerError('Native request ledger has an invalid shape; mutation admission is blocked for recovery.')
  }
  const candidate = parsed as Partial<NativeRequestLedger>
  if (candidate.version !== NATIVE_REQUEST_LEDGER_VERSION || !Array.isArray(candidate.records) || !candidate.records.every(isLedgerRecord)) {
    throw new NativeRequestLedgerError('Native request ledger has an unknown version or invalid record; mutation admission is blocked for recovery.')
  }
  return {
    version: NATIVE_REQUEST_LEDGER_VERSION,
    updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : new Date().toISOString(),
    records: candidate.records
  }
}

function persistLedger(ledger: NativeRequestLedger, configDir?: string): void {
  const target = ledgerPath(configDir)
  const directory = path.dirname(target)
  const temporary = `${target}.${process.pid}.tmp`
  const payload: NativeRequestLedger = {
    version: NATIVE_REQUEST_LEDGER_VERSION,
    updatedAt: new Date().toISOString(),
    records: [
      ...ledger.records.filter(record => record.status === 'in_flight'),
      ...ledger.records
        .filter(record => record.status !== 'in_flight')
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
        .slice(-NATIVE_REQUEST_LEDGER_MAX_RECORDS)
    ]
  }

  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  try {
    const descriptor = fs.openSync(temporary, 'w', 0o600)
    try {
      fs.writeFileSync(descriptor, JSON.stringify(payload), 'utf8')
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
    fs.renameSync(temporary, target)
    fs.chmodSync(target, 0o600)
  } catch (error) {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) } catch {}
    throw new NativeRequestLedgerError(`Native request ledger could not be persisted: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function compactResponseBody(body: unknown): { available: boolean; body?: unknown } {
  if (body === undefined) return { available: false }
  let encoded: string
  try {
    encoded = JSON.stringify(body)
  } catch {
    return { available: false }
  }
  if (typeof encoded !== 'string') return { available: false }
  if (Buffer.byteLength(encoded, 'utf8') > NATIVE_REQUEST_LEDGER_MAX_REPLAY_BYTES) return { available: false }
  return { available: true, body }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalize(entry)]))
}

export function buildNativeRequestFingerprint(params: {
  operationId: WorkbenchOperationId
  sourceId?: string
  sessionId?: string
  payload: unknown
}): string {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalize({
      operationId: params.operationId,
      sourceId: params.sourceId,
      sessionId: params.sessionId,
      payload: params.payload
    })))
    .digest('hex')
}

export function beginNativeRequest(params: {
  configDir?: string
  requestId: string
  fingerprint: string
  operationId: WorkbenchOperationId
  sourceId?: string
  sessionId?: string
}): NativeRequestLedgerBeginResult {
  const ledger = readLedger(params.configDir)
  const existing = ledger.records.find(record => record.requestId === params.requestId)
  if (existing) {
    if (existing.fingerprint !== params.fingerprint || existing.operationId !== params.operationId) {
      return { decision: 'conflict', record: existing }
    }
    if (existing.status === 'in_flight') return { decision: 'in_flight', record: existing }
    return existing.responseBody === undefined
      ? { decision: 'recorded_without_body', record: existing }
      : { decision: 'replay', record: existing }
  }

  const now = new Date().toISOString()
  ledger.records.push({
    version: NATIVE_REQUEST_LEDGER_VERSION,
    requestId: params.requestId,
    fingerprint: params.fingerprint,
    operationId: params.operationId,
    sourceId: params.sourceId,
    sessionId: params.sessionId,
    status: 'in_flight',
    startedAt: now,
    updatedAt: now
  })
  persistLedger(ledger, params.configDir)
  return { decision: 'accepted', requestId: params.requestId }
}

export function completeNativeRequest(params: {
  configDir?: string
  requestId: string
  status: NativeRequestLedgerStatus
  httpStatus: number
  responseBody: unknown
}): void {
  const ledger = readLedger(params.configDir)
  const index = ledger.records.findIndex(record => record.requestId === params.requestId)
  if (index < 0) return
  const current = ledger.records[index]
  if (current.status !== 'in_flight') return
  const compact = compactResponseBody(params.responseBody)
  ledger.records[index] = {
    ...current,
    status: params.status,
    httpStatus: params.httpStatus,
    ...(compact.available ? { responseBody: compact.body } : {}),
    updatedAt: new Date().toISOString()
  }
  persistLedger(ledger, params.configDir)
}
