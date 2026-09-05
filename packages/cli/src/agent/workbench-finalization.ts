import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { consumeApprovedApprovalIntent, getPendingApprovalIntent, type WorkbenchApprovalIntentStoreOptions } from './workbench-approval-intents'
import { validateWriteTarget } from './safe-access'
import { runSafeCommand, type SafeCommandRequest, type SafeCommandResult } from './command-runner'
import { createDeterministicWorkbenchChangeDiff, workbenchPacketDigest, type WorkbenchChangePreview } from './workbench-change-preview'
import type { WorkbenchPacket } from './workbench-packets'
import type { WorkbenchValidationReconciliation } from './workbench-validation-reconciliation'

export const WORKBENCH_FINALIZATION_VERSION = 'r21.5' as const
export const WORKBENCH_FINALIZATION_OPERATION = 'r21.5.finalize' as const
export const WORKBENCH_FINALIZATION_COMMIT_MESSAGE = 'feat(workbench): finalize validated exact-path change' as const
export const WORKBENCH_FINALIZATION_MAX_RECORDS = 100

export type WorkbenchFinalizationTerminal =
  | 'CONFIRMATION_READY'
  | 'FINALIZING'
  | 'APPLIED'
  | 'STAGED'
  | 'COMMITTING'
  | 'FINALIZED'
  | 'REJECTED'
  | 'FINALIZATION_MISMATCH'
  | 'ROLLED_BACK'
  | 'COMMIT_FAILED'
  | 'RECONCILIATION_REQUIRED'

export type WorkbenchR21_5Binding = Readonly<{
  packet: WorkbenchPacket
  preview: WorkbenchChangePreview
  validation: WorkbenchValidationReconciliation
  sourceRoot: string
  worktreePath: string
  worktreeAuthority: Readonly<{
    worktreeId: string
    path: string
    sourceId: string
    expectedHead: string
    actualHead?: string
    packetId: string
    runId: string
    sessionId: string
    leaseOwner: string
    exactPaths: readonly string[]
    state: 'ready'
  }>
  confirmation: Readonly<{ approvalId: string; requestDigest: string }>
}>

export type WorkbenchFinalizationSnapshot = Readonly<{
  head: string
  branch: string
  status: string[]
  stagedPaths: string[]
  trackedDiffDigest: string
  stagedDiffDigest: string
  untrackedPaths: string[]
  targetDigest: string
  targetMode: number
  worktreeRegistryDigest: string
  stashDigest: string
}>

export type WorkbenchFinalizationRecord = Readonly<{
  version: typeof WORKBENCH_FINALIZATION_VERSION
  finalizationId: string
  semanticId: string
  terminal: WorkbenchFinalizationTerminal
  sourceRoot: string
  sourceId: string
  expectedHead: string
  packetId: string
  runId: string
  sessionId: string
  leaseOwner: string
  worktreeId: string
  worktreePath: string
  executionId: string
  previewId: string
  validationId: string
  validationSubmissionId: string
  path: string
  originalDigest: string
  replacementDigest: string
  diffDigest: string
  confirmationId: string
  confirmationDigest: string
  confirmationProjection?: Readonly<{
    source: string
    head: string
    packetId: string
    path: string
    diffDigest: string
    validation: 'VALIDATION_PASSED'
    commitIntent: string
    unrelatedDirtyPaths: string[]
  }>
  mainBefore?: WorkbenchFinalizationSnapshot
  materialization?: Readonly<{ applied: boolean; count: number; elapsedMs: number }>
  staging?: Readonly<{ stagedPaths: string[]; count: number; command: string[] }>
  commit?: Readonly<{ hash: string; parent: string; paths: string[]; message: string }>
  rollback?: Readonly<{ performed: boolean; verified: boolean; detail: string }>
  failure?: Readonly<{ code: string; detail: string }>
  createdAt: string
  updatedAt: string
}>

