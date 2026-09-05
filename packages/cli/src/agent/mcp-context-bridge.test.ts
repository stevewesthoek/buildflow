import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { confirmContextProposalForActivation, createContextProposal, createContextSession } from './context-intelligence-store'
import { consumePreparedMcpContext } from './mcp-context-bridge'
import { decideMcpCapability, requestMcpCapability } from './mcp-session-capability-authorization'

const prepared = (sourceIds: string[] = ['repo']) => ({ mode: 'prepare_task_context' as const, status: 'ok' as const, query: 'auth', sourceIds, summary: 'bounded', exactVerification: true, exactEvidence: [], topFiles: [], exactReadPlan: [], uncertainty: [], searchNotes: [], candidates: [], strategy: { kind: 'deterministic_search' as const, localAiUsed: false as const, reason: 'test' }, timings: { totalMs: 1, searchMs: 1, readMs: 0 }, contextMetadata: { selectedSource: 'repo', freshnessState: 'fresh', indexedRevision: 'r2', observedRevision: 'r2', indexGeneration: '3', warnings: [] }, knowledgeContext: { packageId: 'knowledge-context-1', auditReferences: ['knowledge-context-1'], sourceIds: ['knowledge.docs'], files: 1, bytes: 20, tokens: 5, queries: 1, warnings: [], documents: [], sources: [{ providerId: 'knowledge.docs', freshness: 'r2', indexGeneration: 3, freshnessState: 'fresh' }], diagnostics: { available: true, latencyMs: 2, packageBytes: 400, failures: 0 } } })

test('requires a session and rejects unconfirmed sessions', () => {
  const missing = consumePreparedMcpContext(prepared(), undefined)
  assert.equal(missing.ok, false); if (!missing.ok) assert.equal(missing.code, 'context_session_required')
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-mcp-context-'))
  try {
    createContextSession({ sessionId: 'session-proposed', clientId: 'mcp-client', sourceIds: ['repo'], mode: 'single' }, { rootDir })
    const result = consumePreparedMcpContext(prepared(), 'session-proposed', { storeOptions: { rootDir } })
    assert.equal(result.ok, false); if (!result.ok) assert.equal(result.code, 'context_session_not_confirmed')
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }) }
})

test('consumes only confirmed active context and preserves bounded metadata', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-mcp-context-'))
  try {
    createContextSession({ sessionId: 'session-confirmed', clientId: 'mcp-client', sourceIds: ['repo'], mode: 'single', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T01:00:00.000Z' }, { rootDir, now: () => new Date('2026-01-01T00:00:00.000Z') })
    const contextStore = { rootDir, now: () => new Date('2026-01-01T00:00:00.000Z') }
    createContextProposal({ proposalId: 'proposal-1', sessionId: 'session-confirmed', candidates: [{ sourceId: 'repo', confidenceScore: 1, matchReasons: ['explicit'] }], createdAt: '2026-01-01T00:00:00.000Z' }, contextStore)
    const confirmed = confirmContextProposalForActivation('proposal-1', ['repo'], contextStore)
    assert.equal(confirmed.ok, true)
    const capabilityStore = { storePath: path.join(rootDir, 'capabilities.json'), contextStore, now: contextStore.now }; const requested = requestMcpCapability('session-confirmed', 'context.read', 'explicit-user', '2026-01-01T00:30:00.000Z', capabilityStore); assert.equal(requested.ok, true); if (requested.ok) assert.equal(decideMcpCapability(requested.grant.grantId, true, 'user-1', capabilityStore).ok, true)
    const bridgeOptions = { storeOptions: contextStore, mcpObservability: { storePath: path.join(rootDir, 'observability.json'), now: contextStore.now }, mcpCapabilityAuthorization: { storePath: path.join(rootDir, 'capabilities.json'), now: contextStore.now } }
    const result = consumePreparedMcpContext(prepared(['repo', 'knowledge.docs']), 'session-confirmed', bridgeOptions)
    assert.equal(result.ok, true, JSON.stringify(result)); if (result.ok) { assert.deepEqual(result.context.sourceIds, ['knowledge.docs', 'repo']); assert.equal(result.context.knowledge.packageId, 'knowledge-context-1'); assert.equal(result.context.repository.freshnessState, 'fresh'); assert.equal(JSON.stringify(result).includes('document content'), false) }
    const unauthorized = consumePreparedMcpContext({ ...prepared(), contextMetadata: { ...prepared().contextMetadata!, selectedSource: 'other-repo' } }, 'session-confirmed', bridgeOptions)
    assert.equal(unauthorized.ok, false); if (!unauthorized.ok) assert.equal(unauthorized.code, 'source_not_active')
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }) }
})
