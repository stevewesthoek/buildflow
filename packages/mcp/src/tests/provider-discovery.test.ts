import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  buildProviderInventory,
  discoverProviderManifests,
  parseProviderManifest,
  validateProviderManifest
} from '../provider-discovery.js'

function validManifest(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'workbench.provider.manifest',
    manifestVersion: 1,
    providerId: 'local.docs',
    providerType: 'knowledge',
    displayName: 'Local Documents',
    providerVersion: '1.0.0',
    location: { kind: 'local-path', value: '/tmp/local-docs' },
    ownership: { ownerType: 'user', ownerId: 'owner-1' },
    capabilities: ['read.documents'],
    health: { state: 'healthy', observedAt: '2026-08-23T00:00:00.000Z', revision: 'r1' },
    compatibility: { contractVersion: '1' },
    ...overrides
  }
}

function fixture(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-provider-discovery-'))
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

test('validates the generic workspace, knowledge, and capability manifest shape', () => {
  for (const providerType of ['workspace', 'knowledge', 'capability']) {
    assert.equal(validateProviderManifest(validManifest({ providerType })), true)
  }
  assert.equal(validateProviderManifest(validManifest({ providerId: 'Invalid ID' })), false)
  assert.throws(() => parseProviderManifest(validManifest({ compatibility: {} })))
})

test('discovers a manifest from a configured file or directory without executing anything', () => {
  const f = fixture()
  try {
    fs.writeFileSync(path.join(f.root, 'workbench.provider.json'), JSON.stringify(validManifest()))
    const result = discoverProviderManifests([{ path: f.root }], { now: () => '2026-08-23T01:00:00.000Z' })
    assert.equal(result.failures.length, 0)
    assert.equal(result.candidates.length, 1)
    assert.equal(result.candidates[0].providerId, 'local.docs')
    assert.equal(result.candidates[0].discoveredAt, '2026-08-23T01:00:00.000Z')
    assert.match(result.candidates[0].manifestDigest, /^[a-f0-9]{64}$/)
  } finally {
    f.cleanup()
  }
})

test('rejects unavailable, malformed, oversized, and invalid manifests fail-closed', () => {
  const f = fixture()
  try {
    fs.writeFileSync(path.join(f.root, 'bad.json'), '{not-json')
    fs.writeFileSync(path.join(f.root, 'large.json'), 'x'.repeat(3000))
    fs.writeFileSync(path.join(f.root, 'invalid.json'), JSON.stringify(validManifest({ providerId: 'Bad ID' })))
    const result = discoverProviderManifests([
      { path: path.join(f.root, 'missing.json') },
      { path: path.join(f.root, 'bad.json') },
      { path: path.join(f.root, 'large.json') },
      { path: path.join(f.root, 'invalid.json') }
    ], { maxManifestBytes: 2048 })
    assert.equal(result.candidates.length, 0)
    assert.deepEqual(result.failures.map(item => item.code), [
      'location_unavailable', 'manifest_invalid_json', 'manifest_too_large', 'manifest_invalid'
    ])
  } finally {
    f.cleanup()
  }
})

test('inventory detects duplicates and unavailable provider health deterministically', () => {
  const f = fixture()
  try {
    const first = path.join(f.root, 'first.json')
    const second = path.join(f.root, 'second.json')
    fs.writeFileSync(first, JSON.stringify(validManifest()))
    fs.writeFileSync(second, JSON.stringify(validManifest({ providerId: 'local.docs', health: { state: 'unreachable', observedAt: '2026-08-23T00:00:00.000Z' } })))
    const inventory = buildProviderInventory(discoverProviderManifests([{ path: first }, { path: second }]), '2026-08-23T02:00:00.000Z')
    assert.deepEqual(inventory.duplicateProviderIds, ['local.docs'])
    assert.deepEqual(inventory.providers.map(item => item.availability), ['duplicate', 'duplicate'])
    assert.equal(inventory.failures.at(-1)?.code, 'duplicate_provider')
    assert.equal(inventory.observedAt, '2026-08-23T02:00:00.000Z')
  } finally {
    f.cleanup()
  }
})

test('discovery reports incompatible contracts without granting authority', () => {
  const f = fixture()
  try {
    fs.writeFileSync(path.join(f.root, 'provider.manifest.json'), JSON.stringify(validManifest({ compatibility: { contractVersion: '99' } })))
    const result = discoverProviderManifests([{ path: f.root }])
    assert.equal(result.candidates[0].warnings.length, 1)
    assert.equal(result.candidates[0].manifest.compatibility.contractVersion, '99')
    const inventory = buildProviderInventory(result)
    assert.equal(inventory.providers[0].availability, 'available')
    assert.equal(inventory.providers[0].health, 'healthy')
  } finally {
    f.cleanup()
  }
})
