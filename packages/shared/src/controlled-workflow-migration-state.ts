import type { ControlledWorkflowTopologyManifest } from './controlled-workflow-topology'

export const CONTROLLED_WORKFLOW_MIGRATION_STATE_VERSION = 1 as const

export type ControlledWorkflowMigrationMode = 'apply' | 'rollback'

export type ControlledWorkflowMigrationStatus =
  | 'prepared'
  | 'queued'
  | 'running'
  | 'reconciling'
  | 'rolling_back'
  | 'completed'
  | 'rolled_back'
  | 'failed'
  | 'manual_intervention_required'
  | 'expired'

export type ControlledWorkflowMutationResult =
  | 'not_started'
  | 'succeeded'
  | 'definitively_failed'
  | 'ambiguous'
  | 'timed_out'

export type ControlledWorkflowReadbackResult =
  | 'matches_candidate'
  | 'matches_rollback'
  | 'matches_pre_mutation'
  | 'unexpected_state'
  | 'unavailable'

export type ControlledWorkflowRollbackResult =
  | 'not_attempted'
  | 'succeeded'
  | 'definitively_failed'
  | 'ambiguous'
  | 'timed_out'

export type ControlledWorkflowMigrationReasonCode =
  | 'PREPARED'
  | 'INVALID_OPERATION_ID'
  | 'INVALID_SOURCE_ROOT_FINGERPRINT'
  | 'SOURCE_ID_MISMATCH'
  | 'GRANT_IDENTITY_MISMATCH'
  | 'WORKFLOW_ID_MISMATCH'
  | 'CANONICALIZATION_VERSION_MISMATCH'
  | 'ARTIFACT_BINDING_MISMATCH'
  | 'CANONICAL_HASH_MISMATCH'
  | 'WRAPPER_BINDING_MISMATCH'
  | 'API_ORIGIN_MISMATCH'
  | 'CONFIRMATION_REQUIRED'
  | 'CONFIRMATION_INVALID'
  | 'CONFIRMATION_EXPIRED'
  | 'CONFIRMATION_REPLAYED'
  | 'CONFIRMATION_CONSUMED'
  | 'LEASE_ACQUIRED'
  | 'LEASE_CONFLICT'
  | 'STALE_LEASE_RECONCILIATION'
  | 'PRECONDITION_CONFIRMED'
  | 'PRECONDITION_MISMATCH'
  | 'PRECONDITION_UNAVAILABLE'
  | 'CANDIDATE_DISPATCH_RESERVED'
  | 'ROLLBACK_DISPATCH_RESERVED'
  | 'DISPATCH_CONFLICT'
  | 'DISPATCH_REPLAYED'
  | 'DISPATCH_STORE_CORRUPT'
  | 'CANDIDATE_MUTATION_SUCCEEDED'
  | 'CANDIDATE_MUTATION_FAILED'
  | 'CANDIDATE_MUTATION_AMBIGUOUS'
  | 'CANDIDATE_MUTATION_TIMED_OUT'
  | 'CANDIDATE_MUTATION_NOT_STARTED'
  | 'ROLLBACK_MUTATION_SUCCEEDED'
  | 'ROLLBACK_MUTATION_FAILED'
  | 'ROLLBACK_MUTATION_AMBIGUOUS'
  | 'ROLLBACK_MUTATION_TIMED_OUT'
  | 'ROLLBACK_NOT_ATTEMPTED'
  | 'READBACK_CANDIDATE_CONFIRMED'
  | 'READBACK_ROLLBACK_CONFIRMED'
  | 'READBACK_PRE_MUTATION_CONFIRMED'
  | 'READBACK_UNEXPECTED'
  | 'READBACK_UNAVAILABLE'
  | 'AUTOMATIC_ROLLBACK_REQUIRED'
  | 'ROLLBACK_READBACK_FAILED'
  | 'TERMINAL_STATE'
  | 'INVALID_TRANSITION'

export type ControlledWorkflowMigrationBinding = {
  sourceId: string
  sourceRootFingerprint: string
  grantId: string
  grantVersion: number
  workflowId: string
  mode: ControlledWorkflowMigrationMode
  candidatePath: string
  candidateSha256: string
  rollbackPath: string
  rollbackSha256: string
  manifestPath: string
  manifestSha256: string
  wrapperPath: string
  wrapperSha256: string
  canonicalizationVersion: 1
  candidateCanonicalSha256: string
  rollbackCanonicalSha256: string
  expectedLiveCanonicalSha256: string
  apiOriginFingerprint?: string
}

export type ControlledWorkflowMigrationEvidence = {
  observedCanonicalSha256?: string
  protectedDomains?: 'unchanged' | 'unverified'
  mutationResult?: ControlledWorkflowMutationResult
  readbackResult?: ControlledWorkflowReadbackResult
  rollbackResult?: ControlledWorkflowRollbackResult
  durationMs?: number
}

/**
 * Structurally compatible with the existing capability-operation record. Host-only
 * confirmation and lease proof fields are accepted for persistence compatibility,
 * but are never included in the public projection below.
 */
export type ControlledWorkflowMigrationOperation = {
  storeVersion: typeof CONTROLLED_WORKFLOW_MIGRATION_STATE_VERSION
  operationId: string
  status: ControlledWorkflowMigrationStatus
  binding: ControlledWorkflowMigrationBinding
  confirmationTokenHash?: string
  confirmationExpiresAt: string
  confirmationConsumedAt?: string
  createdAt: string
  updatedAt: string
  lease?: {
    leaseProof?: string
    owner: string
    acquiredAt: string
    expiresAt: string
  }
  candidateUpdateRequests: 0 | 1
  rollbackUpdateRequests: 0 | 1
  readbackRequests: number
  reason?: string
  reasonCode?: ControlledWorkflowMigrationReasonCode
  evidence?: ControlledWorkflowMigrationEvidence
}

