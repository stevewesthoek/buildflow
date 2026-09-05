import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { dispatchCapability, type CapabilityAdapter, type DispatchDecision, type DispatchRequest } from './capability-dispatch.js'
import { validateAndAuditCapability, type ExecutionValidationState } from './capability-pre-execution.js'
import type { CapabilityPlan } from './capability-planning.js'
import type { ProviderInventoryRecord } from './provider-inventory.js'
import { enforceCapabilityResult, redactCapabilityText, type CapabilityAuthorizedExecutionContext, type CapabilityRuntimeIdentity, type CapabilityValidationVerifier } from './capability-runtime-enforcement.js'
import { createPendingCapabilityArtifact, expireCapabilityArtifact, finalizeCapabilityArtifact, readBrokerOwnedArtifact, type BrokerOwnedOutputRoot, type CapabilityArtifactMetadata } from './capability-output-artifact.js'
import { CAPABILITY_MANIFEST_MAX_INLINE_BYTES } from '@workbench/shared'

export const WORKBENCH_EXECUTION_COORDINATOR_FILENAME = 'workbench-capability-executions.json' as const
export type ExecutionLifecycleState = 'pending' | 'requested' | 'validating' | 'dispatching' | 'running' | 'executing' | 'completing' | 'completed' | 'failed' | 'cancelled' | 'expired' | 'recovered'
export type ExecutionOwner = { runtimeId: string; clientId: string; sessionId: string; requestId: string }
export type ExecutionRequest = { executionId?: string; capabilityPlanId: string; contextSessionId: string; providerId: string; capabilityId: string; operation: string; requestIdentity: { requestedBy: string; requestedAt: string }; owner?: ExecutionOwner; signal?: AbortSignal; timeoutMs?: number }
export type CapabilityJobLifecycle = 'queued' | 'running' | 'validating' | 'succeeded' | 'failed' | 'cancelling' | 'cancelled'
export type CapabilityJobIdentity = {
  jobId: string
  capabilityId: string
  capabilityVersion: string
  sourceId: string
  sessionId: string
  runId: string
  requestId: string
  idempotencyKey: string
  evidenceId: string
  evidenceRef: string
}
export type CapabilityJobEvidence = {
  content: string
  byteLength: number
  truncated: boolean
  redactionState: 'redacted'
}
export type CapabilityJobResult = {
  status: 'succeeded' | 'failed' | 'cancelled'
  resultRef?: string
  evidenceRef: string
  output?: unknown
  outputBytes?: number
  outputState?: 'inline' | 'evidence-reference' | 'rejected'
  evidence?: CapabilityJobEvidence
  artifact?: CapabilityArtifactMetadata
  failure?: { code: string; message: string; retryable: boolean }
}
export type CapabilityJobState = CapabilityJobIdentity & {
  lifecycle: CapabilityJobLifecycle
  createdAt: string
  updatedAt: string
  queuedAt: string
  startedAt?: string
  terminalAt?: string
  currentStep: string
  cancelRequestedAt?: string
  cancelReason?: string
  requestFingerprint: string
  /** Internal broker-owned path; never included in projections or result payloads. */
  artifactRoot?: string
  artifact?: CapabilityArtifactMetadata
  result?: CapabilityJobResult
}
export type ExecutionRecord = { executionId: string; planId: string; dispatchId?: string; validationId?: string; adapterId?: string; lifecycleState: ExecutionLifecycleState; createdAt: string; updatedAt: string; owner?: ExecutionOwner; leaseExpiresAt?: string; result?: ExecutionResult; auditReferences: string[]; error?: { code: string; message: string }; job?: CapabilityJobState }
export type ExecutionResult = { status: 'completed' | 'failed' | 'cancelled'; output?: unknown; metadata: { providerId: string; capabilityId: string; operation: string; durationMs: number }; errors: Array<{ code: string; message: string }>; evidence: Array<{ check: string; passed: boolean; detail: string }>; auditReferences: string[] }
export type ExecutableCapabilityAdapter = CapabilityAdapter & { executeApproved?: (request: DispatchRequest & { dispatchId: string; operation: string; signal?: AbortSignal }, authorization: { decision: DispatchDecision; plan?: CapabilityPlan; validation?: unknown; provider?: ProviderInventoryRecord }) => Promise<{ status: 'completed' | 'failed' | 'cancelled'; output?: unknown; metadata?: { providerId: string; capabilityId: string; operation: string; durationMs: number }; errors?: Array<{ code: string; message: string }>; evidence?: Array<{ check: string; passed: boolean; detail: string }>; auditReferences?: { executionId: string; dispatchId: string; validationId: string } }> }
export type ExecutionCoordinatorOptions = { rootDir?: string; now?: () => Date; adapters: readonly ExecutableCapabilityAdapter[]; timeoutMs?: number; artifactRetentionMs?: number }
export type ExecutionCoordinatorResult = { ok: true; value: ExecutionRecord } | { ok: false; code: 'execution_audit_corrupt' | 'execution_audit_busy' | 'duplicate_execution'; message: string; record?: ExecutionRecord }
export type CapabilityJobRequest = {
  capabilityId: string
  capabilityVersion: string
  sourceId: string
  sessionId: string
  runId: string
  requestId: string
  idempotencyKey: string
  requestedBy: string
  input?: unknown
  timeoutMs?: number
}
export type CapabilityJobHandlerContext = {
  job: CapabilityJobIdentity
  /** Only manifest- and policy-bounded values cross the handler boundary. */
  authorized: CapabilityAuthorizedExecutionContext
  input: unknown
  signal: AbortSignal
  reportStep: (step: string) => void
}
export type CapabilityJobHandlerResult = {
  status: 'succeeded' | 'failed' | 'cancelled'
  output?: unknown
  outputBytes?: number
  resultRef?: string
  evidenceRef?: string
  outputState?: 'inline' | 'evidence-reference' | 'rejected'
  evidence?: CapabilityJobEvidence
  failure?: { code: string; message: string; retryable?: boolean }
}
export type CapabilityJobHandler = (context: CapabilityJobHandlerContext) => Promise<CapabilityJobHandlerResult>
export type CapabilityJobSubmitResult = { ok: true; value: ExecutionRecord } | { ok: false; code: 'job_store_corrupt' | 'job_store_busy' | 'job_idempotency_conflict' | 'job_invalid_request'; message: string; record?: ExecutionRecord }
export type CapabilityJobProjection = {
  jobId: string
  capabilityId: string
  capabilityVersion: string
  state: CapabilityJobLifecycle
  sourceId: string
  sessionId: string
  runId: string
  requestId: string
  idempotencyKey: string
  evidenceId: string
  evidenceRef: string
  createdAt: string
  queuedAt: string
  startedAt?: string
  terminalAt?: string
  queueWaitMs: number
  runElapsedMs: number
  currentStep: string
  cancelEligible: boolean
  artifact?: CapabilityArtifactMetadata
  result?: { status: CapabilityJobResult['status']; resultRef?: string; evidenceRef: string; output?: unknown; outputBytes?: number; outputState?: CapabilityJobResult['outputState']; evidence?: CapabilityJobEvidence; artifact?: CapabilityArtifactMetadata }
  failure?: { code: string; message: string; retryable: boolean }
}
export type CapabilityJobLookup = { jobId: string; sourceId: string; sessionId: string; runId: string; requestId: string }

