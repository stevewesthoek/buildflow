import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  advanceControlledWorkflowMigration,
  prepareControlledWorkflowMigration,
  projectControlledWorkflowMigrationStatus,
  type ControlledWorkflowMigrationEvent,
  type ControlledWorkflowMigrationMode,
  type ControlledWorkflowMigrationOperation,
  type ControlledWorkflowMigrationPrepareInput,
  type ControlledWorkflowMigrationStatus
} from '../packages/shared/src/controlled-workflow-migration-state'
import type { ControlledWorkflowTopologyManifest } from '../packages/shared/src/controlled-workflow-topology'
import type {
  CapabilityOperationBinding,
  CapabilityOperationRecord,
  CapabilityOperationStatus
} from '../packages/cli/src/agent/capability-operation-store'

type Assert<T extends true> = T
type StateStatusesMatchStore = Assert<ControlledWorkflowMigrationStatus extends CapabilityOperationStatus ? true : false>
type StoreStatusesMatchState = Assert<CapabilityOperationStatus extends ControlledWorkflowMigrationStatus ? true : false>
type StateBindingMatchesStore = Assert<ControlledWorkflowMigrationOperation['binding'] extends CapabilityOperationBinding ? true : false>
type StoreBindingMatchesState = Assert<CapabilityOperationBinding extends ControlledWorkflowMigrationOperation['binding'] ? true : false>
type StoreRecordAcceptedByState = Assert<CapabilityOperationRecord extends ControlledWorkflowMigrationOperation ? true : false>
type OperationStoreCompatibility = [
  StateStatusesMatchStore,
  StoreStatusesMatchState,
  StateBindingMatchesStore,
  StoreBindingMatchesState,
  StoreRecordAcceptedByState
]
const operationStoreCompatibility: OperationStoreCompatibility = [true, true, true, true, true]
assert.deepEqual(operationStoreCompatibility, [true, true, true, true, true])

const hash = (character: string) => character.repeat(64)
const startedAt = '2026-01-01T00:00:00.000Z'
const expiresAt = '2026-01-01T00:10:00.000Z'
const at = (seconds: number) => new Date(Date.parse(startedAt) + seconds * 1000).toISOString()

const manifest: ControlledWorkflowTopologyManifest = {
  schemaVersion: 1,
  kind: 'n8n-controlled-topology-migration',
  workflow: {
    id: 'workflow-1',
    canonicalizationVersion: 1,
    expectedLiveCanonicalSha256: hash('a'),
    candidateCanonicalSha256: hash('b'),
    rollbackCanonicalSha256: hash('c')
  },
  artifacts: {
    candidatePath: 'operations/workflows/candidate.json',
    candidateSha256: hash('d'),
    rollbackPath: 'operations/artifacts/rollback.json',
    rollbackSha256: hash('e')
  },
  invariants: {
    activation: 'unchanged',
    settings: 'unchanged',
    tags: 'unchanged',
    sharing: 'unchanged',
    credentials: 'unchanged',
    webhooks: 'unchanged',
    schedules: 'unchanged'
  },
  nodes: { add: [], remove: [], modify: [] },
  connections: { add: [], remove: [] },
  routes: { required: [], forbidden: [] }
}

const prepareInput = (mode: ControlledWorkflowMigrationMode): ControlledWorkflowMigrationPrepareInput => ({
  operationId: `operation-${mode}`,
  now: startedAt,
  confirmationExpiresAt: expiresAt,
  sourceId: 'example-source',
  sourceRootFingerprint: hash('f'),
  workflowId: 'workflow-1',
  mode,
  grant: {
    grantId: 'grant-1',
    version: 3,
    sourceId: 'example-source',
    workflowId: 'workflow-1',
    wrapperPath: 'tools/n8n-api.sh',
    wrapperSha256: hash('1'),
    canonicalizationVersion: 1,
    apiOriginFingerprint: hash('2')
  },
  manifest,
  manifestArtifact: { path: 'operations/workflows/manifest.json', sha256: hash('3') },
  candidate: {
    path: manifest.artifacts.candidatePath,
    sha256: manifest.artifacts.candidateSha256,
    canonicalSha256: manifest.workflow.candidateCanonicalSha256
  },
  rollback: {
    path: manifest.artifacts.rollbackPath,
    sha256: manifest.artifacts.rollbackSha256,
    canonicalSha256: manifest.workflow.rollbackCanonicalSha256
  },
  wrapper: { path: 'tools/n8n-api.sh', sha256: hash('1') },
  apiOriginFingerprint: hash('2')
})

