import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { evaluateConnectedRepositoryPath, workbenchEvidenceIdSchema } from '@workbench/shared'
import {
  appendWorkbenchEvidence,
  readWorkbenchEvidence,
  type WorkbenchEvidenceStoreOptions
} from './workbench-evidence-store'
import type { WorkbenchEvidenceRecord } from '@workbench/shared'
import {
  getCodexReviewExecutionRecord,
  type CodexReviewExecutionStoreOptions
} from './codex-review-budget'
import type { CodexReviewAdmissionInput } from './codex-review-contract'
import type { CodexReviewBudgetedSandboxResult } from './codex-review-sandbox'
import { getConfigDir } from '../utils/paths'

export const CODEX_REVIEW_FINDINGS_SCHEMA_VERSION = 1 as const
export const CODEX_REVIEW_FINDINGS_CONTRACT_VERSION = 'r20.4' as const
export const CODEX_REVIEW_FINDINGS_MAX_FINDINGS = 32
export const CODEX_REVIEW_FINDINGS_MAX_EVIDENCE_REFS = 8
export const CODEX_REVIEW_FINDINGS_MAX_EXPLANATION_BYTES = 2_048
export const CODEX_REVIEW_FINDINGS_MAX_EXPLANATION_LINES = 40
export const CODEX_REVIEW_FINDINGS_MAX_IMPORT_BYTES = 16 * 1024
export const CODEX_REVIEW_FINDINGS_MAX_EVIDENCE_CONTENT_BYTES = 4 * 1024

export const CODEX_REVIEW_FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low', 'informational'] as const
export const CODEX_REVIEW_FINDING_CATEGORIES = ['security', 'correctness', 'reliability', 'performance', 'maintainability', 'configuration', 'privacy', 'other'] as const
export const CODEX_REVIEW_FINDING_STATUSES = ['open', 'acknowledged', 'dismissed', 'resolved'] as const
export const CODEX_REVIEW_EVIDENCE_REDACTION_STATES = ['redacted', 'not_required'] as const

export type CodexReviewFindingSeverity = typeof CODEX_REVIEW_FINDING_SEVERITIES[number]
export type CodexReviewFindingCategory = typeof CODEX_REVIEW_FINDING_CATEGORIES[number]
export type CodexReviewFindingStatus = typeof CODEX_REVIEW_FINDING_STATUSES[number]
export type CodexReviewEvidenceRedactionState = typeof CODEX_REVIEW_EVIDENCE_REDACTION_STATES[number]

export type CodexReviewFindingLocation = Readonly<{
  sourceId: string
  sourceRevision: string
  path: string
  startLine: number
  endLine: number
  startColumn?: number
  endColumn?: number
}>

export type CodexReviewFinding = Readonly<{
  findingId: string
  severity: CodexReviewFindingSeverity
  category: CodexReviewFindingCategory
  location: CodexReviewFindingLocation
  evidenceRefs: readonly string[]
  explanation: string
  confidence: number
  status: CodexReviewFindingStatus
}>

export type CodexReviewFindingsEnvelope = Readonly<{
  schemaVersion: typeof CODEX_REVIEW_FINDINGS_SCHEMA_VERSION
  sourceId: string
  sourceRevision: string
  reviewId: string
  executionId: string
  findings: readonly CodexReviewFinding[]
}>

export type CodexReviewFindingIdentityInput = Omit<CodexReviewFinding, 'findingId'>

export type CodexReviewFindingsFailureCode =
  | 'FINDINGS_FORMAT_INVALID'
  | 'FINDING_SCHEMA_INVALID'
  | 'FINDING_SCOPE_INVALID'
  | 'EVIDENCE_REFERENCE_INVALID'
  | 'FINDING_LIMIT_EXCEEDED'
  | 'R20_3_RESULT_NOT_ACCEPTABLE'
  | 'FINDING_IMPORT_STORAGE_FAILED'
  | 'FINDING_IMPORT_CONFLICT'
  | 'FINDING_EXECUTION_INVALID'

