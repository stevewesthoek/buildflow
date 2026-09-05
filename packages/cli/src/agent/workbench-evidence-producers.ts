import crypto from 'node:crypto'
import {
  type WorkbenchEvidenceKind,
  type WorkbenchEvidenceMetadata,
  type WorkbenchEvidenceOwner,
  type WorkbenchEvidenceRecord,
  type WorkbenchEvidenceRetentionClass
} from '@workbench/shared'
import {
  appendWorkbenchEvidence,
  readWorkbenchEvidence,
  type WorkbenchEvidenceStoreFailure,
  type WorkbenchEvidenceStoreFailureCode,
  type WorkbenchEvidenceStoreOptions
} from './workbench-evidence-store'
import { redactSecrets } from './safe-access'

export type WorkbenchEvidenceReference = WorkbenchEvidenceMetadata

export type WorkbenchEvidenceUnavailable = {
  ok: false
  code: WorkbenchEvidenceStoreFailureCode
  message: string
}

export type WorkbenchEvidenceAttachment = {
  evidenceRefs?: WorkbenchEvidenceReference[]
  evidenceUnavailable?: WorkbenchEvidenceUnavailable
}

export type AppendOrReuseWorkbenchEvidenceResult =
  | { ok: true; metadata: WorkbenchEvidenceMetadata; reused: boolean }
  | WorkbenchEvidenceUnavailable

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => stableSerialize(item)).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(object[key])}`).join(',')}}`
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

export function deterministicWorkbenchEvidenceId(params: {
  kind: WorkbenchEvidenceKind
  owner: WorkbenchEvidenceOwner
  retentionClass: WorkbenchEvidenceRetentionClass
  content: string
}): string {
  return `evd-${sha256(stableSerialize({ kind: params.kind, owner: params.owner, retentionClass: params.retentionClass, content: redactSecrets(params.content) }))}`
}

function metadata(record: WorkbenchEvidenceRecord): WorkbenchEvidenceMetadata {
  const { content: _content, ...value } = record
  return value
}

function sameOwner(left: WorkbenchEvidenceOwner, right: WorkbenchEvidenceOwner): boolean {
  return stableSerialize(left) === stableSerialize(right)
}

function sameEvidence(record: { kind: WorkbenchEvidenceKind; owner: WorkbenchEvidenceOwner; retentionClass: WorkbenchEvidenceRetentionClass; sha256: string }, params: {
  kind: WorkbenchEvidenceKind
  owner: WorkbenchEvidenceOwner
  retentionClass: WorkbenchEvidenceRetentionClass
  redactedContent: string
}): boolean {
  return record.kind === params.kind
    && sameOwner(record.owner, params.owner)
    && record.retentionClass === params.retentionClass
    && record.sha256 === sha256(params.redactedContent)
}

/**
 * Append one producer record with a content/owner-derived ID, or safely reuse
 * the exact existing record on replay. The R13.1 store remains the only
 * persistence and integrity authority.
 */
export function appendOrReuseWorkbenchEvidence(params: {
  kind: WorkbenchEvidenceKind
  owner: WorkbenchEvidenceOwner
  content: string
  retentionClass: WorkbenchEvidenceRetentionClass
}, options: WorkbenchEvidenceStoreOptions = {}): AppendOrReuseWorkbenchEvidenceResult {
  if (typeof params.content !== 'string') {
    return { ok: false, code: 'EVIDENCE_INVALID', message: 'Evidence content must be UTF-8 text.' }
  }
  let redactedContent: string
  try {
    redactedContent = redactSecrets(params.content)
  } catch {
    return { ok: false, code: 'EVIDENCE_REDACTION_FAILED', message: 'Evidence redaction failed closed.' }
  }
  const evidenceId = deterministicWorkbenchEvidenceId({ ...params, content: redactedContent })
  const appended = appendWorkbenchEvidence({ ...params, evidenceId }, options)
  if ('record' in appended && appended.ok === true) return { ok: true, metadata: metadata(appended.record as WorkbenchEvidenceRecord), reused: false }
  if (!('code' in appended)) return { ok: false, code: 'EVIDENCE_STORE_WRITE_FAILED', message: 'Evidence append failed safely.' }
  const appendFailure = appended as WorkbenchEvidenceStoreFailure
  if (appendFailure.code !== 'EVIDENCE_DUPLICATE') return { ok: false, code: appendFailure.code, message: appendFailure.message }

  const existing = readWorkbenchEvidence(evidenceId, options)
  if (!('record' in existing)) {
    const readFailure = existing as WorkbenchEvidenceStoreFailure
    return { ok: false, code: readFailure.code, message: readFailure.message }
  }
  if (existing.ok !== true || !existing.record) return { ok: false, code: 'EVIDENCE_STORE_CORRUPT', message: 'Evidence replay record was unavailable.' }
  const existingRecord = existing.record as WorkbenchEvidenceRecord
  if (!sameEvidence(existingRecord as { kind: WorkbenchEvidenceKind; owner: WorkbenchEvidenceOwner; retentionClass: WorkbenchEvidenceRetentionClass; sha256: string }, { kind: params.kind, owner: params.owner, retentionClass: params.retentionClass, redactedContent })) {
    return {
      ok: false,
      code: 'EVIDENCE_DUPLICATE',
      message: 'Deterministic evidence ID exists for a different producer payload or owner.'
    }
  }
  return { ok: true, metadata: metadata(existingRecord), reused: true }
}

export function attachWorkbenchEvidence(params: {
  entries: Array<{
    kind: WorkbenchEvidenceKind
    owner: WorkbenchEvidenceOwner
    content: string
    retentionClass: WorkbenchEvidenceRetentionClass
  }>
}, options: WorkbenchEvidenceStoreOptions = {}): WorkbenchEvidenceAttachment {
  const evidenceRefs: WorkbenchEvidenceMetadata[] = []
  let evidenceUnavailable: WorkbenchEvidenceUnavailable | undefined
  for (const entry of params.entries) {
    const result = appendOrReuseWorkbenchEvidence(entry, options)
    if (result.ok === true) evidenceRefs.push(result.metadata)
    else if (!evidenceUnavailable) evidenceUnavailable = result
  }
  return {
    ...(evidenceRefs.length > 0 ? { evidenceRefs } : {}),
    ...(evidenceUnavailable ? { evidenceUnavailable } : {})
  }
}

export function compactEvidenceUnavailable(value: unknown): WorkbenchEvidenceUnavailable | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = value as Partial<WorkbenchEvidenceUnavailable>
  if (typeof item.code !== 'string' || typeof item.message !== 'string') return undefined
  return { ok: false, code: item.code as WorkbenchEvidenceStoreFailureCode, message: item.message.slice(0, 240) }
}
