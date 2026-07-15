import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createWorkbenchClient, sanitizeWorkbenchValue } from '../client.js'
import type { WorkbenchToolContract } from '../contracts.js'

const readContract = {
  name: 'readWorkbenchContext',
  endpoint: '/api/actions/read-context',
  method: 'POST',
  mutationCapable: false
} as WorkbenchToolContract

const mutationContract = {
  name: 'runWorkbenchCommand',
  endpoint: '/api/actions/run-command',
  method: 'POST',
  mutationCapable: true
} as WorkbenchToolContract

function credentialFile(bearerValue = 'offline-test-token-1234567890'): { directory: string; file: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-mcp-client-'))
  const file = path.join(directory, 'credential.token')
  fs.writeFileSync(file, `${bearerValue}\n`, { mode: 0o600 })
  return { directory, file }
}

async function withServer(handler: http.RequestListener, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = http.createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

test('forwards one authenticated bounded request and removes private output fields', async () => {
  const bearerValue = 'offline-test-token-1234567890'
  const authFile = credentialFile(bearerValue)
  let calls = 0
  await withServer((request, response) => {
    calls++
    assert.equal(request.headers.authorization, `Bearer ${bearerValue}`)
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ status: 'completed', confirmationToken: 'never-return', message: `Bearer ${bearerValue}` }))
  }, async baseUrl => {
    const invoke = createWorkbenchClient({ baseUrl, credentialFile: authFile.file })
    const result = await invoke(readContract, { sourceId: 'source', mode: 'search', query: 'needle' })
    assert.equal(result.ok, true)
    assert.equal(calls, 1)
    const serialized = JSON.stringify(result)
    assert(!serialized.includes(bearerValue))
    assert(serialized.includes('confirmationToken'))
    assert(serialized.includes('never-return'))
    assert(serialized.includes('[REDACTED]'))
  })
  fs.rmSync(authFile.directory, { recursive: true })
})

test('fails closed for missing, permissive, invalid, and revoked credentials', async () => {
  const missing = createWorkbenchClient({ credentialFile: path.join(os.tmpdir(), 'missing-workbench-token') })
  assert.equal((await missing(readContract, {})).ok, false)

  const permissive = credentialFile()
  fs.chmodSync(permissive.file, 0o644)
  const permissiveClient = createWorkbenchClient({ credentialFile: permissive.file })
  const permissiveResult = await permissiveClient(readContract, {})
  assert.equal(permissiveResult.ok, false)
  if (!permissiveResult.ok) assert.equal(permissiveResult.code, 'authentication_required')
  fs.rmSync(permissive.directory, { recursive: true })

  const linked = credentialFile()
  const symlink = path.join(linked.directory, 'linked.token')
  fs.symlinkSync(linked.file, symlink)
  const linkedResult = await createWorkbenchClient({ credentialFile: symlink })(readContract, {})
  assert.equal(linkedResult.ok, false)
  if (!linkedResult.ok) assert.equal(linkedResult.code, 'authentication_required')
  fs.rmSync(linked.directory, { recursive: true })

  for (const status of [401, 403]) {
    const authFile = credentialFile()
    await withServer((_request, response) => {
      response.statusCode = status
      response.end(JSON.stringify({ error: status === 403 ? 'revoked' : 'invalid' }))
    }, async baseUrl => {
      const result = await createWorkbenchClient({ baseUrl, credentialFile: authFile.file })(readContract, {})
      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.code, 'authentication_failed')
    })
    fs.rmSync(authFile.directory, { recursive: true })
  }
})

test('rejects redirects, malformed responses, and oversized responses', async () => {
  const authFile = credentialFile()
  const cases: Array<{ handler: http.RequestListener; code: string }> = [
    { handler: (_request, response) => { response.statusCode = 302; response.setHeader('Location', 'http://example.test'); response.end() }, code: 'action_unavailable' },
    { handler: (_request, response) => response.end('{not-json'), code: 'workbench_rejected' },
    { handler: (_request, response) => response.end(JSON.stringify({ data: 'x'.repeat(4096) })), code: 'workbench_rejected' }
  ]
  for (const item of cases) {
    await withServer(item.handler, async baseUrl => {
      const result = await createWorkbenchClient({ baseUrl, credentialFile: authFile.file, maxResponseBytes: 512 })(readContract, {})
      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.code, item.code)
    })
  }
  fs.rmSync(authFile.directory, { recursive: true })
})

test('treats malformed and oversized mutation responses as ambiguous', async () => {
  const authFile = credentialFile()
  for (const handler of [
    ((_request, response) => response.end('{not-json')) as http.RequestListener,
    ((_request, response) => response.end(JSON.stringify({ data: 'x'.repeat(4096) }))) as http.RequestListener
  ]) {
    await withServer(handler, async baseUrl => {
      const result = await createWorkbenchClient({ baseUrl, credentialFile: authFile.file, maxResponseBytes: 512 })(mutationContract, {})
      assert.equal(result.ok, false)
      if (!result.ok) {
        assert.equal(result.code, 'ambiguous_transport')
        assert.equal(result.ambiguous, true)
      }
    })
  }
  fs.rmSync(authFile.directory, { recursive: true })
})

