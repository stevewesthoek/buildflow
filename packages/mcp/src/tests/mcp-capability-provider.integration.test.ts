import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { connectMcpCapabilityProvider } from '../mcp-capability-provider.js'
import type { CapabilityProviderManifest } from '../capability-provider.js'
import { resolveCapabilities } from '../capability-resolution.js'
import { createAndPersistCapabilityPlan, listCapabilityPlans, transitionCapabilityPlan, type CapabilityGrantSnapshot } from '../capability-planning.js'
import { validateAndAuditCapability } from '../capability-pre-execution.js'
import { dispatchCapability } from '../capability-dispatch.js'
import { createMcpCapabilityAdapter } from '../mcp-capability-adapter.js'
import { verifyMcpExecutionProvenance } from '../mcp-execution-provenance.js'

test('connects a generic MCP capability provider through discovery to result delivery and provenance', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-mcp-provider-integration-')); const now = new Date(); const iso = (offset: number) => new Date(now.getTime() + offset).toISOString()
  try {
    const manifest: CapabilityProviderManifest = { kind: 'workbench.capability-provider.manifest', manifestVersion: 1, providerId: 'fixture.mcp.tools', providerType: 'capability', displayName: 'Generic MCP tools', providerVersion: '1', location: { kind: 'opaque-reference', value: 'mcp://fixture' }, ownership: { ownerType: 'user', ownerId: 'test' }, capabilities: ['inspect'], operations: [{ operationId: 'inspect', description: 'Inspect bounded fixture metadata', permission: 'read', inputSchemaVersion: '1' }], health: { state: 'healthy', observedAt: now.toISOString() }, compatibility: { contractVersion: '1' } }
    const connected = await connectMcpCapabilityProvider(manifest, { rootDir, registeredBy: 'requester', approvedBy: 'approver', sessionId: 'session-1' }); assert.equal(connected.ok, true); if (!connected.ok) return
    const provider = { ...connected.value.provider, enabled: true, registrationState: 'enabled' as const }
    const resolution = resolveCapabilities({ context: { sessionId: 'session-1', status: 'confirmed', sourceIds: ['fixture-source'] }, intent: { query: 'inspect', requestedCapabilities: ['inspect'], requiredPermissions: ['read'] }, providers: [provider], now: now.toISOString() })
    const grant: CapabilityGrantSnapshot = { grantId: 'grant-fixture', grantVersion: 1, state: 'active', permissions: ['read'], budgets: { maximumBytes: 10_000, maximumDurationMs: 30_000, maximumQueries: 1 } }
    const created = createAndPersistCapabilityPlan({ context: { sessionId: 'session-1', status: 'confirmed', sourceIds: ['fixture-source'] }, resolution, providers: [provider], grants: [grant], requestedOperation: 'inspect', requiredPermissions: ['read'], requiredBudgets: { maximumBytes: 100, maximumDurationMs: 1_000, maximumQueries: 1 }, expiresAt: iso(60_000), createdBy: 'requester', now: now.toISOString() }, { rootDir })
    assert.equal(created.ok, true); if (!created.ok) return; transitionCapabilityPlan(created.value.planId, 'reviewed', { rootDir }); transitionCapabilityPlan(created.value.planId, 'approved', { rootDir }); const stored = listCapabilityPlans({ rootDir }); assert.equal(stored.ok, true); if (!stored.ok || !stored.value[0]) return
    const executionRequest = { capabilityPlanId: stored.value[0].planId, contextSessionId: 'session-1', providerId: provider.providerId, capabilityId: 'inspect', manifestDigest: provider.manifestIdentity.digest, requestedOperation: 'inspect', timestamp: iso(1_000) }
    const validation = validateAndAuditCapability(executionRequest, { plan: stored.value[0], context: { sessionId: 'session-1', status: 'confirmed', sourceIds: ['fixture-source'] }, provider, grant, advertisedCapabilities: ['inspect'], operationAllowed: true, riskPolicy: { allowLowRisk: true, allowMediumRisk: true, allowHighRisk: false } }, { rootDir }); assert.equal(validation.ok, true); if (!validation.ok) return; assert.equal(validation.value.allowed, true)
    const adapter = createMcpCapabilityAdapter({ rootDir, boundary: async () => ({ ok: true, result: { inspected: true } }) }); const dispatch = dispatchCapability({ capabilityPlanId: stored.value[0].planId, validationId: validation.value.validationId, providerId: provider.providerId, capabilityId: 'inspect', requestedOperation: 'inspect', contextSessionId: 'session-1', auditIdentity: { requestedBy: 'requester', requestedAt: iso(1_000) } }, { plan: stored.value[0], validation: validation.value, provider, adapters: [adapter] }, { rootDir }); assert.equal(dispatch.ok, true); if (!dispatch.ok) return
    const result = await adapter.executeApproved({ dispatchId: dispatch.value.dispatchId, capabilityPlanId: stored.value[0].planId, validationId: validation.value.validationId, providerId: provider.providerId, capabilityId: 'inspect', requestedOperation: 'inspect', operation: 'inspect', contextSessionId: 'session-1', auditIdentity: { requestedBy: 'requester', requestedAt: iso(1_000) } }, { decision: dispatch.value, plan: stored.value[0], validation: validation.value, provider }); assert.equal(result.status, 'completed'); assert.deepEqual(result.output, { inspected: true }); assert.equal(verifyMcpExecutionProvenance({ rootDir }).invalid, 0); assert.equal(verifyMcpExecutionProvenance({ rootDir }).complete, 1)
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }) }
})
