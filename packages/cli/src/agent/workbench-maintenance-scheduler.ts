import crypto from 'node:crypto'

export type MaintenanceJobReason = 'manual' | 'auto' | 'add'
export type MaintenanceJobSnapshot = {
  jobId: string; sourceId: string; reason: MaintenanceJobReason
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  enqueuedAt: string; startedAt?: string; completedAt?: string
  queueWaitMs?: number; activeElapsedMs?: number; executionMs?: number; error?: string
}
export type MaintenanceSchedulerSnapshot = {
  generatedAt: string; active?: MaintenanceJobSnapshot; queued: MaintenanceJobSnapshot[]
  completed: MaintenanceJobSnapshot[]; failed: MaintenanceJobSnapshot[]; cancelled: MaintenanceJobSnapshot[]
  activeCount: number; queuedCount: number; maxConcurrent: number; maxQueue: number
  backpressure: boolean; foregroundYieldCount: number
}
export type MaintenanceStatusProjection = {
  generatedAt: string
  active?: Pick<MaintenanceJobSnapshot, 'jobId' | 'sourceId' | 'reason' | 'status' | 'enqueuedAt' | 'startedAt' | 'queueWaitMs' | 'activeElapsedMs'>
  queued: Array<Pick<MaintenanceJobSnapshot, 'jobId' | 'sourceId' | 'reason' | 'status' | 'enqueuedAt' | 'queueWaitMs'>>
  activeCount: number
  queuedCount: number
  backpressure: boolean
  foregroundYieldCount: number
  foregroundWaiting: boolean
}
type MaintenanceJob = MaintenanceJobSnapshot & { run: (yieldToForeground: () => Promise<void>) => Promise<void> }

export class WorkbenchMaintenanceScheduler {
  private readonly queued: MaintenanceJob[] = []
  private readonly terminal: MaintenanceJobSnapshot[] = []
  private active: MaintenanceJob | undefined
  private foregroundYieldCount = 0

  constructor(private readonly options: { foregroundDemand: () => boolean; maxQueue?: number; now?: () => Date }) {}

  enqueue(input: { sourceId: string; reason: MaintenanceJobReason; run: (yieldToForeground: () => Promise<void>) => Promise<void> }):
    { ok: true; created: boolean; job: MaintenanceJobSnapshot } | { ok: false; code: 'queue_capacity'; message: string } {
    const existing = this.active?.sourceId === input.sourceId ? this.active : this.queued.find(job => job.sourceId === input.sourceId)
    if (existing) return { ok: true, created: false, job: this.toSnapshot(existing) }
    const maxQueue = this.maxQueue()
    if (this.queued.length >= maxQueue) return { ok: false, code: 'queue_capacity', message: 'Background maintenance queue is at capacity.' }
    const job: MaintenanceJob = { jobId: `maintenance-${crypto.randomUUID()}`, sourceId: input.sourceId, reason: input.reason, status: 'queued', enqueuedAt: this.now().toISOString(), run: input.run }
    this.queued.push(job)
    this.schedule()
    return { ok: true, created: true, job: this.toSnapshot(job) }
  }

  cancelSource(sourceId: string): boolean {
    const index = this.queued.findIndex(job => job.sourceId === sourceId)
    if (index < 0) return false
    const [job] = this.queued.splice(index, 1)
    job.status = 'cancelled'; job.completedAt = this.now().toISOString()
    this.terminal.push(this.toSnapshot(job))
    return true
  }

  snapshot(): MaintenanceSchedulerSnapshot {
    const terminal = this.terminal.slice(-128)
    return { generatedAt: this.now().toISOString(), ...(this.active ? { active: this.toSnapshot(this.active) } : {}), queued: this.queued.map(job => this.toSnapshot(job)), completed: terminal.filter(job => job.status === 'completed'), failed: terminal.filter(job => job.status === 'failed'), cancelled: terminal.filter(job => job.status === 'cancelled'), activeCount: this.active ? 1 : 0, queuedCount: this.queued.length, maxConcurrent: 1, maxQueue: this.maxQueue(), backpressure: this.queued.length >= this.maxQueue(), foregroundYieldCount: this.foregroundYieldCount }
  }

  compactSnapshot(): MaintenanceStatusProjection {
    const full = this.snapshot()
    const nowMs = Date.parse(full.generatedAt)
    const compact = (job: MaintenanceJobSnapshot) => ({
      jobId: job.jobId,
      sourceId: job.sourceId,
      reason: job.reason,
      status: job.status,
      enqueuedAt: job.enqueuedAt,
      ...(job.startedAt ? { startedAt: job.startedAt } : {}),
      ...(job.startedAt ? { queueWaitMs: Math.max(0, Date.parse(job.startedAt) - Date.parse(job.enqueuedAt)) } : { queueWaitMs: Math.max(0, nowMs - Date.parse(job.enqueuedAt)) }),
      ...(job.startedAt ? { activeElapsedMs: Math.max(0, nowMs - Date.parse(job.startedAt)) } : {})
    })
    return { generatedAt: full.generatedAt, ...(full.active ? { active: compact(full.active) } : {}), queued: full.queued.slice(0, 12).map(job => compact(job)), activeCount: full.activeCount, queuedCount: full.queuedCount, backpressure: full.backpressure, foregroundYieldCount: full.foregroundYieldCount, foregroundWaiting: this.options.foregroundDemand() }
  }

  private schedule(): void { if (!this.active && this.queued.length > 0) setImmediate(() => { void this.drain() }) }
  private async drain(): Promise<void> {
    if (this.active) return
    const job = this.queued.shift(); if (!job) return
    this.active = job; job.status = 'running'; job.startedAt = this.now().toISOString()
    try { await job.run(async () => { if (!this.options.foregroundDemand()) return; this.foregroundYieldCount += 1; await new Promise<void>(resolve => setImmediate(resolve)) }); job.status = 'completed' }
    catch (error) { job.status = 'failed'; job.error = error instanceof Error ? error.message : String(error) }
    finally { job.completedAt = this.now().toISOString(); job.queueWaitMs = Math.max(0, Date.parse(job.startedAt!) - Date.parse(job.enqueuedAt)); job.executionMs = Math.max(0, Date.parse(job.completedAt) - Date.parse(job.startedAt!)); this.terminal.push(this.toSnapshot(job)); this.active = undefined; this.schedule() }
  }
  private maxQueue(): number { return Math.max(1, Math.min(this.options.maxQueue || 64, 256)) }
  private now(): Date { return this.options.now?.() || new Date() }
  private toSnapshot(job: MaintenanceJob): MaintenanceJobSnapshot { const { run: _run, ...snapshot } = job; return { ...snapshot } }
}
