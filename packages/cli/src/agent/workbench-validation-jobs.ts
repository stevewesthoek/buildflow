import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { getConfigDir } from '../utils/paths'
import { runSafeCommand, type SafeCommandRequest, type SafeCommandResult } from './command-runner'

export const WORKBENCH_VALIDATION_JOB_STORE_VERSION = 1 as const

export type PersistedValidationCommandKind =
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
  idempotencyKey: string
  commandKind: PersistedValidationCommandKind
  packageDir?: string
  scriptName?: string
  marker?: string
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
      code: 'VALIDATION_JOB_STORE_BUSY' | 'VALIDATION_JOB_IDEMPOTENCY_CONFLICT' | 'VALIDATION_JOB_INVALID'
      message: string
      field?: string
      reason?: string
      allowedValues?: string[]
    }

const STORE_PATH = path.join(getConfigDir(), 'workbench-validation-jobs.json')
const LOCK_PATH = `${STORE_PATH}.lock`
const MAX_JOB_RECORDS = 300
const MAX_PERSISTED_OUTPUT_BYTES = 60_000
const COMPACT_OUTPUT_TAIL_BYTES = 4_000
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 900_000
const ALLOWED_COMMAND_KINDS = new Set<PersistedValidationCommandKind>([
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
    && typeof record.status === 'string'
    && typeof record.command?.commandKind === 'string'
    && typeof record.createdAt === 'string'
    && typeof record.updatedAt === 'string'
}

function readStore(): WorkbenchValidationJobStore {
  try {
    if (!fs.existsSync(STORE_PATH)) return emptyStore()
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as Partial<WorkbenchValidationJobStore>
    return {
      version: WORKBENCH_VALIDATION_JOB_STORE_VERSION,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs.filter(isRecord) : []
    }
  } catch {
    return emptyStore()
  }
}

function persistStore(store: WorkbenchValidationJobStore): void {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true })
  const payload: WorkbenchValidationJobStore = {
    version: WORKBENCH_VALIDATION_JOB_STORE_VERSION,
    updatedAt: new Date().toISOString(),
    jobs: [...store.jobs]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-MAX_JOB_RECORDS)
  }
  const temporaryPath = `${STORE_PATH}.tmp`
  fs.writeFileSync(temporaryPath, JSON.stringify(payload), 'utf8')
  fs.renameSync(temporaryPath, STORE_PATH)
}

function withExclusiveStoreLock<T>(callback: () => T): T | undefined {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true })
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(LOCK_PATH, 'wx')
    return callback()
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code)
      : ''
    if (code === 'EEXIST') return undefined
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

type NormalizeValidationJobRequestResult =
  | { ok: true; request: WorkbenchValidationJobRequest }
  | { ok: false; field: string; reason: string; allowedValues?: string[] }

