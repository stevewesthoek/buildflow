import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { loadTelemetryStore, type TelemetryStore } from './telemetry-store'
import { telemetryToBenchmarkObservation, ActionCaptureOutcomeEvidenceSchema } from './action-round-trip-capture-adapter'
import { ObservableModelConfigurationSchema } from './action-round-trip-benchmark'
import { BenchmarkCaptureSchema, runBenchmarkBaseline } from './action-round-trip-runner'

const Identifier = z.string().min(1).max(160).regex(/^[a-z0-9][a-z0-9._-]*$/)
const RelativeJsonPath = z.string().min(1).max(240).refine(value => {
  if (value.includes('\0') || path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) return false
  const normalized = value.replace(/\\/g, '/').split('/')
  return normalized.every(part => part !== '..' && part !== '') && value.endsWith('.json')
}, 'Expected a safe relative JSON path')

export const CaptureSessionInputSchema = z.object({
  scenarioId: Identifier,
  trialIndex: z.number().int().positive().max(999),
  temperature: z.enum(['cold', 'warmup', 'warm']),
  requestId: z.string().min(1).max(200),
  releaseCommit: z.string().regex(/^[0-9a-f]{40}$/),
  environment: BenchmarkCaptureSchema.shape.environment,
  modelConfiguration: ObservableModelConfigurationSchema,
  outcomeEvidence: ActionCaptureOutcomeEvidenceSchema.omit({ scenarioId: true, trialIndex: true }),
  outputPath: RelativeJsonPath,
  overwrite: z.boolean().default(false)
}).strict()

export type CaptureSessionInput = z.infer<typeof CaptureSessionInputSchema>

function selectExactlyOne(store: TelemetryStore, requestId: string, name: 'conversation_efficiency' | 'request_latency') {
  const matches = store.samples.filter(sample => sample.name === name && sample.scope.requestId === requestId)
  if (matches.length === 0) throw new Error(`Missing ${name} telemetry for requestId: ${requestId}`)
  if (matches.length > 1) throw new Error(`Duplicate ${name} telemetry for requestId: ${requestId}`)
  return matches[0]
}

function expectedPrefix(temperature: CaptureSessionInput['temperature']) {
  return `artifacts/benchmarks/action-round-trip/captures/${temperature}/`
}

export function assembleBenchmarkCaptureSession(options: {
  input: unknown
  corpus: unknown
  rootDir: string
  telemetryStore?: TelemetryStore
  telemetryStorePath?: string
}) {
  const input = CaptureSessionInputSchema.parse(options.input)
  if (!path.isAbsolute(options.rootDir)) throw new Error('Capture rootDir must be absolute')
  const normalized = input.outputPath.replace(/\\/g, '/')
  if (!normalized.startsWith(expectedPrefix(input.temperature))) {
    throw new Error(`Capture outputPath must be under ${expectedPrefix(input.temperature)}`)
  }

  const store = options.telemetryStore ?? loadTelemetryStore({ storePath: options.telemetryStorePath }).store
  const conversationSample = selectExactlyOne(store, input.requestId, 'conversation_efficiency')
  const requestLatencySample = selectExactlyOne(store, input.requestId, 'request_latency')
  const adapted = telemetryToBenchmarkObservation({
    conversationSample,
    requestLatencySample,
    outcomeEvidence: {
      scenarioId: input.scenarioId,
      trialIndex: input.trialIndex,
      ...input.outcomeEvidence
    },
    modelConfiguration: input.modelConfiguration
  })

  const capture = runBenchmarkBaseline({
    corpus: options.corpus,
    selectedScenarioIds: [input.scenarioId],
    observations: [adapted.observation],
    releaseCommit: input.releaseCommit,
    environment: input.environment,
    modelConfiguration: adapted.modelConfiguration
  })
  const serialized = `${JSON.stringify(capture, null, 2)}\n`
  const target = path.resolve(options.rootDir, normalized)
  const relative = path.relative(options.rootDir, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Capture output escaped the repository root')
  if (fs.existsSync(target) && !input.overwrite) throw new Error('Capture output already exists and overwrite is disabled')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, serialized, { encoding: 'utf8', flag: input.overwrite ? 'w' : 'wx' })
  return { capture: BenchmarkCaptureSchema.parse(capture), outputPath: normalized, serialized }
}
