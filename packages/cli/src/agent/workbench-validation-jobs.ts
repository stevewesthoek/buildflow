import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { getConfigDir } from '../utils/paths'
import { runSafeCommand, type SafeCommandRequest, type SafeCommandResult } from './command-runner'
import { recordValidationJobTelemetry, type TerminalValidationJobStatus } from './validation-job-telemetry'
import { recordGitLockTelemetry } from './git-lock-telemetry'
import { appendAgentEvent, hasValidationActivityEvent } from './agent-events'
import { WorkbenchEvidenceMetadataSchema, type WorkbenchEvidenceMetadata } from '@workbench/shared'
import { attachWorkbenchEvidence, type WorkbenchEvidenceUnavailable } from './workbench-evidence-producers'
import { redactSecrets } from './safe-access'

export const WORKBENCH_VALIDATION_JOB_STORE_VERSION = 1 as const

export type PersistedValidationCommandKind =
  | 'git_diff_check'
  | 'validate_json_files'
  | 'security_scan_paths'
  | 'run_package_script'
  | 'run_package_test'
  | 'run_package_test_marker'
  | 'type_check_web'
  | 'type_check_cli'
  | 'run_exact_command'

export type WorkbenchValidationJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'cancelled'

export type WorkbenchValidationJobRequest = {
  sourceId: string
  sessionId?: string
  idempotencyKey: string
  commandKind: PersistedValidationCommandKind
  packageDir?: string
  scriptName?: string
  marker?: string
  paths?: string[]
  patternSet?: SafeCommandRequest['patternSet']
  timeoutMs?: number
  runId?: string
  packetId?: string
  taskId?: string
  executable?: SafeCommandRequest['executable']
  args?: string[]
  nodeVersion?: '20'
  policy?: SafeCommandRequest['policy']
  requiredBranch?: string
  protectedPaths?: string[]
  networkAccess?: false
}

export type WorkbenchValidationJobResult = {
  exitCode: number | null
  signal: NodeJS.Signals | null
  durationMs: number
  stdout: string
  stderr: string
  outputTruncated: boolean
  changedPaths: string[]
  protectedPathsChanged?: string[]
  actualBranch?: string
  reason?: string
  details?: unknown
  terminatedByInfrastructure: boolean
  terminationReason?: 'action_deadline' | 'job_timeout' | 'cancelled' | 'worker_failure'
  runtime?: SafeCommandResult['runtime']
}

export type WorkbenchValidationJobRecord = {
  storeVersion: typeof WORKBENCH_VALIDATION_JOB_STORE_VERSION
  jobId: string
  idempotencyKey: string
  sourceId: string
  sessionId?: string
  runId?: string
  packetId?: string
  taskId?: string
  status: WorkbenchValidationJobStatus
  command: WorkbenchValidationJobRequest
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
  failedAt?: string
  cancelledAt?: string
  workerId?: string
  leaseToken?: string
  leaseAcquiredAt?: string
  leaseExpiresAt?: string
  cancelRequestedAt?: string
  cancelReason?: string
  result?: WorkbenchValidationJobResult
  evidenceRefs?: WorkbenchEvidenceMetadata[]
  evidenceUnavailable?: WorkbenchEvidenceUnavailable
}

export type CompactWorkbenchValidationJob = {
  jobId: string
  sourceId: string
  runId?: string
  packetId?: string
  taskId?: string
  status: WorkbenchValidationJobStatus
  commandKind: PersistedValidationCommandKind
  packageDir?: string
  scriptName?: string
  marker?: string
  paths?: string[]
  patternSet?: SafeCommandRequest['patternSet']
  executable?: SafeCommandRequest['executable']
  args?: string[]
  nodeVersion?: '20'
  timeoutMs?: number
  requiredBranch?: string
  protectedPaths?: string[]
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
  exitCode?: number | null
  signal?: NodeJS.Signals | null
  durationMs?: number
  outputTruncated?: boolean
  resultRef: string
  stdoutBytes?: number
  stderrBytes?: number
  resultAvailableUntil?: string
  stdout?: string
  stderr?: string
  stdoutTail?: string
  stderrTail?: string
  changedPaths?: string[]
  protectedPathsChanged?: string[]
  actualBranch?: string
  reason?: string
  details?: unknown
  runtime?: SafeCommandResult['runtime']
  terminatedByInfrastructure?: boolean
  terminationReason?: WorkbenchValidationJobResult['terminationReason']
  evidenceRefs?: WorkbenchEvidenceMetadata[]
  evidenceUnavailable?: WorkbenchEvidenceUnavailable
}

type WorkbenchValidationJobStore = {
  version: typeof WORKBENCH_VALIDATION_JOB_STORE_VERSION
  updatedAt: string
  jobs: WorkbenchValidationJobRecord[]
}

export type SubmitWorkbenchValidationJobResult =
  | { ok: true; created: boolean; job: CompactWorkbenchValidationJob }
  | {
      ok: false
      code: 'VALIDATION_JOB_STORE_BUSY' | 'VALIDATION_JOB_STORE_CORRUPT' | 'VALIDATION_JOB_IDEMPOTENCY_CONFLICT' | 'VALIDATION_JOB_INVALID'
      message: string
      field?: string
      reason?: string
      allowedValues?: string[]
    }

class ValidationJobStoreCorruptError extends Error {
  constructor(message = 'Validation job store is corrupt or unsupported.') {
    super(message)
    this.name = 'ValidationJobStoreCorruptError'
  }
}

