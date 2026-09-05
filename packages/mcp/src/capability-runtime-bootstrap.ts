import fs from 'node:fs'
import path from 'node:path'
import { maintainCapabilityRuntime, recoverCapabilityRuntime, runtimeHealth, type LifecycleManagerOptions, type LifecycleMaintenanceResult, type RuntimeHealth } from './capability-runtime-lifecycle.js'

export const WORKBENCH_RUNTIME_BOOTSTRAP_FILENAME = 'workbench-capability-runtime-bootstrap.json' as const
export type RuntimeBootstrapStatus = { initialized: boolean; recovered: string[]; failedRecoveries: string[]; lastRecoveryAt?: string; maintenance: 'idle' | 'scheduled' | 'completed' | 'failed'; maintenanceError?: string; health: RuntimeHealth }
export type RuntimeBootstrapOptions = LifecycleManagerOptions & { maintenanceDelayMs?: number }
function statusPath(options: RuntimeBootstrapOptions): string { return path.join(path.resolve(options.rootDir ?? path.join(process.cwd(), '.workbench-provider-state')), WORKBENCH_RUNTIME_BOOTSTRAP_FILENAME) }
function persistStatus(status: RuntimeBootstrapStatus, options: RuntimeBootstrapOptions): void { const target = statusPath(options); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); fs.writeFileSync(target, JSON.stringify({ version: 1, ...status }), { encoding: 'utf8', mode: 0o600 }) }
export function readCapabilityRuntimeBootstrapStatus(options: RuntimeBootstrapOptions): RuntimeBootstrapStatus | undefined { try { const value = JSON.parse(fs.readFileSync(statusPath(options), 'utf8')) as { version?: number } & RuntimeBootstrapStatus; return value.version === 1 && typeof value.initialized === 'boolean' ? value : undefined } catch { return undefined } }

export function initializeCapabilityRuntime(options: RuntimeBootstrapOptions): RuntimeBootstrapStatus {
  try {
    const recovery = recoverCapabilityRuntime(options)
    const status = { initialized: true, recovered: recovery.recovered, failedRecoveries: recovery.failed, lastRecoveryAt: (options.now ?? (() => new Date()))().toISOString(), maintenance: 'idle' as const, health: runtimeHealth(options) }; try { persistStatus(status, options) } catch {} ; return status
  } catch (error) {
    const status = { initialized: false, recovered: [], failedRecoveries: [], maintenance: 'failed' as const, maintenanceError: error instanceof Error ? error.message : 'Runtime recovery failed.', health: runtimeHealth(options) }; try { persistStatus(status, options) } catch {} ; return status
  }
}

export function scheduleCapabilityRuntimeMaintenance(options: RuntimeBootstrapOptions, status: RuntimeBootstrapStatus): { cancel: () => void; runNow: () => LifecycleMaintenanceResult | undefined } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const runNow = (): LifecycleMaintenanceResult | undefined => { try { const result = maintainCapabilityRuntime(options); status.maintenance = 'completed'; status.health = runtimeHealth(options); try { persistStatus(status, options) } catch {} ; return result } catch (error) { status.maintenance = 'failed'; status.maintenanceError = error instanceof Error ? error.message : 'Runtime maintenance failed.'; try { persistStatus(status, options) } catch {} ; return undefined } }
  const delay = Math.max(0, Math.min(options.maintenanceDelayMs ?? 1_000, 10_000)); status.maintenance = 'scheduled'; timer = setTimeout(() => { timer = undefined; runNow() }, delay)
  return { cancel: () => { if (timer) clearTimeout(timer); timer = undefined; if (status.maintenance === 'scheduled') status.maintenance = 'idle' }, runNow }
}
