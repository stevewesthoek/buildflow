import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { WorkbenchPacket } from './workbench-packets'
import type { DelegatedWorktreeEvidence, DelegatedWorktreeLease } from './workbench-delegated-worktree'
import { getConfigDir } from '../utils/paths'

export const WORKBENCH_EXECUTION_CAPSULE_VERSION = 'r21.2-gitless-capsule-v1' as const
const MAX_CAPSULE_BYTES = 16 * 1024
const MAX_FILE_BYTES = 8 * 1024
const MAX_CAPSULE_ENTRIES = 512

export type ExecutionCapsuleSnapshotEntry = Readonly<{
  path: string
  kind: 'file' | 'directory' | 'symlink'
  bytes: number
  mode: number
  sha256?: string
  digestTruncated?: boolean
}>

export type ExecutionCapsuleSnapshot = Readonly<{
  entries: readonly ExecutionCapsuleSnapshotEntry[]
  totalBytes: number
  digest: string
  truncated: boolean
}>

export type ExecutionCapsuleEvidence = Readonly<{
  version: typeof WORKBENCH_EXECUTION_CAPSULE_VERSION
  capsuleId: string
  capsulePath: string
  workspacePath: string
  sourceId: string
  sourceRoot: string
  expectedHead: string
  verifiedWorktreeHead: string
  packetId: string
  packetDigest: string
  runId: string
  sessionId: string
  leaseOwner: string
  worktreeId: string
  worktreePath: string
  exactPaths: readonly string[]
  scopeDigest: string
  policy: Readonly<{
    git: 'denied'
    projectMcp: 'denied'
    credentials: 'denied'
    ownerHome: 'denied_except_provider_auth'
    arbitraryNetwork: 'denied'
  }>
  pristine: ExecutionCapsuleSnapshot
  postExecution?: ExecutionCapsuleSnapshot
  changedPaths?: readonly string[]
  createdPaths?: readonly string[]
  deletedPaths?: readonly string[]
  outputUntrusted: true
}>

export type ExecutionCapsule = Readonly<{
  evidence: ExecutionCapsuleEvidence
  root: string
  workspacePath: string
  home: string
  temp: string
  schema: string
}>

