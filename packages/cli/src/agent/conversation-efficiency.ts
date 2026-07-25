import { loadTelemetryStore, type TelemetrySample } from './telemetry-store'

export type ConversationEfficiencyProfileKind = 'direct' | 'external'

export type ConversationEfficiencyHealth = 'healthy' | 'degraded' | 'overloaded' | 'unknown'

export type ConversationEfficiencyReasonCode =
  | 'missing_samples'
  | 'stale_samples'
  | 'recovered_from_stale'
  | 'byte_budget_crossed'
  | 'latency_budget_crossed'
  | 'retry_behavior'
  | 'interruption_behavior'
  | 'synthetic_fixture'
  | 'estimated_samples'
  | 'within_budget'
  | 'insufficient_data'
  | 'direct_better_score'
  | 'external_better_score'
  | 'score_tie'

export type ConversationEfficiencyBudgets = {
  promptBytes: {
    degraded: number
    overloaded: number
  }
  responseBytes: {
    degraded: number
    overloaded: number
  }
  renderedResponseBytes: {
    degraded: number
    overloaded: number
  }
  toolCallCount: {
    degraded: number
    overloaded: number
  }
  actionRoundTripCount: {
    degraded: number
    overloaded: number
  }
  retries: {
    degraded: number
    overloaded: number
  }
  interruptions: {
    degraded: number
    overloaded: number
  }
  timeToFirstUpdateMs: {
    degraded: number
    overloaded: number
  }
  timeToFinalResponseMs: {
    degraded: number
    overloaded: number
  }
  staleAfterMs: number
}

export type ConversationEfficiencySample = {
  observedAtMs: number
  promptBytes: number
  responseBytes: number
  renderedResponseBytes: number
  toolCallCount: number
  actionRoundTripCount: number
  retries: number
  interruptions: number
  timeToFirstUpdateMs: number
  timeToFinalResponseMs: number
  synthetic?: boolean
  estimated?: boolean
}

export type ConversationEfficiencyProfileInput = {
  profile: ConversationEfficiencyProfileKind
  samples: ConversationEfficiencySample[]
}

export type ConversationEfficiencyMetricSummary = {
  min: number
  p50: number
  p95: number
  max: number
  degradedThreshold: number
  overloadedThreshold: number
  budgetCrossed: boolean
}

export type ConversationEfficiencyCountSummary = {
  total: number
  peak: number
}

export type ConversationEfficiencyProfileReport = {
  profile: ConversationEfficiencyProfileKind
  sampleCount: number
  freshSampleCount: number
  staleSampleCount: number
  syntheticSampleCount: number
  estimatedSampleCount: number
  health: ConversationEfficiencyHealth
  reasonCodes: ConversationEfficiencyReasonCode[]
  efficiencyScore: number
  recovered: boolean
  bytes: {
    prompt: ConversationEfficiencyMetricSummary
    response: ConversationEfficiencyMetricSummary
    renderedResponse: ConversationEfficiencyMetricSummary
  }
  latencies: {
    timeToFirstUpdate: ConversationEfficiencyMetricSummary
    timeToFinalResponse: ConversationEfficiencyMetricSummary
  }
  counts: {
    toolCalls: ConversationEfficiencyCountSummary
    actionRoundTrips: ConversationEfficiencyCountSummary
    retries: ConversationEfficiencyCountSummary
    interruptions: ConversationEfficiencyCountSummary
  }
  flags: {
    syntheticFixtures: boolean
    estimatedSamples: boolean
  }
}

export type ConversationEfficiencyComparison = {
  preferredProfile: ConversationEfficiencyProfileKind | 'tie'
  scoreDelta: number
  promptBytesDelta: number
  responseBytesDelta: number
  renderedResponseBytesDelta: number
  timeToFirstUpdateDeltaMs: number
  timeToFinalResponseDeltaMs: number
  reasonCode: ConversationEfficiencyReasonCode
}

