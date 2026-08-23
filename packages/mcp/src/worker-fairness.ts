import { Ajv, type ValidateFunction } from 'ajv'

export const WORKBENCH_FAIRNESS_CONTRACT_VERSION = '1' as const
export const WORKBENCH_ADMISSION_SCORE_KIND = 'workbench.worker.admission-score' as const
export const WORKBENCH_OBSERVABILITY_SNAPSHOT_KIND = 'workbench.worker.observability' as const
export const WORKBENCH_BENCHMARK_ACCEPTANCE_KIND = 'workbench.benchmark.acceptance' as const

export const WORKBENCH_RECOVERY_CLASS_VALUES = ['never_started', 'completed', 'failed', 'unknown'] as const
export type WorkbenchRecoveryClass = typeof WORKBENCH_RECOVERY_CLASS_VALUES[number]

export type WorkbenchAdmissionScore = {
  kind: typeof WORKBENCH_ADMISSION_SCORE_KIND
  contractVersion: typeof WORKBENCH_FAIRNESS_CONTRACT_VERSION
  deviceId: string
  queueDepth: number
  activeWork: number
  resourcePressure: number
  responsiveness: number
  capabilityFit: number
  compositeScore: number
  scoredAt: string
}

export type WorkbenchDeviceObservability = {
  deviceId: string
  state: string
  activeRuns: number
  queueDepth: number
  availableSlots: number
  lastHeartbeatAt: string
  runAssignments: string[]
}

export type WorkbenchObservabilitySnapshot = {
  kind: typeof WORKBENCH_OBSERVABILITY_SNAPSHOT_KIND
  contractVersion: typeof WORKBENCH_FAIRNESS_CONTRACT_VERSION
  snapshotId: string
  devices: WorkbenchDeviceObservability[]
  totalActiveRuns: number
  totalQueuedWork: number
  deviceCount: number
  snapshotAt: string
}

export type WorkbenchBenchmarkSample = {
  deviceCount: number
  independentWorkloads: number
  concurrentConversations: number
  latencyMs: number
  memoryMb: number
  conflictRate: number
  throughputGain: number
  schedulerFairness: number
  sampledAt: string
}

export type WorkbenchBenchmarkAcceptance = {
  kind: typeof WORKBENCH_BENCHMARK_ACCEPTANCE_KIND
  contractVersion: typeof WORKBENCH_FAIRNESS_CONTRACT_VERSION
  accepted: boolean
  minDevicesMet: boolean
  throughputGainMet: boolean
  conflictRateMet: boolean
  concurrencyMet: boolean
  singleDevicePreserved: boolean
  reason: string
  sample: WorkbenchBenchmarkSample
  evaluatedAt: string
}

type JsonSchema = Record<string, unknown>
const boundedString = (maxLength: number): JsonSchema => ({ type: 'string', minLength: 1, maxLength })

export const WORKBENCH_ADMISSION_SCORE_SCHEMA: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Workbench Admission Score',
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'contractVersion', 'deviceId', 'queueDepth', 'activeWork', 'resourcePressure', 'responsiveness', 'capabilityFit', 'compositeScore', 'scoredAt'],
  properties: {
    kind: { const: WORKBENCH_ADMISSION_SCORE_KIND },
    contractVersion: { const: WORKBENCH_FAIRNESS_CONTRACT_VERSION },
    deviceId: boundedString(128),
    queueDepth: { type: 'integer', minimum: 0 },
    activeWork: { type: 'integer', minimum: 0 },
    resourcePressure: { type: 'number', minimum: 0, maximum: 1 },
    responsiveness: { type: 'number', minimum: 0, maximum: 1 },
    capabilityFit: { type: 'number', minimum: 0, maximum: 1 },
    compositeScore: { type: 'number', minimum: 0, maximum: 1 },
    scoredAt: boundedString(64)
  }
}

let admissionScoreValidator: ValidateFunction | undefined

function getAdmissionScoreValidator(): ValidateFunction {
  if (!admissionScoreValidator) {
    const ajv = new Ajv({ strict: false, allErrors: true })
    admissionScoreValidator = ajv.compile(WORKBENCH_ADMISSION_SCORE_SCHEMA)
  }
  return admissionScoreValidator
}

export function validateAdmissionScore(
  input: unknown
): { valid: true; score: WorkbenchAdmissionScore } | { valid: false; errors: string[] } {
  const validate = getAdmissionScoreValidator()
  if (validate(input)) return { valid: true, score: input as WorkbenchAdmissionScore }
  return { valid: false, errors: (validate.errors ?? []).map(e => `${e.instancePath} ${e.message ?? ''}`.trim()) }
}

export type WorkbenchFairnessState = {
  scores: Map<string, WorkbenchAdmissionScore>
  snapshots: WorkbenchObservabilitySnapshot[]
  maxSnapshots: number
}

export function createFairnessState(maxSnapshots = 10): WorkbenchFairnessState {
  return { scores: new Map(), snapshots: [], maxSnapshots }
}

const PRESSURE_MAP: Record<string, number> = { low: 0.1, medium: 0.5, high: 0.9 }

