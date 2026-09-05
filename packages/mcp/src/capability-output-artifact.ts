import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const CAPABILITY_OUTPUT_ROOT_PREFIX = 'workbench-capability-output-'
export const CAPABILITY_ARTIFACT_DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000
export const CAPABILITY_ARTIFACT_MAX_FILES = 100
export const CAPABILITY_ARTIFACT_MAX_BYTES = 16 * 1024 * 1024
export const CAPABILITY_ARTIFACT_MAX_RETRIEVAL_BYTES = 64 * 1024

export type CapabilityArtifactState = 'pending' | 'available' | 'failed' | 'cancelled' | 'expired'

export type CapabilityArtifactMetadata = Readonly<{
  artifactId: string
  artifactRef: string
  state: CapabilityArtifactState
  fileCount: number
  byteSize: number
  createdAt: string
  retainedUntil: string
}>

export type BrokerOwnedOutputRoot = Readonly<{
  root: string
  artifactId: string
}>

export type CapabilityArtifactReadResult = Readonly<{
  relativePath: string
  content: string
  byteLength: number
  truncated: boolean
}>

function prefixOrEqual(parent: string, child: string): boolean {
  return parent === child || child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`)
}

function canonical(value: string): string | undefined {
  try { return fs.realpathSync(value) } catch { return undefined }
}

function safeRelative(value: string): boolean {
  return value.length > 0 && value.length <= 1_024 && !path.isAbsolute(value) && !value.includes('\0') && !value.split(/[\\/]+/).includes('..')
}

function canonicalTempRoot(): string {
  return canonical(os.tmpdir()) ?? path.resolve(os.tmpdir())
}

function isBrokerOwnedRoot(root: string): boolean {
  const resolved = canonical(root)
  const tempRoot = canonicalTempRoot()
  return !!resolved && path.basename(resolved).startsWith(CAPABILITY_OUTPUT_ROOT_PREFIX) && path.dirname(resolved) === tempRoot
}

function protectedAbsoluteRoots(values: readonly string[]): readonly string[] {
  return values.flatMap(value => {
    if (!path.isAbsolute(value)) return []
    const resolved = canonical(value)
    return resolved ? [resolved] : []
  })
}

export function createBrokerOwnedOutputRoot(options: Readonly<{
  sourceRoot?: string
  sourceRoots?: readonly string[]
  protectedRoots?: readonly string[]
}> = {}): BrokerOwnedOutputRoot {
  const tempRoot = canonicalTempRoot()
  const sourceRoots = [options.sourceRoot, ...(options.sourceRoots ?? [])].flatMap(value => value ? [canonical(value)].filter((item): item is string => !!item) : [])
  const protectedRoots = protectedAbsoluteRoots(options.protectedRoots ?? [])
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tempRoot, CAPABILITY_OUTPUT_ROOT_PREFIX), { encoding: 'utf8' }))
  const invalid = sourceRoots.some(source => prefixOrEqual(source, root)) || protectedRoots.some(protectedRoot => prefixOrEqual(protectedRoot, root)) || path.dirname(root) !== tempRoot
  if (invalid) {
    fs.rmSync(root, { recursive: true, force: true })
    throw new Error('Broker-owned output root failed isolation checks.')
  }
  fs.chmodSync(root, 0o700)
  fs.mkdirSync(path.join(root, 'output'), { mode: 0o700 })
  return { root, artifactId: `capability-artifact-${crypto.randomUUID()}` }
}

export function createPendingCapabilityArtifact(jobId: string, artifactId: string, createdAt: string, retentionMs = CAPABILITY_ARTIFACT_DEFAULT_RETENTION_MS): CapabilityArtifactMetadata {
  return {
    artifactId,
    artifactRef: `workbench://capability-jobs/${jobId}/artifact`,
    state: 'pending',
    fileCount: 0,
    byteSize: 0,
    createdAt,
    retainedUntil: new Date(Date.parse(createdAt) + Math.max(1, retentionMs)).toISOString()
  }
}

function listOutputFiles(root: string): { fileCount: number; byteSize: number } | undefined {
  if (!isBrokerOwnedRoot(root)) return undefined
  const visit = (current: string, state: { fileCount: number; byteSize: number }): boolean => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(current, { withFileTypes: true }) } catch { return false }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name)
      let stat: fs.Stats
      try { stat = fs.lstatSync(absolute) } catch { return false }
      if (stat.isSymbolicLink()) return false
      if (stat.isDirectory()) {
        if (!visit(absolute, state)) return false
        continue
      }
      if (!stat.isFile()) return false
      state.fileCount += 1
      state.byteSize += stat.size
      if (state.fileCount > CAPABILITY_ARTIFACT_MAX_FILES || state.byteSize > CAPABILITY_ARTIFACT_MAX_BYTES) return false
    }
    return true
  }
  const state = { fileCount: 0, byteSize: 0 }
  return visit(root, state) ? state : undefined
}

export function finalizeCapabilityArtifact(root: string, pending: CapabilityArtifactMetadata, state: 'available' | 'failed' | 'cancelled'): CapabilityArtifactMetadata {
  if (state !== 'available') {
    cleanupBrokerOwnedOutputRoot(root)
    return { ...pending, state, fileCount: 0, byteSize: 0 }
  }
  const summary = listOutputFiles(root)
  if (!summary) {
    cleanupBrokerOwnedOutputRoot(root)
    return { ...pending, state: 'failed', fileCount: 0, byteSize: 0 }
  }
  return { ...pending, state: 'available', ...summary }
}

export function expireCapabilityArtifact(root: string, artifact: CapabilityArtifactMetadata): CapabilityArtifactMetadata {
  cleanupBrokerOwnedOutputRoot(root)
  return { ...artifact, state: 'expired' }
}

export function cleanupBrokerOwnedOutputRoot(root: string): boolean {
  if (!isBrokerOwnedRoot(root)) return false
  try { fs.rmSync(root, { recursive: true, force: true }); return true } catch { return false }
}

function hasSymlinkComponent(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return true
  let current = root
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component)
    try { if (fs.lstatSync(current).isSymbolicLink()) return true } catch { return true }
  }
  return false
}

export function readBrokerOwnedArtifact(root: string, relativePath: string, maxBytes = CAPABILITY_ARTIFACT_MAX_RETRIEVAL_BYTES): CapabilityArtifactReadResult | undefined {
  if (!isBrokerOwnedRoot(root) || !safeRelative(relativePath) || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > CAPABILITY_ARTIFACT_MAX_RETRIEVAL_BYTES) return undefined
  const rootPath = canonical(root)
  if (!rootPath) return undefined
  const candidate = path.resolve(rootPath, relativePath)
  const resolved = canonical(candidate)
  if (!resolved || !prefixOrEqual(rootPath, resolved) || hasSymlinkComponent(rootPath, candidate)) return undefined
  let stat: fs.Stats
  try { stat = fs.lstatSync(resolved) } catch { return undefined }
  if (!stat.isFile()) return undefined
  try {
    const bytes = fs.readFileSync(resolved)
    return { relativePath: path.relative(rootPath, resolved).split(path.sep).join('/'), content: bytes.subarray(0, maxBytes).toString('utf8'), byteLength: bytes.byteLength, truncated: bytes.byteLength > maxBytes }
  } catch { return undefined }
}
