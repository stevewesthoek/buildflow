import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { KnowledgeSource } from '@workbench/shared'
import type { ContextSession, IndexJob, IndexJobResult, RepositoryHealth } from './context-intelligence-models'
import { getContextSession, type ContextIntelligenceStoreOptions } from './context-intelligence-store'
import { observeRepositoryHealth, type RepositoryHealthObserverOptions } from './repository-health-observer'
import { planIndexLifecycle } from './index-lifecycle-planner'
import { createIndexJob, getIndexJob, hasActiveIndexJob, updateIndexJob, type IndexLifecycleStoreOptions } from './index-lifecycle-store'

export type IndexWorkerFailureCode =
  | 'job_missing' | 'job_not_queued' | 'source_missing' | 'source_disabled'
  | 'repository_unavailable' | 'context_session_required' | 'context_session_not_confirmed'
  | 'source_not_active' | 'freshness_changed' | 'conflicting_active_job'
  | 'execution_not_configured' | 'execution_failed' | 'atomic_replace_failed'
  | 'retry_scheduled'

export type IndexWorkerExecutionInput = {
  job: IndexJob
  source: KnowledgeSource
  health: RepositoryHealth
  changedPaths: string[]
}

export type IndexWorkerExecution = {
  incremental?: (input: IndexWorkerExecutionInput) => Promise<IndexJobResult>
  full?: (input: IndexWorkerExecutionInput) => Promise<{ temporaryPath: string; targetPath: string; result?: IndexJobResult }>
}

export type IndexWorkerOptions = {
  sources?: KnowledgeSource[]
  sourceLoader?: () => KnowledgeSource[]
  observer?: Omit<RepositoryHealthObserverOptions, 'sources' | 'sourceLoader'>
  indexStore?: IndexLifecycleStoreOptions
  contextStore?: ContextIntelligenceStoreOptions
  execution?: IndexWorkerExecution
  now?: () => Date
  maxChangedPaths?: number
  leaseDurationMs?: number
}

export type IndexWorkerResult = { ok: true; job: IndexJob; result: IndexJobResult } | { ok: false; code: IndexWorkerFailureCode; message: string; job?: IndexJob }

const terminalStatuses = new Set(['completed', 'failed', 'cancelled'])

function timestamp(options: IndexWorkerOptions): string { return (options.now || (() => new Date()))().toISOString() }
function loadSources(options: IndexWorkerOptions): KnowledgeSource[] | undefined {
  try { return options.sources ? [...options.sources] : options.sourceLoader?.() }
  catch { return undefined }
}
function fail(code: IndexWorkerFailureCode, message: string, job?: IndexJob): IndexWorkerResult { return { ok: false, code, message, job } }

function atomicReplace(temporaryPath: string, targetPath: string): void {
  const temporary = path.resolve(temporaryPath)
  const target = path.resolve(targetPath)
  if (!fs.existsSync(temporary) || !fs.statSync(temporary).isFile()) throw new Error('temporary index artifact is missing')
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  const backup = `${target}.${crypto.randomUUID()}.bak`
  const hadTarget = fs.existsSync(target)
  try {
    if (hadTarget) fs.renameSync(target, backup)
    fs.renameSync(temporary, target)
    if (hadTarget) fs.rmSync(backup, { force: true })
  } catch (error) {
    try {
      if (fs.existsSync(target)) fs.rmSync(target, { force: true })
      if (hadTarget && fs.existsSync(backup)) fs.renameSync(backup, target)
    } catch { /* preserve original failure; rollback is best effort */ }
    throw error
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true })
    if (fs.existsSync(backup)) fs.rmSync(backup, { force: true })
  }
}

export class IndexWorker {
  constructor(private readonly options: IndexWorkerOptions = {}) {}

  claim(jobId: string, leaseOwner = 'index-worker'): IndexWorkerResult {
    const job = getIndexJob(jobId, this.options.indexStore)
    if (!job) return fail('job_missing', 'Index job does not exist.')
    if (job.status !== 'queued') return fail('job_not_queued', `Index job cannot be claimed from ${job.status}.`, job)
    if (hasActiveIndexJob(job.sourceId, this.options.indexStore)) return fail('conflicting_active_job', 'Another index job is already active for this source.', job)
    const claimedAt = timestamp(this.options)
    const leaseDurationMs = Math.max(1_000, Math.min(this.options.leaseDurationMs || 60_000, 3_600_000))
    const updated = updateIndexJob(jobId, { status: 'claimed', startedAt: claimedAt, leaseId: `lease-${crypto.randomUUID()}`, leaseOwner, leaseExpiresAt: new Date(Date.parse(claimedAt) + leaseDurationMs).toISOString() }, this.options.indexStore)
    return updated.ok ? { ok: true, job: updated.job, result: {} } : fail('job_missing', 'message' in updated ? updated.message : 'Index job update failed.', job)
  }

  async execute(jobId: string, contextSessionId?: string): Promise<IndexWorkerResult> {
    const claimed = this.claim(jobId)
    if (!claimed.ok) return claimed
    return this.executeClaimed(jobId, contextSessionId, claimed.job.leaseOwner, claimed.job.leaseId)
  }

