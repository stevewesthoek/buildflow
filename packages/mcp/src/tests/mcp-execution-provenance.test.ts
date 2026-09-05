import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { recordMcpExecutionProvenance, verifyMcpExecutionProvenance } from '../mcp-execution-provenance.js'

test('verifies a complete bounded provenance record', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-provenance-'))
  try {
    recordMcpExecutionProvenance({ sessionId: 'session-1', requestId: 'request-1', executionId: 'execution-1', dispatchId: 'dispatch-1', capabilityId: 'read', authorizationGrantId: 'grant-1', authorizationApprovedAt: '2026-01-01T00:00:00.000Z', authorizationApprovedBy: 'user', authorizationValidAtExecution: true, providerId: 'provider-1', sourceIds: ['repo-1'], contextOrigin: 'session-1', planId: 'plan-1', validationId: 'validation-1', occurredAt: '2026-01-01T00:00:00.000Z', lifecycle: 'completed', outcome: 'completed', evidence: [{ evidenceId: 'evidence-1', kind: 'execution', reference: 'audit-1', recordedAt: '2026-01-01T00:00:00.000Z' }] }, { rootDir })
    assert.deepEqual(verifyMcpExecutionProvenance({ rootDir }), { complete: 1, incomplete: 0, invalid: 0, orphaned: 0, traceCoverage: 100, missingEvidence: [], invalidLineage: [] })
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }) }
})

test('detects missing authorization and evidence links', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-provenance-invalid-'))
  try {
    recordMcpExecutionProvenance({ sessionId: 'session-1', requestId: 'request-1', executionId: 'execution-1', dispatchId: 'dispatch-1', capabilityId: 'read', authorizationGrantId: '', authorizationApprovedAt: '', authorizationApprovedBy: '', authorizationValidAtExecution: false, providerId: 'provider-1', sourceIds: [], planId: 'plan-1', validationId: 'validation-1', occurredAt: '2026-01-01T00:00:00.000Z', lifecycle: 'failed', outcome: 'failed', evidence: [] }, { rootDir })
    const diagnostic = verifyMcpExecutionProvenance({ rootDir }); assert.equal(diagnostic.invalid, 1); assert.deepEqual(diagnostic.missingEvidence, ['execution-1']); assert.deepEqual(diagnostic.invalidLineage, ['execution-1'])
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }) }
})

test('rejects cross-session lineage even when the record is otherwise complete', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-provenance-isolation-'))
  try {
    recordMcpExecutionProvenance({ sessionId: 'session-1', requestId: 'request-1', executionId: 'execution-1', dispatchId: 'dispatch-1', capabilityId: 'read', authorizationGrantId: 'grant-1', authorizationApprovedAt: '2026-01-01T00:00:00.000Z', authorizationApprovedBy: 'user', authorizationValidAtExecution: true, providerId: 'provider-1', sourceIds: ['repo-1'], contextOrigin: 'session-2', planId: 'plan-1', validationId: 'validation-1', occurredAt: '2026-01-01T00:00:00.000Z', lifecycle: 'completed', outcome: 'completed', evidence: [{ evidenceId: 'evidence-1', kind: 'execution', reference: 'audit-1', recordedAt: '2026-01-01T00:00:00.000Z' }] }, { rootDir })
    assert.equal(verifyMcpExecutionProvenance({ rootDir }).invalid, 1)
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }) }
})
