import assert from 'node:assert/strict'
import { dispatchPortableOperation, isMutationCapable, createPortableOperationRequest } from '../../lib/actions/portable-operation-dispatcher'
import { WORKBENCH_OPERATION_IDS, WORKBENCH_OPERATION_ID_LIST } from '../../lib/actions/portable-operation-contract'
import { PortableOperationError } from '../../lib/actions/portable-operation-errors'

const deadlineAt = new Date(Date.now() + 10_000).toISOString()

async function main(): Promise<void> {
  assert.deepEqual(WORKBENCH_OPERATION_ID_LIST, Object.values(WORKBENCH_OPERATION_IDS))
  assert.equal(WORKBENCH_OPERATION_ID_LIST.length, 5)
  assert.equal(isMutationCapable('getWorkbenchStatus'), false)
  assert.equal(isMutationCapable('readWorkbenchContext'), false)
  assert.equal(isMutationCapable('applyWorkbenchFileChange'), true)
  assert.equal(isMutationCapable('commitWorkbenchChanges'), true)
  assert.equal(isMutationCapable('runWorkbenchCommand'), true)

  const calls: string[] = []
  const handlers = Object.fromEntries(WORKBENCH_OPERATION_ID_LIST.map(operationId => [operationId, async () => {
    calls.push(operationId)
    return { operationId }
  }]))
  for (const operationId of WORKBENCH_OPERATION_ID_LIST) {
    const response = await dispatchPortableOperation(createPortableOperationRequest({ operationId, deadlineAt, payload: {} }), handlers)
    assert.equal(response.ok, true)
    assert.equal(response.operationId, operationId)
  }
  assert.deepEqual(calls, WORKBENCH_OPERATION_ID_LIST)

  let forwardedSourceId: string | undefined
  let forwardedSessionId: string | undefined
  const forwarded = await dispatchPortableOperation({
    protocolVersion: 1,
    requestId: 'source-session-forwarding',
    operationId: 'readWorkbenchContext',
    sourceId: 'authoritative-source',
    sessionId: 'authoritative-session',
    deadlineAt,
    payload: { sourceId: 'untrusted-payload-source' }
  }, {
    readWorkbenchContext: (_payload, context) => {
      forwardedSourceId = context.sourceId
      forwardedSessionId = context.sessionId
      return { ok: true }
    }
  })
  assert.equal(forwarded.ok, true)
  assert.equal(forwardedSourceId, 'authoritative-source')
  assert.equal(forwardedSessionId, 'authoritative-session')

  const cancelled = await dispatchPortableOperation(createPortableOperationRequest({ operationId: 'readWorkbenchContext', deadlineAt, payload: {} }), handlers, { signal: AbortSignal.abort() })
  assert.equal(cancelled.error?.code, 'cancelled')
  const expired = await dispatchPortableOperation(createPortableOperationRequest({ operationId: 'readWorkbenchContext', deadlineAt: new Date(0).toISOString(), payload: {} }), handlers)
  assert.equal(expired.error?.code, 'deadline_exceeded')
  const unknown = await dispatchPortableOperation({ protocolVersion: 1, requestId: 'unknown', operationId: 'runWorkbenchCommand', deadlineAt, payload: {} }, {})
  assert.equal(unknown.error?.code, 'unknown_operation')

  const errors: Array<[string, string]> = [
    ['source mismatch', 'source_mismatch'],
    ['session invalid', 'session_invalid'],
    ['confirmation required', 'invalid_confirmation'],
    ['stale HEAD', 'stale_head'],
    ['protected path', 'protected_path_rejected'],
    ['dependency unavailable', 'dependency_unavailable'],
    ['unexpected', 'internal_error']
  ]
  for (const [message, code] of errors) {
    const result = await dispatchPortableOperation(createPortableOperationRequest({ operationId: 'applyWorkbenchFileChange', deadlineAt, payload: {} }), {
      applyWorkbenchFileChange: async () => { throw new PortableOperationError(code as never, message) }
    })
    assert.equal(result.error?.code, code)
  }
  assert.equal(calls.filter(call => call === 'applyWorkbenchFileChange').length, 1)
  console.log('portable-operation-dispatcher: passed')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