export type ControlledWorkflowMigrationPrepareInput = {
  operationId: string
  now: string
  confirmationExpiresAt: string
  sourceId: string
  sourceRootFingerprint: string
  workflowId: string
  mode: ControlledWorkflowMigrationMode
  grant: {
    grantId: string
    version: number
    sourceId: string
    workflowId: string
    wrapperPath: string
    wrapperSha256: string
    canonicalizationVersion: 1
    apiOriginFingerprint?: string
  }
  manifest: ControlledWorkflowTopologyManifest
  manifestArtifact: { path: string; sha256: string }
  candidate: { path: string; sha256: string; canonicalSha256: string }
  rollback: { path: string; sha256: string; canonicalSha256: string }
  wrapper: { path: string; sha256: string }
  apiOriginFingerprint?: string
}

export type ControlledWorkflowMigrationPrepareIssue = {
  code: ControlledWorkflowMigrationReasonCode
  field: string
}

export type ControlledWorkflowMigrationPublicEvidence = {
  operationId: string
  status: ControlledWorkflowMigrationStatus
  sourceId: string
  workflowId: string
  mode: ControlledWorkflowMigrationMode
  grantId: string
  grantVersion: number
  candidatePath: string
  candidateSha256: string
  rollbackPath: string
  rollbackSha256: string
  manifestPath: string
  manifestSha256: string
  wrapperSha256: string
  canonicalizationVersion: 1
  candidateCanonicalSha256: string
  rollbackCanonicalSha256: string
  expectedLiveCanonicalSha256: string
  apiOriginFingerprint?: string
  confirmationExpiresAt: string
}

export type ControlledWorkflowMigrationPrepareDecision =
  | {
      allowed: true
      operation: ControlledWorkflowMigrationOperation
      binding: ControlledWorkflowMigrationBinding
      confirmation: { required: true; expiresAt: string }
      evidence: ControlledWorkflowMigrationPublicEvidence
      effects: ControlledWorkflowMigrationEffect[]
    }
  | {
      allowed: false
      reasonCode: ControlledWorkflowMigrationReasonCode
      issues: ControlledWorkflowMigrationPrepareIssue[]
      effects: [{ type: 'none' }]
    }

export type ControlledWorkflowMigrationEvent =
  | {
      type: 'confirmation_result'
      result: 'consumed' | 'missing' | 'invalid' | 'expired' | 'replayed'
      at: string
    }
  | {
      type: 'lease_result'
      result: 'acquired' | 'conflict'
      at: string
    }
  | {
      type: 'precondition_readback'
      result: ControlledWorkflowReadbackResult
      observedCanonicalSha256?: string
      protectedDomains?: 'unchanged' | 'unverified'
      at: string
    }
  | {
      type: 'candidate_dispatch_reserved'
      result: 'reserved' | 'conflict' | 'replayed' | 'store_corrupt'
      at: string
    }
  | {
      type: 'rollback_dispatch_reserved'
      result: 'reserved' | 'conflict' | 'replayed' | 'store_corrupt'
      at: string
    }
  | {
      type: 'mutation_result'
      result: ControlledWorkflowMutationResult
      at: string
    }
  | {
      type: 'rollback_result'
      result: ControlledWorkflowRollbackResult
      at: string
    }
  | {
      type: 'readback_result'
      result: ControlledWorkflowReadbackResult
      observedCanonicalSha256?: string
      protectedDomains?: 'unchanged' | 'unverified'
      at: string
    }
  | {
      type: 'lease_expired'
      at: string
    }
  | {
      type: 'recovered_mutation_result'
      kind: 'candidate'
      result: ControlledWorkflowMutationResult
      at: string
    }
  | {
      type: 'recovered_mutation_result'
      kind: 'rollback'
      result: ControlledWorkflowRollbackResult
      at: string
    }
  | {
      type: 'recovery_resume'
      at: string
    }

export type ControlledWorkflowMigrationEffect =
  | { type: 'none' }
  | { type: 'persist_operation'; operation: ControlledWorkflowMigrationOperation }
  | { type: 'acquire_lease'; operationId: string; sourceId: string; workflowId: string }
  | {
      type: 'read_live_workflow'
      operationId: string
      workflowId: string
      purpose: 'precondition' | 'reconciliation'
      expectedLiveCanonicalSha256: string
    }
  | {
      type: 'reserve_candidate_dispatch'
      operationId: string
      sourceId: string
      workflowId: string
      artifactSha256: string
      wrapperSha256: string
    }
  | {
      type: 'reserve_rollback_dispatch'
      operationId: string
      sourceId: string
      workflowId: string
      artifactSha256: string
      wrapperSha256: string
    }
  | {
      type: 'apply_candidate'
      operationId: string
      workflowId: string
      artifactPath: string
      artifactSha256: string
    }
  | {
      type: 'apply_rollback'
      operationId: string
      workflowId: string
      artifactPath: string
      artifactSha256: string
      automatic: boolean
    }
  | {
      type: 'readback_workflow'
      operationId: string
      workflowId: string
      expected: 'candidate' | 'rollback' | 'approved_state'
    }
  | { type: 'release_lease'; operationId: string }

export type ControlledWorkflowMigrationAdvanceDecision = {
  accepted: boolean
  operation: ControlledWorkflowMigrationOperation
  reasonCode: ControlledWorkflowMigrationReasonCode
  effects: ControlledWorkflowMigrationEffect[]
}