type Store = { version: 1; updatedAt: string; records: ExecutionRecord[] }
function root(options: ExecutionCoordinatorOptions): string { return path.resolve(options.rootDir ?? path.join(process.cwd(), '.workbench-provider-state')) }
function file(options: ExecutionCoordinatorOptions): string { return path.join(root(options), WORKBENCH_EXECUTION_COORDINATOR_FILENAME) }
function read(options: ExecutionCoordinatorOptions): Store { try { if (!fs.existsSync(file(options))) return { version: 1, updatedAt: new Date(0).toISOString(), records: [] }; const value = JSON.parse(fs.readFileSync(file(options), 'utf8')) as Store; if (value.version !== 1 || !Array.isArray(value.records)) throw new Error('corrupt'); return value } catch { throw new Error('execution_audit_corrupt') } }
function write(store: Store, options: ExecutionCoordinatorOptions): void { fs.mkdirSync(root(options), { recursive: true, mode: 0o700 }); const temp = `${file(options)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`; fs.writeFileSync(temp, JSON.stringify({ version: 1, updatedAt: store.updatedAt, records: store.records.slice(-300) }), { encoding: 'utf8', mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file(options)); fs.chmodSync(file(options), 0o600) }
function save(record: ExecutionRecord, options: ExecutionCoordinatorOptions): void { const store = read(options); const index = store.records.findIndex(item => item.executionId === record.executionId); if (index >= 0) store.records[index] = record; else store.records.push(record); store.updatedAt = record.updatedAt; write(store, options) }
function state(record: ExecutionRecord, lifecycleState: ExecutionLifecycleState, at: string, extra: Partial<ExecutionRecord> = {}): ExecutionRecord { return { ...record, ...extra, lifecycleState, updatedAt: at } }
function failure(record: ExecutionRecord, code: string, message: string, lifecycleState: ExecutionLifecycleState, at: string, options: ExecutionCoordinatorOptions): ExecutionCoordinatorResult { const updated = state(record, lifecycleState, at, { error: { code, message } }); try { save(updated, options); return { ok: true, value: updated } } catch { return { ok: false, code: 'execution_audit_corrupt', message: 'Execution audit could not be persisted.', record: updated } } }

export function executeCapability(request: ExecutionRequest, input: { plan?: CapabilityPlan; validationState: ExecutionValidationState; provider?: ProviderInventoryRecord }, options: ExecutionCoordinatorOptions): Promise<ExecutionCoordinatorResult> {
  const now = options.now ?? (() => new Date()); const createdAt = now().toISOString(); const executionId = request.executionId ?? `capability-execution-${crypto.randomUUID()}`
  try { if (read(options).records.some(item => item.executionId === executionId)) return Promise.resolve({ ok: false, code: 'duplicate_execution', message: 'Execution identity already exists.' }) } catch { return Promise.resolve({ ok: false, code: 'execution_audit_corrupt', message: 'Execution cannot start without a valid execution store.' }) }
  const record: ExecutionRecord = { executionId, planId: request.capabilityPlanId, lifecycleState: 'pending', createdAt, updatedAt: createdAt, owner: request.owner, leaseExpiresAt: request.owner ? new Date(Date.parse(createdAt) + (request.timeoutMs ?? options.timeoutMs ?? 300_000)).toISOString() : undefined, auditReferences: [] }
  try { save(record, options) } catch { return Promise.resolve({ ok: false, code: 'execution_audit_corrupt', message: 'Execution cannot start without an execution audit record.' }) }
  return run(record, request, input, options)
}

async function run(initial: ExecutionRecord, request: ExecutionRequest, input: { plan?: CapabilityPlan; validationState: ExecutionValidationState; provider?: ProviderInventoryRecord }, options: ExecutionCoordinatorOptions): Promise<ExecutionCoordinatorResult> {
  const now = options.now ?? (() => new Date()); let record = initial; const update = (next: ExecutionRecord) => { record = next; save(record, options) }
  try {
    update(state(record, 'validating', now().toISOString()))
    const plan = input.plan
    const validation = validateAndAuditCapability({ capabilityPlanId: request.capabilityPlanId, contextSessionId: request.contextSessionId, providerId: request.providerId, capabilityId: request.capabilityId, manifestDigest: plan?.capabilityManifestDigest ?? '', requestedOperation: request.operation, timestamp: now().toISOString() }, { ...input.validationState, plan }, { rootDir: options.rootDir })
    if (!validation.ok) return failure(record, validation.code, validation.message, 'failed', now().toISOString(), options)
    update(state(record, 'dispatching', now().toISOString(), { validationId: validation.value.validationId }))
    const dispatchRequest: DispatchRequest = { capabilityPlanId: request.capabilityPlanId, validationId: validation.value.validationId, providerId: request.providerId, capabilityId: request.capabilityId, requestedOperation: request.operation, contextSessionId: request.contextSessionId, auditIdentity: request.requestIdentity }
    const dispatched = dispatchCapability(dispatchRequest, { plan, validation: validation.value, provider: input.provider, adapters: options.adapters }, { rootDir: options.rootDir })
    if (!dispatched.ok) return failure(record, dispatched.code, dispatched.message, 'failed', now().toISOString(), options)
    const decision = dispatched.value; update(state(record, decision.status === 'accepted' ? 'running' : 'failed', now().toISOString(), { dispatchId: decision.dispatchId, adapterId: decision.adapterId }))
    if (decision.status !== 'accepted' || !decision.adapterId) return failure(record, decision.rejectionReason ?? 'dispatch_rejected', 'Capability dispatch was not accepted.', 'failed', now().toISOString(), options)
    const adapter = options.adapters.find(item => item.adapterId === decision.adapterId)
    if (!adapter?.executeApproved) return failure(record, 'adapter_not_executable', 'Selected adapter does not expose an execution boundary.', 'failed', now().toISOString(), options)
    if (request.signal?.aborted) return failure(record, 'cancelled', 'Execution was cancelled before adapter execution.', 'cancelled', now().toISOString(), options)
    const controller = new AbortController(); const abort = () => controller.abort(); request.signal?.addEventListener('abort', abort, { once: true }); const timeout = request.timeoutMs ?? options.timeoutMs; const timer = timeout && setTimeout(() => controller.abort(), timeout)
    let result: Awaited<ReturnType<NonNullable<ExecutableCapabilityAdapter['executeApproved']>>>; try { result = await adapter.executeApproved({ ...dispatchRequest, dispatchId: decision.dispatchId, operation: request.operation, signal: controller.signal }, { decision, plan, validation: validation.value, provider: input.provider }) } finally { if (timer) clearTimeout(timer); request.signal?.removeEventListener('abort', abort) }
    const cancelled = request.signal?.aborted; const expired = !cancelled && !!timeout && controller.signal.aborted
    const normalized: ExecutionResult = { status: cancelled ? 'cancelled' : expired ? 'failed' : result.status, output: result.output, metadata: result.metadata ?? { providerId: request.providerId, capabilityId: request.capabilityId, operation: request.operation, durationMs: 0 }, errors: result.errors ?? [], evidence: result.evidence ?? [], auditReferences: result.auditReferences ? [result.auditReferences.executionId, result.auditReferences.dispatchId, result.auditReferences.validationId] : [] }
    update(state(record, 'completing', now().toISOString(), { result: normalized, auditReferences: normalized.auditReferences }))
    const terminal: ExecutionLifecycleState = cancelled ? 'cancelled' : expired ? 'expired' : normalized.status === 'completed' ? 'completed' : normalized.status === 'cancelled' ? 'cancelled' : 'failed'
    update(state(record, terminal, now().toISOString(), { result: normalized, auditReferences: normalized.auditReferences, error: terminal === 'expired' ? { code: 'timeout', message: 'Execution exceeded its bounded timeout.' } : undefined }))
    return { ok: true, value: record }
  } catch (error) { return failure(record, error instanceof Error && error.message === 'execution_audit_corrupt' ? 'execution_audit_corrupt' : 'execution_failed', 'Capability execution failed closed.', 'failed', now().toISOString(), options) }
}

export function listExecutionRecords(options: ExecutionCoordinatorOptions): ExecutionRecord[] { try { return read(options).records } catch { return [] } }
export function executionCoordinatorDiagnostics(options: ExecutionCoordinatorOptions): { active: string[]; failed: string[]; cancelled: string[]; expired: string[]; adapterAvailability: Array<{ adapterId: string; available: boolean; detail: string }>; history: string[] } { const records = listExecutionRecords(options); return { active: records.filter(item => ['pending', 'requested', 'validating', 'dispatching', 'running', 'executing', 'completing'].includes(item.lifecycleState)).map(item => item.executionId), failed: records.filter(item => item.lifecycleState === 'failed').map(item => item.executionId), cancelled: records.filter(item => item.lifecycleState === 'cancelled').map(item => item.executionId), expired: records.filter(item => item.lifecycleState === 'expired').map(item => item.executionId), adapterAvailability: options.adapters.map(adapter => ({ adapterId: adapter.adapterId, ...adapter.healthCheck() })), history: records.map(item => item.executionId) } }

const activeCapabilityJobs = new Map<string, { controller: AbortController }>()
const JOB_MAX_STRING = 256
const JOB_MAX_INPUT_BYTES = 64 * 1024
const JOB_MAX_RESULT_BYTES = CAPABILITY_MANIFEST_MAX_INLINE_BYTES
const JOB_MAX_EVIDENCE_BYTES = 32 * 1024
const JOB_DEFAULT_TIMEOUT_MS = 120_000
const JOB_MAX_TIMEOUT_MS = 300_000
const TERMINAL_JOB_STATES: readonly CapabilityJobLifecycle[] = ['succeeded', 'failed', 'cancelled']

function boundedJobString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= JOB_MAX_STRING
}

function stableJobJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJobJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJobJson(record[key])}`).join(',')}}`
}

function jobFingerprint(request: CapabilityJobRequest): string {
  return crypto.createHash('sha256').update(stableJobJson({
    capabilityId: request.capabilityId,
    capabilityVersion: request.capabilityVersion,
    sourceId: request.sourceId,
    sessionId: request.sessionId,
    runId: request.runId,
    idempotencyKey: request.idempotencyKey,
    requestedBy: request.requestedBy,
    input: request.input
  })).digest('hex')
}

function jobRequestValid(request: CapabilityJobRequest): boolean {
  if (![request.capabilityId, request.capabilityVersion, request.sourceId, request.sessionId, request.runId, request.requestId, request.idempotencyKey, request.requestedBy].every(boundedJobString)) return false
  if (request.timeoutMs !== undefined && (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > JOB_MAX_TIMEOUT_MS)) return false
  try { return Buffer.byteLength(JSON.stringify(request.input ?? null), 'utf8') <= JOB_MAX_INPUT_BYTES } catch { return false }
}

function jobLookupMatches(job: CapabilityJobState, lookup: CapabilityJobLookup): boolean {
  return job.jobId === lookup.jobId && job.sourceId === lookup.sourceId && job.sessionId === lookup.sessionId && job.runId === lookup.runId && job.requestId === lookup.requestId
}

