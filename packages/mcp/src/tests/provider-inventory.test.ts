import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { discoverProviderManifests } from '../provider-discovery.js'
import {
  describeMcpProvider,
  discoverIntoProviderInventory,
  getProviderInventoryStorePath,
  inspectProviderInventory,
  listProviderInventory,
  projectProviderContext,
  readProviderInventory,
  transitionProviderRegistration
} from '../provider-inventory.js'

function fixture(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-provider-inventory-'))
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

function manifest(providerId: string, state = 'healthy') {
  return {
    kind: 'workbench.provider.manifest', manifestVersion: 1, providerId, providerType: 'capability',
    displayName: providerId, providerVersion: '1.0.0', location: { kind: 'opaque-reference', value: `provider:${providerId}` },
    ownership: { ownerType: 'user', ownerId: 'owner-1' }, capabilities: ['read.status', 'write.change'],
    health: { state, observedAt: '2026-08-23T00:00:00.000Z' }, compatibility: { contractVersion: '1' }
  }
}

function discover(root: string, values: unknown[]) {
  const locations = values.map((value, index) => {
    const file = path.join(root, `${index}.json`)
    fs.writeFileSync(file, JSON.stringify(value))
    return { path: file }
  })
  return discoverProviderManifests(locations, { now: () => '2026-08-23T01:00:00.000Z' })
}

test('persists discovered inventory atomically with deterministic ordering and bounded state', () => {
  const f = fixture()
  try {
    const result = discoverIntoProviderInventory(discover(f.root, [manifest('zeta'), manifest('alpha')]), 'test-fixture', { rootDir: f.root, now: () => new Date('2026-08-23T02:00:00.000Z') })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.value.map(item => item.providerId), ['alpha', 'zeta'])
    assert.equal(fs.statSync(getProviderInventoryStorePath({ rootDir: f.root })).mode & 0o077, 0)
    assert.equal(readProviderInventory({ rootDir: f.root }).ok, true)
  } finally { f.cleanup() }
})

test('rejects duplicate discovery and corrupt inventory fail-closed', () => {
  const f = fixture()
  try {
    const result = discoverIntoProviderInventory(discover(f.root, [manifest('same'), manifest('same')]), 'test-fixture', { rootDir: f.root })
    assert.equal(result.ok, true)
    const listed = listProviderInventory({ rootDir: f.root })
    assert.equal(listed.ok, true)
    if (listed.ok) assert.equal(listed.value.length, 0)
    fs.writeFileSync(getProviderInventoryStorePath({ rootDir: f.root }), '{bad')
    const corrupt = listProviderInventory({ rootDir: f.root })
    assert.equal(corrupt.ok, false)
    if (!corrupt.ok) assert.equal(corrupt.code, 'inventory_corrupt')
  } finally { f.cleanup() }
})

test('enforces discovered -> reviewed -> registered -> enabled lifecycle and disable/re-enable', () => {
  const f = fixture()
  try {
    const options = { rootDir: f.root }
    assert.equal(discoverIntoProviderInventory(discover(f.root, [manifest('provider.one')]), 'test', options).ok, true)
    assert.equal(transitionProviderRegistration('provider.one', 'registered', options).ok, false)
    assert.equal(transitionProviderRegistration('provider.one', 'reviewed', options).ok, true)
    assert.equal(transitionProviderRegistration('provider.one', 'registered', options).ok, true)
    assert.equal(transitionProviderRegistration('provider.one', 'enabled', options).ok, true)
    const inspected = inspectProviderInventory('provider.one', options)
    assert.equal(inspected.ok, true)
    if (inspected.ok) assert.equal(inspected.value?.enabled, true)
    assert.equal(transitionProviderRegistration('provider.one', 'disabled', options).ok, true)
    assert.equal(transitionProviderRegistration('provider.one', 'enabled', options).ok, true)
  } finally { f.cleanup() }
})

test('projects available capabilities without treating them as trusted authority', () => {
  const f = fixture()
  try {
    const options = { rootDir: f.root }
    discoverIntoProviderInventory(discover(f.root, [manifest('available'), manifest('offline', 'unreachable')]), 'test', options)
    transitionProviderRegistration('available', 'reviewed', options)
    transitionProviderRegistration('available', 'registered', options)
    const context = projectProviderContext(options)
    assert.deepEqual(context, { availableProviderIds: ['available'], capabilities: ['read.status', 'write.change'], trustedProviderIds: ['available'] })
  } finally { f.cleanup() }
})

test('classifies existing MCP registration metadata without changing its contract', () => {
  const metadata = describeMcpProvider({
    schemaVersion: '1.0.0', kind: 'workbench.mcp.registration', registrationId: 'workbench-codex',
    server: { id: 'workbench', transport: 'stdio', executable: { command: '/usr/bin/node', args: [], cwd: '/tmp' }, credentialReferences: [{ id: 'credential', kind: 'file', path: '/tmp/token', inject: { kind: 'environment', name: 'WORKBENCH_MCP_CREDENTIAL_FILE' } }] },
    target: { client: { id: 'generic-client', adapterId: 'adapter-1' }, project: { root: '/tmp' }, profile: 'workbench' },
    availability: { startup: 'required', onUnavailable: 'block_startup' }, admission: { tools: ['getWorkbenchStatus'], commandKinds: [] },
    compatibility: { registrationApiVersion: '1.0.0', minimumWorkbenchVersion: '1.3.12-beta', adapterApiVersion: '1.0.0' },
    rollback: { strategy: 'restore_previous_or_remove', backupRequired: true, metadata: {} }
  })
  assert.deepEqual(metadata.advertisedCapabilities, ['getWorkbenchStatus'])
  assert.equal(metadata.transport, 'stdio')
  assert.equal(metadata.authentication, 'required')
})
