import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getConfigDir } from '../utils/paths'
import { getWorkbenchPacketRecord, type WorkbenchPacketRecord } from './workbench-packet-store'
import type { WorkbenchPacket } from './workbench-packets'
import { createCodexReadOnlyReviewRequest, admitCodexReadOnlyReview, CODEX_REVIEW_NO_MUTATION_AUTHORITY, type CodexReviewAdmissionInput } from './codex-review-contract'
import { CODEX_REVIEW_BUDGET_RUNTIME_MAXIMUM, createCodexReviewExecutionBudget, type CodexReviewBudgetLimits, type CodexReviewExecutionBudget } from './codex-review-budget'
import { runCodexReviewWithTrustedTransport, type CodexReviewTransportResult } from './codex-review-transport'
import { buildWorkbenchChangeProposalSchema, parseWorkbenchChangeProposal, serializeWorkbenchChangeProposalSchema, WORKBENCH_CHANGE_PROPOSAL_SCHEMA_VERSION, type ParsedWorkbenchChangeProposal } from './workbench-change-proposal'
import { inspectCodexStrictSchema, validateCodexSchemaInstance } from './codex-strict-schema'
import { listDelegatedWorkbenchWorktrees, type DelegatedWorktreeEvidence, type DelegatedWorktreeLease } from './workbench-delegated-worktree'

export const CODEX_DELEGATED_EXECUTOR_VERSION = 'r21.2' as const
export const CODEX_DELEGATED_EXECUTOR_CAPABILITY = 'codex-read-only-change-proposal' as const
export const CODEX_DELEGATED_EXECUTION_STORE_VERSION = 1 as const
export const CODEX_DELEGATED_SECURITY_POLICY = Object.freeze({
  mainCheckout: 'denied', unrelatedWorktree: 'denied', ownerHome: 'denied_except_provider_auth', projectMcp: 'denied', recursiveMcp: 'denied', credentialsForwarded: false,
  git: 'denied_by_r20_read_only_transport', directGitWorktreeExecution: 'denied', gitHooks: 'denied', capsule: 'broker_owned_exact_read_only_projection', submoduleUpdate: 'denied', arbitraryExecutable: 'denied_by_r20_fixed_transport', modelControlledNetwork: 'denied_by_r20_native_permission_profile', diffImport: 'denied', commit: 'denied', push: 'denied'
} as const)
export const CODEX_DELEGATED_EXECUTION_BUDGET: CodexReviewBudgetLimits = Object.freeze({ ...CODEX_REVIEW_BUDGET_RUNTIME_MAXIMUM, maxPromptBytes: 8 * 1024, maxInputFiles: 1, maxInputBytes: 8 * 1024, maxInputFileBytes: 8 * 1024, maxContextBytes: 8 * 1024, maxStdoutBytes: 16 * 1024, maxStderrBytes: 16 * 1024, maxResponseBytes: 16 * 1024, maxArtifactBytes: 16 * 1024, maxWallClockMs: 10_000, maxUsageUnits: 50_000 })
export const CODEX_DELEGATED_EXECUTION_PROFILE = 'r21.2-read-only-change-proposal' as const
export const CODEX_DELEGATED_EXECUTION_POLICY = 'r21.2-codex-read-only-change-proposal-v1' as const
export const CODEX_DELEGATED_EXECUTION_PATH = 'packages/cli/src/agent/fixtures/action-round-trip-focused-code-change.ts' as const

