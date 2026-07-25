import {
  appendTelemetryEvent,
  appendTelemetrySample,
  type TelemetryDimensions
} from './telemetry-store'

export type GitLockStoreKind = 'validation_jobs' | 'packet_store' | 'capability_operations' | 'delegation_operations'

type TelemetryDependencies = {
  appendSample: typeof appendTelemetrySample
  appendEvent: typeof appendTelemetryEvent
}

const DEFAULT_DEPENDENCIES: TelemetryDependencies = {
  appendSample: appendTelemetrySample,
  appendEvent: appendTelemetryEvent
}

function boundedDuration(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

export function recordGitLockTelemetry(
  input: {
    storeKind: GitLockStoreKind
    waitMs: number
    contended: boolean
  },
  dependencies: TelemetryDependencies = DEFAULT_DEPENDENCIES
): boolean {
  try {
    const dimensions: TelemetryDimensions = {
      component: 'git',
      operation: 'exclusive_store_lock',
      outcome: input.contended ? 'rejected' : 'success',
      reasonCode: input.contended ? 'lock_contended' : 'lock_acquired',
      commandKind: input.storeKind
    }
    const measurements = {
      queueWaitMs: boundedDuration(input.waitMs),
      count: 1
    }
    dependencies.appendSample({
      name: 'git_lock_wait',
      dimensions,
      measurements
    })
    if (input.contended) {
      dependencies.appendEvent({
        name: 'git_lock_contended',
        dimensions,
        measurements
      })
    }
    return true
  } catch {
    return false
  }
}
