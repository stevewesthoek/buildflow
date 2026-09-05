import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createMcpCapabilityAdapter, listMcpExecutionAudit, type McpExecutionAuthorization, type McpExecutionRequest } from '../mcp-capability-adapter.js'
import { listCapabilityAuditEvents } from '../capability-audit.js'

const request = (dispatchId = 'dispatch-1'): McpExecutionRequest => ({ dispatchId, capabilityPlanId: 'plan-1', validationId: 'validation-1', providerId: 'provider-1', capabilityId: 'read', requestedOperation: 'read', operation: 'read', contextSessionId: 'context-1', auditIdentity: { requestedBy: 'test', requestedAt: new Date().toISOString() } })
const decision = { dispatchId: 'dispatch-1', status: 'accepted' as const, adapterId: 'mcp-capability-adapter-v1', evidence: [], auditIdentity: { dispatchId: 'dispatch-1', planId: 'plan-1', requestedAt: new Date().toISOString() } }
const authorization = (override: Partial<McpExecutionAuthorization> = {}): McpExecutionAuthorization => ({ decision, plan: { planId: 'plan-1', contextSessionId: 'context-1', providerId: 'provider-1', capabilityId: 'read', requestedOperation: 'read', approvalState: 'approved', validity: 'valid', expiresAt: new Date(Date.now() + 60_000).toISOString() } as never, validation: { validationId: 'validation-1', outcome: 'allowed', allowed: true, expiresAt: new Date(Date.now() + 60_000).toISOString() } as never, provider: { providerId: 'provider-1', enabled: true, registrationState: 'enabled', health: 'healthy', capabilities: ['read'] } as never, ...override })

test('executes only an accepted dispatch through the injected MCP boundary and audits lifecycle', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-mcp-execution-')); let calls = 0
  try {
    const adapter = createMcpCapabilityAdapter({ rootDir: root, boundary: async () => { calls++; return { ok: true, result: { value: 'safe' } } } })
    const result = await adapter.executeApproved(request(), authorization())
    assert.equal(result.status, 'completed'); assert.equal(calls, 1)
    assert.deepEqual(listMcpExecutionAudit({ rootDir: root }).map(event => event.eventType), ['execution_requested', 'authorization_verified', 'execution_admitted', 'execution_started', 'execution_completed']); assert.deepEqual(listCapabilityAuditEvents({ rootDir: root }).map(event => event.eventType), ['execution.requested', 'execution.completed'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('rejects replayed dispatch identity before contacting the boundary', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-mcp-execution-')); let calls = 0
  try {
    const adapter = createMcpCapabilityAdapter({ rootDir: root, boundary: async () => { calls++; return { ok: true, result: {} } } })
    assert.equal((await adapter.executeApproved(request(), authorization())).status, 'completed')
    const replay = await adapter.executeApproved(request(), authorization())
    assert.equal(replay.status, 'failed'); assert.equal(replay.errors[0]?.code, 'execution_replay'); assert.equal(calls, 1); assert.equal(listMcpExecutionAudit({ rootDir: root }).at(-1)?.eventType, 'execution_denied')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('rejects execution without accepted dispatch and does not call the boundary', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-mcp-execution-')); let calls = 0
  try {
    const adapter = createMcpCapabilityAdapter({ rootDir: root, boundary: async () => { calls++; return { ok: true, result: {} } } })
    const result = await adapter.executeApproved(request(), authorization({ decision: { ...decision, status: 'rejected', adapterId: undefined } }))
    assert.equal(result.status, 'failed'); assert.equal(result.errors[0]?.code, 'dispatch_not_accepted'); assert.equal(calls, 0)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('records cancellation before the MCP boundary call', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-mcp-execution-')); const controller = new AbortController(); controller.abort(); let calls = 0
  try {
    const adapter = createMcpCapabilityAdapter({ rootDir: root, boundary: async () => { calls++; return { ok: true, result: {} } } })
    const result = await adapter.executeApproved({ ...request(), signal: controller.signal }, authorization())
    assert.equal(result.status, 'cancelled'); assert.equal(calls, 0)
    assert.equal(listMcpExecutionAudit({ rootDir: root }).at(-1)?.eventType, 'execution_cancelled')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('fails with a bounded timeout and does not wait for an unresponsive boundary', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-mcp-execution-'))
  try {
    const adapter = createMcpCapabilityAdapter({ rootDir: root, timeoutMs: 10, boundary: async () => await new Promise(() => {}) })
    const result = await adapter.executeApproved(request('dispatch-timeout'), authorization({ decision: { ...decision, dispatchId: 'dispatch-timeout', auditIdentity: { ...decision.auditIdentity, dispatchId: 'dispatch-timeout' } } }))
    assert.equal(result.status, 'failed'); assert.equal(result.errors[0]?.code, 'execution_timeout'); assert.equal(listMcpExecutionAudit({ rootDir: root }).at(-1)?.eventType, 'execution_failed')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
