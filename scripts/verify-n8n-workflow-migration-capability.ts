import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { canonicalizeN8nWorkflow, hashCanonicalWorkflowTopology } from '../packages/shared/src/controlled-workflow-canonicalization'
import type { ControlledWorkflowMigrationEffect, ControlledWorkflowMigrationOperation } from '../packages/shared/src/controlled-workflow-migration-state'
import type { ControlledWorkflowTopologyManifest } from '../packages/shared/src/controlled-workflow-topology'
import type { ControlledN8nWorkflowGrant } from '../packages/cli/src/agent/capability-grants'
import {
  acquireCapabilityOperationLease,
  consumeCapabilityOperationConfirmation,
  getCapabilityOperationRecord,
  transitionCapabilityOperation
} from '../packages/cli/src/agent/capability-operation-store'
import { findCapabilityMutationDispatchRecord } from '../packages/cli/src/agent/capability-mutation-dispatch-store'
import {
  executeControlledWorkflowMigration,
  getControlledWorkflowMigrationStatus,
  prepareControlledWorkflowMigration,
  N8N_WORKFLOW_MIGRATION_MAX_ITERATIONS,
  type ControlledMigrationFailureCode,
  type ControlledMigrationCapabilityDependencies
} from '../packages/cli/src/agent/n8n-workflow-migration-capability'
import type { N8nWorkflowMigrationExecutorClassification, N8nWorkflowMigrationExecutorResult } from '../packages/cli/src/agent/n8n-workflow-migration-executor'

type Readback = 'matches_candidate' | 'matches_rollback' | 'matches_pre_mutation' | 'unexpected_state' | 'unavailable'
type EffectName = N8nWorkflowMigrationExecutorResult['effect']
type Behavior = {
  candidate?: N8nWorkflowMigrationExecutorClassification
  rollback?: N8nWorkflowMigrationExecutorClassification
  readbacks?: Readback[]
  crash?: 'before_dispatch_consume' | 'after_dispatch_consume'
  lockOperationStoreAfterMutation?: boolean
  bumpRevisionOnPrecondition?: boolean
}
type FixtureOptions = {
  candidate?: Record<string, unknown> | ((workflowId: string) => Record<string, unknown>)
  rollback?: Record<string, unknown> | ((workflowId: string) => Record<string, unknown>)
  mutateManifest?: (manifest: ControlledWorkflowTopologyManifest & Record<string, unknown>) => void
  mutateGrant?: (grant: ControlledN8nWorkflowGrant) => void
  mutateCandidateAfterManifest?: boolean
  candidateSymlink?: boolean
}

const sha = (value: Buffer | string) => crypto.createHash('sha256').update(value).digest('hex')
const roots: string[] = []
const baseWorkflow = (workflowId: string): Record<string, unknown> => ({
  id: workflowId,
  active: false,
  nodes: [{ id: 'node-1', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} }],
  connections: {},
  settings: {},
  tags: []
})

function canonicalHash(value: unknown): string {
  const canonical = canonicalizeN8nWorkflow(value)
  if (!canonical.ok) throw new Error('synthetic workflow canonicalization failed')
  return hashCanonicalWorkflowTopology(canonical.topology, sha)
}

