import assert from 'node:assert/strict'
import {
  classifyRuntimeHealth,
  recordRuntimeResourceTelemetry,
  recordTunnelHealthTelemetry,
  resetTunnelHealthTelemetryForTests
} from '@/lib/actions/runtime-tunnel-telemetry'

type Call = { type: 'sample' | 'event'; value: unknown }

function deps(calls: Call[]) {
  return {
    appendSample: ((value: unknown) => { calls.push({ type: 'sample', value }); return value }) as never,
    appendEvent: ((value: unknown) => { calls.push({ type: 'event', value }); return value }) as never
  }
}

assert.equal(classifyRuntimeHealth(0), 'healthy')
assert.equal(classifyRuntimeHealth(10), 'degraded')
assert.equal(classifyRuntimeHealth(20), 'overloaded')
assert.equal(classifyRuntimeHealth(Number.NaN), 'unknown')

const runtimeCalls: Call[] = []
assert.equal(recordRuntimeResourceTelemetry({ heapBytes: 1024, rssBytes: 2048, activeRequests: 3 }, deps(runtimeCalls)), true)
assert.equal(runtimeCalls.length, 1)
const runtimeSample = runtimeCalls[0]?.value as { name?: string; dimensions?: { health?: string }; measurements?: { heapBytes?: number; rssBytes?: number; count?: number } }
assert.equal(runtimeSample.name, 'runtime_resource')
assert.equal(runtimeSample.dimensions?.health, 'healthy')
assert.equal(runtimeSample.measurements?.heapBytes, 1024)
assert.equal(runtimeSample.measurements?.rssBytes, 2048)
assert.equal(runtimeSample.measurements?.count, 3)

resetTunnelHealthTelemetryForTests()
const tunnelCalls: Call[] = []
assert.equal(recordTunnelHealthTelemetry({ health: 'healthy', durationMs: 5, reasonCode: 'relay_healthy' }, deps(tunnelCalls)), true)
assert.equal(recordTunnelHealthTelemetry({ health: 'healthy', durationMs: 6, reasonCode: 'relay_healthy' }, deps(tunnelCalls)), true)
assert.equal(recordTunnelHealthTelemetry({ health: 'degraded', durationMs: 7, reasonCode: 'relay_degraded' }, deps(tunnelCalls)), true)
assert.equal(recordTunnelHealthTelemetry({ health: 'degraded', durationMs: 8, reasonCode: 'relay_degraded' }, deps(tunnelCalls)), true)

const samples = tunnelCalls.filter(call => call.type === 'sample')
const events = tunnelCalls.filter(call => call.type === 'event')
assert.equal(samples.length, 4)
assert.equal(events.length, 2)
assert.equal((events[0]?.value as { dimensions?: { health?: string } }).dimensions?.health, 'healthy')
assert.equal((events[1]?.value as { dimensions?: { health?: string } }).dimensions?.health, 'degraded')

const serialized = JSON.stringify([...runtimeCalls, ...tunnelCalls])
for (const forbidden of ['http://private-host', 'device-token', 'Authorization', '127.0.0.1', 'raw error text']) {
  assert.equal(serialized.includes(forbidden), false)
}

const isolatedRuntime = recordRuntimeResourceTelemetry({ heapBytes: 1, rssBytes: 2, activeRequests: 1 }, {
  appendSample: (() => { throw new Error('store unavailable') }) as never,
  appendEvent: (() => { throw new Error('store unavailable') }) as never
})
assert.equal(isolatedRuntime, false)

const isolatedTunnel = recordTunnelHealthTelemetry({ health: 'unknown', durationMs: 9, reasonCode: 'relay_unreachable' }, {
  appendSample: (() => { throw new Error('store unavailable') }) as never,
  appendEvent: (() => { throw new Error('store unavailable') }) as never
})
assert.equal(isolatedTunnel, false)

console.log('Runtime and tunnel telemetry verification passed')