function jobIdentityFromRequest(jobId: string, request: CapabilityJobRequest): CapabilityJobIdentity {
  return {
    jobId,
    capabilityId: request.capabilityId,
    capabilityVersion: request.capabilityVersion,
    sourceId: request.sourceId,
    sessionId: request.sessionId,
    runId: request.runId,
    requestId: request.requestId,
    idempotencyKey: request.idempotencyKey,
    evidenceId: `capability-job-evidence-${jobId}`,
    evidenceRef: `workbench://capability-jobs/${jobId}/evidence`
  }
}

function jobProjection(record: ExecutionRecord, at: Date): CapabilityJobProjection | undefined {
  const job = record.job
  if (!job) return undefined
  const nowMs = at.getTime()
  const createdMs = Date.parse(job.createdAt)
  const startedMs = job.startedAt ? Date.parse(job.startedAt) : undefined
  const terminalMs = job.terminalAt ? Date.parse(job.terminalAt) : undefined
  return {
    jobId: job.jobId,
    capabilityId: job.capabilityId,
    capabilityVersion: job.capabilityVersion,
    state: job.lifecycle,
    sourceId: job.sourceId,
    sessionId: job.sessionId,
    runId: job.runId,
    requestId: job.requestId,
    idempotencyKey: job.idempotencyKey,
    evidenceId: job.evidenceId,
    evidenceRef: job.evidenceRef,
    createdAt: job.createdAt,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    terminalAt: job.terminalAt,
    queueWaitMs: startedMs === undefined ? 0 : Math.max(0, startedMs - createdMs),
    runElapsedMs: startedMs === undefined ? 0 : Math.max(0, (terminalMs ?? nowMs) - startedMs),
    currentStep: job.currentStep,
    cancelEligible: job.lifecycle === 'queued' || job.lifecycle === 'running',
    ...(job.artifact ? { artifact: job.artifact } : {}),
    ...(job.result ? {
      result: {
        status: job.result.status,
        ...(job.result.resultRef ? { resultRef: job.result.resultRef } : {}),
        evidenceRef: job.result.evidenceRef,
        ...(job.result.output !== undefined ? { output: job.result.output } : {}),
        ...(job.result.outputBytes !== undefined ? { outputBytes: job.result.outputBytes } : {}),
        ...(job.result.outputState ? { outputState: job.result.outputState } : {}),
        ...(job.result.evidence ? { evidence: job.result.evidence } : {}),
        ...(job.result.artifact ? { artifact: job.result.artifact } : {})
      }
    } : {}),
    ...(job.result?.failure ? { failure: job.result.failure } : {})
  }
}