function createFixture(options: FixtureOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-migration-capability-'))
  roots.push(root)
  const sourceId = `synthetic-source-${roots.length}`
  const workflowId = `synthetic-workflow-${roots.length}`
  const storeRoot = path.join(root, 'store')
  const candidatePath = 'operations/workflows/candidate.json'
  const rollbackPath = 'operations/artifacts/rollback.json'
  const manifestPath = 'operations/manifests/manifest.json'
  const wrapperPath = 'tools/controlled-wrapper'
  const write = (relative: string, value: string | Buffer) => {
    const target = path.join(root, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, value)
    return Buffer.isBuffer(value) ? value : Buffer.from(value)
  }
  const rollback = typeof options.rollback === 'function' ? options.rollback(workflowId) : options.rollback || baseWorkflow(workflowId)
  const candidate = typeof options.candidate === 'function' ? options.candidate(workflowId) : options.candidate || structuredClone(rollback)
  const rollbackBytes = write(rollbackPath, JSON.stringify(rollback))
  const candidateBytes = Buffer.from(JSON.stringify(candidate))
  if (options.candidateSymlink) {
    const outside = write('outside/candidate.json', candidateBytes)
    void outside
    fs.mkdirSync(path.dirname(path.join(root, candidatePath)), { recursive: true })
    fs.symlinkSync(path.join(root, 'outside/candidate.json'), path.join(root, candidatePath))
  } else {
    write(candidatePath, candidateBytes)
  }
  const wrapperBytes = write(wrapperPath, '#!/bin/sh\nexit 1\n')
  const manifest = {
    schemaVersion: 1,
    kind: 'n8n-controlled-topology-migration',
    workflow: {
      id: workflowId,
      canonicalizationVersion: 1,
      expectedLiveCanonicalSha256: canonicalHash(rollback),
      candidateCanonicalSha256: canonicalHash(candidate),
      rollbackCanonicalSha256: canonicalHash(rollback)
    },
    artifacts: {
      candidatePath,
      candidateSha256: sha(candidateBytes),
      rollbackPath,
      rollbackSha256: sha(rollbackBytes)
    },
    invariants: {
      activation: 'unchanged', settings: 'unchanged', tags: 'unchanged', sharing: 'unchanged',
      credentials: 'unchanged', webhooks: 'unchanged', schedules: 'unchanged'
    },
    nodes: { add: [], remove: [], modify: [] },
    connections: { add: [], remove: [] },
    routes: { required: [], forbidden: [] }
  } as ControlledWorkflowTopologyManifest & Record<string, unknown>
  options.mutateManifest?.(manifest)
  write(manifestPath, JSON.stringify(manifest))
  if (options.mutateCandidateAfterManifest && !options.candidateSymlink) {
    write(candidatePath, JSON.stringify({ ...candidate, changedAfterManifest: true }))
  }
  const grant: ControlledN8nWorkflowGrant = {
    grantId: `synthetic-grant-${roots.length}`,
    version: 1,
    enabled: true,
    sourceId,
    workflowId,
    wrapperPath,
    wrapperSha256: sha(wrapperBytes),
    allowedCandidateRoots: ['operations/workflows'],
    allowedRollbackRoots: ['operations/artifacts'],
    allowedManifestRoots: ['operations/manifests'],
    canonicalizationVersion: 1,
    confirmationTtlSeconds: 600,
    operationTimeoutMs: 12_000,
    maxArtifactBytes: 600_000,
    maximumPolicy: {
      activation: 'unchanged', settings: 'unchanged', tags: 'unchanged', sharing: 'unchanged',
      credentials: 'unchanged', webhooks: 'unchanged', schedules: 'unchanged'
    }
  }
  options.mutateGrant?.(grant)
  let nowMs = Date.parse('2026-07-14T12:00:00.000Z')
  let randomCounter = 0
  const behavior: Behavior = {}
  const effects: string[] = []
  let executorCalls = 0
  const operationStore = { rootDir: storeRoot }
  const dispatchStore = {
    rootDir: storeRoot,
    now: () => new Date(nowMs),
    randomBytes: (size: number) => Buffer.alloc(size, 17)
  }

  const result = (
    effect: ControlledWorkflowMigrationEffect,
    operation: ControlledWorkflowMigrationOperation,
    classification: N8nWorkflowMigrationExecutorClassification,
    readbackResult?: Readback
  ): N8nWorkflowMigrationExecutorResult => {
    const effectName = effect.type as EffectName
    const observedCanonicalSha256 = readbackResult === 'matches_candidate'
      ? operation.binding.candidateCanonicalSha256
      : readbackResult === 'matches_rollback'
        ? operation.binding.rollbackCanonicalSha256
        : operation.binding.expectedLiveCanonicalSha256
    return {
      effect: effectName,
      classification,
      workflowId,
      operationId: operation.operationId,
      durationMs: 1,
      stdoutBytes: 0,
      stderrBytes: 0,
      outputTruncated: false,
      responseParsed: true,
      ...(readbackResult ? { readbackResult, observedCanonicalSha256 } : {}),
      ...(effect.type === 'read_live_workflow' ? { readPurpose: effect.purpose } : {}),
      protectedDomains: 'unchanged',
      reasonCode: classification === 'succeeded' ? 'READ_SUCCEEDED' : classification === 'timed_out' ? 'PROCESS_TIMED_OUT' : classification === 'ambiguous' ? 'PROCESS_AMBIGUOUS' : classification === 'blocked' ? 'INVALID_INVOCATION' : 'PROCESS_DEFINITIVE_FAILURE',
      reason: 'synthetic bounded result',
      issues: []
    }
  }

  const deps: ControlledMigrationCapabilityDependencies = {
    getSource: id => id === sourceId ? { sourceId, rootPath: root, rootFingerprint: sha(root), enabled: true } : undefined,
    getGrants: () => [grant],
    operationStore,
    dispatchStore,
    now: () => new Date(nowMs += 10),
    randomBytes: size => Buffer.alloc(size, ++randomCounter),
    executor: async input => {
      executorCalls += 1
      effects.push(input.effect.type)
      const persisted = getCapabilityOperationRecord(input.operation.operationId, operationStore)
      assert.ok(persisted && !('ok' in persisted), 'operation must be persisted before every side effect')
      if (!persisted || 'ok' in persisted) throw new Error('persisted operation missing')
      if (input.effect.type === 'read_live_workflow') {
        assert.equal(persisted.status, 'running')
        assert.ok(persisted.readbackRequests >= 1)
        if (behavior.bumpRevisionOnPrecondition) {
          const bumped = transitionCapabilityOperation({
            operationId: persisted.operationId,
            sourceId,
            workflowId,
            expectedStatus: persisted.status,
            expectedRevision: persisted.revision,
            next: persisted,
            leaseProof: persisted.lease?.leaseProof,
            now: new Date(nowMs),
            store: operationStore
          })
          assert.equal(bumped.ok, true)
          behavior.bumpRevisionOnPrecondition = false
        }
        return result(input.effect, input.operation, 'succeeded', 'matches_pre_mutation')
      }
      if (input.effect.type === 'apply_candidate' || input.effect.type === 'apply_rollback') {
        const kind = input.effect.type === 'apply_candidate' ? 'candidate' : 'rollback'
        assert.equal(kind === 'candidate' ? persisted.candidateUpdateRequests : persisted.rollbackUpdateRequests, 1)
        if (behavior.crash === 'before_dispatch_consume') throw new Error('synthetic crash before dispatch consumption')
        const consumed = input.consumeMutationDispatch?.({
          operationId: input.operation.operationId,
          sourceId,
          workflowId,
          kind,
          artifactSha256: input.effect.artifactSha256,
          wrapperSha256: grant.wrapperSha256
        })
        assert.equal(consumed?.ok, true)
        const dispatch = findCapabilityMutationDispatchRecord(input.operation.operationId, kind, dispatchStore)
        assert.ok(dispatch && !('ok' in dispatch))
        if (dispatch && !('ok' in dispatch)) assert.equal(dispatch.status, 'dispatched')
        if (behavior.crash === 'after_dispatch_consume') throw new Error('synthetic crash after dispatch consumption')
        if (behavior.lockOperationStoreAfterMutation) {
          fs.writeFileSync(path.join(storeRoot, 'workbench-capability-operations.json.lock'), 'synthetic-lock')
          behavior.lockOperationStoreAfterMutation = false
        }
        return result(input.effect, input.operation, kind === 'candidate' ? behavior.candidate || 'succeeded' : behavior.rollback || 'succeeded')
      }
      const readback = behavior.readbacks?.shift()
        || (input.operation.binding.mode === 'rollback' ? 'matches_rollback' : 'matches_candidate')
      return result(input.effect, input.operation, readback === 'unavailable' ? 'definitively_failed' : 'succeeded', readback)
    }
  }

  return {
    root, sourceId, workflowId, storeRoot, candidatePath, rollbackPath, manifestPath, wrapperPath,
    grant, manifest, behavior, effects, deps, operationStore, dispatchStore,
    executorCalls: () => executorCalls,
    advance: (milliseconds: number) => { nowMs += milliseconds },
    request: (mode: 'apply' | 'rollback') => ({ sourceId, workflowId, mode, candidatePath, rollbackPath, manifestPath })
  }
}

