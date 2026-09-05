import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WORKBENCH_PROVIDER_CONTRACT_VERSION,
  WORKBENCH_PROVIDER_KIND,
  WORKBENCH_PROVIDER_LIFECYCLE_JSON_SCHEMA,
  evaluateProviderAdmission,
  parseProviderLifecycleContract,
  validateProviderLifecycleContract,
  type WorkbenchProviderLifecycleContract
} from '../provider-lifecycle.js'

const validContract: WorkbenchProviderLifecycleContract = {
  kind: WORKBENCH_PROVIDER_KIND,
  identity: {
    providerId: 'fixture.provider',
    displayName: 'Fixture Provider',
    contractVersion: WORKBENCH_PROVIDER_CONTRACT_VERSION,
    sourceRevision: 'rev-1'
  },
  health: 'healthy',
  freshnessTimestamp: '2026-08-21T00:00:00.000Z',
  compatible: true,
  lifecycleStatus: 'installed'
}

test('validates and parses a correct provider lifecycle contract', () => {
  assert.equal(validateProviderLifecycleContract(validContract), true)
  assert.deepEqual(parseProviderLifecycleContract(JSON.parse(JSON.stringify(validContract))), validContract)
})

test('rejects additional properties not in the schema', () => {
  const widened = { ...validContract, mount: true }
  assert.equal(validateProviderLifecycleContract(widened), false)
  assert.throws(() => parseProviderLifecycleContract(widened), /Invalid/)
})

test('rejects non-canonical timestamps', () => {
  const bad = { ...validContract, freshnessTimestamp: '2026-08-21' }
  assert.equal(validateProviderLifecycleContract(bad), false)
})

test('rejects invalid providerId format', () => {
  const bad = { ...validContract, identity: { ...validContract.identity, providerId: 'UPPERCASE' } }
  assert.equal(validateProviderLifecycleContract(bad), false)
})

test('admits healthy compatible installed provider with unique identity', () => {
  const result = evaluateProviderAdmission(validContract, new Set(), WORKBENCH_PROVIDER_CONTRACT_VERSION)
  assert.deepEqual(result, { admitted: true })
})

test('rejects incompatible contract version', () => {
  const result = evaluateProviderAdmission(validContract, new Set(), '99')
  assert.deepEqual(result, { admitted: false, reason: 'incompatible_contract_version' })
})

test('rejects duplicate provider identity', () => {
  const result = evaluateProviderAdmission(validContract, new Set(['fixture.provider']), WORKBENCH_PROVIDER_CONTRACT_VERSION)
  assert.deepEqual(result, { admitted: false, reason: 'duplicate_provider_identity' })
})

test('rejects incompatible provider', () => {
  const incompatible = { ...validContract, compatible: false }
  const result = evaluateProviderAdmission(incompatible, new Set(), WORKBENCH_PROVIDER_CONTRACT_VERSION)
  assert.deepEqual(result, { admitted: false, reason: 'provider_incompatible' })
})

test('rejects unhealthy provider', () => {
  const stale: WorkbenchProviderLifecycleContract = { ...validContract, health: 'stale' }
  const result = evaluateProviderAdmission(stale, new Set(), WORKBENCH_PROVIDER_CONTRACT_VERSION)
  assert.deepEqual(result, { admitted: false, reason: 'provider_unhealthy' })
})

test('rejects provider not in installed state', () => {
  const installing: WorkbenchProviderLifecycleContract = { ...validContract, lifecycleStatus: 'installing' }
  const result = evaluateProviderAdmission(installing, new Set(), WORKBENCH_PROVIDER_CONTRACT_VERSION)
  assert.deepEqual(result, { admitted: false, reason: 'provider_not_installed' })
})

test('exports a JSON-serializable strict schema', () => {
  const schema = JSON.parse(JSON.stringify(WORKBENCH_PROVIDER_LIFECYCLE_JSON_SCHEMA))
  assert.equal(schema.additionalProperties, false)
  assert.ok(schema.required.includes('kind'))
  assert.ok(schema.required.includes('identity'))
  assert.ok(schema.required.includes('health'))
  assert.ok(schema.required.includes('lifecycleStatus'))
  assert.equal(schema.properties.identity.additionalProperties, false)
  assert.equal('mount' in schema.properties, false)
  assert.equal('path' in schema.properties, false)
})
