import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateDispatchRequest,
  validateRoutingDecision,
  createDispatchState,
  routeRequest,
  clearAffinity,
  verifySourceIdentityProof,
  WORKBENCH_DISPATCH_REQUEST_KIND,
  WORKBENCH_DISPATCH_CONTRACT_VERSION,
  type WorkbenchDispatchRequest,
  type WorkbenchDeviceInfo,
  type WorkbenchSourceIdentityProof
} from '../distributed-dispatch.js'

const TS = '2026-08-21T00:00:00Z'

function makeRequest(overrides: Partial<WorkbenchDispatchRequest> = {}): WorkbenchDispatchRequest {
  return {
    kind: WORKBENCH_DISPATCH_REQUEST_KIND,
    contractVersion: WORKBENCH_DISPATCH_CONTRACT_VERSION,
    requestId: 'req-001',
    packetId: 'pkt-001',
    runId: 'run-001',
    sourceId: 'src-001',
    routingMode: 'automatic',
    mutation: false,
    requiredCapabilities: [],
    requestedAt: TS,
    ...overrides
  }
}

function makeDevice(overrides: Partial<WorkbenchDeviceInfo> = {}): WorkbenchDeviceInfo {
  return {
    deviceId: 'device-001',
    state: 'online',
    capacity: { availableSlots: 4, queueDepth: 0, cpuPressure: 'low' },
    enabledSourceFingerprints: ['fp-src-1'],
    capabilities: ['run', 'index'],
    ...overrides
  }
}

function makeProof(overrides: Partial<WorkbenchSourceIdentityProof> = {}): WorkbenchSourceIdentityProof {
  return {
    sourceId: 'src-001',
    deviceId: 'device-001',
    expectedHead: 'abc1234def567',
    sourceFingerprint: 'fp-src-1',
    provenAt: TS,
    ...overrides
  }
}

