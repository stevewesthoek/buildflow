import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateDeviceRegistration,
  validateDeviceLease,
  createDeviceRegistryState,
  registerDevice,
  revokeDevice,
  heartbeatDevice,
  listEligibleDevices,
  issueLease,
  releaseLease,
  checkLeaseExpiry,
  WORKBENCH_DEVICE_REGISTRY_KIND,
  WORKBENCH_DEVICE_CONTRACT_VERSION,
  type WorkbenchDeviceRegistration,
  type WorkbenchDeviceLease
} from '../device-registry.js'

function makeRegistration(overrides: Partial<WorkbenchDeviceRegistration> = {}): WorkbenchDeviceRegistration {
  return {
    kind: WORKBENCH_DEVICE_REGISTRY_KIND,
    contractVersion: WORKBENCH_DEVICE_CONTRACT_VERSION,
    deviceId: 'device-001',
    userId: 'user-001',
    identity: {
      deviceId: 'device-001',
      friendlyName: 'Dev Mac',
      workbenchVersion: '1.3.10-beta',
      platform: 'darwin',
      architecture: 'arm64',
      registeredAt: '2026-08-21T00:00:00Z'
    },
    state: 'online',
    capabilities: ['run', 'index'],
    enabledSourceFingerprints: ['fp-src-1'],
    capacity: {
      activeRuns: 0,
      maxConcurrentRuns: 4,
      availableSlots: 4,
      queueDepth: 0,
      cpuPressure: 'low',
      memoryPressure: 'low'
    },
    lastHeartbeatAt: '2026-08-21T00:00:00Z',
    pairingNonce: 'nonce-abc',
    ...overrides
  }
}

function makeLease(overrides: Partial<WorkbenchDeviceLease> = {}): WorkbenchDeviceLease {
  return {
    kind: 'workbench.device.lease',
    contractVersion: WORKBENCH_DEVICE_CONTRACT_VERSION,
    leaseId: 'lease-001',
    deviceId: 'device-001',
    runId: 'run-001',
    sourceId: 'src-001',
    state: 'active',
    issuedAt: '2026-08-21T00:00:00Z',
    expiresAt: '2026-08-21T01:00:00Z',
    ...overrides
  }
}