export type ControlledWorkflowMigrationStatusProjection = {
  stateVersion: typeof CONTROLLED_WORKFLOW_MIGRATION_STATE_VERSION
  operationId: string
  status: ControlledWorkflowMigrationStatus
  sourceId: string
  workflowId: string
  mode: ControlledWorkflowMigrationMode
  grantId: string
  grantVersion: number
  approvedArtifacts: {
    candidatePath: string
    candidateSha256: string
    rollbackPath: string
    rollbackSha256: string
    manifestPath: string
    manifestSha256: string
    wrapperSha256: string
  }
  canonicalHashes: {
    expectedLive: string
    candidate: string
    rollback: string
    observed?: string
  }
  requestCounters: {
    candidateUpdate: 0 | 1
    rollbackUpdate: 0 | 1
    readback: number
  }
  protectedDomains: 'unchanged' | 'unverified'
  confirmationExpiresAt: string
  createdAt: string
  updatedAt: string
  reasonCode?: ControlledWorkflowMigrationReasonCode
  mutationResult?: ControlledWorkflowMutationResult
  readbackResult?: ControlledWorkflowReadbackResult
  rollbackResult?: ControlledWorkflowRollbackResult
  durationMs?: number
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const TERMINAL_STATUSES = new Set<ControlledWorkflowMigrationStatus>([
  'completed',
  'rolled_back',
  'failed',
  'manual_intervention_required',
  'expired'
])

/**
 * Host persistence uses this narrow predicate to reject a state write which was
 * not produced by the portable migration state machine.  Keeping the graph
 * here prevents an adapter from creating a competing lifecycle policy.
 */
const LEGAL_STATE_TRANSITIONS: Record<ControlledWorkflowMigrationStatus, ReadonlySet<ControlledWorkflowMigrationStatus>> = {
  prepared: new Set(['prepared', 'queued', 'expired']),
  queued: new Set(['queued', 'running', 'reconciling', 'expired']),
  running: new Set(['running', 'reconciling', 'rolling_back', 'completed', 'failed', 'manual_intervention_required']),
  reconciling: new Set(['reconciling', 'rolling_back', 'completed', 'rolled_back', 'failed', 'manual_intervention_required']),
  rolling_back: new Set(['rolling_back', 'reconciling', 'rolled_back', 'failed', 'manual_intervention_required']),
  completed: new Set(['completed']),
  rolled_back: new Set(['rolled_back']),
  failed: new Set(['failed']),
  manual_intervention_required: new Set(['manual_intervention_required']),
  expired: new Set(['expired'])
}

export function isControlledWorkflowMigrationStateTransition(
  from: ControlledWorkflowMigrationStatus,
  to: ControlledWorkflowMigrationStatus
): boolean {
  return LEGAL_STATE_TRANSITIONS[from].has(to)
}

function isSha256(value: string | undefined): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value)
}

function isExpired(expiresAt: string, now: string): boolean {
  const expires = Date.parse(expiresAt)
  const current = Date.parse(now)
  return !Number.isFinite(expires) || !Number.isFinite(current) || expires <= current
}

function assertNever(value: never): never {
  throw new Error(`Unhandled controlled workflow migration variant: ${String(value)}`)
}

function operationEvidence(
  operation: ControlledWorkflowMigrationOperation,
  update: ControlledWorkflowMigrationEvidence
): ControlledWorkflowMigrationEvidence {
  return { ...(operation.evidence || {}), ...update }
}

function transition(
  operation: ControlledWorkflowMigrationOperation,
  status: ControlledWorkflowMigrationStatus,
  at: string,
  reasonCode: ControlledWorkflowMigrationReasonCode,
  update: Partial<ControlledWorkflowMigrationOperation> = {}
): ControlledWorkflowMigrationOperation {
  return { ...operation, ...update, status, updatedAt: at, reasonCode }
}

function noChange(
  operation: ControlledWorkflowMigrationOperation,
  reasonCode: ControlledWorkflowMigrationReasonCode,
  accepted = false
): ControlledWorkflowMigrationAdvanceDecision {
  return { accepted, operation, reasonCode, effects: [{ type: 'none' }] }
}

function withEffects(
  operation: ControlledWorkflowMigrationOperation,
  reasonCode: ControlledWorkflowMigrationReasonCode,
  effects: ControlledWorkflowMigrationEffect[]
): ControlledWorkflowMigrationAdvanceDecision {
  return { accepted: true, operation, reasonCode, effects }
}

function persistThen(
  operation: ControlledWorkflowMigrationOperation,
  ...effects: ControlledWorkflowMigrationEffect[]
): ControlledWorkflowMigrationEffect[] {
  return [{ type: 'persist_operation', operation }, ...effects]
}

function release(operation: ControlledWorkflowMigrationOperation): ControlledWorkflowMigrationEffect[] {
  return persistThen(operation, { type: 'release_lease', operationId: operation.operationId })
}

function publicEvidence(
  operationId: string,
  status: ControlledWorkflowMigrationStatus,
  binding: ControlledWorkflowMigrationBinding,
  confirmationExpiresAt: string
): ControlledWorkflowMigrationPublicEvidence {
  return {
    operationId,
    status,
    sourceId: binding.sourceId,
    workflowId: binding.workflowId,
    mode: binding.mode,
    grantId: binding.grantId,
    grantVersion: binding.grantVersion,
    candidatePath: binding.candidatePath,
    candidateSha256: binding.candidateSha256,
    rollbackPath: binding.rollbackPath,
    rollbackSha256: binding.rollbackSha256,
    manifestPath: binding.manifestPath,
    manifestSha256: binding.manifestSha256,
    wrapperSha256: binding.wrapperSha256,
    canonicalizationVersion: binding.canonicalizationVersion,
    candidateCanonicalSha256: binding.candidateCanonicalSha256,
    rollbackCanonicalSha256: binding.rollbackCanonicalSha256,
    expectedLiveCanonicalSha256: binding.expectedLiveCanonicalSha256,
    ...(binding.apiOriginFingerprint ? { apiOriginFingerprint: binding.apiOriginFingerprint } : {}),
    confirmationExpiresAt
  }
}