function jobFailure(code: string, message: string, retryable = false): CapabilityJobHandlerResult {
  return { status: 'failed', failure: { code, message, retryable } }
}

function boundedJobOutput(output: unknown): { output?: unknown; outputBytes?: number } {
  try {
    const outputBytes = Buffer.byteLength(JSON.stringify(output), 'utf8')
    return outputBytes <= JOB_MAX_RESULT_BYTES ? { output, outputBytes } : { outputBytes }
  } catch {
    return {}
  }
}

function boundedJobEvidence(evidence: CapabilityJobEvidence | undefined): CapabilityJobEvidence | undefined {
  if (!evidence || typeof evidence.content !== 'string' || evidence.redactionState !== 'redacted') return undefined
  const contentBytes = Buffer.byteLength(evidence.content, 'utf8')
  const boundedContent = contentBytes <= JOB_MAX_EVIDENCE_BYTES
    ? evidence.content
    : Buffer.from(evidence.content, 'utf8').subarray(0, JOB_MAX_EVIDENCE_BYTES).toString('utf8')
  return {
    content: boundedContent,
    byteLength: Number.isInteger(evidence.byteLength) && evidence.byteLength >= 0 ? Math.min(evidence.byteLength, 1024 * 1024) : contentBytes,
    truncated: evidence.truncated || boundedContent !== evidence.content,
    redactionState: 'redacted'
  }
}

export type CapabilityJobExecution = Readonly<{
  manifest: import('@workbench/shared').CapabilityManifest
  authorized: CapabilityAuthorizedExecutionContext
  identity: CapabilityRuntimeIdentity
  validationVerifiers?: Readonly<Record<string, CapabilityValidationVerifier>>
  artifact?: BrokerOwnedOutputRoot
}>

function terminalJobResult(identity: CapabilityJobIdentity, result: CapabilityJobHandlerResult, artifact?: CapabilityArtifactMetadata): CapabilityJobResult {
  const output = result.output === undefined && result.outputBytes !== undefined ? { outputBytes: result.outputBytes } : boundedJobOutput(result.output)
  const outputState = output.output !== undefined ? (result.outputState ?? 'inline') : result.output !== undefined ? 'evidence-reference' : result.outputState
  return {
    status: result.status,
    resultRef: result.resultRef ?? `workbench://capability-jobs/${identity.jobId}/result`,
    evidenceRef: result.evidenceRef ?? identity.evidenceRef,
    ...output,
    ...(outputState ? { outputState } : {}),
    ...(boundedJobEvidence(result.evidence) ? { evidence: boundedJobEvidence(result.evidence) } : {}),
    ...(artifact ? { artifact } : {}),
    ...(result.failure ? { failure: { code: redactCapabilityText(result.failure.code).slice(0, JOB_MAX_STRING), message: redactCapabilityText(result.failure.message).slice(0, 1_000), retryable: result.failure.retryable ?? false } } : {})
  }
}

function saveJobTerminal(record: ExecutionRecord, result: CapabilityJobHandlerResult, at: string, options: ExecutionCoordinatorOptions): void {
  if (!record.job || TERMINAL_JOB_STATES.includes(record.job.lifecycle)) return
  const artifact = record.job.artifact && record.job.artifactRoot
    ? finalizeCapabilityArtifact(record.job.artifactRoot, record.job.artifact, result.status === 'succeeded' ? 'available' : result.status)
    : record.job.artifact
  const normalized = terminalJobResult(record.job, result, artifact)
  const lifecycle = normalized.status
  const oldState: ExecutionLifecycleState = lifecycle === 'succeeded' ? 'completed' : lifecycle === 'cancelled' ? 'cancelled' : 'failed'
  record.job = { ...record.job, lifecycle, currentStep: lifecycle === 'succeeded' ? 'completed' : lifecycle, terminalAt: at, updatedAt: at, ...(artifact ? { artifact } : {}), result: normalized }
  record.lifecycleState = oldState
  record.updatedAt = at
  record.error = lifecycle === 'failed' && normalized.failure ? { code: normalized.failure.code, message: normalized.failure.message } : lifecycle === 'cancelled' ? { code: 'cancelled', message: 'Capability job was cancelled.' } : undefined
  record.result = {
    status: oldState === 'completed' ? 'completed' : oldState === 'cancelled' ? 'cancelled' : 'failed',
    ...(normalized.output !== undefined ? { output: normalized.output } : {}),
    metadata: { providerId: 'capability-broker-r17.2', capabilityId: record.job.capabilityId, operation: record.job.capabilityId, durationMs: record.job.startedAt ? Math.max(0, Date.parse(at) - Date.parse(record.job.startedAt)) : 0 },
    errors: normalized.failure ? [{ code: normalized.failure.code, message: normalized.failure.message }] : lifecycle === 'cancelled' ? [{ code: 'cancelled', message: 'Capability job was cancelled.' }] : [],
    evidence: [{ check: 'r17.2-job-lifecycle', passed: lifecycle === 'succeeded', detail: `Job reached terminal state ${lifecycle}.` }],
    auditReferences: [record.job.evidenceId]
  }
  record.auditReferences = [record.job.evidenceId]
  save(record, options)
}