export type CodexReviewFindingsParseResult =
  | Readonly<{ ok: true; envelope: CodexReviewFindingsEnvelope; duplicatesRemoved: number }>
  | Readonly<{ ok: false; code: CodexReviewFindingsFailureCode; message: string }>

export type CodexReviewFindingsReceipt = Readonly<{
  schemaVersion: typeof CODEX_REVIEW_FINDINGS_SCHEMA_VERSION
  resultKind: 'codex_review_findings'
  status: 'accepted' | 'rejected'
  sourceId: string
  sourceRevision: string
  reviewId: string
  executionId: string
  findings: readonly CodexReviewFinding[]
  failure?: Readonly<{ code: CodexReviewFindingsFailureCode; message: string }>
}>

export type CodexReviewFindingsImportResult =
  | Readonly<{ ok: true; status: 'accepted'; evidenceId: string; receipt: CodexReviewFindingsReceipt; duplicatesRemoved: number; reused: boolean }>
  | Readonly<{ ok: false; status: 'rejected'; code: CodexReviewFindingsFailureCode; message: string; evidenceId?: string; receipt?: CodexReviewFindingsReceipt; reused?: boolean }>

export type CodexReviewAuditImmutability = Readonly<{
  status: 'verified' | 'not_measured'
  trackedFileMutations: number
  newEntries: number
  deletedEntries: number
  modeChanges: number
  gitIndexChanges: number
  sourceTreeOutputs: number
}>

export type CodexReviewAudit = Readonly<{
  reviewId: string
  sourceId: string
  sourceRevision: string
  reviewedPaths: readonly string[]
  authorityDigest: string
  budgetIdentity?: string
  executionId: string
  terminalState?: string
  findingIds: readonly string[]
  evidenceIds: readonly string[]
  immutability: CodexReviewAuditImmutability
  failure?: Readonly<{ code: CodexReviewFindingsFailureCode; message: string }>
}>

type RecordValue = Record<string, unknown>
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/
const SAFE_REVISION = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/
const MAX_PATH_LENGTH = 500

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function exactKeys(value: RecordValue, required: readonly string[]): boolean {
  const keys = Object.keys(value).sort()
  return keys.length === required.length && keys.every((key, index) => key === [...required].sort()[index])
}

function hasOwn(value: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const object = value as RecordValue
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stable(object[key])}`).join(',')}}`
}

function safeId(value: unknown, revision = false): value is string {
  return typeof value === 'string' && (revision ? SAFE_REVISION : SAFE_ID).test(value)
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function failure(code: CodexReviewFindingsFailureCode, message: string): CodexReviewFindingsParseResult & { ok: false } {
  return { ok: false, code, message: message.slice(0, 500) }
}

function normalizeExplanation(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return undefined
  if (value.split(/\r?\n/).length > CODEX_REVIEW_FINDINGS_MAX_EXPLANATION_LINES) return undefined
  if (Buffer.byteLength(value, 'utf8') > CODEX_REVIEW_FINDINGS_MAX_EXPLANATION_BYTES) return undefined
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized && Buffer.byteLength(normalized, 'utf8') <= CODEX_REVIEW_FINDINGS_MAX_EXPLANATION_BYTES ? normalized : undefined
}

function finiteConfidence(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0) && value >= 0 && value <= 1
}