export function prepareControlledWorkflowMigration(
  input: ControlledWorkflowMigrationPrepareInput
): ControlledWorkflowMigrationPrepareDecision {
  const issues: ControlledWorkflowMigrationPrepareIssue[] = []
  const addIssue = (code: ControlledWorkflowMigrationReasonCode, field: string) => {
    if (issues.length < 20) issues.push({ code, field })
  }

  if (!input.operationId.trim() || input.operationId.length > 200) addIssue('INVALID_OPERATION_ID', 'operationId')
  if (!isSha256(input.sourceRootFingerprint)) addIssue('INVALID_SOURCE_ROOT_FINGERPRINT', 'sourceRootFingerprint')
  if (input.sourceId !== input.grant.sourceId) addIssue('SOURCE_ID_MISMATCH', 'sourceId')
  if (!input.grant.grantId.trim() || input.grant.version < 1) addIssue('GRANT_IDENTITY_MISMATCH', 'grant')
  if (input.workflowId !== input.grant.workflowId || input.workflowId !== input.manifest.workflow.id) {
    addIssue('WORKFLOW_ID_MISMATCH', 'workflowId')
  }
  if (input.grant.canonicalizationVersion !== 1 || input.manifest.workflow.canonicalizationVersion !== 1) {
    addIssue('CANONICALIZATION_VERSION_MISMATCH', 'canonicalizationVersion')
  }
  if (
    input.candidate.path !== input.manifest.artifacts.candidatePath
    || input.candidate.sha256 !== input.manifest.artifacts.candidateSha256
    || input.rollback.path !== input.manifest.artifacts.rollbackPath
    || input.rollback.sha256 !== input.manifest.artifacts.rollbackSha256
    || !input.manifestArtifact.path
    || !isSha256(input.manifestArtifact.sha256)
  ) {
    addIssue('ARTIFACT_BINDING_MISMATCH', 'artifacts')
  }
  if (
    input.candidate.canonicalSha256 !== input.manifest.workflow.candidateCanonicalSha256
    || input.rollback.canonicalSha256 !== input.manifest.workflow.rollbackCanonicalSha256
    || !isSha256(input.manifest.workflow.expectedLiveCanonicalSha256)
  ) {
    addIssue('CANONICAL_HASH_MISMATCH', 'canonicalHashes')
  }
  if (
    input.wrapper.path !== input.grant.wrapperPath
    || input.wrapper.sha256 !== input.grant.wrapperSha256
    || !isSha256(input.wrapper.sha256)
  ) {
    addIssue('WRAPPER_BINDING_MISMATCH', 'wrapper')
  }
  if (input.apiOriginFingerprint !== input.grant.apiOriginFingerprint) {
    addIssue('API_ORIGIN_MISMATCH', 'apiOriginFingerprint')
  }
  if (isExpired(input.confirmationExpiresAt, input.now)) addIssue('CONFIRMATION_EXPIRED', 'confirmationExpiresAt')

  if (issues.length > 0) {
    return { allowed: false, reasonCode: issues[0].code, issues, effects: [{ type: 'none' }] }
  }

  const binding: ControlledWorkflowMigrationBinding = {
    sourceId: input.sourceId,
    sourceRootFingerprint: input.sourceRootFingerprint,
    grantId: input.grant.grantId,
    grantVersion: input.grant.version,
    workflowId: input.workflowId,
    mode: input.mode,
    candidatePath: input.candidate.path,
    candidateSha256: input.candidate.sha256,
    rollbackPath: input.rollback.path,
    rollbackSha256: input.rollback.sha256,
    manifestPath: input.manifestArtifact.path,
    manifestSha256: input.manifestArtifact.sha256,
    wrapperPath: input.wrapper.path,
    wrapperSha256: input.wrapper.sha256,
    canonicalizationVersion: 1,
    candidateCanonicalSha256: input.candidate.canonicalSha256,
    rollbackCanonicalSha256: input.rollback.canonicalSha256,
    expectedLiveCanonicalSha256: input.manifest.workflow.expectedLiveCanonicalSha256,
    ...(input.apiOriginFingerprint ? { apiOriginFingerprint: input.apiOriginFingerprint } : {})
  }
  const operation: ControlledWorkflowMigrationOperation = {
    storeVersion: CONTROLLED_WORKFLOW_MIGRATION_STATE_VERSION,
    operationId: input.operationId,
    status: 'prepared',
    binding,
    confirmationExpiresAt: input.confirmationExpiresAt,
    createdAt: input.now,
    updatedAt: input.now,
    candidateUpdateRequests: 0,
    rollbackUpdateRequests: 0,
    readbackRequests: 0,
    reasonCode: 'PREPARED',
    evidence: { protectedDomains: 'unchanged' }
  }
  return {
    allowed: true,
    operation,
    binding,
    confirmation: { required: true, expiresAt: input.confirmationExpiresAt },
    evidence: publicEvidence(input.operationId, 'prepared', binding, input.confirmationExpiresAt),
    effects: [{ type: 'persist_operation', operation }]
  }
}

