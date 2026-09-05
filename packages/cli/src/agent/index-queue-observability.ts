import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { getConfigDir } from '../utils/paths'
import type { IndexJob, RepositoryHealth } from './context-intelligence-models'
import { listIndexJobs, type IndexLifecycleStoreOptions } from './index-lifecycle-store'
import { observeRepositoryHealth, type RepositoryHealthObserverOptions } from './repository-health-observer'
import type { KnowledgeSource } from '@workbench/shared'

export type QueueHistoryEventType = 'enqueued' | 'claimed' | 'started' | 'completed' | 'failed' | 'retry_scheduled' | 'cancelled' | 'recovered' | 'terminal_failure' | 'rejected' | 'saturated'
export type QueueHistoryEvent = { eventId: string; eventType: QueueHistoryEventType; jobId: string; sourceId: string; occurredAt: string; owner?: string; leaseId?: string; attempt?: number; reason?: string; failureCode?: string; details?: string }
export type QueueHistoryStoreOptions = IndexLifecycleStoreOptions & { maxEvents?: number }
const HISTORY_FILE = 'index-queue-history.json'
function historyPath(options?: QueueHistoryStoreOptions): string { return path.join(options?.rootDir ? path.resolve(options.rootDir) : getConfigDir(), HISTORY_FILE) }
function readHistory(options?: QueueHistoryStoreOptions): QueueHistoryEvent[] { try { const value = JSON.parse(fs.readFileSync(historyPath(options), 'utf8')) as unknown; return Array.isArray(value) ? value as QueueHistoryEvent[] : [] } catch { return [] } }
function writeHistory(events: QueueHistoryEvent[], options?: QueueHistoryStoreOptions): void {
  const target = historyPath(options)
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  const bounded = events.slice(-Math.max(20, Math.min(options?.maxEvents || 2_000, 10_000)))
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(bounded), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  fs.renameSync(temporary, target)
}
export function appendQueueHistory(event: Omit<QueueHistoryEvent, 'eventId'>, options?: QueueHistoryStoreOptions): QueueHistoryEvent {
  const next = { ...event, eventId: `queue-event-${crypto.randomUUID()}` }
  writeHistory([...readHistory(options), next], options)
  return next
}
export function listQueueHistory(jobId?: string, options?: QueueHistoryStoreOptions): QueueHistoryEvent[] { return readHistory(options).filter(event => !jobId || event.jobId === jobId) }

export type QueueDiagnosticJob = {
  job: IndexJob
  queuePosition?: number
  source?: KnowledgeSource
  health?: RepositoryHealth
  ownership: { owner?: string; leaseId?: string; leaseExpiresAt?: string; leaseState: 'none' | 'active' | 'expired' }
  retryHistory: QueueHistoryEvent[]
  failureCodes: string[]
  recoveryEvents: QueueHistoryEvent[]
  freshnessImpact: 'none' | 'warning' | 'blocked' | 'unavailable'
}
export type QueuePressureSummary = {
  activeCount: number
  queuedCount: number
  maxConcurrency: number
  maxPerSource: number
  utilization: number
  backpressure: boolean
  rejectionCount: number
  recentSaturation: number
  lastSaturatedAt?: string
}
export type QueueDiagnostics = { generatedAt: string; current: QueueDiagnosticJob[]; blocked: QueueDiagnosticJob[]; stale: QueueDiagnosticJob[]; failed: QueueDiagnosticJob[]; recovered: QueueDiagnosticJob[]; lastSuccessfulIndexing: Record<string, string | undefined>; pressure: QueuePressureSummary; sources: QueueDiagnosticJob[] }
export type QueueDiagnosticsOptions = { sources?: KnowledgeSource[]; sourceLoader?: () => KnowledgeSource[]; observer?: Omit<RepositoryHealthObserverOptions, 'sources' | 'sourceLoader'>; indexStore?: IndexLifecycleStoreOptions; historyStore?: QueueHistoryStoreOptions; now?: () => Date; maxConcurrency?: number; maxPerSource?: number }

