import crypto from 'node:crypto'
import type { PromptPacketTransportContract } from './prompt-packet-compiler'
import type { PersistedDelegationOperation } from './external-delegation-store'
import type { DelegationEvidenceSummary, DelegationLifecycle } from './external-delegation'

export type ProviderAdmissionReason =
  | 'admitted'
  | 'adapter_unavailable'
  | 'adapter_unsupported'
  | 'authorization_missing'
  | 'authorization_expired'
  | 'confirmation_missing'
  | 'stale_operation_revision'
  | 'stale_compiled_contract'
  | 'source_mismatch'
  | 'run_mismatch'
  | 'task_mismatch'
  | 'packet_mismatch'
  | 'head_mismatch'
  | 'policy_mismatch'
  | 'budget_mismatch'
  | 'terminal_operation'
  | 'ambiguous_operation'
  | 'reconciliation_required'
  | 'duplicate_submission_risk'

export type ProviderAdmissionDecision = {
  allowed: boolean
  reasonCode: ProviderAdmissionReason
  nextAction: string
  manualFallback: true
}

export type SubmissionIntent = {
  schemaVersion: 1
  operationId: string
  adapterIdentity: string
  compiledContractHash: string
  idempotencyKey: string
  expectedRevision: number
  intendedTransition: 'submitted'
  createdAt: string
}

export type SubmissionAcknowledgement = {
  schemaVersion: 1
  operationId: string
  packetId: string
  adapterIdentity: string
  providerOperationIdentity: string
  compiledContractHash: string
  idempotencyKey: string
  acceptedAt: string
  status: 'accepted'
  reasonCode: string
}

export type ProviderStatusRecord = {
  providerOperationIdentity: string
  lifecycle: Extract<DelegationLifecycle, 'submitted' | 'running' | 'completed' | 'failed' | 'cancelled' | 'ambiguous'>
  adapterIdentity: string
  observedAt: string
  reasonCode: string
  durationMs?: number
  validationState?: 'passed' | 'failed' | 'unknown'
  commitIdentity?: string
}

export type CancellationIntent = {
  schemaVersion: 1
  operationId: string
  adapterIdentity: string
  expectedRevision: number
  requestedAt: string
}

export type ReconciliationOutcome = {
  outcome: 'matched' | 'ambiguous' | 'mismatched' | 'reconciliation_required'
  reasonCode: string
  nextAction: string
  manualFallback: true
}

const TERMINAL = new Set<DelegationLifecycle>(['completed', 'failed', 'cancelled'])
const ADMISSIBLE = new Set<DelegationLifecycle>(['admitted'])

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}

function budgetIdentity(contract: PromptPacketTransportContract): string {
  return crypto.createHash('sha256').update(canonical(contract.budget)).digest('hex')
}

function fail(reasonCode: ProviderAdmissionReason, nextAction: string): ProviderAdmissionDecision {
  return { allowed: false, reasonCode, nextAction, manualFallback: true }
}

export function evaluateProviderAdmission(params: {
  operation: PersistedDelegationOperation
  contract: PromptPacketTransportContract
  adapterIdentity?: string
  adapterSupported: boolean
  expectedRevision: number
}): ProviderAdmissionDecision {
  const { operation, contract } = params
  if (!params.adapterIdentity) return fail('adapter_unavailable', 'Use manual copy/paste execution.')
  if (!params.adapterSupported) return fail('adapter_unsupported', 'Use a supported adapter or manual fallback.')
  if (operation.authorization === 'required' || operation.authorization === 'not_required' && false) return fail('authorization_missing', 'Satisfy provider authorization first.')
  if (operation.authorization === 'expired' || operation.authorization === 'rejected') return fail('authorization_expired', 'Refresh or replace authorization.')
  if (operation.confirmation === 'required') return fail('confirmation_missing', 'Satisfy exact operation confirmation first.')
  if (operation.revision !== params.expectedRevision) return fail('stale_operation_revision', 'Reload the persisted delegation operation.')
  if (operation.compiledContractHash !== contract.contentHash) return fail('stale_compiled_contract', 'Recompile the packet from fresh run state.')
  if (operation.sourceId !== contract.sourceId) return fail('source_mismatch', 'Use the contract for the locked source.')
  if (operation.runId !== contract.runId) return fail('run_mismatch', 'Use the contract for the active run.')
  if (operation.taskId !== contract.taskId) return fail('task_mismatch', 'Use the contract for the active task.')
  if (operation.packetId !== contract.packetId) return fail('packet_mismatch', 'Use the contract for the active packet.')
  if (operation.expectedHead !== contract.expectedHead) return fail('head_mismatch', 'Refresh against the current HEAD.')
  if (operation.policyIdentity !== contract.compilerIdentity.policyIdentity) return fail('policy_mismatch', 'Recompile after the policy change.')
  if (operation.budgetIdentity !== budgetIdentity(contract)) return fail('budget_mismatch', 'Recompile after the budget change.')
  if (operation.compiledIdempotencyKey !== contract.idempotencyKey) return fail('duplicate_submission_risk', 'Reconcile the idempotency mismatch.')
  if (TERMINAL.has(operation.lifecycle)) return fail('terminal_operation', 'Keep the terminal operation closed.')
  if (operation.lifecycle === 'ambiguous') return fail('ambiguous_operation', 'Reconcile exact provider state before continuation.')
  if (operation.lifecycle === 'reconciliation_required') return fail('reconciliation_required', 'Complete exact reconciliation first.')
  if (!ADMISSIBLE.has(operation.lifecycle)) return fail('duplicate_submission_risk', 'Do not submit from the current lifecycle state.')
  return { allowed: true, reasonCode: 'admitted', nextAction: 'Persist submission intent; do not mark submitted before acknowledgement.', manualFallback: true }
}

