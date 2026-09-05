import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { TextDecoder } from 'node:util'
import { evaluateConnectedRepositoryPath, containsProtectedRepositoryContent } from '@workbench/shared'
import { validateWriteTarget } from './safe-access'
import { parseWorkbenchChangeProposal, WORKBENCH_CHANGE_PROPOSAL_MAX_REPLACEMENT_BYTES, WORKBENCH_CHANGE_PROPOSAL_SCHEMA_VERSION, type WorkbenchChangeProposal } from './workbench-change-proposal'
import type { WorkbenchPacket } from './workbench-packets'

export const WORKBENCH_CHANGE_PREVIEW_VERSION = 'r21.3' as const
export const WORKBENCH_CHANGE_PREVIEW_POLICY = 'r21.3-exact-path-diff-preflight-v1' as const
export const WORKBENCH_CHANGE_PREVIEW_MAX_DIFF_BYTES = 16 * 1024
export const WORKBENCH_CHANGE_PREVIEW_MAX_SOURCE_BYTES = 8 * 1024
export const WORKBENCH_CHANGE_PREVIEW_MAX_RECORDS = 100

export type WorkbenchChangePreviewTerminal = 'ACCEPTED_PREVIEW' | 'NO_CHANGE' | 'STALE_HEAD' | 'IDENTITY_MISMATCH' | 'PATH_REJECTED' | 'PROTECTED_PATH' | 'DIGEST_MISMATCH' | 'UNSUPPORTED_OPERATION' | 'CONTENT_REJECTED' | 'OUTPUT_TOO_LARGE' | 'MALFORMED_PROPOSAL' | 'SYMLINK_REJECTED' | 'SUBMODULE_REJECTED' | 'POLICY_REJECTED'

export type WorkbenchR21_2ProposalBinding = Readonly<{
  executionId: string
  packetId: string
  packetDigest: string
  packet: WorkbenchPacket
  sourceId: string
  sourceRoot: string
  expectedHead: string
  worktreeId: string
  worktreePath: string
  worktreeHead: string
  runId: string
  sessionId: string
  leaseOwner: string
  leaseExpiresAt?: string
  exactPaths: readonly string[]
  worktreeAuthority: Readonly<{ worktreeId: string; path: string; sourceId: string; expectedHead: string; actualHead?: string; packetId: string; runId: string; sessionId: string; leaseOwner: string; exactPaths: readonly string[]; state: 'ready' }>
  proposal: WorkbenchChangeProposal
}>

export type WorkbenchChangePreview = Readonly<{
  version: typeof WORKBENCH_CHANGE_PREVIEW_VERSION
  previewId: string
  terminal: WorkbenchChangePreviewTerminal
  sourceId: string
  sourceRoot: string
  expectedHead: string
  packetId: string
  packetDigest: string
  executionId: string
  worktreeId: string
  worktreePath: string
  runId: string
  sessionId: string
  leaseOwner: string
  path: string
  originalDigest: string
  replacementDigest?: string
  replacementText?: string
  diffDigest?: string
  originalBytes: number
  replacementBytes: number
  addedLines: number
  deletedLines: number
  changedPathCount: number
  diff?: string
  policy: { version: typeof WORKBENCH_CHANGE_PREVIEW_POLICY; path: 'PASS' | 'FAIL'; content: 'PASS' | 'FAIL'; structural: 'PASS' | 'FAIL' }
  rejection?: { code: string; message: string }
  createdAt: string
  updatedAt: string
}>

