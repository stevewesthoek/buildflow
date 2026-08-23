import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateSyncEnvelope,
  validateSyncManifest,
  createSyncState,
  registerSyncManifest,
  submitSyncEnvelope,
  expireEnvelopes,
  listPendingEnvelopes,
  isForbiddenScope,
  WORKBENCH_SYNC_ENVELOPE_KIND,
  WORKBENCH_SYNC_MANIFEST_KIND,
  WORKBENCH_SYNC_CONTRACT_VERSION,
  type WorkbenchSyncEnvelope,
  type WorkbenchSyncManifest
} from '../encrypted-sync.js'

function makeManifest(overrides: Partial<WorkbenchSyncManifest> = {}): WorkbenchSyncManifest {
  return {
    kind: WORKBENCH_SYNC_MANIFEST_KIND,
    contractVersion: WORKBENCH_SYNC_CONTRACT_VERSION,
    manifestId: 'manifest-001',
    deviceId: 'device-b',
    allowedScopes: ['run_state', 'device_health'],
    maxPayloadBytes: 65536,
    retentionMs: 3600000,
    createdAt: '2026-08-22T10:00:00Z',
    ...overrides
  }
}

function makeEnvelope(overrides: Partial<WorkbenchSyncEnvelope> = {}): WorkbenchSyncEnvelope {
  return {
    kind: WORKBENCH_SYNC_ENVELOPE_KIND,
    contractVersion: WORKBENCH_SYNC_CONTRACT_VERSION,
    envelopeId: 'env-001',
    sourceDeviceId: 'device-a',
    targetDeviceId: 'device-b',
    scope: 'run_state',
    direction: 'push',
    encryptedPayloadB64: 'YWJjZGVm',
    payloadSha256: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    payloadSizeBytes: 6,
    nonce: 'nonce-12345678',
    createdAt: '2026-08-22T10:01:00Z',
    expiresAt: '2026-08-22T11:01:00Z',
    ...overrides
  }
}

