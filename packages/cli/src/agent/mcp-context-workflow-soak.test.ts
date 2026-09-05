import assert from 'node:assert/strict'
import test from 'node:test'
import { MCP_WORKFLOW_PROFILES, runMcpWorkflowSoak } from './mcp-context-workflow-soak'

test('covers full, partial, legacy, and unknown client profiles', () => {
  const context = { mode: 'prepare_task_context', status: 'ok', query: 'auth', sourceIds: ['repo'], summary: 'bounded', topFiles: [], exactReadPlan: [], uncertainty: [], searchNotes: [], candidates: [], strategy: { kind: 'bounded' }, timings: { totalMs: 1 } } as any
  const results = runMcpWorkflowSoak({ context, sessionId: 'session-soak', repetitions: 2, concurrent: 2 })
  assert.deepEqual(results.map(item => item.profile), MCP_WORKFLOW_PROFILES.map(item => item.name)); assert.equal(results[0]?.delivered, true); assert.equal(results[1]?.delivered, false); assert.equal(results[2]?.negotiated, false); assert.equal(results[3]?.negotiated, false); assert.ok(results.every(item => item.requests === 4 && item.maximumPackageBytes <= 64 * 1024))
})

test('repeated bounded soak remains deterministic for the same prepared context', () => {
  const context = { mode: 'prepare_task_context', status: 'ok', query: 'health', sourceIds: ['repo'], summary: 'bounded', topFiles: [], exactReadPlan: [], uncertainty: ['stale'], searchNotes: [], candidates: [], strategy: { kind: 'bounded' }, timings: { totalMs: 1 } } as any
  const result = runMcpWorkflowSoak({ context, sessionId: 'session-soak', profiles: [MCP_WORKFLOW_PROFILES[0]], repetitions: 3, concurrent: 1 })[0]
  assert.equal(result?.delivered, true); assert.equal(result?.failures.length, 0); assert.ok((result?.averageLatencyMs || 0) >= 0)
})