describe('device-registry', () => {
  describe('validateDeviceRegistration', () => {
    it('accepts a valid registration', () => {
      const result = validateDeviceRegistration(makeRegistration())
      assert.equal(result.valid, true)
    })

    it('rejects missing kind', () => {
      const { kind: _, ...rest } = makeRegistration()
      const result = validateDeviceRegistration(rest)
      assert.equal(result.valid, false)
    })

    it('rejects unknown state', () => {
      const result = validateDeviceRegistration(makeRegistration({ state: 'flying' as never }))
      assert.equal(result.valid, false)
    })

    it('rejects negative activeRuns', () => {
      const result = validateDeviceRegistration(makeRegistration({
        capacity: { ...makeRegistration().capacity, activeRuns: -1 }
      }))
      assert.equal(result.valid, false)
    })
  })

  describe('validateDeviceLease', () => {
    it('accepts a valid lease', () => {
      const result = validateDeviceLease(makeLease())
      assert.equal(result.valid, true)
    })

    it('rejects missing leaseId', () => {
      const { leaseId: _, ...rest } = makeLease()
      const result = validateDeviceLease(rest)
      assert.equal(result.valid, false)
    })

    it('rejects unknown lease state', () => {
      const result = validateDeviceLease(makeLease({ state: 'pending' as never }))
      assert.equal(result.valid, false)
    })
  })

  describe('registerDevice', () => {
    it('registers a valid device', () => {
      const state = createDeviceRegistryState()
      const result = registerDevice(state, makeRegistration())
      assert.equal(result.registered, true)
      assert.equal(state.devices.size, 1)
    })

    it('enforces maxDevices limit', () => {
      const state = createDeviceRegistryState(1)
      registerDevice(state, makeRegistration({ deviceId: 'dev-a', identity: { ...makeRegistration().identity, deviceId: 'dev-a' } }))
      const result = registerDevice(state, makeRegistration({ deviceId: 'dev-b', identity: { ...makeRegistration().identity, deviceId: 'dev-b' } }))
      assert.equal(result.registered, false)
      assert.ok('reason' in result && result.reason.includes('device_limit_reached'))
    })

    it('allows re-registration of an existing device at the limit', () => {
      const state = createDeviceRegistryState(1)
      const reg = makeRegistration()
      registerDevice(state, reg)
      const updated = makeRegistration({ capacity: { ...reg.capacity, activeRuns: 1, availableSlots: 3 } })
      const result = registerDevice(state, updated)
      assert.equal(result.registered, true)
    })

    it('rejects invalid registration', () => {
      const state = createDeviceRegistryState()
      const result = registerDevice(state, { kind: 'wrong' } as never)
      assert.equal(result.registered, false)
    })

    it('rejects a registration whose identity names another device', () => {
      const state = createDeviceRegistryState()
      const result = registerDevice(state, makeRegistration({
        identity: { ...makeRegistration().identity, deviceId: 'different-device' }
      }))
      assert.equal(result.registered, false)
      assert.equal('reason' in result && result.reason, 'device_identity_mismatch')
    })
  })

  describe('revokeDevice', () => {
    it('revokes an online device', () => {
      const state = createDeviceRegistryState()
      registerDevice(state, makeRegistration())
      const result = revokeDevice(state, 'device-001', '2026-08-21T01:00:00Z')
      assert.equal(result.revoked, true)
      assert.equal(state.devices.get('device-001')?.state, 'revoked')
    })

    it('fails on nonexistent device', () => {
      const state = createDeviceRegistryState()
      const result = revokeDevice(state, 'missing', '2026-08-21T01:00:00Z')
      assert.equal(result.revoked, false)
    })

    it('fails on already revoked device', () => {
      const state = createDeviceRegistryState()
      registerDevice(state, makeRegistration({ state: 'revoked' }))
      const result = revokeDevice(state, 'device-001', '2026-08-21T01:00:00Z')
      assert.equal(result.revoked, false)
    })
  })

  describe('heartbeatDevice', () => {
    it('updates capacity and timestamp on heartbeat', () => {
      const state = createDeviceRegistryState()
      registerDevice(state, makeRegistration())
      const newCapacity = { ...makeRegistration().capacity, activeRuns: 2, availableSlots: 2 }
      const result = heartbeatDevice(state, 'device-001', '2026-08-21T02:00:00Z', newCapacity)
      assert.equal(result.acknowledged, true)
      assert.equal(state.devices.get('device-001')?.capacity.activeRuns, 2)
    })

    it('can transition state on heartbeat', () => {
      const state = createDeviceRegistryState()
      registerDevice(state, makeRegistration())
      heartbeatDevice(state, 'device-001', '2026-08-21T02:00:00Z', makeRegistration().capacity, 'busy')
      assert.equal(state.devices.get('device-001')?.state, 'busy')
    })

    it('rejects heartbeat from revoked device', () => {
      const state = createDeviceRegistryState()
      registerDevice(state, makeRegistration({ state: 'revoked' }))
      const result = heartbeatDevice(state, 'device-001', '2026-08-21T02:00:00Z', makeRegistration().capacity)
      assert.equal(result.acknowledged, false)
    })
  })

  describe('listEligibleDevices', () => {
    it('returns online devices', () => {
      const state = createDeviceRegistryState()
      registerDevice(state, makeRegistration())
      const eligible = listEligibleDevices(state)
      assert.equal(eligible.length, 1)
    })

    it('excludes revoked devices', () => {
      const state = createDeviceRegistryState()
      registerDevice(state, makeRegistration({ state: 'revoked' }))
      const eligible = listEligibleDevices(state)
      assert.equal(eligible.length, 0)
    })

    it('filters by source fingerprint', () => {
      const state = createDeviceRegistryState()
      registerDevice(state, makeRegistration())
      const eligible = listEligibleDevices(state, 'fp-src-1')
      assert.equal(eligible.length, 1)
      const excluded = listEligibleDevices(state, 'fp-unknown')
      assert.equal(excluded.length, 0)
    })

    it('filters by required capability', () => {
      const state = createDeviceRegistryState()
      registerDevice(state, makeRegistration())
      const eligible = listEligibleDevices(state, undefined, 'run')
      assert.equal(eligible.length, 1)
      const excluded = listEligibleDevices(state, undefined, 'gpu')
      assert.equal(excluded.length, 0)
    })
  })

  describe('lease operations', () => {
    it('issues a valid lease', () => {
      const state = createDeviceRegistryState()
      registerDevice(state, makeRegistration())
      const result = issueLease(state, makeLease())
      assert.equal(result.issued, true)
      assert.equal(state.leases.size, 1)
    })

    it('rejects lease for revoked device', () => {
      const state = createDeviceRegistryState()
      registerDevice(state, makeRegistration({ state: 'revoked' }))
      const result = issueLease(state, makeLease())
      assert.equal(result.issued, false)
    })

    it('rejects replacing an existing lease id', () => {
      const state = createDeviceRegistryState()
      registerDevice(state, makeRegistration())
      issueLease(state, makeLease())
      const result = issueLease(state, makeLease({ runId: 'run-002' }))
      assert.equal(result.issued, false)
      assert.equal('reason' in result && result.reason, 'lease_id_already_exists')
    })

    it('releases an active lease', () => {
      const state = createDeviceRegistryState()
      registerDevice(state, makeRegistration())
      issueLease(state, makeLease())
      const result = releaseLease(state, 'lease-001', '2026-08-21T01:00:00Z')
      assert.equal(result.released, true)
      assert.equal(state.leases.get('lease-001')?.state, 'released')
    })

    it('rejects double release', () => {
      const state = createDeviceRegistryState()
      registerDevice(state, makeRegistration())
      issueLease(state, makeLease())
      releaseLease(state, 'lease-001', '2026-08-21T01:00:00Z')
      const result = releaseLease(state, 'lease-001', '2026-08-21T01:00:00Z')
      assert.equal(result.released, false)
    })
  })

  describe('checkLeaseExpiry', () => {
    it('marks expired lease', () => {
      const lease = makeLease({ expiresAt: '2026-08-21T00:30:00Z' })
      const { expired } = checkLeaseExpiry(lease, '2026-08-21T01:00:00Z')
      assert.equal(expired, true)
    })

    it('does not mark unexpired lease', () => {
      const lease = makeLease({ expiresAt: '2026-08-21T02:00:00Z' })
      const { expired } = checkLeaseExpiry(lease, '2026-08-21T01:00:00Z')
      assert.equal(expired, false)
    })
  })
})
