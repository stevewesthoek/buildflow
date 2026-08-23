import { z } from 'zod'

export const ACTION_ROUND_TRIP_CORPUS_VERSION = 1 as const
export const ACTION_ROUND_TRIP_RESULT_SCHEMA_VERSION = 1 as const

const Identifier = z.string().min(1).max(160).regex(/^[a-z0-9][a-z0-9._-]*$/)
const NonNegativeInteger = z.number().int().nonnegative()
const MeasurementClass = z.enum(['measured', 'derived', 'estimated'])
const Measurement = z.object({ value: z.number().finite().nonnegative(), classification: MeasurementClass }).strict()

const RuntimeModelIdentifierSource = z.enum(['exposed_by_platform', 'operator_reported', 'unavailable'])

export const ObservableModelConfigurationSchema = z.object({
  provider: Identifier,
  executionSurface: Identifier,
  conversationMode: Identifier,
  configuredDefaultMode: Identifier,
  runtimeModelIdentifier: Identifier.nullable(),
  runtimeModelIdentifierSource: RuntimeModelIdentifierSource
}).strict().superRefine((value, context) => {
  if (value.runtimeModelIdentifierSource === 'unavailable' && value.runtimeModelIdentifier !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['runtimeModelIdentifier'], message: 'runtimeModelIdentifier must be null when source is unavailable' })
  }
  if (value.runtimeModelIdentifierSource !== 'unavailable' && value.runtimeModelIdentifier === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['runtimeModelIdentifier'], message: 'runtimeModelIdentifier is required when source is exposed_by_platform or operator_reported' })
  }
})

export const BenchmarkScenarioSchema = z.object({
  id: Identifier,
  title: z.string().min(1).max(200),
  category: z.enum(['documentation_edit', 'focused_code_change', 'multi_file_change', 'validation_only', 'rollback', 'timeout', 'stale_head', 'confirmation_boundary', 'explicit_failure']),
  expectedOutcome: z.enum(['success', 'failure', 'timeout', 'blocked', 'rolled_back']),
  deterministicSeed: NonNegativeInteger,
  requiresConfirmation: z.boolean(),
  operations: z.array(Identifier).min(1).max(12)
}).strict()

export const BenchmarkCorpusSchema = z.object({
  corpusVersion: z.literal(ACTION_ROUND_TRIP_CORPUS_VERSION),
  corpusId: Identifier,
  executionReadiness: z.enum(['native_ready', 'native_ready_with_adapter_replacement']),
  portability: z.enum(['product_agnostic', 'product_agnostic_with_installation_adapter']),
  scenarios: z.array(BenchmarkScenarioSchema).min(9).max(64)
}).strict()

export const BenchmarkResultSchema = z.object({
  schemaVersion: z.literal(ACTION_ROUND_TRIP_RESULT_SCHEMA_VERSION),
  corpusVersion: z.literal(ACTION_ROUND_TRIP_CORPUS_VERSION),
  scenarioId: Identifier,
  trialId: Identifier,
  releaseCommit: z.string().regex(/^[0-9a-f]{40}$/),
  environment: z.object({ platform: Identifier, architecture: Identifier, runtime: Identifier }).strict(),
  modelConfiguration: ObservableModelConfigurationSchema,
  taskSuccess: z.boolean(),
  safetyOutcome: z.enum(['preserved', 'blocked_as_designed', 'rollback_completed', 'failed_safe', 'violation']),
  actionCount: Measurement,
  totalElapsedMs: Measurement,
  workbenchServerMs: Measurement,
  residualModelNetworkClientMs: Measurement.extend({ label: z.literal('residual_not_pure_model_time') }),
  responseBytes: Measurement,
  renderedBytes: Measurement,
  retries: Measurement,
  interruptions: Measurement,
  humanIntervention: Measurement,
  rollbackResult: z.enum(['not_applicable', 'completed', 'failed', 'not_attempted']),
  staleStateResult: z.enum(['not_applicable', 'detected', 'missed'])
}).strict()

const REQUIRED_CATEGORIES = new Set(BenchmarkScenarioSchema.shape.category.options)

export function loadBenchmarkCorpus(input: unknown) {
  const corpus = BenchmarkCorpusSchema.parse(input)
  const ids = new Set<string>()
  const categories = new Set<string>()
  for (const scenario of corpus.scenarios) {
    if (ids.has(scenario.id)) throw new Error(`Duplicate benchmark scenario id: ${scenario.id}`)
    ids.add(scenario.id)
    categories.add(scenario.category)
  }
  for (const category of REQUIRED_CATEGORIES) {
    if (!categories.has(category)) throw new Error(`Missing required benchmark category: ${category}`)
  }
  return structuredClone(corpus)
}

export type BenchmarkCorpus = z.infer<typeof BenchmarkCorpusSchema>
export type BenchmarkResult = z.infer<typeof BenchmarkResultSchema>
