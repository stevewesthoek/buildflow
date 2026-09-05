import type { KnowledgeContentAccess } from './knowledge-content.js'
import type { KnowledgeIndex } from './knowledge-index.js'
import { KnowledgeRefreshLifecycle, type KnowledgeRefreshExecution } from './knowledge-refresh-lifecycle.js'

export type KnowledgeRefreshWorkerOptions = { leaseMs?: number; timeoutMs?: number; maxAttempts?: number; now: () => Date; provider: KnowledgeContentAccess; index: KnowledgeIndex }
export type KnowledgeRefreshWorkerResult = { ok: true; execution: KnowledgeRefreshExecution } | { ok: false; reason: string; execution?: KnowledgeRefreshExecution }

export class KnowledgeRefreshWorker {
  constructor(private readonly lifecycle: KnowledgeRefreshLifecycle, private readonly options: KnowledgeRefreshWorkerOptions) {}
  async run(executionId: string): Promise<KnowledgeRefreshWorkerResult> {
    const existing = this.lifecycle.listExecutions().find(item => item.executionId === executionId)
    if (!existing) return { ok: false, reason: 'execution_missing' }
    if (existing.state === 'running') return { ok: false, reason: 'duplicate_claim', execution: existing }
    if (existing.state !== 'queued') return { ok: false, reason: `execution_not_queued:${existing.state}`, execution: existing }
    const claimed = this.lifecycle.claim(executionId, this.options.leaseMs ?? 300_000)
    if (!claimed.ok) return { ok: false, reason: claimed.message }
    const result = await this.runWithTimeout(executionId)
    const execution = this.lifecycle.listExecutions().find(item => item.executionId === executionId)
    if (result.ok && execution?.state === 'completed') return result
    const reason = result.ok ? 'refresh_failed' : result.reason
    if (execution && execution.attempts < (this.options.maxAttempts ?? 3) && execution.state === 'failed') {
      const retry = this.lifecycle.retry(executionId)
      if (retry.ok) return { ok: false, reason: `retryable:${reason}`, execution: retry.value }
    }
    return { ok: false, reason, execution }
  }
  cancel(executionId: string): KnowledgeRefreshWorkerResult { const result = this.lifecycle.cancel(executionId, 'worker_cancelled'); return result.ok ? { ok: true, execution: result.value } : { ok: false, reason: result.message } }
  recover(): KnowledgeRefreshExecution[] { return this.lifecycle.recover(this.options.now()) }
  private async runWithTimeout(executionId: string): Promise<KnowledgeRefreshWorkerResult> {
    const executions = this.lifecycle.listExecutions(); const execution = executions.find(item => item.executionId === executionId); if (!execution) return { ok: false, reason: 'execution_missing' }
    // The lifecycle owns proposal and drift validation; the worker only supplies the provider/index execution context.
    const actual = this.lifecycle.runApproved(executionId, this.options.provider, this.options.index)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<KnowledgeRefreshWorkerResult>(resolve => { timer = setTimeout(() => resolve({ ok: false, reason: 'worker_timeout', execution }), this.options.timeoutMs ?? 300_000) })
    const result = await Promise.race([actual.then(value => value.ok ? { ok: true as const, execution: value.value } : { ok: false as const, reason: value.message }), timeout])
    if (timer) clearTimeout(timer)
    if (!result.ok && result.reason === 'worker_timeout') this.lifecycle.cancel(executionId, 'worker_timeout')
    return result
  }
}