type Result = { ok: true; capsule: ExecutionCapsule } | { ok: false; code: string; message: string }

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(',')}}`
}

function sha(value: unknown): string { return crypto.createHash('sha256').update(stable(value), 'utf8').digest('hex') }
function shaFilePrefix(filePath: string, maxBytes: number): { digest: string; truncated: boolean } {
  const hash = crypto.createHash('sha256')
  const descriptor = fs.openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(16 * 1024)
  let total = 0
  try {
    while (total < maxBytes) {
      const count = fs.readSync(descriptor, buffer, 0, Math.min(buffer.byteLength, maxBytes - total), total)
      if (count === 0) break
      hash.update(buffer.subarray(0, count))
      total += count
    }
  } finally { fs.closeSync(descriptor) }
  return { digest: hash.digest('hex'), truncated: total < fs.statSync(filePath).size }
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function normalizedRelative(value: string): string | undefined {
  if (!value || path.isAbsolute(value) || value.includes('\\') || value.includes('\0')) return undefined
  const normalized = path.posix.normalize(value)
  if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) return undefined
  return normalized
}

function snapshotWorkspace(workspacePath: string): ExecutionCapsuleSnapshot {
  const entries: ExecutionCapsuleSnapshotEntry[] = []
  let totalBytes = 0
  let truncated = false
  const visit = (current: string, relativeParent: string): void => {
    for (const item of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entries.length >= MAX_CAPSULE_ENTRIES) { truncated = true; return }
      const absolute = path.join(current, item.name)
      const relative = relativeParent ? `${relativeParent}/${item.name}` : item.name
      const stat = fs.lstatSync(absolute)
      if (stat.isDirectory()) {
        entries.push({ path: relative, kind: 'directory', bytes: 0, mode: stat.mode & 0o777 })
        visit(absolute, relative)
      }
      else if (stat.isSymbolicLink()) entries.push({ path: relative, kind: 'symlink', bytes: 0, mode: stat.mode & 0o777 })
      else if (stat.isFile()) {
        const bounded = shaFilePrefix(absolute, MAX_CAPSULE_BYTES)
        totalBytes = Math.min(MAX_CAPSULE_BYTES + 1, totalBytes + stat.size)
        entries.push({ path: relative, kind: 'file', bytes: stat.size, mode: stat.mode & 0o777, sha256: bounded.digest, ...(bounded.truncated ? { digestTruncated: true } : {}) })
      }
      else entries.push({ path: relative, kind: 'symlink', bytes: 0, mode: stat.mode & 0o777 })
    }
  }
  visit(workspacePath, '')
  return { entries, totalBytes, digest: sha({ entries, truncated }), truncated }
}

function safeCapsuleRoot(capsuleId: string): { root: string; parent: string } {
  const parent = path.join(getConfigDir(), 'isolated-capsules')
  const root = path.join(parent, capsuleId)
  if (path.dirname(root) !== parent || !root.startsWith(`${parent}${path.sep}`)) throw new Error('capsule path escaped the broker-owned capsule root')
  return { root, parent }
}

function packetDigest(packet: WorkbenchPacket): string { return sha(packet) }

function worktreeHead(worktreePath: string): string {
  return execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-C', worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function removeOwnedRoot(root: string): void {
  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* bounded cleanup is best effort */ }
}

export function createWorkbenchExecutionCapsule(params: { packet: WorkbenchPacket; worktree: DelegatedWorktreeEvidence; lease: DelegatedWorktreeLease; executionId: string }): Result {
  const worktreePath = fs.realpathSync(params.worktree.path)
  const sourceRoot = fs.realpathSync(params.worktree.sourceRoot)
  if (worktreePath === sourceRoot) return { ok: false, code: 'CAPSULE_SOURCE_ANCHOR_INVALID', message: 'R21.1 worktree cannot be the source checkout' }
  if (params.worktree.actualHead !== params.packet.expectedHead) return { ok: false, code: 'CAPSULE_STALE_WORKTREE', message: 'R21.1 worktree HEAD does not match the packet expected HEAD' }
  let verifiedWorktreeHead: string
  try { verifiedWorktreeHead = worktreeHead(worktreePath) } catch { return { ok: false, code: 'CAPSULE_WORKTREE_HEAD_UNAVAILABLE', message: 'R21.1 worktree HEAD could not be verified' } }
  if (verifiedWorktreeHead !== params.packet.expectedHead) return { ok: false, code: 'CAPSULE_STALE_WORKTREE', message: 'verified R21.1 worktree HEAD does not match the packet expected HEAD' }
  const exactPaths = [...params.worktree.exactPaths].map(normalizedRelative)
  if (exactPaths.some(value => !value) || exactPaths.length === 0) return { ok: false, code: 'CAPSULE_SCOPE_INVALID', message: 'capsule requires at least one exact relative admitted path' }
  const paths = exactPaths as string[]
  const capsuleId = `capsule-r21-2-${sha({ version: WORKBENCH_EXECUTION_CAPSULE_VERSION, executionId: params.executionId, sourceId: params.packet.sourceId, expectedHead: params.packet.expectedHead, packetId: params.packet.packetId, runId: params.packet.runId, sessionId: params.worktree.sessionId, scopeDigest: params.worktree.scopeDigest }).slice(0, 32)}`
  const { root, parent } = safeCapsuleRoot(capsuleId)
  if (path.resolve(root) === path.resolve(sourceRoot) || path.resolve(root) === path.resolve(worktreePath) || !path.resolve(root).startsWith(`${path.resolve(parent)}${path.sep}`)) return { ok: false, code: 'CAPSULE_PATH_INVALID', message: 'capsule is not outside the source and R21.1 worktree' }
  if (fs.existsSync(root)) return { ok: false, code: 'CAPSULE_PATH_COLLISION', message: 'derived capsule path already exists' }
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 })
    const canonicalRoot = fs.realpathSync(root)
    const workspacePath = path.join(canonicalRoot, 'workspace')
    const home = path.join(canonicalRoot, 'home')
    const temp = path.join(canonicalRoot, 'tmp')
    const schema = path.join(canonicalRoot, 'schema.json')
    fs.mkdirSync(workspacePath, { recursive: true, mode: 0o700 })
    fs.mkdirSync(home, { recursive: true, mode: 0o700 })
    fs.mkdirSync(temp, { recursive: true, mode: 0o700 })
    fs.writeFileSync(schema, '{}\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    for (const relative of paths) {
      const sourceFile = path.resolve(worktreePath, relative)
      if (!contained(worktreePath, sourceFile)) throw new Error(`admitted path escaped the R21.1 worktree: ${relative}`)
      const stat = fs.lstatSync(sourceFile)
      const real = fs.realpathSync(sourceFile)
      if (stat.isSymbolicLink() || !stat.isFile() || !contained(worktreePath, real) || path.relative(worktreePath, real).split(path.sep).join('/') !== relative) throw new Error(`admitted path is not an exact regular file: ${relative}`)
      if (stat.size > MAX_FILE_BYTES) throw new Error(`admitted file exceeds capsule input budget: ${relative}`)
      const destination = path.resolve(workspacePath, relative)
      if (!contained(workspacePath, destination)) throw new Error(`capsule destination escaped workspace: ${relative}`)
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
      fs.copyFileSync(real, destination, fs.constants.COPYFILE_EXCL)
      fs.chmodSync(destination, 0o600)
    }
    const pristine = snapshotWorkspace(workspacePath)
    if (pristine.truncated || pristine.totalBytes > MAX_CAPSULE_BYTES || pristine.entries.some(entry => entry.path === '.git' || entry.path.startsWith('.git/'))) throw new Error('capsule baseline exceeded bounded scope or contains forbidden Git metadata')
    const evidence: ExecutionCapsuleEvidence = {
      version: WORKBENCH_EXECUTION_CAPSULE_VERSION, capsuleId, capsulePath: canonicalRoot, workspacePath, sourceId: params.packet.sourceId, sourceRoot,
      expectedHead: params.packet.expectedHead, verifiedWorktreeHead, packetId: params.packet.packetId, packetDigest: packetDigest(params.packet), runId: params.packet.runId,
      sessionId: params.worktree.sessionId, leaseOwner: params.lease.owner, worktreeId: params.worktree.worktreeId, worktreePath, exactPaths: paths,
      scopeDigest: params.worktree.scopeDigest, policy: { git: 'denied', projectMcp: 'denied', credentials: 'denied', ownerHome: 'denied_except_provider_auth', arbitraryNetwork: 'denied' }, pristine, outputUntrusted: true
    }
    return { ok: true, capsule: { evidence, root: canonicalRoot, workspacePath, home, temp, schema } }
  }
  catch (error) {
    removeOwnedRoot(root)
    return { ok: false, code: 'CAPSULE_CREATE_FAILED', message: error instanceof Error ? error.message : 'execution capsule could not be created' }
  }
}

export function captureWorkbenchExecutionCapsuleResult(capsule: ExecutionCapsule): ExecutionCapsuleEvidence {
  const postExecution = snapshotWorkspace(capsule.workspacePath)
  const before = new Map(capsule.evidence.pristine.entries.map(entry => [entry.path, entry]))
  const after = new Map(postExecution.entries.map(entry => [entry.path, entry]))
  const changed: string[] = []
  const created: string[] = []
  const deleted: string[] = []
  for (const [entryPath, entry] of after) {
    const previous = before.get(entryPath)
    if (!previous) created.push(entryPath)
    else if (stable(previous) !== stable(entry)) changed.push(entryPath)
  }
  for (const entryPath of before.keys()) if (!after.has(entryPath)) deleted.push(entryPath)
  return { ...capsule.evidence, postExecution, changedPaths: [...new Set([...changed, ...created, ...deleted])].sort(), createdPaths: created.sort(), deletedPaths: deleted.sort() }
}

export function executionCapsuleHasNoGit(capsule: ExecutionCapsule): boolean {
  return !capsule.evidence.pristine.entries.some(entry => entry.path === '.git' || entry.path.startsWith('.git/'))
}

export function disposeWorkbenchExecutionCapsule(capsule: ExecutionCapsule): void {
  const expectedParent = path.join(getConfigDir(), 'isolated-capsules')
  const canonicalParent = fs.realpathSync(expectedParent)
  const canonicalRoot = fs.realpathSync(capsule.root)
  if (path.dirname(canonicalRoot) !== canonicalParent) throw new Error('refusing to dispose capsule outside broker-owned capsule root')
  const stat = fs.lstatSync(capsule.root)
  if (stat.isSymbolicLink() || canonicalRoot !== path.resolve(capsule.root)) throw new Error('refusing to dispose a non-canonical capsule root')
  removeOwnedRoot(canonicalRoot)
}

export function getExecutionCapsuleConfigRoot(): string { return path.join(getConfigDir(), 'isolated-capsules') }

export function isCapsulePathOutsideRepositories(capsulePath: string, sourceRoot: string, worktreePath: string): boolean {
  const candidate = path.resolve(capsulePath)
  return candidate !== path.resolve(sourceRoot) && candidate !== path.resolve(worktreePath) && !contained(path.resolve(sourceRoot), candidate) && !contained(path.resolve(worktreePath), candidate)
}

export function capsuleRootUsesExpectedTempParent(capsulePath: string): boolean {
  const parent = fs.realpathSync(path.dirname(capsulePath))
  const expected = fs.realpathSync(getExecutionCapsuleConfigRoot())
  return parent === expected && parent !== fs.realpathSync(os.tmpdir())
}
