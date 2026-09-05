import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { getMcpCapabilityAdoptionWorkflow, listMcpCapabilityDescriptions } from '../mcp-capability-adoption.js'
import { discoverCapabilityProviders, registerCapabilityProvider, transitionCapabilityProvider } from '../capability-provider.js'
import type { CapabilityProviderManifest } from '../capability-provider.js'

test('describes approved capability workflow without exposing execution authority', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-mcp-adoption-'))
  try {
    const manifest: CapabilityProviderManifest = { kind: 'workbench.capability-provider.manifest', manifestVersion: 1, providerId: 'fixture.adoption', providerType: 'capability', displayName: 'Adoption fixture', providerVersion: '1', location: { kind: 'opaque-reference', value: 'fixture://adoption' }, ownership: { ownerType: 'user', ownerId: 'test' }, capabilities: ['inspect'], operations: [{ operationId: 'inspect', description: 'Inspect bounded metadata', permission: 'read', inputSchemaVersion: '1' }], health: { state: 'healthy', observedAt: '2026-08-24T00:00:00.000Z' }, compatibility: { contractVersion: '1' } }
    const candidate = discoverCapabilityProviders([{ source: 'mcp', manifest }]).candidates[0]!; assert.equal(registerCapabilityProvider(candidate, { rootDir }).ok, true); transitionCapabilityProvider('fixture.adoption', 'reviewed', { rootDir }); transitionCapabilityProvider('fixture.adoption', 'registered', { rootDir }); transitionCapabilityProvider('fixture.adoption', 'enabled', { rootDir })
    const descriptions = listMcpCapabilityDescriptions({ rootDir }); assert.equal(descriptions[0]?.description, 'Inspect bounded metadata'); assert.equal(descriptions[0]?.approvalRequired, true); assert.equal(descriptions[0]?.executionAvailable, true)
    const full = getMcpCapabilityAdoptionWorkflow({ clientId: 'neutral-client', supportsCapabilityDiscovery: true, supportsContextWorkflow: true, supportsApprovalMetadata: true }, { rootDir }); assert.equal(full.client.mode, 'full'); assert.deepEqual(full.steps, ['request', 'discover', 'plan', 'approve', 'validate', 'execute', 'deliver']); assert.equal(full.context.provenanceIncluded, true)
    assert.equal(getMcpCapabilityAdoptionWorkflow({ clientId: 'legacy-client' }, { rootDir }).client.fallback, 'manual_approval')
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }) }
})
