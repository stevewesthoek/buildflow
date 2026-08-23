import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateAdmissionScore,
  createFairnessState,
  scoreDevice,
  selectBestDevice,
  classifyRecovery,
  takeObservabilitySnapshot,
  evaluateBenchmark,
  DEFAULT_BENCHMARK_GATES,
  WORKBENCH_ADMISSION_SCORE_KIND,
  WORKBENCH_FAIRNESS_CONTRACT_VERSION,
  type WorkbenchBenchmarkSample
} from '../worker-fairness.js'

const TS = '2026-08-21T00:00:00Z'

function makeSample(overrides: Partial<WorkbenchBenchmarkSample> = {}): WorkbenchBenchmarkSample {
  return {
    deviceCount: 2,
    independentWorkloads: 3,
    concurrentConversations: 2,
    latencyMs: 200,
    memoryMb: 512,
    conflictRate: 0.01,
    throughputGain: 1.5,
    schedulerFairness: 0.95,
    sampledAt: TS,
    ...overrides
  }
}

describe('worker-fairness', () => {
  describe('validateAdmissionScore', () => {
    it('accepts a valid score', () => {
      const score = scoreDevice('dev-1', 2, 1, 'low', 'low', 1000, 100, 1.0, TS)
      const result = validateAdmissionScore(score)
      assert.equal(result.valid, true)
    })

    it('rejects a score with resourcePressure > 1', () => {
      const result = validateAdmissionScore({
        kind: WORKBENCH_ADMISSION_SCORE_KIND,
        contractVersion: WORKBENCH_FAIRNESS_CONTRACT_VERSION,
        deviceId: 'dev-1',
        queueDepth: 0,
        activeWork: 0,
        resourcePressure: 1.5,
        responsiveness: 0.9,
        capabilityFit: 1.0,
        compositeScore: 0.9,
        scoredAt: TS
      })
      assert.equal(result.valid, false)
    })

    it('rejects negative queueDepth', () => {
      const result = validateAdmissionScore({
        kind: WORKBENCH_ADMISSION_SCORE_KIND,
        contractVersion: WORKBENCH_FAIRNESS_CONTRACT_VERSION,
        deviceId: 'dev-1',
        queueDepth: -1,
        activeWork: 0,
        resourcePressure: 0.1,
        responsiveness: 0.9,
        capabilityFit: 1.0,
        compositeScore: 0.9,
        scoredAt: TS
      })
      assert.equal(result.valid, false)
    })
  })

  describe('scoreDevice', () => {
    it('produces a score with compositeScore in [0, 1]', () => {
      const score = scoreDevice('dev-1', 0, 0, 'low', 'low', 1000, 50, 1.0, TS)
      assert.ok(score.compositeScore >= 0 && score.compositeScore <= 1)
    })

    it('penalises high queue depth', () => {
      const lowQ = scoreDevice('dev-a', 0, 0, 'low', 'low', 1000, 50, 1.0, TS)
      const highQ = scoreDevice('dev-b', 10, 0, 'low', 'low', 1000, 50, 1.0, TS)
      assert.ok(lowQ.compositeScore > highQ.compositeScore)
    })

    it('penalises high resource pressure', () => {
      const lowP = scoreDevice('dev-a', 0, 0, 'low', 'low', 1000, 50, 1.0, TS)
      const highP = scoreDevice('dev-b', 0, 0, 'high', 'high', 1000, 50, 1.0, TS)
      assert.ok(lowP.compositeScore > highP.compositeScore)
    })

    it('bounds malformed score inputs to the contract range', () => {
      const score = scoreDevice('dev-bad', -3, -2, 'low', 'low', 1000, -50, 4, TS)
      assert.equal(score.queueDepth, 0)
      assert.equal(score.activeWork, 0)
      assert.equal(score.capabilityFit, 1)
      assert.equal(score.responsiveness, 1)
      assert.ok(score.compositeScore >= 0 && score.compositeScore <= 1)
    })
  })

  describe('selectBestDevice', () => {
    it('selects device with highest composite score', () => {
      const state = createFairnessState()
      const scoreA = scoreDevice('dev-a', 0, 0, 'low', 'low', 1000, 50, 1.0, TS)
      const scoreB = scoreDevice('dev-b', 5, 3, 'high', 'medium', 1000, 800, 0.5, TS)
      state.scores.set('dev-a', scoreA)
      state.scores.set('dev-b', scoreB)
      const best = selectBestDevice(state, ['dev-a', 'dev-b'])
      assert.equal(best, 'dev-a')
    })

    it('returns null when no candidates match', () => {
      const state = createFairnessState()
      const best = selectBestDevice(state, ['unknown-dev'])
      assert.equal(best, null)
    })
  })

  describe('classifyRecovery', () => {
    it('returns never_started when no evidence', () => {
      assert.equal(classifyRecovery(false, null, true), 'never_started')
    })

    it('returns completed when evidence shows completed', () => {
      assert.equal(classifyRecovery(true, 'completed', true), 'completed')
      assert.equal(classifyRecovery(true, 'reconciled', true), 'completed')
    })

    it('returns failed when evidence shows failed', () => {
      assert.equal(classifyRecovery(true, 'failed', true), 'failed')
      assert.equal(classifyRecovery(true, 'cancelled', false), 'failed')
    })

    it('returns unknown for ambiguous evidence', () => {
      assert.equal(classifyRecovery(true, 'running', false), 'unknown')
    })
  })

  describe('takeObservabilitySnapshot', () => {
    it('captures device state and totals', () => {
      const state = createFairnessState(10)
      const devices = [
        { deviceId: 'dev-a', state: 'online', activeRuns: 2, queueDepth: 1, availableSlots: 2, lastHeartbeatAt: TS, runAssignments: ['r1', 'r2'] },
        { deviceId: 'dev-b', state: 'busy', activeRuns: 4, queueDepth: 3, availableSlots: 0, lastHeartbeatAt: TS, runAssignments: ['r3', 'r4', 'r5', 'r6'] }
      ]
      const snapshot = takeObservabilitySnapshot(state, 'snap-1', devices, TS)
      assert.equal(snapshot.totalActiveRuns, 6)
      assert.equal(snapshot.totalQueuedWork, 4)
      assert.equal(snapshot.deviceCount, 2)
    })

    it('evicts oldest snapshot when maxSnapshots exceeded', () => {
      const state = createFairnessState(2)
      const devices = [{ deviceId: 'dev-a', state: 'online', activeRuns: 0, queueDepth: 0, availableSlots: 4, lastHeartbeatAt: TS, runAssignments: [] }]
      takeObservabilitySnapshot(state, 's1', devices, TS)
      takeObservabilitySnapshot(state, 's2', devices, TS)
      takeObservabilitySnapshot(state, 's3', devices, TS)
      assert.equal(state.snapshots.length, 2)
      assert.equal(state.snapshots[0].snapshotId, 's2')
    })
  })

  describe('evaluateBenchmark', () => {
    it('accepts a sample meeting all gates', () => {
      const result = evaluateBenchmark(makeSample(), DEFAULT_BENCHMARK_GATES, true, TS)
      assert.equal(result.accepted, true)
      assert.equal(result.reason, 'all_gates_passed')
    })

    it('rejects when device count is too low', () => {
      const result = evaluateBenchmark(makeSample({ deviceCount: 1 }), DEFAULT_BENCHMARK_GATES, true, TS)
      assert.equal(result.accepted, false)
      assert.equal(result.minDevicesMet, false)
      assert.ok(result.reason.includes('device_count'))
    })

    it('rejects when throughput gain is insufficient', () => {
      const result = evaluateBenchmark(makeSample({ throughputGain: 1.0 }), DEFAULT_BENCHMARK_GATES, true, TS)
      assert.equal(result.accepted, false)
      assert.equal(result.throughputGainMet, false)
    })

    it('rejects when conflict rate is too high', () => {
      const result = evaluateBenchmark(makeSample({ conflictRate: 0.1 }), DEFAULT_BENCHMARK_GATES, true, TS)
      assert.equal(result.accepted, false)
      assert.equal(result.conflictRateMet, false)
    })

    it('rejects when single-device behavior is not preserved', () => {
      const result = evaluateBenchmark(makeSample(), DEFAULT_BENCHMARK_GATES, false, TS)
      assert.equal(result.accepted, false)
      assert.equal(result.singleDevicePreserved, false)
      assert.ok(result.reason.includes('single_device_behavior_not_preserved'))
    })

    it('reports all failures when multiple gates fail', () => {
      const result = evaluateBenchmark(
        makeSample({ deviceCount: 1, throughputGain: 0.9, conflictRate: 0.2 }),
        DEFAULT_BENCHMARK_GATES,
        false,
        TS
      )
      assert.equal(result.accepted, false)
      assert.equal(result.minDevicesMet, false)
      assert.equal(result.throughputGainMet, false)
      assert.equal(result.conflictRateMet, false)
    })
  })
})
