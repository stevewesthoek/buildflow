import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { ValidationSelectionV1 } from '@workbench/shared'
import { selectSmallestMeaningfulValidation } from './workbench-validation-selector'
import { runSafeCommand, type SafeCommandRequest, type SafeCommandResult } from './command-runner'
import { createDeterministicWorkbenchChangeDiff, workbenchPacketDigest, type WorkbenchChangePreview } from './workbench-change-preview'
import type { WorkbenchPacket } from './workbench-packets'

export const WORKBENCH_VALIDATION_RECONCILIATION_VERSION = 'r21.4' as const
export const WORKBENCH_VALIDATION_MAX_RECORDS = 100

export type WorkbenchR21_4Terminal = 'VALIDATION_PASSED' | 'VALIDATION_FAILED' | 'VALIDATION_TIMEOUT' | 'VALIDATION_CANCELLED' | 'VALIDATION_EXECUTION_FAILED' | 'RECONCILIATION_REQUIRED' | 'STALE_HEAD' | 'MATERIALIZATION_FAILED'
export type WorkbenchR21_4Binding = Readonly<{
  preview: WorkbenchChangePreview
  packet: WorkbenchPacket
  sourceRoot: string
  worktreePath: string
  worktreeAuthority: Readonly<{ worktreeId: string; path: string; sourceId: string; expectedHead: string; actualHead?: string; packetId: string; runId: string; sessionId: string; leaseOwner: string; exactPaths: readonly string[]; state: 'ready' }>
  capabilities?: readonly string[]
}>
export type WorkbenchValidationReconciliation = Readonly<{
  version: typeof WORKBENCH_VALIDATION_RECONCILIATION_VERSION
  semanticId: string
  validationSubmissionId: string
  validationJobId: string
  terminal: WorkbenchR21_4Terminal | 'MATERIALIZED'
  sourceId: string
  expectedHead: string
  packetId: string
  previewId: string
  executionId: string
  worktreeId: string
  worktreePath: string
  runId: string
  sessionId: string
  leaseOwner: string
  path: string
  originalDigest: string
  replacementDigest: string
  diffDigest: string
  materialization?: { changedPaths: string[]; actualReplacementDigest: string; actualDiffDigest: string; elapsedMs: number }
  selection?: { selectionId: string; selected: ValidationSelectionV1['selected']; reason: string; modelDecisions: number }
  validation?: { results: readonly SafeCommandResult[]; elapsedMs: number; stdoutBytes: number; stderrBytes: number; retries: number; budgetReset: boolean }
  recovery?: { outcome: 'running_recovered_as_unknown' | 'terminal_retrieved' | 'missing_worktree'; detail: string }
  createdAt: string
  updatedAt: string
}>
type Store = { version: 1; records: WorkbenchValidationReconciliation[] }
export type WorkbenchValidationReconciliationOptions = Readonly<{ storePath: string; now?: () => Date; signal?: AbortSignal; runCommand?: (request: SafeCommandRequest) => Promise<SafeCommandResult> }>
export type WorkbenchValidationReconciliationResult = Readonly<{ ok: boolean; record: WorkbenchValidationReconciliation; reused?: boolean }>