const prepared = (mode: ControlledWorkflowMigrationMode): ControlledWorkflowMigrationOperation => {
  const decision = prepareControlledWorkflowMigration(prepareInput(mode))
  assert.equal(decision.allowed, true)
  if (!decision.allowed) throw new Error(decision.reasonCode)
  assert.deepEqual(decision.effects.map(effect => effect.type), ['persist_operation'])
  return decision.operation
}

const step = (operation: ControlledWorkflowMigrationOperation, event: ControlledWorkflowMigrationEvent) => {
  const decision = advanceControlledWorkflowMigration({ operation, event })
  decision.effects.forEach((effect, index) => {
    if (effect.type !== 'apply_candidate' && effect.type !== 'apply_rollback') return
    assert.ok(index > 0)
    assert.equal(decision.effects[index - 1]?.type, 'persist_operation')
    assert.equal(effect.type === 'apply_candidate'
      ? decision.operation.candidateUpdateRequests
      : decision.operation.rollbackUpdateRequests, 1)
  })
  const serializedEffects = JSON.stringify(decision.effects)
  for (const forbiddenField of ['"executable"', '"argv"', '"shell"', '"environment"']) {
    assert.equal(serializedEffects.includes(forbiddenField), false)
  }
  return decision
}

const effectTypes = (decision: ReturnType<typeof step>) => decision.effects.map(effect => effect.type)

const queue = (operation: ControlledWorkflowMigrationOperation) => {
  const decision = step(operation, { type: 'confirmation_result', result: 'consumed', at: at(1) })
  assert.equal(decision.operation.status, 'queued')
  assert.deepEqual(effectTypes(decision), ['persist_operation', 'acquire_lease'])
  return decision.operation
}

const run = (operation: ControlledWorkflowMigrationOperation) => {
  const decision = step(queue(operation), { type: 'lease_result', result: 'acquired', at: at(2) })
  assert.equal(decision.operation.status, 'running')
  assert.deepEqual(effectTypes(decision), ['persist_operation', 'read_live_workflow'])
  return decision.operation
}

const requestMutation = (operation: ControlledWorkflowMigrationOperation) => {
  const decision = step(run(operation), {
    type: 'precondition_readback',
    result: 'matches_pre_mutation',
    observedCanonicalSha256: manifest.workflow.expectedLiveCanonicalSha256,
    at: at(3)
  })
  assert.equal(decision.operation.status, 'running')
  const reservationType = operation.binding.mode === 'apply' ? 'reserve_candidate_dispatch' : 'reserve_rollback_dispatch'
  assert.deepEqual(effectTypes(decision), ['persist_operation', reservationType])
  const reserved = step(decision.operation, {
    type: operation.binding.mode === 'apply' ? 'candidate_dispatch_reserved' : 'rollback_dispatch_reserved',
    result: 'reserved', at: at(4)
  })
  assert.deepEqual(effectTypes(reserved), ['persist_operation', operation.binding.mode === 'apply' ? 'apply_candidate' : 'apply_rollback'])
  return reserved.operation
}

const reconcileApply = (
  result: 'succeeded' | 'ambiguous' | 'timed_out'
): ControlledWorkflowMigrationOperation => {
  const mutationRequested = requestMutation(prepared('apply'))
  const decision = step(mutationRequested, { type: 'mutation_result', result, at: at(4) })
  assert.equal(decision.operation.status, 'reconciling')
  assert.deepEqual(effectTypes(decision), ['persist_operation', 'readback_workflow'])
  return decision.operation
}

