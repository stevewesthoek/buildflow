import { z } from 'zod'
import { BenchmarkResultSchema, ObservableModelConfigurationSchema } from './action-round-trip-benchmark'
import { BenchmarkCaptureSchema, type BenchmarkCapture } from './action-round-trip-runner'

const MeasurementClass = z.enum(['measured', 'derived', 'estimated'])
const SummaryMetricSchema = z.object({
  p50: z.number().finite().nonnegative(),
  p95: z.number().finite().nonnegative(),
  sampleCount: z.number().int().positive(),
  classification: MeasurementClass
}).strict()

const OutcomeCountsSchema = z.object({
  success: z.number().int().nonnegative(),
  failure: z.number().int().nonnegative(),
  timeout: z.number().int().nonnegative(),
  rollback: z.number().int().nonnegative(),
  staleHead: z.number().int().nonnegative(),
  confirmation: z.number().int().nonnegative()
}).strict()

export const ScenarioBenchmarkSummarySchema = z.object({
  scenarioId: BenchmarkResultSchema.shape.scenarioId,
  sampleCount: z.number().int().positive(),
  totalElapsedMs: SummaryMetricSchema,
  workbenchServerMs: SummaryMetricSchema,
  residualModelNetworkClientMs: SummaryMetricSchema.extend({ label: z.literal('residual_not_pure_model_time') }),
  actionCount: SummaryMetricSchema,
  responseBytes: SummaryMetricSchema,
  renderedBytes: SummaryMetricSchema,
  outcomes: OutcomeCountsSchema
}).strict()

export const BenchmarkReportSchema = z.object({
  reportVersion: z.literal(1),
  corpusVersion: z.literal(1),
  corpusId: z.string().min(1),
  releaseCommit: BenchmarkResultSchema.shape.releaseCommit,
  environment: BenchmarkResultSchema.shape.environment,
  modelConfiguration: ObservableModelConfigurationSchema,
  sampleCount: z.number().int().positive(),
  overall: ScenarioBenchmarkSummarySchema.omit({ scenarioId: true }),
  scenarios: z.array(ScenarioBenchmarkSummarySchema).min(1)
}).strict()

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) throw new Error('Cannot calculate percentile for empty values')
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.ceil((percentileValue / 100) * sorted.length) - 1
  return sorted[Math.max(0, index)]
}

function metric(values: number[], classification: 'measured' | 'derived' | 'estimated') {
  return { p50: percentile(values, 50), p95: percentile(values, 95), sampleCount: values.length, classification }
}

function outcomeCounts(results: BenchmarkCapture['results']) {
  return {
    success: results.filter(result => result.taskSuccess).length,
    failure: results.filter(result => !result.taskSuccess).length,
    timeout: results.filter(result => result.scenarioId === 'bounded-timeout').length,
    rollback: results.filter(result => result.rollbackResult === 'completed').length,
    staleHead: results.filter(result => result.staleStateResult === 'detected').length,
    confirmation: results.filter(result => result.scenarioId === 'confirmation-boundary').length
  }
}

function summarize(results: BenchmarkCapture['results'], scenarioId?: string) {
  const summary = {
    sampleCount: results.length,
    totalElapsedMs: metric(results.map(result => result.totalElapsedMs.value), 'measured'),
    workbenchServerMs: metric(results.map(result => result.workbenchServerMs.value), 'measured'),
    residualModelNetworkClientMs: {
      ...metric(results.map(result => result.residualModelNetworkClientMs.value), 'derived'),
      label: 'residual_not_pure_model_time' as const
    },
    actionCount: metric(results.map(result => result.actionCount.value), 'measured'),
    responseBytes: metric(results.map(result => result.responseBytes.value), 'measured'),
    renderedBytes: metric(results.map(result => result.renderedBytes.value), 'measured'),
    outcomes: outcomeCounts(results)
  }
  return scenarioId ? { scenarioId, ...summary } : summary
}

export function aggregateBenchmarkCaptures(inputs: unknown[]) {
  if (inputs.length === 0) throw new Error('At least one benchmark capture is required')
  const captures = inputs.map(input => BenchmarkCaptureSchema.parse(input))
  const first = captures[0]
  for (const capture of captures.slice(1)) {
    if (capture.releaseCommit !== first.releaseCommit) throw new Error('Mixed release commits are not comparable')
    if (JSON.stringify(capture.environment) !== JSON.stringify(first.environment)) throw new Error('Mixed environments are not comparable')
    if (capture.modelConfiguration.executionSurface !== first.modelConfiguration.executionSurface) throw new Error('Mixed execution surfaces are not comparable')
    if (capture.modelConfiguration.conversationMode !== first.modelConfiguration.conversationMode) throw new Error('Mixed conversation modes are not comparable')
    if (capture.modelConfiguration.configuredDefaultMode !== first.modelConfiguration.configuredDefaultMode) throw new Error('Mixed configured defaults are not comparable')
    if (JSON.stringify(capture.modelConfiguration) !== JSON.stringify(first.modelConfiguration)) throw new Error('Mixed model configurations are not comparable')
    if (capture.corpusId !== first.corpusId || capture.corpusVersion !== first.corpusVersion) throw new Error('Mixed corpora are not comparable')
  }

  const seen = new Set<string>()
  const results = captures.flatMap(capture => capture.results)
  for (const result of results) {
    const key = `${result.scenarioId}:${result.trialId}`
    if (seen.has(key)) throw new Error(`Duplicate benchmark trial: ${key}`)
    seen.add(key)
  }
  if (results.length === 0) throw new Error('Benchmark captures contain no samples')

  const scenarioIds = [...new Set(results.map(result => result.scenarioId))].sort()
  return BenchmarkReportSchema.parse({
    reportVersion: 1,
    corpusVersion: first.corpusVersion,
    corpusId: first.corpusId,
    releaseCommit: first.releaseCommit,
    environment: first.environment,
    modelConfiguration: first.modelConfiguration,
    sampleCount: results.length,
    overall: summarize(results),
    scenarios: scenarioIds.map(id => summarize(results.filter(result => result.scenarioId === id), id))
  })
}

export type BenchmarkReport = z.infer<typeof BenchmarkReportSchema>
