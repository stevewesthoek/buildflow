import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { discoverProviderManifests } from '../provider-discovery.js'
import { registerProvider, transitionProvider } from '../provider-onboarding.js'
import { decideProviderActivation, deactivateProvider, getProviderActivationDiagnostics, requestProviderActivation, resolveActiveProviders } from '../provider-activation.js'

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-provider-activation-'))
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-provider-activation-state-'))
  const manifest = { kind: 'workbench.provider.manifest', manifestVersion: 1, providerId: 'fixture.activation', providerType: 'capability', displayName: 'Activation Fixture', providerVersion: '1', location: { kind: 'local-path', value: root }, ownership: { ownerType: 'user', ownerId: 'test-user' }, capabilities: ['health'], health: { state: 'healthy', observedAt: '2026-08-24T00:00:00.000Z' }, compatibility: { contractVersion: '1' } }
  fs.writeFileSync(path.join(root, 'workbench.provider.json'), JSON.stringify(manifest))
  const options = { rootDir: state, authorizedBy: 'test-user', now: () => new Date('2026-08-24T00:00:00.000Z') }
  registerProvider(discoverProviderManifests([{ path: root }]), 'activation-test', options)
  transitionProvider('fixture.activation', 'reviewed', options); transitionProvider('fixture.activation', 'registered', options); transitionProvider('fixture.activation', 'enabled', options)
  return { root, state, options }
}

test('activation requires approval, selects only approved providers, and audits lifecycle', () => {
  const f = fixture()
  const request = requestProviderActivation('fixture.activation', 'requester', 'session-1', f.options)
  assert.equal(request.ok, true)
  if (!request.ok) return
  assert.deepEqual(resolveActiveProviders(f.options), { ok: true, value: [] })
  const approved = decideProviderActivation(request.value.activationId, true, 'approver', 'approved for bounded runtime use', f.options)
  assert.equal(approved.ok, true)
  assert.deepEqual(resolveActiveProviders(f.options), { ok: true, value: ['fixture.activation'] })
  assert.equal(deactivateProvider('fixture.activation', 'approver', 'maintenance', f.options).ok, true)
  const diagnostics = getProviderActivationDiagnostics(f.options)
  assert.deepEqual(diagnostics.activeProviderIds, [])
  assert.ok(diagnostics.recentEvents.some(event => event.eventType === 'activation.requested'))
  assert.ok(diagnostics.recentEvents.some(event => event.eventType === 'activation.approved'))
  assert.ok(diagnostics.recentEvents.some(event => event.eventType === 'provider.selected'))
  assert.ok(diagnostics.recentEvents.some(event => event.eventType === 'provider.deactivated'))
  fs.rmSync(f.root, { recursive: true, force: true }); fs.rmSync(f.state, { recursive: true, force: true })
})

test('unhealthy providers are rejected and recorded as blocked', () => {
  const f = fixture(); fs.rmSync(f.root, { recursive: true, force: true })
  const request = requestProviderActivation('fixture.activation', 'requester', undefined, f.options)
  assert.equal(request.ok, false)
  if (!request.ok) assert.equal(request.code, 'provider_unavailable')
  const diagnostics = getProviderActivationDiagnostics(f.options)
  assert.deepEqual(diagnostics.activeProviderIds, [])
  assert.ok(diagnostics.recentEvents.some(event => event.eventType === 'activation.rejected'))
  fs.rmSync(f.state, { recursive: true, force: true })
})
