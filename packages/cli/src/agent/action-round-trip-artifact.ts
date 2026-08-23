import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { BenchmarkReportSchema, aggregateBenchmarkCaptures } from './action-round-trip-report'

const SHA256 = z.string().regex(/^[0-9a-f]{64}$/)
const OWNER_LOCAL_PATH = /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)/
const blockedFragments = ['BEGIN ' + 'PRIVATE KEY', 'BEGIN RSA ' + 'PRIVATE KEY', 'BEGIN OPENSSH ' + 'PRIVATE KEY', 'BEGIN EC ' + 'PRIVATE KEY', 'AK' + 'IA', 'gh' + 'p_', '.env', 'graphify-out/', '.buildflow/']

export const BenchmarkArtifactSchema = z.object({
  artifactVersion: z.literal(1),
  mediaType: z.literal('application/vnd.prochattools.workbench.action-round-trip-baseline+json'),
  reportSha256: SHA256,
  report: BenchmarkReportSchema
}).strict()

export type BenchmarkArtifact = z.infer<typeof BenchmarkArtifactSchema>

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const fields = Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    return `{${fields.join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

export function createBenchmarkArtifact(captures: unknown[]): BenchmarkArtifact {
  const report = aggregateBenchmarkCaptures(captures)
  return BenchmarkArtifactSchema.parse({
    artifactVersion: 1,
    mediaType: 'application/vnd.prochattools.workbench.action-round-trip-baseline+json',
    reportSha256: sha256(canonicalJson(report)),
    report
  })
}

export function serializeBenchmarkArtifact(input: unknown): string {
  const artifact = BenchmarkArtifactSchema.parse(input)
  const expected = sha256(canonicalJson(artifact.report))
  if (artifact.reportSha256 !== expected) throw new Error('Benchmark artifact report checksum mismatch')
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`
  if (OWNER_LOCAL_PATH.test(serialized)) throw new Error('Benchmark artifact contains an owner-local absolute path')
  if (blockedFragments.some(fragment => serialized.includes(fragment))) throw new Error('Benchmark artifact contains restricted or secret-like content')
  return serialized
}

export function verifyBenchmarkArtifact(serialized: string): BenchmarkArtifact {
  const artifact = BenchmarkArtifactSchema.parse(JSON.parse(serialized))
  serializeBenchmarkArtifact(artifact)
  return artifact
}

export function writeBenchmarkArtifact(
  artifact: BenchmarkArtifact,
  options: { rootDir: string; outputPath: string; overwrite?: boolean }
) {
  if (!path.isAbsolute(options.rootDir)) throw new Error('Benchmark artifact rootDir must be absolute')
  if (!options.outputPath || path.isAbsolute(options.outputPath) || options.outputPath.includes('\0')) {
    throw new Error('Benchmark artifact outputPath must be a safe relative path')
  }
  const normalized = path.posix.normalize(options.outputPath.replace(/\\/g, '/'))
  if (normalized === '..' || normalized.startsWith('../') || !normalized.endsWith('.json')) {
    throw new Error('Benchmark artifact outputPath must stay within the root and end with .json')
  }
  const target = path.resolve(options.rootDir, normalized)
  const relative = path.relative(options.rootDir, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Benchmark artifact outputPath escaped the root')
  }
  if (fs.existsSync(target) && !options.overwrite) {
    throw new Error('Benchmark artifact already exists and overwrite is disabled')
  }
  const serialized = serializeBenchmarkArtifact(artifact)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, serialized, { encoding: 'utf8', flag: options.overwrite ? 'w' : 'wx' })
  const bytes = fs.readFileSync(target)
  return {
    path: normalized,
    bytes: bytes.length,
    artifactSha256: sha256(bytes),
    reportSha256: artifact.reportSha256
  }
}
