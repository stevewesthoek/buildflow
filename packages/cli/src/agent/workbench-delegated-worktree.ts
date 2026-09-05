import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { getConfigDir } from '../utils/paths'
import { getEnabledSources } from './config'
import { getWorkbenchPacketRecord } from './workbench-packet-store'
import type { WorkbenchPacket } from './workbench-packets'

export const WORKBENCH_DELEGATED_WORKTREE_VERSION = 1 as const
export type DelegatedWorktreeState = 'creating' | 'ready' | 'reconciling' | 'disposing' | 'complete' | 'cancelled' | 'failed' | 'stale' | 'recovery_required'
export type DelegatedWorktreeLease = { owner: string; token: string; expiresAt: string }

export type DelegatedWorktreeEvidence = {
  version: typeof WORKBENCH_DELEGATED_WORKTREE_VERSION
  worktreeId: string
  path: string
  sourceId: string
  sourceRoot: string
  expectedHead: string
  actualHead?: string
  packetId: string
  packetDigest: string
  runId: string
  sessionId: string
  exactPaths: string[]
  scopeDigest: string
  leaseOwner: string
  leaseState: 'active' | 'expired' | 'released'
  state: DelegatedWorktreeState
  createdAt: string
  updatedAt: string
  reconciliation?: string
  cleanup?: 'not_attempted' | 'removed' | 'already_absent' | 'failed'
  errorCode?: string
}

type Store = { version: 1; records: DelegatedWorktreeEvidence[] }
type Result = { ok: true; evidence: DelegatedWorktreeEvidence; reused?: boolean } | { ok: false; code: string; message: string; evidence?: DelegatedWorktreeEvidence }

const storePath = () => path.join(getConfigDir(), 'workbench-delegated-worktrees.json')
const lockPath = () => `${storePath()}.lock`
const SAFE_ID = /^[A-Za-z0-9._:-]{8,160}$/
const HEX_HEAD = /^[0-9a-f]{7,64}$/i

function readStore(): Store {
  try {
    const value = JSON.parse(fs.readFileSync(storePath(), 'utf8')) as Partial<Store>
    return { version: 1, records: Array.isArray(value.records) ? value.records.filter(Boolean) as DelegatedWorktreeEvidence[] : [] }
  } catch { return { version: 1, records: [] } }
}

function writeStore(store: Store): void {
  fs.mkdirSync(path.dirname(storePath()), { recursive: true })
  const temporary = `${storePath()}.tmp-${process.pid}`
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, records: store.records.slice(-500) }), 'utf8')
  fs.renameSync(temporary, storePath())
}

function withStoreLock<T>(callback: (store: Store) => T): T {
  fs.mkdirSync(path.dirname(storePath()), { recursive: true })
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(lockPath(), 'wx')
    const store = readStore()
    const result = callback(store)
    writeStore(store)
    return result
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    if (descriptor !== undefined) { try { fs.unlinkSync(lockPath()) } catch {} }
  }
}

