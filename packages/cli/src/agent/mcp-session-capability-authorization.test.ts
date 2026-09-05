import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { confirmContextProposalForActivation, createContextProposal, createContextSession } from './context-intelligence-store'
import { authorizeMcpCapability, decideMcpCapability, getMcpCapabilityDiagnostics, requestMcpCapability, revokeMcpCapability } from './mcp-session-capability-authorization'

test('binds approved capabilities to one session with expiry and revocation enforcement', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-capability-auth-')); let current = new Date('2026-01-01T00:00:00.000Z'); const now = () => current; const contextStore = { rootDir, now }; const options = { storePath: path.join(rootDir, 'grants.json'), contextStore, now }
  try {
    for (const sessionId of ['session-a', 'session-b']) { createContextSession({ sessionId, clientId: sessionId, sourceIds: ['repo'], mode: 'single', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T01:00:00.000Z' }, contextStore); createContextProposal({ proposalId: `proposal-${sessionId}`, sessionId, candidates: [{ sourceId: 'repo', confidenceScore: 1, matchReasons: ['explicit'] }], createdAt: '2026-01-01T00:00:00.000Z' }, contextStore); assert.equal(confirmContextProposalForActivation(`proposal-${sessionId}`, ['repo'], contextStore).ok, true) }
    const missing = requestMcpCapability('session-a', 'context.read', 'explicit-user', '2026-01-01T00:30:00.000Z', options); assert.equal(missing.ok, true); if (!missing.ok) return
    const code = (value: ReturnType<typeof authorizeMcpCapability>) => 'code' in value ? value.code : undefined; assert.equal(code(authorizeMcpCapability('session-a', 'context.read', options)), 'grant_missing')
    const decision = decideMcpCapability(missing.grant.grantId, true, 'user-a', options); assert.equal(decision.ok, true); assert.equal(code(authorizeMcpCapability('session-b', 'context.read', options)), 'grant_missing'); assert.equal(authorizeMcpCapability('session-a', 'context.read', options).ok, true)
    assert.equal(revokeMcpCapability(missing.grant.grantId, options).ok, true); assert.equal(code(authorizeMcpCapability('session-a', 'context.read', options)), 'grant_revoked')
    const expiring = requestMcpCapability('session-a', 'context.search', 'explicit-user', '2026-01-01T00:01:00.000Z', options); assert.equal(expiring.ok, true); if (expiring.ok) { assert.equal(decideMcpCapability(expiring.grant.grantId, true, 'user-a', options).ok, true); current = new Date('2026-01-01T00:02:00.000Z'); assert.equal(code(authorizeMcpCapability('session-a', 'context.search', options)), 'grant_expired') }
    const diagnostics = getMcpCapabilityDiagnostics(options); assert.equal(diagnostics.grants.revoked, 1); assert.ok(diagnostics.recentEvents.some(item => item.eventType === 'approved')); assert.ok(diagnostics.recentEvents.some(item => item.eventType === 'revoked'))
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }) }
})