async function runCapabilityJob(record: ExecutionRecord, request: CapabilityJobRequest, handler: CapabilityJobHandler, execution: CapabilityJobExecution, options: ExecutionCoordinatorOptions, controller: AbortController): Promise<void> {
  const now = options.now ?? (() => new Date())
  try {
    const current = read(options).records.find(item => item.executionId === record.executionId)
    if (!current?.job || current.job.lifecycle !== 'queued') return
    const startedAt = now().toISOString()
    current.job = { ...current.job, lifecycle: 'running', startedAt, currentStep: 'running', updatedAt: startedAt }
    current.lifecycleState = 'running'
    current.updatedAt = startedAt
    save(current, options)
    const reportStep = (step: string) => {
      if (!boundedJobString(step)) return
      try {
        const latest = read(options).records.find(item => item.executionId === record.executionId)
        if (!latest?.job || TERMINAL_JOB_STATES.includes(latest.job.lifecycle)) return
        latest.job = { ...latest.job, currentStep: step, updatedAt: now().toISOString() }
        latest.updatedAt = latest.job.updatedAt
        save(latest, options)
      } catch { /* terminal persistence reports the failure */ }
    }
    let timedOut = false
    let cancelResolve: ((value: CapabilityJobHandlerResult) => void) | undefined
    const cancellation = new Promise<CapabilityJobHandlerResult>(resolve => {
      cancelResolve = resolve
      controller.signal.addEventListener('abort', () => { if (!timedOut) resolve({ status: 'cancelled', failure: { code: 'cancelled', message: 'Capability job cancellation was acknowledged.', retryable: false } }) }, { once: true })
    })
    const timeoutMs = request.timeoutMs ?? options.timeoutMs ?? JOB_DEFAULT_TIMEOUT_MS
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      cancelResolve?.(jobFailure('job_timeout', 'Capability job exceeded its bounded timeout.', true))
    }, timeoutMs)
    const handlerResult = Promise.resolve().then(() => handler({ job: current.job!, authorized: execution.authorized, input: execution.authorized.input, signal: controller.signal, reportStep })).catch(error => jobFailure('handler_failed', error instanceof Error ? error.message : 'Capability handler failed safely.'))
    let result = await Promise.race([handlerResult, cancellation])
    if (!timedOut && !controller.signal.aborted && result.status === 'succeeded') {
      const validatingAt = now().toISOString()
      const validating = read(options).records.find(item => item.executionId === record.executionId)
      if (validating?.job && !TERMINAL_JOB_STATES.includes(validating.job.lifecycle)) {
        validating.job = { ...validating.job, lifecycle: 'validating', currentStep: 'validating', updatedAt: validatingAt }
        validating.lifecycleState = 'completing'
        validating.updatedAt = validatingAt
        save(validating, options)
        result = await Promise.race([
          enforceCapabilityResult(execution.manifest, result, { request: execution.identity, authorized: execution.authorized, job: validating.job, validationVerifiers: execution.validationVerifiers }),
          cancellation
        ])
      }
    }
    clearTimeout(timer)
    const finalResult = timedOut ? jobFailure('job_timeout', 'Capability job exceeded its bounded timeout.', true) : controller.signal.aborted ? { status: 'cancelled' as const, failure: { code: 'cancelled', message: 'Capability job cancellation was acknowledged.', retryable: false } } : result
    const latest = read(options).records.find(item => item.executionId === record.executionId)
    if (latest) saveJobTerminal(latest, finalResult, now().toISOString(), options)
  } catch (error) {
    try {
      const latest = read(options).records.find(item => item.executionId === record.executionId)
      if (latest) saveJobTerminal(latest, jobFailure('job_persistence_failed', error instanceof Error ? error.message : 'Capability job failed safely.'), now().toISOString(), options)
    } catch { /* the durable store has already failed closed */ }
  } finally {
    activeCapabilityJobs.delete(record.executionId)
  }
}

export function getCapabilityJobStorePath(options: Pick<ExecutionCoordinatorOptions, 'rootDir'> = {}): string { return file({ ...options, adapters: [] }) }

