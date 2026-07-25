import type { TelemetrySample, TelemetryStore } from './telemetry-store'

export type SloHealth = 'healthy' | 'degraded' | 'overloaded' | 'unknown'

export type SloThreshold = {
  degraded: number
  overloaded: number
}

export type SloThresholdConfig = {
  staleAfterMs: number
  actionLatencyP95Ms: SloThreshold
  actionLatencyP99Ms: SloThreshold
  queueWaitMs: SloThreshold
  gitLockWaitMs: SloThreshold
  eventLoopDelayMs: SloThreshold
  memorySlopeBytesPerMinute: SloThreshold
  diskBudgetBytes: SloThreshold
  telemetryStoreBytes: SloThreshold
  cancellationLatencyMs: SloThreshold
  responseRenderMs: SloThreshold
  promptBytes: SloThreshold
  responseBytes: SloThreshold
  compactStatusTtfbMs: SloThreshold
}

export const DEFAULT_SLO_THRESHOLDS: SloThresholdConfig = {
  staleAfterMs: 5 * 60_000,
  actionLatencyP95Ms: { degraded: 2_000, overloaded: 3_500 },
  actionLatencyP99Ms: { degraded: 3_000, overloaded: 4_000 },
  queueWaitMs: { degraded: 1_000, overloaded: 3_000 },
  gitLockWaitMs: { degraded: 100, overloaded: 500 },
  eventLoopDelayMs: { degraded: 50, overloaded: 200 },
  memorySlopeBytesPerMinute: { degraded: 8 * 1024 * 1024, overloaded: 32 * 1024 * 1024 },
  diskBudgetBytes: { degraded: 512 * 1024 * 1024, overloaded: 1024 * 1024 * 1024 },
  telemetryStoreBytes: { degraded: 2 * 1024 * 1024, overloaded: 4 * 1024 * 1024 },
  cancellationLatencyMs: { degraded: 1_000, overloaded: 3_000 },
  responseRenderMs: { degraded: 250, overloaded: 750 },
  promptBytes: { degraded: 48_000, overloaded: 96_000 },
  responseBytes: { degraded: 48_000, overloaded: 96_000 },
  compactStatusTtfbMs: { degraded: 500, overloaded: 1_500 }
}

export type SloMetricKey = Exclude<keyof SloThresholdConfig, 'staleAfterMs'>

export type SloMetricResult = {
  key: SloMetricKey
  health: SloHealth
  value?: number
  sampleCount: number
  reason: 'within_threshold' | 'degraded_threshold' | 'overloaded_threshold' | 'missing_samples' | 'stale_samples'
}

export type SloHealthResult = {
  health: SloHealth
  evaluatedAt: string
  metrics: SloMetricResult[]
}

function bounded(value: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, numeric))
}

function normalizeThreshold(value: Partial<SloThreshold> | undefined, fallback: SloThreshold): SloThreshold {
  const degraded = bounded(value?.degraded, fallback.degraded)
  const overloaded = bounded(value?.overloaded, fallback.overloaded, degraded)
  return { degraded, overloaded }
}

