import {
  appendTelemetryEvent,
  appendTelemetrySample,
  type TelemetryDimensions,
  type TelemetryScope
} from './telemetry-store'

type TelemetryDependencies = {
  appendSample: typeof appendTelemetrySample
  appendEvent: typeof appendTelemetryEvent
}

const DEFAULT_DEPENDENCIES: TelemetryDependencies = {
  appendSample: appendTelemetrySample,
  appendEvent: appendTelemetryEvent
}

type IndexTelemetryInput = {
  sourceId?: string
  durationMs: number
  indexedFileCount?: number
  outcome: 'success' | 'failure'
  reasonCode: 'index_completed' | 'index_failed' | 'source_not_found' | 'source_path_missing'
}

type GraphifyTelemetryInput = {
  sourceId?: string
  durationMs: number
  outcome: 'success' | 'failure' | 'degraded' | 'rejected'
  reasonCode: 'graphify_completed' | 'missing_graph_artifacts' | 'graphify_failed' | 'invalid_source' | 'source_not_found'
}

function boundedNumber(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function boundedCount(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.floor(value))
}

function safeScope(sourceId?: string): TelemetryScope {
  return sourceId ? { sourceId } : {}
}

export function recordIndexTelemetry(
  input: IndexTelemetryInput,
  dependencies: TelemetryDependencies = DEFAULT_DEPENDENCIES
): boolean {
  try {
    const dimensions: TelemetryDimensions = {
      component: 'index',
      operation: 'build_index_for_source',
      outcome: input.outcome,
      reasonCode: input.reasonCode
    }
    const measurements = {
      durationMs: boundedNumber(input.durationMs),
      count: boundedCount(input.indexedFileCount)
    }
    dependencies.appendSample({
      name: 'index_duration',
      scope: safeScope(input.sourceId),
      dimensions,
      measurements
    })
    dependencies.appendEvent({
      name: input.outcome === 'success' ? 'index_completed' : 'index_failed',
      scope: safeScope(input.sourceId),
      dimensions,
      measurements
    })
    return true
  } catch {
    return false
  }
}

export function recordGraphifyTelemetry(
  input: GraphifyTelemetryInput,
  dependencies: TelemetryDependencies = DEFAULT_DEPENDENCIES
): boolean {
  try {
    const dimensions: TelemetryDimensions = {
      component: 'graphify',
      operation: 'graph_context',
      outcome: input.outcome,
      reasonCode: input.reasonCode
    }
    const measurements = { durationMs: boundedNumber(input.durationMs) }
    dependencies.appendSample({
      name: 'graphify_duration',
      scope: safeScope(input.sourceId),
      dimensions,
      measurements
    })
    dependencies.appendEvent({
      name: input.outcome === 'failure' || input.outcome === 'rejected' ? 'graphify_failed' : 'graphify_completed',
      scope: safeScope(input.sourceId),
      dimensions,
      measurements
    })
    return true
  } catch {
    return false
  }
}