function normalizeLocation(value: unknown, admission: CodexReviewAdmissionInput): CodexReviewFindingLocation | undefined {
  if (!isRecord(value) || ![...Object.keys(value)].every(key => ['sourceId', 'sourceRevision', 'path', 'startLine', 'endLine', 'startColumn', 'endColumn'].includes(key))) return undefined
  if (!exactKeys(value, ['sourceId', 'sourceRevision', 'path', 'startLine', 'endLine', ...(hasOwn(value, 'startColumn') ? ['startColumn'] : []), ...(hasOwn(value, 'endColumn') ? ['endColumn'] : [])])) return undefined
  if (value.sourceId !== admission.request.source.sourceId || value.sourceRevision !== admission.request.source.revision) return undefined
  if (typeof value.path !== 'string' || value.path.length === 0 || value.path.length > MAX_PATH_LENGTH || value.path !== value.path.trim() || value.path.includes('\\') || value.path.startsWith('/') || value.path.startsWith('~') || value.path.includes('\0') || value.path.split('/').some(part => !part || part === '.' || part === '..')) return undefined
  if (!admission.request.scope.paths.includes(value.path) || evaluateConnectedRepositoryPath(value.path)) return undefined
  const startLine = value.startLine
  const endLine = value.endLine
  if (!safeInteger(startLine) || !safeInteger(endLine) || startLine < 1 || endLine < startLine || endLine > 1_000_000) return undefined
  const rawHasStartColumn = hasOwn(value, 'startColumn')
  const rawHasEndColumn = hasOwn(value, 'endColumn')
  const startColumn = value.startColumn
  const endColumn = value.endColumn
  const hasStartColumn = rawHasStartColumn && startColumn !== null
  const hasEndColumn = rawHasEndColumn && endColumn !== null
  if (rawHasStartColumn !== rawHasEndColumn || hasStartColumn !== hasEndColumn) return undefined
  if (hasStartColumn !== hasEndColumn || (hasStartColumn && (!safeInteger(startColumn) || !safeInteger(endColumn) || startColumn < 1 || endColumn < startColumn || endColumn > 10_000))) return undefined
  const columns = hasStartColumn ? { startColumn: Number(startColumn), endColumn: Number(endColumn) } : {}
  try {
    const root = fs.realpathSync(admission.source.sourceRoot)
    let current = root
    for (const part of value.path.split('/')) {
      current = path.join(current, part)
      if (fs.lstatSync(current).isSymbolicLink()) return undefined
    }
    const target = fs.realpathSync(current)
    const relative = path.relative(root, target)
    if (!fs.statSync(target).isFile() || relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep).join('/') !== value.path) return undefined
    const lines = fs.readFileSync(target, 'utf8').split('\n').length
    if (endLine > lines) return undefined
  } catch {
    return undefined
  }
  return {
    sourceId: value.sourceId,
    sourceRevision: value.sourceRevision,
    path: value.path,
    startLine,
    endLine,
    ...columns
  }
}

function semanticPayload(sourceId: string, sourceRevision: string, finding: CodexReviewFindingIdentityInput): RecordValue {
  return {
    category: finding.category,
    confidence: finding.confidence,
    evidenceRefs: [...finding.evidenceRefs].sort(),
    explanation: normalizeExplanation(finding.explanation) || '',
    location: finding.location,
    severity: finding.severity,
    sourceId,
    sourceRevision,
    status: finding.status
  }
}

export function codexReviewFindingIdFor(input: { sourceId: string; sourceRevision: string; finding: CodexReviewFindingIdentityInput }): string {
  return `finding-${sha256(stable(semanticPayload(input.sourceId, input.sourceRevision, input.finding))).slice(0, 32)}`
}