function sha(value: unknown): string { return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex') }
function now(): string { return new Date().toISOString() }
function git(sourceRoot: string, args: string[]): string { return execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-C', sourceRoot, ...args], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
function currentHead(sourceRoot: string): string { return git(sourceRoot, ['rev-parse', 'HEAD']) }
function leaseState(lease: DelegatedWorktreeLease): 'active' | 'expired' { return Date.parse(lease.expiresAt) > Date.now() ? 'active' : 'expired' }

function exactScope(packet: WorkbenchPacket): { paths: string[]; digest: string } | { code: string; message: string } {
  const paths = new Set<string>()
  for (const step of packet.steps || []) {
    for (const candidate of [step.path, step.to]) {
      if (!candidate) continue
      if (typeof candidate !== 'string' || path.isAbsolute(candidate) || candidate.includes('\\') || candidate.split('/').includes('..')) return { code: 'SCOPE_INVALID', message: 'exact packet scope must be relative and traversal-free' }
      const normalized = path.posix.normalize(candidate)
      if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../') || normalized.startsWith('.git/') || normalized === '.git' || /(^|\/)(node_modules|\.env|secrets?|credentials?)(\/|$)/i.test(normalized)) return { code: 'SCOPE_PROTECTED', message: `protected or invalid packet path: ${candidate}` }
      paths.add(normalized)
    }
  }
  const ordered = [...paths]
  return { paths: ordered, digest: sha(ordered) }
}

function identity(packet: WorkbenchPacket, sourceRoot: string, sessionId: string, scopeDigest: string): string {
  return sha({ version: WORKBENCH_DELEGATED_WORKTREE_VERSION, sourceId: packet.sourceId, sourceRoot, expectedHead: packet.expectedHead, packetId: packet.packetId, packetDigest: sha(packet), runId: packet.runId, sessionId, scopeDigest })
}

function validateInputs(packet: WorkbenchPacket, sourceRoot: string, sessionId: string, lease: DelegatedWorktreeLease): Result | { scope: { paths: string[]; digest: string }; worktreeId: string; sourceRoot: string } {
  if (!SAFE_ID.test(packet.packetId) || !SAFE_ID.test(packet.runId) || !SAFE_ID.test(packet.sourceId) || !SAFE_ID.test(sessionId)) return { ok: false, code: 'IDENTITY_INVALID', message: 'packet, source, run, and session identities are invalid' }
  if (!HEX_HEAD.test(packet.expectedHead)) return { ok: false, code: 'EXPECTED_HEAD_INVALID', message: 'expected HEAD is not a commit hash' }
  if (!sourceRoot || !path.isAbsolute(sourceRoot)) return { ok: false, code: 'SOURCE_ROOT_INVALID', message: 'source root must be absolute' }
  if (!lease.owner || !lease.token || !Number.isFinite(Date.parse(lease.expiresAt))) return { ok: false, code: 'LEASE_INVALID', message: 'active packet lease proof is required' }
  const scope = exactScope(packet)
  if ('code' in scope) return { ok: false, ...scope }
  let source: string
  try { source = fs.realpathSync(path.resolve(sourceRoot)); fs.statSync(source) } catch { return { ok: false, code: 'SOURCE_NOT_FOUND', message: 'source root does not exist' } }
  const worktreeId = identity(packet, source, sessionId, scope.digest)
  return { scope, worktreeId, sourceRoot: source }
}

function evidence(packet: WorkbenchPacket, sourceRoot: string, sessionId: string, lease: DelegatedWorktreeLease, scope: { paths: string[]; digest: string }, worktreeId: string, worktreePath: string, state: DelegatedWorktreeState, createdAt: string): DelegatedWorktreeEvidence {
  return { version: 1, worktreeId, path: worktreePath, sourceId: packet.sourceId, sourceRoot, expectedHead: packet.expectedHead, packetId: packet.packetId, packetDigest: sha(packet), runId: packet.runId, sessionId, exactPaths: scope.paths, scopeDigest: scope.digest, leaseOwner: lease.owner, leaseState: leaseState(lease), state, createdAt, updatedAt: createdAt, cleanup: 'not_attempted' }
}

function assertPacketLease(packet: WorkbenchPacket, lease: DelegatedWorktreeLease): Result | undefined {
  const record = getWorkbenchPacketRecord(packet.packetId)
  if (!record || record.packet.sourceId !== packet.sourceId) return { ok: false, code: 'PACKET_IDENTITY_MISMATCH', message: 'packet is not the authoritative packet for this source' }
  if (record.packet.expectedHead !== packet.expectedHead) return { ok: false, code: 'STALE_EXPECTED_HEAD', message: 'packet expected HEAD differs from the authoritative packet HEAD' }
  if (sha(record.packet) !== sha(packet)) return { ok: false, code: 'PACKET_IDENTITY_MISMATCH', message: 'packet content differs from the authoritative packet' }
  if (record.status !== 'running' || record.leaseOwner !== lease.owner || record.leaseToken !== lease.token || record.leaseExpiresAt !== lease.expiresAt) return { ok: false, code: 'LEASE_CONFLICT', message: 'packet lease is not owned by the requested scheduler owner' }
  if (leaseState(lease) !== 'active') return { ok: false, code: 'LEASE_EXPIRED', message: 'packet lease has expired' }
}

/** Scheduler entry point: sourceRoot is resolved from the canonical source registry. */
export function createDelegatedWorkbenchWorktreeForPacket(params: { packet: WorkbenchPacket; sessionId: string; lease: DelegatedWorktreeLease }): Result {
  const source = getEnabledSources({ includeIndexState: false }).find(item => item.id === params.packet.sourceId)
  if (!source) return { ok: false, code: 'SOURCE_NOT_FOUND', message: 'packet source is not an enabled canonical source' }
  return createDelegatedWorkbenchWorktree({ ...params, sourceRoot: source.path })
}

export function createDelegatedWorkbenchWorktree(params: { packet: WorkbenchPacket; sourceRoot: string; sessionId: string; lease: DelegatedWorktreeLease }): Result {
  const leaseError = assertPacketLease(params.packet, params.lease)
  if (leaseError) return leaseError
  const checked = validateInputs(params.packet, params.sourceRoot, params.sessionId, params.lease)
  if ('ok' in checked) return checked
  let actualHead: string
  try { actualHead = currentHead(checked.sourceRoot) } catch { return { ok: false, code: 'GIT_HEAD_UNAVAILABLE', message: 'unable to resolve authoritative source HEAD' } }
  if (actualHead !== params.packet.expectedHead) return { ok: false, code: 'STALE_EXPECTED_HEAD', message: `expected HEAD ${params.packet.expectedHead} but source is ${actualHead}` }
  return withStoreLock(store => {
    const conflict = store.records.find(record => record.packetId === params.packet.packetId && (record.expectedHead !== params.packet.expectedHead || record.sourceId !== params.packet.sourceId))
    if (conflict) return { ok: false, code: 'PACKET_ID_CONFLICT', message: 'packet identity is bound to a different source or expected HEAD' }
    const existing = store.records.find(record => record.worktreeId === checked.worktreeId)
    if (existing) {
      const expectedOwnedPath = path.join(getConfigDir(), 'isolated-worktrees', existing.worktreeId)
      if (existing.sourceRoot !== checked.sourceRoot || existing.path !== expectedOwnedPath) return { ok: false, code: 'WORKTREE_IDENTITY_CONFLICT', message: 'existing worktree record has conflicting ownership metadata', evidence: existing }
      if (!fs.existsSync(existing.path)) return { ok: false, code: 'RECOVERY_REQUIRED', message: 'authoritative worktree record exists but its filesystem path is missing', evidence: { ...existing, state: 'recovery_required', reconciliation: 'missing_worktree' } }
      let head = ''; try { head = git(existing.path, ['rev-parse', 'HEAD']) } catch { return { ok: false, code: 'RECOVERY_REQUIRED', message: 'worktree filesystem cannot resolve HEAD', evidence: { ...existing, state: 'recovery_required' } } }
      if (head !== params.packet.expectedHead) return { ok: false, code: 'WORKTREE_HEAD_MISMATCH', message: 'existing worktree HEAD does not match packet expected HEAD', evidence: { ...existing, actualHead: head, state: 'recovery_required' } }
      return { ok: true, reused: true, evidence: { ...existing, actualHead: head, state: 'ready', updatedAt: now(), reconciliation: 'reused' } }
    }
    const worktreePath = path.join(getConfigDir(), 'isolated-worktrees', checked.worktreeId)
    if (fs.existsSync(worktreePath)) return { ok: false, code: 'WORKTREE_PATH_COLLISION', message: 'derived worktree path already exists without an owned lifecycle record' }
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true })
    const record = evidence(params.packet, checked.sourceRoot, params.sessionId, params.lease, checked.scope, checked.worktreeId, worktreePath, 'creating', now())
    let gitCreated = false
    try {
      git(checked.sourceRoot, ['worktree', 'add', '--detach', worktreePath, params.packet.expectedHead])
      gitCreated = true
      const created = { ...record, state: 'ready' as const, actualHead: git(worktreePath, ['rev-parse', 'HEAD']), updatedAt: now() }
      store.records.push(created)
      return { ok: true, evidence: created }
    } catch (error) {
      let cleanup: DelegatedWorktreeEvidence['cleanup'] = 'not_attempted'
      if (gitCreated) {
        try { git(checked.sourceRoot, ['worktree', 'remove', '--force', worktreePath]); cleanup = 'removed' } catch { cleanup = 'failed' }
      }
      const failed = { ...record, state: 'failed' as const, cleanup, updatedAt: now(), errorCode: 'WORKTREE_CREATE_FAILED' }
      store.records.push(failed)
      return { ok: false, code: 'WORKTREE_CREATE_FAILED', message: error instanceof Error ? error.message : 'Git worktree creation failed', evidence: failed }
    }
  })
}

