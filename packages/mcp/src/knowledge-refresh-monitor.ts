import type { KnowledgeRefreshExecutionRecord } from './knowledge-refresh-store.js'

export type KnowledgeRefreshMonitoring = { bounded: boolean; throughput: number; activeWorkers: number; queuedRefreshes: number; completedRefreshes: number; failedRefreshes: number; retryCount: number; averageExecutionTimeMs: number; providerHealthImpact: Record<string, { failed: number; completed: number; generations: number[] }> }

export function collectKnowledgeRefreshMonitoring(executions: readonly KnowledgeRefreshExecutionRecord[], now = new Date(), maxRecords = 500): KnowledgeRefreshMonitoring {
  const records = executions.slice(-Math.min(Math.max(1, maxRecords), 500))
  const completed = records.filter(item => item.state === 'completed')
  const durations = completed.flatMap(item => item.startedAt && item.completedAt ? [Math.max(0, Date.parse(item.completedAt) - Date.parse(item.startedAt))] : [])
  const providerHealthImpact: KnowledgeRefreshMonitoring['providerHealthImpact'] = {}
  for (const record of records) { const entry = providerHealthImpact[record.providerId] ?? { failed: 0, completed: 0, generations: [] }; if (record.state === 'failed') entry.failed += 1; if (record.state === 'completed') { entry.completed += 1; if (record.resultingGeneration !== undefined) entry.generations.push(record.resultingGeneration) } providerHealthImpact[record.providerId] = entry }
  return { bounded: records.length <= 500, throughput: completed.length, activeWorkers: records.filter(item => item.state === 'running').length, queuedRefreshes: records.filter(item => item.state === 'queued').length, completedRefreshes: completed.length, failedRefreshes: records.filter(item => item.state === 'failed').length, retryCount: records.reduce((sum, item) => sum + Math.max(0, item.attempts - 1), 0), averageExecutionTimeMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0, providerHealthImpact }
}