export type ConversationEfficiencyReport = {
  version: 1
  evaluatedAtMs: number
  health: ConversationEfficiencyHealth
  efficiencyScore: number
  reasonCodes: ConversationEfficiencyReasonCode[]
  profiles: {
    direct: ConversationEfficiencyProfileReport
    external: ConversationEfficiencyProfileReport
  }
  comparison: ConversationEfficiencyComparison
  text: string
  narrowText: string
}

export type ConversationEfficiencyBudgetInput = Partial<ConversationEfficiencyBudgets>

export type ConversationEfficiencyReportInput = {
  profiles: [ConversationEfficiencyProfileInput, ConversationEfficiencyProfileInput]
  evaluatedAtMs?: number
  budgets?: ConversationEfficiencyBudgetInput
}

export type ConversationEfficiencyTelemetryReportInput = {
  evaluatedAtMs?: number
  budgets?: ConversationEfficiencyBudgetInput
}

export type ConversationEfficiencyTelemetryDependencies = {
  loadStore: typeof loadTelemetryStore
}

const DEFAULT_BUDGETS: ConversationEfficiencyBudgets = {
  promptBytes: { degraded: 24_000, overloaded: 48_000 },
  responseBytes: { degraded: 48_000, overloaded: 96_000 },
  renderedResponseBytes: { degraded: 64_000, overloaded: 128_000 },
  toolCallCount: { degraded: 4, overloaded: 8 },
  actionRoundTripCount: { degraded: 3, overloaded: 6 },
  retries: { degraded: 1, overloaded: 3 },
  interruptions: { degraded: 1, overloaded: 2 },
  timeToFirstUpdateMs: { degraded: 500, overloaded: 1_500 },
  timeToFinalResponseMs: { degraded: 2_000, overloaded: 5_000 },
  staleAfterMs: 5 * 60_000
}

const MAX_BYTES = 4 * 1024 * 1024
const MAX_MILLISECONDS = 24 * 60 * 60 * 1000
const MAX_TIMESTAMP_MS = Number.MAX_SAFE_INTEGER
const MAX_SAMPLE_COUNT = 200
const TEXT_LIMIT = 1_000
const NARROW_TEXT_LIMIT = 420

function clampInteger(value: unknown, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return min
  return Math.min(max, Math.max(min, Math.floor(numeric)))
}

function clampNonNegative(value: unknown, max: number): number {
  return clampInteger(value, 0, max)
}