export type DelegatedCodexTerminalState = 'SUCCESS' | 'DENIED' | 'TIMEOUT' | 'CANCELLED' | 'OUTPUT_BUDGET_EXCEEDED' | 'COST_BUDGET_EXCEEDED' | 'RUNTIME_UNAVAILABLE' | 'EXECUTION_FAILED'
export type DelegatedCodexProposalEvidence = Readonly<{ schemaVersion: typeof WORKBENCH_CHANGE_PROPOSAL_SCHEMA_VERSION; path: string; originalDigest: string; replacementDigest?: string; replacementBytes: number; replacementText?: string; summary: string; validation: 'PASS' }>
export type DelegatedCodexTransportEvidence = Readonly<{ contractVersion: string; invocationMode: string; invocationArgs: readonly string[]; projectionRoot: string; workingDirectory: string; network: string; networkRestriction: string; providerAuthentication: string; credentialForwarded: boolean; requestSchemaSha256?: string; requestPromptSha256?: string; requestPromptBytes?: number }>
export type DelegatedCodexExecutionRecord = {
  version: typeof CODEX_DELEGATED_EXECUTION_STORE_VERSION; executionId: string; packetId: string; packetDigest: string; sourceId: string; sourceRoot: string; expectedHead: string; worktreeId: string; worktreePath: string; worktreeHead: string; runId: string; sessionId: string; exactPaths: string[]; originalDigest: string; scopeDigest: string; leaseOwner: string; capability: typeof CODEX_DELEGATED_EXECUTOR_CAPABILITY; profile: typeof CODEX_DELEGATED_EXECUTION_PROFILE; budgetIdentity: string; budgetDigest: string; status: 'running' | 'terminal'; terminalState?: DelegatedCodexTerminalState; launched: boolean; replayAllowed: false; createdAt: string; updatedAt: string; terminalAt?: string; processGroupId?: number; exitCode?: number | null; signal?: NodeJS.Signals | null; timedOut?: boolean; cancelled?: boolean; elapsedMs?: number; providerModelCalls: number; providerDispatchState: 'not_dispatched' | 'dispatched'; retries: 0; output: { stdoutBytes: number; stderrBytes: number; responseBytes: number; truncated: boolean; stdoutPreview?: string; stderrPreview?: string }; providerRequestId?: string; transport?: DelegatedCodexTransportEvidence; proposal?: DelegatedCodexProposalEvidence; proposalRejection?: { code: string; message: string }; changedPaths: string[]; changedPathSummary: 'proposal_only'; usageUnits: 'unavailable' | number; errorCode?: string
}

type Store = { version: typeof CODEX_DELEGATED_EXECUTION_STORE_VERSION; records: DelegatedCodexExecutionRecord[] }
type Result = { ok: true; record: DelegatedCodexExecutionRecord; reused?: boolean } | { ok: false; code: string; message: string; record?: DelegatedCodexExecutionRecord }
export type DelegatedCodexExecutionPlan = Readonly<{ packet: WorkbenchPacket; packetRecord: WorkbenchPacketRecord; worktree: DelegatedWorktreeEvidence; lease: DelegatedWorktreeLease; budget: CodexReviewExecutionBudget; executionId: string; prompt: string; worktreePath: string; sourceRoot: string; projectedSourceRoot: string; exactPath: typeof CODEX_DELEGATED_EXECUTION_PATH; originalDigest: string; originalBytes: number; approvalStorePath: string }>