export function normalizeSloThresholds(input: Partial<SloThresholdConfig> = {}): SloThresholdConfig {
  return {
    staleAfterMs: bounded(input.staleAfterMs, DEFAULT_SLO_THRESHOLDS.staleAfterMs, 1_000, 24 * 60 * 60_000),
    actionLatencyP95Ms: normalizeThreshold(input.actionLatencyP95Ms, DEFAULT_SLO_THRESHOLDS.actionLatencyP95Ms),
    actionLatencyP99Ms: normalizeThreshold(input.actionLatencyP99Ms, DEFAULT_SLO_THRESHOLDS.actionLatencyP99Ms),
    queueWaitMs: normalizeThreshold(input.queueWaitMs, DEFAULT_SLO_THRESHOLDS.queueWaitMs),
    gitLockWaitMs: normalizeThreshold(input.gitLockWaitMs, DEFAULT_SLO_THRESHOLDS.gitLockWaitMs),
    eventLoopDelayMs: normalizeThreshold(input.eventLoopDelayMs, DEFAULT_SLO_THRESHOLDS.eventLoopDelayMs),
    memorySlopeBytesPerMinute: normalizeThreshold(input.memorySlopeBytesPerMinute, DEFAULT_SLO_THRESHOLDS.memorySlopeBytesPerMinute),
    diskBudgetBytes: normalizeThreshold(input.diskBudgetBytes, DEFAULT_SLO_THRESHOLDS.diskBudgetBytes),
    telemetryStoreBytes: normalizeThreshold(input.telemetryStoreBytes, DEFAULT_SLO_THRESHOLDS.telemetryStoreBytes),
    cancellationLatencyMs: normalizeThreshold(input.cancellationLatencyMs, DEFAULT_SLO_THRESHOLDS.cancellationLatencyMs),
    responseRenderMs: normalizeThreshold(input.responseRenderMs, DEFAULT_SLO_THRESHOLDS.responseRenderMs),
    promptBytes: normalizeThreshold(input.promptBytes, DEFAULT_SLO_THRESHOLDS.promptBytes),
    responseBytes: normalizeThreshold(input.responseBytes, DEFAULT_SLO_THRESHOLDS.responseBytes),
    compactStatusTtfbMs: normalizeThreshold(input.compactStatusTtfbMs, DEFAULT_SLO_THRESHOLDS.compactStatusTtfbMs)
  }
}

function percentile(values: number[], percentileValue: number): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentileValue * sorted.length) - 1))
  return sorted[index]
}

function sampleTime(sample: TelemetrySample): number {
  return Date.parse(sample.recordedAt)
}

function recentSamples(samples: TelemetrySample[], nowMs: number, staleAfterMs: number): TelemetrySample[] {
  return samples.filter(sample => Number.isFinite(sampleTime(sample)) && nowMs - sampleTime(sample) <= staleAfterMs)
}

function classify(key: SloMetricKey, value: number | undefined, count: number, threshold: SloThreshold, stale: boolean): SloMetricResult {
  if (value === undefined) return { key, health: 'unknown', sampleCount: count, reason: stale ? 'stale_samples' : 'missing_samples' }
  if (value >= threshold.overloaded) return { key, health: 'overloaded', value, sampleCount: count, reason: 'overloaded_threshold' }
  if (value >= threshold.degraded) return { key, health: 'degraded', value, sampleCount: count, reason: 'degraded_threshold' }
  return { key, health: 'healthy', value, sampleCount: count, reason: 'within_threshold' }
}

function numbers(samples: TelemetrySample[], getter: (sample: TelemetrySample) => number | undefined): number[] {
  return samples.map(getter).filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0)
}

function metricSamples(samples: TelemetrySample[], name: TelemetrySample['name'], operation?: string): TelemetrySample[] {
  return samples.filter(sample => sample.name === name && (!operation || sample.dimensions.operation === operation))
}

function memorySlope(samples: TelemetrySample[]): number | undefined {
  const points = samples
    .map(sample => ({ time: sampleTime(sample), value: sample.measurements.rssBytes }))
    .filter((point): point is { time: number; value: number } => Number.isFinite(point.time) && typeof point.value === 'number')
    .sort((a, b) => a.time - b.time)
  if (points.length < 2) return undefined
  const elapsedMinutes = (points[points.length - 1].time - points[0].time) / 60_000
  if (elapsedMinutes <= 0) return undefined
  return Math.max(0, (points[points.length - 1].value - points[0].value) / elapsedMinutes)
}

