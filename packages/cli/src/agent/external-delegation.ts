import crypto from 'node:crypto'
import type { AgentJob } from './agent-jobs'
import type { PromptPacketTransportContract } from './prompt-packet-compiler'
import type { ResumeProjection } from './resume-projection'

export const EXTERNAL_DELEGATION_SCHEMA_VERSION = 1 as const

export type DelegationLifecycle =
  | 'prepared'
  | 'awaiting_confirmation'
  | 'admitted'
  | 'submitted'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancellation_requested'
  | 'cancelled'
  | 'ambiguous'
  | 'reconciliation_required'

export type DelegationAuthorization = 'not_required' | 'required' | 'satisfied' | 'rejected' | 'expired'
export type DelegationConfirmation = 'not_required' | 'required' | 'satisfied' | 'rejected' | 'expired'
export type DelegationCancellation = 'none' | 'requested' | 'acknowledged' | 'timed_out' | 'conflicted' | 'ambiguous'
export type DelegationReconciliation = 'not_required' | 'pending' | 'matched' | 'mismatched' | 'ambiguous'

export type DelegationReasonCode =
  | 'prepared'
  | 'awaiting_confirmation'
  | 'admitted'
  | 'manual_fallback_required'
  | 'stale_compiled_contract'
  | 'source_mismatch'
  | 'run_mismatch'
  | 'task_mismatch'
  | 'packet_mismatch'
  | 'head_mismatch'
  | 'policy_mismatch'
  | 'confirmation_required'
  | 'budget_exhausted'
  | 'terminal_run'
  | 'unsupported_executor'
  | 'authorization_required'
  | 'authorization_rejected'
  | 'duplicate_conflict'
  | 'invalid_transition'
  | 'cancellation_requested'
  | 'cancellation_acknowledged'
  | 'cancellation_timeout'
  | 'cancellation_conflict'
  | 'cancellation_ambiguous'
  | 'evidence_identity_mismatch'
  | 'evidence_authority_broadening'
  | 'reconciliation_matched'
  | 'reconciliation_mismatch'
  | 'reconciliation_ambiguous'

export type DelegationEvidenceSummary = {
  operationId: string
  packetId: string
  resultStatus: 'completed' | 'failed' | 'cancelled' | 'ambiguous'
  validationState: 'passed' | 'failed' | 'unknown'
  commitIdentity?: string
  startedAt?: string
  completedAt?: string
  durationMs?: number
  reasonCode?: string
}

export type ExternalDelegationOperation = {
  schemaVersion: typeof EXTERNAL_DELEGATION_SCHEMA_VERSION
  operationId: string
  sourceId: string
  runId: string
  taskId: string
  packetId: string
  compiledContractHash: string
  compiledIdempotencyKey: string
  expectedHead: string
  executor: { engine: string; profile: string }
  lifecycle: DelegationLifecycle
  authorization: DelegationAuthorization
  confirmation: DelegationConfirmation
  budgetIdentity: string
  policyIdentity: string
  createdAt: string
  updatedAt: string
  reasonCode: DelegationReasonCode
  evidence?: DelegationEvidenceSummary
  cancellation: DelegationCancellation
  reconciliation: DelegationReconciliation
}

export type DelegationDecision = {
  allowed: boolean
  reasonCode: DelegationReasonCode
  nextAction: string
  operation?: ExternalDelegationOperation
  manualFallback: boolean
}

const MAX_TEXT = 240
const KNOWN_ENGINES = new Set(['codex', 'future_adapter', 'human'])
const TERMINAL_RUNS = new Set(['completed', 'failed', 'cancelled'])
const TERMINAL_OPERATIONS = new Set<DelegationLifecycle>(['completed', 'failed', 'cancelled', 'ambiguous'])