export function submitCapabilityJob(request: CapabilityJobRequest, handler: CapabilityJobHandler, execution: CapabilityJobExecution, options: ExecutionCoordinatorOptions): CapabilityJobSubmitResult {
  if (!jobRequestValid(request)) return { ok: false, code: 'job_invalid_request', message: 'Capability job identity or bounded input is invalid.' }
  if (execution.identity.sourceId !== request.sourceId || execution.identity.sessionId !== request.sessionId || execution.identity.runId !== request.runId || execution.identity.requestId !== request.requestId || execution.identity.capabilityId !== request.capabilityId || execution.identity.capabilityVersion !== request.capabilityVersion) return { ok: false, code: 'job_invalid_request', message: 'Capability execution authority does not match the job identity.' }
  let store: Store
  try { store = read(options) } catch { return { ok: false, code: 'job_store_corrupt', message: 'Capability job cannot start without a valid durable store.' } }
  const fingerprint = jobFingerprint(request)
  const prior = store.records.find(item => item.job && item.job.sourceId === request.sourceId && item.job.sessionId === request.sessionId && item.job.runId === request.runId && item.job.idempotencyKey === request.idempotencyKey)
  if (prior?.job) {
    if (prior.job.capabilityId !== request.capabilityId || prior.job.capabilityVersion !== request.capabilityVersion || prior.job.requestFingerprint !== fingerprint) return { ok: false, code: 'job_idempotency_conflict', message: 'Idempotency identity is already bound to a different capability request.', record: prior }
    return { ok: true, value: prior }
  }
  const jobId = `capability-job-${crypto.randomUUID()}`
  const createdAt = (options.now ?? (() => new Date()))().toISOString()
  const identity = jobIdentityFromRequest(jobId, request)
  const artifact = execution.artifact ? createPendingCapabilityArtifact(jobId, execution.artifact.artifactId, createdAt, options.artifactRetentionMs) : undefined
  const job: CapabilityJobState = { ...identity, lifecycle: 'queued', createdAt, updatedAt: createdAt, queuedAt: createdAt, currentStep: 'queued', requestFingerprint: fingerprint, ...(execution.artifact ? { artifactRoot: execution.artifact.root } : {}), ...(artifact ? { artifact } : {}) }
  const record: ExecutionRecord = { executionId: jobId, planId: `r17.2:${request.capabilityId}@${request.capabilityVersion}`, lifecycleState: 'pending', createdAt, updatedAt: createdAt, owner: { runtimeId: 'capability-broker-r17.2', clientId: request.requestedBy, sessionId: request.sessionId, requestId: request.requestId }, auditReferences: [identity.evidenceId], job }
  try {
    save(record, options)
    const controller = new AbortController()
    activeCapabilityJobs.set(jobId, { controller })
    setImmediate(() => { void runCapabilityJob(record, request, handler, execution, options, controller) })
    return { ok: true, value: record }
  } catch { return { ok: false, code: 'job_store_busy', message: 'Capability job could not be durably queued.' } }
}

export function getCapabilityJob(jobId: string, lookup: Omit<CapabilityJobLookup, 'jobId'>, options: ExecutionCoordinatorOptions): { ok: true; value: CapabilityJobProjection } | { ok: false; code: 'job_not_found' | 'job_identity_mismatch' | 'job_store_corrupt'; message: string } {
  try {
    const record = read(options).records.find(item => item.executionId === jobId && item.job)
    if (!record?.job) return { ok: false, code: 'job_not_found', message: `Capability job ${jobId} was not found.` }
    if (!jobLookupMatches(record.job, { jobId, ...lookup })) return { ok: false, code: 'job_identity_mismatch', message: 'Capability job identity does not match the requesting source, session, run, and request.' }
    const projection = jobProjection(record, (options.now ?? (() => new Date()))())
    return projection ? { ok: true, value: projection } : { ok: false, code: 'job_store_corrupt', message: 'Capability job projection is unavailable.' }
  } catch { return { ok: false, code: 'job_store_corrupt', message: 'Capability job store could not be read safely.' } }
}

export function findCapabilityJobByIdempotency(request: CapabilityJobRequest, options: ExecutionCoordinatorOptions): CapabilityJobProjection | undefined {
  try {
    const record = read(options).records.find(item => item.job && item.job.sourceId === request.sourceId && item.job.sessionId === request.sessionId && item.job.runId === request.runId && item.job.idempotencyKey === request.idempotencyKey && item.job.capabilityId === request.capabilityId && item.job.capabilityVersion === request.capabilityVersion)
    return record ? jobProjection(record, (options.now ?? (() => new Date()))()) : undefined
  } catch { return undefined }
}

export function listCapabilityJobProjections(options: ExecutionCoordinatorOptions, lookup?: Omit<CapabilityJobLookup, 'jobId'>): CapabilityJobProjection[] {
  try {
    return read(options).records.flatMap(record => {
      if (!record.job || (lookup && (record.job.sourceId !== lookup.sourceId || record.job.sessionId !== lookup.sessionId || record.job.runId !== lookup.runId || record.job.requestId !== lookup.requestId))) return []
      const projection = jobProjection(record, (options.now ?? (() => new Date()))())
      return projection ? [projection] : []
    }).slice(-300)
  } catch { return [] }
}

