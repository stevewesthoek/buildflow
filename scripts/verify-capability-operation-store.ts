import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  acquireCapabilityOperationLease,
  consumeCapabilityOperationConfirmation,
  createPreparedCapabilityOperation,
  getCompactCapabilityOperation,
  getCapabilityOperationRecord,
  releaseCapabilityOperationLease,
  renewCapabilityOperationLease,
  transitionCapabilityOperation
} from '../packages/cli/src/agent/capability-operation-store'

function main() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-capability-store-'))
  const store = { rootDir }
  const hash = 'a'.repeat(64)
  const binding = {
    sourceId: 'example-source',
    sourceRootFingerprint: hash,
    grantId: 'grant-1',
    grantVersion: 1,
    workflowId: 'workflow-1',
    mode: 'apply' as const,
    candidatePath: 'operations/candidate.json',
    candidateSha256: hash,
    rollbackPath: 'operations/rollback.json',
    rollbackSha256: hash,
    manifestPath: 'operations/manifest.json',
    manifestSha256: hash,
    wrapperPath: 'tools/n8n-api.sh',
    wrapperSha256: hash,
    canonicalizationVersion: 1 as const,
    candidateCanonicalSha256: hash,
    rollbackCanonicalSha256: hash,
    expectedLiveCanonicalSha256: hash
  }
  const now = new Date('2026-01-01T00:00:00.000Z')
  try {
    const prepared = createPreparedCapabilityOperation({ binding, confirmationTtlSeconds: 600, now, store })
    assert.equal(prepared.ok, true)
    if (!prepared.ok) throw new Error(prepared.message)
    assert.equal(prepared.operation.status, 'prepared')
    assert.equal(prepared.operation.revision, 0)
    assert.equal('confirmationTokenHash' in prepared.operation, false)
    assert.ok(prepared.confirmationToken.length >= 40)
    const preparedStatus = getCompactCapabilityOperation(prepared.operation.operationId, store)
    assert.ok(preparedStatus && !('ok' in preparedStatus))
    if (preparedStatus && !('ok' in preparedStatus)) assert.equal(preparedStatus.status, 'prepared')
    const privateOperation = getCapabilityOperationRecord(prepared.operation.operationId, store)
    assert.ok(privateOperation && !('ok' in privateOperation)); if (privateOperation && !('ok' in privateOperation)) assert.equal(typeof privateOperation.confirmationTokenHash, 'string')
    const storedPayload = fs.readFileSync(path.join(rootDir, 'workbench-capability-operations.json'), 'utf8')
    assert.equal(storedPayload.includes(prepared.confirmationToken), false)
    const invalid = consumeCapabilityOperationConfirmation({ operationId: prepared.operation.operationId, confirmationToken: 'wrong-token', now: new Date(now.getTime() + 1000), store })
    assert.equal(invalid.ok, false)
    if (!invalid.ok) assert.equal(invalid.code, 'CAPABILITY_OPERATION_CONFIRMATION_INVALID')
    const consumed = consumeCapabilityOperationConfirmation({ operationId: prepared.operation.operationId, confirmationToken: prepared.confirmationToken, now: new Date(now.getTime() + 2000), store })
    assert.equal(consumed.ok, true)
    if (!consumed.ok) throw new Error(consumed.message)
    assert.equal(consumed.operation.status, 'queued')
    assert.equal(consumed.operation.revision, 1)
    const replay = consumeCapabilityOperationConfirmation({ operationId: prepared.operation.operationId, confirmationToken: prepared.confirmationToken, now: new Date(now.getTime() + 3000), store })
    assert.equal(replay.ok, false)
    if (!replay.ok) assert.equal(replay.code, 'CAPABILITY_OPERATION_CONFIRMATION_REPLAYED')
    const lease = acquireCapabilityOperationLease({ operationId: prepared.operation.operationId, owner: 'worker-1', leaseMs: 30_000, now: new Date(now.getTime() + 4000), store })
    assert.equal(lease.ok, true)
    if (!lease.ok) throw new Error(lease.message)
    assert.equal(lease.operation.status, 'running')
    assert.equal(lease.operation.revision, 2)
    assert.equal('token' in (lease.operation.lease || {}), false)
    const wrongRenewal = renewCapabilityOperationLease({ operationId: lease.operation.operationId, sourceId: binding.sourceId, workflowId: binding.workflowId, expectedRevision: lease.operation.revision, leaseProof: 'wrong-proof', leaseMs: 930_000, now: new Date(now.getTime() + 4250), store })
    assert.equal(wrongRenewal.ok, false)
    if (!wrongRenewal.ok) assert.equal(wrongRenewal.code, 'CAPABILITY_OPERATION_LEASE_INVALID')
    const renewed = renewCapabilityOperationLease({ operationId: lease.operation.operationId, sourceId: binding.sourceId, workflowId: binding.workflowId, expectedRevision: lease.operation.revision, leaseProof: lease.leaseProof, leaseMs: 930_000, now: new Date(now.getTime() + 4250), store })
    assert.equal(renewed.ok, true)
    if (!renewed.ok) throw new Error(renewed.message)
    assert.equal(renewed.operation.revision, 3)
    assert.equal(Date.parse(renewed.operation.lease!.expiresAt) - (now.getTime() + 4250), 930_000)
    const next = {
      ...lease.operation,
      status: 'reconciling' as const,
      updatedAt: new Date(now.getTime() + 4500).toISOString(),
      reasonCode: 'PROCESS_AMBIGUOUS' as const,
      evidence: { protectedDomains: 'unverified' as const }
    }
    const immutable = transitionCapabilityOperation({ operationId: lease.operation.operationId, sourceId: binding.sourceId, workflowId: binding.workflowId, expectedStatus: 'running', expectedRevision: renewed.operation.revision, next: { ...next, binding: { ...next.binding, workflowId: 'wrong' } }, leaseProof: lease.leaseProof, now: new Date(now.getTime() + 4500), store })
    assert.equal(immutable.ok, false)
    if (!immutable.ok) assert.equal(immutable.code, 'CAPABILITY_OPERATION_IMMUTABLE_MISMATCH')
    const transitioned = transitionCapabilityOperation({ operationId: lease.operation.operationId, sourceId: binding.sourceId, workflowId: binding.workflowId, expectedStatus: 'running', expectedRevision: renewed.operation.revision, next, leaseProof: lease.leaseProof, now: new Date(now.getTime() + 4500), store })
    assert.equal(transitioned.ok, true)
    if (!transitioned.ok) throw new Error(transitioned.message)
    assert.equal(transitioned.operation.status, 'reconciling')
    assert.equal(transitioned.operation.revision, 4)
    const sameOperationConflict = acquireCapabilityOperationLease({ operationId: lease.operation.operationId, owner: 'worker-preempt', leaseMs: 30_000, now: new Date(now.getTime() + 4750), store })
    assert.equal(sameOperationConflict.ok, false)
    if (!sameOperationConflict.ok) assert.equal(sameOperationConflict.code, 'CAPABILITY_OPERATION_LEASE_CONFLICT')
    const staleTransition = transitionCapabilityOperation({ operationId: lease.operation.operationId, sourceId: binding.sourceId, workflowId: binding.workflowId, expectedStatus: 'reconciling', expectedRevision: 2, next: { ...next, status: 'completed' as const }, leaseProof: lease.leaseProof, now: new Date(now.getTime() + 5000), store })
    assert.equal(staleTransition.ok, false)
    if (!staleTransition.ok) assert.equal(staleTransition.code, 'CAPABILITY_OPERATION_REVISION_CONFLICT')
    const secondPrepared = createPreparedCapabilityOperation({ binding: { ...binding, grantId: 'grant-2' }, confirmationTtlSeconds: 600, now: new Date(now.getTime() + 5000), store })
    assert.equal(secondPrepared.ok, true)
    if (!secondPrepared.ok) throw new Error(secondPrepared.message)
    const secondConsumed = consumeCapabilityOperationConfirmation({ operationId: secondPrepared.operation.operationId, confirmationToken: secondPrepared.confirmationToken, now: new Date(now.getTime() + 6000), store })
    assert.equal(secondConsumed.ok, true)
    const conflict = acquireCapabilityOperationLease({ operationId: secondPrepared.operation.operationId, owner: 'worker-2', leaseMs: 30_000, now: new Date(now.getTime() + 7000), store })
    assert.equal(conflict.ok, false)
    if (!conflict.ok) assert.equal(conflict.code, 'CAPABILITY_OPERATION_LEASE_CONFLICT')
    const badProof = releaseCapabilityOperationLease({ operationId: lease.operation.operationId, sourceId: binding.sourceId, workflowId: binding.workflowId, expectedRevision: 4, leaseProof: 'wrong-proof', now: new Date(now.getTime() + 7000), store })
    assert.equal(badProof.ok, false)
    if (!badProof.ok) assert.equal(badProof.code, 'CAPABILITY_OPERATION_LEASE_INVALID')
    const released = releaseCapabilityOperationLease({ operationId: lease.operation.operationId, sourceId: binding.sourceId, workflowId: binding.workflowId, expectedRevision: 4, leaseProof: lease.leaseProof, now: new Date(now.getTime() + 7000), store })
    assert.equal(released.ok, true)
    if (!released.ok) throw new Error(released.message)
    assert.equal(released.operation.revision, 5)
    assert.equal(released.operation.lease, undefined)
    const replayRelease = releaseCapabilityOperationLease({ operationId: lease.operation.operationId, sourceId: binding.sourceId, workflowId: binding.workflowId, expectedRevision: 5, leaseProof: lease.leaseProof, now: new Date(now.getTime() + 7000), store })
    assert.equal(replayRelease.ok, false)
    const stale = acquireCapabilityOperationLease({ operationId: prepared.operation.operationId, owner: 'worker-reconcile', leaseMs: 30_000, now: new Date(now.getTime() + 35_000), store })
    assert.equal(stale.ok, true)
    if (!stale.ok) throw new Error(stale.message)
    assert.equal(stale.operation.status, 'reconciling')
    const expiring = createPreparedCapabilityOperation({ binding: { ...binding, workflowId: 'workflow-2', grantId: 'grant-3' }, confirmationTtlSeconds: 30, now, store })
    assert.equal(expiring.ok, true)
    if (!expiring.ok) throw new Error(expiring.message)
    const expired = consumeCapabilityOperationConfirmation({ operationId: expiring.operation.operationId, confirmationToken: expiring.confirmationToken, now: new Date(now.getTime() + 31_000), store })
    assert.equal(expired.ok, false)
    if (!expired.ok) assert.equal(expired.code, 'CAPABILITY_OPERATION_CONFIRMATION_EXPIRED')
    const expiredStatus = getCompactCapabilityOperation(expiring.operation.operationId, store)
    assert.ok(expiredStatus && !('ok' in expiredStatus))
    if (expiredStatus && !('ok' in expiredStatus)) assert.equal(expiredStatus.status, 'expired')
    const validPayload = JSON.parse(fs.readFileSync(path.join(rootDir, 'workbench-capability-operations.json'), 'utf8'))
    const invalidRevision = structuredClone(validPayload)
    invalidRevision.operations[0].revision = -1
    const invalidStatus = structuredClone(validPayload)
    invalidStatus.operations[0].status = 'unknown'
    const invalidLease = structuredClone(validPayload)
    invalidLease.operations[0].lease = { leaseProof: 'x', owner: 'bad', acquiredAt: now.toISOString(), expiresAt: new Date(now.getTime() + 1000).toISOString() }
    for (const payload of ['{', JSON.stringify({ version: 2, updatedAt: now.toISOString(), operations: [] }), JSON.stringify({ version: 1, updatedAt: now.toISOString(), operations: [{}] }), JSON.stringify(invalidRevision), JSON.stringify(invalidStatus), JSON.stringify(invalidLease)]) {
      fs.writeFileSync(path.join(rootDir, 'workbench-capability-operations.json'), payload, { mode: 0o600 })
      const corruptRead = getCompactCapabilityOperation('missing', store)
      assert.ok(corruptRead && 'ok' in corruptRead)
      if (corruptRead && 'ok' in corruptRead) assert.equal(corruptRead.code, 'CAPABILITY_OPERATION_STORE_CORRUPT')
      const corruptWrite = createPreparedCapabilityOperation({ binding, confirmationTtlSeconds: 600, now, store })
      assert.equal(corruptWrite.ok, false)
      if (!corruptWrite.ok) assert.equal(corruptWrite.code, 'CAPABILITY_OPERATION_STORE_CORRUPT')
      const corruptTransition = transitionCapabilityOperation({ operationId: prepared.operation.operationId, sourceId: binding.sourceId, workflowId: binding.workflowId, expectedStatus: 'reconciling', expectedRevision: 5, next, leaseProof: lease.leaseProof, now, store })
      assert.equal(corruptTransition.ok, false)
      if (!corruptTransition.ok) assert.equal(corruptTransition.code, 'CAPABILITY_OPERATION_STORE_CORRUPT')
      const corruptRelease = releaseCapabilityOperationLease({ operationId: prepared.operation.operationId, sourceId: binding.sourceId, workflowId: binding.workflowId, expectedRevision: 5, leaseProof: lease.leaseProof, now, store })
      assert.equal(corruptRelease.ok, false)
      if (!corruptRelease.ok) assert.equal(corruptRelease.code, 'CAPABILITY_OPERATION_STORE_CORRUPT')
    }
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true })
  }
  console.log('capability operation store verification passed')
}

main()