const validApply = prepareControlledWorkflowMigration(prepareInput('apply'))
assert.equal(validApply.allowed, true)
if (!validApply.allowed) throw new Error(validApply.reasonCode)
assert.equal(validApply.operation.status, 'prepared')
assert.equal(validApply.confirmation.required, true)
assert.equal(validApply.binding.grantVersion, 3)
assert.equal(validApply.evidence.wrapperSha256, hash('1'))
assert.equal('confirmationTokenHash' in validApply.evidence, false)

const validRollback = prepareControlledWorkflowMigration(prepareInput('rollback'))
assert.equal(validRollback.allowed, true)
if (!validRollback.allowed) throw new Error(validRollback.reasonCode)
assert.equal(validRollback.operation.binding.mode, 'rollback')

const wrongWorkflow = prepareControlledWorkflowMigration({ ...prepareInput('apply'), workflowId: 'wrong-workflow' })
assert.equal(wrongWorkflow.allowed, false)
if (!wrongWorkflow.allowed) assert.ok(wrongWorkflow.issues.some(issue => issue.code === 'WORKFLOW_ID_MISMATCH'))

const mismatchedCanonicalHash = prepareControlledWorkflowMigration({
  ...prepareInput('apply'),
  candidate: { ...prepareInput('apply').candidate, canonicalSha256: hash('9') }
})
assert.equal(mismatchedCanonicalHash.allowed, false)
if (!mismatchedCanonicalHash.allowed) assert.ok(mismatchedCanonicalHash.issues.some(issue => issue.code === 'CANONICAL_HASH_MISMATCH'))

const preparationRejections: Array<[ControlledWorkflowMigrationPrepareInput, string]> = [
  [{ ...prepareInput('apply'), operationId: '' }, 'INVALID_OPERATION_ID'],
  [{ ...prepareInput('apply'), sourceRootFingerprint: 'invalid' }, 'INVALID_SOURCE_ROOT_FINGERPRINT'],
  [{ ...prepareInput('apply'), sourceId: 'wrong-source' }, 'SOURCE_ID_MISMATCH'],
  [{ ...prepareInput('apply'), manifestArtifact: { ...prepareInput('apply').manifestArtifact, sha256: 'invalid' } }, 'ARTIFACT_BINDING_MISMATCH'],
  [{ ...prepareInput('apply'), wrapper: { ...prepareInput('apply').wrapper, sha256: hash('9') } }, 'WRAPPER_BINDING_MISMATCH'],
  [{ ...prepareInput('apply'), apiOriginFingerprint: hash('9') }, 'API_ORIGIN_MISMATCH']
]
for (const [input, reasonCode] of preparationRejections) {
  const decision = prepareControlledWorkflowMigration(input)
  assert.equal(decision.allowed, false)
  if (!decision.allowed) assert.ok(decision.issues.some(issue => issue.code === reasonCode))
}

const expiredPreparation = prepareControlledWorkflowMigration({
  ...prepareInput('apply'),
  confirmationExpiresAt: '2025-12-31T23:59:59.000Z'
})
assert.equal(expiredPreparation.allowed, false)
if (!expiredPreparation.allowed) assert.equal(expiredPreparation.reasonCode, 'CONFIRMATION_EXPIRED')

for (const result of ['missing', 'invalid'] as const) {
  const decision = step(prepared('apply'), { type: 'confirmation_result', result, at: at(1) })
  assert.equal(decision.accepted, false)
  assert.equal(decision.operation.status, 'prepared')
  assert.deepEqual(effectTypes(decision), ['none'])
}

const expiredAfterPreparation = step(prepared('apply'), {
  type: 'confirmation_result',
  result: 'consumed',
  at: '2026-01-01T00:11:00.000Z'
})
assert.equal(expiredAfterPreparation.operation.status, 'expired')
assert.deepEqual(effectTypes(expiredAfterPreparation), ['persist_operation'])

