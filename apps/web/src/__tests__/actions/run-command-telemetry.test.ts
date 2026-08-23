import assert from 'node:assert/strict'
import {
  buildRolledBackPacketTelemetryInput,
  buildRunCommandRouteTelemetryInput,
  jsonResponseBytes,
  recordRunCommandTelemetry,
  type RunCommandTelemetryInput
} from '@/lib/actions/run-command-telemetry'

type RecordedCall = { type: 'sample' | 'event'; value: any }

function emptyStore() {
  return { store: { version: 1, updatedAt: '2026-07-26T00:00:00.000Z', events: [], samples: [] }, recovery: null }
}

function baseInput(overrides: Partial<RunCommandTelemetryInput> = {}): RunCommandTelemetryInput {
  return {
    requestId: 'wr-test-request-001',
    disposition: 'success',
    reasonCode: 'command_completed',
    requestDurationMs: 40,
    responseBytes: 120,
    renderedBytes: 120,
    actionRoundTrips: 1,
    retries: 0,
    interruptions: 0,
    sourceId: 'source-a',
    commandKind: 'git_status_short',
    commandDurationMs: 25,
    ...overrides
  }
}

function record(input: RunCommandTelemetryInput, existingSamples: any[] = []) {
  const calls: RecordedCall[] = []
  const recorded = recordRunCommandTelemetry(input, {
    appendSample: ((value: unknown) => { calls.push({ type: 'sample', value }); return value }) as never,
    appendEvent: ((value: unknown) => { calls.push({ type: 'event', value }); return value }) as never,
    loadStore: (() => ({ store: { ...emptyStore().store, samples: existingSamples }, recovery: null })) as never
  })
  return { recorded, calls }
}

function byName(calls: RecordedCall[], name: string) {
  return calls.filter(call => call.value?.name === name)
}

const sensitivePayload = { stdout: 'stdout-private-payload', stderr: 'stderr-private-payload', diagnostics: { rawError: 'private exception text' } }
const success = record(baseInput({ responseBytes: jsonResponseBytes(sensitivePayload), renderedBytes: jsonResponseBytes(sensitivePayload) }))
assert.equal(success.recorded, true)
assert.equal(byName(success.calls, 'request_latency').length, 1)
assert.equal(byName(success.calls, 'response_size').length, 1)
assert.equal(byName(success.calls, 'conversation_efficiency').length, 1)
assert.equal(byName(success.calls, 'request_completed').length, 1)
assert.equal(byName(success.calls, 'command_completed').length, 1)
for (const call of success.calls) assert.equal(call.value.scope.requestId, 'wr-test-request-001')
const conversation = byName(success.calls, 'conversation_efficiency')[0].value
assert.deepEqual(conversation.measurements, {
  durationMs: 40,
  responseBytes: jsonResponseBytes(sensitivePayload),
  renderedBytes: jsonResponseBytes(sensitivePayload),
  actionRoundTrips: 1,
  retries: 0,
  interruptions: 0
})
assert.equal(JSON.stringify(success.calls).includes('stdout-private-payload'), false)
assert.equal(JSON.stringify(success.calls).includes('private exception text'), false)

const applyFileChange = record(baseInput({
  requestId: 'wr-test-apply-file-change',
  operationId: 'applyWorkbenchFileChange',
  commandKind: undefined,
  commandDurationMs: undefined
}))
assert.equal(applyFileChange.recorded, true)
assert.equal(byName(applyFileChange.calls, 'request_latency').length, 1)
assert.equal(byName(applyFileChange.calls, 'conversation_efficiency').length, 1)
for (const call of applyFileChange.calls) {
  assert.equal(call.value.scope.requestId, 'wr-test-apply-file-change')
  assert.equal(call.value.dimensions.operation, call.value.name === 'conversation_efficiency' ? 'conversation_efficiency_direct' : 'applyWorkbenchFileChange')
}
assert.deepEqual(byName(applyFileChange.calls, 'conversation_efficiency')[0].value.measurements, {
  durationMs: 40,
  responseBytes: 120,
  renderedBytes: 120,
  actionRoundTrips: 1,
  retries: 0,
  interruptions: 0
})
const duplicateApplyFileChange = record(baseInput({
  requestId: 'wr-test-apply-file-change',
  operationId: 'applyWorkbenchFileChange',
  commandKind: undefined,
  commandDurationMs: undefined
}), [{ name: 'conversation_efficiency', scope: { requestId: 'wr-test-apply-file-change' } }])
assert.equal(duplicateApplyFileChange.recorded, false)
assert.equal(duplicateApplyFileChange.calls.length, 0)