function normalizeRequest(request: WorkbenchValidationJobRequest): NormalizeValidationJobRequestResult {
  const sourceId = String(request.sourceId || '').trim()
  if (!sourceId) return { ok: false, field: 'sourceId', reason: 'sourceId is required.' }

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
  if (request.commandKind === 'run_exact_command') {
    if (request.executable !== 'node' && request.executable !== 'pnpm') {
      return { ok: false, field: 'executable', reason: 'executable is required for run_exact_command.', allowedValues: ['node', 'pnpm'] }
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
      idempotencyKey,
      commandKind: request.commandKind,
      packageDir: request.packageDir ? String(request.packageDir).trim() : undefined,
      scriptName: request.scriptName ? String(request.scriptName).trim() : undefined,
      marker: request.marker ? String(request.marker).trim() : undefined,
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
    terminationReason: record.result?.terminationReason
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

  const result = withExclusiveStoreLock<SubmitWorkbenchValidationJobResult>(() => {
    const store = readStore()
    const existing = store.jobs.find(job => job.sourceId === normalized.sourceId && job.idempotencyKey === normalized.idempotencyKey)
    if (existing) {
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
    return { ok: true, created: true, job: compactWorkbenchValidationJob(record) }
  })

  return result || {
    ok: false,
    code: 'VALIDATION_JOB_STORE_BUSY',
    message: 'Validation job storage is busy. Retry the same idempotent submission.'
  }
}

export function getWorkbenchValidationJob(jobId: string, sourceId?: string): WorkbenchValidationJobRecord | undefined {
  const normalizedJobId = String(jobId || '').trim()
  const normalizedSourceId = sourceId ? String(sourceId).trim() : undefined
  return readStore().jobs.find(job => job.jobId === normalizedJobId && (!normalizedSourceId || job.sourceId === normalizedSourceId))
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
  return readStore().jobs
    .filter(job => job.sourceId === sourceId && (!runId || job.runId === runId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit)
    .map(compactWorkbenchValidationJob)
}

export function recordWorkbenchValidationJobResult(params: {
  jobId: string
  sourceId: string
  status: Extract<WorkbenchValidationJobStatus, 'completed' | 'failed' | 'timed_out' | 'cancelled'>
  result: WorkbenchValidationJobResult
}): CompactWorkbenchValidationJob | undefined {
  return withExclusiveStoreLock(() => {
    const store = readStore()
    const record = store.jobs.find(job => job.jobId === params.jobId && job.sourceId === params.sourceId)
    if (!record) return undefined
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
    persistStore(store)
    return compactWorkbenchValidationJob(record)
  })
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

const scheduledValidationJobIds = new Set<string>()

function claimWorkbenchValidationJob(params: {
  jobId: string
  sourceId: string
  workerId: string
  leaseMs: number
}): WorkbenchValidationJobRecord | undefined {
  return withExclusiveStoreLock(() => {
    const store = readStore()
    const record = store.jobs.find(job => job.jobId === params.jobId && job.sourceId === params.sourceId)
    if (!record || record.status !== 'queued') return undefined

    const now = new Date()
    record.status = 'running'
    record.startedAt = now.toISOString()
    record.updatedAt = record.startedAt
    record.workerId = params.workerId
    record.leaseToken = crypto.randomUUID()
    record.leaseAcquiredAt = record.startedAt
    record.leaseExpiresAt = new Date(now.getTime() + params.leaseMs).toISOString()
    persistStore(store)
    return { ...record, command: { ...record.command } }
  })
}

function terminalStatus(result: SafeCommandResult): Extract<WorkbenchValidationJobStatus, 'completed' | 'failed' | 'timed_out'> {
  if (result.status === 'completed' && result.exitCode === 0) return 'completed'
  if (result.status === 'timed_out') return 'timed_out'
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

  const existing = getWorkbenchValidationJob(jobId, sourceId)
  if (!existing) return { status: 'rejected', jobId, sourceId, reason: 'Validation job was not found for the selected source.' }
  if (existing.status === 'running' || scheduledValidationJobIds.has(jobId)) {
    return { status: 'already_running', jobId, sourceId, workerId: existing.workerId }
  }
  if (existing.status !== 'queued') {
    return { status: 'rejected', jobId, sourceId, reason: `Validation job is ${existing.status}; only queued jobs can be scheduled.` }
  }

  const workerId = `validation-worker-${process.pid}-${crypto.randomUUID()}`.slice(0, 160)
  const leaseMs = Math.max(30_000, Math.min(params.leaseMs || 360_000, 960_000))
  const claimed = claimWorkbenchValidationJob({ jobId, sourceId, workerId, leaseMs })
  if (!claimed) return { status: 'already_running', jobId, sourceId }

  scheduledValidationJobIds.add(jobId)
  setImmediate(() => {
    void runSafeCommand(toSafeCommandRequest(claimed, sourceRoot))
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
            terminationReason: status === 'timed_out' ? 'job_timeout' : undefined,
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
        scheduledValidationJobIds.delete(jobId)
      })
  })

  return { status: 'scheduled', jobId, sourceId, workerId }
}
