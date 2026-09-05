import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { clearContextSession, confirmContextProposalForActivation, createContextProposal, createContextSession } from './context-intelligence-store'
import { approveMcpContextSessionRenewal, executeMcpContextSessionRenewal, getMcpContextDiagnostics, recordMcpContextConsumption, requestMcpContextSessionRenewal, touchMcpContextSession, validateMcpContextSession } from './mcp-context-observability'

test('aggregates bounded privacy-preserving context outcomes deterministically', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-mcp-observability-'))
  try {
    const options = { storePath: path.join(rootDir, 'metrics.json'), now: () => new Date('2026-01-01T00:00:00.000Z'), maxEvents: 2 }
    recordMcpContextConsumption({ outcome: 'success', sessionId: 'session-1', sourceIds: ['repo'], providerIds: ['knowledge.docs'], packageId: 'package-1', freshnessWarnings: 0, packageBytes: 120, retrievalLatencyMs: 4, preparationLatencyMs: 8 }, options)
    recordMcpContextConsumption({ outcome: 'rejected', sessionId: 'session-1', sourceIds: ['repo'], providerIds: [], failureCode: 'source_not_active', freshnessWarnings: 0, packageBytes: 0, retrievalLatencyMs: 0, preparationLatencyMs: 2 }, options)
    recordMcpContextConsumption({ outcome: 'degraded', sessionId: 'session-2', sourceIds: ['repo'], providerIds: ['knowledge.docs'], packageId: 'package-2', freshnessWarnings: 1, packageBytes: 240, retrievalLatencyMs: 5, preparationLatencyMs: 9 }, options)
    const diagnostics = getMcpContextDiagnostics(options)
    assert.equal(diagnostics.status, 'degraded'); assert.equal(diagnostics.metrics.requests, 3); assert.equal(diagnostics.metrics.successfulDeliveries, 2); assert.equal(diagnostics.metrics.authorizationFailures, 1); assert.equal(diagnostics.metrics.staleContextUsage, 1); assert.deepEqual(diagnostics.activeSessionIds, ['session-1', 'session-2']); assert.equal(diagnostics.bridge.recentFailures[0]?.code, 'source_not_active'); assert.equal(diagnostics.lastPackage?.packageId, 'package-2'); assert.ok(JSON.stringify(diagnostics).includes('package-2')); assert.equal(JSON.stringify(diagnostics).includes('document content'), false)
    const persisted = JSON.parse(fs.readFileSync(options.storePath, 'utf8')) as { events: unknown[] }
    assert.equal(persisted.events.length, 2)
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }) }
})

test('tracks confirmed, active, idle, expiry, revocation, and renewal state fail closed', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-mcp-lifecycle-')); let current = new Date('2026-01-01T00:00:00.000Z')
  try {
    const contextStore = { rootDir, now: () => current }; const observability = { storePath: path.join(rootDir, 'metrics.json'), now: () => current }
    createContextSession({ sessionId: 'session-lifecycle', clientId: 'client', sourceIds: ['repo'], mode: 'single', expiresAt: '2026-01-01T01:00:00.000Z' }, contextStore)
    const proposed = validateMcpContextSession('session-lifecycle', { contextStore, observability }); assert.equal(proposed.ok, false); if (!proposed.ok) assert.equal(proposed.code, 'session_unconfirmed')
    createContextProposal({ proposalId: 'proposal-lifecycle', sessionId: 'session-lifecycle', candidates: [{ sourceId: 'repo', confidenceScore: 1, matchReasons: ['explicit'] }] }, contextStore); assert.equal(confirmContextProposalForActivation('proposal-lifecycle', ['repo'], contextStore).ok, true)
    const confirmed = validateMcpContextSession('session-lifecycle', { contextStore, observability }); assert.equal(confirmed.ok, true); touchMcpContextSession('session-lifecycle', ['repo'], ['provider'], true, observability)
    current = new Date('2026-01-01T00:16:00.000Z'); const idle = validateMcpContextSession('session-lifecycle', { contextStore, observability }); assert.equal(idle.ok, true); if (idle.ok) assert.equal(idle.lifecycle.state, 'idle')
    assert.deepEqual(requestMcpContextSessionRenewal('session-lifecycle', observability), { ok: true, state: 'requested' })
    const missingAuthorization = approveMcpContextSessionRenewal('session-lifecycle', '2026-01-01T01:30:00.000Z', undefined, { contextStore, observability }); assert.equal('code' in missingAuthorization ? missingAuthorization.code : undefined, 'authorization_required')
    assert.deepEqual(approveMcpContextSessionRenewal('session-lifecycle', '2026-01-01T01:30:00.000Z', { authorizedBy: 'user-1', authority: 'explicit-user', reason: 'continue approved work', requestId: 'request-1' }, { contextStore, observability }), { ok: true, state: 'approved' })
    const executed = executeMcpContextSessionRenewal('session-lifecycle', { contextStore, observability }); assert.equal('state' in executed ? executed.state : undefined, 'executed')
    current = new Date('2026-01-01T01:31:00.000Z'); const expired = validateMcpContextSession('session-lifecycle', { contextStore, observability }); assert.equal(expired.ok, false); if (!expired.ok) assert.equal(expired.code, 'session_expired')
    clearContextSession('session-lifecycle', contextStore); const revoked = validateMcpContextSession('session-lifecycle', { contextStore, observability }); assert.equal(revoked.ok, false); if (!revoked.ok) assert.equal(revoked.code, 'session_revoked')
    const diagnostics = getMcpContextDiagnostics(observability); assert.ok(diagnostics.sessionLifecycle.revokedCount >= 1)
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }) }
})

test('enforces session ownership and recovers expired sessions without restoring privileges', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-mcp-ownership-')); let current = new Date('2026-01-01T00:00:00.000Z')
  try {
    const contextStore = { rootDir, now: () => current }; const observability = { storePath: path.join(rootDir, 'metrics.json'), now: () => current }
    assert.equal(createContextSession({ sessionId: 'owned-session', clientId: 'client', ownerId: 'owner-a', sourceIds: ['repo'], mode: 'single', expiresAt: '2026-01-01T00:01:00.000Z' }, contextStore).ok, true)
    const mismatch = validateMcpContextSession('owned-session', { contextStore, observability, ownerId: 'owner-b' }); assert.equal(mismatch.ok, false); if (!mismatch.ok) assert.equal(mismatch.code, 'owner_mismatch')
    createContextProposal({ proposalId: 'owned-proposal', sessionId: 'owned-session', candidates: [{ sourceId: 'repo', confidenceScore: 1, matchReasons: ['explicit'] }] }, contextStore); assert.equal(confirmContextProposalForActivation('owned-proposal', ['repo'], contextStore).ok, true)
    assert.equal(validateMcpContextSession('owned-session', { contextStore, observability, ownerId: 'owner-a' }).ok, true)
    current = new Date('2026-01-01T00:02:00.000Z'); const expired = validateMcpContextSession('owned-session', { contextStore, observability, ownerId: 'owner-a' }); assert.equal(expired.ok, false); if (!expired.ok) assert.equal(expired.code, 'session_expired')
    const recovered = validateMcpContextSession('owned-session', { contextStore, observability, ownerId: 'owner-a' }); assert.equal(recovered.ok, false); if (!recovered.ok) assert.equal(recovered.code, 'session_expired')
    const diagnostics = getMcpContextDiagnostics(observability); assert.ok(diagnostics.sessionLifecycle.expiredCount >= 1); assert.equal(diagnostics.activeSessionIds.includes('owned-session'), false)
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }) }
})