  async executeClaimed(jobId: string, contextSessionId?: string, leaseOwner?: string, leaseId?: string): Promise<IndexWorkerResult> {
    const job = getIndexJob(jobId, this.options.indexStore)
    if (!job) return fail('job_missing', 'Index job does not exist.')
    if (job.status !== 'claimed' || (leaseOwner && job.leaseOwner !== leaseOwner) || (leaseId && job.leaseId !== leaseId)) return fail('job_not_queued', 'Index job is not held by the requested lease.', job)
    if (job.leaseExpiresAt && Date.parse(job.leaseExpiresAt) <= Date.parse(timestamp(this.options))) return this.failJob(job, 'conflicting_active_job', 'Index job lease has expired.')
    if (job.cancelRequested) return this.cancelJob(job)
    const sources = loadSources(this.options)
    const source = sources?.find(item => item.id === job.sourceId)
    if (!source) return this.failJob(job, 'source_missing', 'Registered source was not found.')
    if (source.enabled === false) return this.failJob(job, 'source_disabled', 'Registered source is disabled.')
    if (!contextSessionId) return this.failJob(job, 'context_session_required', 'Authorized Context Intelligence session is required.')
    const session = getContextSession(contextSessionId, this.options.contextStore)
    if (!session || ('ok' in session)) return this.failJob(job, 'context_session_required', 'Context Intelligence session was not found.')
    if (session.status !== 'confirmed') return this.failJob(job, 'context_session_not_confirmed', 'Context Intelligence session is not confirmed.')
    if (!session.sourceIds.includes(job.sourceId)) return this.failJob(job, 'source_not_active', 'Source is not active in the confirmed context session.')
    const observed = observeRepositoryHealth(job.sourceId, { ...this.options.observer, sources, sourceLoader: () => sources })
    if (!observed.ok || !observed.health || observed.health.runtimeAvailability !== 'available') return this.failJob(job, 'repository_unavailable', 'Repository is unavailable.')
    const health = observed.health
    if (health.freshnessState === 'unavailable' || health.freshnessState === 'failed') return this.failJob(job, 'repository_unavailable', 'Repository health is not executable.')
    const plan = planIndexLifecycle(health, job.changedPaths || [], job.changedPaths || [])
    if (job.operation !== 'observe' && plan.refresh === 'reuse') return this.failJob(job, 'freshness_changed', 'Freshness no longer requires this index job.')
    if (hasActiveIndexJob(job.sourceId, this.options.indexStore)) {
      const active = getIndexJob(jobId, this.options.indexStore)
      if (!active || active.status !== 'claimed') return this.failJob(job, 'conflicting_active_job', 'Another index job is already active for this source.')
    }
    const running = updateIndexJob(jobId, { status: 'running' }, this.options.indexStore)
    if (!running.ok) return fail('job_missing', 'message' in running ? running.message : 'Index job update failed.', job)
    const input = { job: running.job, source, health, changedPaths: (job.changedPaths || []).slice(0, this.options.maxChangedPaths || 5_000) }
    try {
      if (job.operation === 'full') {
        if (!this.options.execution?.full) return this.failJob(running.job, 'execution_not_configured', 'Full index execution is not configured.')
        const full = await this.options.execution.full(input)
        try { atomicReplace(full.temporaryPath, full.targetPath) }
        catch (error) { return this.failJob(running.job, 'atomic_replace_failed', error instanceof Error ? error.message : 'Atomic replacement failed.') }
        return this.complete(running.job, full.result || {})
      }
      if (!this.options.execution?.incremental) return this.failJob(running.job, 'execution_not_configured', 'Incremental index execution is not configured.')
      return this.complete(running.job, await this.options.execution.incremental(input))
    } catch (error) {
      return this.failJob(running.job, 'execution_failed', error instanceof Error ? error.message : 'Index execution failed.')
    }
  }

  private complete(job: IndexJob, result: IndexJobResult): IndexWorkerResult {
    const updated = updateIndexJob(job.jobId, { status: 'completed', result, completedAt: timestamp(this.options) }, this.options.indexStore)
    return updated.ok ? { ok: true, job: updated.job, result } : fail('job_missing', 'message' in updated ? updated.message : 'Index job update failed.', job)
  }
  private failJob(job: IndexJob, code: IndexWorkerFailureCode, message: string): IndexWorkerResult {
    const updated = updateIndexJob(job.jobId, { status: 'failed', error: `${code}: ${message}`, completedAt: timestamp(this.options) }, this.options.indexStore)
    return fail(code, message, updated.ok ? updated.job : job)
  }
  private cancelJob(job: IndexJob): IndexWorkerResult {
    const updated = updateIndexJob(job.jobId, { status: 'cancelled', completedAt: timestamp(this.options), error: 'cancelled: cancellation requested' }, this.options.indexStore)
    return fail('execution_failed', 'Index job was cancelled before execution.', updated.ok ? updated.job : job)
  }
}

export function createQueuedIndexJob(input: Omit<IndexJob, 'schemaVersion' | 'jobId' | 'createdAt' | 'updatedAt' | 'status'> & { jobId?: string }, options?: IndexLifecycleStoreOptions) {
  return createIndexJob({ ...input, status: 'queued' }, options)
}

export function isTerminalIndexJob(job: IndexJob): boolean { return terminalStatuses.has(job.status) }