const rollbackPayload = {
  status: 'failed',
  packetId: 'rollback-cold-001',
  writesPerformed: true,
  rolledBack: true,
  failedStep: 1,
  errors: [{ code: 'PACKET_EXECUTION_FAILED', message: 'Validation validate_json_files failed' }],
  diagnostics: { rawError: 'private rollback diagnostics' }
}
const rollbackInput = buildRolledBackPacketTelemetryInput(rollbackPayload, {
  requestId: 'wr-test-rollback',
  requestDurationMs: 190,
  sourceId: 'source-a',
  commandKind: undefined,
  commandDurationMs: undefined
})
assert.equal(rollbackInput.operationId, 'applyWorkbenchFileChange')
assert.equal(rollbackInput.disposition, 'failure')
assert.equal(rollbackInput.reasonCode, 'packet_rolled_back')
assert.equal(rollbackInput.responseBytes, jsonResponseBytes(rollbackPayload))
assert.equal(rollbackInput.renderedBytes, jsonResponseBytes(rollbackPayload))
assert.equal(rollbackInput.actionRoundTrips, 1)
assert.equal(rollbackInput.retries, 0)
assert.equal(rollbackInput.interruptions, 0)
const rollback = record(rollbackInput)
assert.equal(rollback.recorded, true)
assert.equal(byName(rollback.calls, 'request_latency').length, 1)
assert.equal(byName(rollback.calls, 'response_size').length, 1)
assert.equal(byName(rollback.calls, 'conversation_efficiency').length, 1)
for (const call of rollback.calls) assert.equal(call.value.scope.requestId, 'wr-test-rollback')
assert.equal(byName(rollback.calls, 'request_latency')[0].value.dimensions.operation, 'applyWorkbenchFileChange')
assert.equal(byName(rollback.calls, 'request_latency')[0].value.dimensions.reasonCode, 'packet_rolled_back')
assert.equal(JSON.stringify(rollback.calls).includes('private rollback diagnostics'), false)
assert.equal(JSON.stringify(rollback.calls).includes('Validation validate_json_files failed'), false)
const duplicateRollback = record(rollbackInput, [{ name: 'request_latency', scope: { requestId: 'wr-test-rollback' } }])
assert.equal(duplicateRollback.recorded, false)
assert.equal(duplicateRollback.calls.length, 0)
assert.throws(() => buildRolledBackPacketTelemetryInput({
  ...rollbackPayload,
  rolledBack: false
}, {
  requestId: 'wr-test-no-rollback',
  requestDurationMs: 190,
  sourceId: 'source-a',
  commandKind: undefined,
  commandDurationMs: undefined
}), /does not prove failed execution with completed rollback/)

const timeout = record(baseInput({
  requestId: 'wr-test-timeout',
  disposition: 'timed_out',
  reasonCode: 'command_timed_out',
  requestDurationMs: 8000,
  commandDurationMs: 7900,
  interruptions: 1
}))
assert.equal(timeout.recorded, true)
assert.equal(byName(timeout.calls, 'conversation_efficiency')[0].value.measurements.interruptions, 1)
assert.equal(byName(timeout.calls, 'request_failed')[0].value.dimensions.outcome, 'timed_out')
assert.equal(byName(timeout.calls, 'command_failed')[0].value.dimensions.outcome, 'timed_out')

const rejected = record(baseInput({
  requestId: 'wr-test-rejected',
  disposition: 'rejected',
  reasonCode: 'invalid_request',
  commandKind: undefined,
  commandDurationMs: undefined
}))
assert.equal(rejected.recorded, true)
assert.equal(byName(rejected.calls, 'conversation_efficiency')[0].value.measurements.interruptions, 0)
assert.equal(byName(rejected.calls, 'request_rejected').length, 1)
assert.equal(byName(rejected.calls, 'command_completed').length, 0)
assert.equal(byName(rejected.calls, 'command_failed').length, 0)

const failed = record(baseInput({
  requestId: 'wr-test-failure',
  disposition: 'failure',
  reasonCode: 'command_failed',
  commandKind: 'run_package_script',
  commandDurationMs: 55
}))
assert.equal(failed.recorded, true)
assert.equal(byName(failed.calls, 'request_failed')[0].value.dimensions.outcome, 'failure')
assert.equal(byName(failed.calls, 'command_failed').length, 1)

const duplicate = record(baseInput(), [{ name: 'request_latency', scope: { requestId: 'wr-test-request-001' } }])
assert.equal(duplicate.recorded, false)
assert.equal(duplicate.calls.length, 0)

for (const invalid of [
  { requestDurationMs: Number.NaN },
  { responseBytes: Number.POSITIVE_INFINITY },
  { renderedBytes: -1 },
  { actionRoundTrips: 1.5 },
  { retries: -1 },
  { interruptions: Number.NaN }
]) {
  const result = record(baseInput({ requestId: `wr-invalid-${Object.keys(invalid)[0]}`, ...invalid }))
  assert.equal(result.recorded, false)
  assert.equal(result.calls.length, 0)
}

const isolated = recordRunCommandTelemetry(baseInput({ requestId: 'wr-store-failure', disposition: 'failure', reasonCode: 'transport_error' }), {
  appendSample: (() => { throw new Error('store unavailable') }) as never,
  appendEvent: (() => { throw new Error('store unavailable') }) as never,
  loadStore: (() => emptyStore()) as never
})
assert.equal(isolated, false)

for (const routeCase of [
  { requestId: 'wr-route-success', disposition: 'success' as const, reasonCode: 'command_completed' as const, expectedInterruptions: 0 },
  { requestId: 'wr-route-timeout', disposition: 'timed_out' as const, reasonCode: 'command_timed_out' as const, expectedInterruptions: 1 },
  { requestId: 'wr-route-rejected', disposition: 'rejected' as const, reasonCode: 'command_rejected' as const, expectedInterruptions: 0 },
  { requestId: 'wr-route-failure', disposition: 'failure' as const, reasonCode: 'command_failed' as const, expectedInterruptions: 0 }
]) {
  const payload = { ok: routeCase.disposition === 'success', requestId: routeCase.requestId }
  const captured = buildRunCommandRouteTelemetryInput(payload, {
    requestId: routeCase.requestId,
    disposition: routeCase.disposition,
    reasonCode: routeCase.reasonCode,
    requestDurationMs: 42,
    sourceId: 'source-a',
    commandKind: 'git_status_short',
    commandDurationMs: 21
  })
  assert.equal(captured.requestId, routeCase.requestId)
  assert.equal(captured.responseBytes, jsonResponseBytes(payload))
  assert.equal(captured.renderedBytes, jsonResponseBytes(payload))
  assert.equal(captured.actionRoundTrips, 1)
  assert.equal(captured.retries, 0)
  assert.equal(captured.interruptions, routeCase.expectedInterruptions)
}

console.log('Run-command telemetry tests passed')
