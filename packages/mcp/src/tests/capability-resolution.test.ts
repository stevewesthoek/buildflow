import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { discoverProviderManifests } from '../provider-discovery.js'
import { discoverIntoProviderInventory, transitionProviderRegistration, type ProviderInventoryRecord } from '../provider-inventory.js'
import { getCapabilityDecisionStorePath, listCapabilityDecisions, resolveAndRecordCapabilities, resolveCapabilities } from '../capability-resolution.js'

function fixture(): { root: string; cleanup: () => void } { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-capability-resolution-')); return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) } }
function manifest(providerId: string, capabilities: string[], health = 'healthy') { return { kind: 'workbench.provider.manifest', manifestVersion: 1, providerId, providerType: 'capability', displayName: providerId, providerVersion: '1.0.0', location: { kind: 'opaque-reference', value: `provider:${providerId}` }, ownership: { ownerType: 'user', ownerId: 'owner' }, capabilities, health: { state: health, observedAt: '2026-08-23T00:00:00.000Z' }, compatibility: { contractVersion: '1' } } }
function addProvider(root: string, providerId: string, capabilities: string[], health = 'healthy'): ProviderInventoryRecord[] {
  const file = path.join(root, `${providerId}.json`); fs.writeFileSync(file, JSON.stringify(manifest(providerId, capabilities, health)))
  const discovered = discoverProviderManifests([{ path: file }], { now: () => '2026-08-23T01:00:00.000Z' })
  const options = { rootDir: root, now: () => new Date('2026-08-23T02:00:00.000Z') }
  const result = discoverIntoProviderInventory(discovered, 'test', options); assert.equal(result.ok, true); if (!result.ok) throw new Error('inventory discovery failed')
  return result.value
}
function register(root: string, providerId: string) { const options = { rootDir: root, now: () => new Date('2026-08-23T03:00:00.000Z') }; transitionProviderRegistration(providerId, 'reviewed', options); transitionProviderRegistration(providerId, 'registered', options); transitionProviderRegistration(providerId, 'enabled', options); return options }

test('ranks exact capability and deterministic matches without execution', () => {
  const f = fixture()
  try {
    const providers = addProvider(f.root, 'repo-tools', ['repository.read', 'architecture.graph'])
    const result = resolveCapabilities({ context: { sessionId: 's1', status: 'confirmed', sourceIds: ['repo'] }, intent: { query: 'Analyze repository architecture', requestedCapabilities: ['architecture.graph'] }, providers: providers.map(p => ({ ...p, registrationState: 'enabled', enabled: true })), catalog: [{ capabilityId: 'architecture.graph', displayName: 'Architecture Graph Analyzer', description: 'Analyze repository architecture', requiredPermissions: ['read'], supportedContext: ['repository'] }], now: '2026-08-23T04:00:00.000Z' })
    assert.equal(result.candidates[0].capabilityId, 'architecture.graph')
    assert.equal(result.candidates[0].eligible, true)
    assert.equal(result.candidates[0].score, 100)
    assert.equal(result.availableCapabilities[0], 'architecture.graph')
  } finally { f.cleanup() }
})

test('rejects disabled, unhealthy, context-disallowed, and incompatible permissions', () => {
  const f = fixture()
  try {
    const providers = addProvider(f.root, 'unsafe-tools', ['repository.write'])
    const candidate = providers[0]
    const result = resolveCapabilities({ context: { sessionId: 's2', status: 'confirmed', sourceIds: [], allowedProviderIds: ['other'], allowedPermissions: ['read'] }, intent: { query: 'write repository', requiredPermissions: ['write'] }, providers: [{ ...candidate, registrationState: 'registered', enabled: false, health: 'degraded' }], now: '2026-08-23T04:00:00.000Z' })
    assert.equal(result.candidates[0].eligible, false)
    assert.deepEqual(result.candidates[0].rejectionReasons, ['provider_disabled', 'provider_unhealthy', 'context_not_allowed', 'permissions_incompatible'])
    assert.deepEqual(result.unavailableCapabilities, ['repository.write'])
  } finally { f.cleanup() }
})

test('requires a confirmed or proposed context and excludes unavailable providers', () => {
  const f = fixture()
  try {
    const providers = [...addProvider(f.root, 'healthy', ['read.docs']), ...addProvider(f.root, 'offline', ['read.docs'], 'unreachable')]
    const result = resolveCapabilities({ context: { sessionId: 's3', status: 'expired', sourceIds: [] }, intent: { query: 'read docs' }, providers: providers.map(p => ({ ...p, registrationState: 'registered', enabled: false })), now: '2026-08-23T04:00:00.000Z' })
    assert.equal(result.candidates.every(item => !item.eligible), true)
    assert.equal(result.providerHealthImpact.find(item => item.providerId === 'offline')?.impact, 'unavailable')
  } finally { f.cleanup() }
})

test('records capability decisions durably and reports inventory failures', () => {
  const f = fixture()
  try {
    addProvider(f.root, 'reader', ['read.docs']); const options = register(f.root, 'reader')
    const result = resolveAndRecordCapabilities({ context: { sessionId: 's4', status: 'confirmed', sourceIds: [] }, intent: { query: 'read docs' }, options })
    assert.equal(result.ok, true); assert.equal(fs.statSync(getCapabilityDecisionStorePath(options)).mode & 0o077, 0)
    const listed = listCapabilityDecisions(options); assert.equal(listed.ok, true); if (listed.ok) assert.equal(listed.value.length, 1)
  } finally { f.cleanup() }
})