describe('distributed-dispatch', () => {
  describe('validateDispatchRequest', () => {
    it('accepts a valid request', () => {
      const result = validateDispatchRequest(makeRequest())
      assert.equal(result.valid, true)
    })

    it('rejects missing sourceId', () => {
      const { sourceId: _, ...rest } = makeRequest()
      const result = validateDispatchRequest(rest)
      assert.equal(result.valid, false)
    })

    it('rejects invalid routingMode', () => {
      const result = validateDispatchRequest(makeRequest({ routingMode: 'random' as never }))
      assert.equal(result.valid, false)
    })
  })

  describe('validateRoutingDecision', () => {
    it('accepts a valid decision', () => {
      const result = validateRoutingDecision({
        kind: 'workbench.dispatch.decision',
        contractVersion: '1',
        requestId: 'req-001',
        outcome: 'admitted',
        selectedDeviceId: 'device-001',
        reason: 'selected_by_capacity',
        decidedAt: TS
      })
      assert.equal(result.valid, true)
    })

    it('rejects invalid outcome', () => {
      const result = validateRoutingDecision({
        kind: 'workbench.dispatch.decision',
        contractVersion: '1',
        requestId: 'req-001',
        outcome: 'maybe',
        reason: 'test',
        decidedAt: TS
      })
      assert.equal(result.valid, false)
    })
  })

  describe('routeRequest', () => {
    it('admits a request to the best device', () => {
      const state = createDispatchState()
      const decision = routeRequest(state, makeRequest(), [makeDevice()], [], TS)
      assert.equal(decision.outcome, 'admitted')
      assert.equal(decision.selectedDeviceId, 'device-001')
    })

    it('rejects when no devices are eligible', () => {
      const state = createDispatchState()
      const decision = routeRequest(state, makeRequest(), [], [], TS)
      assert.equal(decision.outcome, 'rejected')
    })

    it('rejects when all slots are full', () => {
      const state = createDispatchState()
      const device = makeDevice({ capacity: { availableSlots: 0, queueDepth: 10, cpuPressure: 'high' } })
      const decision = routeRequest(state, makeRequest(), [device], [], TS)
      assert.equal(decision.outcome, 'rejected')
    })

    it('excludes offline devices', () => {
      const state = createDispatchState()
      const device = makeDevice({ state: 'offline' })
      const decision = routeRequest(state, makeRequest(), [device], [], TS)
      assert.equal(decision.outcome, 'rejected')
    })

    it('rejects mutation request with no proven source', () => {
      const state = createDispatchState()
      const decision = routeRequest(state, makeRequest({ mutation: true }), [makeDevice()], [], TS)
      assert.equal(decision.outcome, 'rejected')
      assert.ok(decision.reason.includes('no_device_with_proven_source_identity'))
    })

    it('admits mutation request when source proof matches', () => {
      const state = createDispatchState()
      const decision = routeRequest(state, makeRequest({ mutation: true }), [makeDevice()], [makeProof()], TS)
      assert.equal(decision.outcome, 'admitted')
    })

    it('rejects a mutation proof for a fingerprint the device does not have', () => {
      const state = createDispatchState()
      const decision = routeRequest(state, makeRequest({ mutation: true }), [makeDevice()], [makeProof({ sourceFingerprint: 'fp-other' })], TS)
      assert.equal(decision.outcome, 'rejected')
    })

    it('does not let sticky affinity bypass mutation proof or source binding', () => {
      const state = createDispatchState()
      const device = makeDevice()
      routeRequest(state, makeRequest({ runId: 'run-sticky' }), [device], [], TS)
      const mutation = routeRequest(state, makeRequest({ runId: 'run-sticky', requestId: 'req-mutation', mutation: true }), [device], [], TS)
      assert.equal(mutation.outcome, 'rejected')
      const otherSource = routeRequest(state, makeRequest({ runId: 'run-sticky', requestId: 'req-other', sourceId: 'src-other' }), [device], [], TS)
      assert.notEqual(otherSource.reason, 'sticky_affinity')
    })

    it('rejects a pinned request without a pinned device', () => {
      const state = createDispatchState()
      const decision = routeRequest(state, makeRequest({ routingMode: 'pinned' }), [makeDevice()], [], TS)
      assert.equal(decision.outcome, 'rejected')
      assert.equal(decision.reason, 'pinned_device_required')
    })

    it('uses sticky affinity for a run already assigned', () => {
      const state = createDispatchState()
      const deviceA = makeDevice({ deviceId: 'dev-a' })
      const deviceB = makeDevice({ deviceId: 'dev-b' })
      routeRequest(state, makeRequest({ requestId: 'req-1', routingMode: 'automatic' }), [deviceA, deviceB], [], TS)
      const firstDevice = state.affinities.get('run-001')?.deviceId
      assert.ok(firstDevice)
      const second = routeRequest(state, makeRequest({ requestId: 'req-2' }), [deviceA, deviceB], [], TS)
      assert.equal(second.selectedDeviceId, firstDevice)
      assert.equal(second.reason, 'sticky_affinity')
    })

    it('defers pinned request when pinned device is offline', () => {
      const state = createDispatchState()
      const device = makeDevice({ state: 'offline', deviceId: 'pinned-dev' })
      const decision = routeRequest(state, makeRequest({ routingMode: 'pinned', pinnedDeviceId: 'pinned-dev' }), [device], [], TS)
      assert.equal(decision.outcome, 'deferred')
      assert.equal(decision.reason, 'pinned_device_unavailable')
    })

    it('filters by required capability', () => {
      const state = createDispatchState()
      const device = makeDevice({ capabilities: ['index'] })
      const decision = routeRequest(state, makeRequest({ requiredCapabilities: ['gpu'] }), [device], [], TS)
      assert.equal(decision.outcome, 'rejected')
    })

    it('rejects an invalid request object', () => {
      const state = createDispatchState()
      const decision = routeRequest(state, { kind: 'bad' } as never, [makeDevice()], [], TS)
      assert.equal(decision.outcome, 'rejected')
      assert.ok(decision.reason.includes('invalid_request'))
    })
  })

  describe('clearAffinity', () => {
    it('clears an existing affinity', () => {
      const state = createDispatchState()
      routeRequest(state, makeRequest(), [makeDevice()], [], TS)
      const result = clearAffinity(state, 'run-001')
      assert.equal(result.cleared, true)
      assert.equal(state.affinities.has('run-001'), false)
    })

    it('fails when affinity does not exist', () => {
      const state = createDispatchState()
      const result = clearAffinity(state, 'missing-run')
      assert.equal(result.cleared, false)
    })
  })

  describe('verifySourceIdentityProof', () => {
    it('verifies a valid proof', () => {
      const result = verifySourceIdentityProof(makeProof())
      assert.equal(result.verified, true)
    })

    it('rejects a proof with too-short head reference', () => {
      const result = verifySourceIdentityProof(makeProof({ expectedHead: 'abc' }))
      assert.equal(result.verified, false)
    })

    it('rejects a proof with missing fingerprint', () => {
      const result = verifySourceIdentityProof(makeProof({ sourceFingerprint: '' }))
      assert.equal(result.verified, false)
    })

    it('rejects a proof without a timestamp', () => {
      const result = verifySourceIdentityProof(makeProof({ provenAt: '' }))
      assert.equal(result.verified, false)
    })
  })
})