type Store = { version: 1; records: WorkbenchChangePreview[] }
export type WorkbenchChangePreviewStoreOptions = Readonly<{ storePath: string; now?: () => Date }>
export type WorkbenchChangePreviewResult = Readonly<{ ok: boolean; preview: WorkbenchChangePreview; reused?: boolean }>

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) as string
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(',')}}`
}
function sha(value: string): string { return crypto.createHash('sha256').update(value, 'utf8').digest('hex') }
function now(options: WorkbenchChangePreviewStoreOptions): string { return (options.now || (() => new Date()))().toISOString() }
function readStore(options: WorkbenchChangePreviewStoreOptions): Store {
  try { const value = JSON.parse(fs.readFileSync(options.storePath, 'utf8')) as Partial<Store>; return { version: 1, records: Array.isArray(value.records) ? value.records as WorkbenchChangePreview[] : [] } } catch { return { version: 1, records: [] } }
}
function writeStore(options: WorkbenchChangePreviewStoreOptions, store: Store): void {
  fs.mkdirSync(path.dirname(options.storePath), { recursive: true, mode: 0o700 })
  const temporary = `${options.storePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, records: store.records.slice(-WORKBENCH_CHANGE_PREVIEW_MAX_RECORDS) }), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  try { fs.renameSync(temporary, options.storePath) } finally { try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) } catch {} }
}
export function workbenchPacketDigest(packet: WorkbenchPacket): string { return sha(stable(packet)) }
function git(sourceRoot: string, args: readonly string[]): string { return execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-C', sourceRoot, ...args], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
function isContained(root: string, candidate: string): boolean { const relative = path.relative(path.resolve(root), path.resolve(candidate)); return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) }
function safeTarget(root: string, relativePath: string): { target: string } | { code: WorkbenchChangePreviewTerminal; message: string } {
  if (!relativePath || relativePath.includes('\\') || /[\u0000-\u001f\u007f]/.test(relativePath) || relativePath.startsWith('/') || relativePath.startsWith('~') || relativePath.split('/').some(part => !part || part === '.' || part === '..')) return { code: 'PATH_REJECTED', message: 'proposal path is not an exact normalized repository-relative path' }
  const protection = evaluateConnectedRepositoryPath(relativePath)
  if (protection) return { code: protection.code === 'SECRET_PATH_BLOCKED' ? 'PROTECTED_PATH' : 'PATH_REJECTED', message: protection.message }
  const target = path.resolve(root, relativePath)
  if (!isContained(root, target)) return { code: 'PATH_REJECTED', message: 'proposal path escapes the source root' }
  try { const mode = git(root, ['ls-files', '--stage', '--', relativePath]); if (mode.split(/\s+/)[0] === '160000') return { code: 'SUBMODULE_REJECTED', message: 'proposal target is a Git submodule' } } catch {}
  let caseProbe = path.resolve(root)
  for (const segment of relativePath.split('/')) {
    try {
      const entries = fs.readdirSync(caseProbe)
      if (entries.some(entry => entry !== segment && entry.toLowerCase() === segment.toLowerCase())) return { code: 'PATH_REJECTED', message: 'proposal path is case-ambiguous on the local filesystem' }
    } catch { break }
    caseProbe = path.join(caseProbe, segment)
  }
  let probe = target
  while (isContained(root, probe)) {
    try { const stat = fs.lstatSync(probe); if (stat.isSymbolicLink()) return { code: 'SYMLINK_REJECTED', message: 'proposal path crosses a symlink' }; if (probe === target && !stat.isFile()) return { code: 'POLICY_REJECTED', message: 'proposal target is not a regular file' } } catch { break }
    const parent = path.dirname(probe); if (parent === probe) break; probe = parent
  }
  return { target }
}

type DiffResult = { diff: string; added: number; deleted: number }
function deterministicDiff(relativePath: string, original: string, replacement: string): DiffResult {
  const before = original.split('\n'); const after = replacement.split('\n')
  if (before.length && before[before.length - 1] === '') before.pop(); if (after.length && after[after.length - 1] === '') after.pop()
  const lines: string[] = [`--- a/${relativePath}`, `+++ b/${relativePath}`, `@@ -1,${before.length} +1,${after.length} @@`]
  for (const line of before) lines.push(`-${line}`)
  for (const line of after) lines.push(`+${line}`)
  return { diff: `${lines.join('\n')}\n`, added: after.length, deleted: before.length }
}
function makePreview(binding: WorkbenchR21_2ProposalBinding, terminal: WorkbenchChangePreviewTerminal, options: WorkbenchChangePreviewStoreOptions, detail: Partial<WorkbenchChangePreview> = {}): WorkbenchChangePreview {
  const pathValue = binding.exactPaths.length === 1 ? binding.exactPaths[0] : binding.proposal.changes[0]?.path || ''
  const identity = { sourceId: binding.sourceId, expectedHead: binding.expectedHead, packetId: binding.packetId, executionId: binding.executionId, path: pathValue, originalDigest: binding.proposal.changes[0]?.originalDigest || '', proposalDigest: sha(stable(binding.proposal)), replacementDigest: detail.replacementDigest || '', policy: WORKBENCH_CHANGE_PREVIEW_POLICY, diffDigest: detail.diffDigest || '' }
  const previewId = `preview-r21-3-${sha(stable(identity)).slice(0, 32)}`
  const timestamp = now(options)
  return { version: WORKBENCH_CHANGE_PREVIEW_VERSION, previewId, terminal, sourceId: binding.sourceId, sourceRoot: binding.sourceRoot, expectedHead: binding.expectedHead, packetId: binding.packetId, packetDigest: binding.packetDigest, executionId: binding.executionId, worktreeId: binding.worktreeId, worktreePath: binding.worktreePath, runId: binding.runId, sessionId: binding.sessionId, leaseOwner: binding.leaseOwner, path: pathValue, originalDigest: binding.proposal.changes[0]?.originalDigest || '', originalBytes: 0, replacementBytes: 0, addedLines: 0, deletedLines: 0, changedPathCount: terminal === 'ACCEPTED_PREVIEW' ? 1 : 0, policy: { version: WORKBENCH_CHANGE_PREVIEW_POLICY, path: terminal === 'PATH_REJECTED' || terminal === 'PROTECTED_PATH' ? 'FAIL' : 'PASS', content: terminal === 'CONTENT_REJECTED' ? 'FAIL' : 'PASS', structural: terminal === 'UNSUPPORTED_OPERATION' ? 'FAIL' : 'PASS' }, createdAt: timestamp, updatedAt: timestamp, ...detail }
}
function persist(binding: WorkbenchR21_2ProposalBinding, preview: WorkbenchChangePreview, options: WorkbenchChangePreviewStoreOptions): WorkbenchChangePreviewResult {
  const store = readStore(options); const existing = store.records.find(item => item.previewId === preview.previewId)
  if (existing) return { ok: existing.terminal === 'ACCEPTED_PREVIEW' || existing.terminal === 'NO_CHANGE', preview: existing, reused: true }
  store.records.push(preview); writeStore(options, store); return { ok: preview.terminal === 'ACCEPTED_PREVIEW' || preview.terminal === 'NO_CHANGE', preview }
}

