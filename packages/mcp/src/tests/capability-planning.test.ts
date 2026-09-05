import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { discoverProviderManifests } from '../provider-discovery.js'
import { discoverIntoProviderInventory, transitionProviderRegistration, type ProviderInventoryRecord } from '../provider-inventory.js'
import { resolveCapabilities, type CapabilityResolution } from '../capability-resolution.js'
import { capabilityPlanDiagnostics, createAndPersistCapabilityPlan, listCapabilityPlans, revalidateCapabilityPlan, transitionCapabilityPlan, type CapabilityGrantSnapshot, type CapabilityPlanInput } from '../capability-planning.js'

function fixture(): { root: string; cleanup: () => void } { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-capability-plan-')); return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) } }
function build(root: string): { provider: ProviderInventoryRecord; resolution: CapabilityResolution; grant: CapabilityGrantSnapshot; input: CapabilityPlanInput } {
  const file = path.join(root, 'provider.json')
  fs.writeFileSync(file, JSON.stringify({ kind: 'workbench.provider.manifest', manifestVersion: 1, providerId: 'repo.tools', providerType: 'capability', displayName: 'Repo Tools', providerVersion: '1.0.0', location: { kind: 'opaque-reference', value: 'repo-tools' }, ownership: { ownerType: 'user', ownerId: 'owner' }, capabilities: ['repository.read'], health: { state: 'healthy', observedAt: '2026-08-23T00:00:00.000Z' }, compatibility: { contractVersion: '1' } }))
  const discovered = discoverProviderManifests([{ path: file }], { now: () => '2026-08-23T01:00:00.000Z' })
  const options = { rootDir: root, now: () => new Date('2026-08-23T02:00:00.000Z') }
  const stored = discoverIntoProviderInventory(discovered, 'test', options); assert.equal(stored.ok, true); if (!stored.ok) throw new Error('inventory failed')
  transitionProviderRegistration('repo.tools', 'reviewed', options); transitionProviderRegistration('repo.tools', 'registered', options); transitionProviderRegistration('repo.tools', 'enabled', options)
  const provider = stored.value[0]
  const resolution = resolveCapabilities({ context: { sessionId: 'session-1', status: 'confirmed', sourceIds: ['repo'] }, intent: { query: 'read repository', requestedCapabilities: ['repository.read'] }, providers: [{ ...provider, registrationState: 'enabled', enabled: true }], now: '2026-08-23T03:00:00.000Z' })
  const grant: CapabilityGrantSnapshot = { grantId: 'grant-1', grantVersion: 1, state: 'active', permissions: ['read'], budgets: { maximumBytes: 1000, maximumDurationMs: 1000, maximumQueries: 1 } }
  const input: CapabilityPlanInput = { context: { sessionId: 'session-1', status: 'confirmed', sourceIds: ['repo'] }, resolution, providers: [provider], grants: [grant], requestedOperation: 'read repository', requiredPermissions: ['read'], requiredBudgets: { maximumBytes: 100, maximumDurationMs: 100, maximumQueries: 1 }, expiresAt: '2026-08-23T05:00:00.000Z', createdBy: 'test', now: '2026-08-23T03:00:00.000Z' }
  return { provider, resolution, grant, input }
}

test('creates a deterministic reviewable plan bound to provider, context, grant, digest, and budgets', () => {
  const f = fixture()
  try {
    const { input } = build(f.root); const result = createAndPersistCapabilityPlan(input, { rootDir: f.root })
    assert.equal(result.ok, true); if (!result.ok) return
    assert.equal(result.value.approvalState, 'proposed'); assert.equal(result.value.validity, 'valid'); assert.equal(result.value.contextSessionId, 'session-1'); assert.match(result.value.capabilityManifestDigest, /^[a-f0-9]{64}$/)
    assert.equal(fs.statSync(path.join(f.root, 'workbench-capability-plans.json')).mode & 0o077, 0)
  } finally { f.cleanup() }
})

test('requires candidate eligibility and grant compatibility', () => {
  const f = fixture()
  try {
    const { input } = build(f.root); const noGrant = createAndPersistCapabilityPlan({ ...input, grants: [] }, { rootDir: f.root }); assert.equal(noGrant.ok, false); if (!noGrant.ok) assert.equal(noGrant.code, 'grant_missing')
    const badResolution = { ...input.resolution, candidates: input.resolution.candidates.map(candidate => ({ ...candidate, eligible: false })) }
    const noCandidate = createAndPersistCapabilityPlan({ ...input, resolution: badResolution }, { rootDir: f.root }); assert.equal(noCandidate.ok, false); if (!noCandidate.ok) assert.equal(noCandidate.code, 'candidate_ineligible')
  } finally { f.cleanup() }
})

test('enforces approval lifecycle and prevents invalid transitions', () => {
  const f = fixture()
  try {
    const { input } = build(f.root); const created = createAndPersistCapabilityPlan(input, { rootDir: f.root }); assert.equal(created.ok, true); if (!created.ok) return
    const options = { rootDir: f.root }; assert.equal(transitionCapabilityPlan(created.value.planId, 'approved', options).ok, false); assert.equal(transitionCapabilityPlan(created.value.planId, 'reviewed', options).ok, true); assert.equal(transitionCapabilityPlan(created.value.planId, 'approved', options).ok, true); assert.equal(transitionCapabilityPlan(created.value.planId, 'rejected', options).ok, false)
  } finally { f.cleanup() }
})

test('invalidates an approved plan when provider digest changes and exposes diagnostics', () => {
  const f = fixture()
  try {
    const { input, provider, grant } = build(f.root); const created = createAndPersistCapabilityPlan(input, { rootDir: f.root }); assert.equal(created.ok, true); if (!created.ok) return
    const options = { rootDir: f.root }; transitionCapabilityPlan(created.value.planId, 'reviewed', options); transitionCapabilityPlan(created.value.planId, 'approved', options)
    const invalid = revalidateCapabilityPlan(created.value.planId, { contextSessionId: 'session-1', contextStatus: 'confirmed', sourceIds: ['repo'], provider: { ...provider, manifestIdentity: { ...provider.manifestIdentity, digest: 'f'.repeat(64) } }, grant, now: '2026-08-23T03:30:00.000Z' }, options)
    assert.equal(invalid.ok, false); const plans = listCapabilityPlans(options); assert.equal(plans.ok, true); if (plans.ok) assert.equal(plans.value[0].validity, 'invalidated')
    const diagnostics = capabilityPlanDiagnostics(options); assert.equal(diagnostics.ok, true); if (diagnostics.ok) assert.deepEqual(diagnostics.value.invalidated, [created.value.planId])
  } finally { f.cleanup() }
})