const STORE_PATH = path.join(getConfigDir(), 'workbench-validation-jobs.json')
const LOCK_PATH = `${STORE_PATH}.lock`
const MAX_JOB_RECORDS = 300
const TERMINAL_JOB_RETENTION_MS = 4 * 60 * 60_000  // terminal jobs older than this are pruned
const MAX_PERSISTED_OUTPUT_BYTES = 60_000
const COMPACT_OUTPUT_TAIL_BYTES = 4_000
const RESULT_PAGE_DEFAULT_BYTES = 4_000
const RESULT_PAGE_MAX_BYTES = 4_000
const RESULT_RETENTION_MS = TERMINAL_JOB_RETENTION_MS
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 900_000
const ALLOWED_COMMAND_KINDS = new Set<PersistedValidationCommandKind>([
  'git_diff_check',
  'validate_json_files',
  'security_scan_paths',
  'run_package_script',
  'run_package_test',
  'run_package_test_marker',
  'type_check_web',
  'type_check_cli',
  'run_exact_command'
])

function emptyStore(): WorkbenchValidationJobStore {
  return {
    version: WORKBENCH_VALIDATION_JOB_STORE_VERSION,
    updatedAt: new Date().toISOString(),
    jobs: []
  }
}

function isRecord(value: unknown): value is WorkbenchValidationJobRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<WorkbenchValidationJobRecord>
  return record.storeVersion === WORKBENCH_VALIDATION_JOB_STORE_VERSION
    && typeof record.jobId === 'string'
    && typeof record.idempotencyKey === 'string'
    && typeof record.sourceId === 'string'
    && (record.sessionId === undefined || typeof record.sessionId === 'string')
    && typeof record.status === 'string'
    && typeof record.command?.commandKind === 'string'
    && typeof record.createdAt === 'string'
    && typeof record.updatedAt === 'string'
    && (record.evidenceRefs === undefined || (Array.isArray(record.evidenceRefs) && record.evidenceRefs.every(item => WorkbenchEvidenceMetadataSchema.safeParse(item).success)))
    && (record.evidenceUnavailable === undefined || (typeof record.evidenceUnavailable === 'object' && record.evidenceUnavailable !== null && typeof record.evidenceUnavailable.code === 'string' && typeof record.evidenceUnavailable.message === 'string'))
}

function readStore(): WorkbenchValidationJobStore {
  if (!fs.existsSync(STORE_PATH)) return emptyStore()
  let parsed: Partial<WorkbenchValidationJobStore>
  try {
    parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as Partial<WorkbenchValidationJobStore>
  } catch {
    throw new ValidationJobStoreCorruptError('Validation job store JSON is corrupt.')
  }
  if (parsed.version !== WORKBENCH_VALIDATION_JOB_STORE_VERSION
    || typeof parsed.updatedAt !== 'string'
    || !Array.isArray(parsed.jobs)
    || parsed.jobs.some(job => !isRecord(job))) {
    throw new ValidationJobStoreCorruptError('Validation job store schema is corrupt or unsupported.')
  }
  return {
    version: WORKBENCH_VALIDATION_JOB_STORE_VERSION,
    updatedAt: parsed.updatedAt,
    jobs: parsed.jobs as WorkbenchValidationJobRecord[]
  }
}

function projectValidationStarted(record: WorkbenchValidationJobRecord): void {
  if (!record.runId || !record.startedAt) return
  if (hasValidationActivityEvent({ jobId: record.runId, sourceId: record.sourceId, validationJobId: record.jobId, kind: 'validation_started' })) return
  appendAgentEvent({
    jobId: record.runId,
    sourceId: record.sourceId,
    type: 'validation_started',
    activityKind: 'validation_started',
    message: `Validation ${record.command.commandKind} started`,
    createdAt: record.startedAt,
    validationJobId: record.jobId,
    packetId: record.packetId,
    taskId: record.taskId,
    status: 'running',
    evidenceRefs: [{ kind: 'validation', ref: record.jobId }]
  })
}

function projectValidationTerminal(record: WorkbenchValidationJobRecord): void {
  if (!record.runId || !['completed', 'failed', 'timed_out', 'cancelled'].includes(record.status)) return
  const kind = record.status === 'completed' ? 'validation_completed' : 'validation_failed'
  if (hasValidationActivityEvent({ jobId: record.runId, sourceId: record.sourceId, validationJobId: record.jobId, kind })) return
  const createdAt = record.completedAt || record.failedAt || record.cancelledAt || record.updatedAt
  appendAgentEvent({
    jobId: record.runId,
    sourceId: record.sourceId,
    type: kind,
    activityKind: kind,
    message: `Validation ${record.command.commandKind} ${record.status}`,
    createdAt,
    validationJobId: record.jobId,
    packetId: record.packetId,
    taskId: record.taskId,
    status: record.status,
    evidenceRefs: record.evidenceRefs?.length
      ? record.evidenceRefs.map(ref => ({ kind: 'validation' as const, ref: ref.evidenceId }))
      : [{ kind: 'validation', ref: record.jobId }],
    ...(typeof record.result?.durationMs === 'number' ? { telemetry: { durationMs: record.result.durationMs } } : {})
  })
}

const EVIDENCE_OWNER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/

function attachValidationEvidence(record: WorkbenchValidationJobRecord): void {
  if (!record.result || !['completed', 'failed', 'timed_out', 'cancelled'].includes(record.status) || record.evidenceRefs?.length) return
  const owner = {
    sourceId: record.sourceId,
    ...(record.sessionId && EVIDENCE_OWNER_ID.test(record.sessionId) ? { sessionId: record.sessionId } : {}),
    ...(record.runId && EVIDENCE_OWNER_ID.test(record.runId) ? { runId: record.runId } : {}),
    ...(record.taskId && EVIDENCE_OWNER_ID.test(record.taskId) ? { taskId: record.taskId } : {}),
    ...(record.packetId && EVIDENCE_OWNER_ID.test(record.packetId) ? { packetId: record.packetId } : {}),
    operationId: `validation-job:${record.jobId}`
  }
  const evidence = attachWorkbenchEvidence({
    entries: [{
      kind: 'validation_result',
      owner,
      retentionClass: record.runId ? 'active_run' : 'standard',
      // The resultRef/cursor store already owns the bounded output streams.
      // Keep this canonical record as the durable outcome/reference envelope
      // without copying those potentially large bodies.
      content: JSON.stringify({
        resultRef: record.jobId,
        commandKind: record.command.commandKind,
        status: record.status,
        exitCode: record.result.exitCode,
        signal: record.result.signal,
        durationMs: record.result.durationMs,
        stdoutBytes: Buffer.byteLength(record.result.stdout, 'utf8'),
        stderrBytes: Buffer.byteLength(record.result.stderr, 'utf8'),
        outputTruncated: record.result.outputTruncated,
        streams: ['stdout', 'stderr']
      })
    }]
  })
  record.evidenceRefs = evidence.evidenceRefs
  record.evidenceUnavailable = evidence.evidenceUnavailable
}

