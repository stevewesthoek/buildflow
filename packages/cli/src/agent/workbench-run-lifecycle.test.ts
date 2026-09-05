import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assessWorkbenchRunLiveness,
  isReconciledStaleWorkbenchRun,
  WORKBENCH_STALE_RUN_REASON
} from './workbench-run-lifecycle'

test('run liveness uses the newest persisted signal', () => {
  const result = assessWorkbenchRunLiveness({
    status: 'running',
    updatedAt: '2026-08-25T10:00:00.000Z',
    lastEventAt: '2026-08-25T10:14:00.000Z',
    now: '2026-08-25T10:20:00.000Z'
  })

  assert.equal(result.stale, false)
  assert.equal(result.lastSignalAt, '2026-08-25T10:14:00.000Z')
})

test('running work with no recent lifecycle signal is stale', () => {
  const result = assessWorkbenchRunLiveness({
    status: 'running',
    updatedAt: '2026-08-25T07:00:00.000Z',
    now: '2026-08-25T10:00:00.000Z'
  })

  assert.equal(result.stale, true)
  assert.equal(result.reason, WORKBENCH_STALE_RUN_REASON)
  assert.ok(result.ageMs > 60 * 60 * 1000)
})

test('terminal and paused runs are not reclassified as stale', () => {
  assert.equal(assessWorkbenchRunLiveness({ status: 'completed', updatedAt: '2026-01-01T00:00:00.000Z', now: '2026-01-02T00:00:00.000Z' }).stale, false)
  assert.equal(isReconciledStaleWorkbenchRun({ status: 'paused', blockedReason: `${WORKBENCH_STALE_RUN_REASON}: age=1h` }), true)
  assert.equal(isReconciledStaleWorkbenchRun({ status: 'paused', blockedReason: 'user_paused' }), false)
})