function normalizeBudgets(input: ConversationEfficiencyBudgetInput = {}): ConversationEfficiencyBudgets {
  const budgets = { ...DEFAULT_BUDGETS }
  return {
    promptBytes: {
      degraded: clampNonNegative(input.promptBytes?.degraded ?? budgets.promptBytes.degraded, MAX_BYTES),
      overloaded: Math.max(
        clampNonNegative(input.promptBytes?.degraded ?? budgets.promptBytes.degraded, MAX_BYTES),
        clampNonNegative(input.promptBytes?.overloaded ?? budgets.promptBytes.overloaded, MAX_BYTES)
      )
    },
    responseBytes: {
      degraded: clampNonNegative(input.responseBytes?.degraded ?? budgets.responseBytes.degraded, MAX_BYTES),
      overloaded: Math.max(
        clampNonNegative(input.responseBytes?.degraded ?? budgets.responseBytes.degraded, MAX_BYTES),
        clampNonNegative(input.responseBytes?.overloaded ?? budgets.responseBytes.overloaded, MAX_BYTES)
      )
    },
    renderedResponseBytes: {
      degraded: clampNonNegative(input.renderedResponseBytes?.degraded ?? budgets.renderedResponseBytes.degraded, MAX_BYTES),
      overloaded: Math.max(
        clampNonNegative(input.renderedResponseBytes?.degraded ?? budgets.renderedResponseBytes.degraded, MAX_BYTES),
        clampNonNegative(input.renderedResponseBytes?.overloaded ?? budgets.renderedResponseBytes.overloaded, MAX_BYTES)
      )
    },
    toolCallCount: {
      degraded: clampNonNegative(input.toolCallCount?.degraded ?? budgets.toolCallCount.degraded, 10_000),
      overloaded: Math.max(
        clampNonNegative(input.toolCallCount?.degraded ?? budgets.toolCallCount.degraded, 10_000),
        clampNonNegative(input.toolCallCount?.overloaded ?? budgets.toolCallCount.overloaded, 10_000)
      )
    },
    actionRoundTripCount: {
      degraded: clampNonNegative(input.actionRoundTripCount?.degraded ?? budgets.actionRoundTripCount.degraded, 10_000),
      overloaded: Math.max(
        clampNonNegative(input.actionRoundTripCount?.degraded ?? budgets.actionRoundTripCount.degraded, 10_000),
        clampNonNegative(input.actionRoundTripCount?.overloaded ?? budgets.actionRoundTripCount.overloaded, 10_000)
      )
    },
    retries: {
      degraded: clampNonNegative(input.retries?.degraded ?? budgets.retries.degraded, 10_000),
      overloaded: Math.max(
        clampNonNegative(input.retries?.degraded ?? budgets.retries.degraded, 10_000),
        clampNonNegative(input.retries?.overloaded ?? budgets.retries.overloaded, 10_000)
      )
    },
    interruptions: {
      degraded: clampNonNegative(input.interruptions?.degraded ?? budgets.interruptions.degraded, 10_000),
      overloaded: Math.max(
        clampNonNegative(input.interruptions?.degraded ?? budgets.interruptions.degraded, 10_000),
        clampNonNegative(input.interruptions?.overloaded ?? budgets.interruptions.overloaded, 10_000)
      )
    },
    timeToFirstUpdateMs: {
      degraded: clampNonNegative(input.timeToFirstUpdateMs?.degraded ?? budgets.timeToFirstUpdateMs.degraded, MAX_MILLISECONDS),
      overloaded: Math.max(
        clampNonNegative(input.timeToFirstUpdateMs?.degraded ?? budgets.timeToFirstUpdateMs.degraded, MAX_MILLISECONDS),
        clampNonNegative(input.timeToFirstUpdateMs?.overloaded ?? budgets.timeToFirstUpdateMs.overloaded, MAX_MILLISECONDS)
      )
    },
    timeToFinalResponseMs: {
      degraded: clampNonNegative(input.timeToFinalResponseMs?.degraded ?? budgets.timeToFinalResponseMs.degraded, MAX_MILLISECONDS),
      overloaded: Math.max(
        clampNonNegative(input.timeToFinalResponseMs?.degraded ?? budgets.timeToFinalResponseMs.degraded, MAX_MILLISECONDS),
        clampNonNegative(input.timeToFinalResponseMs?.overloaded ?? budgets.timeToFinalResponseMs.overloaded, MAX_MILLISECONDS)
      )
    },
    staleAfterMs: clampInteger(input.staleAfterMs ?? budgets.staleAfterMs, 1_000, MAX_MILLISECONDS)
  }
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1))
  return sorted[index]
}

function summarize(values: number[], degradedThreshold: number, overloadedThreshold: number, maxValue: number): ConversationEfficiencyMetricSummary {
  const bounded = values.map(value => clampNonNegative(value, maxValue))
  return {
    min: bounded.length === 0 ? 0 : Math.min(...bounded),
    p50: percentile(bounded, 0.5),
    p95: percentile(bounded, 0.95),
    max: bounded.length === 0 ? 0 : Math.max(...bounded),
    degradedThreshold,
    overloadedThreshold,
    budgetCrossed: bounded.some(value => value >= overloadedThreshold)
  }
}

