import {
  appendTelemetryEvent,
  appendTelemetrySample,
  redactTelemetryTag
} from '@workbench/cli/telemetry-store'

export type RunCommandTelemetryDisposition = 'success' | 'failure' | 'timed_out' | 'rejected'

export type RunCommandTelemetryReason =
  | 'invalid_request'
  | 'source_selection_required'
  | 'command_completed'
  | 'command_failed'
  | 'command_timed_out'
  | 'command_rejected'
  | 'transport_error'

export type RunCommandTelemetryInput = {
  disposition: RunCommandTelemetryDisposition
  reasonCode: RunCommandTelemetryReason
  requestDurationMs: number
  responseBytes: number
  sourceId?: string
  commandKind?: string
  commandDurationMs?: number
}

type TelemetryDependencies = {
  appendSample: typeof appendTelemetrySample
  appendEvent: typeof appendTelemetryEvent
}

const DEFAULT_DEPENDENCIES: TelemetryDependencies = {
  appendSample: appendTelemetrySample,
  appendEvent: appendTelemetryEvent
}

function boundedMeasurement(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function outcome(disposition: RunCommandTelemetryDisposition) {
  return disposition === 'success'
    ? 'success' as const
    : disposition === 'timed_out'
      ? 'timed_out' as const
      : disposition === 'rejected'
        ? 'rejected' as const
        : 'failure' as const
}

function requestEventName(disposition: RunCommandTelemetryDisposition) {
  return disposition === 'success'
    ? 'request_completed' as const
    : disposition === 'rejected'
      ? 'request_rejected' as const
      : 'request_failed' as const
}

export function jsonResponseBytes(payload: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(payload), 'utf8')
  } catch {
    return 0
  }
}

export function recordRunCommandTelemetry(
  input: RunCommandTelemetryInput,
  dependencies: TelemetryDependencies = DEFAULT_DEPENDENCIES
): boolean {
  try {
    const commandKind = input.commandKind ? redactTelemetryTag(input.commandKind) : undefined
    const scope = input.sourceId ? { sourceId: input.sourceId } : {}
    const requestDimensions = {
      component: 'action' as const,
      operation: 'runWorkbenchCommand',
      outcome: outcome(input.disposition),
      commandKind,
      reasonCode: input.reasonCode
    }

    dependencies.appendSample({
      name: 'request_latency',
      scope,
      dimensions: requestDimensions,
      measurements: { durationMs: boundedMeasurement(input.requestDurationMs) }
    })
    dependencies.appendSample({
      name: 'response_size',
      scope,
      dimensions: requestDimensions,
      measurements: { responseBytes: Math.floor(boundedMeasurement(input.responseBytes)) }
    })
    dependencies.appendEvent({
      name: requestEventName(input.disposition),
      scope,
      dimensions: requestDimensions,
      measurements: {
        durationMs: boundedMeasurement(input.requestDurationMs),
        responseBytes: Math.floor(boundedMeasurement(input.responseBytes))
      }
    })

    if (commandKind && input.commandDurationMs !== undefined) {
      const commandDimensions = {
        component: 'command' as const,
        operation: 'runSafeCommand',
        outcome: outcome(input.disposition),
        commandKind,
        reasonCode: input.reasonCode
      }
      dependencies.appendSample({
        name: 'command_duration',
        scope,
        dimensions: commandDimensions,
        measurements: { durationMs: boundedMeasurement(input.commandDurationMs) }
      })
      if (input.disposition !== 'rejected') {
        dependencies.appendEvent({
          name: input.disposition === 'success' ? 'command_completed' : 'command_failed',
          scope,
          dimensions: commandDimensions,
          measurements: { durationMs: boundedMeasurement(input.commandDurationMs) }
        })
      }
    }

    return true
  } catch {
    return false
  }
}