const executionStorePath = () => path.join(getConfigDir(), 'workbench-delegated-executions.json')
const executionLockPath = () => `${executionStorePath()}.lock`
const activeControllers = new Map<string, AbortController>()
function stable(value: unknown): string { if (value === null || typeof value !== 'object') return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`; return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(',')}}` }
function sha(value: unknown): string { return crypto.createHash('sha256').update(stable(value), 'utf8').digest('hex') }
function textSha(value: string): string { return crypto.createHash('sha256').update(value, 'utf8').digest('hex') }
function now(): string { return new Date().toISOString() }
function preview(value: string): string { return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 2_000) }
function readStore(): Store { try { const parsed = JSON.parse(fs.readFileSync(executionStorePath(), 'utf8')) as Partial<Store>; return { version: 1, records: Array.isArray(parsed.records) ? parsed.records as DelegatedCodexExecutionRecord[] : [] } } catch { return { version: 1, records: [] } } }
function writeStore(store: Store): void { fs.mkdirSync(path.dirname(executionStorePath()), { recursive: true, mode: 0o700 }); const temporary = `${executionStorePath()}.${process.pid}.${crypto.randomUUID()}.tmp`; fs.writeFileSync(temporary, JSON.stringify({ version: 1, records: store.records.slice(-300) }), { encoding: 'utf8', mode: 0o600, flag: 'wx' }); try { fs.renameSync(temporary, executionStorePath()) } finally { try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) } catch {} } }
function withStore<T>(callback: (store: Store) => T): T { fs.mkdirSync(path.dirname(executionStorePath()), { recursive: true, mode: 0o700 }); let descriptor: number | undefined; try { descriptor = fs.openSync(executionLockPath(), 'wx', 0o600); const store = readStore(); const result = callback(store); writeStore(store); return result } finally { if (descriptor !== undefined) fs.closeSync(descriptor); if (descriptor !== undefined) { try { fs.unlinkSync(executionLockPath()) } catch {} } } }
function executionIdFor(worktreeId: string): string { return `exec-r21-2-${worktreeId.slice(0, 32)}` }
function delegatedBudgetValid(budget: CodexReviewExecutionBudget): boolean { if (budget.profileId !== CODEX_DELEGATED_EXECUTION_PROFILE || budget.policyIdentity !== CODEX_DELEGATED_EXECUTION_POLICY || budget.effective.maxModelRequests !== 1) return false; return Object.entries(CODEX_DELEGATED_EXECUTION_BUDGET).every(([key, maximum]) => budget.effective[key as keyof CodexReviewBudgetLimits] <= maximum) }
function exactFile(worktreePath: string): { content: string; digest: string; bytes: number } | Result {
  const target = path.resolve(worktreePath, CODEX_DELEGATED_EXECUTION_PATH)
  try { const stat = fs.lstatSync(target); if (!stat.isFile() || stat.isSymbolicLink()) return { ok: false, code: 'SOURCE_FILE_INVALID', message: 'the admitted proposal target must be a regular non-symlink file' }; const realWorktree = fs.realpathSync(worktreePath); const realTarget = fs.realpathSync(target); if (!realTarget.startsWith(`${realWorktree}${path.sep}`)) return { ok: false, code: 'SYMLINK_ESCAPE', message: 'the admitted proposal target escapes the R21.1 worktree' }; const content = fs.readFileSync(target, 'utf8'); if (content.includes('\0')) return { ok: false, code: 'SOURCE_FILE_INVALID', message: 'the admitted proposal target is not valid bounded text' }; const bytes = Buffer.byteLength(content, 'utf8'); if (bytes === 0 || bytes > CODEX_DELEGATED_EXECUTION_BUDGET.maxInputFileBytes) return { ok: false, code: 'INPUT_BUDGET_EXCEEDED', message: 'the admitted source file exceeds the bounded proposal input' }; return { content, digest: textSha(content), bytes } } catch { return { ok: false, code: 'SOURCE_FILE_INVALID', message: 'the admitted proposal target could not be read safely' } }
}
function proposalPrompt(plan: Pick<DelegatedCodexExecutionPlan, 'packet' | 'exactPath' | 'originalDigest'>, content: string): string { return ['Produce one bounded structured code-change proposal. Do not execute commands, inspect files, use Git, use MCP, use credentials, access network services, or claim that any change was applied.', `Task: ${plan.packet.goalSummary}`, `Exact path: ${plan.exactPath}`, `Original SHA-256: ${plan.originalDigest}`, 'Return exactly one JSON object matching the supplied schema. Use changes=[] when no safe change is warranted. If proposing a change, use exactly one operation=replace entry and include the complete replacement text.', 'The response is untrusted evidence for Workbench. Do not include Markdown, prose, tool traces, extra properties, or any path other than the exact path.', `BEGIN_FILE\n${content}\nEND_FILE`].join('\n\n') }