export function scoreDevice(
  deviceId: string,
  queueDepth: number,
  activeWork: number,
  cpuPressure: string,
  memoryPressure: string,
  maxLatencyMs: number,
  measuredLatencyMs: number,
  capabilityFit: number,
  timestamp: string
): WorkbenchAdmissionScore {
  const normalizedQueueDepth = Math.max(0, Math.floor(queueDepth))
  const normalizedActiveWork = Math.max(0, Math.floor(activeWork))
  const normalizedCapabilityFit = Math.min(Math.max(capabilityFit, 0), 1)
  const normalizedLatency = Math.max(0, measuredLatencyMs)
  const cpuP = PRESSURE_MAP[cpuPressure] ?? 0.5
  const memP = PRESSURE_MAP[memoryPressure] ?? 0.5
  const resourcePressure = (cpuP + memP) / 2
  const responsiveness = maxLatencyMs > 0 ? Math.min(1, Math.max(0, 1 - normalizedLatency / maxLatencyMs)) : 0
  const compositeScore = (
    (1 - Math.min(normalizedQueueDepth / 10, 1)) * 0.3 +
    (1 - Math.min(normalizedActiveWork / 5, 1)) * 0.2 +
    (1 - resourcePressure) * 0.2 +
    responsiveness * 0.15 +
    normalizedCapabilityFit * 0.15
  )
  return {
    kind: WORKBENCH_ADMISSION_SCORE_KIND,
    contractVersion: WORKBENCH_FAIRNESS_CONTRACT_VERSION,
    deviceId,
    queueDepth: normalizedQueueDepth,
    activeWork: normalizedActiveWork,
    resourcePressure,
    responsiveness,
    capabilityFit: normalizedCapabilityFit,
    compositeScore: Math.round(compositeScore * 1000) / 1000,
    scoredAt: timestamp
  }
}

export function selectBestDevice(
  state: WorkbenchFairnessState,
  candidateIds: string[]
): string | null {
  let best: string | null = null
  let bestScore = -1
  for (const id of candidateIds) {
    const score = state.scores.get(id)
    if (score && score.compositeScore > bestScore) {
      bestScore = score.compositeScore
      best = id
    }
  }
  return best
}

export function classifyRecovery(
  hasLocalEvidence: boolean,
  evidenceState: string | null,
  packetIdempotent: boolean
): WorkbenchRecoveryClass {
  if (!hasLocalEvidence) return 'never_started'
  if (evidenceState === 'completed' || evidenceState === 'reconciled') return 'completed'
  if (evidenceState === 'failed' || evidenceState === 'cancelled') return 'failed'
  if (!packetIdempotent) return 'unknown'
  return 'unknown'
}

export type WorkbenchDeviceForSnapshot = {
  deviceId: string
  state: string
  activeRuns: number
  queueDepth: number
  availableSlots: number
  lastHeartbeatAt: string
  runAssignments: string[]
}

export function takeObservabilitySnapshot(
  state: WorkbenchFairnessState,
  snapshotId: string,
  devices: WorkbenchDeviceForSnapshot[],
  timestamp: string
): WorkbenchObservabilitySnapshot {
  const snapshot: WorkbenchObservabilitySnapshot = {
    kind: WORKBENCH_OBSERVABILITY_SNAPSHOT_KIND,
    contractVersion: WORKBENCH_FAIRNESS_CONTRACT_VERSION,
    snapshotId,
    devices: devices.map(d => ({
      deviceId: d.deviceId,
      state: d.state,
      activeRuns: d.activeRuns,
      queueDepth: d.queueDepth,
      availableSlots: d.availableSlots,
      lastHeartbeatAt: d.lastHeartbeatAt,
      runAssignments: d.runAssignments
    })),
    totalActiveRuns: devices.reduce((sum, d) => sum + d.activeRuns, 0),
    totalQueuedWork: devices.reduce((sum, d) => sum + d.queueDepth, 0),
    deviceCount: devices.length,
    snapshotAt: timestamp
  }
  state.snapshots.push(snapshot)
  if (state.snapshots.length > state.maxSnapshots) {
    state.snapshots.shift()
  }
  return snapshot
}

export type WorkbenchBenchmarkGates = {
  minDevices: number
  minThroughputGain: number
  maxConflictRate: number
  minConcurrentConversations: number
}

export const DEFAULT_BENCHMARK_GATES: WorkbenchBenchmarkGates = {
  minDevices: 2,
  minThroughputGain: 1.1,
  maxConflictRate: 0.05,
  minConcurrentConversations: 2
}

export function evaluateBenchmark(
  sample: WorkbenchBenchmarkSample,
  gates: WorkbenchBenchmarkGates,
  singleDevicePreserved: boolean,
  timestamp: string
): WorkbenchBenchmarkAcceptance {
  const minDevicesMet = sample.deviceCount >= gates.minDevices
  const throughputGainMet = sample.throughputGain >= gates.minThroughputGain
  const conflictRateMet = sample.conflictRate <= gates.maxConflictRate
  const concurrencyMet = sample.concurrentConversations >= gates.minConcurrentConversations
  const accepted = minDevicesMet && throughputGainMet && conflictRateMet && concurrencyMet && singleDevicePreserved

  const failures: string[] = []
  if (!minDevicesMet) failures.push(`device_count_${sample.deviceCount}_below_${gates.minDevices}`)
  if (!throughputGainMet) failures.push(`throughput_gain_${sample.throughputGain}_below_${gates.minThroughputGain}`)
  if (!conflictRateMet) failures.push(`conflict_rate_${sample.conflictRate}_above_${gates.maxConflictRate}`)
  if (!concurrencyMet) failures.push(`concurrency_${sample.concurrentConversations}_below_${gates.minConcurrentConversations}`)
  if (!singleDevicePreserved) failures.push('single_device_behavior_not_preserved')

  return {
    kind: WORKBENCH_BENCHMARK_ACCEPTANCE_KIND,
    contractVersion: WORKBENCH_FAIRNESS_CONTRACT_VERSION,
    accepted,
    minDevicesMet,
    throughputGainMet,
    conflictRateMet,
    concurrencyMet,
    singleDevicePreserved,
    reason: accepted ? 'all_gates_passed' : failures.join('; '),
    sample,
    evaluatedAt: timestamp
  }
}
