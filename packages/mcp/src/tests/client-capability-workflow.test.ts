import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createClientCapabilityRequest, createClientWorkflowSession, decideClientCapabilityRequest, getClientCapabilityRequest, getClientWorkflowSession, transitionClientWorkflowSession } from '../client-capability-workflow.js'

test('external client session and approval lifecycle is explicit and bounded', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-client-workflow-'))
  let clock = new Date('2026-08-24T10:00:00.000Z')
  const options = { rootDir, now: () => clock }
  try {
    const session = createClientWorkflowSession({ clientId: 'client-a', ownerId: 'owner-a', expiresAt: '2026-08-24T11:00:00.000Z' }, options)
    assert.equal(session.ok, true); if (!session.ok) return
    const request = createClientCapabilityRequest({ clientSessionId: session.value.clientSessionId, capabilityId: 'repository.read', operation: 'read', expiresAt: '2026-08-24T10:30:00.000Z' }, options)
    assert.equal(request.ok, true); if (!request.ok) return
    assert.equal(decideClientCapabilityRequest(request.value.requestId, 'approved', undefined, options).ok, false)
    const approved = decideClientCapabilityRequest(request.value.requestId, 'approved', 'explicit-user', options)
    assert.equal(approved.ok, true); if (!approved.ok) return
    const stored = getClientCapabilityRequest(request.value.requestId, options)
    assert.equal(stored.ok, true); if (!stored.ok) return
    assert.equal(stored.value.state, 'approved')
    clock = new Date('2026-08-24T12:00:00.000Z')
    assert.equal(getClientWorkflowSession(session.value.clientSessionId, options).ok, false)
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }) }
})

test('revoked and cleared external sessions cannot be reused', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-client-workflow-'))
  const options = { rootDir, now: () => new Date('2026-08-24T10:00:00.000Z') }
  try {
    const created = createClientWorkflowSession({ clientId: 'client-b', ownerId: 'owner-b', expiresAt: '2026-08-24T11:00:00.000Z' }, options)
    assert.equal(created.ok, true); if (!created.ok) return
    assert.equal(transitionClientWorkflowSession(created.value.clientSessionId, 'revoked', options).ok, true)
    assert.equal(createClientCapabilityRequest({ clientSessionId: created.value.clientSessionId, capabilityId: 'x', operation: 'x', expiresAt: '2026-08-24T10:30:00.000Z' }, options).ok, false)
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }) }
})
