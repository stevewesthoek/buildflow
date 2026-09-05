import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createRegistryState,
  inspectProvider,
  listProviders,
  markStaleProviders,
  recentFailures,
  refreshProviderHealth,
  registerProvider,
  removeProvider
} from '../provider-registry.js'
import {
  WORKBENCH_PROVIDER_CONTRACT_VERSION,
  WORKBENCH_PROVIDER_KIND,
  type WorkbenchProviderLifecycleContract
} from '../provider-lifecycle.js'

function healthyContract(id: string = 'fixture.provider', version: string = WORKBENCH_PROVIDER_CONTRACT_VERSION): WorkbenchProviderLifecycleContract {
  return {
    kind: WORKBENCH_PROVIDER_KIND,
    identity: {
      providerId: id,
      displayName: `Fixture ${id}`,
      contractVersion: version,
      sourceRevision: 'rev-1'
    },
    health: 'healthy',
    freshnessTimestamp: '2026-08-21T12:00:00.000Z',
    compatible: true,
    lifecycleStatus: 'installed'
  }
}

test('list returns compact metadata for all registered providers', () => {
  const state = createRegistryState()
  registerProvider(state, healthyContract('provider.a'))
  registerProvider(state, healthyContract('provider.b'))

  const entries = listProviders(state)
  assert.equal(entries.length, 2)
  assert.ok(entries.some(e => e.providerId === 'provider.a'))
  assert.ok(entries.some(e => e.providerId === 'provider.b'))
  assert.equal(entries[0].health, 'healthy')
})

test('inspect returns full contract for known provider', () => {
  const state = createRegistryState()
  const contract = healthyContract()
  registerProvider(state, contract)

  const full = inspectProvider(state, 'fixture.provider')
  assert.deepEqual(full, contract)
})

test('inspect returns undefined for unknown provider', () => {
  const state = createRegistryState()
  assert.equal(inspectProvider(state, 'unknown'), undefined)
})

test('register admits healthy compatible provider', () => {
  const state = createRegistryState()
  const mutation = registerProvider(state, healthyContract())
  assert.deepEqual(mutation, { type: 'admitted', providerId: 'fixture.provider' })
  assert.equal(state.providers.size, 1)
})

test('register rejects duplicate identity visibly', () => {
  const state = createRegistryState()
  registerProvider(state, healthyContract())
  const mutation = registerProvider(state, healthyContract())
  assert.equal(mutation.type, 'rejected')
  if (mutation.type === 'rejected') {
    assert.equal(mutation.reason, 'duplicate_provider_identity')
  }
  assert.equal(state.providers.size, 1)
  assert.equal(state.failures.length, 1)
  assert.equal(state.failures[0].mode, 'duplicate_identity')
})

test('register rejects incompatible version visibly', () => {
  const state = createRegistryState()
  const mutation = registerProvider(state, healthyContract('bad.provider', '99'))
  assert.equal(mutation.type, 'rejected')
  assert.equal(state.providers.size, 0)
  assert.equal(state.failures[0].mode, 'incompatible_contract')
})

test('remove produces receipt and clears state', () => {
  const state = createRegistryState()
  registerProvider(state, healthyContract())
  const mutation = removeProvider(state, 'fixture.provider', '2026-08-21T13:00:00.000Z')
  assert.deepEqual(mutation, { type: 'removed', providerId: 'fixture.provider', receipt: '2026-08-21T13:00:00.000Z' })
  assert.equal(state.providers.has('fixture.provider'), false)
  assert.equal(state.failures.at(-1)?.mode, 'removed')
})

test('health refresh detects and records degradation', () => {
  const state = createRegistryState()
  registerProvider(state, healthyContract())

  const degraded: WorkbenchProviderLifecycleContract = {
    ...healthyContract(),
    health: 'stale',
    freshnessTimestamp: '2026-08-21T12:30:00.000Z'
  }
  const mutation = refreshProviderHealth(state, degraded)
  assert.deepEqual(mutation, { type: 'health_changed', providerId: 'fixture.provider', from: 'healthy', to: 'stale' })
  assert.equal(state.providers.get('fixture.provider')?.health, 'stale')
  assert.equal(state.failures.at(-1)?.mode, 'stale_revision')
})

test('mark stale providers by timestamp cutoff', () => {
  const state = createRegistryState()
  registerProvider(state, healthyContract('old.provider'))

  const fresh: WorkbenchProviderLifecycleContract = {
    ...healthyContract('fresh.provider'),
    freshnessTimestamp: '2026-08-21T14:00:00.000Z'
  }
  registerProvider(state, fresh)

  const mutations = markStaleProviders(state, '2026-08-21T13:00:00.000Z')
  assert.equal(mutations.length, 1)
  assert.equal(mutations[0].type, 'marked_stale')
  assert.equal(state.providers.get('old.provider')?.health, 'stale')
  assert.equal(state.providers.get('fresh.provider')?.health, 'healthy')
})

test('failures do not corrupt existing registry state', () => {
  const state = createRegistryState()
  registerProvider(state, healthyContract('good.provider'))

  const unhealthy: WorkbenchProviderLifecycleContract = {
    ...healthyContract('bad.provider'),
    health: 'stale'
  }
  registerProvider(state, unhealthy)

  assert.equal(state.providers.size, 1)
  assert.equal(state.providers.get('good.provider')?.health, 'healthy')
  assert.ok(state.failures.length > 0)
})

test('recentFailures bounds output', () => {
  const state = createRegistryState()
  for (let i = 0; i < 25; i++) {
    registerProvider(state, healthyContract(`dup.${i}`, '99'))
  }
  const recent = recentFailures(state, 10)
  assert.equal(recent.length, 10)
})
