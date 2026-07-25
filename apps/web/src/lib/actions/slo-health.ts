import { appendTelemetrySample, loadTelemetryStore } from '@workbench/cli/telemetry-store'
import {
  evaluateSloHealth,
  type SloHealthResult,
  type SloThresholdConfig
} from '@workbench/cli/slo-health'

export type CompactSloHealth = {
  health: SloHealthResult['health']
  evaluatedAt: string
  degradedMetrics: string[]
  overloadedMetrics: string[]
  unknownMetrics: string[]
}

export function readCompactSloHealth(
  input: { thresholds?: Partial<SloThresholdConfig>; now?: Date } = {},
  dependencies: { loadStore: typeof loadTelemetryStore } = { loadStore: loadTelemetryStore }
): CompactSloHealth {
  try {
    const loaded = dependencies.loadStore()
    const storeBytes = Buffer.byteLength(JSON.stringify(loaded.store), 'utf8')
    const result = evaluateSloHealth({
      store: loaded.store,
      thresholds: input.thresholds,
      now: input.now,
      telemetryStoreBytes: storeBytes
    })
    return {
      health: result.health,
      evaluatedAt: result.evaluatedAt,
      degradedMetrics: result.metrics.filter(metric => metric.health === 'degraded').map(metric => metric.key).slice(0, 4),
      overloadedMetrics: result.metrics.filter(metric => metric.health === 'overloaded').map(metric => metric.key).slice(0, 4),
      unknownMetrics: result.metrics.filter(metric => metric.health === 'unknown').map(metric => metric.key).slice(0, 4)
    }
  } catch {
    return {
      health: 'unknown',
      evaluatedAt: (input.now || new Date()).toISOString(),
      degradedMetrics: [],
      overloadedMetrics: [],
      unknownMetrics: ['telemetry_unavailable']
    }
  }
}



export function recordCompactStatusSloTelemetry(
  input: { durationMs: number; responseBytes: number },
  dependencies: { appendSample: typeof appendTelemetrySample } = { appendSample: appendTelemetrySample }
): boolean {
  try {
    dependencies.appendSample({
      name: 'request_latency',
      dimensions: {
        component: 'action',
        operation: 'compact_status_ttfb',
        outcome: 'success',
        reasonCode: 'status_ready'
      },
      measurements: {
        durationMs: Math.max(0, Number.isFinite(input.durationMs) ? input.durationMs : 0),
        responseBytes: Math.max(0, Math.floor(Number.isFinite(input.responseBytes) ? input.responseBytes : 0))
      }
    })
    return true
  } catch {
    return false
  }
}