function recoverExpiredRunningJobsInStore(store: WorkbenchValidationJobStore, now = new Date().toISOString()): WorkbenchValidationJobRecord[] {
  const nowMs = Date.parse(now)
  const recovered: WorkbenchValidationJobRecord[] = []
  for (const record of store.jobs) {
    if (record.status !== 'running' || !record.leaseExpiresAt) continue
    if (Date.parse(record.leaseExpiresAt) > nowMs) continue
    record.status = 'failed'
    record.updatedAt = now
    record.failedAt = now
    record.result = {
      exitCode: null,
      signal: null,
      durationMs: Math.max(0, nowMs - Date.parse(record.startedAt || record.leaseAcquiredAt || record.createdAt)),
      stdout: '',
      stderr: 'Validation worker lease expired before terminal evidence was persisted.',
      outputTruncated: false,
      changedPaths: [],
      reason: 'Validation worker lease expired before terminal evidence was persisted.',
      terminatedByInfrastructure: true,
      terminationReason: 'worker_failure'
    }
    attachValidationEvidence(record)
    record.leaseToken = undefined
    record.leaseAcquiredAt = undefined
    record.leaseExpiresAt = undefined
    recovered.push({ ...record, command: { ...record.command }, result: record.result ? { ...record.result } : undefined })
  }
  return recovered
}

function persistStore(store: WorkbenchValidationJobStore): void {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true })
  const cutoffMs = Date.now() - TERMINAL_JOB_RETENTION_MS
  const TERMINAL_STATUSES = new Set<WorkbenchValidationJobStatus>(['completed', 'failed', 'timed_out', 'cancelled'])
  const payload: WorkbenchValidationJobStore = {
    version: WORKBENCH_VALIDATION_JOB_STORE_VERSION,
    updatedAt: new Date().toISOString(),
    jobs: [...store.jobs]
      .filter(job => !TERMINAL_STATUSES.has(job.status) || Date.parse(job.updatedAt) > cutoffMs)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-MAX_JOB_RECORDS)
  }
  const temporaryPath = `${STORE_PATH}.tmp`
  fs.writeFileSync(temporaryPath, JSON.stringify(payload), 'utf8')
  fs.renameSync(temporaryPath, STORE_PATH)
}

function withExclusiveStoreLock<T>(callback: () => T): T | undefined {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true })
  const startedAt = Date.now()
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(LOCK_PATH, 'wx')
    recordGitLockTelemetry({
      storeKind: 'validation_jobs',
      waitMs: Date.now() - startedAt,
      contended: false
    })
    return callback()
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code)
      : ''
    if (code === 'EEXIST') {
      recordGitLockTelemetry({
        storeKind: 'validation_jobs',
        waitMs: Date.now() - startedAt,
        contended: true
      })
      return undefined
    }
    throw error
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    try {
      if (descriptor !== undefined && fs.existsSync(LOCK_PATH)) fs.unlinkSync(LOCK_PATH)
    } catch {
      // Leave an unknown lock for explicit operator recovery.
    }
  }
}

function boundedText(value: string): string {
  const buffer = Buffer.from(value || '', 'utf8')
  if (buffer.byteLength <= MAX_PERSISTED_OUTPUT_BYTES) return value || ''
  return buffer.subarray(buffer.byteLength - MAX_PERSISTED_OUTPUT_BYTES).toString('utf8')
}

function textTail(value: string | undefined): string | undefined {
  if (!value) return undefined
  const buffer = Buffer.from(value, 'utf8')
  if (buffer.byteLength <= COMPACT_OUTPUT_TAIL_BYTES) return value
  return buffer.subarray(buffer.byteLength - COMPACT_OUTPUT_TAIL_BYTES).toString('utf8')
}

function textBytes(value: string | undefined): number | undefined {
  return value === undefined ? undefined : Buffer.byteLength(value, 'utf8')
}

function resultAvailableUntil(record: WorkbenchValidationJobRecord): string | undefined {
  if (!record.result || !['completed', 'failed', 'timed_out', 'cancelled'].includes(record.status)) return undefined
  return new Date(Date.parse(record.updatedAt) + RESULT_RETENTION_MS).toISOString()
}

type NormalizeValidationJobRequestResult =
  | { ok: true; request: WorkbenchValidationJobRequest }
  | { ok: false; field: string; reason: string; allowedValues?: string[] }

