import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createCapabilityMutationDispatchConsumer,
  consumeCapabilityMutationDispatch,
  getCapabilityMutationDispatchRecord,
  getCompactCapabilityMutationDispatch,
  recordCapabilityMutationDispatchOutcome,
  requireMutationDispatchReconciliation,
  reconcilePendingCapabilityMutationDispatches,
  reserveCapabilityMutationDispatch
} from '../packages/cli/src/agent/capability-mutation-dispatch-store'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-dispatch-store-'))
const hash = (char: string) => char.repeat(64)
const base = { operationId: 'operation-1', sourceId: 'source-1', workflowId: 'workflow-1', artifactSha256: hash('a'), wrapperSha256: hash('b'), store: { rootDir: root } }
try {
  const candidate = reserveCapabilityMutationDispatch({ ...base, kind: 'candidate' })
  assert.equal(candidate.ok, true); if (!candidate.ok) throw new Error(candidate.message)
  assert.equal(reserveCapabilityMutationDispatch({ ...base, kind: 'candidate' }).ok, false)
  const rollback = reserveCapabilityMutationDispatch({ ...base, kind: 'rollback' })
  assert.equal(rollback.ok, true); if (!rollback.ok) throw new Error(rollback.message)
  assert.notEqual(candidate.dispatch.dispatchId, rollback.dispatch.dispatchId)
  const raw = fs.readFileSync(path.join(root, 'workbench-capability-mutation-dispatches.json'), 'utf8')
  assert.equal(raw.includes(candidate.authorization), false)
  assert.equal(fs.statSync(path.join(root, 'workbench-capability-mutation-dispatches.json')).mode & 0o777, 0o600)
  const consume = (extra: Record<string, unknown> = {}) => consumeCapabilityMutationDispatch({ dispatchId: candidate.dispatch.dispatchId, authorization: candidate.authorization, ...base, kind: 'candidate', ...extra } as any)
  for (const [field, value] of Object.entries({ operationId: 'other', sourceId: 'other', workflowId: 'other', artifactSha256: hash('c'), wrapperSha256: hash('d'), kind: 'rollback' })) assert.equal(consume({ [field]: value }).ok, false, field)
  assert.equal(consume({ authorization: 'wrong' }).ok, false)
  const consumed = consume(); assert.equal(consumed.ok, true)
  assert.equal(consume().ok, false)
  const privateDispatch = getCapabilityMutationDispatchRecord(candidate.dispatch.dispatchId, base.store)
  assert.ok(privateDispatch && !('ok' in privateDispatch)); if (privateDispatch && !('ok' in privateDispatch)) assert.equal(typeof privateDispatch.authorizationDigest, 'string')
  const outcome = recordCapabilityMutationDispatchOutcome({ dispatchId: candidate.dispatch.dispatchId, ...base, kind: 'candidate', outcome: 'succeeded' })
  assert.equal(outcome.ok, true); if (outcome.ok) assert.equal(outcome.dispatch.status, 'outcome_recorded')
  const replayedOutcome = recordCapabilityMutationDispatchOutcome({ dispatchId: candidate.dispatch.dispatchId, ...base, kind: 'candidate', outcome: 'ambiguous' })
  assert.equal(replayedOutcome.ok, false)
  const mismatchedOutcome = recordCapabilityMutationDispatchOutcome({ dispatchId: rollback.dispatch.dispatchId, ...base, kind: 'candidate', outcome: 'timed_out' })
  assert.equal(mismatchedOutcome.ok, false)
  const consumerDispatch = reserveCapabilityMutationDispatch({ ...base, operationId: 'operation-3', kind: 'candidate' })
  assert.equal(consumerDispatch.ok, true); if (!consumerDispatch.ok) throw new Error(consumerDispatch.message)
  const consumer = createCapabilityMutationDispatchConsumer({ dispatchId: consumerDispatch.dispatch.dispatchId, authorization: consumerDispatch.authorization, store: base.store })
  assert.equal(consumer({ operationId: 'operation-3', sourceId: base.sourceId, workflowId: base.workflowId, kind: 'candidate', artifactSha256: base.artifactSha256, wrapperSha256: base.wrapperSha256 }).ok, true)
  assert.equal(consumer({ operationId: 'operation-3', sourceId: base.sourceId, workflowId: base.workflowId, kind: 'candidate', artifactSha256: base.artifactSha256, wrapperSha256: base.wrapperSha256 }).ok, false)
  const compact = getCompactCapabilityMutationDispatch(candidate.dispatch.dispatchId, base.store)
  assert.ok(compact && !('authorizationDigest' in compact))
  const reconciled = requireMutationDispatchReconciliation(rollback.dispatch.dispatchId, base.store)
  assert.equal(reconciled.ok, true); if (reconciled.ok) assert.equal(reconciled.dispatch.status, 'reconciliation_required')
  const stale = reserveCapabilityMutationDispatch({ ...base, operationId: 'operation-stale', kind: 'candidate' })
  assert.equal(stale.ok, true); if (!stale.ok) throw new Error(stale.message)
  const recovered = reconcilePendingCapabilityMutationDispatches(base.store)
  assert.equal(recovered.ok, true); if (recovered.ok) assert.ok(recovered.dispatches.some(dispatch => dispatch.dispatchId === stale.dispatch.dispatchId && dispatch.status === 'reconciliation_required'))
  fs.writeFileSync(path.join(root, 'workbench-capability-mutation-dispatches.json'), '{bad')
  const corrupt = reserveCapabilityMutationDispatch({ ...base, operationId: 'operation-2', kind: 'candidate' })
  assert.equal(corrupt.ok, false); if (!corrupt.ok) assert.equal(corrupt.code, 'MUTATION_DISPATCH_STORE_CORRUPT')
} finally { fs.rmSync(root, { recursive: true, force: true }) }
console.log('capability mutation dispatch store verification passed')