export function createSubmissionIntent(params: { operation: PersistedDelegationOperation; adapterIdentity: string; now: string }): SubmissionIntent {
  return {
    schemaVersion: 1,
    operationId: params.operation.operationId,
    adapterIdentity: params.adapterIdentity,
    compiledContractHash: params.operation.compiledContractHash,
    idempotencyKey: params.operation.compiledIdempotencyKey,
    expectedRevision: params.operation.revision,
    intendedTransition: 'submitted',
    createdAt: params.now
  }
}

export function sameSubmissionIntent(a: SubmissionIntent, b: SubmissionIntent): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function validateSubmissionAcknowledgement(params: {
  operation: PersistedDelegationOperation
  intent: SubmissionIntent
  acknowledgement?: SubmissionAcknowledgement
}): { ok: true; nextLifecycle: 'submitted' } | { ok: false; outcome: 'ambiguous' | 'reconciliation_required'; reasonCode: string } {
  const acknowledgement = params.acknowledgement
  if (!acknowledgement) return { ok: false, outcome: 'ambiguous', reasonCode: 'acknowledgement_missing' }
  const valid = acknowledgement.operationId === params.operation.operationId
    && acknowledgement.packetId === params.operation.packetId
    && acknowledgement.adapterIdentity === params.intent.adapterIdentity
    && acknowledgement.compiledContractHash === params.operation.compiledContractHash
    && acknowledgement.idempotencyKey === params.operation.compiledIdempotencyKey
  return valid
    ? { ok: true, nextLifecycle: 'submitted' }
    : { ok: false, outcome: 'reconciliation_required', reasonCode: 'acknowledgement_identity_mismatch' }
}

export function createCancellationIntent(params: { operation: PersistedDelegationOperation; adapterIdentity: string; now: string }): CancellationIntent {
  return { schemaVersion: 1, operationId: params.operation.operationId, adapterIdentity: params.adapterIdentity, expectedRevision: params.operation.revision, requestedAt: params.now }
}

export function reconcileProviderState(params: {
  operation: PersistedDelegationOperation
  intent?: SubmissionIntent
  acknowledgement?: SubmissionAcknowledgement
  status?: ProviderStatusRecord
  evidence?: DelegationEvidenceSummary
}): ReconciliationOutcome {
  if (!params.status) return { outcome: 'ambiguous', reasonCode: 'provider_status_missing', nextAction: 'Obtain bounded provider status or use manual fallback.', manualFallback: true }
  if (!params.intent || !params.acknowledgement) return { outcome: 'reconciliation_required', reasonCode: 'submission_evidence_incomplete', nextAction: 'Reconcile submission intent and acknowledgement.', manualFallback: true }
  if (params.acknowledgement.providerOperationIdentity !== params.status.providerOperationIdentity) return { outcome: 'mismatched', reasonCode: 'provider_operation_mismatch', nextAction: 'Stop automatic continuation and reconcile identities.', manualFallback: true }
  if (params.acknowledgement.adapterIdentity !== params.status.adapterIdentity) return { outcome: 'mismatched', reasonCode: 'adapter_identity_mismatch', nextAction: 'Stop automatic continuation and reconcile adapter identity.', manualFallback: true }
  if (params.status.lifecycle === 'completed' && !params.evidence) return { outcome: 'reconciliation_required', reasonCode: 'completed_evidence_missing', nextAction: 'Import bounded validated evidence before completion.', manualFallback: true }
  if (params.status.lifecycle === 'completed' && params.evidence?.commitIdentity && params.status.commitIdentity && params.evidence.commitIdentity !== params.status.commitIdentity) return { outcome: 'mismatched', reasonCode: 'commit_identity_mismatch', nextAction: 'Stop automatic continuation and reconcile commit identity.', manualFallback: true }
  if (params.status.lifecycle === 'ambiguous') return { outcome: 'ambiguous', reasonCode: 'provider_status_ambiguous', nextAction: 'Do not continue automatically.', manualFallback: true }
  return { outcome: 'matched', reasonCode: 'provider_state_matched', nextAction: 'Apply the validated monotonic lifecycle transition.', manualFallback: true }
}