export function cancelCapabilityJob(jobId: string, lookup: Omit<CapabilityJobLookup, 'jobId'>, reason: string, options: ExecutionCoordinatorOptions): { ok: true; value: CapabilityJobProjection } | { ok: false; code: 'job_not_found' | 'job_identity_mismatch' | 'job_store_corrupt'; message: string } {
  try {
    const records = read(options).records
    const record = records.find(item => item.executionId === jobId && item.job)
    if (!record?.job) return { ok: false, code: 'job_not_found', message: `Capability job ${jobId} was not found.` }
    if (!jobLookupMatches(record.job, { jobId, ...lookup })) return { ok: false, code: 'job_identity_mismatch', message: 'Capability job identity does not match the requesting source, session, run, and request.' }
    if (TERMINAL_JOB_STATES.includes(record.job.lifecycle)) return { ok: true, value: jobProjection(record, (options.now ?? (() => new Date()))())! }
    const at = (options.now ?? (() => new Date()))().toISOString()
    if (record.job.lifecycle === 'queued') {
      const artifact = record.job.artifact && record.job.artifactRoot ? finalizeCapabilityArtifact(record.job.artifactRoot, record.job.artifact, 'cancelled') : record.job.artifact
      record.job = { ...record.job, lifecycle: 'cancelled', currentStep: 'cancelled', cancelRequestedAt: at, cancelReason: reason.slice(0, JOB_MAX_STRING), terminalAt: at, updatedAt: at, ...(artifact ? { artifact } : {}), result: terminalJobResult(record.job, { status: 'cancelled', failure: { code: 'cancelled', message: 'Capability job was cancelled before it started.', retryable: false } }, artifact) }
      record.lifecycleState = 'cancelled'; record.updatedAt = at; record.error = { code: 'cancelled', message: 'Capability job was cancelled before it started.' }; save(record, options)
    } else {
      record.job = { ...record.job, lifecycle: 'cancelling', currentStep: 'cancelling', cancelRequestedAt: at, cancelReason: reason.slice(0, JOB_MAX_STRING), updatedAt: at }
      record.updatedAt = at; save(record, options)
      const active = activeCapabilityJobs.get(jobId)
      if (active) active.controller.abort()
      else {
        const latest = read(options).records.find(item => item.executionId === jobId)
        if (latest) saveJobTerminal(latest, { status: 'cancelled', failure: { code: 'worker_not_active', message: 'Cancellation completed because no active worker owned this job.', retryable: true } }, at, options)
      }
    }
    const updated = read(options).records.find(item => item.executionId === jobId)
    const projection = updated && jobProjection(updated, (options.now ?? (() => new Date()))())
    return projection ? { ok: true, value: projection } : { ok: false, code: 'job_store_corrupt', message: 'Capability job cancellation projection is unavailable.' }
  } catch { return { ok: false, code: 'job_store_corrupt', message: 'Capability job cancellation failed safely.' } }
}

export function recoverCapabilityJobs(options: ExecutionCoordinatorOptions): string[] {
  try {
    const store = read(options); const recovered: string[] = []; const at = (options.now ?? (() => new Date()))().toISOString()
    for (const record of store.records) {
      if (!record.job || !['running', 'cancelling'].includes(record.job.lifecycle)) continue
      saveJobTerminal(record, jobFailure('worker_lost', 'Capability job was active when the runtime restarted.', true), at, options)
      recovered.push(record.job.jobId)
    }
    return recovered
  } catch { return [] }
}

export function maintainCapabilityJobArtifacts(options: ExecutionCoordinatorOptions): string[] {
  try {
    const store = read(options)
    const now = (options.now ?? (() => new Date()))()
    const expired: string[] = []
    let changed = false
    for (const record of store.records) {
      const job = record.job
      if (!job?.artifact || !job.artifactRoot) continue
      if (job.artifact.state === 'available' && Date.parse(job.artifact.retainedUntil) <= now.getTime()) {
        job.artifact = expireCapabilityArtifact(job.artifactRoot, job.artifact)
        job.updatedAt = now.toISOString(); record.updatedAt = job.updatedAt; expired.push(job.jobId); changed = true
      } else if (job.artifact.state === 'pending' && TERMINAL_JOB_STATES.includes(job.lifecycle)) {
        job.artifact = finalizeCapabilityArtifact(job.artifactRoot, job.artifact, job.lifecycle === 'cancelled' ? 'cancelled' : 'failed')
        job.updatedAt = now.toISOString(); record.updatedAt = job.updatedAt; changed = true
      }
    }
    if (changed) { store.updatedAt = now.toISOString(); write(store, options) }
    return expired
  } catch { return [] }
}

export type CapabilityArtifactRetrieval = Readonly<{
  artifactId: string
  artifactRef: string
  state: CapabilityArtifactMetadata['state']
  relativePath: string
  content: string
  byteLength: number
  truncated: boolean
  redactionState: 'redacted'
  retainedUntil: string
}>

export function retrieveCapabilityArtifact(jobId: string, lookup: Omit<CapabilityJobLookup, 'jobId'>, relativePath: string, maxBytes: number | undefined, options: ExecutionCoordinatorOptions): { ok: true; value: CapabilityArtifactRetrieval } | { ok: false; code: 'job_not_found' | 'job_identity_mismatch' | 'artifact_unavailable' | 'job_store_corrupt'; message: string } {
  try {
    const record = read(options).records.find(item => item.executionId === jobId && item.job)
    if (!record?.job) return { ok: false, code: 'job_not_found', message: `Capability job ${jobId} was not found.` }
    if (!jobLookupMatches(record.job, { jobId, ...lookup })) return { ok: false, code: 'job_identity_mismatch', message: 'Capability job identity does not match the requesting source, session, run, and request.' }
    const artifact = record.job.artifact
    if (!artifact || artifact.state !== 'available' || !record.job.artifactRoot) return { ok: false, code: 'artifact_unavailable', message: 'The capability artifact is not currently available for retrieval.' }
    const readResult = readBrokerOwnedArtifact(record.job.artifactRoot, relativePath, maxBytes)
    if (!readResult) return { ok: false, code: 'artifact_unavailable', message: 'The requested artifact path is unavailable or outside the broker-owned output root.' }
    return { ok: true, value: { artifactId: artifact.artifactId, artifactRef: artifact.artifactRef, state: artifact.state, relativePath: readResult.relativePath, content: redactCapabilityText(readResult.content), byteLength: readResult.byteLength, truncated: readResult.truncated, redactionState: 'redacted', retainedUntil: artifact.retainedUntil } }
  } catch { return { ok: false, code: 'job_store_corrupt', message: 'Capability artifact retrieval failed safely.' }
  }
}