export class IndexQueueDiagnostics {
  constructor(private readonly options: QueueDiagnosticsOptions = {}) {}
  collect(): QueueDiagnostics {
    const generatedAt = (this.options.now || (() => new Date()))().toISOString()
    let sources: KnowledgeSource[] = []
    try { sources = this.options.sources ? [...this.options.sources] : this.options.sourceLoader?.() || [] } catch { sources = [] }
    const jobs = listIndexJobs(undefined, this.options.indexStore)
    const queued = jobs.filter(job => job.status === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const active = jobs.filter(job => ['claimed', 'observing', 'running'].includes(job.status))
    const history = listQueueHistory(undefined, this.options.historyStore)
    const maxConcurrency = Math.max(1, Math.min(this.options.maxConcurrency || 2, 16))
    const maxPerSource = Math.max(1, Math.min(this.options.maxPerSource || 1, maxConcurrency))
    const saturationEvents = history.filter(event => event.eventType === 'saturated')
    const recentSaturationCutoff = Date.parse(generatedAt) - 15 * 60_000
    const recentSaturationEvents = saturationEvents.filter(event => Date.parse(event.occurredAt) >= recentSaturationCutoff)
    const activeBySource = new Map<string, number>()
    for (const job of active) activeBySource.set(job.sourceId, (activeBySource.get(job.sourceId) || 0) + 1)
    const sourceLimited = queued.some(job => (activeBySource.get(job.sourceId) || 0) >= maxPerSource)
    const backpressure = queued.length > 0 && (active.length >= maxConcurrency || sourceLimited)
    const pressure: QueuePressureSummary = {
      activeCount: active.length,
      queuedCount: queued.length,
      maxConcurrency,
      maxPerSource,
      utilization: maxConcurrency > 0 ? Number(Math.min(1, active.length / maxConcurrency).toFixed(3)) : 0,
      backpressure,
      rejectionCount: history.filter(event => event.eventType === 'rejected').length,
      recentSaturation: recentSaturationEvents.length,
      ...(saturationEvents.length > 0 ? { lastSaturatedAt: saturationEvents[saturationEvents.length - 1].occurredAt } : {})
    }
    const diagnostics = jobs.map(job => {
      const history = listQueueHistory(job.jobId, this.options.historyStore)
      const source = sources.find(item => item.id === job.sourceId)
      const observed = source ? observeRepositoryHealth(job.sourceId, { ...this.options.observer, now: this.options.observer?.now || this.options.now, sources, sourceLoader: () => sources }) : undefined
      const health = observed?.health
      const leaseState = !job.leaseExpiresAt ? 'none' : Date.parse(job.leaseExpiresAt) <= Date.parse(generatedAt) ? 'expired' : 'active'
      const freshnessImpact = !health || health.runtimeAvailability === 'unavailable' || health.freshnessState === 'unavailable' ? 'unavailable' : health.freshnessState === 'fresh' ? 'none' : ['failed'].includes(health.freshnessState) ? 'blocked' : 'warning'
      return { job, queuePosition: job.status === 'queued' ? queued.findIndex(item => item.jobId === job.jobId) + 1 : undefined, source, health, ownership: { owner: job.leaseOwner, leaseId: job.leaseId, leaseExpiresAt: job.leaseExpiresAt, leaseState }, retryHistory: history.filter(event => event.eventType === 'retry_scheduled'), failureCodes: Array.from(new Set(history.map(event => event.failureCode).filter((code): code is string => Boolean(code)))), recoveryEvents: history.filter(event => event.eventType === 'recovered'), freshnessImpact } satisfies QueueDiagnosticJob
    })
    const lastSuccessfulIndexing: Record<string, string | undefined> = {}
    for (const diagnostic of diagnostics) if (diagnostic.job.status === 'completed') lastSuccessfulIndexing[diagnostic.job.sourceId] = diagnostic.job.completedAt
    return { generatedAt, current: diagnostics.filter(item => ['queued', 'claimed', 'observing', 'planned', 'running'].includes(item.job.status)), blocked: diagnostics.filter(item => item.freshnessImpact === 'blocked' || item.job.status === 'failed'), stale: diagnostics.filter(item => item.ownership.leaseState === 'expired' || item.job.status === 'queued' && Boolean(item.job.nextAttemptAt)), failed: diagnostics.filter(item => item.job.status === 'failed'), recovered: diagnostics.filter(item => item.recoveryEvents.length > 0), lastSuccessfulIndexing, pressure, sources: diagnostics }
  }
}

export function collectIndexQueueDiagnostics(options?: QueueDiagnosticsOptions): QueueDiagnostics { return new IndexQueueDiagnostics(options).collect() }
