import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { maintainCapabilityRuntime, recoverCapabilityRuntime, runtimeHealth } from '../capability-runtime-lifecycle.js'
import { WORKBENCH_EXECUTION_COORDINATOR_FILENAME } from '../capability-execution-coordinator.js'

const record = (id: string, state: any, extra: Record<string, unknown> = {}) => ({ executionId: id, planId: 'plan', lifecycleState: state, createdAt: '2026-08-23T00:00:00.000Z', updatedAt: '2026-08-23T00:00:00.000Z', leaseExpiresAt: '2026-08-23T00:00:01.000Z', auditReferences: [`audit-${id}`], ...extra })
function fixture() { const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-lifecycle-')); fs.writeFileSync(path.join(rootDir, WORKBENCH_EXECUTION_COORDINATOR_FILENAME), JSON.stringify({ version: 1, updatedAt: '2026-08-23T00:00:00.000Z', records: [record('expired', 'running'), record('interrupted', 'dispatching', { leaseExpiresAt: '2026-08-23T01:00:00.000Z' }), record('complete', 'completed')] })); return rootDir }
const options = (rootDir: string) => ({ rootDir, adapters: [], now: () => new Date('2026-08-23T00:01:00.000Z') })

test('recovers interrupted and expired leases without retrying', () => { const rootDir = fixture(); try { const result = recoverCapabilityRuntime(options(rootDir)); assert.deepEqual(result.recovered.sort(), ['expired', 'interrupted']); assert.deepEqual(result.expired, ['expired']); const health = runtimeHealth(options(rootDir)); assert.equal(health.recovered.length, 2); assert.equal(health.active.length, 0) } finally { fs.rmSync(rootDir, { recursive: true, force: true }) } })
test('fails closed for invalid provider and capability state', () => { const rootDir = fixture(); try { const result = recoverCapabilityRuntime({ ...options(rootDir), providerValid: item => item.executionId !== 'expired' }); assert.deepEqual(result.failed, ['expired']); const health = runtimeHealth(options(rootDir)); assert.deepEqual(health.failed, ['expired']) } finally { fs.rmSync(rootDir, { recursive: true, force: true }) } })
test('maintenance removes only bounded old terminal records and preserves audit references', () => { const rootDir = fixture(); try { const result = maintainCapabilityRuntime({ ...options(rootDir), retentionMs: 1 }); assert.deepEqual(result.removed, ['complete']); assert.equal(result.preservedAuditReferences.length, 3); assert.equal(runtimeHealth(options(rootDir)).recentHistory.length, 2) } finally { fs.rmSync(rootDir, { recursive: true, force: true }) } })
