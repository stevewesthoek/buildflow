import crypto from 'node:crypto'
import type { IndexJob, IndexJobPriority } from './context-intelligence-models'
import { createQueuedIndexJob, IndexWorker, type IndexWorkerOptions, type IndexWorkerResult } from './index-worker'
import { getIndexJob, listIndexJobs, updateIndexJob, type IndexLifecycleStoreOptions } from './index-lifecycle-store'
import { appendQueueHistory, type QueueHistoryStoreOptions } from './index-queue-observability'
import { auditRefreshExecutionEvent, type RefreshAuditStoreOptions } from './freshness-automation'

export type QueueCoordinatorOptions = IndexWorkerOptions & {
  ownerId?: string
  maxConcurrency?: number
  maxPerSource?: number
  maxAttempts?: number
  retryDelayMs?: number
  historyStore?: QueueHistoryStoreOptions
  refreshAuditStore?: RefreshAuditStoreOptions
}
export type QueueEnqueueInput = Omit<IndexJob, 'schemaVersion' | 'jobId' | 'createdAt' | 'updatedAt' | 'status' | 'attempt' | 'maxAttempts' | 'leaseId' | 'leaseOwner' | 'leaseExpiresAt' | 'cancelRequested'> & { jobId?: string }
export type QueueResult = { ok: true; job: IndexJob } | { ok: false; code: string; message: string; job?: IndexJob }

const activeStatuses = new Set(['claimed', 'observing', 'running'])
const priorities: Record<IndexJobPriority, number> = { interactive: 0, background: 1, maintenance: 2 }

function now(options: QueueCoordinatorOptions): string { return (options.now || (() => new Date()))().toISOString() }
function failure(code: string, message: string, job?: IndexJob): QueueResult { return { ok: false, code, message, job } }

export class IndexQueueCoordinator {
  private readonly worker: IndexWorker
  private readonly ownerId: string
  private readonly maxConcurrency: number
  private readonly maxPerSource: number
  private readonly maxAttempts: number
  private readonly retryDelayMs: number

  constructor(private readonly options: QueueCoordinatorOptions = {}) {
    this.worker = new IndexWorker(options)
    this.ownerId = options.ownerId || `queue-owner-${crypto.randomUUID()}`
    this.maxConcurrency = Math.max(1, Math.min(options.maxConcurrency || 2, 16))
    this.maxPerSource = Math.max(1, Math.min(options.maxPerSource || 1, this.maxConcurrency))
    this.maxAttempts = Math.max(1, Math.min(options.maxAttempts || 3, 10))
    this.retryDelayMs = Math.max(0, Math.min(options.retryDelayMs || 1_000, 86_400_000))
  }

  enqueue(input: QueueEnqueueInput): QueueResult {
    const existing = listIndexJobs(input.sourceId, this.options.indexStore).find(job => !['completed', 'failed', 'cancelled'].includes(job.status) && job.operation === input.operation && job.reason === input.reason)
    if (existing) return { ok: true, job: existing }
    const created = createQueuedIndexJob({ ...input, attempt: 0, maxAttempts: this.maxAttempts }, this.options.indexStore)
    if (!created.ok) return failure('enqueue_failed', 'message' in created ? created.message : 'Unable to enqueue index job.')
    appendQueueHistory({ eventType: 'enqueued', jobId: created.job.jobId, sourceId: created.job.sourceId, occurredAt: now(this.options), reason: created.job.reason }, this.options.historyStore)
    return { ok: true, job: created.job }
  }

  cancel(jobId: string, reason = 'explicit cancellation'): QueueResult {
    const job = getIndexJob(jobId, this.options.indexStore)
    if (!job) return failure('job_missing', 'Index job does not exist.')
    if (['completed', 'failed', 'cancelled'].includes(job.status)) return { ok: true, job }
    const updated = updateIndexJob(jobId, { status: job.status === 'queued' ? 'cancelled' : job.status, cancelRequested: true, error: `cancelled: ${reason}`, completedAt: job.status === 'queued' ? now(this.options) : undefined }, this.options.indexStore)
    if (updated.ok) appendQueueHistory({ eventType: 'cancelled', jobId: job.jobId, sourceId: job.sourceId, occurredAt: now(this.options), reason }, this.options.historyStore)
    return updated.ok ? { ok: true, job: updated.job } : failure('cancel_failed', 'Unable to cancel index job.', job)
  }

  shutdown(reason = 'shutdown cancellation'): IndexJob[] {
    return this.cancelMatching(job => !['completed', 'failed', 'cancelled'].includes(job.status), reason)
  }

  cancelStale(maxAgeMs: number, reason = 'stale cancellation'): IndexJob[] {
    const cutoff = Date.parse(now(this.options)) - Math.max(1_000, Math.min(maxAgeMs, 86_400_000 * 30))
    return this.cancelMatching(job => !['completed', 'failed', 'cancelled'].includes(job.status) && Date.parse(job.updatedAt) <= cutoff, reason)
  }