export function createDelegatedCodexExecutionPlan(params: { packet: WorkbenchPacket; sessionId: string; lease: DelegatedWorktreeLease; budget?: CodexReviewExecutionBudget }): Result | DelegatedCodexExecutionPlan {
  const packetRecord = getWorkbenchPacketRecord(params.packet.packetId)
  if (!packetRecord || packetRecord.packet.sourceId !== params.packet.sourceId || packetRecord.packet.expectedHead !== params.packet.expectedHead || sha(packetRecord.packet) !== sha(params.packet)) return { ok: false, code: 'PACKET_IDENTITY_MISMATCH', message: 'packet is not the authoritative packet for execution' }
  if (packetRecord.status !== 'running' || packetRecord.leaseOwner !== params.lease.owner || packetRecord.leaseToken !== params.lease.token || packetRecord.leaseExpiresAt !== params.lease.expiresAt) return { ok: false, code: 'LEASE_CONFLICT', message: 'packet lease is not owned by the requesting scheduler' }
  if (!Number.isFinite(Date.parse(params.lease.expiresAt)) || Date.parse(params.lease.expiresAt) <= Date.now()) return { ok: false, code: 'LEASE_EXPIRED', message: 'packet lease has expired' }
  const lifecycle = listDelegatedWorkbenchWorktrees().find(item => item.packetId === params.packet.packetId && item.sourceId === params.packet.sourceId && item.expectedHead === params.packet.expectedHead && item.runId === params.packet.runId)
  if (!lifecycle) return { ok: false, code: 'WORKTREE_NOT_FOUND', message: 'R21.1 worktree evidence was not found for this packet' }
  if (lifecycle.sessionId !== params.sessionId) return { ok: false, code: 'SESSION_ID_MISMATCH', message: 'executor session does not match the R21.1 worktree session identity' }
  if (lifecycle.state !== 'ready' || lifecycle.actualHead !== params.packet.expectedHead || path.resolve(lifecycle.path) === path.resolve(lifecycle.sourceRoot)) return { ok: false, code: 'WORKTREE_NOT_READY', message: 'R21.1 worktree is not ready at the exact expected HEAD' }
  if (lifecycle.exactPaths.length !== 1 || lifecycle.exactPaths[0] !== CODEX_DELEGATED_EXECUTION_PATH) return { ok: false, code: 'SCOPE_INVALID', message: 'R21.2 admits exactly the fixed acceptance fixture and no other path' }
  const source = exactFile(lifecycle.path); if ('ok' in source) return source
  let budget: CodexReviewExecutionBudget
  if (params.budget) {
    if (!delegatedBudgetValid(params.budget)) return { ok: false, code: 'BUDGET_POLICY_MISMATCH', message: 'executor budget does not match the bounded R21.2 proposal policy' }
    budget = params.budget
  } else {
    const created = createCodexReviewExecutionBudget({ profileId: CODEX_DELEGATED_EXECUTION_PROFILE, policyIdentity: CODEX_DELEGATED_EXECUTION_POLICY, requested: CODEX_DELEGATED_EXECUTION_BUDGET })
    if (created.ok === false) return { ok: false, code: created.code, message: created.message }
    budget = created.budget
  }
  const executionId = executionIdFor(lifecycle.worktreeId); const approvalStorePath = path.join(os.tmpdir(), `workbench-r21-2-approval-${executionId}.json`)
  const plan = { packet: params.packet, packetRecord, worktree: lifecycle, lease: params.lease, budget, executionId, prompt: '', worktreePath: lifecycle.path, sourceRoot: lifecycle.sourceRoot, projectedSourceRoot: lifecycle.path, exactPath: CODEX_DELEGATED_EXECUTION_PATH, originalDigest: source.digest, originalBytes: source.bytes, approvalStorePath }
  return { ...plan, prompt: proposalPrompt(plan, source.content) }
}