const leaseConflict = step(queue(prepared('apply')), { type: 'lease_result', result: 'conflict', at: at(2) })
assert.equal(leaseConflict.accepted, false)
assert.equal(leaseConflict.reasonCode, 'LEASE_CONFLICT')
assert.deepEqual(effectTypes(leaseConflict), ['none'])

for (const result of ['unexpected_state', 'unavailable'] as const) {
  const decision = step(run(prepared('apply')), { type: 'precondition_readback', result, at: at(3) })
  assert.equal(decision.operation.status, 'failed')
  assert.equal(decision.operation.candidateUpdateRequests, 0)
  assert.ok(!effectTypes(decision).includes('apply_candidate'))
}

const applyRequested = requestMutation(prepared('apply'))
assert.equal(applyRequested.candidateUpdateRequests, 1)
assert.equal(applyRequested.rollbackUpdateRequests, 0)
const applySucceeded = step(applyRequested, { type: 'mutation_result', result: 'succeeded', at: at(4) })
assert.equal(applySucceeded.operation.status, 'reconciling')
const applyCompleted = step(applySucceeded.operation, {
  type: 'readback_result',
  result: 'matches_candidate',
  observedCanonicalSha256: manifest.workflow.candidateCanonicalSha256,
  at: at(5)
})
assert.equal(applyCompleted.operation.status, 'completed')
assert.deepEqual(effectTypes(applyCompleted), ['persist_operation', 'release_lease'])

const rollbackRequested = requestMutation(prepared('rollback'))
assert.equal(rollbackRequested.rollbackUpdateRequests, 1)
assert.equal(rollbackRequested.candidateUpdateRequests, 0)
const rollbackSucceeded = step(rollbackRequested, { type: 'rollback_result', result: 'succeeded', at: at(4) })
assert.equal(rollbackSucceeded.operation.status, 'rolling_back')
assert.deepEqual(effectTypes(rollbackSucceeded), ['persist_operation', 'readback_workflow'])
const rollbackCompleted = step(rollbackSucceeded.operation, {
  type: 'readback_result',
  result: 'matches_rollback',
  observedCanonicalSha256: manifest.workflow.rollbackCanonicalSha256,
  at: at(5)
})
assert.equal(rollbackCompleted.operation.status, 'rolled_back')

const definiteFailure = step(requestMutation(prepared('apply')), {
  type: 'mutation_result',
  result: 'definitively_failed',
  at: at(4)
})
assert.equal(definiteFailure.operation.status, 'failed')
assert.equal(definiteFailure.operation.rollbackUpdateRequests, 0)
assert.ok(!effectTypes(definiteFailure).includes('apply_rollback'))

const notStarted = step(requestMutation(prepared('apply')), {
  type: 'mutation_result',
  result: 'not_started',
  at: at(4)
})
assert.equal(notStarted.operation.status, 'failed')
assert.equal(notStarted.reasonCode, 'CANDIDATE_MUTATION_NOT_STARTED')

for (const result of ['timed_out', 'ambiguous'] as const) {
  const decision = step(requestMutation(prepared('apply')), { type: 'mutation_result', result, at: at(4) })
  assert.equal(decision.operation.status, 'reconciling')
  assert.deepEqual(effectTypes(decision), ['persist_operation', 'readback_workflow'])
  assert.ok(!effectTypes(decision).includes('apply_candidate'))
}

const candidateAfterAmbiguous = step(reconcileApply('ambiguous'), {
  type: 'readback_result',
  result: 'matches_candidate',
  observedCanonicalSha256: manifest.workflow.candidateCanonicalSha256,
  at: at(5)
})
assert.equal(candidateAfterAmbiguous.operation.status, 'completed')

const unavailableAfterAmbiguous = step(reconcileApply('ambiguous'), {
  type: 'readback_result',
  result: 'unavailable',
  at: at(5)
})
assert.equal(unavailableAfterAmbiguous.operation.status, 'manual_intervention_required')
assert.equal(unavailableAfterAmbiguous.reasonCode, 'READBACK_UNAVAILABLE')