function validateFinding(value: unknown, admission: CodexReviewAdmissionInput): CodexReviewFindingParseInternal {
  if (!isRecord(value) || !exactKeys(value, ['findingId', 'severity', 'category', 'location', 'evidenceRefs', 'explanation', 'confidence', 'status'])) return { ok: false, code: 'FINDING_SCHEMA_INVALID', message: 'Each finding must contain exactly the canonical R20.4 fields.' }
  if (!CODEX_REVIEW_FINDING_SEVERITIES.includes(value.severity as CodexReviewFindingSeverity) || !CODEX_REVIEW_FINDING_CATEGORIES.includes(value.category as CodexReviewFindingCategory) || !CODEX_REVIEW_FINDING_STATUSES.includes(value.status as CodexReviewFindingStatus)) return { ok: false, code: 'FINDING_SCHEMA_INVALID', message: 'Finding severity, category, or status is outside the bounded enum.' }
  const explanation = normalizeExplanation(value.explanation)
  if (!explanation) return { ok: false, code: 'FINDING_SCHEMA_INVALID', message: 'Finding explanation is empty or exceeds its bounded text limits.' }
  if (!finiteConfidence(value.confidence)) return { ok: false, code: 'FINDING_SCHEMA_INVALID', message: 'Finding confidence must be a finite number from 0 through 1.' }
  const confidence = value.confidence
  if (Math.round(confidence * 100) !== confidence * 100) return { ok: false, code: 'FINDING_SCHEMA_INVALID', message: 'Finding confidence has too many decimal places.' }
  if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.length < 1 || value.evidenceRefs.length > CODEX_REVIEW_FINDINGS_MAX_EVIDENCE_REFS || value.evidenceRefs.some(ref => !workbenchEvidenceIdSchema.safeParse(ref).success)) return { ok: false, code: 'EVIDENCE_REFERENCE_INVALID', message: 'Finding evidence references are malformed or exceed their bounded limit.' }
  const location = normalizeLocation(value.location, admission)
  if (!location) return { ok: false, code: 'FINDING_SCOPE_INVALID', message: 'Finding location is outside the exact admitted source, revision, or path scope.' }
  const finding = {
    findingId: typeof value.findingId === 'string' ? value.findingId : '',
    severity: value.severity as CodexReviewFindingSeverity,
    category: value.category as CodexReviewFindingCategory,
    location,
    evidenceRefs: [...new Set(value.evidenceRefs as string[])].sort(),
    explanation,
    confidence,
    status: value.status as CodexReviewFindingStatus
  }
  if (!/^finding-[a-f0-9]{32}$/.test(finding.findingId) || finding.findingId !== codexReviewFindingIdFor({ sourceId: admission.request.source.sourceId, sourceRevision: admission.request.source.revision, finding })) return { ok: false, code: 'FINDING_SCHEMA_INVALID', message: 'Finding ID does not match its stable semantic identity.' }
  return { ok: true, finding }
}

type CodexReviewFindingParseInternal = { ok: true; finding: CodexReviewFinding } | { ok: false; code: CodexReviewFindingsFailureCode; message: string }

export function parseCodexReviewFindings(raw: string, admission: CodexReviewAdmissionInput): CodexReviewFindingsParseResult {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > CODEX_REVIEW_FINDINGS_MAX_IMPORT_BYTES) return failure('FINDING_LIMIT_EXCEEDED', 'The canonical findings envelope exceeds the bounded import size.')
  let value: unknown
  try { value = JSON.parse(raw) } catch { return failure('FINDINGS_FORMAT_INVALID', 'The review result is not one canonical JSON findings envelope.') }
  if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'sourceId', 'sourceRevision', 'reviewId', 'executionId', 'findings'])) return failure('FINDINGS_FORMAT_INVALID', 'The review result must be exactly one canonical findings envelope with no unknown fields.')
  if (value.schemaVersion !== CODEX_REVIEW_FINDINGS_SCHEMA_VERSION || value.sourceId !== admission.request.source.sourceId || value.sourceRevision !== admission.request.source.revision || value.reviewId !== admission.request.reviewId || !safeId(value.executionId)) return failure('FINDING_SCHEMA_INVALID', 'The findings envelope identity is invalid or does not bind to the admitted review.')
  if (!Array.isArray(value.findings)) return failure('FINDING_SCHEMA_INVALID', 'The findings envelope must contain an array.')
  if (value.findings.length > CODEX_REVIEW_FINDINGS_MAX_FINDINGS) return failure('FINDING_LIMIT_EXCEEDED', 'The review returned more findings than the finite import cap.')
  const findings: CodexReviewFinding[] = []
  const seen = new Map<string, string>()
  let duplicatesRemoved = 0
  for (const candidate of value.findings) {
    const parsed = validateFinding(candidate, admission)
    if (parsed.ok !== true) return failure(parsed.code, parsed.message)
    const canonical = stable(parsed.finding)
    const prior = seen.get(parsed.finding.findingId)
    if (prior !== undefined) {
      if (prior !== canonical) return failure('FINDING_SCHEMA_INVALID', 'A duplicate finding ID has materially different content.')
      duplicatesRemoved += 1
      continue
    }
    seen.set(parsed.finding.findingId, canonical)
    findings.push(parsed.finding)
  }
  const envelope: CodexReviewFindingsEnvelope = {
    schemaVersion: CODEX_REVIEW_FINDINGS_SCHEMA_VERSION,
    sourceId: value.sourceId,
    sourceRevision: value.sourceRevision,
    reviewId: value.reviewId,
    executionId: value.executionId,
    findings: findings.sort((left, right) => left.findingId.localeCompare(right.findingId))
  }
  if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > CODEX_REVIEW_FINDINGS_MAX_IMPORT_BYTES) return failure('FINDING_LIMIT_EXCEEDED', 'The normalized findings envelope exceeds the bounded import size.')
  return { ok: true, envelope, duplicatesRemoved }
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function evidenceStorePath(options: WorkbenchEvidenceStoreOptions): string {
  return path.resolve(options.storePath || path.join(getConfigDir(), 'workbench-evidence.json'))
}