function summarizeCounts(values: number[]): ConversationEfficiencyCountSummary {
  const bounded = values.map(value => clampNonNegative(value, 10_000))
  return {
    total: bounded.reduce((sum, value) => sum + value, 0),
    peak: bounded.length === 0 ? 0 : Math.max(...bounded)
  }
}

function clampScore(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)))
}

function topReasonCodes(codes: ConversationEfficiencyReasonCode[]): ConversationEfficiencyReasonCode[] {
  const priority: ConversationEfficiencyReasonCode[] = [
    'missing_samples',
    'stale_samples',
    'recovered_from_stale',
    'byte_budget_crossed',
    'latency_budget_crossed',
    'retry_behavior',
    'interruption_behavior',
    'direct_better_score',
    'external_better_score',
    'score_tie',
    'estimated_samples',
    'synthetic_fixture',
    'within_budget',
    'insufficient_data'
  ]
  const unique = [...new Set(codes)]
  return priority.filter(code => unique.includes(code)).slice(0, 4)
}

function buildSummaryText(report: ConversationEfficiencyReport): { text: string; narrowText: string } {
  const direct = report.profiles.direct
  const external = report.profiles.external
  const lines = [
    `conversation-efficiency · ${report.health} · ${report.comparison.preferredProfile}`,
    `Score ${direct.efficiencyScore}/${external.efficiencyScore} · Δ ${report.comparison.scoreDelta >= 0 ? '+' : ''}${report.comparison.scoreDelta}`,
    `Prompt ${direct.bytes.prompt.p95}/${external.bytes.prompt.p95} · Response ${direct.bytes.response.p95}/${external.bytes.response.p95}`,
    `Render ${direct.bytes.renderedResponse.p95}/${external.bytes.renderedResponse.p95} · TTFU ${direct.latencies.timeToFirstUpdate.p95}/${external.latencies.timeToFirstUpdate.p95} · TTF ${direct.latencies.timeToFinalResponse.p95}/${external.latencies.timeToFinalResponse.p95}`,
    `Counts retries ${direct.counts.retries.total}/${external.counts.retries.total} · interrupts ${direct.counts.interruptions.total}/${external.counts.interruptions.total} · reasons ${report.reasonCodes.join(',')}`
  ]
  const text = lines.join('\n').slice(0, TEXT_LIMIT)
  const narrowText = [
    `${report.health} · ${report.comparison.preferredProfile} · ${report.efficiencyScore}`,
    `P ${direct.bytes.prompt.p95}/${external.bytes.prompt.p95} · R ${direct.bytes.response.p95}/${external.bytes.response.p95}`,
    `L ${direct.latencies.timeToFirstUpdate.p95}/${external.latencies.timeToFirstUpdate.p95} · ${direct.latencies.timeToFinalResponse.p95}/${external.latencies.timeToFinalResponse.p95}`,
    `retries ${direct.counts.retries.total}/${external.counts.retries.total} · interrupts ${direct.counts.interruptions.total}/${external.counts.interruptions.total}`
  ].join(' | ').slice(0, NARROW_TEXT_LIMIT)
  return { text, narrowText }
}