function handleConfirmationResult(
  operation: ControlledWorkflowMigrationOperation,
  event: Extract<ControlledWorkflowMigrationEvent, { type: 'confirmation_result' }>
): ControlledWorkflowMigrationAdvanceDecision {
  if (operation.status !== 'prepared') {
    return noChange(operation, event.result === 'replayed' || operation.confirmationConsumedAt
      ? 'CONFIRMATION_REPLAYED'
      : 'INVALID_TRANSITION')
  }
  if (event.result === 'expired' || isExpired(operation.confirmationExpiresAt, event.at)) {
    const expired = transition(operation, 'expired', event.at, 'CONFIRMATION_EXPIRED')
    return withEffects(expired, 'CONFIRMATION_EXPIRED', [{ type: 'persist_operation', operation: expired }])
  }
  if (operation.confirmationConsumedAt || event.result === 'replayed') return noChange(operation, 'CONFIRMATION_REPLAYED')
  if (event.result === 'missing') return noChange(operation, 'CONFIRMATION_REQUIRED')
  if (event.result === 'invalid') return noChange(operation, 'CONFIRMATION_INVALID')
  if (event.result !== 'consumed') return assertNever(event.result)

  const queued = transition(operation, 'queued', event.at, 'CONFIRMATION_CONSUMED', {
    confirmationConsumedAt: event.at
  })
  return withEffects(queued, 'CONFIRMATION_CONSUMED', persistThen(queued, {
    type: 'acquire_lease',
    operationId: queued.operationId,
    sourceId: queued.binding.sourceId,
    workflowId: queued.binding.workflowId
  }))
}

function handleLeaseResult(
  operation: ControlledWorkflowMigrationOperation,
  event: Extract<ControlledWorkflowMigrationEvent, { type: 'lease_result' }>
): ControlledWorkflowMigrationAdvanceDecision {
  if (operation.status !== 'queued') return noChange(operation, 'INVALID_TRANSITION')
  if (!operation.confirmationConsumedAt) return noChange(operation, 'CONFIRMATION_REQUIRED')
  if (event.result === 'conflict') return noChange(operation, 'LEASE_CONFLICT')
  if (event.result !== 'acquired') return assertNever(event.result)

  const running = transition(operation, 'running', event.at, 'LEASE_ACQUIRED', {
    readbackRequests: operation.readbackRequests + 1
  })
  return withEffects(running, 'LEASE_ACQUIRED', persistThen(running, {
    type: 'read_live_workflow',
    operationId: running.operationId,
    workflowId: running.binding.workflowId,
    purpose: 'precondition',
    expectedLiveCanonicalSha256: running.binding.expectedLiveCanonicalSha256
  }))
}

function handlePreconditionReadback(
  operation: ControlledWorkflowMigrationOperation,
  event: Extract<ControlledWorkflowMigrationEvent, { type: 'precondition_readback' }>
): ControlledWorkflowMigrationAdvanceDecision {
  if (operation.status !== 'running' || operation.candidateUpdateRequests !== 0 || operation.rollbackUpdateRequests !== 0) {
    return noChange(operation, 'INVALID_TRANSITION')
  }
  const evidence = operationEvidence(operation, {
    readbackResult: event.result,
    protectedDomains: event.protectedDomains === 'unchanged' ? 'unchanged' : 'unverified',
    ...(isSha256(event.observedCanonicalSha256) ? { observedCanonicalSha256: event.observedCanonicalSha256 } : {})
  })
  if (event.result !== 'matches_pre_mutation') {
    const reasonCode = event.result === 'unavailable' ? 'PRECONDITION_UNAVAILABLE' : 'PRECONDITION_MISMATCH'
    const failed = transition(operation, 'failed', event.at, reasonCode, { evidence })
    return withEffects(failed, reasonCode, release(failed))
  }

  if (operation.binding.mode === 'apply') {
    const ready = transition(operation, 'running', event.at, 'PRECONDITION_CONFIRMED', { evidence })
    return withEffects(ready, 'PRECONDITION_CONFIRMED', persistThen(ready, {
      type: 'reserve_candidate_dispatch',
      operationId: ready.operationId,
      sourceId: ready.binding.sourceId,
      workflowId: ready.binding.workflowId,
      artifactSha256: ready.binding.candidateSha256,
      wrapperSha256: ready.binding.wrapperSha256
    }))
  }

  const ready = transition(operation, 'running', event.at, 'PRECONDITION_CONFIRMED', { evidence })
  return withEffects(ready, 'PRECONDITION_CONFIRMED', persistThen(ready, {
    type: 'reserve_rollback_dispatch',
    operationId: ready.operationId,
    sourceId: ready.binding.sourceId,
    workflowId: ready.binding.workflowId,
    artifactSha256: ready.binding.rollbackSha256,
    wrapperSha256: ready.binding.wrapperSha256
  }))
}

function dispatchFailure(
  operation: ControlledWorkflowMigrationOperation,
  result: 'conflict' | 'replayed' | 'store_corrupt',
  at: string
): ControlledWorkflowMigrationAdvanceDecision {
  const code = result === 'conflict' ? 'DISPATCH_CONFLICT' : result === 'replayed' ? 'DISPATCH_REPLAYED' : 'DISPATCH_STORE_CORRUPT'
  const terminal = transition(operation, 'manual_intervention_required', at, code)
  return withEffects(terminal, code, release(terminal))
}

