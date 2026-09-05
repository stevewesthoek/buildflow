import { KnowledgeRefreshWorker, type KnowledgeRefreshWorkerOptions, type KnowledgeRefreshWorkerResult } from './knowledge-refresh-worker.js'
import type { KnowledgeRefreshLifecycle } from './knowledge-refresh-lifecycle.js'
import { KnowledgeRefreshOwnershipStore, type KnowledgeRefreshOwnershipRecord } from './knowledge-refresh-ownership.js'

export type KnowledgeRefreshSupervisorState = 'disabled' | 'starting' | 'ready' | 'draining' | 'stopped' | 'failed'
export type KnowledgeRefreshSupervisorOptions = KnowledgeRefreshWorkerOptions & { lifecycle: KnowledgeRefreshLifecycle; supervisorId: string; rootIdentity?: string; enabled?: boolean; ownershipLeaseMs?: number }
export type KnowledgeRefreshSupervisorHealth = { state: KnowledgeRefreshSupervisorState; supervisorId: string; activeWorkers: number; recoveredExecutions: number; queueConnected: boolean; leaseExpiresAt?: string; ownershipState?: KnowledgeRefreshOwnershipRecord['state']; lastError?: string }

const owners = new Map<string, string>()

export class KnowledgeRefreshSupervisor {
  private state: KnowledgeRefreshSupervisorState = 'disabled'
  private active = new Set<string>()
  private recoveredExecutions = 0
  private lastError?: string
  private ownership?: KnowledgeRefreshOwnershipRecord
  private readonly ownershipStore: KnowledgeRefreshOwnershipStore
  private activeRuns = new Set<Promise<KnowledgeRefreshWorkerResult>>()
  private readonly ownerKey: string
  constructor(private readonly options: KnowledgeRefreshSupervisorOptions) { this.ownerKey = options.rootIdentity ?? 'default'; this.ownershipStore = new KnowledgeRefreshOwnershipStore({ rootDir: options.lifecycle.rootDir() }) }
  start(): KnowledgeRefreshSupervisorHealth {
    if (this.options.enabled === false) { this.state = 'disabled'; return this.health() }
    const owner = owners.get(this.ownerKey)
    if (owner && owner !== this.options.supervisorId) { this.state = 'failed'; this.lastError = 'duplicate_supervisor'; return this.health() }
    try { this.state = 'starting'; const acquired = this.ownershipStore.acquire(this.ownerKey, this.options.supervisorId, this.options.now(), this.options.ownershipLeaseMs ?? 30_000); if (!acquired.ok) throw new Error(acquired.reason); this.ownership = acquired.value; owners.set(this.ownerKey, this.options.supervisorId); this.recoveredExecutions = this.options.lifecycle.recover().length; this.state = 'ready'; return this.health() } catch (error) { this.state = 'failed'; this.lastError = error instanceof Error ? error.message : 'supervisor_start_failed'; owners.delete(this.ownerKey); return this.health() }
  }
  async run(executionId: string): Promise<KnowledgeRefreshWorkerResult> {
    if (this.state !== 'ready') return { ok: false, reason: `supervisor_not_ready:${this.state}` }
    const ownership = this.ownershipStore.get()
    if (!ownership.ok || !ownership.value || ownership.value.ownerId !== this.options.supervisorId || Date.parse(ownership.value.leaseExpiresAt) <= this.options.now().getTime()) { this.state = 'failed'; this.lastError = 'ownership_expired'; return { ok: false, reason: 'ownership_expired' } }
    if (this.active.has(executionId)) return { ok: false, reason: 'duplicate_worker', execution: this.options.lifecycle.listExecutions().find(item => item.executionId === executionId) }
    this.active.add(executionId)
    const run: Promise<KnowledgeRefreshWorkerResult> = (async () => { try { return await new KnowledgeRefreshWorker(this.options.lifecycle, this.options).run(executionId) } catch (error) { this.state = 'failed'; this.lastError = error instanceof Error ? error.message : 'worker_crash'; return { ok: false as const, reason: 'worker_crash' } } finally { this.active.delete(executionId) } })()
    this.activeRuns.add(run); void run.finally(() => this.activeRuns.delete(run)); return run
  }
  renew(): KnowledgeRefreshSupervisorHealth { if (this.state !== 'ready' || !this.ownership) return this.health(); const result = this.ownershipStore.renew(this.options.supervisorId, this.options.now(), this.options.ownershipLeaseMs ?? 30_000); if (!result.ok) { this.state = 'failed'; this.lastError = result.reason; return this.health() } this.ownership = result.value; return this.health() }
  stop(): KnowledgeRefreshSupervisorHealth { if (this.state === 'ready' || this.state === 'starting') this.state = 'draining'; this.active.clear(); this.releaseOwnership('forced_shutdown'); if (this.state === 'draining') this.state = 'stopped'; return this.health() }
  async shutdown(timeoutMs = 5_000): Promise<KnowledgeRefreshSupervisorHealth> { if (this.state === 'ready' || this.state === 'starting') this.state = 'draining'; const pending = [...this.activeRuns]; if (pending.length) await Promise.race([Promise.allSettled(pending), new Promise(resolve => setTimeout(resolve, Math.max(0, timeoutMs)))]); if (this.active.size) { this.lastError = 'shutdown_timeout'; this.options.lifecycle.recover(this.options.now()) } this.releaseOwnership(this.active.size ? 'shutdown_timeout' : 'graceful_shutdown'); this.state = 'stopped'; return this.health() }
  private releaseOwnership(reason: string): void { if (this.ownership) { const result = this.ownershipStore.release(this.options.supervisorId, this.options.now(), reason); if (result.ok) this.ownership = result.value } owners.delete(this.ownerKey) }
  health(): KnowledgeRefreshSupervisorHealth { return { state: this.state, supervisorId: this.options.supervisorId, activeWorkers: this.active.size, recoveredExecutions: this.recoveredExecutions, queueConnected: this.state === 'ready', ...(this.ownership ? { leaseExpiresAt: this.ownership.leaseExpiresAt, ownershipState: this.ownership.state } : {}), ...(this.lastError ? { lastError: this.lastError } : {}) } }
}
