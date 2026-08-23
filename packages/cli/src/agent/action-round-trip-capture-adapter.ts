import { z } from 'zod'
import { TelemetrySampleSchema, type TelemetrySample } from './telemetry-store'
import { BenchmarkObservationSchema, type BenchmarkObservation } from './action-round-trip-runner'
import { ObservableModelConfigurationSchema } from './action-round-trip-benchmark'

const Identifier = z.string().min(1).max(160).regex(/^[a-z0-9][a-z0-9._-]*$/)
const NonNegativeInteger = z.number().int().nonnegative()

export const ActionCaptureOutcomeEvidenceSchema = z.object({
  scenarioId: Identifier,
  trialIndex: z.number().int().positive().max(999),
  taskSuccess: z.boolean(),
  safetyOutcome: BenchmarkObservationSchema.shape.safetyOutcome,
  humanInterventionCount: NonNegativeInteger,
  rollbackResult: BenchmarkObservationSchema.shape.rollbackResult,
  staleStateResult: BenchmarkObservationSchema.shape.staleStateResult
}).strict()

export const ActionCaptureAdapterInputSchema = z.object({
  conversationSample: TelemetrySampleSchema,
  requestLatencySample: TelemetrySampleSchema,
  outcomeEvidence: ActionCaptureOutcomeEvidenceSchema,
  modelConfiguration: ObservableModelConfigurationSchema
}).strict()

export type ActionCaptureAdapterInput = z.infer<typeof ActionCaptureAdapterInputSchema>

function requireMeasurement(sample: TelemetrySample, field: keyof TelemetrySample['measurements']): number {
  const value = sample.measurements[field]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Missing factual telemetry measurement: ${field}`)
  }
  return value
}

export function telemetryToBenchmarkObservation(input: unknown): {
  observation: BenchmarkObservation
  modelConfiguration: z.infer<typeof ObservableModelConfigurationSchema>
} {
  const parsed = ActionCaptureAdapterInputSchema.parse(input)
  const conversation = parsed.conversationSample
  const requestLatency = parsed.requestLatencySample
  if (conversation.name !== 'conversation_efficiency') throw new Error('Expected a conversation_efficiency telemetry sample')
  if (requestLatency.name !== 'request_latency') throw new Error('Expected a request_latency telemetry sample')
  if (conversation.dimensions.reasonCode === 'synthetic_fixture' || requestLatency.dimensions.reasonCode === 'synthetic_fixture') {
    throw new Error('Synthetic telemetry cannot be used as benchmark evidence')
  }
  const conversationRequestId = conversation.scope.requestId
  const latencyRequestId = requestLatency.scope.requestId
  if (!conversationRequestId || !latencyRequestId || conversationRequestId !== latencyRequestId) {
    throw new Error('Factual capture telemetry requires matching requestId scope evidence')
  }

  const actionCount = requireMeasurement(conversation, 'actionRoundTrips')
  const totalElapsedMs = requireMeasurement(conversation, 'durationMs')
  const workbenchServerMs = requireMeasurement(requestLatency, 'durationMs')
  const responseBytes = requireMeasurement(conversation, 'responseBytes')
  const renderedBytes = requireMeasurement(conversation, 'renderedBytes')
  const retries = requireMeasurement(conversation, 'retries')
  const interruptions = requireMeasurement(conversation, 'interruptions')

  if (workbenchServerMs > totalElapsedMs) throw new Error('Workbench server time cannot exceed total elapsed time')

  const observation = BenchmarkObservationSchema.parse({
    scenarioId: parsed.outcomeEvidence.scenarioId,
    trialIndex: parsed.outcomeEvidence.trialIndex,
    taskSuccess: parsed.outcomeEvidence.taskSuccess,
    safetyOutcome: parsed.outcomeEvidence.safetyOutcome,
    actionCount: { value: actionCount, classification: 'measured' },
    totalElapsedMs: { value: totalElapsedMs, classification: 'measured' },
    workbenchServerMs: { value: workbenchServerMs, classification: 'measured' },
    responseBytes: { value: responseBytes, classification: 'measured' },
    renderedBytes: { value: renderedBytes, classification: 'measured' },
    retries: { value: retries, classification: 'measured' },
    interruptions: { value: interruptions, classification: 'measured' },
    humanIntervention: { value: parsed.outcomeEvidence.humanInterventionCount, classification: 'measured' },
    rollbackResult: parsed.outcomeEvidence.rollbackResult,
    staleStateResult: parsed.outcomeEvidence.staleStateResult
  })

  return { observation, modelConfiguration: parsed.modelConfiguration }
}