const TRANSITIONS: Record<DelegationLifecycle, DelegationLifecycle[]> = {
  prepared: ['awaiting_confirmation', 'admitted', 'ambiguous'],
  awaiting_confirmation: ['admitted', 'failed', 'ambiguous'],
  admitted: ['submitted', 'failed', 'cancellation_requested', 'ambiguous'],
  submitted: ['running', 'completed', 'failed', 'cancellation_requested', 'ambiguous', 'reconciliation_required'],
  running: ['completed', 'failed', 'cancellation_requested', 'ambiguous', 'reconciliation_required'],
  completed: ['reconciliation_required'],
  failed: ['reconciliation_required'],
  cancellation_requested: ['cancelled', 'ambiguous', 'reconciliation_required'],
  cancelled: ['reconciliation_required'],
  ambiguous: ['reconciliation_required'],
  reconciliation_required: ['completed', 'failed', 'cancelled', 'ambiguous']
}

function bounded(value: unknown, max = MAX_TEXT): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const item = value as Record<string, unknown>
  return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical(item[key])}`).join(',')}}`
}

function sha(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function budgetIdentity(contract: PromptPacketTransportContract): string {
  return sha(canonical(contract.budget))
}

function operationIdentity(contract: PromptPacketTransportContract): string {
  return `delegation-${sha(`${contract.idempotencyKey}:${contract.contentHash}`).slice(0, 24)}`
}

export function prepareDelegationOperation(params: {
  run: AgentJob
  projection: ResumeProjection
  contract: PromptPacketTransportContract
  authorization: DelegationAuthorization
  confirmation: DelegationConfirmation
  now: string
  existing?: ExternalDelegationOperation
}): DelegationDecision {
  const { run, projection, contract } = params
  const manual = (reasonCode: DelegationReasonCode, nextAction: string): DelegationDecision => ({ allowed: false, reasonCode, nextAction, manualFallback: true })
  if (run.sourceId !== contract.sourceId || projection.sourceId !== contract.sourceId) return manual('source_mismatch', 'Use the compiled contract for the locked source.')
  if (run.id !== contract.runId || projection.runId !== contract.runId) return manual('run_mismatch', 'Use the compiled contract for the active run.')
  if (run.activeTaskId && run.activeTaskId !== contract.taskId) return manual('task_mismatch', 'Use the compiled contract for the active task.')
  if (projection.packet?.id && projection.packet.id !== contract.packetId) return manual('packet_mismatch', 'Use the compiled contract for the active packet.')
  if (projection.currentHead && projection.currentHead !== contract.expectedHead) return manual('head_mismatch', 'Refresh the packet against the current HEAD.')
  if (projection.contentHash !== contract.resumeProjectionHash) return manual('stale_compiled_contract', 'Recompile from the fresh Resume Projection.')
  if (projection.freshness.policyIdentity !== contract.compilerIdentity.policyIdentity) return manual('policy_mismatch', 'Recompile after the policy change.')
  if (TERMINAL_RUNS.has(run.status)) return manual('terminal_run', 'Start a new run or use explicit reconciliation.')
  if (run.executionBudget.exhausted || projection.budget.exhausted) return manual('budget_exhausted', 'Resolve or replace the exhausted run budget.')
  if (!KNOWN_ENGINES.has(contract.compilerIdentity.executionEngine)) return manual('unsupported_executor', 'Use direct Workbench execution or manual copy/paste.')
  if (params.authorization === 'rejected' || params.authorization === 'expired') return manual('authorization_rejected', 'Use manual fallback or refresh authorization.')

  const operationId = operationIdentity(contract)
  if (params.existing) {
    const same = params.existing.operationId === operationId
      && params.existing.compiledContractHash === contract.contentHash
      && params.existing.compiledIdempotencyKey === contract.idempotencyKey
    if (!same) return manual('duplicate_conflict', 'Reconcile the conflicting delegation operation.')
    return { allowed: params.existing.lifecycle === 'admitted', reasonCode: params.existing.reasonCode, nextAction: 'Reuse the existing delegation operation.', operation: params.existing, manualFallback: false }
  }

  const confirmationRequired = run.requiresConfirmation || projection.confirmation.required || params.confirmation === 'required'
  const authorizationRequired = params.authorization === 'required'
  const lifecycle: DelegationLifecycle = confirmationRequired || authorizationRequired ? 'awaiting_confirmation' : 'admitted'
  const reasonCode: DelegationReasonCode = confirmationRequired ? 'confirmation_required' : authorizationRequired ? 'authorization_required' : 'admitted'
  const operation: ExternalDelegationOperation = {
    schemaVersion: EXTERNAL_DELEGATION_SCHEMA_VERSION,
    operationId,
    sourceId: contract.sourceId,
    runId: contract.runId,
    taskId: contract.taskId,
    packetId: contract.packetId,
    compiledContractHash: contract.contentHash,
    compiledIdempotencyKey: contract.idempotencyKey,
    expectedHead: contract.expectedHead,
    executor: { engine: contract.compilerIdentity.executionEngine, profile: contract.compilerIdentity.executionProfile },
    lifecycle,
    authorization: params.authorization,
    confirmation: confirmationRequired ? 'required' : params.confirmation,
    budgetIdentity: budgetIdentity(contract),
    policyIdentity: contract.compilerIdentity.policyIdentity,
    createdAt: params.now,
    updatedAt: params.now,
    reasonCode,
    cancellation: 'none',
    reconciliation: 'not_required'
  }
  return {
    allowed: lifecycle === 'admitted',
    reasonCode,
    nextAction: lifecycle === 'admitted' ? 'Preview the submission or continue manually.' : 'Satisfy authorization and confirmation before delegation.',
    operation,
    manualFallback: true
  }
}

export function transitionDelegationOperation(operation: ExternalDelegationOperation, next: DelegationLifecycle, now: string): { ok: true; operation: ExternalDelegationOperation } | { ok: false; reasonCode: 'invalid_transition' } {
  if (!TRANSITIONS[operation.lifecycle].includes(next)) return { ok: false, reasonCode: 'invalid_transition' }
  const reasonCode: DelegationReasonCode = next === 'cancellation_requested'
    ? 'cancellation_requested'
    : next === 'ambiguous'
      ? 'reconciliation_ambiguous'
      : next === 'reconciliation_required'
        ? 'reconciliation_mismatch'
        : operation.reasonCode
  return { ok: true, operation: { ...operation, lifecycle: next, updatedAt: now, reasonCode, reconciliation: next === 'reconciliation_required' ? 'pending' : operation.reconciliation } }
}

export function evaluateCancellation(operation: ExternalDelegationOperation, outcome: 'request' | 'acknowledge' | 'timeout' | 'conflict' | 'ambiguous', now: string): ExternalDelegationOperation {
  if (outcome === 'request') {
    const transition = transitionDelegationOperation(operation, 'cancellation_requested', now)
    return transition.ok ? { ...transition.operation, cancellation: 'requested', reasonCode: 'cancellation_requested' } : { ...operation, cancellation: 'conflicted', reasonCode: 'cancellation_conflict' }
  }
  if (operation.lifecycle !== 'cancellation_requested') return { ...operation, cancellation: 'conflicted', reasonCode: 'cancellation_conflict' }
  if (outcome === 'acknowledge') return { ...operation, lifecycle: 'cancelled', cancellation: 'acknowledged', reasonCode: 'cancellation_acknowledged', updatedAt: now }
  if (outcome === 'timeout') return { ...operation, lifecycle: 'ambiguous', cancellation: 'timed_out', reconciliation: 'ambiguous', reasonCode: 'cancellation_timeout', updatedAt: now }
  if (outcome === 'ambiguous') return { ...operation, lifecycle: 'ambiguous', cancellation: 'ambiguous', reconciliation: 'ambiguous', reasonCode: 'cancellation_ambiguous', updatedAt: now }
  return { ...operation, cancellation: 'conflicted', reasonCode: 'cancellation_conflict', updatedAt: now }
}

export function validateDelegationEvidence(operation: ExternalDelegationOperation, input: DelegationEvidenceSummary & { sourceId?: string; runId?: string; taskId?: string; expectedHead?: string; paths?: string[] }): { ok: true; evidence: DelegationEvidenceSummary } | { ok: false; reasonCode: DelegationReasonCode } {
  if (input.operationId !== operation.operationId || input.packetId !== operation.packetId) return { ok: false, reasonCode: 'evidence_identity_mismatch' }
  if ((input.sourceId && input.sourceId !== operation.sourceId) || (input.runId && input.runId !== operation.runId) || (input.taskId && input.taskId !== operation.taskId) || (input.expectedHead && input.expectedHead !== operation.expectedHead)) return { ok: false, reasonCode: 'evidence_identity_mismatch' }
  if (Array.isArray(input.paths) && input.paths.length > 0) return { ok: false, reasonCode: 'evidence_authority_broadening' }
  const evidence: DelegationEvidenceSummary = {
    operationId: bounded(input.operationId, 160),
    packetId: bounded(input.packetId, 160),
    resultStatus: input.resultStatus,
    validationState: input.validationState,
    ...(input.commitIdentity ? { commitIdentity: bounded(input.commitIdentity, 64) } : {}),
    ...(input.startedAt ? { startedAt: bounded(input.startedAt, 40) } : {}),
    ...(input.completedAt ? { completedAt: bounded(input.completedAt, 40) } : {}),
    ...(Number.isFinite(input.durationMs) ? { durationMs: Math.max(0, Math.min(86_400_000, Math.floor(input.durationMs!))) } : {}),
    ...(input.reasonCode ? { reasonCode: bounded(input.reasonCode, 80) } : {})
  }
  return { ok: true, evidence }
}

export function reconcileDelegationOperation(operation: ExternalDelegationOperation, evidence?: DelegationEvidenceSummary): ExternalDelegationOperation {
  if (!evidence) return { ...operation, lifecycle: 'ambiguous', reconciliation: 'ambiguous', reasonCode: 'reconciliation_ambiguous' }
  if (evidence.operationId !== operation.operationId || evidence.packetId !== operation.packetId) return { ...operation, lifecycle: 'reconciliation_required', reconciliation: 'mismatched', reasonCode: 'reconciliation_mismatch' }
  const lifecycle: DelegationLifecycle = evidence.resultStatus === 'completed' ? 'completed' : evidence.resultStatus === 'failed' ? 'failed' : evidence.resultStatus === 'cancelled' ? 'cancelled' : 'ambiguous'
  return { ...operation, lifecycle, evidence, reconciliation: lifecycle === 'ambiguous' ? 'ambiguous' : 'matched', reasonCode: lifecycle === 'ambiguous' ? 'reconciliation_ambiguous' : 'reconciliation_matched' }
}

export function projectDelegationStatus(operation: ExternalDelegationOperation): { executor: string; operationId: string; lifecycle: DelegationLifecycle; authorization: DelegationAuthorization; confirmation: DelegationConfirmation; cancellation: DelegationCancellation; reconciliation: DelegationReconciliation; blocker?: string; nextAction: string; evidence?: DelegationEvidenceSummary } {
  const blocker = operation.lifecycle === 'awaiting_confirmation' ? 'Authorization or confirmation is required.' : operation.lifecycle === 'ambiguous' || operation.lifecycle === 'reconciliation_required' ? 'External state requires reconciliation.' : undefined
  const nextAction = blocker ? 'Use manual fallback or reconcile exact evidence.' : TERMINAL_OPERATIONS.has(operation.lifecycle) ? 'Review bounded evidence and keep the packet closed.' : 'Manual copy/paste remains the supported execution path.'
  return {
    executor: `${operation.executor.engine}/${operation.executor.profile}`.slice(0, 120),
    operationId: operation.operationId,
    lifecycle: operation.lifecycle,
    authorization: operation.authorization,
    confirmation: operation.confirmation,
    cancellation: operation.cancellation,
    reconciliation: operation.reconciliation,
    ...(blocker ? { blocker } : {}),
    nextAction,
    ...(operation.evidence ? { evidence: operation.evidence } : {})
  }
}

export function manualDelegationFallback(reasonCode: DelegationReasonCode): { required: true; reasonCode: DelegationReasonCode; nextAction: string } {
  return { required: true, reasonCode, nextAction: 'Copy the bounded compiled packet manually; no automatic external submission is available.' }
}