type Store = { version: 1; records: WorkbenchFinalizationRecord[] }
export type WorkbenchFinalizationOptions = Readonly<{
  storePath: string
  approvalOptions?: WorkbenchApprovalIntentStoreOptions
  now?: () => Date
  runCommand?: (request: SafeCommandRequest) => Promise<SafeCommandResult>
  writeReplacement?: (target: string, replacement: string, mode: number) => void
}>
export type WorkbenchFinalizationResult = Readonly<{ ok: boolean; record: WorkbenchFinalizationRecord; reused?: boolean }>

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) as string
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(',')}}`
}

function sha(value: string): string { return crypto.createHash('sha256').update(value, 'utf8').digest('hex') }
function timestamp(options: WorkbenchFinalizationOptions): string { return (options.now || (() => new Date()))().toISOString() }
function readStore(options: WorkbenchFinalizationOptions): Store {
  try {
    const parsed = JSON.parse(fs.readFileSync(options.storePath, 'utf8')) as Partial<Store>
    return { version: 1, records: Array.isArray(parsed.records) ? parsed.records as WorkbenchFinalizationRecord[] : [] }
  } catch { return { version: 1, records: [] } }
}
function writeStore(options: WorkbenchFinalizationOptions, store: Store): void {
  fs.mkdirSync(path.dirname(options.storePath), { recursive: true, mode: 0o700 })
  const temporary = `${options.storePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, records: store.records.slice(-WORKBENCH_FINALIZATION_MAX_RECORDS) }), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  try { fs.renameSync(temporary, options.storePath) } finally { try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) } catch {} }
}
function git(root: string, args: readonly string[]): string { return execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
function gitRaw(root: string, args: readonly string[]): string { return execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }) }
function statusLines(root: string): string[] { const output = gitRaw(root, ['status', '--porcelain=v1', '--untracked-files=all']).trimEnd(); return output ? output.split('\n').filter(Boolean) : [] }
function stagedPaths(root: string): string[] { const output = gitRaw(root, ['diff', '--cached', '--name-only', '-z']).replace(/\0+$/, ''); return output ? output.split('\0').filter(Boolean).sort() : [] }
function untrackedPaths(status: readonly string[]): string[] { return status.filter(line => line.startsWith('?? ')).map(line => line.slice(3)).sort() }
function targetDigest(root: string, relativePath: string): { digest: string; mode: number } {
  const target = path.resolve(root, relativePath)
  const stat = fs.lstatSync(target)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('finalization target must be an existing regular non-symlink file')
  return { digest: sha(fs.readFileSync(target, 'utf8')), mode: stat.mode & 0o777 }
}
function worktreeRegistryDigest(root: string): string {
  const blocks = gitRaw(root, ['worktree', 'list', '--porcelain']).trim().split(/\n\s*\n/).filter(Boolean)
  const current = fs.realpathSync(root)
  return sha(blocks.filter(block => !block.split('\n')[0]?.startsWith(`worktree ${current}`)).join('\n\n'))
}
function stashDigest(root: string): string { return sha(gitRaw(root, ['stash', 'list', '--format=%H'])) }
function snapshot(root: string, relativePath: string): WorkbenchFinalizationSnapshot {
  const status = statusLines(root)
  const target = targetDigest(root, relativePath)
  return {
    head: git(root, ['rev-parse', 'HEAD']),
    branch: git(root, ['branch', '--show-current']) || 'detached',
    status,
    stagedPaths: stagedPaths(root),
    trackedDiffDigest: sha(gitRaw(root, ['diff', '--binary', '--no-ext-diff'])),
    stagedDiffDigest: sha(gitRaw(root, ['diff', '--cached', '--binary', '--no-ext-diff'])),
    untrackedPaths: untrackedPaths(status),
    targetDigest: target.digest,
    targetMode: target.mode,
    worktreeRegistryDigest: worktreeRegistryDigest(root),
    stashDigest: stashDigest(root)
  }
}
function finalizationId(binding: WorkbenchR21_5Binding): string { return `finalization-r21-5-${sha(buildR21_5FinalizationRequestDigest(binding)).slice(0, 32)}` }
export function buildR21_5FinalizationRequestDigest(binding: WorkbenchR21_5Binding): string {
  return sha(stable({ operation: WORKBENCH_FINALIZATION_OPERATION, sourceId: binding.preview.sourceId, sourceRoot: path.resolve(binding.sourceRoot), expectedHead: binding.preview.expectedHead, packetId: binding.preview.packetId, packetDigest: binding.preview.packetDigest, runId: binding.preview.runId, sessionId: binding.preview.sessionId, leaseOwner: binding.preview.leaseOwner, worktreeId: binding.preview.worktreeId, worktreePath: path.resolve(binding.worktreePath), executionId: binding.preview.executionId, previewId: binding.preview.previewId, validationId: binding.validation.semanticId, validationSubmissionId: binding.validation.validationSubmissionId, path: binding.preview.path, originalDigest: binding.preview.originalDigest, replacementDigest: binding.preview.replacementDigest, diffDigest: binding.preview.diffDigest, commitMessage: WORKBENCH_FINALIZATION_COMMIT_MESSAGE }))
}
function baseRecord(binding: WorkbenchR21_5Binding, terminal: WorkbenchFinalizationTerminal, options: WorkbenchFinalizationOptions, extra: Partial<WorkbenchFinalizationRecord> = {}): WorkbenchFinalizationRecord {
  const at = timestamp(options)
  return {
    version: WORKBENCH_FINALIZATION_VERSION,
    finalizationId: finalizationId(binding),
    semanticId: finalizationId(binding),
    terminal,
    sourceRoot: path.resolve(binding.sourceRoot),
    sourceId: binding.preview.sourceId,
    expectedHead: binding.preview.expectedHead,
    packetId: binding.preview.packetId,
    runId: binding.preview.runId,
    sessionId: binding.preview.sessionId,
    leaseOwner: binding.preview.leaseOwner,
    worktreeId: binding.preview.worktreeId,
    worktreePath: path.resolve(binding.worktreePath),
    executionId: binding.preview.executionId,
    previewId: binding.preview.previewId,
    validationId: binding.validation.semanticId,
    validationSubmissionId: binding.validation.validationSubmissionId,
    path: binding.preview.path,
    originalDigest: binding.preview.originalDigest,
    replacementDigest: binding.preview.replacementDigest || '',
    diffDigest: binding.preview.diffDigest || '',
    confirmationId: binding.confirmation.approvalId,
    confirmationDigest: binding.confirmation.requestDigest,
    createdAt: at,
    updatedAt: at,
    ...extra
  }
}
function persist(record: WorkbenchFinalizationRecord, options: WorkbenchFinalizationOptions): WorkbenchFinalizationResult {
  const store = readStore(options)
  const existing = store.records.find(item => item.finalizationId === record.finalizationId)
  if (existing) return { ok: existing.terminal === 'FINALIZED', record: existing, reused: true }
  store.records.push(record)
  writeStore(options, store)
  return { ok: record.terminal === 'FINALIZED', record }
}
function update(record: WorkbenchFinalizationRecord, options: WorkbenchFinalizationOptions, terminal: WorkbenchFinalizationTerminal, extra: Partial<WorkbenchFinalizationRecord> = {}): WorkbenchFinalizationRecord {
  const store = readStore(options); const index = store.records.findIndex(item => item.finalizationId === record.finalizationId)
  const next = { ...record, ...extra, terminal, updatedAt: timestamp(options) }
  if (index >= 0) store.records[index] = next; else store.records.push(next)
  writeStore(options, store)
  return next
}
function reject(binding: WorkbenchR21_5Binding, options: WorkbenchFinalizationOptions, code: string, detail: string, terminal: WorkbenchFinalizationTerminal = 'REJECTED'): WorkbenchFinalizationResult {
  const record = baseRecord(binding, terminal, options, { failure: { code, detail: detail.slice(0, 1_000) } })
  return persist(record, options)
}
function validateBinding(binding: WorkbenchR21_5Binding): string | undefined {
  const preview = binding.preview; const validation = binding.validation; const authority = binding.worktreeAuthority
  if (preview.terminal !== 'ACCEPTED_PREVIEW') return 'R21.3 preview is not ACCEPTED_PREVIEW'
  if (validation.terminal !== 'VALIDATION_PASSED') return 'R21.4 validation is not VALIDATION_PASSED'
  if (validation.sourceId !== preview.sourceId || validation.expectedHead !== preview.expectedHead || validation.packetId !== preview.packetId || validation.previewId !== preview.previewId || validation.executionId !== preview.executionId || validation.worktreeId !== preview.worktreeId || path.resolve(validation.worktreePath) !== path.resolve(binding.worktreePath) || validation.path !== preview.path || validation.originalDigest !== preview.originalDigest || validation.replacementDigest !== preview.replacementDigest || validation.diffDigest !== preview.diffDigest) return 'R21.4 validation identity does not match the accepted preview'
  if (typeof preview.replacementText !== 'string' || !preview.replacementDigest || !preview.diffDigest) return 'accepted preview does not contain a bounded replacement and diff identity'
  if (!validation.materialization || validation.materialization.changedPaths.length !== 1 || validation.materialization.changedPaths[0] !== preview.path || validation.materialization.actualReplacementDigest !== preview.replacementDigest || validation.materialization.actualDiffDigest !== preview.diffDigest || !validation.validation || validation.validation.retries !== 0 || validation.validation.budgetReset || validation.validation.results.length === 0 || validation.validation.results.some(result => result.status !== 'completed' || result.exitCode !== 0)) return 'R21.4 validation evidence does not prove one successful bounded validation'
  if (path.resolve(preview.sourceRoot) !== path.resolve(binding.sourceRoot) || path.resolve(preview.worktreePath) !== path.resolve(binding.worktreePath) || authority.state !== 'ready' || authority.worktreeId !== preview.worktreeId || path.resolve(authority.path) !== path.resolve(binding.worktreePath) || authority.actualHead !== preview.expectedHead || authority.sourceId !== preview.sourceId || authority.expectedHead !== preview.expectedHead || authority.packetId !== preview.packetId || authority.runId !== preview.runId || authority.sessionId !== preview.sessionId || authority.leaseOwner !== preview.leaseOwner || authority.exactPaths.length !== 1 || authority.exactPaths[0] !== preview.path) return 'R21.1 worktree authority does not match the accepted identity'
  if (binding.packet.sourceId !== preview.sourceId || binding.packet.packetId !== preview.packetId || binding.packet.runId !== preview.runId || binding.packet.expectedHead !== preview.expectedHead || workbenchPacketDigest(binding.packet) !== preview.packetDigest || binding.packet.steps.length !== 1 || binding.packet.steps[0]?.type !== 'overwrite' || binding.packet.steps[0]?.path !== preview.path) return 'packet identity does not match the accepted preview'
  const write = validateWriteTarget({ sourceId: preview.sourceId, sourceRoot: binding.sourceRoot, requestedPath: preview.path, changeType: 'overwrite' })
  if (!write.ok) return 'finalization target is blocked by the write policy'
  try {
    if (git(binding.worktreePath, ['rev-parse', 'HEAD']) !== preview.expectedHead) return 'validated isolated worktree HEAD is stale'
    const worktreeStatus = statusLines(binding.worktreePath).map(line => line.slice(3)).filter(Boolean)
    const worktreeContent = fs.readFileSync(path.resolve(binding.worktreePath, preview.path), 'utf8')
    const worktreeOriginal = gitRaw(binding.worktreePath, ['show', `${preview.expectedHead}:${preview.path}`])
    const worktreeDiff = createDeterministicWorkbenchChangeDiff(preview.path, worktreeOriginal, worktreeContent)
    if (worktreeStatus.length !== 1 || worktreeStatus[0] !== preview.path || sha(worktreeContent) !== preview.replacementDigest || sha(worktreeDiff.diff) !== preview.diffDigest) return 'validated isolated worktree content or status no longer matches the accepted result'
  } catch { return 'validated isolated worktree could not be re-read safely' }
  const expectedDigest = buildR21_5FinalizationRequestDigest(binding)
  if (binding.confirmation.requestDigest !== expectedDigest) return 'confirmation digest does not bind the exact finalization request'
  return undefined
}
function exactMainDiff(root: string, binding: WorkbenchR21_5Binding, original: string, replacement: string): boolean {
  const target = binding.preview.path
  const changed = gitRaw(root, ['diff', '--name-only', '--', target]).trim().split('\n').filter(Boolean)
  const deterministic = createDeterministicWorkbenchChangeDiff(target, original, replacement)
  return changed.length === 1 && changed[0] === target && sha(deterministic.diff) === binding.preview.diffDigest
}
function currentCommit(root: string): { hash: string; parent: string; paths: string[]; message: string } | undefined {
  try {
    const hash = git(root, ['rev-parse', 'HEAD']); const parent = git(root, ['rev-parse', 'HEAD^']); const paths = gitRaw(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', hash]).trim().split('\n').filter(Boolean).sort(); const message = git(root, ['show', '-s', '--format=%s', hash])
    return { hash, parent, paths, message }
  } catch { return undefined }
}
function resetExact(root: string, relativePath: string): void { execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-C', root, 'reset', '--quiet', '--', relativePath], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }) }
function rollback(root: string, binding: WorkbenchR21_5Binding, before: WorkbenchFinalizationSnapshot, original: string, replacementDigest: string): { verified: boolean; detail: string } {
  try {
    if (git(root, ['rev-parse', 'HEAD']) !== before.head) return { verified: false, detail: 'HEAD changed; rollback stopped without overwriting unknown state' }
    const current = targetDigest(root, binding.preview.path)
    if (current.digest === replacementDigest) {
      if (stagedPaths(root).includes(binding.preview.path)) resetExact(root, binding.preview.path)
      fs.writeFileSync(path.resolve(root, binding.preview.path), original, { encoding: 'utf8', mode: before.targetMode })
    }
    const after = snapshot(root, binding.preview.path)
    return { verified: stable(after) === stable(before), detail: stable(after) === stable(before) ? 'owned exact-path effects restored' : 'rollback left an unexpected repository state' }
  } catch (error) { return { verified: false, detail: error instanceof Error ? error.message : 'rollback failed' } }
}
function commandRequest(binding: WorkbenchR21_5Binding, commandKind: 'git_add_paths' | 'git_commit'): SafeCommandRequest {
  return { commandKind, sourceId: binding.preview.sourceId, sourceRoot: binding.sourceRoot, paths: [binding.preview.path], ...(commandKind === 'git_commit' ? { message: WORKBENCH_FINALIZATION_COMMIT_MESSAGE } : {}), networkAccess: false, confirmedByUser: true }
}

export async function finalizeR21_5(binding: WorkbenchR21_5Binding, options: WorkbenchFinalizationOptions): Promise<WorkbenchFinalizationResult> {
  const id = finalizationId(binding); const existing = readStore(options).records.find(item => item.finalizationId === id)
  if (existing?.terminal === 'FINALIZED') return { ok: true, record: existing, reused: true }
  if (existing?.terminal === 'RECONCILIATION_REQUIRED' || existing?.terminal === 'COMMIT_FAILED' || existing?.terminal === 'FINALIZATION_MISMATCH' || existing?.terminal === 'ROLLED_BACK' || existing?.terminal === 'REJECTED') return { ok: false, record: existing, reused: true }
  if (existing?.terminal === 'CONFIRMATION_READY' || existing?.terminal === 'FINALIZING' || existing?.terminal === 'COMMITTING') return { ok: false, record: update(existing, options, 'RECONCILIATION_REQUIRED', { failure: { code: 'RESTART_REQUIRES_RECONCILIATION', detail: 'a non-terminal finalization record exists; no apply, stage, commit, or replay was launched' } }), reused: true }
  const invalid = validateBinding(binding); if (invalid) return reject(binding, options, 'IDENTITY_MISMATCH', invalid)
  let before: WorkbenchFinalizationSnapshot
  try { before = snapshot(binding.sourceRoot, binding.preview.path) } catch { return reject(binding, options, 'SOURCE_UNAVAILABLE', 'main source snapshot could not be captured') }
  if (before.head !== binding.preview.expectedHead) return reject(binding, options, 'STALE_HEAD', 'main HEAD changed before finalization')
  if (before.targetDigest !== binding.preview.originalDigest) return reject(binding, options, 'TARGET_MISMATCH', 'main target does not match the accepted original digest')
  if (before.stagedPaths.length > 0) return reject(binding, options, 'UNRELATED_STAGED_WORK', 'pre-existing staged work is preserved and finalization stops closed')
  const approval = getPendingApprovalIntent(binding.confirmation.approvalId, options.approvalOptions)
  const approvalValid = Boolean(approval && !('ok' in approval) && approval.status === 'approved' && approval.sourceId === binding.preview.sourceId && approval.runId === binding.preview.runId && approval.sessionId === binding.preview.sessionId && approval.operationKind === WORKBENCH_FINALIZATION_OPERATION && approval.requestDigest === binding.confirmation.requestDigest)
  if (!approvalValid) return reject(binding, options, 'CONFIRMATION_INVALID', 'the exact R21.5 confirmation is not approved and bound')
  const projection = { source: binding.sourceRoot, head: before.head, packetId: binding.preview.packetId, path: binding.preview.path, diffDigest: binding.preview.diffDigest || '', validation: 'VALIDATION_PASSED' as const, commitIntent: WORKBENCH_FINALIZATION_COMMIT_MESSAGE, unrelatedDirtyPaths: before.status.map(line => line.slice(3)).filter(item => item !== binding.preview.path) }
  let record = persist(baseRecord(binding, 'CONFIRMATION_READY', options, { mainBefore: before, confirmationProjection: projection }), options).record
  const consumed = consumeApprovedApprovalIntent({ sourceId: binding.preview.sourceId, runId: binding.preview.runId, sessionId: binding.preview.sessionId, operationKind: WORKBENCH_FINALIZATION_OPERATION, requestDigest: binding.confirmation.requestDigest, options: options.approvalOptions })
  if (!consumed.ok || !consumed.consumed) return { ok: false, record: update(record, options, 'REJECTED', { failure: { code: 'CONFIRMATION_NOT_CONSUMED', detail: 'the one exact R21.5 confirmation could not be consumed' } }) }
  record = update(record, options, 'FINALIZING')
  const target = path.resolve(binding.sourceRoot, binding.preview.path); const original = fs.readFileSync(target, 'utf8'); const started = Date.now();
  try {
    ;(options.writeReplacement || ((file, text, mode) => fs.writeFileSync(file, text, { encoding: 'utf8', mode })))(target, binding.preview.replacementText, before.targetMode)
    const afterApply = targetDigest(binding.sourceRoot, binding.preview.path)
    if (afterApply.digest !== binding.preview.replacementDigest || afterApply.mode !== before.targetMode || !exactMainDiff(binding.sourceRoot, binding, original, binding.preview.replacementText)) throw new Error('post-apply exact path or diff identity mismatch')
    record = update(record, options, 'APPLIED', { materialization: { applied: true, count: 1, elapsedMs: Date.now() - started } })
  } catch (error) {
    const restored = rollback(binding.sourceRoot, binding, before, original, binding.preview.replacementDigest || '')
    return { ok: false, record: update(record, options, restored.verified ? 'ROLLED_BACK' : 'FINALIZATION_MISMATCH', { rollback: { performed: true, verified: restored.verified, detail: restored.detail }, failure: { code: 'APPLY_FAILED', detail: error instanceof Error ? error.message : 'apply failed' } }) }
  }
  if (git(binding.sourceRoot, ['rev-parse', 'HEAD']) !== before.head) { const restored = rollback(binding.sourceRoot, binding, before, original, binding.preview.replacementDigest || ''); return { ok: false, record: update(record, options, restored.verified ? 'ROLLED_BACK' : 'FINALIZATION_MISMATCH', { rollback: { performed: true, verified: restored.verified, detail: restored.detail }, failure: { code: 'STALE_HEAD', detail: 'HEAD changed before staging' } }) } }
  const execute = options.runCommand || runSafeCommand
  const staged = await execute(commandRequest(binding, 'git_add_paths'))
  const currentStaged = stagedPaths(binding.sourceRoot)
  if (staged.status !== 'completed' || currentStaged.length !== 1 || currentStaged[0] !== binding.preview.path) {
    const restored = rollback(binding.sourceRoot, binding, before, original, binding.preview.replacementDigest || '')
    return { ok: false, record: update(record, options, restored.verified ? 'ROLLED_BACK' : 'FINALIZATION_MISMATCH', { rollback: { performed: true, verified: restored.verified, detail: restored.detail }, failure: { code: 'STAGE_FAILED', detail: staged.reason || staged.stderr || 'exact-path staging failed' } }) }
  }
  record = update(record, options, 'STAGED', { staging: { stagedPaths: currentStaged, count: 1, command: staged.command } })
  if (git(binding.sourceRoot, ['rev-parse', 'HEAD']) !== before.head) { const restored = rollback(binding.sourceRoot, binding, before, original, binding.preview.replacementDigest || ''); return { ok: false, record: update(record, options, restored.verified ? 'ROLLED_BACK' : 'FINALIZATION_MISMATCH', { rollback: { performed: true, verified: restored.verified, detail: restored.detail }, failure: { code: 'STALE_HEAD', detail: 'HEAD changed before commit' } }) } }
  record = update(record, options, 'COMMITTING')
  const committed = await execute(commandRequest(binding, 'git_commit'))
  if (committed.status !== 'completed') {
    const restored = rollback(binding.sourceRoot, binding, before, original, binding.preview.replacementDigest || '')
    return { ok: false, record: update(record, options, restored.verified ? 'ROLLED_BACK' : 'COMMIT_FAILED', { rollback: { performed: true, verified: restored.verified, detail: restored.detail }, failure: { code: 'COMMIT_FAILED', detail: committed.reason || committed.stderr || 'commit failed' } }) }
  }
  const commit = currentCommit(binding.sourceRoot)
  let committedText = ''
  try { committedText = fs.readFileSync(target, 'utf8') } catch {}
  const committedDiff = committedText ? createDeterministicWorkbenchChangeDiff(binding.preview.path, original, committedText) : undefined
  if (!commit || commit.parent !== before.head || commit.paths.length !== 1 || commit.paths[0] !== binding.preview.path || commit.message !== WORKBENCH_FINALIZATION_COMMIT_MESSAGE || sha(committedText) !== binding.preview.replacementDigest || !committedDiff || sha(committedDiff.diff) !== binding.preview.diffDigest) return { ok: false, record: update(record, options, 'RECONCILIATION_REQUIRED', { failure: { code: 'COMMIT_IDENTITY_UNKNOWN', detail: 'commit command completed but exact commit identity could not be proven' } }) }
  const afterCommit = snapshot(binding.sourceRoot, binding.preview.path)
  const postCommitMismatch = { targetStatus: afterCommit.status.filter(line => line.includes(binding.preview.path)), branch: afterCommit.branch, stagedPaths: afterCommit.stagedPaths, untrackedPaths: afterCommit.untrackedPaths, worktreeRegistryChanged: afterCommit.worktreeRegistryDigest !== before.worktreeRegistryDigest, stashesChanged: afterCommit.stashDigest !== before.stashDigest }
  if (postCommitMismatch.targetStatus.length > 0 || postCommitMismatch.branch !== before.branch || postCommitMismatch.stagedPaths.length > 0 || postCommitMismatch.untrackedPaths.join('\n') !== before.untrackedPaths.join('\n') || postCommitMismatch.worktreeRegistryChanged || postCommitMismatch.stashesChanged) return { ok: false, record: update(record, options, 'RECONCILIATION_REQUIRED', { commit, failure: { code: 'POST_COMMIT_DIRTY_STATE', detail: JSON.stringify(postCommitMismatch) } }) }
  return { ok: true, record: update(record, options, 'FINALIZED', { commit }) }
}

export function reconcileR21_5(options: WorkbenchFinalizationOptions, finalizationIdValue: string): WorkbenchFinalizationRecord | undefined {
  const record = readStore(options).records.find(item => item.finalizationId === finalizationIdValue)
  if (!record || record.terminal === 'FINALIZED' || record.terminal === 'REJECTED' || record.terminal === 'ROLLED_BACK') return record
  try {
    const commit = currentCommit(record.sourceRoot)
    if (commit && commit.parent === record.expectedHead && commit.paths.length === 1 && commit.paths[0] === record.path && commit.message === WORKBENCH_FINALIZATION_COMMIT_MESSAGE) return update(record, options, 'FINALIZED', { commit })
  } catch {}
  return update(record, options, 'RECONCILIATION_REQUIRED', { failure: { code: 'RECOVERY_REQUIRED', detail: 'finalization was not durably observed as a proven commit; no replay was launched' } })
}
export function getR21_5Finalization(options: WorkbenchFinalizationOptions, finalizationIdValue: string): WorkbenchFinalizationRecord | undefined { return readStore(options).records.find(item => item.finalizationId === finalizationIdValue) }