describe('encrypted-sync', () => {
  describe('validateSyncManifest', () => {
    it('accepts a valid manifest', () => {
      const result = validateSyncManifest(makeManifest())
      assert.equal(result.valid, true)
    })

    it('rejects missing kind', () => {
      const { kind: _, ...rest } = makeManifest()
      const result = validateSyncManifest(rest)
      assert.equal(result.valid, false)
    })

    it('rejects zero maxPayloadBytes', () => {
      const result = validateSyncManifest(makeManifest({ maxPayloadBytes: 0 }))
      assert.equal(result.valid, false)
    })

    it('rejects retentionMs < 1000', () => {
      const result = validateSyncManifest(makeManifest({ retentionMs: 500 }))
      assert.equal(result.valid, false)
    })
  })

  describe('validateSyncEnvelope', () => {
    it('accepts a valid envelope', () => {
      const result = validateSyncEnvelope(makeEnvelope())
      assert.equal(result.valid, true)
    })

    it('rejects unknown scope', () => {
      const result = validateSyncEnvelope(makeEnvelope({ scope: 'secrets' as never }))
      assert.equal(result.valid, false)
    })

    it('rejects unknown direction', () => {
      const result = validateSyncEnvelope(makeEnvelope({ direction: 'sideways' as never }))
      assert.equal(result.valid, false)
    })

    it('rejects zero payloadSizeBytes', () => {
      const result = validateSyncEnvelope(makeEnvelope({ payloadSizeBytes: 0 }))
      assert.equal(result.valid, false)
    })
  })

  describe('registerSyncManifest', () => {
    it('registers a valid manifest', () => {
      const state = createSyncState()
      const result = registerSyncManifest(state, makeManifest())
      assert.equal(result.registered, true)
      assert.equal(state.manifests.size, 1)
    })

    it('rejects manifest with empty allowedScopes', () => {
      const state = createSyncState()
      const result = registerSyncManifest(state, makeManifest({ allowedScopes: [] }))
      assert.equal(result.registered, false)
      assert.ok('reason' in result && result.reason.includes('no_scopes_allowed'))
    })

    it('rejects invalid manifest', () => {
      const state = createSyncState()
      const result = registerSyncManifest(state, { kind: 'wrong' } as never)
      assert.equal(result.registered, false)
    })
  })

  describe('submitSyncEnvelope', () => {
    it('accepts a valid envelope for registered target', () => {
      const state = createSyncState()
      registerSyncManifest(state, makeManifest({ retentionMs: 7200000 }))
      const result = submitSyncEnvelope(state, makeEnvelope())
      assert.equal(result.accepted, true)
      assert.equal(state.envelopes.size, 1)
    })

    it('rejects envelope when target has no manifest', () => {
      const state = createSyncState()
      const result = submitSyncEnvelope(state, makeEnvelope())
      assert.equal(result.accepted, false)
      assert.ok('reason' in result && result.reason.includes('target_device_no_manifest'))
    })

    it('rejects envelope with scope not in target manifest', () => {
      const state = createSyncState()
      registerSyncManifest(state, makeManifest({ allowedScopes: ['device_health'] }))
      const result = submitSyncEnvelope(state, makeEnvelope({ scope: 'run_state' }))
      assert.equal(result.accepted, false)
      assert.ok('reason' in result && result.reason.includes('scope_not_allowed'))
    })

    it('rejects envelope exceeding max payload size', () => {
      const state = createSyncState()
      registerSyncManifest(state, makeManifest({ maxPayloadBytes: 4 }))
      const result = submitSyncEnvelope(state, makeEnvelope({ payloadSizeBytes: 6 }))
      assert.equal(result.accepted, false)
      assert.ok('reason' in result && result.reason.includes('payload_exceeds_max_size'))
    })

    it('rejects self-sync (source == target)', () => {
      const state = createSyncState()
      registerSyncManifest(state, makeManifest({ deviceId: 'device-a' }))
      const result = submitSyncEnvelope(state, makeEnvelope({ sourceDeviceId: 'device-a', targetDeviceId: 'device-a' }))
      assert.equal(result.accepted, false)
      assert.ok('reason' in result && result.reason.includes('cannot_sync_to_self'))
    })

    it('rejects when envelope limit reached', () => {
      const state = createSyncState(1)
      registerSyncManifest(state, makeManifest())
      submitSyncEnvelope(state, makeEnvelope({ envelopeId: 'env-1' }))
      const result = submitSyncEnvelope(state, makeEnvelope({ envelopeId: 'env-2' }))
      assert.equal(result.accepted, false)
      assert.ok('reason' in result && result.reason.includes('envelope_limit_reached'))
    })

    it('rejects duplicate envelope ids instead of replacing the first envelope', () => {
      const state = createSyncState()
      registerSyncManifest(state, makeManifest())
      submitSyncEnvelope(state, makeEnvelope())
      const result = submitSyncEnvelope(state, makeEnvelope({ payloadSizeBytes: 5 }))
      assert.equal(result.accepted, false)
      assert.equal('reason' in result && result.reason, 'envelope_id_already_exists')
      assert.equal(state.envelopes.get('env-001')?.payloadSizeBytes, 6)
    })

    it('rejects malformed payload integrity metadata', () => {
      const state = createSyncState()
      registerSyncManifest(state, makeManifest())
      const result = submitSyncEnvelope(state, makeEnvelope({ payloadSha256: 'not-a-sha256' }))
      assert.equal(result.accepted, false)
      assert.equal('reason' in result && result.reason, 'invalid_payload_hash')
    })

    it('rejects an envelope whose lifetime exceeds manifest retention', () => {
      const state = createSyncState()
      registerSyncManifest(state, makeManifest({ retentionMs: 1000 }))
      const result = submitSyncEnvelope(state, makeEnvelope({ expiresAt: '2026-08-22T11:01:01Z' }))
      assert.equal(result.accepted, false)
      assert.equal('reason' in result && result.reason, 'envelope_retention_exceeded')
    })
  })

  describe('expireEnvelopes', () => {
    it('removes expired envelopes', () => {
      const state = createSyncState()
      registerSyncManifest(state, makeManifest({ retentionMs: 7200000 }))
      submitSyncEnvelope(state, makeEnvelope({ envelopeId: 'e1', expiresAt: '2026-08-22T10:30:00Z' }))
      submitSyncEnvelope(state, makeEnvelope({ envelopeId: 'e2', expiresAt: '2026-08-22T12:00:00Z' }))
      const { expiredCount } = expireEnvelopes(state, '2026-08-22T11:00:00Z')
      assert.equal(expiredCount, 1)
      assert.equal(state.envelopes.size, 1)
    })
  })

  describe('listPendingEnvelopes', () => {
    it('returns envelopes for specified target device', () => {
      const state = createSyncState()
      registerSyncManifest(state, makeManifest({ deviceId: 'device-b' }))
      registerSyncManifest(state, makeManifest({ deviceId: 'device-c', manifestId: 'm2' }))
      submitSyncEnvelope(state, makeEnvelope({ envelopeId: 'e1', targetDeviceId: 'device-b' }))
      submitSyncEnvelope(state, makeEnvelope({ envelopeId: 'e2', targetDeviceId: 'device-c', sourceDeviceId: 'device-a' }))
      const pending = listPendingEnvelopes(state, 'device-b')
      assert.equal(pending.length, 1)
      assert.equal(pending[0].envelopeId, 'e1')
    })
  })

  describe('isForbiddenScope', () => {
    it('returns true for forbidden scopes', () => {
      assert.equal(isForbiddenScope('secrets'), true)
      assert.equal(isForbiddenScope('credentials'), true)
      assert.equal(isForbiddenScope('full_repository'), true)
      assert.equal(isForbiddenScope('worktree_contents'), true)
    })

    it('returns false for allowed scopes', () => {
      assert.equal(isForbiddenScope('run_state'), false)
      assert.equal(isForbiddenScope('device_health'), false)
    })
  })
})
