export type WorkbenchBenchmarkMetrics = {
  retrievalLatencyMs: number
  relevantFileHits: number
  relevantSymbolHits: number
  totalCandidates: number
  indexingCostMs: number
  freshnessCostMs: number
  memoryBytes: number
  diskBytes: number
  returnedContextBytes: number
  actionCount: number
  toolCount: number
  correctnessScore: number
}

export type WorkbenchBenchmarkTask = {
  taskId: string
  query: string
  expectedFiles: string[]
  expectedSymbols: string[]
}

export type WorkbenchBenchmarkResult = {
  providerId: string
  taskId: string
  metrics: WorkbenchBenchmarkMetrics
  returnedFiles: string[]
  returnedSymbols: string[]
  timestamp: string
}

export type WorkbenchBenchmarkVerdict = 'net_benefit' | 'marginal' | 'no_improvement' | 'degradation'

export function hitRate(returned: string[], expected: string[]): number {
  if (expected.length === 0) return 1.0
  const hits = expected.filter(e => returned.includes(e)).length
  return hits / expected.length
}

export function evaluateBenchmark(
  result: WorkbenchBenchmarkResult,
  baseline: WorkbenchBenchmarkResult
): WorkbenchBenchmarkVerdict {
  const latencyRatio = result.metrics.retrievalLatencyMs / Math.max(baseline.metrics.retrievalLatencyMs, 1.0)
  const contextRatio = result.metrics.returnedContextBytes / Math.max(baseline.metrics.returnedContextBytes, 1.0)
  const correctnessDelta = result.metrics.correctnessScore - baseline.metrics.correctnessScore

  if (correctnessDelta > 0.1 && latencyRatio < 2.0) return 'net_benefit'
  if (correctnessDelta >= 0 && latencyRatio <= 1.5 && contextRatio <= 1.2) return 'net_benefit'
  if (correctnessDelta >= -0.05 && latencyRatio <= 2.0) return 'marginal'
  if (correctnessDelta < -0.1 || latencyRatio > 5.0 || contextRatio > 3.0) return 'degradation'
  return 'no_improvement'
}

export function compareProviders(
  results: WorkbenchBenchmarkResult[],
  baselineProviderId: string
): Map<string, WorkbenchBenchmarkVerdict> {
  const grouped = new Map<string, WorkbenchBenchmarkResult[]>()
  for (const r of results) {
    const existing = grouped.get(r.taskId) ?? []
    existing.push(r)
    grouped.set(r.taskId, existing)
  }

  const verdictsByProvider = new Map<string, WorkbenchBenchmarkVerdict[]>()

  for (const [, taskResults] of grouped) {
    const baseline = taskResults.find(r => r.providerId === baselineProviderId)
    if (!baseline) continue
    for (const result of taskResults) {
      if (result.providerId === baselineProviderId) continue
      const verdict = evaluateBenchmark(result, baseline)
      const existing = verdictsByProvider.get(result.providerId) ?? []
      existing.push(verdict)
      verdictsByProvider.set(result.providerId, existing)
    }
  }

  const finalVerdicts = new Map<string, WorkbenchBenchmarkVerdict>()
  for (const [providerId, taskVerdicts] of verdictsByProvider) {
    const benefitCount = taskVerdicts.filter(v => v === 'net_benefit').length
    const degradationCount = taskVerdicts.filter(v => v === 'degradation').length
    if (degradationCount > 0) {
      finalVerdicts.set(providerId, 'degradation')
    } else if (benefitCount > taskVerdicts.length / 2) {
      finalVerdicts.set(providerId, 'net_benefit')
    } else if (benefitCount > 0) {
      finalVerdicts.set(providerId, 'marginal')
    } else {
      finalVerdicts.set(providerId, 'no_improvement')
    }
  }
  return finalVerdicts
}
