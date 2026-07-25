import { evaluateSloHealth, type SloHealthResult, type SloThresholdConfig } from './slo-health'
import type { TelemetrySample, TelemetryStore } from './telemetry-store'

export type LoadSurface = 'direct' | 'relay' | 'mcp' | 'compact_status'
export type LoadOutcome = 'success' | 'failure' | 'timeout' | 'interrupted'

export type LoadProbeResult = {
  outcome: LoadOutcome
  durationMs: number
  responseBytes: number
  renderedBytes?: number
}

export type LoadProbe = () => Promise<LoadProbeResult> | LoadProbeResult

export type LoadHarnessProfile = {
  surface: LoadSurface
  iterations: number
  concurrency: number
  mobileResponseBudgetBytes?: number
  probe: LoadProbe
}

export type LoadSurfaceReport = {
  surface: LoadSurface
  iterations: number
  concurrency: number
  successes: number
  failures: number
  timeouts: number
  interruptions: number
  recoveredAfterFailure: boolean
  baselineMs: number
  peakMs: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  averageMs: number
  peakResponseBytes: number
  peakRenderedBytes: number
  mobileBudgetBytes?: number
  mobileBudgetExceeded: boolean
  timeoutBaselineMs?: number
  interruptionBaselineMs?: number
}

export type LoadHarnessReport = {
  version: 1
  startedAt: string
  completedAt: string
  profiles: LoadSurfaceReport[]
  slo: SloHealthResult
  summary: {
    totalIterations: number
    totalFailures: number
    totalTimeouts: number
    totalInterruptions: number
    recoveredProfiles: number
    overloadedProfiles: LoadSurface[]
    degradedProfiles: LoadSurface[]
  }
}

function boundedInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.floor(value)))
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentileValue * sorted.length) - 1))
  return sorted[index]
}

