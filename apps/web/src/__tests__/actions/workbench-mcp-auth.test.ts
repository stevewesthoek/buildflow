import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { deriveWorkbenchMcpCredential } from '@workbench/shared/workbench-mcp-auth'

test('accepts and attributes only the derived scoped MCP credential', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-mcp-audit-'))
  const actionToken = 'offline-action-token-123456789'
  process.env.RELAY_DATA_DIR = dataDir
  process.env.WORKBENCH_BACKEND_MODE = 'direct-agent'
  process.env.WORKBENCH_ACTION_TOKEN = actionToken

  const { checkActionAuth, WORKBENCH_MCP_ACTION_ROUTES } = await import('../../lib/actionAuth')
  const scopedCredential = deriveWorkbenchMcpCredential(actionToken)
  const allowedRoutes = [
    ['GET', '/api/actions/status'],
    ['POST', '/api/actions/read-context'],
    ['POST', '/api/actions/apply-file-change'],
    ['POST', '/api/actions/commit-changes'],
    ['POST', '/api/actions/run-command']
  ] as const
  assert.deepEqual([...WORKBENCH_MCP_ACTION_ROUTES].sort(), allowedRoutes.map(([method, pathname]) => `${method} ${pathname}`).sort())
  for (const [method, pathname] of allowedRoutes) {
    const accepted = checkActionAuth(new NextRequest(`http://127.0.0.1:3054${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${scopedCredential}` }
    }))
    assert.equal(accepted.valid, true, `${method} ${pathname}`)
    assert.equal(accepted.principal, 'codex-workbench-mcp', `${method} ${pathname}`)
  }

  for (const [method, pathname] of [
    ['POST', '/api/actions/status'],
    ['GET', '/api/actions/run-command'],
    ['POST', '/api/actions/append-file'],
    ['POST', '/api/actions/write-file'],
    ['POST', '/api/actions/patch-file'],
    ['POST', '/api/actions/create-plan'],
    ['POST', '/api/actions/create-artifact'],
    ['GET', '/api/actions/sources']
  ] as const) {
    const rejectedRoute = checkActionAuth(new NextRequest(`http://127.0.0.1:3054${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${scopedCredential}` }
    }))
    assert.equal(rejectedRoute.valid, false, `${method} ${pathname}`)
    assert.equal(rejectedRoute.error?.status, 403, `${method} ${pathname}`)
  }

  const normalActionToken = checkActionAuth(new NextRequest('http://127.0.0.1:3054/api/actions/write-file', {
    method: 'POST',
    headers: { Authorization: `Bearer ${actionToken}` }
  }))
  assert.equal(normalActionToken.valid, true)
  assert.equal(normalActionToken.principal, undefined)

  const rejected = checkActionAuth(new NextRequest('http://127.0.0.1:3054/api/actions/status', {
    headers: { Authorization: 'Bearer wbmcp_v1_invalid' }
  }))
  assert.equal(rejected.valid, false)
  assert.equal(rejected.error?.status, 401)

  process.env.WORKBENCH_BACKEND_MODE = 'relay-agent'
  const relayRejected = checkActionAuth(new NextRequest('http://127.0.0.1:3054/api/actions/status', {
    headers: { Authorization: `Bearer ${scopedCredential}` }
  }))
  assert.equal(relayRejected.valid, false)
  assert.equal(relayRejected.error?.status, 403)

  const relayUserBearer = checkActionAuth(new NextRequest('http://127.0.0.1:3054/api/actions/status', {
    headers: { Authorization: 'Bearer relay-user-token' }
  }))
  assert.equal(relayUserBearer.valid, true)
  assert.equal(relayUserBearer.bearerToken, 'relay-user-token')

  const audit = JSON.parse(fs.readFileSync(path.join(dataDir, 'relay-requests.json'), 'utf8')) as Array<Record<string, unknown>>
  assert.equal(audit.length, allowedRoutes.length)
  assert.equal(audit[0].deviceId, 'codex-workbench-mcp')
  assert.equal(audit[0].command, 'action:GET:/api/actions/status')
  assert.deepEqual(audit.map(item => item.command), allowedRoutes.map(([method, pathname]) => `action:${method}:${pathname}`))
  assert(!JSON.stringify(audit).includes(actionToken))
  assert(!JSON.stringify(audit).includes(scopedCredential))

  const auditPath = path.join(dataDir, 'relay-requests.json')
  fs.writeFileSync(auditPath, '{corrupt-audit')
  process.env.WORKBENCH_BACKEND_MODE = 'direct-agent'
  const auditUnavailable = checkActionAuth(new NextRequest('http://127.0.0.1:3054/api/actions/status', {
    headers: { Authorization: `Bearer ${scopedCredential}` }
  }))
  assert.equal(auditUnavailable.valid, false)
  assert.equal(auditUnavailable.error?.status, 503)
  assert.equal(fs.readFileSync(auditPath, 'utf8'), '{corrupt-audit')

  delete process.env.RELAY_DATA_DIR
  delete process.env.WORKBENCH_BACKEND_MODE
  delete process.env.WORKBENCH_ACTION_TOKEN
  fs.rmSync(dataDir, { recursive: true })
})
