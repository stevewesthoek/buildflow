import assert from 'node:assert/strict'
import test from 'node:test'
import { createCliCapabilityManifest, createOrchestratorCapabilityManifest, createSkillCapabilityManifest, discoverCapabilityEcosystemMetadata } from '../capability-ecosystem-adapters.js'
import { getCapabilityEcosystemDiagnostics } from '../capability-ecosystem-diagnostics.js'
import { registerCapabilityProvider, transitionCapabilityProvider } from '../capability-provider.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const base = { displayName: 'Example', providerVersion: '1.0.0', ownerId: 'owner', capabilities: ['capability.read'], permissions: [{ permission: 'capability.read' }] }
test('normalizes CLI metadata without accepting execution payloads', () => {
  const result = createCliCapabilityManifest({ ...base, providerId: 'cli.example', commands: [{ commandId: 'inspect', description: 'Inspect metadata', permission: 'capability.read', inputSchemaVersion: '1' }] })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.value.location.kind, 'opaque-reference')
})
test('normalizes skill and orchestrator metadata', () => {
  const skill = createSkillCapabilityManifest({ ...base, providerId: 'skill.example', skillDescription: 'Describes a skill', lifecycle: 'discovered' })
  const workflow = createOrchestratorCapabilityManifest({ ...base, providerId: 'orchestrator.example', workflows: [{ operationId: 'plan', description: 'Plan work', permission: 'workflow.plan', inputSchemaVersion: '1' }] })
  assert.equal(skill.ok, true); assert.equal(workflow.ok, true)
})
test('rejects unbounded or malformed CLI metadata', () => {
  const result = createCliCapabilityManifest({ ...base, providerId: 'cli.example', commands: [{ commandId: 'inspect', description: 'x'.repeat(501), permission: 'capability.read', inputSchemaVersion: '1' }] })
  assert.equal(result.ok, false)
})
test('discovery is metadata-only and deterministic', () => {
  const result = createCliCapabilityManifest({ ...base, providerId: 'cli.example', commands: [{ commandId: 'inspect', description: 'Inspect', permission: 'capability.read', inputSchemaVersion: '1' }] })
  assert.equal(result.ok, true)
  if (result.ok) { const discovered = discoverCapabilityEcosystemMetadata([{ ecosystem: 'cli', manifest: result.value }], new Date('2026-01-01T00:00:00.000Z')); assert.deepEqual(discovered.candidates.map(item => item.providerId), ['cli.example']); assert.equal(discovered.candidates[0]?.source, 'cli') }
})
test('ecosystem diagnostics project empty and disabled inventories fail safely', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-ecosystem-doctor-'))
  try {
    const empty = getCapabilityEcosystemDiagnostics({ rootDir })
    assert.equal(empty.readiness, 'unavailable')
    const manifest = createCliCapabilityManifest({ ...base, providerId: 'cli.disabled', commands: [{ commandId: 'inspect', description: 'Inspect', permission: 'capability.read', inputSchemaVersion: '1' }], health: { state: 'healthy', observedAt: '2026-01-01T00:00:00.000Z' } })
    assert.equal(manifest.ok, true)
    if (manifest.ok) {
      const discovered = discoverCapabilityEcosystemMetadata([{ ecosystem: 'cli', manifest: manifest.value }], new Date('2026-01-01T00:00:00.000Z'))
      const registered = registerCapabilityProvider(discovered.candidates[0], { rootDir, now: () => new Date('2026-01-01T00:00:00.000Z') })
      assert.equal(registered.ok, true)
      const lifecycleOptions = { rootDir, now: () => new Date('2026-01-01T00:00:00.000Z') }
      assert.equal(transitionCapabilityProvider('cli.disabled', 'reviewed', lifecycleOptions).ok, true)
      assert.equal(transitionCapabilityProvider('cli.disabled', 'registered', lifecycleOptions).ok, true)
      assert.equal(transitionCapabilityProvider('cli.disabled', 'disabled', lifecycleOptions).ok, true)
      const diagnostics = getCapabilityEcosystemDiagnostics({ rootDir })
      assert.equal(diagnostics.readiness, 'degraded')
      assert.deepEqual(diagnostics.ecosystems[0]?.unavailableProviderIds, ['cli.disabled'])
      assert.deepEqual(diagnostics.permissionStatus['cli.disabled'], ['disabled'])
    }
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }) }
})
