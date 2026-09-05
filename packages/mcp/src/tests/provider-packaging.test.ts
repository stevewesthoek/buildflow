import assert from 'node:assert/strict'
import test from 'node:test'
import {
  validateCapabilityExecution,
  validateDiscovery,
  validateInstall,
  type WorkbenchProviderManifest
} from '../provider-packaging.js'

const brainMindManifest: WorkbenchProviderManifest = {
  providerId: 'reference.brain-mind',
  displayName: 'Brain/Mind Reference',
  version: '1.0.0',
  contractVersion: '1',
  sourceRevision: 'abc123',
  capabilities: ['context.lookup', 'skill.discover', 'runbook.list'],
  transportType: 'stdio'
}

const alternateManifest: WorkbenchProviderManifest = {
  providerId: 'alternate.fixture',
  displayName: 'Alternate Fixture Provider',
  version: '2.1.0',
  contractVersion: '1',
  sourceRevision: 'def456',
  capabilities: ['context.lookup'],
  transportType: 'stdio'
}

test('brain/mind reference installs with valid policy', () => {
  const result = validateInstall(brainMindManifest, new Set(['stdio', 'xpc']), 10)
  assert.deepEqual(result, { permitted: true })
})

test('alternate fixture installs with valid policy', () => {
  const result = validateInstall(alternateManifest, new Set(['stdio', 'xpc']), 10)
  assert.deepEqual(result, { permitted: true })
})

test('rejects unsupported transport', () => {
  const manifest: WorkbenchProviderManifest = { ...brainMindManifest, transportType: 'http_remote' }
  const result = validateInstall(manifest, new Set(['stdio', 'xpc']), 10)
  assert.equal(result.permitted, false)
  if (!result.permitted) {
    assert.equal(result.violations[0].boundary, 'network_policy')
  }
})

test('rejects excessive capabilities', () => {
  const manifest: WorkbenchProviderManifest = {
    ...brainMindManifest,
    capabilities: Array(50).fill('cap')
  }
  const result = validateInstall(manifest, new Set(['stdio']), 10)
  assert.equal(result.permitted, false)
  if (!result.permitted) {
    assert.ok(result.violations.some(v => v.boundary === 'command_allowlist'))
  }
})

test('rejects incompatible contract version', () => {
  const manifest: WorkbenchProviderManifest = { ...brainMindManifest, contractVersion: '99' }
  const result = validateInstall(manifest, new Set(['stdio']), 10)
  assert.equal(result.permitted, false)
  if (!result.permitted) {
    assert.ok(result.violations.some(v => v.boundary === 'validation_required'))
  }
})

test('discovery permitted with matching source lock', () => {
  const result = validateDiscovery('reference.brain-mind', 'source-a', 'source-a')
  assert.deepEqual(result, { permitted: true })
})

test('discovery permitted with no source lock', () => {
  const result = validateDiscovery('reference.brain-mind', null, 'source-a')
  assert.deepEqual(result, { permitted: true })
})

test('discovery blocked by cross-source lock', () => {
  const result = validateDiscovery('reference.brain-mind', 'source-a', 'source-b')
  assert.equal(result.permitted, false)
  if (!result.permitted) {
    assert.equal(result.violations[0].boundary, 'source_lock')
  }
})

test('allowlisted capability with grant permitted', () => {
  const result = validateCapabilityExecution(
    'reference.brain-mind',
    'context.lookup',
    new Set(['context.lookup', 'skill.discover']),
    new Set(),
    { grantAvailable: true, confirmationAvailable: true, requiresGrant: true, requiresConfirmation: false }
  )
  assert.deepEqual(result, { permitted: true })
})

test('unlisted capability blocked by allowlist', () => {
  const result = validateCapabilityExecution(
    'reference.brain-mind',
    'dangerous.action',
    new Set(['context.lookup']),
    new Set(['mcp.read']),
    { grantAvailable: true, confirmationAvailable: true, requiresGrant: false, requiresConfirmation: false }
  )
  assert.equal(result.permitted, false)
  if (!result.permitted) {
    assert.equal(result.violations[0].boundary, 'command_allowlist')
  }
})

test('missing grant blocks execution', () => {
  const result = validateCapabilityExecution(
    'alternate.fixture',
    'context.lookup',
    new Set(['context.lookup']),
    new Set(),
    { grantAvailable: false, confirmationAvailable: true, requiresGrant: true, requiresConfirmation: false }
  )
  assert.equal(result.permitted, false)
  if (!result.permitted) {
    assert.ok(result.violations.some(v => v.boundary === 'grant_required'))
  }
})

test('both reference and alternate pass same policy path', () => {
  const policy = { allowedTransports: new Set(['stdio']), maxCapabilities: 10 }
  const refResult = validateInstall(brainMindManifest, policy.allowedTransports, policy.maxCapabilities)
  const altResult = validateInstall(alternateManifest, policy.allowedTransports, policy.maxCapabilities)
  assert.deepEqual(refResult, { permitted: true })
  assert.deepEqual(altResult, { permitted: true })
})