function handleCandidateDispatchReserved(operation: ControlledWorkflowMigrationOperation, event: Extract<ControlledWorkflowMigrationEvent, { type: 'candidate_dispatch_reserved' }>): ControlledWorkflowMigrationAdvanceDecision {
  if (operation.status !== 'running' || operation.binding.mode !== 'apply' || operation.candidateUpdateRequests !== 0) return noChange(operation, 'INVALID_TRANSITION')
  if (event.result !== 'reserved') return dispatchFailure(operation, event.result, event.at)
  const ready = transition(operation, 'running', event.at, 'CANDIDATE_DISPATCH_RESERVED', { candidateUpdateRequests: 1 })
  return withEffects(ready, 'CANDIDATE_DISPATCH_RESERVED', persistThen(ready, { type: 'apply_candidate', operationId: ready.operationId, workflowId: ready.binding.workflowId, artifactPath: ready.binding.candidatePath, artifactSha256: ready.binding.candidateSha256 }))
}

function handleRollbackDispatchReserved(operation: ControlledWorkflowMigrationOperation, event: Extract<ControlledWorkflowMigrationEvent, { type: 'rollback_dispatch_reserved' }>): ControlledWorkflowMigrationAdvanceDecision {
  const standalone = operation.binding.mode === 'rollback' && operation.status === 'running'
  const automatic = operation.binding.mode === 'apply' && operation.status === 'rolling_back'
  if ((!standalone && !automatic) || operation.rollbackUpdateRequests !== 0) return noChange(operation, 'INVALID_TRANSITION')
  if (event.result !== 'reserved') return dispatchFailure(operation, event.result, event.at)
  const ready = transition(operation, operation.status, event.at, 'ROLLBACK_DISPATCH_RESERVED', { rollbackUpdateRequests: 1 })
  return withEffects(ready, 'ROLLBACK_DISPATCH_RESERVED', persistThen(ready, { type: 'apply_rollback', operationId: ready.operationId, workflowId: ready.binding.workflowId, artifactPath: ready.binding.rollbackPath, artifactSha256: ready.binding.rollbackSha256, automatic }))
}

function handleMutationResult(
  operation: ControlledWorkflowMigrationOperation,
  event: Extract<ControlledWorkflowMigrationEvent, { type: 'mutation_result' }>
): ControlledWorkflowMigrationAdvanceDecision {
  if (operation.status !== 'running' || operation.binding.mode !== 'apply' || operation.candidateUpdateRequests !== 1) {
    return noChange(operation, 'INVALID_TRANSITION')
  }
  const reasonByResult: Record<ControlledWorkflowMutationResult, ControlledWorkflowMigrationReasonCode> = {
    not_started: 'CANDIDATE_MUTATION_NOT_STARTED',
    succeeded: 'CANDIDATE_MUTATION_SUCCEEDED',
    definitively_failed: 'CANDIDATE_MUTATION_FAILED',
    ambiguous: 'CANDIDATE_MUTATION_AMBIGUOUS',
    timed_out: 'CANDIDATE_MUTATION_TIMED_OUT'
  }
  const reasonCode = reasonByResult[event.result]
  const evidence = operationEvidence(operation, { mutationResult: event.result })
  if (event.result === 'not_started' || event.result === 'definitively_failed') {
    const failed = transition(operation, 'failed', event.at, reasonCode, { evidence })
    return withEffects(failed, reasonCode, release(failed))
  }
  const reconciling = transition(operation, 'reconciling', event.at, reasonCode, {
    readbackRequests: operation.readbackRequests + 1,
    evidence
  })
  return withEffects(reconciling, reasonCode, persistThen(reconciling, {
    type: 'readback_workflow',
    operationId: reconciling.operationId,
    workflowId: reconciling.binding.workflowId,
    expected: event.result === 'succeeded' ? 'candidate' : 'approved_state'
  }))
}

function handleRollbackResult(
  operation: ControlledWorkflowMigrationOperation,
  event: Extract<ControlledWorkflowMigrationEvent, { type: 'rollback_result' }>
): ControlledWorkflowMigrationAdvanceDecision {
  const standalone = operation.binding.mode === 'rollback' && operation.status === 'running'
  const automatic = operation.binding.mode === 'apply' && operation.status === 'rolling_back'
  if ((!standalone && !automatic) || operation.rollbackUpdateRequests !== 1) return noChange(operation, 'INVALID_TRANSITION')

  const reasonByResult: Record<ControlledWorkflowRollbackResult, ControlledWorkflowMigrationReasonCode> = {
    not_attempted: 'ROLLBACK_NOT_ATTEMPTED',
    succeeded: 'ROLLBACK_MUTATION_SUCCEEDED',
    definitively_failed: 'ROLLBACK_MUTATION_FAILED',
    ambiguous: 'ROLLBACK_MUTATION_AMBIGUOUS',
    timed_out: 'ROLLBACK_MUTATION_TIMED_OUT'
  }
  const reasonCode = reasonByResult[event.result]
  const evidence = operationEvidence(operation, { rollbackResult: event.result })

  if (event.result === 'succeeded') {
    const rollingBack = transition(operation, 'rolling_back', event.at, reasonCode, {
      readbackRequests: operation.readbackRequests + 1,
      evidence
    })
    return withEffects(rollingBack, reasonCode, persistThen(rollingBack, {
      type: 'readback_workflow',
      operationId: rollingBack.operationId,
      workflowId: rollingBack.binding.workflowId,
      expected: 'rollback'
    }))
  }

  if (automatic) {
    const manual = transition(operation, 'manual_intervention_required', event.at, reasonCode, { evidence })
    return withEffects(manual, reasonCode, release(manual))
  }
  if (event.result === 'ambiguous' || event.result === 'timed_out') {
    const reconciling = transition(operation, 'reconciling', event.at, reasonCode, {
      readbackRequests: operation.readbackRequests + 1,
      evidence
    })
    return withEffects(reconciling, reasonCode, persistThen(reconciling, {
      type: 'readback_workflow',
      operationId: reconciling.operationId,
      workflowId: reconciling.binding.workflowId,
      expected: 'approved_state'
    }))
  }
  const failed = transition(operation, 'failed', event.at, reasonCode, { evidence })
  return withEffects(failed, reasonCode, release(failed))
}

