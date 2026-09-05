import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compareProviders,
  evaluateBenchmark,
  hitRate,
  type WorkbenchBenchmarkMetrics,
  type WorkbenchBenchmarkResult
} from '../provider-benchmark.js'

function makeMetrics(overrides: Partial<WorkbenchBenchmarkMetrics> = {}): WorkbenchBenchmarkMetrics {
  return {
    retrievalLatencyMs: 50,
    relevantFileHits: 5,
    relevantSymbolHits: 3,
    totalCandidates: 10,
    indexingCostMs: 1000,
    freshnessCostMs: 100,
    memoryBytes: 1_000_000,
    diskBytes: 5_000_000,
    returnedContextBytes: 4096,
    actionCount: 2,
    toolCount: 3,
    correctnessScore: 0.8,
    ...overrides
  }
}

function makeResult(providerId: string, taskId: string, overrides: Partial<WorkbenchBenchmarkMetrics> = {}): WorkbenchBenchmarkResult {
  return {
    providerId,
    taskId,
    metrics: makeMetrics(overrides),
    returnedFiles: ['src/main.swift', 'src/app.swift'],
    returnedSymbols: ['AppState', 'main'],
    timestamp: '2026-08-21T12:00:00.000Z'
  }
}

test('hitRate computes correctly', () => {
  const rate = hitRate(['a.ts', 'b.ts', 'c.ts'], ['a.ts', 'c.ts', 'd.ts'])
  assert.ok(Math.abs(rate - 2 / 3) < 0.001)
})

test('hitRate with empty expected returns 1', () => {
  assert.equal(hitRate(['a.ts'], []), 1.0)
})

test('higher correctness with reasonable latency is net_benefit', () => {
  const baseline = makeResult('exact-source', 't1', { correctnessScore: 0.7 })
  const candidate = makeResult('structural', 't1', { correctnessScore: 0.9, returnedContextBytes: 4500 })
  assert.equal(evaluateBenchmark(candidate, baseline), 'net_benefit')
})

test('same correctness but much slower is marginal', () => {
  const baseline = makeResult('exact-source', 't1', { retrievalLatencyMs: 50 })
  const candidate = makeResult('structural', 't1', { retrievalLatencyMs: 90 })
  assert.equal(evaluateBenchmark(candidate, baseline), 'marginal')
})

test('lower correctness by large margin is degradation', () => {
  const baseline = makeResult('exact-source', 't1', { correctnessScore: 0.9 })
  const candidate = makeResult('structural', 't1', { correctnessScore: 0.7 })
  assert.equal(evaluateBenchmark(candidate, baseline), 'degradation')
})

test('extreme latency is degradation', () => {
  const baseline = makeResult('exact-source', 't1', { retrievalLatencyMs: 10 })
  const candidate = makeResult('structural', 't1', { retrievalLatencyMs: 100 })
  assert.equal(evaluateBenchmark(candidate, baseline), 'degradation')
})

test('compareProviders aggregates across tasks', () => {
  const results = [
    makeResult('exact-source', 't1', { correctnessScore: 0.7 }),
    makeResult('graphify', 't1', { correctnessScore: 0.9 }),
    makeResult('exact-source', 't2', { correctnessScore: 0.7 }),
    makeResult('graphify', 't2', { correctnessScore: 0.9 })
  ]
  const verdicts = compareProviders(results, 'exact-source')
  assert.equal(verdicts.get('graphify'), 'net_benefit')
})

test('any degradation task marks degradation overall', () => {
  const results = [
    makeResult('exact-source', 't1', { retrievalLatencyMs: 10 }),
    makeResult('slow', 't1', { retrievalLatencyMs: 200 }),
    makeResult('exact-source', 't2', { correctnessScore: 0.7 }),
    makeResult('slow', 't2', { correctnessScore: 0.9 })
  ]
  const verdicts = compareProviders(results, 'exact-source')
  assert.equal(verdicts.get('slow'), 'degradation')
})
