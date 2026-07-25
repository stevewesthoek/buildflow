import assert from 'node:assert/strict'
import { readCompactSloHealth, recordCompactStatusSloTelemetry } from '@/lib/actions/slo-health'

const fixedNow = new Date('2026-07-16T12:00:00.000Z')

const compact = readCompactSloHealth({ now: fixedNow }, {
  loadStore: (() => ({
    store: {
      version: 1,
      updatedAt: fixedNow.toISOString(),
      samples: [],
      events: []
    },
    migrated: false,
    recovered: false
  })) as never
})
assert.equal(compact.health, 'healthy')
assert.equal(compact.evaluatedAt, fixedNow.toISOString())
assert(compact.unknownMetrics.length > 0)
assert(Buffer.byteLength(JSON.stringify(compact), 'utf8') < 1_500)

const failed = readCompactSloHealth({ now: fixedNow }, {
  loadStore: (() => { throw new Error('store unavailable') }) as never
})
assert.deepEqual(failed, {
  health: 'unknown',
  evaluatedAt: fixedNow.toISOString(),
  degradedMetrics: [],
  overloadedMetrics: [],
  unknownMetrics: ['telemetry_unavailable']
})

const calls: unknown[] = []
assert.equal(recordCompactStatusSloTelemetry({ durationMs: 42, responseBytes: 512 }, {
  appendSample: ((value: unknown) => { calls.push(value); return value }) as never
}), true)
assert.equal(calls.length, 1)
const sample = calls[0] as {
  name?: string
  dimensions?: { operation?: string; reasonCode?: string }
  measurements?: { durationMs?: number; responseBytes?: number }
}
assert.equal(sample.name, 'request_latency')
assert.equal(sample.dimensions?.operation, 'compact_status_ttfb')
assert.equal(sample.dimensions?.reasonCode, 'status_ready')
assert.deepEqual(sample.measurements, { durationMs: 42, responseBytes: 512 })

assert.equal(recordCompactStatusSloTelemetry({ durationMs: 1, responseBytes: 1 }, {
  appendSample: (() => { throw new Error('telemetry unavailable') }) as never
}), false)

const serialized = JSON.stringify([...calls, compact, failed])
for (const forbidden of ['prompt content', 'response body', '/private/path', 'https://private.example', 'raw exception']) {
  assert.equal(serialized.includes(forbidden), false)
}

console.log('SLO status adapter verification passed')
