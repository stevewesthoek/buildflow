import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateApprovalRequest,
  validateApprovalDecision,
  createApprovalStore,
  submitApprovalRequest,
  resolveApproval,
  withdrawApproval,
  checkApprovalExpiry,
  listPendingApprovals,
  WORKBENCH_APPROVAL_REQUEST_KIND,
  WORKBENCH_APPROVAL_DECISION_KIND,
  WORKBENCH_APPROVAL_CONTRACT_VERSION,
  type WorkbenchApprovalRequest,
  type WorkbenchApprovalDecision
} from '../cross-device-approval.js'

function makeRequest(overrides: Partial<WorkbenchApprovalRequest> = {}): WorkbenchApprovalRequest {
  return {
    kind: WORKBENCH_APPROVAL_REQUEST_KIND,
    contractVersion: WORKBENCH_APPROVAL_CONTRACT_VERSION,
    requestId: 'req-001',
    originDeviceId: 'device-a',
    targetDeviceId: 'device-b',
    userId: 'user-001',
    scope: 'run',
    description: 'Execute packet P-123 on device-b',
    requiredLevel: 3,
    state: 'pending',
    requestedAt: '2026-08-22T10:00:00Z',
    expiresAt: '2026-08-22T11:00:00Z',
    ...overrides
  }
}

function makeDecision(overrides: Partial<WorkbenchApprovalDecision> = {}): WorkbenchApprovalDecision {
  return {
    kind: WORKBENCH_APPROVAL_DECISION_KIND,
    contractVersion: WORKBENCH_APPROVAL_CONTRACT_VERSION,
    requestId: 'req-001',
    decidedBy: 'user-001',
    decidedOnDeviceId: 'device-b',
    state: 'approved',
    reason: 'Trusted origin device',
    decidedAt: '2026-08-22T10:05:00Z',
    ...overrides
  }
}