function safeEvidenceStorePath(admission: CodexReviewAdmissionInput, options: WorkbenchEvidenceStoreOptions): boolean {
  try {
    const sourceRoot = fs.realpathSync(admission.source.sourceRoot)
    const target = evidenceStorePath(options)
    if (fs.existsSync(target)) return !contained(sourceRoot, fs.realpathSync(target))
    const parent = fs.realpathSync(path.dirname(target))
    return !contained(sourceRoot, parent)
  } catch { return false }
}

function receiptFor(envelope: Pick<CodexReviewFindingsEnvelope, 'sourceId' | 'sourceRevision' | 'reviewId' | 'executionId'>, status: 'accepted' | 'rejected', findings: readonly CodexReviewFinding[], rejected?: { code: CodexReviewFindingsFailureCode; message: string }): CodexReviewFindingsReceipt {
  return {
    schemaVersion: CODEX_REVIEW_FINDINGS_SCHEMA_VERSION,
    resultKind: 'codex_review_findings',
    status,
    sourceId: envelope.sourceId,
    sourceRevision: envelope.sourceRevision,
    reviewId: envelope.reviewId,
    executionId: envelope.executionId,
    findings,
    ...(rejected ? { failure: { code: rejected.code, message: rejected.message.slice(0, 500) } } : {})
  }
}

function receiptEvidenceId(executionId: string): string {
  return `evd-r20-4-findings-${sha256(executionId).slice(0, 32)}`
}

function appendOrReuseReceipt(receipt: CodexReviewFindingsReceipt, evidenceId: string, owner: { sourceId: string; sessionId: string; runId: string; requestId: string; operationId: string }, options: WorkbenchEvidenceStoreOptions): { ok: true; reused: boolean; record: WorkbenchEvidenceRecord } | { ok: false; code: CodexReviewFindingsFailureCode; message: string } {
  const content = JSON.stringify(receipt)
  const existing = readWorkbenchEvidence(evidenceId, options)
  if (existing.ok !== true) return { ok: false, code: 'FINDING_IMPORT_STORAGE_FAILED', message: existing.message }
  if (existing.record) {
    if (existing.record.kind !== 'capability_result' || existing.record.content !== content || JSON.stringify(existing.record.owner) !== JSON.stringify(owner)) return { ok: false, code: 'FINDING_IMPORT_CONFLICT', message: 'The deterministic findings evidence ID is already bound to different content or ownership.' }
    return { ok: true, reused: true, record: existing.record }
  }
  const appended = appendWorkbenchEvidence({ kind: 'capability_result', owner, content, retentionClass: 'active_run', evidenceId }, options)
  if (appended.ok === true) return { ok: true, reused: false, record: appended.record }
  if (appended.code === 'EVIDENCE_DUPLICATE') {
    const raced = readWorkbenchEvidence(evidenceId, options)
    if (raced.ok && raced.record?.content === content && JSON.stringify(raced.record.owner) === JSON.stringify(owner)) return { ok: true, reused: true, record: raced.record }
  }
  return { ok: false, code: 'FINDING_IMPORT_STORAGE_FAILED', message: appended.message }
}

function baseReceipt(admission: CodexReviewAdmissionInput, executionId: string): Pick<CodexReviewFindingsEnvelope, 'sourceId' | 'sourceRevision' | 'reviewId' | 'executionId'> {
  return { sourceId: admission.request.source.sourceId, sourceRevision: admission.request.source.revision, reviewId: admission.request.reviewId, executionId }
}

