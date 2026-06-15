import assert from 'node:assert/strict'
import { NextResponse } from 'next/server'
import { withGptActionDeadline } from '../../lib/actions/deadline'
import { ActionTransportError } from '../../lib/actions/transport'
import { buildActionErrorEnvelope } from '../../lib/actions/action-response'
import { isControlledFailure, validateNoGatewayStatusCodes } from '../../lib/actions/http-status'

async function testDeadlineReturnsHttp200OnTimeout() {
  let abortObserved = false
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

  assert.equal(response.status, 200, 'deadline timeout must return HTTP 200')
  const json = await response.json()
  assert.equal(json.ok, false)
  assert.equal(json.status, 'timeout')
  assert.equal(json.error?.code, 'BUILDFLOW_ACTION_DEADLINE_EXCEEDED')
  assert.equal(abortObserved, true)
  console.log('✓ Deadline timeout returns HTTP 200 with structured timeout payload')
}

async function testTransportTimeoutReturnsHttp200() {
  const error = new ActionTransportError(
    'Timed out waiting for /api/test',
    200,
    buildActionErrorEnvelope({
      code: 'LOCAL_STACK_TIMEOUT',
      message: 'BuildFlow local stack timed out.',
      details: 'Request exceeded timeout.',
      status: 'timeout'
    })
  )
  assert.equal(error.statusCode, 200, 'transport timeout statusCode must be 200')
  assert.equal((error.payload as { status?: string })?.status, 'timeout')
  console.log('✓ Transport timeout uses HTTP 200 internally')
}

async function testControlledFailureClassifications() {
  const controlledCodes = [
    'LOCAL_STACK_TIMEOUT',
    'LOCAL_STACK_UNAVAILABLE',
    'RESPONSE_SIZE_EXCEEDED',
    'EMPTY_RELAY_RESPONSE',
    'INVALID_RELAY_RESPONSE',
    'ACTION_TRANSPORT_ERROR',
    'BUILDFLOW_ACTION_DEADLINE_EXCEEDED',
    'BUILDFLOW_NEEDS_NARROWER_SCOPE',
    'STATUS_PAYLOAD_EXCEEDS_BUDGET',
    'BUILDFLOW_RESPONSE_SIZE_EXCEEDED',
    'BUILDFLOW_COMMAND_TIMEOUT',
    'REQUIRES_EXPLICIT_CONFIRMATION'
  ]

  for (const code of controlledCodes) {
    assert.equal(isControlledFailure(code), true, `${code} must be classified as controlled`)
  }

  console.log(`✓ All ${controlledCodes.length} controlled failure codes are properly classified`)
}

async function testNoGatewayStatusCodesInControlledFailures() {
  assert.doesNotThrow(() => {
    validateNoGatewayStatusCodes()
  }, 'No controlled failures should use 502, 503, 504, or 507')

  console.log('✓ No controlled failures use gateway status codes (502, 503, 504, 507)')
}

async function testDeadlineHandlesTransportErrors() {
  const response = await withGptActionDeadline(
    {
      operationId: 'testTransportError',
      route: '/api/test-error',
      deadlineMs: 5000
    },
    async (context) => {
      throw new ActionTransportError(
        'Connection refused',
        200,
        buildActionErrorEnvelope({
          code: 'LOCAL_STACK_UNAVAILABLE',
          message: 'BuildFlow local stack is unavailable.',
          details: 'Connection refused.',
          status: 'unavailable'
        })
      )
    }
  )

  assert.equal(response.status, 200, 'deadline must preserve HTTP 200 from caught transport errors')
  const json = await response.json()
  assert.equal(json.ok, false)
  assert.equal(json.error?.code, 'LOCAL_STACK_UNAVAILABLE')
  console.log('✓ Deadline properly handles and propagates transport errors with HTTP 200')
}

async function main() {
  await testDeadlineReturnsHttp200OnTimeout()
  await testTransportTimeoutReturnsHttp200()
  await testControlledFailureClassifications()
  await testNoGatewayStatusCodesInControlledFailures()
  await testDeadlineHandlesTransportErrors()

  console.log('\n✓ All controlled failure tests passed')
  console.log('✓ No controlled Workbench failures can emit HTTP 502, 503, or 504')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
