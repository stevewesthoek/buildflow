import assert from 'node:assert/strict'
import {
  jsonResponseBytes,
  recordRunCommandTelemetry,
  type RunCommandTelemetryInput
} from '@/lib/actions/run-command-telemetry'

type RecordedCall = {
  type: 'sample' | 'event'
  value: unknown
}

function record(input: RunCommandTelemetryInput): RecordedCall[] {
  const calls: RecordedCall[] = []
  const appendSample = ((value: unknown) => {
    calls.push({ type: 'sample', value })
    return value
  }) as never
  const appendEvent = ((value: unknown) => {
    calls.push({ type: 'event', value })
    return value
  }) as never
  const recorded = recordRunCommandTelemetry(input, { appendSample, appendEvent })
  assert.equal(recorded, true)
  return calls
}

function serialized(calls: RecordedCall[]): string {
  return JSON.stringify(calls)
}

function assertRequestOutcome(
  calls: RecordedCall[],
  expectedOutcome: string,
  expectedReason: string,
  expectedEvent: string
) {
  assert(calls.some(call => {
    const value = call.value as { name?: string; dimensions?: { outcome?: string; reasonCode?: string } }
    return call.type === 'event'
      && value.name === expectedEvent
      && value.dimensions?.outcome === expectedOutcome
      && value.dimensions?.reasonCode === expectedReason
  }))
}

const sensitiveStdout = 'stdout-private-payload'
const sensitiveStderr = 'stderr-private-payload'
const responsePayload = {
  stdout: sensitiveStdout,
  stderr: sensitiveStderr,
  diagnostics: { rawError: 'private exception text' }
}

const success = record({
  disposition: 'success',
  reasonCode: 'command_completed',
  requestDurationMs: 40,
  responseBytes: jsonResponseBytes(responsePayload),
  sourceId: 'source-a',
  commandKind: 'git_status_short',
  commandDurationMs: 25
})
assertRequestOutcome(success, 'success', 'command_completed', 'request_completed')
assert(success.some(call => (call.value as { name?: string }).name === 'command_completed'))

const rejected = record({
  disposition: 'rejected',
  reasonCode: 'invalid_request',
  requestDurationMs: 2,
  responseBytes: 120
})
assertRequestOutcome(rejected, 'rejected', 'invalid_request', 'request_rejected')
assert.equal(rejected.some(call => (call.value as { name?: string }).name === 'command_completed'), false)
assert.equal(rejected.some(call => (call.value as { name?: string }).name === 'command_failed'), false)

const failed = record({
  disposition: 'failure',
  reasonCode: 'command_failed',
  requestDurationMs: 60,
  responseBytes: 240,
  sourceId: 'source-a',
  commandKind: 'run_package_script',
  commandDurationMs: 55
})
assertRequestOutcome(failed, 'failure', 'command_failed', 'request_failed')
assert(failed.some(call => (call.value as { name?: string }).name === 'command_failed'))

const timedOut = record({
  disposition: 'timed_out',
  reasonCode: 'command_timed_out',
  requestDurationMs: 8_000,
  responseBytes: 300,
  sourceId: 'source-a',
  commandKind: 'type_check_web',
  commandDurationMs: 7_900
})
assertRequestOutcome(timedOut, 'timed_out', 'command_timed_out', 'request_failed')
assert(timedOut.some(call => {
  const value = call.value as { name?: string; dimensions?: { outcome?: string } }
  return value.name === 'command_failed' && value.dimensions?.outcome === 'timed_out'
}))

const allSerialized = serialized([...success, ...rejected, ...failed, ...timedOut])
assert.equal(allSerialized.includes(sensitiveStdout), false)
assert.equal(allSerialized.includes(sensitiveStderr), false)
assert.equal(allSerialized.includes('private exception text'), false)
assert.equal(allSerialized.includes('diagnostics'), false)

const isolated = recordRunCommandTelemetry({
  disposition: 'failure',
  reasonCode: 'transport_error',
  requestDurationMs: 12,
  responseBytes: 80,
  sourceId: 'source-a',
  commandKind: 'git_status_short'
}, {
  appendSample: (() => { throw new Error('store unavailable') }) as never,
  appendEvent: (() => { throw new Error('store unavailable') }) as never
})
assert.equal(isolated, false)

console.log('Run-command telemetry verification passed')
