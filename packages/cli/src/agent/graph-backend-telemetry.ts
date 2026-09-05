import { appendTelemetryEvent, appendTelemetrySample, type TelemetryDimensions, type TelemetryScope } from './telemetry-store'

export type GraphBackend = 'disabled' | 'graphify' | 'cbm'
export type GraphFallbackReason =
  | 'disabled'
  | 'invalid_backend'
  | 'cbm_transport_unavailable'
  | 'cbm_stale'
  | 'cbm_building'
  | 'cbm_incompatible'
  | 'cbm_timeout'
  | 'cbm_invalid_response'
  | 'cbm_source_mismatch'
  | 'cbm_failed'

export type GraphFreshnessState = 'fresh' | 'stale' | 'unavailable' | 'building' | 'incompatible' | 'unknown' | 'not_applicable'

export type GraphBackendTelemetryInput = {
  sourceId?: string
  backendRequested: string
  backendUsed: GraphBackend | 'exact_source'
  fallbackReason?: GraphFallbackReason
  freshnessState: GraphFreshnessState
  providerLatencyMs: number
}

function healthForFreshness(state: GraphFreshnessState): 'healthy' | 'degraded' | 'unknown' {
  if (state === 'fresh') return 'healthy'
  if (state === 'stale' || state === 'unavailable' || state === 'building' || state === 'incompatible') return 'degraded'
  return 'unknown'
}

export function recordGraphBackendTelemetry(input: GraphBackendTelemetryInput): boolean {
  try {
    const dimensions: TelemetryDimensions = {
      component: 'index',
      operation: 'graph_context_router',
      outcome: input.fallbackReason ? 'degraded' : 'success',
      health: healthForFreshness(input.freshnessState),
      commandKind: `requested:${input.backendRequested}`,
      validationKind: `used:${input.backendUsed}`,
      reasonCode: input.fallbackReason || 'backend_completed'
    }
    const scope: TelemetryScope = input.sourceId ? { sourceId: input.sourceId } : {}
    const measurements = { durationMs: Math.max(0, Number.isFinite(input.providerLatencyMs) ? input.providerLatencyMs : 0) }
    appendTelemetrySample({ name: 'index_duration', scope, dimensions, measurements })
    appendTelemetryEvent({ name: input.fallbackReason ? 'index_failed' : 'index_completed', scope, dimensions, measurements })
    return true
  } catch {
    return false
  }
}
