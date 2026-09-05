import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadConfiguredProviderRuntime, loadWorkspaceConfiguration, validateWorkspaceConfiguration } from '../workspace-configuration.js'

function manifest(providerId: string, providerType: 'knowledge' | 'capability') {
  return {
    kind: 'workbench.provider.manifest', manifestVersion: 1, providerId, providerType,
    displayName: providerId, providerVersion: '1.0.0', location: { kind: 'local-path', value: '/tmp/provider' },
    ownership: { ownerType: 'user', ownerId: 'test-user' }, capabilities: ['health'],
    health: { state: 'healthy', observedAt: '2026-08-24T00:00:00.000Z' }, compatibility: { contractVersion: '1' }
  }
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-config-'))
  const knowledgeManifest = path.join(root, 'knowledge.json')
  const capabilityManifest = path.join(root, 'capability.json')
  fs.writeFileSync(knowledgeManifest, JSON.stringify(manifest('knowledge.local', 'knowledge')))
  fs.writeFileSync(capabilityManifest, JSON.stringify(manifest('capability.local', 'capability')))
  const configPath = path.join(root, 'workspace-config.json')
  fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, workspaces: [{ workspaceId: 'main', name: 'Main', root, mode: 'default', enabled: true }], knowledgeProviders: [{ providerId: 'knowledge.local', manifestPath: knowledgeManifest, enabled: true, ownerType: 'user', ownerId: 'test-user' }], capabilityProviders: [{ providerId: 'capability.local', manifestPath: capabilityManifest, enabled: true, ownerType: 'user', ownerId: 'test-user' }] }))
  return { root, configPath }
}

test('loads and validates neutral workspace/provider configuration', () => {
  const { configPath } = fixture()
  const loaded = loadWorkspaceConfiguration({ configPath })
  assert.equal(loaded.ok, true)
  if (!loaded.ok) return
  assert.equal(loaded.value.value.workspaces[0].workspaceId, 'main')
  assert.equal(validateWorkspaceConfiguration(loaded.value.value), true)
})

test('discovers configured providers without enabling or activating them', () => {
  const { configPath } = fixture()
  const runtime = loadConfiguredProviderRuntime({ configPath, now: () => '2026-08-24T00:01:00.000Z' })
  assert.equal(runtime.ok, true)
  if (!runtime.ok) return
  assert.equal(runtime.value.knowledgeProviders[0].state, 'discovered')
  assert.equal(runtime.value.capabilityProviders[0].state, 'discovered')
  assert.equal(runtime.value.knowledgeProviders[0].candidate?.manifest.providerType, 'knowledge')
})

test('fails closed for disabled, missing, and mismatched provider manifests', () => {
  const { root } = fixture()
  const configPath = path.join(root, 'invalid-config.json')
  fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, workspaces: [], knowledgeProviders: [{ providerId: 'knowledge.local', manifestPath: path.join(root, 'missing.json'), enabled: true, ownerType: 'user', ownerId: 'test-user' }], capabilityProviders: [{ providerId: 'capability.local', manifestPath: path.join(root, 'knowledge.json'), enabled: true, ownerType: 'user', ownerId: 'test-user' }]}))
  const runtime = loadConfiguredProviderRuntime({ configPath })
  assert.equal(runtime.ok, true)
  if (!runtime.ok) return
  assert.equal(runtime.value.knowledgeProviders[0].state, 'unavailable')
  assert.equal(runtime.value.capabilityProviders[0].state, 'invalid')
})
