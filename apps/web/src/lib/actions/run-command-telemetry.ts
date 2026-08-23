import {
  appendTelemetryEvent,
  appendTelemetrySample,
  loadTelemetryStore,
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
  | 'packet_rolled_back'
  | 'transport_error'

export type RunCommandTelemetryInput = {
  requestId: string
  operationId?: string
  disposition: RunCommandTelemetryDisposition
  reasonCode: RunCommandTelemetryReason
  requestDurationMs: number
  responseBytes: number
  renderedBytes: number
  actionRoundTrips: number
  retries: number
  interruptions: number
  sourceId?: string
  commandKind?: string
  commandDurationMs?: number
}

type TelemetryDependencies = {
  appendSample: typeof appendTelemetrySample
  appendEvent: typeof appendTelemetryEvent
  loadStore: typeof loadTelemetryStore
}

const DEFAULT_DEPENDENCIES: TelemetryDependencies = {
  appendSample: appendTelemetrySample,
  appendEvent: appendTelemetryEvent,
  loadStore: loadTelemetryStore
}

function factualMeasurement(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Missing factual telemetry measurement: ${label}`)
  return value
}

function factualInteger(value: number, label: string): number {
  const measured = factualMeasurement(value, label)
  if (!Number.isInteger(measured)) throw new Error(`Expected an integer telemetry measurement: ${label}`)
  return measured
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

export function buildRunCommandRouteTelemetryInput(
  payload: unknown,
  telemetry: Omit<RunCommandTelemetryInput, 'responseBytes' | 'renderedBytes' | 'actionRoundTrips' | 'retries' | 'interruptions'>
): RunCommandTelemetryInput {
  const payloadBytes = jsonResponseBytes(payload)
  return {
    ...telemetry,
    responseBytes: payloadBytes,
    renderedBytes: payloadBytes,
    actionRoundTrips: 1,
    retries: 0,
    interruptions: telemetry.disposition === 'timed_out' ? 1 : 0
  }
}

export function buildRolledBackPacketTelemetryInput(
  payload: unknown,
  telemetry: Omit<RunCommandTelemetryInput, 'operationId' | 'disposition' | 'reasonCode' | 'responseBytes' | 'renderedBytes' | 'actionRoundTrips' | 'retries' | 'interruptions'>
): RunCommandTelemetryInput {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Missing factual rolled-back packet payload')
  }
  const packet = payload as Record<string, unknown>
  if (packet.status !== 'failed' || packet.writesPerformed !== true || packet.rolledBack !== true) {
    throw new Error('Packet payload does not prove failed execution with completed rollback')
  }
  return buildRunCommandRouteTelemetryInput(payload, {
    ...telemetry,
    operationId: 'applyWorkbenchFileChange',
    disposition: 'failure',
    reasonCode: 'packet_rolled_back'
  })
}

export function recordRunCommandTelemetry(
  input: RunCommandTelemetryInput,
  dependencies: TelemetryDependencies = DEFAULT_DEPENDENCIES
): boolean {
  try {
    const existing = dependencies.loadStore().store.samples.filter(sample =>
      sample.scope.requestId === input.requestId
      && (sample.name === 'request_latency' || sample.name === 'conversation_efficiency')
    )
    if (existing.length > 0) return false

    const commandKind = input.commandKind ? redactTelemetryTag(input.commandKind) : undefined
    const operation = redactTelemetryTag(input.operationId ?? 'runWorkbenchCommand')
    const scope = {
      requestId: input.requestId,
      ...(input.sourceId ? { sourceId: input.sourceId } : {})
    }
    const requestDimensions = {
      component: 'action' as const,
      operation,
      outcome: outcome(input.disposition),
      commandKind,
      reasonCode: input.reasonCode
    }

    const requestDurationMs = factualMeasurement(input.requestDurationMs, 'requestDurationMs')
    const responseBytes = factualInteger(input.responseBytes, 'responseBytes')
    const renderedBytes = factualInteger(input.renderedBytes, 'renderedBytes')
    const actionRoundTrips = factualInteger(input.actionRoundTrips, 'actionRoundTrips')
    const retries = factualInteger(input.retries, 'retries')
    const interruptions = factualInteger(input.interruptions, 'interruptions')

    dependencies.appendSample({
      name: 'request_latency',
      scope,
      dimensions: requestDimensions,
      measurements: { durationMs: requestDurationMs }
    })
    dependencies.appendSample({
      name: 'response_size',
      scope,
      dimensions: requestDimensions,
      measurements: { responseBytes }
    })
    dependencies.appendSample({
      name: 'conversation_efficiency',
      scope,
      dimensions: {
        ...requestDimensions,
        operation: 'conversation_efficiency_direct'
      },
      measurements: {
        durationMs: requestDurationMs,
        responseBytes,
        renderedBytes,
        actionRoundTrips,
        retries,
        interruptions
      }
    })
    dependencies.appendEvent({
      name: requestEventName(input.disposition),
      scope,
      dimensions: requestDimensions,
      measurements: {
        durationMs: requestDurationMs,
        responseBytes
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
        measurements: { durationMs: factualMeasurement(input.commandDurationMs, 'commandDurationMs') }
      })
      if (input.disposition !== 'rejected') {
        dependencies.appendEvent({
          name: input.disposition === 'success' ? 'command_completed' : 'command_failed',
          scope,
          dimensions: commandDimensions,
          measurements: { durationMs: factualMeasurement(input.commandDurationMs, 'commandDurationMs') }
        })
      }
    }

    return true
  } catch {
    return false
  }
}