function handleReadbackResult(
  operation: ControlledWorkflowMigrationOperation,
  event: Extract<ControlledWorkflowMigrationEvent, { type: 'readback_result' }>
): ControlledWorkflowMigrationAdvanceDecision {
  if (operation.status !== 'reconciling' && operation.status !== 'rolling_back') {
    return noChange(operation, 'INVALID_TRANSITION')
  }
  const evidence = operationEvidence(operation, {
    readbackResult: event.result,
    protectedDomains: event.protectedDomains === 'unchanged' ? 'unchanged' : 'unverified',
    ...(isSha256(event.observedCanonicalSha256) ? { observedCanonicalSha256: event.observedCanonicalSha256 } : {})
  })

  if (operation.status === 'rolling_back') {
    if (event.result === 'matches_rollback') {
      const rolledBack = transition(operation, 'rolled_back', event.at, 'READBACK_ROLLBACK_CONFIRMED', { evidence })
      return withEffects(rolledBack, 'READBACK_ROLLBACK_CONFIRMED', release(rolledBack))
    }
    const manual = transition(operation, 'manual_intervention_required', event.at, 'ROLLBACK_READBACK_FAILED', { evidence })
    return withEffects(manual, 'ROLLBACK_READBACK_FAILED', release(manual))
  }

  if (operation.binding.mode === 'apply') {
    if (event.result === 'matches_candidate') {
      const completed = transition(operation, 'completed', event.at, 'READBACK_CANDIDATE_CONFIRMED', { evidence })
      return withEffects(completed, 'READBACK_CANDIDATE_CONFIRMED', release(completed))
    }
    if (event.result === 'matches_rollback') {
      const rolledBack = transition(operation, 'rolled_back', event.at, 'READBACK_ROLLBACK_CONFIRMED', { evidence })
      return withEffects(rolledBack, 'READBACK_ROLLBACK_CONFIRMED', release(rolledBack))
    }
    if (event.result === 'matches_pre_mutation') {
      const failed = transition(operation, 'failed', event.at, 'READBACK_PRE_MUTATION_CONFIRMED', { evidence })
      return withEffects(failed, 'READBACK_PRE_MUTATION_CONFIRMED', release(failed))
    }
    if (event.result === 'unexpected_state' && operation.rollbackUpdateRequests === 0) {
      const rollingBack = transition(operation, 'rolling_back', event.at, 'AUTOMATIC_ROLLBACK_REQUIRED', { evidence })
      return withEffects(rollingBack, 'AUTOMATIC_ROLLBACK_REQUIRED', persistThen(rollingBack, {
        type: 'reserve_rollback_dispatch',
        operationId: rollingBack.operationId,
        sourceId: rollingBack.binding.sourceId,
        workflowId: rollingBack.binding.workflowId,
        artifactSha256: rollingBack.binding.rollbackSha256,
        wrapperSha256: rollingBack.binding.wrapperSha256
      }))
    }
    const reasonCode = event.result === 'unavailable' ? 'READBACK_UNAVAILABLE' : 'READBACK_UNEXPECTED'
    const manual = transition(operation, 'manual_intervention_required', event.at, reasonCode, { evidence })
    return withEffects(manual, reasonCode, release(manual))
  }

  if (event.result === 'matches_rollback') {
    const rolledBack = transition(operation, 'rolled_back', event.at, 'READBACK_ROLLBACK_CONFIRMED', { evidence })
    return withEffects(rolledBack, 'READBACK_ROLLBACK_CONFIRMED', release(rolledBack))
  }
  if (event.result === 'matches_pre_mutation') {
    const failed = transition(operation, 'failed', event.at, 'READBACK_PRE_MUTATION_CONFIRMED', { evidence })
    return withEffects(failed, 'READBACK_PRE_MUTATION_CONFIRMED', release(failed))
  }
  const reasonCode = event.result === 'unavailable' ? 'READBACK_UNAVAILABLE' : 'READBACK_UNEXPECTED'
  const manual = transition(operation, 'manual_intervention_required', event.at, reasonCode, { evidence })
  return withEffects(manual, reasonCode, release(manual))
}

function handleLeaseExpired(
  operation: ControlledWorkflowMigrationOperation,
  event: Extract<ControlledWorkflowMigrationEvent, { type: 'lease_expired' }>
): ControlledWorkflowMigrationAdvanceDecision {
  if (operation.status !== 'running') return noChange(operation, 'INVALID_TRANSITION')
  const reconciling = transition(operation, 'reconciling', event.at, 'STALE_LEASE_RECONCILIATION', {
    readbackRequests: operation.readbackRequests + 1
  })
  return withEffects(reconciling, 'STALE_LEASE_RECONCILIATION', persistThen(reconciling, {
    type: 'read_live_workflow',
    operationId: reconciling.operationId,
    workflowId: reconciling.binding.workflowId,
    purpose: 'reconciliation',
    expectedLiveCanonicalSha256: reconciling.binding.expectedLiveCanonicalSha256
  }))
}