function normalizeRequest(request: WorkbenchValidationJobRequest): NormalizeValidationJobRequestResult {
  const sourceId = String(request.sourceId || '').trim()
  if (!sourceId) return { ok: false, field: 'sourceId', reason: 'sourceId is required.' }

  const sessionId = request.sessionId ? String(request.sessionId).trim() : undefined
  if (sessionId && !EVIDENCE_OWNER_ID.test(sessionId)) return { ok: false, field: 'sessionId', reason: 'sessionId is invalid.' }

  const idempotencyKey = String(request.idempotencyKey || '').trim()
  if (!idempotencyKey) return { ok: false, field: 'idempotencyKey', reason: 'idempotencyKey is required.' }
  if (idempotencyKey.length > 200) return { ok: false, field: 'idempotencyKey', reason: 'idempotencyKey must be 200 characters or fewer.' }

  if (!ALLOWED_COMMAND_KINDS.has(request.commandKind)) {
    return {
      ok: false,
      field: 'commandKind',
      reason: `Unsupported persisted validation command: ${String(request.commandKind || '')}`,
      allowedValues: Array.from(ALLOWED_COMMAND_KINDS)
    }
  }

  if (request.commandKind === 'run_package_script' && !String(request.scriptName || '').trim()) {
    return { ok: false, field: 'scriptName', reason: 'scriptName is required for run_package_script.' }
  }
  if (request.commandKind === 'run_package_test_marker' && !String(request.marker || '').trim()) {
    return { ok: false, field: 'marker', reason: 'marker is required for run_package_test_marker.' }
  }
  if (request.commandKind === 'git_diff_check' || request.commandKind === 'validate_json_files' || request.commandKind === 'security_scan_paths') {
    if (!Array.isArray(request.paths) || request.paths.length === 0 || request.paths.some(item => typeof item !== 'string' || !item.trim())) {
      return { ok: false, field: 'paths', reason: `paths are required for ${request.commandKind}.` }
    }
    if (request.paths.some(item => item.startsWith('/') || item.includes('\\') || item.split('/').some(part => !part || part === '.' || part === '..'))) {
      return { ok: false, field: 'paths', reason: 'Validation paths must be normalized repository-relative paths.' }
    }
    if (request.commandKind === 'validate_json_files' && request.paths.some(item => !item.endsWith('.json'))) {
      return { ok: false, field: 'paths', reason: 'validate_json_files only accepts JSON paths.' }
    }
    if (request.commandKind === 'security_scan_paths' && !request.patternSet) {
      return { ok: false, field: 'patternSet', reason: 'patternSet is required for security_scan_paths.' }
    }
    if (request.commandKind === 'security_scan_paths' && !['forbidden_runtime_execution', 'forbidden_secret_material', 'forbidden_upload_network', 'forbidden_all_high_risk'].includes(request.patternSet || '')) {
      return { ok: false, field: 'patternSet', reason: 'security_scan_paths patternSet is not allowlisted.' }
    }
  }
  if (request.commandKind === 'run_exact_command') {
    if (request.executable !== 'node' && request.executable !== 'pnpm' && request.executable !== 'rg') {
      return { ok: false, field: 'executable', reason: 'executable is required for run_exact_command.', allowedValues: ['node', 'pnpm', 'rg'] }
    }
    if (!Array.isArray(request.args) || request.args.length === 0) {
      return { ok: false, field: 'args', reason: 'A non-empty exact argument array is required for run_exact_command.' }
    }
    if (request.args.some(item => typeof item !== 'string' || item.length === 0 || item.length > 500)) {
      return { ok: false, field: 'args', reason: 'Every exact argument must be a non-empty string of at most 500 characters.' }
    }
  }
  if (request.nodeVersion !== undefined && request.nodeVersion !== '20') {
    return { ok: false, field: 'nodeVersion', reason: 'Only the approved Node 20 runtime is supported.', allowedValues: ['20'] }
  }
  if (request.networkAccess !== undefined && request.networkAccess !== false) {
    return { ok: false, field: 'networkAccess', reason: 'Persisted validation jobs do not allow network access.', allowedValues: ['false'] }
  }

  const timeoutMs = Math.max(
    MIN_TIMEOUT_MS,
    Math.min(Number.isFinite(request.timeoutMs) ? Math.floor(request.timeoutMs as number) : 300_000, MAX_TIMEOUT_MS)
  )

  return {
    ok: true,
    request: {
      sourceId,
      sessionId,
      idempotencyKey,
      commandKind: request.commandKind,
      packageDir: request.packageDir ? String(request.packageDir).trim() : undefined,
      scriptName: request.scriptName ? String(request.scriptName).trim() : undefined,
      marker: request.marker ? String(request.marker).trim() : undefined,
      paths: Array.isArray(request.paths) ? Array.from(new Set(request.paths.map(item => String(item).trim()).filter(Boolean))).slice(0, 50) : undefined,
      patternSet: request.patternSet,
      timeoutMs,
      runId: request.runId ? String(request.runId).trim() : undefined,
      packetId: request.packetId ? String(request.packetId).trim() : undefined,
      taskId: request.taskId ? String(request.taskId).trim() : undefined,
      executable: request.executable,
      args: Array.isArray(request.args) ? request.args.map(item => String(item)) : undefined,
      nodeVersion: request.nodeVersion,
      policy: request.policy ? { ...request.policy } : undefined,
      requiredBranch: request.requiredBranch ? String(request.requiredBranch).trim() : undefined,
      protectedPaths: Array.isArray(request.protectedPaths)
        ? Array.from(new Set(request.protectedPaths.map(item => String(item).trim()).filter(Boolean))).slice(0, 50)
        : undefined,
      networkAccess: false
    }
  }
}

