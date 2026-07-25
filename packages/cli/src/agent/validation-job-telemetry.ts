import {
  appendTelemetryEvent,
  appendTelemetrySample,
  type TelemetryDimensions,
  type TelemetryScope
} from './telemetry-store'
import type {
  PersistedValidationCommandKind,
  WorkbenchValidationJobRecord,
  WorkbenchValidationJobStatus
} from './workbench-validation-jobs'

export type TerminalValidationJobStatus = Extract<
  WorkbenchValidationJobStatus,
  'completed' | 'failed' | 'timed_out' | 'cancelled'
>

type ValidationTelemetryDependencies = {
  appendSample: typeof appendTelemetrySample
  appendEvent: typeof appendTelemetryEvent
}

const DEFAULT_DEPENDENCIES: ValidationTelemetryDependencies = {
  appendSample: appendTelemetrySample,
  appendEvent: appendTelemetryEvent
}

function telemetryOutcome(status: TerminalValidationJobStatus): NonNullable<TelemetryDimensions['outcome']> {
  if (status === 'completed') return 'success'
  if (status === 'timed_out') return 'timed_out'
  if (status === 'cancelled') return 'cancelled'
  return 'failure'
}

function reasonCode(status: TerminalValidationJobStatus): string {
  if (status === 'completed') return 'validation_completed'
  if (status === 'timed_out') return 'validation_timed_out'
  if (status === 'cancelled') return 'validation_cancelled'
  return 'validation_failed'
}

function validationKind(commandKind: PersistedValidationCommandKind): string {
  return commandKind
}

function safeScope(record: WorkbenchValidationJobRecord): TelemetryScope {
  return {
    sourceId: record.sourceId,
    runId: record.runId,
    packetId: record.packetId,
    taskId: record.taskId
  }
}

export function recordValidationJobTelemetry(
  record: WorkbenchValidationJobRecord,
  status: TerminalValidationJobStatus,
  durationMs: number,
  dependencies: ValidationTelemetryDependencies = DEFAULT_DEPENDENCIES
): boolean {
  try {
    const dimensions: TelemetryDimensions = {
      component: 'validation',
      operation: 'validation_job',
      outcome: telemetryOutcome(status),
      commandKind: record.command.commandKind,
      validationKind: validationKind(record.command.commandKind),
      reasonCode: reasonCode(status)
    }
    const scope = safeScope(record)
    const boundedDurationMs = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0

    dependencies.appendSample({
      name: 'validation_duration',
      scope,
      dimensions,
      measurements: { durationMs: boundedDurationMs }
    })
    dependencies.appendEvent({
      name: status === 'completed' ? 'validation_completed' : 'validation_failed',
      scope,
      dimensions,
      measurements: { durationMs: boundedDurationMs }
    })
    return true
  } catch {
    return false
  }
}
