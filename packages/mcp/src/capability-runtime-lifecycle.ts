import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { maintainCapabilityJobArtifacts, recoverCapabilityJobs, WORKBENCH_EXECUTION_COORDINATOR_FILENAME, type ExecutionCoordinatorOptions, type ExecutionLifecycleState, type ExecutionRecord } from './capability-execution-coordinator.js'

export const WORKBENCH_RUNTIME_MAINTENANCE_FILENAME = 'workbench-capability-runtime-maintenance.json' as const
export type LifecycleManagerOptions = ExecutionCoordinatorOptions & { maxRecords?: number; retentionMs?: number; providerValid?: (record: ExecutionRecord) => boolean; capabilityValid?: (record: ExecutionRecord) => boolean }
export type LifecycleMaintenanceResult = { recovered: string[]; failed: string[]; expired: string[]; removed: string[]; preservedAuditReferences: string[] }
export type RuntimeHealth = { active: string[]; queued: string[]; failed: string[]; recovered: string[]; expired: string[]; adapterAvailability: Array<{ adapterId: string; available: boolean; detail: string }>; executionLatencyMs: number[]; cancellationCount: number; recentHistory: string[] }

function root(options: LifecycleManagerOptions): string { return path.resolve(options.rootDir ?? path.join(process.cwd(), '.workbench-provider-state')) }
function executionFile(options: LifecycleManagerOptions): string { return path.join(root(options), WORKBENCH_EXECUTION_COORDINATOR_FILENAME) }
function maintenanceFile(options: LifecycleManagerOptions): string { return path.join(root(options), WORKBENCH_RUNTIME_MAINTENANCE_FILENAME) }
function read(options: LifecycleManagerOptions): { version: 1; updatedAt: string; records: ExecutionRecord[] } { const file = executionFile(options); if (!fs.existsSync(file)) return { version: 1, updatedAt: new Date(0).toISOString(), records: [] }; const value = JSON.parse(fs.readFileSync(file, 'utf8')) as { version: 1; updatedAt: string; records: ExecutionRecord[] }; if (value.version !== 1 || !Array.isArray(value.records)) throw new Error('execution_store_corrupt'); return value }
function write(store: { version: 1; updatedAt: string; records: ExecutionRecord[] }, options: LifecycleManagerOptions): void { fs.mkdirSync(root(options), { recursive: true, mode: 0o700 }); const target = executionFile(options); const temp = `${target}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`; fs.writeFileSync(temp, JSON.stringify({ ...store, records: store.records.slice(-Math.max(1, options.maxRecords ?? 300)) }), { encoding: 'utf8', mode: 0o600, flag: 'wx' }); fs.renameSync(temp, target); fs.chmodSync(target, 0o600) }
function saveMaintenance(entry: { at: string; action: string; recovered: number; failed: number; removed: number }, options: LifecycleManagerOptions): void { const target = maintenanceFile(options); let entries: unknown[] = []; try { const value = JSON.parse(fs.readFileSync(target, 'utf8')) as { entries?: unknown[] }; entries = Array.isArray(value.entries) ? value.entries : [] } catch {} entries.push({ eventId: crypto.randomUUID(), ...entry }); fs.mkdirSync(root(options), { recursive: true, mode: 0o700 }); fs.writeFileSync(target, JSON.stringify({ version: 1, entries: entries.slice(-100) }), { encoding: 'utf8', mode: 0o600 }) }

const activeStates: readonly ExecutionLifecycleState[] = ['pending', 'requested', 'validating', 'dispatching', 'running', 'executing', 'completing']
export function recoverCapabilityRuntime(options: LifecycleManagerOptions): LifecycleMaintenanceResult {
  const now = (options.now ?? (() => new Date()))().toISOString(); const recovered: string[] = []; const failed: string[] = []; const expired: string[] = []
  recovered.push(...recoverCapabilityJobs(options)); const store = read(options)
  for (const record of store.records) {
    if (!activeStates.includes(record.lifecycleState)) continue
    const leaseExpired = !!record.leaseExpiresAt && Date.parse(record.leaseExpiresAt) <= Date.parse(now)
    const invalidProvider = options.providerValid ? !options.providerValid(record) : false
    const invalidCapability = options.capabilityValid ? !options.capabilityValid(record) : false
    if (invalidProvider || invalidCapability) { record.lifecycleState = 'failed'; record.error = { code: invalidProvider ? 'provider_invalid' : 'capability_invalid', message: 'Runtime state failed closed during recovery.' }; failed.push(record.executionId) }
    else if (leaseExpired) { record.lifecycleState = 'recovered'; record.error = { code: 'lease_expired', message: 'Ownership lease expired before runtime recovery.' }; recovered.push(record.executionId); expired.push(record.executionId) }
    else { record.lifecycleState = 'recovered'; record.error = { code: 'interrupted_execution', message: 'Execution was active when runtime recovery started.' }; recovered.push(record.executionId) }
    record.updatedAt = now
  }
  store.updatedAt = now; write(store, options); saveMaintenance({ at: now, action: 'recover', recovered: recovered.length, failed: failed.length, removed: 0 }, options); return { recovered, failed, expired, removed: [], preservedAuditReferences: store.records.flatMap(record => record.auditReferences) }
}

export function maintainCapabilityRuntime(options: LifecycleManagerOptions): LifecycleMaintenanceResult {
  const now = (options.now ?? (() => new Date()))(); const expired = maintainCapabilityJobArtifacts(options); const store = read(options); const cutoff = now.getTime() - (options.retentionMs ?? 7 * 24 * 60 * 60 * 1_000); const removed: string[] = []; const preservedAuditReferences: string[] = []
  const retained = store.records.filter(record => { preservedAuditReferences.push(...record.auditReferences); const terminal = ['completed', 'failed', 'cancelled', 'expired', 'recovered'].includes(record.lifecycleState); const remove = terminal && Date.parse(record.updatedAt) < cutoff; if (remove) removed.push(record.executionId); return !remove })
  store.records = retained.slice(-Math.max(1, options.maxRecords ?? 300)); store.updatedAt = now.toISOString(); write(store, options); saveMaintenance({ at: store.updatedAt, action: 'maintain', recovered: 0, failed: 0, removed: removed.length }, options); return { recovered: [], failed: [], expired, removed, preservedAuditReferences }
}

export function runtimeHealth(options: LifecycleManagerOptions): RuntimeHealth {
  let records: ExecutionRecord[] = []; try { records = read(options).records } catch {}
  const active = records.filter(record => activeStates.includes(record.lifecycleState)).map(record => record.executionId); const terminal = records.filter(record => ['completed', 'failed', 'cancelled', 'expired', 'recovered'].includes(record.lifecycleState)); const latency = terminal.flatMap(record => record.result?.metadata.durationMs === undefined ? [] : [record.result.metadata.durationMs])
  return { active, queued: records.filter(record => record.lifecycleState === 'pending').map(record => record.executionId), failed: records.filter(record => record.lifecycleState === 'failed').map(record => record.executionId), recovered: records.filter(record => record.lifecycleState === 'recovered').map(record => record.executionId), expired: records.filter(record => record.lifecycleState === 'expired').map(record => record.executionId), adapterAvailability: options.adapters.map(adapter => ({ adapterId: adapter.adapterId, ...adapter.healthCheck() })), executionLatencyMs: latency, cancellationCount: records.filter(record => record.lifecycleState === 'cancelled').length, recentHistory: records.slice(-20).map(record => record.executionId) }
}