function persistRejected(admission: CodexReviewAdmissionInput, executionId: string, rejected: { code: CodexReviewFindingsFailureCode; message: string }, evidenceOptions: WorkbenchEvidenceStoreOptions): CodexReviewFindingsImportResult {
  const envelope = baseReceipt(admission, executionId)
  const receipt = receiptFor(envelope, 'rejected', [], rejected)
  const stored = appendOrReuseReceipt(receipt, receiptEvidenceId(executionId), { sourceId: envelope.sourceId, sessionId: admission.request.run.sessionId, runId: admission.request.run.runId, requestId: envelope.reviewId, operationId: executionId }, evidenceOptions)
  if (stored.ok !== true) return { ok: false, status: 'rejected', code: stored.code, message: stored.message }
  return { ok: false, status: 'rejected', code: rejected.code, message: rejected.message, evidenceId: stored.record.evidenceId, receipt, reused: stored.reused }
}

export function importCodexReviewFindings(input: {
  admission: CodexReviewAdmissionInput
  result: CodexReviewBudgetedSandboxResult
  evidenceOptions?: WorkbenchEvidenceStoreOptions
  executionStoreOptions?: CodexReviewExecutionStoreOptions
}): CodexReviewFindingsImportResult {
  const evidenceOptions = input.evidenceOptions || {}
  const resultExecutionId = 'execution' in input.result && input.result.execution?.executionId
  const executionId = typeof resultExecutionId === 'string' ? resultExecutionId : `rejected-${sha256(input.admission.request.reviewId).slice(0, 24)}`
  if (!safeEvidenceStorePath(input.admission, evidenceOptions)) return { ok: false, status: 'rejected', code: 'FINDING_IMPORT_STORAGE_FAILED', message: 'The findings evidence store must resolve outside the admitted source tree.' }
  if (input.result.ok !== true) return persistRejected(input.admission, executionId, { code: 'R20_3_RESULT_NOT_ACCEPTABLE', message: `R20.3 terminal result ${'code' in input.result ? input.result.code : 'UNKNOWN'} cannot import authoritative findings.` }, evidenceOptions)
  if (input.result.execution.executionId !== executionId) return persistRejected(input.admission, executionId, { code: 'FINDING_EXECUTION_INVALID', message: 'The findings result execution identity does not match its persisted terminal execution.' }, evidenceOptions)
  const persisted = getCodexReviewExecutionRecord(executionId, input.executionStoreOptions)
  if (!persisted.ok || !persisted.record || persisted.record.status !== 'terminal' || persisted.record.terminalState !== 'SUCCESS' || persisted.record.reviewId !== input.admission.request.reviewId || persisted.record.sourceId !== input.admission.request.source.sourceId || persisted.record.runId !== input.admission.request.run.runId) return persistRejected(input.admission, executionId, { code: 'FINDING_EXECUTION_INVALID', message: 'The R20.3 execution record is missing, non-terminal, or not bound to this review.' }, evidenceOptions)
  if (input.result.output.truncated || input.result.output.stdoutBytes > CODEX_REVIEW_FINDINGS_MAX_IMPORT_BYTES) return persistRejected(input.admission, executionId, { code: 'FINDING_LIMIT_EXCEEDED', message: 'The bounded review output cannot be imported because it was truncated or oversized.' }, evidenceOptions)
  const parsed = parseCodexReviewFindings(input.result.output.stdout, input.admission)
  if (parsed.ok !== true) return persistRejected(input.admission, executionId, { code: parsed.code, message: parsed.message }, evidenceOptions)
  if (parsed.envelope.executionId !== executionId) return persistRejected(input.admission, executionId, { code: 'FINDING_EXECUTION_INVALID', message: 'Findings refer to a different execution than the persisted R20.3 result.' }, evidenceOptions)
  for (const finding of parsed.envelope.findings) {
    for (const evidenceId of finding.evidenceRefs) {
      const evidence = readWorkbenchEvidence(evidenceId, evidenceOptions)
      if (!evidence.ok || !evidence.record || evidence.record.kind !== 'capability_result') return persistRejected(input.admission, executionId, { code: 'EVIDENCE_REFERENCE_INVALID', message: `Evidence reference ${evidenceId} is missing or is not a capability result.` }, evidenceOptions)
      const owner = evidence.record.owner
      if (owner.sourceId !== parsed.envelope.sourceId || owner.runId !== input.admission.request.run.runId || owner.requestId !== parsed.envelope.reviewId || owner.operationId !== executionId) return persistRejected(input.admission, executionId, { code: 'EVIDENCE_REFERENCE_INVALID', message: `Evidence reference ${evidenceId} is bound to a different source, run, review, or execution.` }, evidenceOptions)
      if (!isBoundSourceEvidence(evidence.record, finding, parsed.envelope)) return persistRejected(input.admission, executionId, { code: 'EVIDENCE_REFERENCE_INVALID', message: `Evidence reference ${evidenceId} does not bind the finding location and redacted content hash.` }, evidenceOptions)
    }
  }
  const receipt = receiptFor(parsed.envelope, 'accepted', parsed.envelope.findings)
  const stored = appendOrReuseReceipt(receipt, receiptEvidenceId(executionId), { sourceId: parsed.envelope.sourceId, sessionId: input.admission.request.run.sessionId, runId: input.admission.request.run.runId, requestId: parsed.envelope.reviewId, operationId: executionId }, evidenceOptions)
  if (stored.ok !== true) return { ok: false, status: 'rejected', code: stored.code, message: stored.message }
  return { ok: true, status: 'accepted', evidenceId: stored.record.evidenceId, receipt, duplicatesRemoved: parsed.duplicatesRemoved, reused: stored.reused }
}