type AdmissionBuildFailure = { ok: false; code: string; message: string }
export function createDelegatedCodexReviewAdmission(plan: DelegatedCodexExecutionPlan): CodexReviewAdmissionInput | AdmissionBuildFailure {
  const created = createCodexReadOnlyReviewRequest({ sourceId: plan.packet.sourceId, sourceRevision: `r21.1-${plan.packet.expectedHead}`, sourceHead: plan.packet.expectedHead, runId: plan.packet.runId, sessionId: plan.worktree.sessionId, scope: { paths: [plan.exactPath], pathPolicyIdentity: CODEX_DELEGATED_EXECUTION_POLICY }, objective: { category: 'quality', summary: 'Produce one bounded structured change proposal for the exact acceptance fixture.' }, policy: { identity: CODEX_DELEGATED_EXECUTION_POLICY, autonomyLevel: 5, actorId: 'workbench-r21-2' }, budgetIdentity: plan.budget.budgetIdentity })
  if (created.ok === false) return { ok: false, code: 'ADMISSION_REQUEST_INVALID', message: created.message }
  return { request: created.request, source: { sourceId: plan.packet.sourceId, sourceRoot: plan.projectedSourceRoot, enabled: true, revision: `r21.1-${plan.packet.expectedHead}`, head: plan.packet.expectedHead }, run: { runId: plan.packet.runId, sessionId: plan.worktree.sessionId, sourceId: plan.packet.sourceId, status: 'active' }, session: { sessionId: plan.worktree.sessionId, status: 'active', lockedSourceIds: [plan.packet.sourceId] }, phase16: { policyIdentity: CODEX_DELEGATED_EXECUTION_POLICY, autonomyLevel: 5, actorId: 'workbench-r21-2', allowedPaths: ['packages/cli/src/agent/fixtures'] }, storeOptions: { storePath: plan.approvalStorePath } }
}
function recordForPlan(plan: DelegatedCodexExecutionPlan): DelegatedCodexExecutionRecord { return { version: 1, executionId: plan.executionId, packetId: plan.packet.packetId, packetDigest: sha(plan.packet), sourceId: plan.packet.sourceId, sourceRoot: plan.sourceRoot, expectedHead: plan.packet.expectedHead, worktreeId: plan.worktree.worktreeId, worktreePath: plan.worktreePath, worktreeHead: plan.packet.expectedHead, runId: plan.packet.runId, sessionId: plan.worktree.sessionId, exactPaths: [plan.exactPath], originalDigest: plan.originalDigest, scopeDigest: plan.worktree.scopeDigest, leaseOwner: plan.lease.owner, capability: CODEX_DELEGATED_EXECUTOR_CAPABILITY, profile: CODEX_DELEGATED_EXECUTION_PROFILE, budgetIdentity: plan.budget.budgetIdentity, budgetDigest: plan.budget.budgetDigest, status: 'running', launched: false, replayAllowed: false, createdAt: now(), updatedAt: now(), providerModelCalls: 0, providerDispatchState: 'not_dispatched', retries: 0, output: { stdoutBytes: 0, stderrBytes: 0, responseBytes: 0, truncated: false }, changedPaths: [], changedPathSummary: 'proposal_only', usageUnits: 'unavailable' } }
export function reserveDelegatedCodexExecution(plan: DelegatedCodexExecutionPlan): Result { return withStore(store => { const existing = store.records.find(item => item.executionId === plan.executionId); if (existing?.status === 'terminal') return existing.terminalState === 'SUCCESS' ? { ok: true, record: existing, reused: true } : { ok: false, code: existing.terminalState || 'EXECUTION_FAILED', message: 'this execution already has a terminal non-success outcome', record: existing }; if (existing?.status === 'running') return { ok: false, code: 'EXECUTION_ALREADY_RUNNING', message: 'this packet already has an authoritative executor submission', record: existing }; const record = recordForPlan(plan); store.records.push(record); return { ok: true, record } }) }
function completeRecord(executionId: string, state: DelegatedCodexTerminalState, transport: CodexReviewTransportResult | undefined, proposal: ParsedWorkbenchChangeProposal | undefined, rejection: { code: string; message: string } | undefined): DelegatedCodexExecutionRecord | undefined {
  return withStore(store => { const current = store.records.find(item => item.executionId === executionId); if (!current) return undefined; if (current.status === 'terminal') return current; const output = transport?.output; const proposalChange = proposal?.proposal.changes[0]; const metadata = transport?.transport; const completed: DelegatedCodexExecutionRecord = { ...current, status: 'terminal', terminalState: state, terminalAt: now(), updatedAt: now(), ...(transport?.lifecycle.processGroupId ? { processGroupId: transport.lifecycle.processGroupId } : {}), exitCode: transport?.lifecycle.exitCode ?? null, signal: transport?.lifecycle.signal ?? null, timedOut: transport?.lifecycle.timedOut ?? false, cancelled: transport?.lifecycle.cancelled ?? false, elapsedMs: transport?.budgetSnapshot.consumed.wallClockMs ?? 0, output: { stdoutBytes: output?.stdoutBytes || 0, stderrBytes: output?.stderrBytes || 0, responseBytes: output?.stdoutBytes || 0, truncated: output?.truncated === true, ...(output ? { stdoutPreview: preview(output.stdout), stderrPreview: preview(output.stderr) } : {}) }, ...(metadata ? { transport: { contractVersion: metadata.contractVersion, invocationMode: metadata.invocationMode, invocationArgs: metadata.invocationArgs, projectionRoot: metadata.projectionRoot, workingDirectory: metadata.workingDirectory, network: metadata.network, networkRestriction: metadata.networkRestriction, providerAuthentication: metadata.providerAuthentication, credentialForwarded: metadata.credentialForwarded, ...(metadata.requestSchemaSha256 ? { requestSchemaSha256: metadata.requestSchemaSha256 } : {}), ...(metadata.requestPromptSha256 ? { requestPromptSha256: metadata.requestPromptSha256 } : {}), ...(metadata.requestPromptBytes ? { requestPromptBytes: metadata.requestPromptBytes } : {}) } } : {}), ...(proposal ? { proposal: { schemaVersion: proposal.proposal.schemaVersion, path: proposalChange?.path || current.exactPaths[0], originalDigest: proposalChange?.originalDigest || current.originalDigest, ...(proposal.replacementDigest ? { replacementDigest: proposal.replacementDigest } : {}), replacementBytes: proposal.replacementBytes, ...(proposalChange ? { replacementText: proposalChange.replacementText } : {}), summary: proposal.proposal.summary, validation: proposal.validation } } : {}), ...(rejection ? { proposalRejection: rejection } : {}), ...(state !== 'SUCCESS' ? { errorCode: rejection?.code || state } : {}) }; store.records[store.records.indexOf(current)] = completed; return completed })
}
function terminalFromTransport(result: CodexReviewTransportResult): DelegatedCodexTerminalState {
  if (!('code' in result)) return 'SUCCESS'
  if (result.code === 'TIMEOUT') return 'TIMEOUT'
  if (result.code === 'CANCELLED') return 'CANCELLED'
  if (result.code === 'OUTPUT_BUDGET_EXCEEDED') return 'OUTPUT_BUDGET_EXCEEDED'
  if (result.code === 'COST_BUDGET_EXCEEDED') return 'COST_BUDGET_EXCEEDED'
  if (result.code === 'REVIEW_RUNTIME_UNAVAILABLE') return 'RUNTIME_UNAVAILABLE'
  return 'EXECUTION_FAILED'
}
function preProviderFailure(plan: DelegatedCodexExecutionPlan, code: DelegatedCodexTerminalState, message: string): Result { const completed = completeRecord(plan.executionId, code, undefined, undefined, { code, message: message.slice(0, 1_000) }); return completed ? { ok: false, code, message: message.slice(0, 1_000), record: completed } : { ok: false, code: 'EXECUTION_FAILED', message: 'pre-provider failure evidence could not be persisted' } }