function stable(value: unknown): string { if (value === null || typeof value !== 'object') return JSON.stringify(value) as string; if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`; return `{${Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(',')}}` }
function sha(value: string): string { return crypto.createHash('sha256').update(value, 'utf8').digest('hex') }
function timestamp(options: WorkbenchValidationReconciliationOptions): string { return (options.now || (() => new Date()))().toISOString() }
function readStore(options: WorkbenchValidationReconciliationOptions): Store { try { const value = JSON.parse(fs.readFileSync(options.storePath, 'utf8')) as Partial<Store>; return { version: 1, records: Array.isArray(value.records) ? value.records as WorkbenchValidationReconciliation[] : [] } } catch { return { version: 1, records: [] } } }
function writeStore(options: WorkbenchValidationReconciliationOptions, store: Store): void { fs.mkdirSync(path.dirname(options.storePath), { recursive: true, mode: 0o700 }); const temporary = `${options.storePath}.${process.pid}.${crypto.randomUUID()}.tmp`; fs.writeFileSync(temporary, JSON.stringify({ version: 1, records: store.records.slice(-WORKBENCH_VALIDATION_MAX_RECORDS) }), { encoding: 'utf8', mode: 0o600, flag: 'wx' }); try { fs.renameSync(temporary, options.storePath) } finally { try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) } catch {} } }
function git(root: string, args: readonly string[]): string { return execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
function statusPaths(root: string): string[] { const output = execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-C', root, 'status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd(); return output ? output.split('\n').map(line => line.slice(3)).filter(Boolean).sort() : [] }
function mirrorIgnoredDirectory(sourceRoot: string, worktreePath: string, relativePath: string): boolean {
  const source = path.resolve(sourceRoot, relativePath)
  if (!fs.existsSync(source)) return true
  try {
    if (!fs.statSync(source).isDirectory()) return false
    const destination = path.resolve(worktreePath, relativePath)
    if (fs.existsSync(destination)) {
      if (fs.lstatSync(destination).isSymbolicLink()) return path.resolve(fs.realpathSync(destination)) === source
      if (!fs.statSync(destination).isDirectory()) return false
    } else fs.mkdirSync(destination, { recursive: true, mode: 0o700 })
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      const sourceEntry = path.join(source, entry.name)
      const destinationEntry = path.join(destination, entry.name)
      if (fs.existsSync(destinationEntry)) continue
      fs.symlinkSync(sourceEntry, destinationEntry, entry.isDirectory() ? 'dir' : 'file')
    }
    return true
  } catch { return false }
}
function prepareValidationRuntimeProjection(sourceRoot: string, worktreePath: string): boolean {
  return ['node_modules', 'packages/cli/node_modules', 'packages/shared/node_modules', 'packages/mcp/node_modules', 'apps/web/node_modules', 'packages/shared/dist', 'packages/mcp/dist']
    .every(relativePath => mirrorIgnoredDirectory(sourceRoot, worktreePath, relativePath))
}
function semanticId(binding: WorkbenchR21_4Binding, selection: ValidationSelectionV1): string { return `validation-r21-4-${sha(stable({ sourceId: binding.preview.sourceId, expectedHead: binding.preview.expectedHead, packetId: binding.preview.packetId, previewId: binding.preview.previewId, worktreeId: binding.preview.worktreeId, diffDigest: binding.preview.diffDigest, selectorVersion: selection.selectorVersion, selectionId: selection.selectionId })).slice(0, 32)}` }
function commandRequest(binding: WorkbenchR21_4Binding, selection: ValidationSelectionV1['selected'][number]): SafeCommandRequest {
  const command = selection.command
  return { sourceId: binding.preview.sourceId, sourceRoot: binding.worktreePath, timeoutMs: selection.timeoutMs, commandKind: command.commandKind, ...(command.commandKind === 'git_diff_check' || command.commandKind === 'validate_json_files' || command.commandKind === 'security_scan_paths' ? { paths: command.paths } : {}), ...(command.commandKind === 'security_scan_paths' ? { patternSet: command.patternSet } : {}), ...(command.commandKind === 'run_package_script' ? { packageDir: command.packageDir, scriptName: command.scriptName } : {}), ...(command.commandKind === 'run_package_test' ? { packageDir: command.packageDir } : {}), ...(command.commandKind === 'run_package_test_marker' ? { packageDir: command.packageDir, marker: command.marker } : {}), networkAccess: false, persistedValidation: true }
}
function baseRecord(binding: WorkbenchR21_4Binding, selection: ValidationSelectionV1, submissionId: string, terminal: WorkbenchR21_4Terminal | 'MATERIALIZED', options: WorkbenchValidationReconciliationOptions, extra: Partial<WorkbenchValidationReconciliation> = {}): WorkbenchValidationReconciliation { const at = timestamp(options); return { version: WORKBENCH_VALIDATION_RECONCILIATION_VERSION, semanticId: semanticId(binding, selection), validationSubmissionId: submissionId, validationJobId: submissionId, terminal, sourceId: binding.preview.sourceId, expectedHead: binding.preview.expectedHead, packetId: binding.preview.packetId, previewId: binding.preview.previewId, executionId: binding.preview.executionId, worktreeId: binding.preview.worktreeId, worktreePath: binding.worktreePath, runId: binding.preview.runId, sessionId: binding.preview.sessionId, leaseOwner: binding.preview.leaseOwner, path: binding.preview.path, originalDigest: binding.preview.originalDigest, replacementDigest: binding.preview.replacementDigest || '', diffDigest: binding.preview.diffDigest || '', createdAt: at, updatedAt: at, ...extra } }
function persist(record: WorkbenchValidationReconciliation, options: WorkbenchValidationReconciliationOptions): WorkbenchValidationReconciliationResult { const store = readStore(options); const existing = store.records.find(item => item.semanticId === record.semanticId); if (existing) return { ok: existing.terminal === 'VALIDATION_PASSED', record: existing, reused: true }; store.records.push(record); writeStore(options, store); return { ok: record.terminal === 'VALIDATION_PASSED', record } }

export async function materializeAndValidateR21_4(binding: WorkbenchR21_4Binding, options: WorkbenchValidationReconciliationOptions): Promise<WorkbenchValidationReconciliationResult> {
  const selectionResult = selectSmallestMeaningfulValidation({ sourceId: binding.preview.sourceId, runId: binding.preview.runId, packetId: binding.preview.packetId, taskId: binding.packet.taskId, expectedHead: binding.preview.expectedHead, exactPaths: [binding.preview.path], capabilities: [...(binding.capabilities || [])], declaredValidation: binding.packet.validation || [] })
  if (!selectionResult.ok) { const fallback = { selectionId: 'invalid', selectorVersion: 'r19.4', selected: [], skipped: [], modelDecisions: 0 } as unknown as ValidationSelectionV1; return persist(baseRecord(binding, fallback, `validation-submission-${sha(binding.preview.previewId).slice(0, 24)}`, 'MATERIALIZATION_FAILED', options), options) }
  const selection = selectionResult.selection; const submissionId = `validation-submission-${sha(stable({ semantic: semanticId(binding, selection) })).slice(0, 32)}`
  const existing = readStore(options).records.find(item => item.semanticId === semanticId(binding, selection)); if (existing) return { ok: existing.terminal === 'VALIDATION_PASSED', record: existing, reused: true }
  const reject = (terminal: WorkbenchR21_4Terminal, detail: string) => persist(baseRecord(binding, selection, submissionId, terminal, options, { recovery: { outcome: 'missing_worktree', detail } }), options)
  if (binding.preview.terminal !== 'ACCEPTED_PREVIEW' || typeof binding.preview.replacementText !== 'string' || !/^preview-r21-3-[a-f0-9]{32}$/.test(binding.preview.previewId) || path.resolve(binding.preview.sourceRoot) !== path.resolve(binding.sourceRoot) || path.resolve(binding.preview.worktreePath) !== path.resolve(binding.worktreePath) || binding.preview.path !== binding.worktreeAuthority.exactPaths[0] || binding.preview.worktreeId !== binding.worktreeAuthority.worktreeId || path.resolve(binding.worktreePath) !== path.resolve(binding.worktreeAuthority.path) || binding.preview.sourceId !== binding.packet.sourceId || binding.worktreeAuthority.sourceId !== binding.preview.sourceId || binding.preview.packetId !== binding.packet.packetId || binding.worktreeAuthority.packetId !== binding.preview.packetId || binding.preview.runId !== binding.packet.runId || binding.worktreeAuthority.runId !== binding.preview.runId || binding.preview.sessionId !== binding.worktreeAuthority.sessionId || binding.preview.leaseOwner !== binding.worktreeAuthority.leaseOwner || binding.preview.expectedHead !== binding.packet.expectedHead || binding.worktreeAuthority.expectedHead !== binding.preview.expectedHead || binding.preview.packetDigest !== workbenchPacketDigest(binding.packet) || binding.packet.steps.length !== 1 || binding.packet.steps[0]?.type !== 'overwrite' || binding.packet.steps[0]?.path !== binding.preview.path || binding.worktreeAuthority.actualHead !== binding.preview.expectedHead || binding.worktreeAuthority.state !== 'ready') return reject('MATERIALIZATION_FAILED', 'accepted preview, packet, and R21.1 authority do not agree')
  try { if (git(binding.sourceRoot, ['rev-parse', 'HEAD']) !== binding.preview.expectedHead || git(binding.worktreePath, ['rev-parse', 'HEAD']) !== binding.preview.expectedHead) return reject('STALE_HEAD', 'source or isolated worktree HEAD is stale before materialization') } catch { return reject('MATERIALIZATION_FAILED', 'source or isolated worktree is unavailable') }
  if (!prepareValidationRuntimeProjection(binding.sourceRoot, binding.worktreePath)) return reject('MATERIALIZATION_FAILED', 'read-only dependency/build-output projection could not be prepared for isolated validation')
  const target = path.resolve(binding.worktreePath, binding.preview.path); const beforePaths = statusPaths(binding.worktreePath)
  let original: string
  let originalMode = 0
  try { const stat = fs.lstatSync(target); if (!stat.isFile() || stat.isSymbolicLink()) return reject('MATERIALIZATION_FAILED', 'target is not an existing regular file'); originalMode = stat.mode & 0o777; original = fs.readFileSync(target, 'utf8'); if (sha(original) !== binding.preview.originalDigest) return reject('MATERIALIZATION_FAILED', 'isolated worktree target is not pristine at the accepted original digest'); if (beforePaths.length > 0) return reject('MATERIALIZATION_FAILED', 'isolated worktree has unexpected preexisting changes'); fs.writeFileSync(target, binding.preview.replacementText, { encoding: 'utf8', mode: originalMode }); if ((fs.lstatSync(target).mode & 0o777) !== originalMode) return reject('MATERIALIZATION_FAILED', 'materialization changed the target mode') } catch { return reject('MATERIALIZATION_FAILED', 'exact-path materialization failed closed') }
  const materializationStarted = Date.now(); let actualPaths: string[]; let actual: string
  try {
    actual = fs.readFileSync(target, 'utf8'); actualPaths = statusPaths(binding.worktreePath); const actualDiff = createDeterministicWorkbenchChangeDiff(binding.preview.path, original, actual)
    if (actualPaths.length !== 1 || actualPaths[0] !== binding.preview.path || sha(actual) !== binding.preview.replacementDigest || sha(actualDiff.diff) !== binding.preview.diffDigest) return reject('MATERIALIZATION_FAILED', JSON.stringify({ reason: 'post-write identity mismatch', actualPaths, actualReplacementDigest: sha(actual), expectedReplacementDigest: binding.preview.replacementDigest, actualDiffDigest: sha(actualDiff.diff), expectedDiffDigest: binding.preview.diffDigest }))
  } catch { return reject('MATERIALIZATION_FAILED', 'post-write self-check failed') }
  const materialized = baseRecord(binding, selection, submissionId, 'MATERIALIZED', options, { materialization: { changedPaths: actualPaths, actualReplacementDigest: sha(actual), actualDiffDigest: sha(createDeterministicWorkbenchChangeDiff(binding.preview.path, original, actual).diff), elapsedMs: Date.now() - materializationStarted }, selection: { selectionId: selection.selectionId, selected: selection.selected, reason: selection.selected.map(node => node.reason).join(','), modelDecisions: selection.modelDecisions } }); const persisted = persist(materialized, options); if (persisted.reused) return persisted
  const validationStarted = Date.now(); const results: SafeCommandResult[] = []
  const execute = options.runCommand || runSafeCommand
  for (const node of selection.selected) { const request = commandRequest(binding, node); const result = await execute(options.signal ? { ...request, signal: options.signal } : request); results.push({ ...result, stdout: (result.stdout || '').slice(0, 4_000), stderr: (result.stderr || '').slice(0, 4_000) }); if (result.status !== 'completed' || result.exitCode !== 0) break }
  const elapsedMs = Date.now() - validationStarted; const stdoutBytes = results.reduce((sum, result) => sum + Buffer.byteLength(result.stdout || '', 'utf8'), 0); const stderrBytes = results.reduce((sum, result) => sum + Buffer.byteLength(result.stderr || '', 'utf8'), 0); const last = results[results.length - 1]
  const terminal: WorkbenchR21_4Terminal = !last ? 'VALIDATION_EXECUTION_FAILED' : last.status === 'timed_out' ? 'VALIDATION_TIMEOUT' : last.reason === 'cancelled' ? 'VALIDATION_CANCELLED' : last.status === 'completed' && last.exitCode === 0 && results.length === selection.selected.length ? 'VALIDATION_PASSED' : last.status === 'completed' || last.status === 'failed' ? 'VALIDATION_FAILED' : 'VALIDATION_EXECUTION_FAILED'
  const completed = { ...materialized, terminal, updatedAt: timestamp(options), validation: { results, elapsedMs, stdoutBytes, stderrBytes, retries: 0, budgetReset: false } }; const store = readStore(options); const current = store.records.find(item => item.semanticId === materialized.semanticId); if (current && current.terminal !== 'MATERIALIZED') return { ok: current.terminal === 'VALIDATION_PASSED', record: current, reused: true }; const index = store.records.findIndex(item => item.semanticId === materialized.semanticId); if (index >= 0) store.records[index] = completed; else store.records.push(completed); writeStore(options, store); return { ok: terminal === 'VALIDATION_PASSED', record: completed }
}

export function reconcileR21_4(options: WorkbenchValidationReconciliationOptions): WorkbenchValidationReconciliation[] { const store = readStore(options); let changed = false; const reconciled = store.records.map(record => { if (record.terminal !== 'MATERIALIZED') return record; changed = true; return { ...record, terminal: 'RECONCILIATION_REQUIRED' as const, recovery: { outcome: 'running_recovered_as_unknown' as const, detail: 'validation submission was not durably observed after restart; no replay was launched' }, updatedAt: timestamp(options) } }); if (changed) writeStore(options, { version: 1, records: reconciled }); return reconciled }
export function getR21_4Validation(options: WorkbenchValidationReconciliationOptions, semanticIdValue: string): WorkbenchValidationReconciliation | undefined { return readStore(options).records.find(record => record.semanticId === semanticIdValue) }