function summarizeProfile(
  profile: ConversationEfficiencyProfileInput,
  evaluatedAtMs: number,
  budgets: ConversationEfficiencyBudgets
): ConversationEfficiencyProfileReport {
  const samples = profile.samples.slice(0, MAX_SAMPLE_COUNT).map(sample => ({
    observedAtMs: clampNonNegative(sample.observedAtMs, MAX_TIMESTAMP_MS),
    promptBytes: clampNonNegative(sample.promptBytes, MAX_BYTES),
    responseBytes: clampNonNegative(sample.responseBytes, MAX_BYTES),
    renderedResponseBytes: clampNonNegative(sample.renderedResponseBytes, MAX_BYTES),
    toolCallCount: clampNonNegative(sample.toolCallCount, 10_000),
    actionRoundTripCount: clampNonNegative(sample.actionRoundTripCount, 10_000),
    retries: clampNonNegative(sample.retries, 10_000),
    interruptions: clampNonNegative(sample.interruptions, 10_000),
    timeToFirstUpdateMs: clampNonNegative(sample.timeToFirstUpdateMs, MAX_MILLISECONDS),
    timeToFinalResponseMs: clampNonNegative(sample.timeToFinalResponseMs, MAX_MILLISECONDS),
    synthetic: sample.synthetic === true,
    estimated: sample.estimated === true
  }))

  const sampleCount = samples.length
  const ages = samples.map(sample => Math.max(0, evaluatedAtMs - sample.observedAtMs))
  const freshSamples = samples.filter((sample, index) => ages[index] <= budgets.staleAfterMs)
  const staleSamples = samples.filter((sample, index) => ages[index] > budgets.staleAfterMs)
  const primarySamples = freshSamples.length > 0 ? freshSamples : samples

  const prompt = summarize(primarySamples.map(sample => sample.promptBytes), budgets.promptBytes.degraded, budgets.promptBytes.overloaded, MAX_BYTES)
  const response = summarize(primarySamples.map(sample => sample.responseBytes), budgets.responseBytes.degraded, budgets.responseBytes.overloaded, MAX_BYTES)
  const renderedResponse = summarize(primarySamples.map(sample => sample.renderedResponseBytes), budgets.renderedResponseBytes.degraded, budgets.renderedResponseBytes.overloaded, MAX_BYTES)
  const timeToFirstUpdate = summarize(primarySamples.map(sample => sample.timeToFirstUpdateMs), budgets.timeToFirstUpdateMs.degraded, budgets.timeToFirstUpdateMs.overloaded, MAX_MILLISECONDS)
  const timeToFinalResponse = summarize(primarySamples.map(sample => sample.timeToFinalResponseMs), budgets.timeToFinalResponseMs.degraded, budgets.timeToFinalResponseMs.overloaded, MAX_MILLISECONDS)
  const toolCalls = summarizeCounts(primarySamples.map(sample => sample.toolCallCount))
  const actionRoundTrips = summarizeCounts(primarySamples.map(sample => sample.actionRoundTripCount))
  const retries = summarizeCounts(primarySamples.map(sample => sample.retries))
  const interruptions = summarizeCounts(primarySamples.map(sample => sample.interruptions))

  const syntheticSampleCount = samples.filter(sample => sample.synthetic).length
  const estimatedSampleCount = samples.filter(sample => sample.estimated).length
  const recovered = freshSamples.length > 0 && staleSamples.length > 0
  const allStale = sampleCount > 0 && freshSamples.length === 0
  const byteBudgetCrossed = prompt.budgetCrossed || response.budgetCrossed || renderedResponse.budgetCrossed
  const latencyBudgetCrossed = timeToFirstUpdate.budgetCrossed || timeToFinalResponse.budgetCrossed
  const retryBehavior = retries.total > 0
  const interruptionBehavior = interruptions.total > 0
  const reasonCodes: ConversationEfficiencyReasonCode[] = []

  if (sampleCount === 0) reasonCodes.push('missing_samples')
  else if (allStale) reasonCodes.push('stale_samples')
  else {
    if (recovered) reasonCodes.push('recovered_from_stale')
    if (byteBudgetCrossed) reasonCodes.push('byte_budget_crossed')
    if (latencyBudgetCrossed) reasonCodes.push('latency_budget_crossed')
    if (retryBehavior) reasonCodes.push('retry_behavior')
    if (interruptionBehavior) reasonCodes.push('interruption_behavior')
    if (estimatedSampleCount > 0) reasonCodes.push('estimated_samples')
    if (syntheticSampleCount > 0) reasonCodes.push('synthetic_fixture')
    if (reasonCodes.length === 0) reasonCodes.push('within_budget')
  }

  const health: ConversationEfficiencyHealth = sampleCount === 0 || allStale
    ? 'unknown'
    : byteBudgetCrossed || latencyBudgetCrossed
      ? 'overloaded'
      : retryBehavior || interruptionBehavior
        ? 'degraded'
        : 'healthy'

  const efficiencyScore = clampScore(
    sampleCount === 0
      ? 0
      : 100
        - (prompt.p95 / Math.max(budgets.promptBytes.overloaded, 1)) * 18
        - (response.p95 / Math.max(budgets.responseBytes.overloaded, 1)) * 18
        - (renderedResponse.p95 / Math.max(budgets.renderedResponseBytes.overloaded, 1)) * 14
        - (timeToFirstUpdate.p95 / Math.max(budgets.timeToFirstUpdateMs.overloaded, 1)) * 14
        - (timeToFinalResponse.p95 / Math.max(budgets.timeToFinalResponseMs.overloaded, 1)) * 14
        - Math.min(10, toolCalls.total / Math.max(budgets.toolCallCount.overloaded, 1) * 8)
        - Math.min(10, actionRoundTrips.total / Math.max(budgets.actionRoundTripCount.overloaded, 1) * 8)
        - Math.min(10, retries.total * 6)
        - Math.min(10, interruptions.total * 6)
        - (recovered ? 3 : 0)
        - (allStale ? 100 : 0)
  )

  return {
    profile: profile.profile,
    sampleCount,
    freshSampleCount: freshSamples.length,
    staleSampleCount: staleSamples.length,
    syntheticSampleCount,
    estimatedSampleCount,
    health,
    reasonCodes: topReasonCodes(reasonCodes),
    efficiencyScore,
    recovered,
    bytes: {
      prompt,
      response,
      renderedResponse
    },
    latencies: {
      timeToFirstUpdate,
      timeToFinalResponse
    },
    counts: {
      toolCalls,
      actionRoundTrips,
      retries,
      interruptions
    },
    flags: {
      syntheticFixtures: syntheticSampleCount > 0,
      estimatedSamples: estimatedSampleCount > 0
    }
  }
}

