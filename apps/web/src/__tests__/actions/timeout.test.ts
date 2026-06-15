import assert from 'node:assert/strict'
import { NextResponse } from 'next/server'
import { withGptActionDeadline } from '../../lib/actions/deadline'

async function main() {
  let abortObserved = false
  const startedAt = Date.now()

  const response = await withGptActionDeadline(
    {
      operationId: 'testTimeout',
      route: '/api/test-timeout',
      deadlineMs: 20
    },
    async (context) => {
      context.signal.addEventListener('abort', () => {
        abortObserved = true
      }, { once: true })

      await new Promise(resolve => setTimeout(resolve, 100))
      return NextResponse.json({ ok: true })
    }
  )

  const json = await response.json()
  assert.equal(json.ok, false)
  assert.equal(json.status, 'timeout')
  assert.equal(json.error?.code, 'BUILDFLOW_ACTION_DEADLINE_EXCEEDED')
  assert.match(String(json.requestId || ''), /^wr_[a-z0-9]+_[a-z0-9]+$/)
  assert.equal(response.headers.get('X-Workbench-Request-Id')?.startsWith('wr_'), true)
  assert.equal(response.headers.get('X-Workbench-Deadline-Phase')?.length ?? 0, 'response_ready'.length)
  assert.equal(abortObserved, true)
  assert.ok(Date.now() - startedAt < 250)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