const preMutationAfterAmbiguous = step(reconcileApply('ambiguous'), {
  type: 'readback_result',
  result: 'matches_pre_mutation',
  observedCanonicalSha256: manifest.workflow.expectedLiveCanonicalSha256,
  at: at(5)
})
assert.equal(preMutationAfterAmbiguous.operation.status, 'failed')
assert.equal(preMutationAfterAmbiguous.operation.rollbackUpdateRequests, 0)
assert.ok(!effectTypes(preMutationAfterAmbiguous).includes('apply_rollback'))

const approvedRollbackAfterAmbiguous = step(reconcileApply('ambiguous'), {
  type: 'readback_result',
  result: 'matches_rollback',
  observedCanonicalSha256: manifest.workflow.rollbackCanonicalSha256,
  at: at(5)
})
assert.equal(approvedRollbackAfterAmbiguous.operation.status, 'rolled_back')
assert.equal(approvedRollbackAfterAmbiguous.operation.rollbackUpdateRequests, 0)

const unexpectedReadback = step(reconcileApply('ambiguous'), {
  type: 'readback_result',
  result: 'unexpected_state',
  observedCanonicalSha256: hash('8'),
  at: at(5)
})
assert.equal(unexpectedReadback.operation.status, 'rolling_back')
assert.equal(unexpectedReadback.operation.rollbackUpdateRequests, 0)
assert.deepEqual(effectTypes(unexpectedReadback), ['persist_operation', 'reserve_rollback_dispatch'])
const automaticReserved = step(unexpectedReadback.operation, {
  type: 'rollback_dispatch_reserved', result: 'reserved', at: at(6)
})
assert.equal(automaticReserved.operation.rollbackUpdateRequests, 1)
assert.deepEqual(effectTypes(automaticReserved), ['persist_operation', 'apply_rollback'])

const automaticRollbackSucceeded = step(automaticReserved.operation, {
  type: 'rollback_result',
  result: 'succeeded',
  at: at(6)
})
assert.equal(automaticRollbackSucceeded.operation.status, 'rolling_back')
const automaticRollbackVerified = step(automaticRollbackSucceeded.operation, {
  type: 'readback_result',
  result: 'matches_rollback',
  observedCanonicalSha256: manifest.workflow.rollbackCanonicalSha256,
  at: at(7)
})
assert.equal(automaticRollbackVerified.operation.status, 'rolled_back')

for (const result of ['definitively_failed', 'ambiguous', 'timed_out'] as const) {
  const rollingBack = step(reconcileApply('ambiguous'), {
    type: 'readback_result',
    result: 'unexpected_state',
    at: at(5)
  }).operation
  const reserved = step(rollingBack, { type: 'rollback_dispatch_reserved', result: 'reserved', at: at(6) })
  const decision = step(reserved.operation, { type: 'rollback_result', result, at: at(7) })
  assert.equal(decision.operation.status, 'manual_intervention_required')
  assert.ok(!effectTypes(decision).includes('apply_rollback'))
}

const automaticRollbackBadReadback = step(automaticRollbackSucceeded.operation, {
  type: 'readback_result',
  result: 'unexpected_state',
  at: at(7)
})
assert.equal(automaticRollbackBadReadback.operation.status, 'manual_intervention_required')
assert.ok(!effectTypes(automaticRollbackBadReadback).includes('apply_rollback'))

const standaloneRollbackFailure = step(requestMutation(prepared('rollback')), {
  type: 'rollback_result',
  result: 'definitively_failed',
  at: at(4)
})
assert.equal(standaloneRollbackFailure.operation.status, 'failed')