export function preflightWorkbenchChangeProposal(binding: WorkbenchR21_2ProposalBinding, options: WorkbenchChangePreviewStoreOptions): WorkbenchChangePreviewResult {
  const reject = (terminal: WorkbenchChangePreviewTerminal, message: string, extra: Partial<WorkbenchChangePreview> = {}) => persist(binding, makePreview(binding, terminal, options, { rejection: { code: terminal, message }, ...extra }), options)
  if (!binding || !binding.packet || binding.sourceId !== binding.packet.sourceId || binding.runId !== binding.packet.runId || binding.packetId !== binding.packet.packetId || binding.expectedHead !== binding.packet.expectedHead || binding.sourceRoot === binding.worktreePath || binding.exactPaths.length !== 1 || binding.exactPaths[0] !== binding.packet.steps[0]?.path || binding.packet.steps.length !== 1 || binding.packet.steps[0]?.type !== 'overwrite' || binding.packetDigest !== workbenchPacketDigest(binding.packet)) return reject('IDENTITY_MISMATCH', 'R21.2 source, packet, run, worktree, or packet digest identity does not match')
  const authority = binding.worktreeAuthority
  if (!authority || authority.state !== 'ready' || authority.worktreeId !== binding.worktreeId || path.resolve(authority.path) !== path.resolve(binding.worktreePath) || authority.sourceId !== binding.sourceId || authority.expectedHead !== binding.expectedHead || authority.actualHead !== binding.expectedHead || authority.packetId !== binding.packetId || authority.runId !== binding.runId || authority.sessionId !== binding.sessionId || authority.leaseOwner !== binding.leaseOwner || authority.exactPaths.length !== 1 || authority.exactPaths[0] !== binding.exactPaths[0]) return reject('IDENTITY_MISMATCH', 'R21.1 worktree, session, lease, or exact-scope authority does not match')
  if (binding.leaseExpiresAt && Date.parse(binding.leaseExpiresAt) <= Date.now()) return reject('IDENTITY_MISMATCH', 'R21.2 lease has expired')
  let currentHead: string
  try { currentHead = git(binding.sourceRoot, ['rev-parse', 'HEAD']) } catch { return reject('IDENTITY_MISMATCH', 'canonical source HEAD could not be read') }
  if (currentHead !== binding.expectedHead || binding.worktreeHead !== binding.expectedHead) return reject('STALE_HEAD', 'canonical source or isolated worktree HEAD differs from the R21.2 expected HEAD')
  try { if (git(binding.worktreePath, ['rev-parse', 'HEAD']) !== binding.expectedHead) return reject('STALE_HEAD', 'isolated worktree HEAD differs from the R21.2 expected HEAD') } catch { return reject('IDENTITY_MISMATCH', 'isolated worktree HEAD could not be read') }
  const admittedPath = binding.exactPaths[0]
  const proposalJson = JSON.stringify(binding.proposal)
  const parsed = parseWorkbenchChangeProposal(proposalJson, admittedPath, binding.proposal.changes[0]?.originalDigest || binding.proposal.changes[0]?.originalDigest || '')
  if (parsed.ok === false) return reject(parsed.code === 'PROPOSAL_UNSAFE' ? 'PATH_REJECTED' : parsed.message.includes('operation is unsupported') ? 'UNSUPPORTED_OPERATION' : 'MALFORMED_PROPOSAL', parsed.message)
  const target = safeTarget(binding.worktreePath, admittedPath); if ('code' in target) return reject(target.code, target.message)
  let original: string
  try { original = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(target.target)) } catch { return reject('POLICY_REJECTED', 'authoritative isolated source file is not supported UTF-8 text') }
  const originalBytes = Buffer.byteLength(original, 'utf8'); if (originalBytes > WORKBENCH_CHANGE_PREVIEW_MAX_SOURCE_BYTES || original.includes('\0')) return reject('OUTPUT_TOO_LARGE', 'authoritative source file is outside the bounded text policy')
  const originalDigest = sha(original); const change = parsed.parsed.proposal.changes[0]
  if (!change) {
    const preview = makePreview(binding, 'NO_CHANGE', options, { originalDigest, originalBytes, path: admittedPath }); return persist(binding, preview, options)
  }
  if (change.originalDigest !== originalDigest) return reject('DIGEST_MISMATCH', 'proposal original digest does not match canonical authoritative source bytes', { originalDigest, originalBytes })
  const replacementBytes = Buffer.byteLength(change.replacementText, 'utf8'); if (replacementBytes > WORKBENCH_CHANGE_PROPOSAL_MAX_REPLACEMENT_BYTES) return reject('OUTPUT_TOO_LARGE', 'replacement exceeds the bounded proposal size', { originalDigest, originalBytes, replacementBytes })
  if (containsProtectedRepositoryContent(change.replacementText)) return reject('CONTENT_REJECTED', 'replacement content matches the canonical protected-content policy', { originalDigest, originalBytes, replacementBytes })
  const writePolicy = validateWriteTarget({ sourceId: binding.sourceId, requestedPath: admittedPath, changeType: 'overwrite', sourceRoot: binding.worktreePath, content: change.replacementText })
  if (writePolicy.ok === false) return reject(writePolicy.error.code === 'SECRET_PATH_BLOCKED' || writePolicy.error.code === 'PROTECTED_PATH' ? 'PROTECTED_PATH' : 'POLICY_REJECTED', writePolicy.error.message, { originalDigest, originalBytes, replacementBytes })
  const replacementDigest = sha(change.replacementText); const diffResult = deterministicDiff(admittedPath, original, change.replacementText); const diffDigest = sha(diffResult.diff)
  if (Buffer.byteLength(diffResult.diff, 'utf8') > WORKBENCH_CHANGE_PREVIEW_MAX_DIFF_BYTES || !diffResult.diff.startsWith(`--- a/${admittedPath}\n+++ b/${admittedPath}\n`) || /^(?:[-+]\+\+\+|diff --git|new file|deleted file|old mode|new mode|Binary files)/m.test(diffResult.diff)) return reject('OUTPUT_TOO_LARGE', 'generated diff is outside the bounded exact-path format', { originalDigest, originalBytes, replacementDigest, replacementBytes, diffDigest })
  try {
    if (git(binding.sourceRoot, ['rev-parse', 'HEAD']) !== binding.expectedHead || git(binding.worktreePath, ['rev-parse', 'HEAD']) !== binding.expectedHead) return reject('STALE_HEAD', 'canonical source or isolated worktree HEAD changed during preflight')
  } catch { return reject('IDENTITY_MISMATCH', 'canonical source or isolated worktree HEAD could not be re-read') }
  const preview = makePreview(binding, 'ACCEPTED_PREVIEW', options, { path: admittedPath, originalDigest, replacementDigest, replacementText: change.replacementText, diffDigest, originalBytes, replacementBytes, addedLines: diffResult.added, deletedLines: diffResult.deleted, diff: diffResult.diff }); return persist(binding, preview, options)
}

export function getWorkbenchChangePreview(previewId: string, options: WorkbenchChangePreviewStoreOptions): WorkbenchChangePreview | undefined { return readStore(options).records.find(item => item.previewId === previewId) }
export function listWorkbenchChangePreviews(options: WorkbenchChangePreviewStoreOptions): WorkbenchChangePreview[] { return readStore(options).records.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }

export function createDeterministicWorkbenchChangeDiff(relativePath: string, original: string, replacement: string): { diff: string; added: number; deleted: number } { return deterministicDiff(relativePath, original, replacement) }
