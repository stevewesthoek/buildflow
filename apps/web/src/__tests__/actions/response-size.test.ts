import assert from 'node:assert/strict'
import { executeAction, ActionTransportError } from '../../lib/actions/transport'
import { requiresVerifiedFileWrite } from '../../lib/actions/file-change-verification'

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

async function testStagedSetGuardBlocksCommitDispatch() {
  const { dispatchAfterExactStaging } = await import('../../lib/actions/staged-set-guard')
  let commitDispatches = 0

  const mismatch = await dispatchAfterExactStaging({ details: { exactMatch: false } }, async () => {
    commitDispatches += 1
    return { exitCode: 0 }
  })
  assert.equal(mismatch.pass, false)
  if (mismatch.pass) throw new Error('Expected staged-set mismatch')
  assert.equal(mismatch.reason, 'staged_path_set_mismatch')
  assert.equal(commitDispatches, 0)

  const missingEvidence = await dispatchAfterExactStaging({}, async () => {
    commitDispatches += 1
    return { exitCode: 0 }
  })
  assert.equal(missingEvidence.pass, false)
  assert.equal(commitDispatches, 0)

  const exactMatch = await dispatchAfterExactStaging({ details: { exactMatch: true } }, async () => {
    commitDispatches += 1
    return { exitCode: 0, paths: ['scripts/001'] }
  })
  assert.equal(exactMatch.pass, true)
  if (!exactMatch.pass) throw new Error('Expected exact staged set to dispatch commit')
  assert.equal(exactMatch.result.exitCode, 0)
  assert.deepEqual(exactMatch.result.paths, ['scripts/001'])
  assert.equal(commitDispatches, 1)
}

function testVerifiedWritePolicyOnlyCoversDirectFileChanges() {
  for (const changeType of ['create', 'overwrite', 'patch', 'append', 'delete_file', 'move']) {
    assert.equal(requiresVerifiedFileWrite(changeType, false), true, `${changeType} must require verified:true`)
    assert.equal(requiresVerifiedFileWrite(changeType, true), false, `${changeType} dry-run must not require verified:true`)
  }

  for (const changeType of ['create_run', 'resume_run', 'close_run', 'packet_preflight', 'packet_claim', 'packet_plan', 'packet_execute']) {
    assert.equal(requiresVerifiedFileWrite(changeType, false), false, `${changeType} must not be rejected as an unverified direct write`)
  }
}

async function main() {
  await testOversizedResponseIsRejected()
  await testTimeoutAbortsPendingFetch()
  await testStagedSetGuardBlocksCommitDispatch()
  testVerifiedWritePolicyOnlyCoversDirectFileChanges()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