export function evaluateConversationEfficiency(input: ConversationEfficiencyReportInput): ConversationEfficiencyReport {
  const evaluatedAtMs = clampNonNegative(input.evaluatedAtMs ?? 0, MAX_TIMESTAMP_MS)
  const budgets = normalizeBudgets(input.budgets)
  const direct = summarizeProfile(input.profiles[0], evaluatedAtMs, budgets)
  const external = summarizeProfile(input.profiles[1], evaluatedAtMs, budgets)
  const comparisonScoreDelta = direct.efficiencyScore - external.efficiencyScore
  const comparisonReason: ConversationEfficiencyReasonCode = comparisonScoreDelta > 0
    ? 'direct_better_score'
    : comparisonScoreDelta < 0
      ? 'external_better_score'
      : 'score_tie'
  const preferredProfile: ConversationEfficiencyComparison['preferredProfile'] = comparisonScoreDelta > 0
    ? 'direct'
    : comparisonScoreDelta < 0
      ? 'external'
      : 'tie'
  const healthRank: Record<ConversationEfficiencyHealth, number> = { healthy: 0, degraded: 1, overloaded: 2, unknown: 3 }
  const reportHealth = healthRank[direct.health] >= healthRank[external.health] ? direct.health : external.health
  const reasonCodes = topReasonCodes([
    ...direct.reasonCodes,
    ...external.reasonCodes,
    comparisonReason
  ])
  const efficiencyScore = clampScore((direct.efficiencyScore + external.efficiencyScore) / 2)
  const report: ConversationEfficiencyReport = {
    version: 1,
    evaluatedAtMs,
    health: reportHealth,
    efficiencyScore,
    reasonCodes,
    profiles: { direct, external },
    comparison: {
      preferredProfile,
      scoreDelta: comparisonScoreDelta,
      promptBytesDelta: direct.bytes.prompt.p95 - external.bytes.prompt.p95,
      responseBytesDelta: direct.bytes.response.p95 - external.bytes.response.p95,
      renderedResponseBytesDelta: direct.bytes.renderedResponse.p95 - external.bytes.renderedResponse.p95,
      timeToFirstUpdateDeltaMs: direct.latencies.timeToFirstUpdate.p95 - external.latencies.timeToFirstUpdate.p95,
      timeToFinalResponseDeltaMs: direct.latencies.timeToFinalResponse.p95 - external.latencies.timeToFinalResponse.p95,
      reasonCode: comparisonReason
    },
    text: '',
    narrowText: ''
  }
  const rendered = buildSummaryText(report)
  report.text = rendered.text
  report.narrowText = rendered.narrowText
  return report
}

