import assert from 'node:assert/strict'
import test from 'node:test'
import { formatMcpContextWorkflowResponse, getMcpContextWorkflowDiagnostics, negotiateMcpContextClient, recordMcpContextWorkflowResult } from './mcp-context-workflow'

test('negotiates compatible and unsupported neutral MCP clients deterministically', () => {
  assert.equal(negotiateMcpContextClient({ clientId: 'client-a', contextWorkflow: true, features: ['freshness', 'warnings'] }).supported, true)
  assert.equal(negotiateMcpContextClient({ clientId: 'legacy-client' }).reason, 'unsupported_context_workflow')
  assert.equal(negotiateMcpContextClient(undefined).reason, 'malformed_capabilities')
  assert.equal(negotiateMcpContextClient({ clientId: 'partial', contextWorkflow: true, requestedScope: 'invalid' as any }).reason, 'unsupported_scope')
  assert.equal(negotiateMcpContextClient({ clientId: '' }).reason, 'malformed_capabilities')
})

test('formats bounded metadata without requiring a specific provider or LLM', () => {
  const response = formatMcpContextWorkflowResponse({ mode: 'prepare_task_context', query: 'auth', sourceIds: ['repo'], files: [], uncertainty: ['stale'], timings: { totalMs: 2 }, contextMetadata: { freshnessState: 'stale', warnings: ['warning'] } } as any, 'session-1')
  assert.equal(response.ok, true); if (response.ok) { assert.equal(response.metadata.sessionId, 'session-1'); assert.deepEqual(response.metadata.freshnessStates, ['stale']); assert.equal(response.metadata.warnings.length, 2); assert.ok(response.metadata.diagnosticsRef); assert.ok(response.metadata.provenanceRef); assert.equal(JSON.stringify(response.metadata).includes('document content'), false) }
})

test('keeps workflow diagnostics bounded and records deterministic outcomes', () => {
  recordMcpContextWorkflowResult({ clientId: 'client-a', ok: true, latencyMs: 10, packageBytes: 80 })
  recordMcpContextWorkflowResult({ clientId: 'client-a', ok: false, latencyMs: 20, failureCode: 'session_expired' })
  const diagnostics = getMcpContextWorkflowDiagnostics(); assert.ok(diagnostics.requests >= 2); assert.ok(diagnostics.successfulDeliveries >= 1); assert.ok(diagnostics.recentFailures.length <= 128); assert.ok(diagnostics.averageLatencyMs >= 0)
})