function handleRecoveredMutationResult(
  operation: ControlledWorkflowMigrationOperation,
  event: Extract<ControlledWorkflowMigrationEvent, { type: 'recovered_mutation_result' }>
): ControlledWorkflowMigrationAdvanceDecision {
  if (operation.status !== 'reconciling') return noChange(operation, 'INVALID_TRANSITION')
  if (event.kind === 'candidate') {
    if (operation.binding.mode !== 'apply'
      || operation.candidateUpdateRequests !== 1
      || operation.evidence?.mutationResult !== undefined) return noChange(operation, 'INVALID_TRANSITION')
    return handleMutationResult({ ...operation, status: 'running' }, {
      type: 'mutation_result',
      result: event.result,
      at: event.at
    })
  }
  if (operation.rollbackUpdateRequests !== 1
    || operation.evidence?.rollbackResult !== undefined) return noChange(operation, 'INVALID_TRANSITION')
  return handleRollbackResult({
    ...operation,
    status: operation.binding.mode === 'apply' ? 'rolling_back' : 'running'
  }, {
    type: 'rollback_result',
    result: event.result,
    at: event.at
  })
}

function handleRecoveryResume(
  operation: ControlledWorkflowMigrationOperation,
  event: Extract<ControlledWorkflowMigrationEvent, { type: 'recovery_resume' }>
): ControlledWorkflowMigrationAdvanceDecision {
  if (operation.status !== 'reconciling' && operation.status !== 'rolling_back') {
    return noChange(operation, 'INVALID_TRANSITION')
  }
  const expectsRollback = operation.status === 'rolling_back'
    || (operation.rollbackUpdateRequests === 1 && operation.evidence?.rollbackResult === 'succeeded')
  const resumed = transition(operation, operation.status, event.at, 'STALE_LEASE_RECONCILIATION', {
    readbackRequests: operation.readbackRequests + 1
  })
  return withEffects(resumed, 'STALE_LEASE_RECONCILIATION', persistThen(resumed, {
    type: 'readback_workflow',
    operationId: resumed.operationId,
    workflowId: resumed.binding.workflowId,
    expected: expectsRollback ? 'rollback' : 'approved_state'
  }))
}

export function advanceControlledWorkflowMigration(params: {
  operation: ControlledWorkflowMigrationOperation
  event: ControlledWorkflowMigrationEvent
}): ControlledWorkflowMigrationAdvanceDecision {
  const { operation, event } = params
  if (TERMINAL_STATUSES.has(operation.status)) return noChange(operation, 'TERMINAL_STATE', true)
  if (operation.status === 'prepared' && isExpired(operation.confirmationExpiresAt, event.at)) {
    const expired = transition(operation, 'expired', event.at, 'CONFIRMATION_EXPIRED')
    return withEffects(expired, 'CONFIRMATION_EXPIRED', [{ type: 'persist_operation', operation: expired }])
  }

  switch (event.type) {
    case 'confirmation_result': return handleConfirmationResult(operation, event)
    case 'lease_result': return handleLeaseResult(operation, event)
    case 'precondition_readback': return handlePreconditionReadback(operation, event)
    case 'candidate_dispatch_reserved': return handleCandidateDispatchReserved(operation, event)
    case 'rollback_dispatch_reserved': return handleRollbackDispatchReserved(operation, event)
    case 'mutation_result': return handleMutationResult(operation, event)
    case 'rollback_result': return handleRollbackResult(operation, event)
    case 'readback_result': return handleReadbackResult(operation, event)
    case 'lease_expired': return handleLeaseExpired(operation, event)
    case 'recovered_mutation_result': return handleRecoveredMutationResult(operation, event)
    case 'recovery_resume': return handleRecoveryResume(operation, event)
    default: return assertNever(event)
  }
}

export function projectControlledWorkflowMigrationStatus(
  operation: ControlledWorkflowMigrationOperation
): ControlledWorkflowMigrationStatusProjection {
  const evidence = operation.evidence || {}
  const durationMs = typeof evidence.durationMs === 'number' && Number.isFinite(evidence.durationMs)
    ? Math.max(0, Math.min(Math.trunc(evidence.durationMs), 900_000))
    : undefined
  return {
    stateVersion: CONTROLLED_WORKFLOW_MIGRATION_STATE_VERSION,
    operationId: operation.operationId,
    status: operation.status,
    sourceId: operation.binding.sourceId,
    workflowId: operation.binding.workflowId,
    mode: operation.binding.mode,
    grantId: operation.binding.grantId,
    grantVersion: operation.binding.grantVersion,
    approvedArtifacts: {
      candidatePath: operation.binding.candidatePath,
      candidateSha256: operation.binding.candidateSha256,
      rollbackPath: operation.binding.rollbackPath,
      rollbackSha256: operation.binding.rollbackSha256,
      manifestPath: operation.binding.manifestPath,
      manifestSha256: operation.binding.manifestSha256,
      wrapperSha256: operation.binding.wrapperSha256
    },
    canonicalHashes: {
      expectedLive: operation.binding.expectedLiveCanonicalSha256,
      candidate: operation.binding.candidateCanonicalSha256,
      rollback: operation.binding.rollbackCanonicalSha256,
      ...(isSha256(evidence.observedCanonicalSha256) ? { observed: evidence.observedCanonicalSha256 } : {})
    },
    requestCounters: {
      candidateUpdate: operation.candidateUpdateRequests,
      rollbackUpdate: operation.rollbackUpdateRequests,
      readback: Math.max(0, Math.min(Math.trunc(operation.readbackRequests), 10_000))
    },
    protectedDomains: evidence.protectedDomains || 'unverified',
    confirmationExpiresAt: operation.confirmationExpiresAt,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    ...(operation.reasonCode ? { reasonCode: operation.reasonCode } : {}),
    ...(evidence.mutationResult ? { mutationResult: evidence.mutationResult } : {}),
    ...(evidence.readbackResult ? { readbackResult: evidence.readbackResult } : {}),
    ...(evidence.rollbackResult ? { rollbackResult: evidence.rollbackResult } : {}),
    ...(durationMs === undefined ? {} : { durationMs })
  }
}