function isBoundSourceEvidence(record: WorkbenchEvidenceRecord, finding: CodexReviewFinding, envelope: CodexReviewFindingsEnvelope): boolean {
  let value: unknown
  try { value = JSON.parse(record.content) } catch { return false }
  if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'kind', 'sourceId', 'sourceRevision', 'reviewId', 'executionId', 'path', 'startLine', 'endLine', 'content', 'contentSha256', 'redactionState'])) return false
  if (value.schemaVersion !== 1 || value.kind !== 'codex_review_source_excerpt' || value.sourceId !== envelope.sourceId || value.sourceRevision !== envelope.sourceRevision || value.reviewId !== envelope.reviewId || value.executionId !== envelope.executionId || value.path !== finding.location.path || value.startLine !== finding.location.startLine || value.endLine !== finding.location.endLine || !CODEX_REVIEW_EVIDENCE_REDACTION_STATES.includes(value.redactionState as CodexReviewEvidenceRedactionState) || typeof value.content !== 'string' || Buffer.byteLength(value.content, 'utf8') > CODEX_REVIEW_FINDINGS_MAX_EVIDENCE_CONTENT_BYTES || value.contentSha256 !== sha256(value.content) || record.redactionState !== value.redactionState) return false
  return true
}

export function readCodexReviewFindings(evidenceId: string, options: WorkbenchEvidenceStoreOptions = {}): { ok: true; receipt?: CodexReviewFindingsReceipt; record?: WorkbenchEvidenceRecord } | { ok: false; code: CodexReviewFindingsFailureCode; message: string } {
  if (!workbenchEvidenceIdSchema.safeParse(evidenceId).success) return { ok: false, code: 'EVIDENCE_REFERENCE_INVALID', message: 'The findings evidence ID is malformed.' }
  const result = readWorkbenchEvidence(evidenceId, options)
  if (result.ok !== true) return { ok: false, code: 'FINDING_IMPORT_STORAGE_FAILED', message: result.message }
  if (!result.record || result.record.kind !== 'capability_result') return { ok: true }
  try {
    const receipt = JSON.parse(result.record.content) as CodexReviewFindingsReceipt
    if (!isRecord(receipt) || receipt.schemaVersion !== 1 || receipt.resultKind !== 'codex_review_findings' || !['accepted', 'rejected'].includes(receipt.status) || !Array.isArray(receipt.findings)) return { ok: false, code: 'FINDING_SCHEMA_INVALID', message: 'The stored findings receipt is invalid.' }
    return { ok: true, receipt, record: result.record }
  } catch {
    return { ok: false, code: 'FINDING_SCHEMA_INVALID', message: 'The stored findings receipt is not valid JSON.' }
  }
}

