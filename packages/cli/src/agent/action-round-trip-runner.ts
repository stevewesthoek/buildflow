import { z } from 'zod'
import {
  ACTION_ROUND_TRIP_RESULT_SCHEMA_VERSION,
  BenchmarkResultSchema,
  ObservableModelConfigurationSchema,
  loadBenchmarkCorpus,
  type BenchmarkCorpus,
  type BenchmarkResult
} from './action-round-trip-benchmark'

const Identifier = z.string().min(1).max(160).regex(/^[a-z0-9][a-z0-9._-]*$/)
const MeasurementClass = z.enum(['measured', 'derived', 'estimated'])
const Measurement = z.object({ value: z.number().finite().nonnegative(), classification: MeasurementClass }).strict()

export const BenchmarkObservationSchema = z.object({
  scenarioId: Identifier,
  trialIndex: z.number().int().positive().max(999),
  taskSuccess: z.boolean(),
  safetyOutcome: BenchmarkResultSchema.shape.safetyOutcome,
  actionCount: Measurement,
  totalElapsedMs: Measurement,
  workbenchServerMs: Measurement,
  responseBytes: Measurement,
  renderedBytes: Measurement,
  retries: Measurement,
  interruptions: Measurement,
  humanIntervention: Measurement,
  rollbackResult: BenchmarkResultSchema.shape.rollbackResult,
  staleStateResult: BenchmarkResultSchema.shape.staleStateResult
}).strict()

export const BenchmarkCaptureSchema = z.object({
  captureVersion: z.literal(1),
  corpusVersion: z.literal(1),
  corpusId: Identifier,
  releaseCommit: z.string().regex(/^[0-9a-f]{40}$/),
  environment: BenchmarkResultSchema.shape.environment,
  modelConfiguration: ObservableModelConfigurationSchema,
  results: z.array(BenchmarkResultSchema).min(1)
}).strict()

export type BenchmarkObservation = z.infer<typeof BenchmarkObservationSchema>
export type BenchmarkCapture = z.infer<typeof BenchmarkCaptureSchema>

export type ObservableModelConfiguration = z.infer<typeof ObservableModelConfigurationSchema>

export type BenchmarkRunnerInput = {
  corpus: unknown
  selectedScenarioIds: string[]
  observations: unknown[]
  releaseCommit: string
  environment: BenchmarkResult['environment']
  modelConfiguration: ObservableModelConfiguration
}

function stableTrialId(scenarioId: string, trialIndex: number): string {
  return `${scenarioId}.trial-${String(trialIndex).padStart(3, '0')}`
}

export function runBenchmarkBaseline(input: BenchmarkRunnerInput): BenchmarkCapture {
  const corpus: BenchmarkCorpus = loadBenchmarkCorpus(input.corpus)
  if (input.selectedScenarioIds.length === 0) throw new Error('At least one benchmark scenario must be selected')

  const selected = new Set<string>()
  for (const scenarioId of input.selectedScenarioIds) {
    if (selected.has(scenarioId)) throw new Error(`Duplicate selected benchmark scenario: ${scenarioId}`)
    if (!corpus.scenarios.some(scenario => scenario.id === scenarioId)) throw new Error(`Unknown benchmark scenario: ${scenarioId}`)
    selected.add(scenarioId)
  }

  const observations = input.observations.map(value => BenchmarkObservationSchema.parse(value))
  const observationByKey = new Map<string, BenchmarkObservation>()
  for (const observation of observations) {
    if (!selected.has(observation.scenarioId)) throw new Error(`Observation references unselected scenario: ${observation.scenarioId}`)
    const key = `${observation.scenarioId}:${observation.trialIndex}`
    if (observationByKey.has(key)) throw new Error(`Duplicate benchmark trial: ${key}`)
    observationByKey.set(key, observation)
  }

  const orderedScenarios = corpus.scenarios.filter(scenario => selected.has(scenario.id))
  const results = [...observationByKey.values()]
    .sort((left, right) => {
      const scenarioDelta = orderedScenarios.findIndex(item => item.id === left.scenarioId) - orderedScenarios.findIndex(item => item.id === right.scenarioId)
      return scenarioDelta || left.trialIndex - right.trialIndex
    })
    .map(observation => {
      const residual = Math.max(0, observation.totalElapsedMs.value - observation.workbenchServerMs.value)
      return BenchmarkResultSchema.parse({
        schemaVersion: ACTION_ROUND_TRIP_RESULT_SCHEMA_VERSION,
        corpusVersion: corpus.corpusVersion,
        scenarioId: observation.scenarioId,
        trialId: stableTrialId(observation.scenarioId, observation.trialIndex),
        releaseCommit: input.releaseCommit,
        environment: input.environment,
        modelConfiguration: input.modelConfiguration,
        taskSuccess: observation.taskSuccess,
        safetyOutcome: observation.safetyOutcome,
        actionCount: observation.actionCount,
        totalElapsedMs: observation.totalElapsedMs,
        workbenchServerMs: observation.workbenchServerMs,
        residualModelNetworkClientMs: { value: residual, classification: 'derived', label: 'residual_not_pure_model_time' },
        responseBytes: observation.responseBytes,
        renderedBytes: observation.renderedBytes,
        retries: observation.retries,
        interruptions: observation.interruptions,
        humanIntervention: observation.humanIntervention,
        rollbackResult: observation.rollbackResult,
        staleStateResult: observation.staleStateResult
      })
    })

  if (results.length === 0) throw new Error('No benchmark observations were provided')
  return BenchmarkCaptureSchema.parse({
    captureVersion: 1,
    corpusVersion: corpus.corpusVersion,
    corpusId: corpus.corpusId,
    releaseCommit: input.releaseCommit,
    environment: input.environment,
    modelConfiguration: input.modelConfiguration,
    results
  })
}