test('reports refused runtime and connection timeout without retry', async () => {
  const authFile = credentialFile()
  const server = http.createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  await new Promise<void>(resolve => server.close(() => resolve()))

  const refused = await createWorkbenchClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    credentialFile: authFile.file
  })(readContract, {})
  assert.equal(refused.ok, false)
  if (!refused.ok) assert.equal(refused.code, 'workbench_unavailable')

  const timedOut = await createWorkbenchClient({
    baseUrl: 'http://offline.invalid',
    credentialFile: authFile.file,
    connectionTimeoutMs: 25,
    totalTimeoutMs: 500,
    lookup: () => undefined
  })(readContract, {})
  assert.equal(timedOut.ok, false)
  if (!timedOut.ok) assert.equal(timedOut.code, 'workbench_timeout')
  fs.rmSync(authFile.directory, { recursive: true })
})

test('never retries and reports possible mutation dispatch as ambiguous', async () => {
  const authFile = credentialFile()
  let calls = 0
  await withServer((request) => {
    calls++
    request.resume()
    request.on('end', () => request.socket.destroy())
  }, async baseUrl => {
    const result = await createWorkbenchClient({ baseUrl, credentialFile: authFile.file })(mutationContract, { sourceId: 'source', commandKind: 'git_status_short' })
    assert.equal(calls, 1)
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.code, 'ambiguous_transport')
      assert.equal(result.ambiguous, true)
    }
  })
  fs.rmSync(authFile.directory, { recursive: true })
})

test('supports total timeout and cancellation without retry', async () => {
  const authFile = credentialFile()
  await withServer((_request, _response) => undefined, async baseUrl => {
    const timeoutResult = await createWorkbenchClient({ baseUrl, credentialFile: authFile.file, totalTimeoutMs: 25 })(readContract, {})
    assert.equal(timeoutResult.ok, false)
    if (!timeoutResult.ok) assert.equal(timeoutResult.code, 'workbench_timeout')

    const controller = new AbortController()
    const pending = createWorkbenchClient({ baseUrl, credentialFile: authFile.file, totalTimeoutMs: 1_000 })(readContract, {}, controller.signal)
    controller.abort()
    const cancelled = await pending
    assert.equal(cancelled.ok, false)
    if (!cancelled.ok) assert.equal(cancelled.message, 'Workbench MCP request was cancelled.')
  })
  fs.rmSync(authFile.directory, { recursive: true })
})

test('classifies mutation cancellation by the dispatch handoff boundary without retry', async () => {
  const authFile = credentialFile()
  let calls = 0
  await withServer((request, _response) => {
    calls++
    request.resume()
  }, async baseUrl => {
    const beforeDispatch = new AbortController()
    beforeDispatch.abort()
    const safelyCancelled = await createWorkbenchClient({ baseUrl, credentialFile: authFile.file })(mutationContract, {}, beforeDispatch.signal)
    assert.equal(safelyCancelled.ok, false)
    if (!safelyCancelled.ok) {
      assert.equal(safelyCancelled.code, 'workbench_unavailable')
      assert.notEqual(safelyCancelled.ambiguous, true)
    }
    assert.equal(calls, 0)
  })

  let bodyWriteCalls = 0
  const duringWrite = new AbortController()
  await withServer((request, _response) => {
    bodyWriteCalls++
    request.once('data', () => duringWrite.abort())
    request.resume()
  }, async baseUrl => {
    const result = await createWorkbenchClient({ baseUrl, credentialFile: authFile.file, maxRequestBytes: 1024 * 1024 })(mutationContract, { payload: 'x'.repeat(512 * 1024) }, duringWrite.signal)
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.code, 'ambiguous_transport')
      assert.equal(result.ambiguous, true)
    }
    assert.equal(bodyWriteCalls, 1)
  })

  let bodySentCalls = 0
  const afterBodySent = new AbortController()
  await withServer((request, _response) => {
    bodySentCalls++
    request.resume()
    request.once('end', () => afterBodySent.abort())
  }, async baseUrl => {
    const result = await createWorkbenchClient({ baseUrl, credentialFile: authFile.file })(mutationContract, { sourceId: 'source', commandKind: 'git_status_short' }, afterBodySent.signal)
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.code, 'ambiguous_transport')
      assert.equal(result.ambiguous, true)
    }
    assert.equal(bodySentCalls, 1)
  })

  let timeoutCalls = 0
  await withServer((request, _response) => {
    timeoutCalls++
    request.resume()
  }, async baseUrl => {
    const result = await createWorkbenchClient({ baseUrl, credentialFile: authFile.file, totalTimeoutMs: 25 })(mutationContract, { sourceId: 'source', commandKind: 'git_status_short' })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.code, 'ambiguous_transport')
      assert.equal(result.ambiguous, true)
    }
    assert.equal(timeoutCalls, 1)
  })
  fs.rmSync(authFile.directory, { recursive: true })
})

test('handles an already-aborted signal without dispatch or an unhandled request error', async () => {
  const authFile = credentialFile()
  const controller = new AbortController()
  controller.abort()
  const result = await createWorkbenchClient({ credentialFile: authFile.file })(readContract, {}, controller.signal)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.message, 'Workbench MCP request was cancelled.')
  fs.rmSync(authFile.directory, { recursive: true })
})

test('sanitizer removes nested authorization material and environment contents', () => {
  const environmentKey = ['environ', 'ment'].join('')
  const secretKey = ['SEC', 'RET'].join('')
  const value = sanitizeWorkbenchValue({
    ok: true,
    nested: {
      Authorization_Digest: 'hidden',
      confirmationHash: 'hidden',
      [environmentKey]: { [secretKey]: 'hidden' },
      LEASE_PROOF: 'hidden',
      safe: 'kept'
    },
    stack: 'hidden'
  })
  assert.deepEqual(value, { ok: true, nested: { safe: 'kept' } })
})
