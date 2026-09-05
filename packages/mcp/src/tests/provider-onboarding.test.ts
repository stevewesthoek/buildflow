import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createFilesystemKnowledgeManifest } from '../filesystem-knowledge-provider.js'
import { activateKnowledgeProvider, verifyProviderIdentity, verifyProviderPath } from '../provider-onboarding.js'
import { initializeKnowledgeContextRuntime } from '../knowledge-context-runtime.js'
import { discoverProviderManifests } from '../provider-discovery.js'
import { inspectProvider, listProviders, registerProvider, removeProvider, transitionProvider } from '../provider-onboarding.js'

test('provider identity is deterministic and verifies expected digest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-provider-onboarding-'))
  const manifest = createFilesystemKnowledgeManifest({ rootPath: root, providerId: 'fixture.docs' })
  const identity = verifyProviderIdentity(manifest as never)
  assert.equal(identity.ok, true)
  if (identity.ok) assert.equal(verifyProviderIdentity(manifest as never, identity.value.manifestDigest).ok, true)
  fs.rmSync(root, { recursive: true, force: true })
})

test('filesystem knowledge activation is explicit, persisted, and health checked', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-provider-onboarding-'))
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-provider-state-'))
  fs.writeFileSync(path.join(root, 'README.md'), 'bounded provider fixture')
  const manifest = createFilesystemKnowledgeManifest({ rootPath: root, providerId: 'fixture.docs' })
  const result = await activateKnowledgeProvider(manifest, { rootDir: state, knowledgeRegistry: { rootDir: state }, authorizedBy: 'requester', activationApprovedBy: 'approver' })
  assert.equal(result.ok, true)
  assert.equal(await verifyProviderPath(root), true)
  assert.equal(fs.existsSync(path.join(state, 'workbench-knowledge-providers.json')), true)
  const restarted = await initializeKnowledgeContextRuntime({ registry: { rootDir: state }, indexRootDir: state, activeProviderIds: ['fixture.docs'] })
  assert.deepEqual(restarted.status().enabledProviders, ['fixture.docs'])
  assert.equal(restarted.status().retrievalReady, true)
  fs.renameSync(root, `${root}.offline`)
  const unavailable = await initializeKnowledgeContextRuntime({ registry: { rootDir: state }, indexRootDir: state })
  assert.equal(unavailable.status().readiness, 'unavailable')
  fs.renameSync(`${root}.offline`, root)
  const recovered = await initializeKnowledgeContextRuntime({ registry: { rootDir: state }, indexRootDir: state })
  assert.equal(recovered.status().retrievalReady, true)
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(state, { recursive: true, force: true })
})

test('unavailable filesystem providers fail closed', async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-provider-state-'))
  const manifest = createFilesystemKnowledgeManifest({ rootPath: path.join(state, 'missing'), providerId: 'fixture.missing' })
  const result = await activateKnowledgeProvider(manifest, { rootDir: state, knowledgeRegistry: { rootDir: state }, authorizedBy: 'test-user', activationApprovedBy: 'approver' })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'provider_unavailable')
  fs.rmSync(state, { recursive: true, force: true })
})

test('knowledge connection requires explicit activation approval', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-provider-onboarding-'))
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-provider-state-'))
  const manifest = createFilesystemKnowledgeManifest({ rootPath: root, providerId: 'fixture.pending' })
  const result = await activateKnowledgeProvider(manifest, { rootDir: state, knowledgeRegistry: { rootDir: state }, authorizedBy: 'requester' })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'activation_required')
  const restarted = await initializeKnowledgeContextRuntime({ registry: { rootDir: state }, indexRootDir: state, activeProviderIds: [] })
  assert.deepEqual(restarted.status().availableProviders, [])
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(state, { recursive: true, force: true })
})

test('operator workflow lists, inspects, enables, and removes provider metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-provider-workflow-'))
  const manifest = {
    kind: 'workbench.provider.manifest', manifestVersion: 1, providerId: 'fixture.tools', providerType: 'capability', displayName: 'Fixture Tools', providerVersion: '1',
    location: { kind: 'local-path', value: root }, ownership: { ownerType: 'user', ownerId: 'test-user' }, capabilities: ['health'],
    health: { state: 'healthy', observedAt: '2026-08-24T00:00:00.000Z' }, compatibility: { contractVersion: '1' }
  }
  fs.writeFileSync(path.join(root, 'workbench.provider.json'), JSON.stringify(manifest))
  const options = { rootDir: fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-provider-state-')), authorizedBy: 'test-user' }
  const discovered = discoverProviderManifests([{ path: root }])
  assert.equal(registerProvider(discovered, 'fixture-test', options).ok, true)
  assert.equal(listProviders(options).ok, true)
  const inspected = inspectProvider('fixture.tools', options)
  assert.equal(inspected.ok, true)
  assert.equal(transitionProvider('fixture.tools', 'reviewed', options).ok, true)
  assert.equal(transitionProvider('fixture.tools', 'registered', options).ok, true)
  assert.equal(transitionProvider('fixture.tools', 'enabled', options).ok, true)
  assert.equal(removeProvider('fixture.tools', options).ok, true)
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(options.rootDir, { recursive: true, force: true })
})