function sameCommand(a: WorkbenchValidationJobRequest, b: WorkbenchValidationJobRequest): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function compactWorkbenchValidationJob(record: WorkbenchValidationJobRecord): CompactWorkbenchValidationJob {
  return {
    jobId: record.jobId,
    sourceId: record.sourceId,
    runId: record.runId,
    packetId: record.packetId,
    taskId: record.taskId,
    status: record.status,
    commandKind: record.command.commandKind,
    packageDir: record.command.packageDir,
    scriptName: record.command.scriptName,
    marker: record.command.marker,
    paths: record.command.paths,
    patternSet: record.command.patternSet,
    executable: record.command.executable,
    args: record.command.args,
    nodeVersion: record.command.nodeVersion,
    timeoutMs: record.command.timeoutMs,
    requiredBranch: record.command.requiredBranch,
    protectedPaths: record.command.protectedPaths,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    startedAt: record.startedAt,
    completedAt: record.completedAt || record.failedAt || record.cancelledAt,
    exitCode: record.result?.exitCode,
    signal: record.result?.signal,
    durationMs: record.result?.durationMs,
    outputTruncated: record.result?.outputTruncated,
    resultRef: record.jobId,
    stdoutBytes: textBytes(record.result?.stdout),
    stderrBytes: textBytes(record.result?.stderr),
    resultAvailableUntil: resultAvailableUntil(record),
    stdout: record.result?.stdout,
    stderr: record.result?.stderr,
    stdoutTail: textTail(record.result?.stdout),
    stderrTail: textTail(record.result?.stderr),
    changedPaths: record.result?.changedPaths.slice(0, 50),
    protectedPathsChanged: record.result?.protectedPathsChanged?.slice(0, 50),
    actualBranch: record.result?.actualBranch,
    reason: record.result?.reason,
    details: record.result?.details,
    runtime: record.result?.runtime,
    terminatedByInfrastructure: record.result?.terminatedByInfrastructure,
    terminationReason: record.result?.terminationReason,
    evidenceRefs: record.evidenceRefs,
    evidenceUnavailable: record.evidenceUnavailable
  }
}

export type PublicCompactWorkbenchValidationJob = Omit<CompactWorkbenchValidationJob, 'stdout' | 'stderr' | 'details' | 'stdoutTail' | 'stderrTail'>

/** Public action projection: keep metadata and the durable reference, never output content. */
export function compactWorkbenchValidationJobForPublic(record: WorkbenchValidationJobRecord): PublicCompactWorkbenchValidationJob {
  const compact = compactWorkbenchValidationJob(record)
  const {
    stdout: _stdout,
    stderr: _stderr,
    details: _details,
    stdoutTail: _stdoutTail,
    stderrTail: _stderrTail,
    ...publicJob
  } = compact
  return publicJob
}

export type ValidationJobResultPage = {
  resultRef: string
  stream: 'stdout' | 'stderr'
  text: string
  offset: number
  returnedBytes: number
  totalBytes: number
  complete: boolean
  outputTruncated: boolean
  nextCursor?: string
}

export type GetValidationJobResultPageResult =
  | { ok: true; page: ValidationJobResultPage }
  | { ok: false; code: 'VALIDATION_JOB_NOT_FOUND' | 'VALIDATION_RESULT_CURSOR_INVALID' | 'VALIDATION_RESULT_STREAM_EMPTY' | 'VALIDATION_RESULT_REDACTION_FAILED'; message: string }

type ValidationResultCursor = { version: 1; jobId: string; stream: 'stdout' | 'stderr'; offset: number }

function encodeResultCursor(cursor: ValidationResultCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeResultCursor(value: string): ValidationResultCursor | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<ValidationResultCursor>
    if (parsed.version !== 1 || typeof parsed.jobId !== 'string' || (parsed.stream !== 'stdout' && parsed.stream !== 'stderr') || !Number.isInteger(parsed.offset) || parsed.offset < 0) return undefined
    return parsed as ValidationResultCursor
  } catch {
    return undefined
  }
}