export function readCodexReviewAudit(input: {
  admission: CodexReviewAdmissionInput
  evidenceId: string
  evidenceOptions?: WorkbenchEvidenceStoreOptions
  executionStoreOptions?: CodexReviewExecutionStoreOptions
  immutability?: CodexReviewAuditImmutability
}): { ok: true; audit: CodexReviewAudit } | { ok: false; code: CodexReviewFindingsFailureCode; message: string } {
  const findings = readCodexReviewFindings(input.evidenceId, input.evidenceOptions)
  if (findings.ok !== true || !findings.receipt) return findings.ok !== true ? findings : { ok: false, code: 'FINDING_SCHEMA_INVALID', message: 'The findings receipt is missing.' }
  const receipt = findings.receipt
  if (receipt.sourceId !== input.admission.request.source.sourceId || receipt.sourceRevision !== input.admission.request.source.revision || receipt.reviewId !== input.admission.request.reviewId) return { ok: false, code: 'FINDING_EXECUTION_INVALID', message: 'The stored findings receipt is not bound to the admitted review.' }
  const execution = getCodexReviewExecutionRecord(receipt.executionId, input.executionStoreOptions)
  if (execution.ok !== true) return { ok: false, code: 'FINDING_EXECUTION_INVALID', message: 'The execution audit record is unavailable.' }
  return {
    ok: true,
    audit: {
      reviewId: receipt.reviewId,
      sourceId: receipt.sourceId,
      sourceRevision: receipt.sourceRevision,
      reviewedPaths: input.admission.request.scope.paths,
      authorityDigest: input.admission.request.authorityDigest,
      ...(execution.record ? { budgetIdentity: execution.record.budgetIdentity, terminalState: execution.record.terminalState } : {}),
      executionId: receipt.executionId,
      findingIds: receipt.findings.map(finding => finding.findingId),
      evidenceIds: receipt.findings.flatMap(finding => finding.evidenceRefs),
      immutability: input.immutability || { status: 'not_measured', trackedFileMutations: 0, newEntries: 0, deletedEntries: 0, modeChanges: 0, gitIndexChanges: 0, sourceTreeOutputs: 0 },
      ...(receipt.failure ? { failure: receipt.failure } : {})
    }
  }
}

export function formatCodexReviewFindingsStatus(input: CodexReviewFindingsImportResult | CodexReviewFindingsReceipt): string {
  if (!('resultKind' in input)) {
    const outcome = input as CodexReviewFindingsImportResult
    if (!('receipt' in outcome) || !outcome.receipt) return `Codex review findings:\nREJECTED — EVIDENCE ONLY\nFailure: ${'code' in outcome ? outcome.code : 'UNKNOWN'}\nAutomatic remediation: NO\nRepository changed: NO`
    input = outcome.receipt
  }
  const receipt = input
  const lines = [
    'Codex review findings:',
    receipt.status === 'accepted' ? 'ACCEPTED — EVIDENCE ONLY' : 'REJECTED — EVIDENCE ONLY',
    `Findings: ${receipt.findings.length}`,
    'Automatic remediation: NO',
    'Repository changed: NO',
    'Further action requires a normal Workbench task, policy evaluation, and confirmation.'
  ]
  if (receipt.status === 'rejected' && receipt.failure) lines.push(`Failure: ${receipt.failure.code} — ${receipt.failure.message}`)
  for (const finding of receipt.findings.slice(0, CODEX_REVIEW_FINDINGS_MAX_FINDINGS)) lines.push(`${finding.severity.toUpperCase()} ${finding.location.path}:${finding.location.startLine}-${finding.location.endLine} — ${finding.explanation}`)
  return lines.join('\n')
}
