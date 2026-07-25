import {
  appendTelemetryEvent,
  appendTelemetrySample,
  type TelemetryDimensions
} from '@workbench/cli/telemetry-store'

export type RuntimeHealth = 'healthy' | 'degraded' | 'overloaded' | 'unknown'

type TelemetryDependencies = {
  appendSample: typeof appendTelemetrySample
  appendEvent: typeof appendTelemetryEvent
}

const DEFAULT_DEPENDENCIES: TelemetryDependencies = {
  appendSample: appendTelemetrySample,
  appendEvent: appendTelemetryEvent
}

let lastTunnelHealth: RuntimeHealth | undefined

function boundedInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

export function classifyRuntimeHealth(activeRequests: number): RuntimeHealth {
  if (!Number.isFinite(activeRequests) || activeRequests < 0) return 'unknown'
  if (activeRequests >= 20) return 'overloaded'
  if (activeRequests >= 10) return 'degraded'
  return 'healthy'
}

function telemetryOutcome(health: RuntimeHealth): NonNullable<TelemetryDimensions['outcome']> {
  return health === 'healthy' ? 'success' : 'degraded'
}

export function recordRuntimeResourceTelemetry(
  input: { heapBytes: number; rssBytes: number; activeRequests: number },
  dependencies: TelemetryDependencies = DEFAULT_DEPENDENCIES
): boolean {
  try {
    const health = classifyRuntimeHealth(input.activeRequests)
    dependencies.appendSample({
      name: 'runtime_resource',
      dimensions: {
        component: 'server',
        operation: 'status_runtime',
        outcome: telemetryOutcome(health),
        health,
        reasonCode: 'runtime_sampled'
      },
      measurements: {
        heapBytes: boundedInteger(input.heapBytes),
        rssBytes: boundedInteger(input.rssBytes),
        count: boundedInteger(input.activeRequests)
      }
    })
    return true
  } catch {
    return false
  }
}

export function recordTunnelHealthTelemetry(
  input: { health: RuntimeHealth; durationMs: number; reasonCode: 'relay_healthy' | 'relay_degraded' | 'relay_unreachable' | 'relay_timed_out' },
  dependencies: TelemetryDependencies = DEFAULT_DEPENDENCIES
): boolean {
  try {
    const dimensions: TelemetryDimensions = {
      component: 'tunnel',
      operation: 'relay_health_check',
      outcome: telemetryOutcome(input.health),
      health: input.health,
      reasonCode: input.reasonCode
    }
    const measurements = { durationMs: boundedInteger(input.durationMs), count: 1 }
    dependencies.appendSample({
      name: 'tunnel_health',
      dimensions,
      measurements
    })
    if (lastTunnelHealth !== input.health) {
      dependencies.appendEvent({
        name: 'tunnel_health_changed',
        dimensions,
        measurements
      })
      lastTunnelHealth = input.health
    }
    return true
  } catch {
    return false
  }
}

export function resetTunnelHealthTelemetryForTests(): void {
  lastTunnelHealth = undefined
}