  recover(): IndexJob[] {
    const recovered: IndexJob[] = []
    for (const job of listIndexJobs(undefined, this.options.indexStore)) {
      if (!activeStatuses.has(job.status) || !job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) > Date.parse(now(this.options))) continue
      if ((job.attempt || 0) + 1 >= (job.maxAttempts || this.maxAttempts)) {
        const failed = updateIndexJob(job.jobId, { status: 'failed', error: 'terminal_failure: lease expired during execution', completedAt: now(this.options) }, this.options.indexStore)
        if (failed.ok) { recovered.push(failed.job); appendQueueHistory({ eventType: 'terminal_failure', jobId: job.jobId, sourceId: job.sourceId, occurredAt: now(this.options), attempt: failed.job.attempt, failureCode: 'lease_expired', details: 'Lease expired at retry limit.' }, this.options.historyStore) }
      } else {
        const requeued = updateIndexJob(job.jobId, { status: 'queued', attempt: (job.attempt || 0) + 1, leaseId: undefined, leaseOwner: undefined, leaseExpiresAt: undefined, error: 'retry: lease expired during execution', nextAttemptAt: new Date(Date.parse(now(this.options)) + this.retryDelayMs).toISOString() }, this.options.indexStore)
        if (requeued.ok) { recovered.push(requeued.job); appendQueueHistory({ eventType: 'recovered', jobId: job.jobId, sourceId: job.sourceId, occurredAt: now(this.options), attempt: requeued.job.attempt, failureCode: 'lease_expired' }, this.options.historyStore) }
      }
    }
    return recovered
  }

  async drain(contextSessionId?: string): Promise<IndexWorkerResult[]> {
    this.recover()
    const jobs = listIndexJobs(undefined, this.options.indexStore)
      .filter(job => job.status === 'queued' && !job.cancelRequested && (!job.nextAttemptAt || Date.parse(job.nextAttemptAt) <= Date.parse(now(this.options))))
      .sort((a, b) => priorities[a.priority] - priorities[b.priority] || a.createdAt.localeCompare(b.createdAt))
    const active = listIndexJobs(undefined, this.options.indexStore).filter(job => activeStatuses.has(job.status))
    const sourceCounts = new Map<string, number>()
    active.forEach(job => sourceCounts.set(job.sourceId, (sourceCounts.get(job.sourceId) || 0) + 1))
    const available = Math.max(0, this.maxConcurrency - active.length)
    const selected = jobs.filter(job => (sourceCounts.get(job.sourceId) || 0) < this.maxPerSource).slice(0, available)
    return Promise.all(selected.map(async job => {
      const claimed = this.worker.claim(job.jobId, this.ownerId)
      if (!claimed.ok) return claimed
      appendQueueHistory({ eventType: 'claimed', jobId: job.jobId, sourceId: job.sourceId, occurredAt: now(this.options), owner: this.ownerId, leaseId: claimed.job.leaseId, attempt: claimed.job.attempt }, this.options.historyStore)
      appendQueueHistory({ eventType: 'started', jobId: job.jobId, sourceId: job.sourceId, occurredAt: now(this.options), owner: this.ownerId, leaseId: claimed.job.leaseId, attempt: claimed.job.attempt }, this.options.historyStore)
      return this.worker.executeClaimed(job.jobId, contextSessionId, this.ownerId, claimed.job.leaseId)
    })).then(results => results.map(result => {
      if (result.ok) { appendQueueHistory({ eventType: 'completed', jobId: result.job.jobId, sourceId: result.job.sourceId, occurredAt: now(this.options), owner: this.ownerId, leaseId: result.job.leaseId, attempt: result.job.attempt }, this.options.historyStore); if (result.job.proposalId) auditRefreshExecutionEvent('refresh.job.completed', result.job, 'completed', this.options.refreshAuditStore) }
      else if (result.job && 'code' in result) { appendQueueHistory({ eventType: 'failed', jobId: result.job.jobId, sourceId: result.job.sourceId, occurredAt: now(this.options), owner: result.job.leaseOwner, leaseId: result.job.leaseId, attempt: result.job.attempt, failureCode: result.code, details: result.message }, this.options.historyStore); if (result.job.proposalId) auditRefreshExecutionEvent('refresh.job.failed', result.job, result.code, this.options.refreshAuditStore) }
      return this.handleRetry(result)
    }))
  }

  private handleRetry(result: IndexWorkerResult): IndexWorkerResult {
    if (result.ok || !result.job || result.job.status === 'cancelled' || !('code' in result)) return result
    const job = result.job
    const attempt = (job.attempt || 0) + 1
    if (attempt >= (job.maxAttempts || this.maxAttempts)) { appendQueueHistory({ eventType: 'terminal_failure', jobId: job.jobId, sourceId: job.sourceId, occurredAt: now(this.options), attempt, failureCode: result.code, details: result.message }, this.options.historyStore); return result }
    const retryable = !['source_missing', 'source_disabled', 'context_session_required', 'context_session_not_confirmed', 'source_not_active', 'freshness_changed'].includes(result.code)
    if (!retryable) return result
    const updated = updateIndexJob(job.jobId, { status: 'queued', attempt, error: `retry: ${result.code}: ${result.message}`, nextAttemptAt: new Date(Date.parse(now(this.options)) + this.retryDelayMs).toISOString(), leaseId: undefined, leaseOwner: undefined, leaseExpiresAt: undefined }, this.options.indexStore)
    if (updated.ok) appendQueueHistory({ eventType: 'retry_scheduled', jobId: job.jobId, sourceId: job.sourceId, occurredAt: now(this.options), attempt, failureCode: result.code, details: result.message }, this.options.historyStore)
    return updated.ok ? { ok: false, code: 'retry_scheduled', message: result.message, job: updated.job } : result
  }

  private cancelMatching(predicate: (job: IndexJob) => boolean, reason: string): IndexJob[] {
    const cancelled: IndexJob[] = []
    for (const job of listIndexJobs(undefined, this.options.indexStore)) {
      if (!predicate(job)) continue
      const updated = updateIndexJob(job.jobId, { status: job.status === 'queued' ? 'cancelled' : job.status, cancelRequested: true, error: `cancelled: ${reason}`, completedAt: job.status === 'queued' ? now(this.options) : undefined }, this.options.indexStore)
      if (updated.ok) { cancelled.push(updated.job); if (updated.job.proposalId) auditRefreshExecutionEvent('refresh.cancelled', updated.job, reason, this.options.refreshAuditStore) }
    }
    return cancelled
  }
}
