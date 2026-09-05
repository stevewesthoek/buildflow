import crypto from 'node:crypto'
import {
  WORKBENCH_EVIDENCE_PAGE_DEFAULT_BYTES,
  WORKBENCH_EVIDENCE_PAGE_MAX_BYTES,
  WORKBENCH_EVIDENCE_MAX_CONTENT_BYTES,
  WorkbenchEvidenceRecordSchema,
  type WorkbenchEvidenceOwner,
  type WorkbenchEvidenceReadOwner,
  type WorkbenchEvidenceRecord,
  workbenchEvidenceIdSchema
} from '@workbench/shared'
import {
  readWorkbenchEvidence,
  type WorkbenchEvidenceStoreFailure,
  type WorkbenchEvidenceStoreOptions
} from './workbench-evidence-store'
import { redactSecrets } from './safe-access'
import {
  getWorkbenchSession,
  type WorkbenchSessionRecord,
  type WorkbenchSessionStoreOptions
} from './workbench-session-store'
import { getWorkbenchValidationJob, type WorkbenchValidationJobRecord } from './workbench-validation-jobs'
import { readWorkbenchReadResultAsEvidence, type WorkbenchReadResultRecoveryOptions } from './workbench-read-result-recovery'

export type WorkbenchEvidenceReadFailureCode =
  | 'EVIDENCE_ID_INVALID'
  | 'EVIDENCE_NOT_FOUND'
  | 'EVIDENCE_CURSOR_INVALID'
  | 'EVIDENCE_PAGE_INVALID'
  | 'EVIDENCE_PAGE_TOO_LARGE'
  | 'EVIDENCE_CONTENT_TOO_LARGE'
  | 'EVIDENCE_STORE_CORRUPT'
  | 'EVIDENCE_STORE_UNAVAILABLE'
  | 'EVIDENCE_REDACTION_FAILED'
  | 'EVIDENCE_RESULT_REF_UNAVAILABLE'

export type WorkbenchEvidenceReadFailure = {
  ok: false
  code: WorkbenchEvidenceReadFailureCode
  message: string
}

export type WorkbenchEvidencePage = {
  evidenceId: string
  kind: WorkbenchEvidenceRecord['kind']
  metadata: Omit<WorkbenchEvidenceRecord, 'content'>
  text: string
  offset: number
  returnedBytes: number
  totalBytes: number
  complete: boolean
  redactionState: WorkbenchEvidenceRecord['redactionState']
  contentHashVerified: true
  returnedSha256: string
  resultRef?: string
  nextCursor?: string
}

export type WorkbenchEvidenceReadResult =
  | { ok: true; page: WorkbenchEvidencePage }
  | WorkbenchEvidenceReadFailure

export type WorkbenchEvidenceReadOptions = {
  evidenceStore?: WorkbenchEvidenceStoreOptions
  readResultRecovery?: WorkbenchReadResultRecoveryOptions
  sessionStore?: WorkbenchSessionStoreOptions
  redactContent?: (content: string) => string
}

type EvidenceCursor = {
  version: 1
  evidenceId: string
  sourceId: string
  ownerSha256: string
  offset: number
}

const OWNER_BINDING_KEYS: Array<keyof WorkbenchEvidenceReadOwner> = [
  'sessionId',
  'runId',
  'taskId',
  'packetId',
  'requestId',
  'operationId',
  'providerId'
]

function failure(code: WorkbenchEvidenceReadFailureCode, message: string): WorkbenchEvidenceReadFailure {
  return { ok: false, code, message }
}

function notFound(): WorkbenchEvidenceReadFailure {
  return failure('EVIDENCE_NOT_FOUND', 'Evidence was not found for the selected source and session.')
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => stableSerialize(item)).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(object[key])}`).join(',')}}`
}

function encodeCursor(cursor: EvidenceCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeCursor(value: string): EvidenceCursor | undefined {
  if (!value || value.length > 2000) return undefined
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8')
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== value) return undefined
    const parsed = JSON.parse(decoded) as Partial<EvidenceCursor>
    if (parsed.version !== 1
      || typeof parsed.evidenceId !== 'string'
      || typeof parsed.sourceId !== 'string'
      || !/^[a-f0-9]{64}$/.test(String(parsed.ownerSha256))
      || !Number.isSafeInteger(parsed.offset)
      || Number(parsed.offset) < 0) return undefined
    return parsed as EvidenceCursor
  } catch {
    return undefined
  }
}