function telemetrySampleToConversationEfficiencySample(sample: TelemetrySample): ConversationEfficiencySample | undefined {
  const operation = sample.dimensions.operation
  const profile: ConversationEfficiencyProfileKind | undefined =
    operation === 'conversation_efficiency_direct' ? 'direct'
      : operation === 'conversation_efficiency_external' ? 'external'
        : undefined
  if (!profile) return undefined
  const measurements = sample.measurements
  const observedAtMs = Date.parse(sample.recordedAt)
  const durationMs = clampNonNegative(measurements.durationMs ?? 0, MAX_MILLISECONDS)
  return {
    observedAtMs: Number.isFinite(observedAtMs) ? observedAtMs : 0,
    promptBytes: clampNonNegative(measurements.promptBytes ?? 0, MAX_BYTES),
    responseBytes: clampNonNegative(measurements.responseBytes ?? 0, MAX_BYTES),
    renderedResponseBytes: clampNonNegative(measurements.renderedBytes ?? measurements.responseBytes ?? 0, MAX_BYTES),
    toolCallCount: clampNonNegative(measurements.toolCalls ?? 0, 10_000),
    actionRoundTripCount: clampNonNegative(measurements.actionRoundTrips ?? 0, 10_000),
    retries: clampNonNegative(measurements.retries ?? 0, 10_000),
    interruptions: clampNonNegative(measurements.interruptions ?? 0, 10_000),
    timeToFirstUpdateMs: durationMs,
    timeToFinalResponseMs: durationMs,
    synthetic: sample.dimensions.reasonCode === 'synthetic_fixture',
    estimated: true
  }
}

export function readConversationEfficiencyReport(
  input: ConversationEfficiencyTelemetryReportInput = {},
  dependencies: ConversationEfficiencyTelemetryDependencies = { loadStore: loadTelemetryStore }
): ConversationEfficiencyReport {
  try {
    const loaded = dependencies.loadStore()
    const directSamples: ConversationEfficiencySample[] = []
    const externalSamples: ConversationEfficiencySample[] = []
    for (const sample of loaded.store.samples) {
      if (sample.name !== 'conversation_efficiency') continue
      const converted = telemetrySampleToConversationEfficiencySample(sample)
      if (!converted) continue
      if (sample.dimensions.operation === 'conversation_efficiency_direct') directSamples.push(converted)
      if (sample.dimensions.operation === 'conversation_efficiency_external') externalSamples.push(converted)
    }
    return evaluateConversationEfficiency({
      profiles: [
        { profile: 'direct', samples: directSamples },
        { profile: 'external', samples: externalSamples }
      ],
      evaluatedAtMs: input.evaluatedAtMs,
      budgets: input.budgets
    })
  } catch {
    return evaluateConversationEfficiency({
      profiles: [
        { profile: 'direct', samples: [] },
        { profile: 'external', samples: [] }
      ],
      evaluatedAtMs: input.evaluatedAtMs,
      budgets: input.budgets
    })
  }
}