for (const result of ['ambiguous', 'timed_out'] as const) {
  const uncertainRollback = step(requestMutation(prepared('rollback')), {
    type: 'rollback_result',
    result,
    at: at(4)
  })
  assert.equal(uncertainRollback.operation.status, 'reconciling')
  assert.deepEqual(effectTypes(uncertainRollback), ['persist_operation', 'readback_workflow'])
  const unchanged = step(uncertainRollback.operation, {
    type: 'readback_result',
    result: 'matches_pre_mutation',
    at: at(5)
  })
  assert.equal(unchanged.operation.status, 'failed')
  assert.ok(!effectTypes(unchanged).includes('apply_rollback'))
}

const rollbackUnavailable = step(
  step(requestMutation(prepared('rollback')), { type: 'rollback_result', result: 'ambiguous', at: at(4) }).operation,
  { type: 'readback_result', result: 'unavailable', at: at(5) }
)
assert.equal(rollbackUnavailable.operation.status, 'manual_intervention_required')

const automaticRollbackNotAttempted = step(automaticReserved.operation, {
  type: 'rollback_result',
  result: 'not_attempted',
  at: at(6)
})
assert.equal(automaticRollbackNotAttempted.operation.status, 'manual_intervention_required')

const staleRunning = requestMutation(prepared('apply'))
const staleDecision = step(staleRunning, { type: 'lease_expired', at: at(10) })
assert.equal(staleDecision.operation.status, 'reconciling')
assert.deepEqual(effectTypes(staleDecision), ['persist_operation', 'read_live_workflow'])
assert.ok(!effectTypes(staleDecision).includes('apply_candidate'))

const resumedReconciliation = step(staleDecision.operation, { type: 'recovery_resume', at: at(11) })
assert.deepEqual(effectTypes(resumedReconciliation), ['persist_operation', 'readback_workflow'])
assert.equal(resumedReconciliation.operation.status, 'reconciling')
assert.equal(resumedReconciliation.operation.readbackRequests, staleDecision.operation.readbackRequests + 1)

const recoveredCandidate = step({ ...staleDecision.operation, evidence: { protectedDomains: 'unchanged' } }, {
  type: 'recovered_mutation_result', kind: 'candidate', result: 'succeeded', at: at(11)
})
assert.equal(recoveredCandidate.operation.status, 'reconciling')
assert.deepEqual(effectTypes(recoveredCandidate), ['persist_operation', 'readback_workflow'])

const resumedRollback = step(automaticRollbackSucceeded.operation, { type: 'recovery_resume', at: at(11) })
assert.deepEqual(effectTypes(resumedRollback), ['persist_operation', 'readback_workflow'])
const rollbackReadback = resumedRollback.effects.find(effect => effect.type === 'readback_workflow')
assert.ok(rollbackReadback && rollbackReadback.type === 'readback_workflow')
if (rollbackReadback && rollbackReadback.type === 'readback_workflow') assert.equal(rollbackReadback.expected, 'rollback')

const resumedReconciledRollback = step({ ...automaticRollbackSucceeded.operation, status: 'reconciling' }, { type: 'recovery_resume', at: at(12) })
const reconciledRollbackReadback = resumedReconciledRollback.effects.find(effect => effect.type === 'readback_workflow')
assert.ok(reconciledRollbackReadback && reconciledRollbackReadback.type === 'readback_workflow')
if (reconciledRollbackReadback && reconciledRollbackReadback.type === 'readback_workflow') assert.equal(reconciledRollbackReadback.expected, 'rollback')
const recoveredRollbackConfirmed = step(resumedReconciledRollback.operation, { type: 'readback_result', result: 'matches_rollback', at: at(13), protectedDomains: 'unchanged' })
assert.equal(recoveredRollbackConfirmed.operation.status, 'rolled_back')
assert.deepEqual(effectTypes(recoveredRollbackConfirmed), ['persist_operation', 'release_lease'])
const recoveredRollbackMismatch = step(resumedReconciledRollback.operation, { type: 'readback_result', result: 'unexpected_state', at: at(13), protectedDomains: 'unchanged' })
assert.equal(recoveredRollbackMismatch.operation.status, 'manual_intervention_required')