describe('cross-device-approval', () => {
  describe('validateApprovalRequest', () => {
    it('accepts a valid request', () => {
      const result = validateApprovalRequest(makeRequest())
      assert.equal(result.valid, true)
    })

    it('rejects missing kind', () => {
      const { kind: _, ...rest } = makeRequest()
      const result = validateApprovalRequest(rest)
      assert.equal(result.valid, false)
    })

    it('rejects unknown scope', () => {
      const result = validateApprovalRequest(makeRequest({ scope: 'admin' as never }))
      assert.equal(result.valid, false)
    })

    it('rejects requiredLevel > 6', () => {
      const result = validateApprovalRequest(makeRequest({ requiredLevel: 7 }))
      assert.equal(result.valid, false)
    })

    it('rejects unknown state', () => {
      const result = validateApprovalRequest(makeRequest({ state: 'magic' as never }))
      assert.equal(result.valid, false)
    })
  })

  describe('validateApprovalDecision', () => {
    it('accepts a valid decision', () => {
      const result = validateApprovalDecision(makeDecision())
      assert.equal(result.valid, true)
    })

    it('rejects missing requestId', () => {
      const { requestId: _, ...rest } = makeDecision()
      const result = validateApprovalDecision(rest)
      assert.equal(result.valid, false)
    })

    it('rejects state value other than approved/denied', () => {
      const result = validateApprovalDecision(makeDecision({ state: 'pending' as never }))
      assert.equal(result.valid, false)
    })
  })

  describe('submitApprovalRequest', () => {
    it('submits a valid pending request', () => {
      const store = createApprovalStore()
      const result = submitApprovalRequest(store, makeRequest())
      assert.equal(result.submitted, true)
      assert.equal(store.requests.size, 1)
    })

    it('rejects request with state != pending', () => {
      const store = createApprovalStore()
      const result = submitApprovalRequest(store, makeRequest({ state: 'approved' }))
      assert.equal(result.submitted, false)
      assert.ok('reason' in result && result.reason.includes('initial_state_must_be_pending'))
    })

    it('rejects self-approval (origin == target)', () => {
      const store = createApprovalStore()
      const result = submitApprovalRequest(store, makeRequest({ originDeviceId: 'device-a', targetDeviceId: 'device-a' }))
      assert.equal(result.submitted, false)
      assert.ok('reason' in result && result.reason.includes('cannot_approve_own_device'))
    })

    it('rejects duplicate requestId', () => {
      const store = createApprovalStore()
      submitApprovalRequest(store, makeRequest())
      const result = submitApprovalRequest(store, makeRequest())
      assert.equal(result.submitted, false)
      assert.ok('reason' in result && result.reason.includes('request_already_exists'))
    })

    it('rejects an invalid or reversed expiry window', () => {
      const store = createApprovalStore()
      const result = submitApprovalRequest(store, makeRequest({ expiresAt: '2026-08-22T09:00:00Z' }))
      assert.equal(result.submitted, false)
      assert.equal('reason' in result && result.reason, 'invalid_request_expiry')
    })

    it('rejects invalid request payload', () => {
      const store = createApprovalStore()
      const result = submitApprovalRequest(store, { kind: 'wrong' } as never)
      assert.equal(result.submitted, false)
    })
  })

  describe('resolveApproval', () => {
    it('resolves a pending request as approved', () => {
      const store = createApprovalStore()
      submitApprovalRequest(store, makeRequest())
      const result = resolveApproval(store, makeDecision(), '2026-08-22T10:05:00Z')
      assert.equal(result.resolved, true)
      assert.equal(store.requests.get('req-001')?.state, 'approved')
      assert.equal(store.decisions.size, 1)
    })

    it('resolves a pending request as denied', () => {
      const store = createApprovalStore()
      submitApprovalRequest(store, makeRequest())
      const result = resolveApproval(store, makeDecision({ state: 'denied', reason: 'Untrusted' }), '2026-08-22T10:05:00Z')
      assert.equal(result.resolved, true)
      assert.equal(store.requests.get('req-001')?.state, 'denied')
    })

    it('rejects resolution of non-existent request', () => {
      const store = createApprovalStore()
      const result = resolveApproval(store, makeDecision({ requestId: 'missing' }), '2026-08-22T10:05:00Z')
      assert.equal(result.resolved, false)
      assert.ok('reason' in result && result.reason.includes('request_not_found'))
    })

    it('requires the target device to issue the decision', () => {
      const store = createApprovalStore()
      submitApprovalRequest(store, makeRequest())
      const result = resolveApproval(store, makeDecision({ decidedOnDeviceId: 'device-c' }), '2026-08-22T10:05:00Z')
      assert.equal(result.resolved, false)
      assert.equal('reason' in result && result.reason, 'decision_not_target_device')
    })

    it('rejects invalid decision timestamps', () => {
      const store = createApprovalStore()
      submitApprovalRequest(store, makeRequest())
      const result = resolveApproval(store, makeDecision({ decidedAt: 'not-a-date' }), '2026-08-22T10:05:00Z')
      assert.equal(result.resolved, false)
      assert.equal('reason' in result && result.reason, 'invalid_timestamp')
    })

    it('rejects resolution of already-resolved request', () => {
      const store = createApprovalStore()
      submitApprovalRequest(store, makeRequest())
      resolveApproval(store, makeDecision(), '2026-08-22T10:05:00Z')
      const result = resolveApproval(store, makeDecision(), '2026-08-22T10:06:00Z')
      assert.equal(result.resolved, false)
      assert.ok('reason' in result && result.reason.includes('request_not_pending'))
    })

    it('marks request expired if decision arrives after expiry', () => {
      const store = createApprovalStore()
      submitApprovalRequest(store, makeRequest({ expiresAt: '2026-08-22T10:30:00Z' }))
      const result = resolveApproval(store, makeDecision(), '2026-08-22T11:00:00Z')
      assert.equal(result.resolved, false)
      assert.ok('reason' in result && result.reason.includes('request_expired'))
      assert.equal(store.requests.get('req-001')?.state, 'expired')
    })
  })

  describe('withdrawApproval', () => {
    it('withdraws a pending request from origin device', () => {
      const store = createApprovalStore()
      submitApprovalRequest(store, makeRequest())
      const result = withdrawApproval(store, 'req-001', 'device-a')
      assert.equal(result.withdrawn, true)
      assert.equal(store.requests.get('req-001')?.state, 'withdrawn')
    })

    it('rejects withdrawal from non-originator', () => {
      const store = createApprovalStore()
      submitApprovalRequest(store, makeRequest())
      const result = withdrawApproval(store, 'req-001', 'device-b')
      assert.equal(result.withdrawn, false)
      assert.ok('reason' in result && result.reason.includes('not_request_originator'))
    })

    it('rejects withdrawal of non-pending request', () => {
      const store = createApprovalStore()
      submitApprovalRequest(store, makeRequest())
      resolveApproval(store, makeDecision(), '2026-08-22T10:05:00Z')
      const result = withdrawApproval(store, 'req-001', 'device-a')
      assert.equal(result.withdrawn, false)
    })
  })

  describe('checkApprovalExpiry', () => {
    it('expires pending requests past their deadline', () => {
      const store = createApprovalStore()
      submitApprovalRequest(store, makeRequest({ requestId: 'r1', expiresAt: '2026-08-22T10:30:00Z' }))
      submitApprovalRequest(store, makeRequest({ requestId: 'r2', expiresAt: '2026-08-22T12:00:00Z' }))
      const { expiredCount } = checkApprovalExpiry(store, '2026-08-22T11:00:00Z')
      assert.equal(expiredCount, 1)
      assert.equal(store.requests.get('r1')?.state, 'expired')
      assert.equal(store.requests.get('r2')?.state, 'pending')
    })
  })

  describe('listPendingApprovals', () => {
    it('returns only pending requests for a target device', () => {
      const store = createApprovalStore()
      submitApprovalRequest(store, makeRequest({ requestId: 'r1', targetDeviceId: 'device-b' }))
      submitApprovalRequest(store, makeRequest({ requestId: 'r2', targetDeviceId: 'device-c' }))
      submitApprovalRequest(store, makeRequest({ requestId: 'r3', targetDeviceId: 'device-b' }))
      resolveApproval(store, makeDecision({ requestId: 'r3' }), '2026-08-22T10:05:00Z')
      const pending = listPendingApprovals(store, 'device-b')
      assert.equal(pending.length, 1)
      assert.equal(pending[0].requestId, 'r1')
    })
  })
})