export function reconcileDelegatedWorkbenchWorktree(params: { worktreeId: string }): Result {
  return withStoreLock(store => {
    const current = store.records.find(record => record.worktreeId === params.worktreeId)
    if (!current) return { ok: false, code: 'WORKTREE_NOT_FOUND', message: 'worktree lifecycle record was not found' }
    if (['complete', 'cancelled'].includes(current.state)) return { ok: true, evidence: current, reused: true }
    try {
      const head = git(current.path, ['rev-parse', 'HEAD'])
      if (head !== current.expectedHead) return { ok: false, code: 'WORKTREE_HEAD_MISMATCH', message: 'worktree HEAD differs from expected HEAD', evidence: { ...current, actualHead: head, state: 'recovery_required', reconciliation: 'head_mismatch' } }
      const updated = { ...current, actualHead: head, state: 'ready' as const, updatedAt: now(), reconciliation: 'verified' }
      store.records[store.records.indexOf(current)] = updated
      return { ok: true, evidence: updated }
    } catch { return { ok: false, code: 'RECOVERY_REQUIRED', message: 'worktree is missing or not a Git worktree', evidence: { ...current, state: 'recovery_required', reconciliation: 'missing_worktree' } } }
  })
}

export function disposeDelegatedWorkbenchWorktree(params: { worktreeId: string; terminalState?: 'complete' | 'cancelled' | 'failed' }): Result {
  return withStoreLock(store => {
    const current = store.records.find(record => record.worktreeId === params.worktreeId)
    if (!current) return { ok: false, code: 'WORKTREE_NOT_FOUND', message: 'worktree lifecycle record was not found' }
    if (current.state === 'complete' || current.state === 'cancelled') return { ok: true, evidence: current, reused: true }
    const index = store.records.indexOf(current)
    const disposing = { ...current, state: 'disposing' as const, updatedAt: now() }
    store.records[index] = disposing
    try {
      if (!fs.existsSync(current.path)) {
        const complete = { ...disposing, state: (params.terminalState || 'complete'), cleanup: 'already_absent' as const, leaseState: 'released' as const, updatedAt: now() }
        store.records[index] = complete
        return { ok: true, evidence: complete }
      }
      git(current.sourceRoot, ['worktree', 'remove', '--force', current.path])
      const complete = { ...disposing, state: (params.terminalState || 'complete'), cleanup: 'removed' as const, leaseState: 'released' as const, updatedAt: now() }
      store.records[index] = complete
      return { ok: true, evidence: complete }
    } catch (error) {
      const failed = { ...disposing, state: 'recovery_required' as const, cleanup: 'failed' as const, updatedAt: now(), errorCode: 'WORKTREE_DISPOSE_FAILED' }
      store.records[index] = failed
      return { ok: false, code: 'WORKTREE_DISPOSE_FAILED', message: error instanceof Error ? error.message : 'Git worktree disposal failed', evidence: failed }
    }
  })
}

export function getDelegatedWorkbenchWorktree(worktreeId: string): DelegatedWorktreeEvidence | undefined { return readStore().records.find(record => record.worktreeId === worktreeId) }
export function listDelegatedWorkbenchWorktrees(): DelegatedWorktreeEvidence[] { return readStore().records.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(record => ({ ...record, exactPaths: [...record.exactPaths] })) }
