import assert from 'node:assert/strict'
import { executeAction, ActionTransportError } from '../../lib/actions/transport'

async function testOversizedResponseIsRejected() {
  const originalFetch = globalThis.fetch
  const oversizedBody = JSON.stringify({ data: 'x'.repeat(90_000) })

  try {
    globalThis.fetch = (async () => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(oversizedBody))
          controller.close()
        }
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }
    )) as typeof fetch

    await assert.rejects(
      () => executeAction('/api/test-large', { sourceId: 'source' }, undefined, { timeoutMs: 1000, maxResponseBytes: 80_000 }),
      (error: unknown) => {
        assert.ok(error instanceof ActionTransportError)
        assert.equal(error.statusCode, 413)
        return true
      }
    )
  } finally {
    globalThis.fetch = originalFetch
  }
}

async function testTimeoutAbortsPendingFetch() {
  const originalFetch = globalThis.fetch
  let abortObserved = false

  try {
    globalThis.fetch = ((_, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        abortObserved = true
        const error = new Error('The operation was aborted')
        error.name = 'AbortError'
        reject(error)
      }, { once: true })
    })) as typeof fetch

    await assert.rejects(
      () => executeAction('/api/test-timeout', { sourceId: 'source' }, undefined, { timeoutMs: 20 }),
      (error: unknown) => {
        assert.ok(error instanceof ActionTransportError)
        assert.equal(error.statusCode, 200, 'public HTTP status for controlled timeout must be 200, not 504')
        assert.equal((error.payload as { status?: string } | undefined)?.status, 'timeout')
        return true
      }
    )
    assert.equal(abortObserved, true)
  } finally {
    globalThis.fetch = originalFetch
  }
}

async function main() {
  await testOversizedResponseIsRejected()
  await testTimeoutAbortsPendingFetch()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