async function prepareOrThrow(fixture: ReturnType<typeof createFixture>, mode: 'apply' | 'rollback' = 'apply') {
  const prepared = await prepareControlledWorkflowMigration(fixture.request(mode), fixture.deps)
  assert.equal(prepared.ok, true)
  if (!prepared.ok) throw new Error(prepared.error.message)
  return prepared
}

async function executePrepared(fixture: ReturnType<typeof createFixture>, mode: 'apply' | 'rollback' = 'apply') {
  const prepared = await prepareOrThrow(fixture, mode)
  const executed = await executeControlledWorkflowMigration({
    sourceId: fixture.sourceId,
    operationId: prepared.operation.operationId,
    mode,
    confirmationToken: prepared.confirmationToken
  }, fixture.deps)
  return { prepared, executed }
}

async function main() {
  assert.equal(N8N_WORKFLOW_MIGRATION_MAX_ITERATIONS, 16)

  const valid = createFixture()
  const prepared = await prepareOrThrow(valid)
  assert.equal(prepared.status, 'needs_confirmation')
  assert.ok(JSON.stringify(prepared).length < 5_000)
  const operationFile = fs.readFileSync(path.join(valid.storeRoot, 'workbench-capability-operations.json'), 'utf8')
  assert.equal(operationFile.includes(prepared.confirmationToken), false)
  const status = getControlledWorkflowMigrationStatus({ sourceId: valid.sourceId, operationId: prepared.operation.operationId }, valid.deps)
  assert.equal(status.ok, true)
  assert.equal(valid.executorCalls(), 0)
  assert.equal((await prepareOrThrow(createFixture(), 'rollback')).operation.mode, 'rollback')

  const prepareFailures: Array<[string, ControlledMigrationFailureCode, ReturnType<typeof createFixture>, Parameters<typeof prepareControlledWorkflowMigration>[0], Partial<ControlledMigrationCapabilityDependencies> | undefined]> = []
  const missingGrant = createFixture()
  prepareFailures.push(['missing grant', 'capability_not_configured', missingGrant, missingGrant.request('apply'), { getGrants: () => [] }])
  const wrongSource = createFixture()
  prepareFailures.push(['wrong source', 'source_not_found', wrongSource, { ...wrongSource.request('apply'), sourceId: 'missing-source' }, undefined])
  const wrongWorkflow = createFixture()
  prepareFailures.push(['wrong workflow', 'grant_not_found', wrongWorkflow, { ...wrongWorkflow.request('apply'), workflowId: 'wrong-workflow' }, undefined])
  const badGrantVersion = createFixture({ mutateGrant: grant => { grant.version = 0 } })
  prepareFailures.push(['wrong grant version', 'grant_mismatch', badGrantVersion, badGrantVersion.request('apply'), undefined])
  const badWrapperDigest = createFixture({ mutateGrant: grant => { grant.wrapperSha256 = '0'.repeat(64) } })
  prepareFailures.push(['wrapper digest', 'grant_mismatch', badWrapperDigest, badWrapperDigest.request('apply'), undefined])
  const invalidContract = createFixture()
  prepareFailures.push(['wrapper contract', 'grant_mismatch', invalidContract, invalidContract.request('apply'), { wrapperContract: {} }])
  const outsideRoot = createFixture()
  prepareFailures.push(['outside root', 'artifact_invalid', outsideRoot, { ...outsideRoot.request('apply'), candidatePath: 'operations/artifacts/rollback.json' }, undefined])
  const symlink = createFixture({ candidateSymlink: true })
  prepareFailures.push(['symlink', 'artifact_invalid', symlink, symlink.request('apply'), undefined])
  const oversized = createFixture({ candidate: { ...baseWorkflow('placeholder'), padding: 'x'.repeat(5_000) }, mutateGrant: grant => { grant.maxArtifactBytes = 1024 } })
  prepareFailures.push(['oversized', 'artifact_invalid', oversized, oversized.request('apply'), undefined])
  const artifactMismatch = createFixture({ mutateCandidateAfterManifest: true })
  prepareFailures.push(['artifact hash', 'manifest_invalid', artifactMismatch, artifactMismatch.request('apply'), undefined])
  const manifestHashMismatch = createFixture({ mutateManifest: manifest => { manifest.artifacts.rollbackSha256 = '0'.repeat(64) } })
  prepareFailures.push(['manifest hash', 'manifest_invalid', manifestHashMismatch, manifestHashMismatch.request('apply'), undefined])
  const canonicalMismatch = createFixture({ mutateManifest: manifest => { manifest.workflow.candidateCanonicalSha256 = '0'.repeat(64) } })
  prepareFailures.push(['canonical hash', 'canonicalization_failed', canonicalMismatch, canonicalMismatch.request('apply'), undefined])
  const invalidManifest = createFixture({ mutateManifest: manifest => { manifest.unexpected = true } })
  prepareFailures.push(['strict manifest', 'manifest_invalid', invalidManifest, invalidManifest.request('apply'), undefined])
  const undeclared = createFixture({ candidate: workflowId => {
    const value = baseWorkflow(workflowId)
    ;(value.nodes as Array<Record<string, unknown>>).push({ id: 'node-2', name: 'Extra', type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {} })
    return value
  } })
  prepareFailures.push(['undeclared topology', 'manifest_invalid', undeclared, undeclared.request('apply'), undefined])
  const protectedChange = createFixture({ candidate: workflowId => ({ ...baseWorkflow(workflowId), settings: { executionOrder: 'v1' } }) })
  prepareFailures.push(['protected domain', 'manifest_invalid', protectedChange, protectedChange.request('apply'), undefined])
  for (const [name, expectedCode, fixture, request, override] of prepareFailures) {
    const rejected = await prepareControlledWorkflowMigration(request, { ...fixture.deps, ...override })
    assert.equal(rejected.ok, false, name)
    if (!rejected.ok) assert.equal(rejected.error.code, expectedCode, name)
    assert.equal(fixture.executorCalls(), 0, name)
  }

  const confirmation = createFixture()
  const confirmationPrepared = await prepareOrThrow(confirmation)
  const required = await executeControlledWorkflowMigration({ sourceId: confirmation.sourceId, operationId: confirmationPrepared.operation.operationId, mode: 'apply' }, confirmation.deps)
  assert.equal(required.ok, false)
  if (!required.ok) assert.equal(required.error.code, 'confirmation_required')
  const invalid = await executeControlledWorkflowMigration({ sourceId: confirmation.sourceId, operationId: confirmationPrepared.operation.operationId, mode: 'apply', confirmationToken: 'invalid' }, confirmation.deps)
  assert.equal(invalid.ok, false)
  assert.equal(confirmation.executorCalls(), 0)

  const expired = createFixture()
  const expiredPrepared = await prepareOrThrow(expired)
  expired.advance(700_000)
  const expiredResult = await executeControlledWorkflowMigration({ sourceId: expired.sourceId, operationId: expiredPrepared.operation.operationId, mode: 'apply', confirmationToken: expiredPrepared.confirmationToken }, expired.deps)
  assert.equal(expiredResult.ok, false)
  if (!expiredResult.ok) assert.equal(expiredResult.error.code, 'confirmation_expired')
  assert.equal(expired.executorCalls(), 0)

  const changedGrant = createFixture()
  const changedGrantPrepared = await prepareOrThrow(changedGrant)
  changedGrant.grant.version += 1
  const changedGrantResult = await executeControlledWorkflowMigration({ sourceId: changedGrant.sourceId, operationId: changedGrantPrepared.operation.operationId, mode: 'apply', confirmationToken: changedGrantPrepared.confirmationToken }, changedGrant.deps)
  assert.equal(changedGrantResult.ok, false)
  if (!changedGrantResult.ok) assert.equal(changedGrantResult.error.code, 'grant_mismatch')
  assert.equal(changedGrant.executorCalls(), 0)

  const successful = createFixture()
  const success = await executePrepared(successful)
  assert.equal(success.executed.ok, true)
  if (success.executed.ok) assert.equal(success.executed.status, 'completed')
  assert.equal(successful.effects.filter(effect => effect === 'apply_candidate').length, 1)
  const candidateDispatch = findCapabilityMutationDispatchRecord(success.prepared.operation.operationId, 'candidate', successful.dispatchStore)
  assert.ok(candidateDispatch && !('ok' in candidateDispatch))
  if (candidateDispatch && !('ok' in candidateDispatch)) {
    assert.equal(candidateDispatch.status, 'outcome_recorded')
    assert.equal(candidateDispatch.outcome, 'succeeded')
  }
  const replay = await executeControlledWorkflowMigration({ sourceId: successful.sourceId, operationId: success.prepared.operation.operationId, mode: 'apply', confirmationToken: success.prepared.confirmationToken }, successful.deps)
  assert.equal(replay.ok, false)
  if (!replay.ok) assert.equal(replay.error.code, 'confirmation_replayed')
  const terminalReplay = await executeControlledWorkflowMigration({ sourceId: successful.sourceId, operationId: success.prepared.operation.operationId, mode: 'apply' }, successful.deps)
  assert.equal(terminalReplay.ok, false)
  if (!terminalReplay.ok) assert.equal(terminalReplay.error.code, 'operation_conflict')
  assert.equal(successful.effects.filter(effect => effect === 'apply_candidate').length, 1)

  for (const classification of ['definitively_failed', 'ambiguous', 'timed_out'] as const) {
    const fixture = createFixture()
    fixture.behavior.candidate = classification
    fixture.behavior.readbacks = ['matches_pre_mutation']
    const run = await executePrepared(fixture)
    assert.equal(run.executed.ok, true, classification)
    if (run.executed.ok) assert.equal(run.executed.status, 'failed', classification)
    assert.equal(fixture.effects.filter(effect => effect === 'apply_candidate').length, 1)
  }

  const automaticRollback = createFixture()
  automaticRollback.behavior.readbacks = ['unexpected_state', 'matches_rollback']
  const automatic = await executePrepared(automaticRollback)
  assert.equal(automatic.executed.ok, true)
  if (automatic.executed.ok) assert.equal(automatic.executed.status, 'rolled_back')
  assert.equal(automaticRollback.effects.filter(effect => effect === 'apply_candidate').length, 1)
  assert.equal(automaticRollback.effects.filter(effect => effect === 'apply_rollback').length, 1)

  for (const classification of ['definitively_failed', 'ambiguous', 'timed_out'] as const) {
    const fixture = createFixture()
    fixture.behavior.readbacks = ['unexpected_state']
    fixture.behavior.rollback = classification
    const run = await executePrepared(fixture)
    assert.equal(run.executed.ok, true, `automatic rollback ${classification}`)
    if (run.executed.ok) assert.equal(run.executed.status, 'manual_intervention_required', classification)
    assert.equal(fixture.effects.filter(effect => effect === 'apply_rollback').length, 1)
  }

  const standaloneRollback = createFixture()
  const rolledBack = await executePrepared(standaloneRollback, 'rollback')
  assert.equal(rolledBack.executed.ok, true)
  if (rolledBack.executed.ok) assert.equal(rolledBack.executed.status, 'rolled_back')
  assert.equal(standaloneRollback.effects.filter(effect => effect === 'apply_rollback').length, 1)

  const leaseConflict = createFixture()
  const firstLease = await prepareOrThrow(leaseConflict)
  const secondLease = await prepareOrThrow(leaseConflict)
  const leaseNow = new Date('2026-07-14T12:00:01.000Z')
  const consumed = consumeCapabilityOperationConfirmation({ operationId: firstLease.operation.operationId, confirmationToken: firstLease.confirmationToken, now: leaseNow, store: leaseConflict.operationStore })
  assert.equal(consumed.ok, true)
  const held = acquireCapabilityOperationLease({ operationId: firstLease.operation.operationId, owner: 'synthetic-holder', leaseMs: 60_000, now: leaseNow, store: leaseConflict.operationStore })
  assert.equal(held.ok, true)
  if (!held.ok) throw new Error(held.message)
  const heldRecord = getCapabilityOperationRecord(firstLease.operation.operationId, leaseConflict.operationStore)
  assert.ok(heldRecord && !('ok' in heldRecord))
  if (!heldRecord || 'ok' in heldRecord) throw new Error('held operation was not available')
  const reconcilingLease = transitionCapabilityOperation({
    operationId: heldRecord.operationId,
    sourceId: heldRecord.binding.sourceId,
    workflowId: heldRecord.binding.workflowId,
    expectedStatus: 'running',
    expectedRevision: heldRecord.revision,
    next: { ...heldRecord, status: 'reconciling', reasonCode: 'PROCESS_AMBIGUOUS', evidence: { protectedDomains: 'unverified' } },
    leaseProof: held.leaseProof,
    now: leaseNow,
    store: leaseConflict.operationStore
  })
  assert.equal(reconcilingLease.ok, true)
  const recoveryConflict = await executeControlledWorkflowMigration({ sourceId: leaseConflict.sourceId, operationId: firstLease.operation.operationId, mode: 'apply' }, leaseConflict.deps)
  assert.equal(recoveryConflict.ok, false)
  if (!recoveryConflict.ok) assert.equal(recoveryConflict.error.code, 'lease_conflict')
  const conflict = await executeControlledWorkflowMigration({ sourceId: leaseConflict.sourceId, operationId: secondLease.operation.operationId, mode: 'apply', confirmationToken: secondLease.confirmationToken }, leaseConflict.deps)
  assert.equal(conflict.ok, false)
  if (!conflict.ok) assert.equal(conflict.error.code, 'lease_conflict')
  assert.equal(leaseConflict.executorCalls(), 0)
  leaseConflict.advance(400_000)
  const resumedQueued = await executeControlledWorkflowMigration({ sourceId: leaseConflict.sourceId, operationId: secondLease.operation.operationId, mode: 'apply' }, leaseConflict.deps)
  assert.equal(resumedQueued.ok, true)
  if (resumedQueued.ok) assert.equal(resumedQueued.status, 'completed')

  const longMutation = createFixture({ mutateGrant: grant => { grant.operationTimeoutMs = 900_000 } })
  const longPrepared = await prepareOrThrow(longMutation)
  const originalExecutor = longMutation.deps.executor
  let releaseCandidate!: () => void
  let candidateEntered!: () => void
  const candidateGate = new Promise<void>(resolve => { releaseCandidate = resolve })
  const candidateStarted = new Promise<void>(resolve => { candidateEntered = resolve })
  longMutation.deps.executor = async input => {
    if (input.effect.type === 'apply_candidate') {
      candidateEntered()
      await candidateGate
    }
    return originalExecutor(input)
  }
  const firstInvocation = executeControlledWorkflowMigration({ sourceId: longMutation.sourceId, operationId: longPrepared.operation.operationId, mode: 'apply', confirmationToken: longPrepared.confirmationToken }, longMutation.deps)
  await candidateStarted
  longMutation.advance(400_000)
  const concurrentInvocation = await executeControlledWorkflowMigration({ sourceId: longMutation.sourceId, operationId: longPrepared.operation.operationId, mode: 'apply' }, longMutation.deps)
  assert.equal(concurrentInvocation.ok, false)
  if (!concurrentInvocation.ok) assert.equal(concurrentInvocation.error.code, 'lease_conflict')
  releaseCandidate()
  const longResult = await firstInvocation
  assert.equal(longResult.ok, true)
  if (longResult.ok) assert.equal(longResult.status, 'completed')
  assert.equal(longMutation.effects.filter(effect => effect === 'apply_candidate').length, 1)
  assert.equal(longMutation.effects.filter(effect => effect === 'apply_rollback').length, 0)

  const staleRevision = createFixture()
  staleRevision.behavior.bumpRevisionOnPrecondition = true
  const staleRun = await executePrepared(staleRevision)
  assert.equal(staleRun.executed.ok, false)
  if (!staleRun.executed.ok) assert.equal(staleRun.executed.error.code, 'operation_conflict')
  assert.equal(staleRevision.effects.includes('apply_candidate'), false)

  for (const crashPoint of ['before_dispatch_consume', 'after_dispatch_consume'] as const) {
    const fixture = createFixture()
    fixture.behavior.crash = crashPoint
    const crashPrepared = await prepareOrThrow(fixture)
    await assert.rejects(executeControlledWorkflowMigration({ sourceId: fixture.sourceId, operationId: crashPrepared.operation.operationId, mode: 'apply', confirmationToken: crashPrepared.confirmationToken }, fixture.deps))
    const dispatch = findCapabilityMutationDispatchRecord(crashPrepared.operation.operationId, 'candidate', fixture.dispatchStore)
    assert.ok(dispatch && !('ok' in dispatch))
    if (dispatch && !('ok' in dispatch)) assert.equal(dispatch.status, crashPoint === 'before_dispatch_consume' ? 'reserved' : 'dispatched')
    fixture.behavior.crash = undefined
    fixture.behavior.readbacks = ['matches_pre_mutation']
    fixture.advance(400_000)
    const recovered = await executeControlledWorkflowMigration({ sourceId: fixture.sourceId, operationId: crashPrepared.operation.operationId, mode: 'apply' }, fixture.deps)
    assert.equal(recovered.ok, true)
    if (recovered.ok) assert.equal(recovered.status, 'failed')
    assert.equal(fixture.effects.filter(effect => effect === 'apply_candidate').length, 1)
  }

  const recordedBeforeTransition = createFixture()
  recordedBeforeTransition.behavior.lockOperationStoreAfterMutation = true
  const recordedPrepared = await prepareOrThrow(recordedBeforeTransition)
  const interrupted = await executeControlledWorkflowMigration({ sourceId: recordedBeforeTransition.sourceId, operationId: recordedPrepared.operation.operationId, mode: 'apply', confirmationToken: recordedPrepared.confirmationToken }, recordedBeforeTransition.deps)
  assert.equal(interrupted.ok, false)
  const recordedDispatch = findCapabilityMutationDispatchRecord(recordedPrepared.operation.operationId, 'candidate', recordedBeforeTransition.dispatchStore)
  assert.ok(recordedDispatch && !('ok' in recordedDispatch))
  if (recordedDispatch && !('ok' in recordedDispatch)) assert.equal(recordedDispatch.status, 'outcome_recorded')
  fs.rmSync(path.join(recordedBeforeTransition.storeRoot, 'workbench-capability-operations.json.lock'), { force: true })
  recordedBeforeTransition.advance(400_000)
  recordedBeforeTransition.behavior.readbacks = ['matches_candidate']
  const resumedRecorded = await executeControlledWorkflowMigration({ sourceId: recordedBeforeTransition.sourceId, operationId: recordedPrepared.operation.operationId, mode: 'apply' }, recordedBeforeTransition.deps)
  assert.equal(resumedRecorded.ok, true)
  if (resumedRecorded.ok) assert.equal(resumedRecorded.status, 'completed')
  assert.equal(recordedBeforeTransition.effects.filter(effect => effect === 'apply_candidate').length, 1)

  const sourceChanged = createFixture()
  const sourcePrepared = await prepareOrThrow(sourceChanged)
  const sourceMismatchDeps = { ...sourceChanged.deps, getSource: (id: string) => id === sourceChanged.sourceId ? { sourceId: id, rootPath: sourceChanged.root, rootFingerprint: '0'.repeat(64), enabled: true } : undefined }
  assert.equal(getControlledWorkflowMigrationStatus({ sourceId: sourceChanged.sourceId, operationId: sourcePrepared.operation.operationId }, sourceMismatchDeps).ok, false)
  const sourceMismatchExecute = await executeControlledWorkflowMigration({ sourceId: sourceChanged.sourceId, operationId: sourcePrepared.operation.operationId, mode: 'apply', confirmationToken: sourcePrepared.confirmationToken }, sourceMismatchDeps)
  assert.equal(sourceMismatchExecute.ok, false)
  assert.equal(sourceChanged.executorCalls(), 0)

  const operationCorrupt = createFixture()
  const operationCorruptPrepared = await prepareOrThrow(operationCorrupt)
  fs.writeFileSync(path.join(operationCorrupt.storeRoot, 'workbench-capability-operations.json'), '{')
  const operationCorruptResult = await executeControlledWorkflowMigration({ sourceId: operationCorrupt.sourceId, operationId: operationCorruptPrepared.operation.operationId, mode: 'apply', confirmationToken: operationCorruptPrepared.confirmationToken }, operationCorrupt.deps)
  assert.equal(operationCorruptResult.ok, false)
  if (!operationCorruptResult.ok) assert.equal(operationCorruptResult.error.code, 'operation_store_corrupt')
  assert.equal(operationCorrupt.executorCalls(), 0)

  const dispatchCorrupt = createFixture()
  const dispatchCorruptPrepared = await prepareOrThrow(dispatchCorrupt)
  fs.mkdirSync(dispatchCorrupt.storeRoot, { recursive: true })
  fs.writeFileSync(path.join(dispatchCorrupt.storeRoot, 'workbench-capability-mutation-dispatches.json'), '{')
  const dispatchCorruptResult = await executeControlledWorkflowMigration({ sourceId: dispatchCorrupt.sourceId, operationId: dispatchCorruptPrepared.operation.operationId, mode: 'apply', confirmationToken: dispatchCorruptPrepared.confirmationToken }, dispatchCorrupt.deps)
  assert.equal(dispatchCorruptResult.ok, false)
  if (!dispatchCorruptResult.ok) assert.equal(dispatchCorruptResult.error.code, 'dispatch_store_corrupt')
  assert.equal(dispatchCorrupt.executorCalls(), 0)

  const publicText = JSON.stringify([prepared, status, success.executed, rolledBack.executed, resumedRecorded])
  for (const forbidden of [
    'confirmationTokenHash', 'leaseProof', 'authorizationDigest', 'dispatch-', '#!/bin/sh',
    'API_KEY', 'Authorization:', 'stderr', 'stdout', 'process.env', 'synthetic bounded result',
    JSON.stringify(baseWorkflow(valid.workflowId))
  ]) assert.equal(publicText.includes(forbidden), false, forbidden)

  console.log('n8n workflow migration capability verification passed')
}

main().finally(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})