const ambiguousRollbackRecovery = step({
  ...automaticReserved.operation,
  status: 'reconciling',
  evidence: { protectedDomains: 'unchanged', rollbackResult: 'ambiguous' }
}, { type: 'recovery_resume', at: at(12) })
const ambiguousRollbackReadback = ambiguousRollbackRecovery.effects.find(effect => effect.type === 'readback_workflow')
assert.ok(ambiguousRollbackReadback && ambiguousRollbackReadback.type === 'readback_workflow')
if (ambiguousRollbackReadback && ambiguousRollbackReadback.type === 'readback_workflow') assert.equal(ambiguousRollbackReadback.expected, 'approved_state')

const queuedOperation = queue(prepared('apply'))
const replay = step(queuedOperation, { type: 'confirmation_result', result: 'replayed', at: at(2) })
assert.equal(replay.accepted, false)
assert.equal(replay.operation.status, 'queued')
assert.deepEqual(effectTypes(replay), ['none'])

const terminalStatuses: ControlledWorkflowMigrationStatus[] = [
  'completed',
  'rolled_back',
  'failed',
  'manual_intervention_required',
  'expired'
]
for (const status of terminalStatuses) {
  const terminal = { ...prepared('apply'), status }
  const decision = step(terminal, { type: 'lease_result', result: 'acquired', at: at(20) })
  assert.equal(decision.operation.status, status)
  assert.equal(decision.reasonCode, 'TERMINAL_STATE')
  assert.deepEqual(effectTypes(decision), ['none'])
}

const repeatMutation = step(reconcileApply('ambiguous'), { type: 'mutation_result', result: 'succeeded', at: at(5) })
assert.equal(repeatMutation.accepted, false)
assert.deepEqual(effectTypes(repeatMutation), ['none'])

const secretBearingOperation = {
  ...applyCompleted.operation,
  confirmationTokenHash: 'confirmation-hash-must-not-project',
  lease: {
    leaseProof: 'lease-proof-must-not-project',
    owner: 'worker-1',
    acquiredAt: at(1),
    expiresAt: at(30)
  },
  credentials: { reference: 'credential-must-not-project' },
  rawWorkflowJson: { id: 'workflow-1', payload: 'raw-workflow-must-not-project' },
  rawWrapperOutput: 'wrapper-output-must-not-project',
  evidence: {
    ...applyCompleted.operation.evidence,
    observedCanonicalSha256: manifest.workflow.candidateCanonicalSha256,
    durationMs: 1_000_000
  }
}
const projection = projectControlledWorkflowMigrationStatus(secretBearingOperation)
assert.equal(projection.status, 'completed')
assert.equal(projection.durationMs, 900_000)
assert.equal(projection.canonicalHashes.observed, manifest.workflow.candidateCanonicalSha256)
const serializedProjection = JSON.stringify(projection)
for (const forbidden of [
  'confirmation-hash-must-not-project',
  'lease-proof-must-not-project',
  'credential-must-not-project',
  'raw-workflow-must-not-project',
  'wrapper-output-must-not-project'
]) {
  assert.equal(serializedProjection.includes(forbidden), false)
}

const stateSource = fs.readFileSync(path.resolve('packages/shared/src/controlled-workflow-migration-state.ts'), 'utf8')
for (const forbiddenDependency of [
  'node:fs',
  'node:path',
  'node:crypto',
  ['child', 'process'].join('_'),
  'next/',
  'react',
  'fastify',
  'relay',
  'apps/web',
  'server.ts',
  'openapi'
]) {
  assert.equal(stateSource.toLowerCase().includes(forbiddenDependency), false, `portable state must not depend on ${forbiddenDependency}`)
}
for (const unsafeEffectField of ['executable:', 'argv:', 'shell:', 'environment:']) {
  assert.equal(stateSource.includes(unsafeEffectField), false, `portable effects must not expose ${unsafeEffectField}`)
}

console.log('controlled workflow migration state verification passed')