async function runBoundedProfile(profile: LoadHarnessProfile): Promise<{ report: LoadSurfaceReport; samples: TelemetrySample[] }> {
  const iterations = boundedInteger(profile.iterations, 1, 500)
  const concurrency = boundedInteger(profile.concurrency, 1, 32)
  const results: LoadProbeResult[] = []
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (nextIndex < iterations) {
      nextIndex += 1
      try {
        const result = await profile.probe()
        results.push({
          outcome: result.outcome,
          durationMs: Math.max(0, Number.isFinite(result.durationMs) ? result.durationMs : 0),
          responseBytes: boundedInteger(result.responseBytes, 0, 4 * 1024 * 1024),
          renderedBytes: result.renderedBytes === undefined ? undefined : boundedInteger(result.renderedBytes, 0, 4 * 1024 * 1024)
        })
      } catch {
        results.push({ outcome: 'failure', durationMs: 0, responseBytes: 0 })
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, iterations) }, () => worker()))
  const durations = results.map(result => result.durationMs)
  const successes = results.filter(result => result.outcome === 'success').length
  const failures = results.filter(result => result.outcome === 'failure').length
  const timeouts = results.filter(result => result.outcome === 'timeout').length
  const interruptions = results.filter(result => result.outcome === 'interrupted').length
  const firstFailureIndex = results.findIndex(result => result.outcome !== 'success')
  const recoveredAfterFailure = firstFailureIndex >= 0 && results.slice(firstFailureIndex + 1).some(result => result.outcome === 'success')
  const peakResponseBytes = results.reduce((peak, result) => Math.max(peak, result.responseBytes), 0)
  const peakRenderedBytes = results.reduce((peak, result) => Math.max(peak, result.renderedBytes || 0), 0)
  const mobileBudgetBytes = profile.mobileResponseBudgetBytes === undefined
    ? undefined
    : boundedInteger(profile.mobileResponseBudgetBytes, 256, 256 * 1024)
  const timeoutDurations = results.filter(result => result.outcome === 'timeout').map(result => result.durationMs)
  const interruptionDurations = results.filter(result => result.outcome === 'interrupted').map(result => result.durationMs)
  const averageMs = durations.reduce((sum, value) => sum + value, 0) / Math.max(durations.length, 1)

  const report: LoadSurfaceReport = {
    surface: profile.surface,
    iterations,
    concurrency,
    successes,
    failures,
    timeouts,
    interruptions,
    recoveredAfterFailure,
    baselineMs: round(percentile(durations, 0.5)),
    peakMs: round(Math.max(...durations, 0)),
    p50Ms: round(percentile(durations, 0.5)),
    p95Ms: round(percentile(durations, 0.95)),
    p99Ms: round(percentile(durations, 0.99)),
    averageMs: round(averageMs),
    peakResponseBytes,
    peakRenderedBytes,
    ...(mobileBudgetBytes === undefined ? {} : { mobileBudgetBytes }),
    mobileBudgetExceeded: mobileBudgetBytes === undefined ? false : Math.max(peakResponseBytes, peakRenderedBytes) > mobileBudgetBytes,
    ...(timeoutDurations.length === 0 ? {} : { timeoutBaselineMs: round(percentile(timeoutDurations, 0.5)) }),
    ...(interruptionDurations.length === 0 ? {} : { interruptionBaselineMs: round(percentile(interruptionDurations, 0.5)) })
  }

  const now = new Date().toISOString()
  const samples: TelemetrySample[] = results.map((result, index) => ({
    schemaVersion: 1,
    kind: 'sample',
    id: `load-${profile.surface}-${index + 1}`,
    name: 'request_latency',
    recordedAt: now,
    scope: {},
    dimensions: {
      component: 'executor',
      operation: profile.surface === 'compact_status' ? 'compact_status_ttfb' : `${profile.surface}_load`,
      outcome: result.outcome === 'success' ? 'success' : result.outcome === 'timeout' ? 'timed_out' : result.outcome === 'interrupted' ? 'cancelled' : 'failure',
      reasonCode: result.outcome
    },
    measurements: {
      durationMs: result.durationMs,
      responseBytes: result.responseBytes,
      renderedBytes: result.renderedBytes,
      interruptions: result.outcome === 'interrupted' ? 1 : 0,
      retries: recoveredAfterFailure && result.outcome === 'success' ? 1 : 0
    }
  }))

  return { report, samples }
}

export async function runLoadHarness(input: {
  profiles: LoadHarnessProfile[]
  thresholds?: Partial<SloThresholdConfig>
  startedAt?: Date
}): Promise<LoadHarnessReport> {
  const startedAt = input.startedAt || new Date()
  const selected = input.profiles.slice(0, 8)
  const completed = [] as Array<{ report: LoadSurfaceReport; samples: TelemetrySample[] }>
  for (const profile of selected) completed.push(await runBoundedProfile(profile))

  const samples = completed.flatMap(item => item.samples)
  const store: TelemetryStore = {
    version: 1,
    updatedAt: new Date().toISOString(),
    samples,
    events: []
  }
  const slo = evaluateSloHealth({ store, thresholds: input.thresholds, now: new Date() })
  const reports = completed.map(item => item.report)
  const overloadedProfiles = reports.filter(report => report.p95Ms >= 3_500 || report.mobileBudgetExceeded).map(report => report.surface)
  const degradedProfiles = reports.filter(report => !overloadedProfiles.includes(report.surface) && report.p95Ms >= 2_000).map(report => report.surface)

  return {
    version: 1,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    profiles: reports,
    slo,
    summary: {
      totalIterations: reports.reduce((sum, report) => sum + report.iterations, 0),
      totalFailures: reports.reduce((sum, report) => sum + report.failures, 0),
      totalTimeouts: reports.reduce((sum, report) => sum + report.timeouts, 0),
      totalInterruptions: reports.reduce((sum, report) => sum + report.interruptions, 0),
      recoveredProfiles: reports.filter(report => report.recoveredAfterFailure).length,
      overloadedProfiles,
      degradedProfiles
    }
  }
}
