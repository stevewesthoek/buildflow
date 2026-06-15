import assert from 'node:assert/strict'

async function main() {
  process.env.WORKBENCH_ACTION_TOKEN = process.env.WORKBENCH_ACTION_TOKEN || process.env.BUILDFLOW_ACTION_TOKEN || 'test-token'
  process.env.WORKBENCH_BACKEND_MODE = 'direct-agent'
  process.env.LOCAL_AGENT_URL = 'http://127.0.0.1:65535'

  const { GET } = await import('../apps/web/src/app/api/actions/status/route')
  const { executeActionGET, ActionTransportError } = await import('../apps/web/src/lib/actions/transport')

  async function readJson(response: Response) {
    const text = await response.text()
    assert(text.length > 0, 'response body must not be empty')
    const json = JSON.parse(text)
    return { text, json }
  }

  async function withFetch(mock: typeof fetch, fn: () => Promise<void>) {
    const original = global.fetch
    global.fetch = mock as typeof fetch
    try {
      await fn()
    } finally {
      global.fetch = original
    }
  }

  const authHeaders = {
    authorization: `Bearer ${process.env.WORKBENCH_ACTION_TOKEN}`
  }

  await withFetch((async () => new Response(JSON.stringify({
    connected: true,
    sourceCount: 2,
    sourcesAvailable: true,
    version: '1.2.13-beta'
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })) as unknown as typeof fetch, async () => {
    const response = await GET(new Request('http://127.0.0.1/api/actions/status', { headers: authHeaders }))
    assert.equal(response.status, 200)
    const { json } = await readJson(response)
    assert.equal(json.ok, true)
    assert.equal(json.connected, true)
    assert.equal(json.status, 'available')
    assert.equal(json.message, 'BuildFlow is available')
    assert.equal(json.sourcesReady, true)
    assert.equal(typeof json.serverTime, 'string')
  })

  await withFetch((async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch, async () => {
    const response = await GET(new Request('http://127.0.0.1/api/actions/status', { headers: authHeaders }))
    assert.equal(response.status, 503)
    const { json } = await readJson(response)
    assert.equal(json.ok, false)
    assert.equal(json.connected, false)
    assert.equal(json.error.code, 'LOCAL_STACK_UNAVAILABLE')
    assert(Array.isArray(json.error.recovery))
    assert(json.error.recovery.length > 0)
  })

  await withFetch((async () => new Response('', {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })) as unknown as typeof fetch, async () => {
    try {
      await executeActionGET('/api/status', process.env.WORKBENCH_ACTION_TOKEN)
      assert.fail('expected executeActionGET to throw on empty response')
    } catch (err) {
      assert(err instanceof ActionTransportError)
      assert.equal((err as ActionTransportError).payload && typeof (err as ActionTransportError).payload === 'object', true)
      const payload = (err as ActionTransportError).payload as { error?: { code?: string } }
      assert.equal(payload.error?.code, 'EMPTY_RELAY_RESPONSE')
    }
  })

  await withFetch((async () => { throw new Error('boom') }) as unknown as typeof fetch, async () => {
    const response = await GET(new Request('http://127.0.0.1/api/actions/status', { headers: authHeaders }))
    assert.equal(response.status, 503)
    const { json } = await readJson(response)
    assert.equal(json.ok, false)
    assert.equal(json.error.code, 'BUILDFLOW_STATUS_ERROR')
  })

  console.log('verify-buildflow-status-contract: passed')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