function utf8SafeEnd(buffer: Buffer, start: number, proposedEnd: number): number {
  let end = proposedEnd
  while (end > start && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end -= 1
  return end > start ? end : Math.min(buffer.length, start + 1)
}

export function getWorkbenchValidationJobResultPage(params: {
  jobId: string
  sourceId: string
  stream: 'stdout' | 'stderr'
  cursor?: string
  pageBytes?: number
}): GetValidationJobResultPageResult {
  const record = getWorkbenchValidationJob(params.jobId, params.sourceId)
  if (!record) return { ok: false, code: 'VALIDATION_JOB_NOT_FOUND', message: 'Validation job was not found for the selected source.' }
  const cursor = params.cursor ? decodeResultCursor(params.cursor) : undefined
  if (params.cursor && (!cursor || cursor.jobId !== record.jobId || cursor.stream !== params.stream)) {
    return { ok: false, code: 'VALIDATION_RESULT_CURSOR_INVALID', message: 'The result cursor is invalid for this job and stream. Restart from the resultRef.' }
  }
  const value = params.stream === 'stdout' ? record.result?.stdout : record.result?.stderr
  if (value === undefined) return { ok: false, code: 'VALIDATION_RESULT_STREAM_EMPTY', message: `No ${params.stream} result is available yet.` }
  let redactedValue: string
  try {
    redactedValue = redactSecrets(value)
  } catch {
    return { ok: false, code: 'VALIDATION_RESULT_REDACTION_FAILED', message: 'Validation result redaction failed closed.' }
  }
  const buffer = Buffer.from(redactedValue, 'utf8')
  const offset = cursor?.offset ?? 0
  if (offset > buffer.byteLength) return { ok: false, code: 'VALIDATION_RESULT_CURSOR_INVALID', message: 'The result cursor is beyond the stored result.' }
  const pageBytes = Math.max(256, Math.min(Math.floor(params.pageBytes || RESULT_PAGE_DEFAULT_BYTES), RESULT_PAGE_MAX_BYTES))
  const proposedEnd = Math.min(buffer.byteLength, offset + pageBytes)
  const end = utf8SafeEnd(buffer, offset, proposedEnd)
  const text = buffer.subarray(offset, end).toString('utf8')
  const complete = end >= buffer.byteLength
  return {
    ok: true,
    page: {
      resultRef: record.jobId,
      stream: params.stream,
      text,
      offset,
      returnedBytes: Buffer.byteLength(text, 'utf8'),
      totalBytes: buffer.byteLength,
      complete,
      outputTruncated: record.result?.outputTruncated === true,
      ...(complete ? {} : { nextCursor: encodeResultCursor({ version: 1, jobId: record.jobId, stream: params.stream, offset: end }) })
    }
  }
}

export function submitWorkbenchValidationJob(request: WorkbenchValidationJobRequest): SubmitWorkbenchValidationJobResult {
  const normalizedResult = normalizeRequest(request)
  if (normalizedResult.ok === false) {
    return {
      ok: false,
      code: 'VALIDATION_JOB_INVALID',
      message: normalizedResult.reason,
      field: normalizedResult.field,
      reason: normalizedResult.reason,
      allowedValues: normalizedResult.allowedValues
    }
  }
  const normalized = normalizedResult.request

  try {
    const result = withExclusiveStoreLock<SubmitWorkbenchValidationJobResult>(() => {
      const store = readStore()
      const recovered = recoverExpiredRunningJobsInStore(store)
      const existing = store.jobs.find(job => job.sourceId === normalized.sourceId && job.idempotencyKey === normalized.idempotencyKey)
      if (existing) {
        if (recovered.length > 0) {
          persistStore(store)
          recovered.forEach(projectValidationTerminal)
        }
        if (!sameCommand(existing.command, normalized)) {
          return {
            ok: false,
            code: 'VALIDATION_JOB_IDEMPOTENCY_CONFLICT',
            message: 'The idempotency key is already associated with a different validation command.'
          }
        }
        return { ok: true, created: false, job: compactWorkbenchValidationJob(existing) }
      }

      const now = new Date().toISOString()
      const record: WorkbenchValidationJobRecord = {
        storeVersion: WORKBENCH_VALIDATION_JOB_STORE_VERSION,
        jobId: `validation-${crypto.randomUUID()}`,
        idempotencyKey: normalized.idempotencyKey,
        sourceId: normalized.sourceId,
        sessionId: normalized.sessionId,
        runId: normalized.runId,
        packetId: normalized.packetId,
        taskId: normalized.taskId,
        status: 'queued',
        command: normalized,
        createdAt: now,
        updatedAt: now
      }
      store.jobs.push(record)
      persistStore(store)
      recovered.forEach(projectValidationTerminal)
      return { ok: true, created: true, job: compactWorkbenchValidationJob(record) }
    })

    return result || {
      ok: false,
      code: 'VALIDATION_JOB_STORE_BUSY',
      message: 'Validation job storage is busy. Retry the same idempotent submission.'
    }
  } catch (error) {
    if (error instanceof ValidationJobStoreCorruptError) {
      return { ok: false, code: 'VALIDATION_JOB_STORE_CORRUPT', message: error.message }
    }
    throw error
  }
}

export function getWorkbenchValidationJob(jobId: string, sourceId?: string): WorkbenchValidationJobRecord | undefined {
  const normalizedJobId = String(jobId || '').trim()
  const normalizedSourceId = sourceId ? String(sourceId).trim() : undefined
  const recoveredStore = withExclusiveStoreLock(() => {
    const store = readStore()
    const recovered = recoverExpiredRunningJobsInStore(store)
    if (recovered.length > 0) {
      persistStore(store)
      recovered.forEach(projectValidationTerminal)
    }
    return store
  })
  const store = recoveredStore ?? readStore()
  return store.jobs.find(job => job.jobId === normalizedJobId && (!normalizedSourceId || job.sourceId === normalizedSourceId))
}

export function getCompactWorkbenchValidationJob(jobId: string, sourceId?: string): CompactWorkbenchValidationJob | undefined {
  const record = getWorkbenchValidationJob(jobId, sourceId)
  return record ? compactWorkbenchValidationJob(record) : undefined
}

export function listCompactWorkbenchValidationJobs(params: {
  sourceId: string
  runId?: string
  limit?: number
}): CompactWorkbenchValidationJob[] {
  const sourceId = String(params.sourceId || '').trim()
  const runId = params.runId ? String(params.runId).trim() : undefined
  const limit = Math.max(1, Math.min(Math.floor(params.limit || 20), 100))
  const recoveredStore = withExclusiveStoreLock(() => {
    const store = readStore()
    const recovered = recoverExpiredRunningJobsInStore(store)
    if (recovered.length > 0) {
      persistStore(store)
      recovered.forEach(projectValidationTerminal)
    }
    return store
  })
  const store = recoveredStore ?? readStore()
  return store.jobs
    .filter(job => job.sourceId === sourceId && (!runId || job.runId === runId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit)
    .map(compactWorkbenchValidationJob)
}

export type RecoverExpiredWorkbenchValidationJobsResult =
  | { ok: true; recovered: number }
  | { ok: false; code: 'VALIDATION_JOB_STORE_BUSY' | 'VALIDATION_JOB_STORE_CORRUPT'; message: string }

export function recoverExpiredWorkbenchValidationJobs(now = new Date().toISOString()): RecoverExpiredWorkbenchValidationJobsResult {
  try {
    const result = withExclusiveStoreLock(() => {
      const store = readStore()
      const recovered = recoverExpiredRunningJobsInStore(store, now)
      if (recovered.length > 0) {
        persistStore(store)
        recovered.forEach(projectValidationTerminal)
      }
      return { ok: true as const, recovered: recovered.length }
    })
    return result ?? { ok: false, code: 'VALIDATION_JOB_STORE_BUSY', message: 'Validation job storage is busy.' }
  } catch (error) {
    if (error instanceof ValidationJobStoreCorruptError) {
      return { ok: false, code: 'VALIDATION_JOB_STORE_CORRUPT', message: error.message }
    }
    throw error
  }
}

export function recordWorkbenchValidationJobResult(params: {
  jobId: string
  sourceId: string
  status: TerminalValidationJobStatus
  result: WorkbenchValidationJobResult
}): CompactWorkbenchValidationJob | undefined {
  const transition = withExclusiveStoreLock(() => {
    const store = readStore()
    const record = store.jobs.find(job => job.jobId === params.jobId && job.sourceId === params.sourceId)
    if (!record) return undefined
    const recovered = recoverExpiredRunningJobsInStore(store)
    const alreadyTerminal = ['completed', 'failed', 'timed_out', 'cancelled'].includes(record.status)
    if (alreadyTerminal) {
      if (recovered.length > 0) {
        persistStore(store)
        recovered.forEach(projectValidationTerminal)
      }
      return {
        compact: compactWorkbenchValidationJob(record),
        record: { ...record, command: { ...record.command }, result: record.result ? { ...record.result } : undefined },
        shouldRecordTelemetry: false
      }
    }
    const now = new Date().toISOString()
    record.status = params.status
    record.updatedAt = now
    if (params.status === 'completed') record.completedAt = now
    if (params.status === 'failed' || params.status === 'timed_out') record.failedAt = now
    if (params.status === 'cancelled') record.cancelledAt = now
    record.result = {
      ...params.result,
      stdout: boundedText(params.result.stdout),
      stderr: boundedText(params.result.stderr),
      changedPaths: Array.from(new Set(params.result.changedPaths)).sort().slice(0, 200)
    }
    attachValidationEvidence(record)
    record.leaseToken = undefined
    record.leaseAcquiredAt = undefined
    record.leaseExpiresAt = undefined
    persistStore(store)
    return {
      compact: compactWorkbenchValidationJob(record),
      record: { ...record, command: { ...record.command }, result: record.result ? { ...record.result } : undefined },
      shouldRecordTelemetry: true
    }
  })
  if (!transition) return undefined
  if (transition.shouldRecordTelemetry) {
    projectValidationTerminal(transition.record)
    recordValidationJobTelemetry(transition.record, params.status, params.result.durationMs)
  }
  return transition.compact
}

export function toSafeCommandRequest(job: WorkbenchValidationJobRecord, sourceRoot: string): SafeCommandRequest {
  return {
    commandKind: job.command.commandKind,
    sourceId: job.sourceId,
    sourceRoot,
    timeoutMs: job.command.timeoutMs,
    packageDir: job.command.packageDir,
    scriptName: job.command.scriptName,
    marker: job.command.marker,
    paths: job.command.paths,
    patternSet: job.command.patternSet,
    executable: job.command.executable,
    args: job.command.args,
    nodeVersion: job.command.nodeVersion,
    policy: job.command.policy,
    requiredBranch: job.command.requiredBranch,
    protectedPaths: job.command.protectedPaths,
    networkAccess: false,
    persistedValidation: true
  }
}

export type ScheduleWorkbenchValidationJobResult = {
  status: 'scheduled' | 'already_running' | 'rejected'
  jobId: string
  sourceId: string
  workerId?: string
  reason?: string
}

export type CancelWorkbenchValidationJobResult =
  | { ok: true; job: CompactWorkbenchValidationJob; cancellationRequested: boolean }
  | { ok: false; code: 'VALIDATION_JOB_NOT_FOUND' | 'VALIDATION_JOB_STORE_BUSY' | 'VALIDATION_JOB_STORE_CORRUPT'; message: string }

const scheduledValidationJobIds = new Set<string>()
const scheduledValidationJobControllers = new Map<string, AbortController>()

export function cancelWorkbenchValidationJob(params: {
  jobId: string
  sourceId: string
  reason?: string
}): CancelWorkbenchValidationJobResult {
  const jobId = String(params.jobId || '').trim()
  const sourceId = String(params.sourceId || '').trim()
  if (!jobId || !sourceId) {
    return { ok: false, code: 'VALIDATION_JOB_NOT_FOUND', message: 'Job ID and source ID are required.' }
  }

  let transition:
    | { kind: 'not_found' }
    | { kind: 'terminal'; job: CompactWorkbenchValidationJob }
    | { kind: 'requested'; job: CompactWorkbenchValidationJob; running: boolean }
    | undefined
  try {
    transition = withExclusiveStoreLock(() => {
      const store = readStore()
      const recovered = recoverExpiredRunningJobsInStore(store)
      const record = store.jobs.find(job => job.jobId === jobId && job.sourceId === sourceId)
      if (!record) {
        if (recovered.length > 0) {
          persistStore(store)
          recovered.forEach(projectValidationTerminal)
        }
        return { kind: 'not_found' as const }
      }
      if (['completed', 'failed', 'timed_out', 'cancelled'].includes(record.status)) {
        if (recovered.length > 0) {
          persistStore(store)
          recovered.forEach(projectValidationTerminal)
        }
        return { kind: 'terminal' as const, job: compactWorkbenchValidationJob(record) }
      }

      const now = new Date().toISOString()
      record.cancelRequestedAt = record.cancelRequestedAt || now
      record.cancelReason = String(params.reason || 'validation plan cancellation requested').slice(0, 500)
      record.updatedAt = now

      if (record.status === 'queued') {
        record.status = 'cancelled'
        record.cancelledAt = now
        record.result = {
          exitCode: null,
          signal: null,
          durationMs: 0,
          stdout: '',
          stderr: '',
          outputTruncated: false,
          changedPaths: [],
          terminatedByInfrastructure: false,
          terminationReason: 'cancelled'
        }
        attachValidationEvidence(record)
      }

      persistStore(store)
      if (record.status === 'cancelled') {
        projectValidationTerminal({ ...record, command: { ...record.command }, result: record.result ? { ...record.result } : undefined })
      }
      return { kind: 'requested' as const, job: compactWorkbenchValidationJob(record), running: record.status === 'running' }
    })
  } catch (error) {
    if (error instanceof ValidationJobStoreCorruptError) {
      return { ok: false, code: 'VALIDATION_JOB_STORE_CORRUPT', message: error.message }
    }
    throw error
  }

  if (!transition) return { ok: false, code: 'VALIDATION_JOB_STORE_BUSY', message: 'Validation job store is busy.' }
  if (transition.kind === 'not_found') return { ok: false, code: 'VALIDATION_JOB_NOT_FOUND', message: 'Validation job was not found for the selected source.' }
  if (transition.kind === 'terminal') return { ok: true, job: transition.job, cancellationRequested: false }
  if (transition.running) scheduledValidationJobControllers.get(jobId)?.abort('validation plan cancellation requested')
  return { ok: true, job: transition.job, cancellationRequested: true }
}

function claimWorkbenchValidationJob(params: {
  jobId: string
  sourceId: string
  workerId: string
  leaseMs: number
}): WorkbenchValidationJobRecord | undefined {
  const transition = withExclusiveStoreLock(() => {
    const store = readStore()
    const recovered = recoverExpiredRunningJobsInStore(store)
    const record = store.jobs.find(job => job.jobId === params.jobId && job.sourceId === params.sourceId)
    if (!record || record.status !== 'queued') {
      if (recovered.length > 0) persistStore(store)
      return { claimed: undefined, recovered }
    }

    const now = new Date()
    record.status = 'running'
    record.startedAt = now.toISOString()
    record.updatedAt = record.startedAt
    record.workerId = params.workerId
    record.leaseToken = crypto.randomUUID()
    record.leaseAcquiredAt = record.startedAt
    record.leaseExpiresAt = new Date(now.getTime() + params.leaseMs).toISOString()
    persistStore(store)
    return { claimed: { ...record, command: { ...record.command } }, recovered }
  })
  transition?.recovered.forEach(projectValidationTerminal)
  if (transition?.claimed) projectValidationStarted(transition.claimed)
  return transition?.claimed
}

function terminalStatus(result: SafeCommandResult): Extract<WorkbenchValidationJobStatus, 'completed' | 'failed' | 'timed_out' | 'cancelled'> {
  if (result.status === 'completed' && result.exitCode === 0) return 'completed'
  if (result.status === 'timed_out') return 'timed_out'
  if (result.reason === 'cancelled') return 'cancelled'
  return 'failed'
}

export function scheduleWorkbenchValidationJob(params: {
  jobId: string
  sourceId: string
  sourceRoot: string
  leaseMs?: number
}): ScheduleWorkbenchValidationJobResult {
  const jobId = String(params.jobId || '').trim()
  const sourceId = String(params.sourceId || '').trim()
  const sourceRoot = String(params.sourceRoot || '').trim()
  if (!jobId || !sourceId || !sourceRoot) {
    return { status: 'rejected', jobId, sourceId, reason: 'Job ID, source ID, and source root are required.' }
  }

  let existing: WorkbenchValidationJobRecord | undefined
  try {
    existing = getWorkbenchValidationJob(jobId, sourceId)
  } catch (error) {
    if (error instanceof ValidationJobStoreCorruptError) {
      return { status: 'rejected', jobId, sourceId, reason: error.message }
    }
    throw error
  }
  if (!existing) return { status: 'rejected', jobId, sourceId, reason: 'Validation job was not found for the selected source.' }
  if (existing.status === 'running' || scheduledValidationJobIds.has(jobId)) {
    return { status: 'already_running', jobId, sourceId, workerId: existing.workerId }
  }
  if (existing.status !== 'queued') {
    return { status: 'rejected', jobId, sourceId, reason: `Validation job is ${existing.status}; only queued jobs can be scheduled.` }
  }

  const workerId = `validation-worker-${process.pid}-${crypto.randomUUID()}`.slice(0, 160)
  const leaseMs = Math.max(30_000, Math.min(params.leaseMs || 360_000, 960_000))
  let claimed: WorkbenchValidationJobRecord | undefined
  try {
    claimed = claimWorkbenchValidationJob({ jobId, sourceId, workerId, leaseMs })
  } catch (error) {
    if (error instanceof ValidationJobStoreCorruptError) {
      return { status: 'rejected', jobId, sourceId, reason: error.message }
    }
    throw error
  }
  if (!claimed) return { status: 'already_running', jobId, sourceId }

  const controller = new AbortController()
  scheduledValidationJobIds.add(jobId)
  scheduledValidationJobControllers.set(jobId, controller)
  setImmediate(() => {
    void runSafeCommand({ ...toSafeCommandRequest(claimed, sourceRoot), signal: controller.signal })
      .then(result => {
        const status = terminalStatus(result)
        recordWorkbenchValidationJobResult({
          jobId,
          sourceId,
          status,
          result: {
            exitCode: result.exitCode,
            signal: result.signal,
            durationMs: result.durationMs,
            stdout: result.stdout,
            stderr: result.stderr,
            outputTruncated: result.outputTruncated,
            changedPaths: result.changedPaths || [],
            protectedPathsChanged: result.protectedPathsChanged || [],
            actualBranch: result.actualBranch,
            reason: result.reason,
            details: result.details,
            terminatedByInfrastructure: false,
            terminationReason: status === 'timed_out' ? 'job_timeout' : status === 'cancelled' ? 'cancelled' : undefined,
            runtime: result.runtime
          }
        })
      })
      .catch(error => {
        recordWorkbenchValidationJobResult({
          jobId,
          sourceId,
          status: 'failed',
          result: {
            exitCode: null,
            signal: null,
            durationMs: 0,
            stdout: '',
            stderr: error instanceof Error ? error.message : String(error),
            outputTruncated: false,
            changedPaths: [],
            terminatedByInfrastructure: false,
            terminationReason: 'worker_failure'
          }
        })
      })
      .finally(() => {
        scheduledValidationJobControllers.delete(jobId)
        scheduledValidationJobIds.delete(jobId)
      })
  })

  return { status: 'scheduled', jobId, sourceId, workerId }
}