export function evaluateSloHealth(input: {
  store: TelemetryStore
  thresholds?: Partial<SloThresholdConfig>
  now?: Date
  diskUsageBytes?: number
  telemetryStoreBytes?: number
}): SloHealthResult {
  const thresholds = normalizeSloThresholds(input.thresholds)
  const now = input.now ?? new Date()
  const nowMs = now.getTime()
  const allSamples = input.store.samples
  const recent = recentSamples(allSamples, nowMs, thresholds.staleAfterMs)
  const stale = allSamples.length > 0 && recent.length === 0

  const request = metricSamples(recent, 'request_latency')
  const queue = metricSamples(recent, 'queue_wait')
  const gitLock = metricSamples(recent, 'git_lock_wait')
  const eventLoop = metricSamples(recent, 'event_loop_delay')
  const runtime = metricSamples(recent, 'runtime_resource')
  const cancellation = metricSamples(recent, 'conversation_efficiency', 'cancellation_latency')
  const render = metricSamples(recent, 'conversation_efficiency', 'response_render')
  const efficiency = metricSamples(recent, 'conversation_efficiency')
  const compactTtfb = metricSamples(recent, 'request_latency', 'compact_status_ttfb')

  const requestDurations = numbers(request, sample => sample.measurements.durationMs)
  const queueWaits = numbers(queue, sample => sample.measurements.queueWaitMs ?? sample.measurements.durationMs)
  const gitLockWaits = numbers(gitLock, sample => sample.measurements.queueWaitMs ?? sample.measurements.durationMs)
  const eventLoopDelays = numbers(eventLoop, sample => sample.measurements.eventLoopDelayMs ?? sample.measurements.durationMs)
  const cancellationDurations = numbers(cancellation, sample => sample.measurements.durationMs)
  const renderDurations = numbers(render, sample => sample.measurements.durationMs)
  const promptSizes = numbers(efficiency, sample => sample.measurements.promptBytes)
  const responseSizes = numbers(efficiency.concat(metricSamples(recent, 'response_size')), sample => sample.measurements.responseBytes ?? sample.measurements.renderedBytes)
  const compactTtfbDurations = numbers(compactTtfb, sample => sample.measurements.durationMs)

  const metrics: SloMetricResult[] = [
    classify('actionLatencyP95Ms', percentile(requestDurations, 0.95), requestDurations.length, thresholds.actionLatencyP95Ms, stale),
    classify('actionLatencyP99Ms', percentile(requestDurations, 0.99), requestDurations.length, thresholds.actionLatencyP99Ms, stale),
    classify('queueWaitMs', percentile(queueWaits, 0.95), queueWaits.length, thresholds.queueWaitMs, stale),
    classify('gitLockWaitMs', percentile(gitLockWaits, 0.95), gitLockWaits.length, thresholds.gitLockWaitMs, stale),
    classify('eventLoopDelayMs', percentile(eventLoopDelays, 0.95), eventLoopDelays.length, thresholds.eventLoopDelayMs, stale),
    classify('memorySlopeBytesPerMinute', memorySlope(runtime), runtime.length, thresholds.memorySlopeBytesPerMinute, stale),
    classify('diskBudgetBytes', input.diskUsageBytes, input.diskUsageBytes === undefined ? 0 : 1, thresholds.diskBudgetBytes, false),
    classify('telemetryStoreBytes', input.telemetryStoreBytes, input.telemetryStoreBytes === undefined ? 0 : 1, thresholds.telemetryStoreBytes, false),
    classify('cancellationLatencyMs', percentile(cancellationDurations, 0.95), cancellationDurations.length, thresholds.cancellationLatencyMs, stale),
    classify('responseRenderMs', percentile(renderDurations, 0.95), renderDurations.length, thresholds.responseRenderMs, stale),
    classify('promptBytes', percentile(promptSizes, 0.95), promptSizes.length, thresholds.promptBytes, stale),
    classify('responseBytes', percentile(responseSizes, 0.95), responseSizes.length, thresholds.responseBytes, stale),
    classify('compactStatusTtfbMs', percentile(compactTtfbDurations, 0.95), compactTtfbDurations.length, thresholds.compactStatusTtfbMs, stale)
  ]

  const health: SloHealth = metrics.some(metric => metric.health === 'overloaded')
    ? 'overloaded'
    : metrics.some(metric => metric.health === 'degraded')
      ? 'degraded'
      : metrics.some(metric => metric.health === 'healthy')
        ? 'healthy'
        : 'unknown'

  return { health, evaluatedAt: now.toISOString(), metrics }
}