export async function executeDelegatedCodexPacket(params: { packet: WorkbenchPacket; sessionId: string; lease: DelegatedWorktreeLease; budget?: CodexReviewExecutionBudget; signal?: AbortSignal }): Promise<Result> {
  const plan = createDelegatedCodexExecutionPlan(params); if ('ok' in plan) return plan
  const existing = readStore().records.find(item => item.executionId === plan.executionId); if (existing?.status === 'terminal') return existing.terminalState === 'SUCCESS' ? { ok: true, record: existing, reused: true } : { ok: false, code: existing.terminalState || 'EXECUTION_FAILED', message: 'this execution already has a terminal non-success outcome', record: existing }; if (existing?.status === 'running') return { ok: false, code: 'EXECUTION_ALREADY_RUNNING', message: 'this packet already has an authoritative executor submission', record: existing }
  const reserved = reserveDelegatedCodexExecution(plan); if (reserved.ok === false || reserved.reused) return reserved
  if (params.signal?.aborted) return preProviderFailure(plan, 'CANCELLED', 'execution was cancelled before provider dispatch')
  const admissionInput = createDelegatedCodexReviewAdmission(plan)
  if ('ok' in admissionInput) return preProviderFailure(plan, 'DENIED', admissionInput.message)
  const admitted = admitCodexReadOnlyReview(admissionInput)
  if (admitted.ok === false) return preProviderFailure(plan, 'DENIED', admitted.message)
  if (admitted.decision !== 'ALLOW' || admitted.stopCondition !== 'structured_findings_required') return preProviderFailure(plan, 'DENIED', 'exact persisted read-only provider approval is not available')
  const schema = buildWorkbenchChangeProposalSchema(plan.exactPath, plan.originalDigest); const serializedSchema = serializeWorkbenchChangeProposalSchema(schema); const schemaInspection = inspectCodexStrictSchema(schema); if (schemaInspection.violations.length > 0 || Buffer.byteLength(plan.prompt, 'utf8') > plan.budget.effective.maxPromptBytes || Buffer.byteLength(serializedSchema, 'utf8') > plan.budget.effective.maxArtifactBytes) return preProviderFailure(plan, 'EXECUTION_FAILED', 'the bounded prompt or proposal schema exceeds the finite execution budget')
  withStore(store => { const item = store.records.find(record => record.executionId === plan.executionId); if (item) store.records[store.records.indexOf(item)] = { ...item, launched: true, providerModelCalls: 1, providerDispatchState: 'dispatched', updatedAt: now() } })
  const controller = new AbortController(); activeControllers.set(plan.executionId, controller); if (params.signal) { if (params.signal.aborted) controller.abort(); else params.signal.addEventListener('abort', () => controller.abort(), { once: true }) }
  try {
    const result = await runCodexReviewWithTrustedTransport({ admission: admissionInput, budget: plan.budget, executionId: plan.executionId, prompt: plan.prompt, outputSchema: schema, signal: controller.signal })
    if ('code' in result) {
      const completed = completeRecord(plan.executionId, terminalFromTransport(result), result, undefined, { code: result.code, message: result.message })
      return completed ? { ok: false, code: completed.terminalState || 'EXECUTION_FAILED', message: result.message, record: completed } : { ok: false, code: 'EXECUTION_FAILED', message: 'terminal execution evidence could not be persisted' }
    }
    let responseValue: unknown
    try { responseValue = JSON.parse(result.output.stdout) } catch { responseValue = undefined }
    const schemaFailure = responseValue === undefined ? undefined : validateCodexSchemaInstance(schema, responseValue)
    if (schemaFailure) {
      const completed = completeRecord(plan.executionId, 'EXECUTION_FAILED', result, undefined, { code: 'PROPOSAL_INVALID', message: schemaFailure })
      return completed ? { ok: false, code: 'PROPOSAL_INVALID', message: schemaFailure, record: completed } : { ok: false, code: 'EXECUTION_FAILED', message: 'proposal rejection evidence could not be persisted' }
    }
    const parsed = parseWorkbenchChangeProposal(result.output.stdout, plan.exactPath, plan.originalDigest)
    if ('code' in parsed) {
      const completed = completeRecord(plan.executionId, 'EXECUTION_FAILED', result, undefined, { code: parsed.code, message: parsed.message })
      return completed ? { ok: false, code: parsed.code, message: parsed.message, record: completed } : { ok: false, code: 'EXECUTION_FAILED', message: 'proposal rejection evidence could not be persisted' }
    }
    const completed = completeRecord(plan.executionId, 'SUCCESS', result, parsed.parsed, undefined)
    return completed ? { ok: true, record: completed } : { ok: false, code: 'EXECUTION_FAILED', message: 'terminal proposal evidence could not be persisted' }
  } finally { activeControllers.delete(plan.executionId) }
}
export function cancelDelegatedCodexExecution(executionId: string): Result { const controller = activeControllers.get(executionId); if (!controller) { const existing = readStore().records.find(item => item.executionId === executionId); return existing ? { ok: false, code: existing.status === 'terminal' ? 'EXECUTION_ALREADY_TERMINAL' : 'EXECUTION_NOT_ACTIVE', message: 'execution is not active in this process', record: existing } : { ok: false, code: 'EXECUTION_NOT_FOUND', message: 'execution was not found' } }; controller.abort(); const existing = readStore().records.find(item => item.executionId === executionId); return existing ? { ok: true, record: existing } : { ok: false, code: 'EXECUTION_NOT_FOUND', message: 'execution record was not persisted' } }
export function reconcileDelegatedCodexExecution(executionId: string): Result { return withStore(store => { const current = store.records.find(item => item.executionId === executionId); if (!current) return { ok: false, code: 'EXECUTION_NOT_FOUND', message: 'execution was not found' }; if (current.status === 'terminal') return { ok: true, record: current, reused: true }; const terminal = { ...current, status: 'terminal' as const, terminalState: 'EXECUTION_FAILED' as const, terminalAt: now(), updatedAt: now(), errorCode: 'ORPHANED_EXECUTION_REQUIRES_RECONCILIATION' }; store.records[store.records.indexOf(current)] = terminal; return { ok: true, record: terminal } }) }
export function getDelegatedCodexExecution(executionId: string): DelegatedCodexExecutionRecord | undefined { return readStore().records.find(item => item.executionId === executionId) }
export function listDelegatedCodexExecutions(): DelegatedCodexExecutionRecord[] { return readStore().records.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }
export { CODEX_REVIEW_NO_MUTATION_AUTHORITY }
