import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { ObservableModelConfigurationSchema } from './action-round-trip-benchmark'
import { createBenchmarkArtifact, writeBenchmarkArtifact } from './action-round-trip-artifact'

const Identifier = z.string().min(1).max(160).regex(/^[a-z0-9][a-z0-9._-]*$/)
const SHA256 = z.string().regex(/^[0-9a-f]{64}$/)
const RelativePath = z.string().min(1).max(240).refine(value => {
  if (value.includes('\0') || value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) return false
  return value.replace(/\\/g, '/').split('/').every(part => part !== '..' && part !== '')
}, 'Expected a safe relative path')
const RelativeJsonPath = RelativePath.refine(value => value.endsWith('.json'), 'Expected a relative JSON path')

export const BenchmarkCaptureProcedureSchema = z.object({
  procedureVersion: z.literal(1),
  procedureId: Identifier,
  corpusId: Identifier,
  corpusVersion: z.literal(1),
  environmentControls: z.object({
    platform: Identifier,
    architecture: Identifier,
    runtime: Identifier,
    sourceCommitRequired: z.boolean(),
    cleanIntendedPathsRequired: z.boolean(),
    networkPolicy: z.enum(['disabled', 'required_for_target_path']),
    concurrency: z.literal(1)
  }).strict(),
  modelConfiguration: ObservableModelConfigurationSchema,
  samplePolicy: z.object({
    coldTrialsPerScenario: z.number().int().positive().max(100),
    warmupTrialsPerScenario: z.number().int().nonnegative().max(100),
    warmTrialsPerScenario: z.number().int().positive().max(100),
    minimumComparableSamplesPerScenario: z.number().int().positive().max(200)
  }).strict(),
  ordering: z.literal('corpus_order_then_temperature_then_trial_index'),
  invocation: z.object({
    command: z.literal('pnpm'),
    args: z.array(z.string().min(1)).min(1).max(12),
    captureInputDirectory: RelativePath,
    artifactOutputDirectory: RelativePath
  }).strict()
}).strict().superRefine((value, context) => {
  const comparable = value.samplePolicy.coldTrialsPerScenario + value.samplePolicy.warmTrialsPerScenario
  if (value.samplePolicy.minimumComparableSamplesPerScenario > comparable) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['samplePolicy', 'minimumComparableSamplesPerScenario'], message: 'Minimum comparable samples exceed planned cold plus warm trials' })
  }
})

export const BenchmarkManifestArtifactSchema = z.object({
  temperature: z.enum(['cold', 'warm']),
  relativePath: RelativeJsonPath,
  artifactSha256: SHA256,
  reportSha256: SHA256,
  sampleCount: z.number().int().positive()
}).strict()

export const BenchmarkBaselineManifestSchema = z.object({
  manifestVersion: z.literal(1),
  status: z.enum(['awaiting_measurements', 'complete']),
  procedure: BenchmarkCaptureProcedureSchema,
  releaseCommit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  artifacts: z.array(BenchmarkManifestArtifactSchema),
  statement: z.literal('No optimization gain is claimed by this manifest.')
}).strict().superRefine((value, context) => {
  if (value.status === 'complete' && (!value.releaseCommit || value.artifacts.length === 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: 'Complete manifests require a release commit and artifact references' })
  }
  if (value.status === 'awaiting_measurements' && (value.releaseCommit !== null || value.artifacts.length !== 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: 'Awaiting-measurements manifests cannot contain measurement claims' })
  }
  const paths = new Set<string>()
  for (const artifact of value.artifacts) {
    if (paths.has(artifact.relativePath)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['artifacts'], message: `Duplicate artifact path: ${artifact.relativePath}` })
    }
    paths.add(artifact.relativePath)
  }
})

export function loadBenchmarkBaselineManifest(input: unknown) {
  const manifest = BenchmarkBaselineManifestSchema.parse(input)
  return structuredClone(manifest)
}

export type BenchmarkCaptureProcedure = z.infer<typeof BenchmarkCaptureProcedureSchema>
export type BenchmarkBaselineManifest = z.infer<typeof BenchmarkBaselineManifestSchema>



export function executeBenchmarkCaptureProcedure(options: {
  pendingManifest: unknown
  coldCaptures: unknown[]
  warmCaptures: unknown[]
  rootDir: string
  manifestOutputPath: string
  overwrite?: boolean
}) {
  const pending = loadBenchmarkBaselineManifest(options.pendingManifest)
  if (pending.status !== 'awaiting_measurements') throw new Error('Procedure execution requires an awaiting-measurements manifest')
  if (!path.isAbsolute(options.rootDir)) throw new Error('Procedure rootDir must be absolute')
  const manifestPath = RelativeJsonPath.parse(options.manifestOutputPath)

  const groups = [
    { temperature: 'cold' as const, captures: options.coldCaptures, required: pending.procedure.samplePolicy.coldTrialsPerScenario },
    { temperature: 'warm' as const, captures: options.warmCaptures, required: pending.procedure.samplePolicy.warmTrialsPerScenario }
  ]
  const artifactRefs = groups.map(group => {
    const artifact = createBenchmarkArtifact(group.captures)
    if (artifact.report.corpusId !== pending.procedure.corpusId || artifact.report.corpusVersion !== pending.procedure.corpusVersion) {
      throw new Error('Capture corpus does not match the procedure')
    }
    if (JSON.stringify(artifact.report.environment) !== JSON.stringify({
      platform: pending.procedure.environmentControls.platform,
      architecture: pending.procedure.environmentControls.architecture,
      runtime: pending.procedure.environmentControls.runtime
    })) throw new Error('Capture environment does not match the procedure')
    if (JSON.stringify(artifact.report.modelConfiguration) !== JSON.stringify(pending.procedure.modelConfiguration)) {
      throw new Error('Capture model configuration does not match the procedure')
    }
    if (artifact.report.scenarios.some(scenario => scenario.sampleCount < group.required)) {
      throw new Error(`${group.temperature} captures do not satisfy the sample-count policy`)
    }
    const relativePath = `${pending.procedure.invocation.artifactOutputDirectory}/${group.temperature}.json`
    const written = writeBenchmarkArtifact(artifact, { rootDir: options.rootDir, outputPath: relativePath, overwrite: options.overwrite })
    return {
      temperature: group.temperature,
      relativePath: written.path,
      artifactSha256: written.artifactSha256,
      reportSha256: written.reportSha256,
      sampleCount: artifact.report.sampleCount,
      releaseCommit: artifact.report.releaseCommit
    }
  })

  if (artifactRefs[0].releaseCommit !== artifactRefs[1].releaseCommit) {
    throw new Error('Cold and warm captures must use the same release commit')
  }
  const manifest = BenchmarkBaselineManifestSchema.parse({
    ...pending,
    status: 'complete',
    releaseCommit: artifactRefs[0].releaseCommit,
    artifacts: artifactRefs.map(({ releaseCommit: _releaseCommit, ...reference }) => reference)
  })
  const target = path.resolve(options.rootDir, manifestPath)
  const relative = path.relative(options.rootDir, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Manifest output escaped the root')
  if (fs.existsSync(target) && !options.overwrite) throw new Error('Baseline manifest already exists and overwrite is disabled')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`
  fs.writeFileSync(target, serialized, { encoding: 'utf8', flag: options.overwrite ? 'w' : 'wx' })
  return { manifest, manifestPath, serialized }
}