function utf8SafeEnd(buffer: Buffer, start: number, proposedEnd: number): number {
  let end = proposedEnd
  while (end > start && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end -= 1
  return end > start ? end : Math.min(buffer.length, start + 1)
}

function storeFailureToReadFailure(result: WorkbenchEvidenceStoreFailure): WorkbenchEvidenceReadFailure {
  if (result.code === 'EVIDENCE_STORE_CORRUPT') {
    return failure('EVIDENCE_STORE_CORRUPT', 'The evidence store is corrupt and requires recovery.')
  }
  if (result.code === 'EVIDENCE_STORE_BUSY') {
    return failure('EVIDENCE_STORE_UNAVAILABLE', 'The evidence store is temporarily unavailable.')
  }
  return failure('EVIDENCE_STORE_UNAVAILABLE', 'The evidence store is unavailable.')
}

function isSessionFailure(value: WorkbenchSessionRecord | { ok: false } | undefined): value is { ok: false } {
  return Boolean(value && typeof value === 'object' && 'ok' in value && value.ok === false)
}

function sessionProvesOwner(sessionId: string, session: WorkbenchSessionRecord, owner: WorkbenchEvidenceOwner): boolean {
  if (owner.sessionId && owner.sessionId !== sessionId) return false
  if (owner.runId) {
    const runBound = session.activeRunId === owner.runId || sessionId === `session-${owner.runId}`
    if (!runBound) return false
  }
  if (!owner.sessionId && !owner.runId) return false
  return true
}

function ownerBindingMatches(
  session: WorkbenchSessionRecord,
  owner: WorkbenchEvidenceOwner,
  binding: WorkbenchEvidenceReadOwner | undefined
): boolean {
  for (const key of OWNER_BINDING_KEYS) {
    const requested = binding?.[key]
    if (requested !== undefined && requested !== owner[key]) return false
  }

  // A live task in the session is an additional proof for its task-owned
  // evidence. Completed sessions must provide the exact task binding again.
  if (owner.taskId && session.activeTaskId !== owner.taskId && binding?.taskId !== owner.taskId) return false
  return true
}

function authorizeEvidenceRead(params: {
  sourceId: string
  sessionId: string
  owner: WorkbenchEvidenceOwner
  binding?: WorkbenchEvidenceReadOwner
  options: WorkbenchEvidenceReadOptions
}): boolean {
  const session = getWorkbenchSession(params.sessionId, params.options.sessionStore)
  if (!session || isSessionFailure(session)) return false
  if (!session.lockedSourceIds.includes(params.sourceId)) return false
  if (params.owner.sourceId !== params.sourceId) return false
  if (!sessionProvesOwner(params.sessionId, session, params.owner)) return false
  return ownerBindingMatches(session, params.owner, params.binding)
}

function resultRefFor(record: WorkbenchEvidenceRecord): string | undefined {
  if (record.kind !== 'validation_result') return undefined
  try {
    const value = JSON.parse(record.content) as { resultRef?: unknown }
    return typeof value.resultRef === 'string' && value.resultRef.length <= 200 ? value.resultRef : undefined
  } catch {
    return undefined
  }
}

function validationJobMatchesEvidenceOwner(job: WorkbenchValidationJobRecord, owner: WorkbenchEvidenceOwner): boolean {
  if (job.sourceId !== owner.sourceId) return false
  const bindings: Array<[keyof WorkbenchEvidenceOwner, string | undefined]> = [
    ['sessionId', job.sessionId],
    ['runId', job.runId],
    ['taskId', job.taskId],
    ['packetId', job.packetId]
  ]
  return bindings.every(([key, value]) => owner[key] === undefined || owner[key] === value)
}

function currentRedactedContent(record: WorkbenchEvidenceRecord, redactContent = redactSecrets): string | WorkbenchEvidenceReadFailure {
  try {
    const content = redactContent(record.content)
    if (!WorkbenchEvidenceRecordSchema.shape.content.safeParse(content).success) {
      return failure('EVIDENCE_REDACTION_FAILED', 'Evidence redaction failed closed.')
    }
    if (Buffer.byteLength(content, 'utf8') > WORKBENCH_EVIDENCE_MAX_CONTENT_BYTES) {
      return failure('EVIDENCE_CONTENT_TOO_LARGE', 'Redacted evidence exceeds the bounded content limit.')
    }
    return content
  } catch {
    return failure('EVIDENCE_REDACTION_FAILED', 'Evidence redaction failed closed.')
  }
}

export function readAuthorizedWorkbenchEvidence(params: {
  evidenceId: string
  sourceId: string
  sessionId: string
  evidenceOwner?: WorkbenchEvidenceReadOwner
  cursor?: string
  pageBytes?: number
}, options: WorkbenchEvidenceReadOptions = {}): WorkbenchEvidenceReadResult {
  const parsedEvidenceId = workbenchEvidenceIdSchema.safeParse(params.evidenceId)
  if (!parsedEvidenceId.success) return failure('EVIDENCE_ID_INVALID', 'Evidence ID is invalid.')
  if (!Number.isSafeInteger(params.pageBytes ?? WORKBENCH_EVIDENCE_PAGE_DEFAULT_BYTES)
    || (params.pageBytes !== undefined && params.pageBytes < 256)) {
    return failure('EVIDENCE_PAGE_INVALID', 'Evidence page size is invalid.')
  }
  if ((params.pageBytes ?? WORKBENCH_EVIDENCE_PAGE_DEFAULT_BYTES) > WORKBENCH_EVIDENCE_PAGE_MAX_BYTES) {
    return failure('EVIDENCE_PAGE_TOO_LARGE', 'Evidence page size exceeds the bounded limit.')
  }

  let stored: ReturnType<typeof readWorkbenchEvidence>
  try {
    stored = readWorkbenchEvidence(parsedEvidenceId.data, options.evidenceStore)
  } catch {
    return failure('EVIDENCE_STORE_UNAVAILABLE', 'The evidence store is unavailable.')
  }
  let record: WorkbenchEvidenceRecord | undefined
  if (stored.ok === false) {
    record = readWorkbenchReadResultAsEvidence(parsedEvidenceId.data, options.readResultRecovery)
    if (!record) return storeFailureToReadFailure(stored)
  } else {
    record = stored.record || readWorkbenchReadResultAsEvidence(parsedEvidenceId.data, options.readResultRecovery)
    if (!record) return notFound()
  }
  if (!authorizeEvidenceRead({
    sourceId: params.sourceId,
    sessionId: params.sessionId,
    owner: record.owner,
    binding: params.evidenceOwner,
    options
  })) return notFound()

  const resultRef = resultRefFor(record)
  if (resultRef) {
    let validationJob: WorkbenchValidationJobRecord | undefined
    try {
      validationJob = getWorkbenchValidationJob(resultRef, params.sourceId)
    } catch {
      return failure('EVIDENCE_RESULT_REF_UNAVAILABLE', 'The referenced validation result is unavailable.')
    }
    if (!validationJob || !validationJobMatchesEvidenceOwner(validationJob, record.owner)) {
      return failure('EVIDENCE_RESULT_REF_UNAVAILABLE', 'The referenced validation result is unavailable.')
    }
  }
  const content = currentRedactedContent(record, options.redactContent)
  if (typeof content !== 'string') return content
  const buffer = Buffer.from(content, 'utf8')
  const ownerSha256 = sha256(stableSerialize(record.owner))
  const cursor = params.cursor ? decodeCursor(params.cursor) : undefined
  if (params.cursor && (!cursor
    || cursor.evidenceId !== record.evidenceId
    || cursor.sourceId !== params.sourceId
    || cursor.ownerSha256 !== ownerSha256)) {
    return failure('EVIDENCE_CURSOR_INVALID', 'Evidence cursor is invalid for this record and owner.')
  }
  const offset = cursor?.offset ?? 0
  if (offset > buffer.byteLength) return failure('EVIDENCE_CURSOR_INVALID', 'Evidence cursor is beyond the stored content.')
  const pageBytes = params.pageBytes ?? WORKBENCH_EVIDENCE_PAGE_DEFAULT_BYTES
  const end = utf8SafeEnd(buffer, offset, Math.min(buffer.byteLength, offset + pageBytes))
  const text = buffer.subarray(offset, end).toString('utf8')
  const complete = end >= buffer.byteLength
  const { content: _content, ...metadata } = record
  return {
    ok: true,
    page: {
      evidenceId: record.evidenceId,
      kind: record.kind,
      metadata,
      text,
      offset,
      returnedBytes: Buffer.byteLength(text, 'utf8'),
      totalBytes: buffer.byteLength,
      complete,
      redactionState: content === record.content ? record.redactionState : 'redacted',
      contentHashVerified: true,
      returnedSha256: sha256(content),
      ...(resultRef ? { resultRef } : {}),
      ...(complete ? {} : {
        nextCursor: encodeCursor({
          version: 1,
          evidenceId: record.evidenceId,
          sourceId: params.sourceId,
          ownerSha256,
          offset: end
        })
      })
    }
  }
}

export function authorizeWorkbenchEvidenceOwner(params: {
  sourceId: string
  sessionId: string
  owner: WorkbenchEvidenceOwner
  evidenceOwner?: WorkbenchEvidenceReadOwner
}, options: WorkbenchEvidenceReadOptions = {}): boolean {
  return authorizeEvidenceRead({ ...params, binding: params.evidenceOwner, options })
}

export function authorizeWorkbenchValidationJobRead(params: {
  sourceId: string
  sessionId: string
  owner: { sourceId: string; sessionId?: string; runId?: string }
}, options: WorkbenchEvidenceReadOptions = {}): boolean {
  const session = getWorkbenchSession(params.sessionId, options.sessionStore)
  if (!session || isSessionFailure(session)) return false
  if (params.owner.sourceId !== params.sourceId || !session.lockedSourceIds.includes(params.sourceId)) return false
  if (params.owner.sessionId && params.owner.sessionId !== params.sessionId) return false
  if (params.owner.runId && session.activeRunId !== params.owner.runId && params.sessionId !== `session-${params.owner.runId}`) return false
  return Boolean(params.owner.sessionId || params.owner.runId)
}
