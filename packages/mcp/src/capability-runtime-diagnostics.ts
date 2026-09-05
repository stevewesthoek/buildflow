import { readCapabilityRuntimeBootstrapStatus, type RuntimeBootstrapOptions, type RuntimeBootstrapStatus } from './capability-runtime-bootstrap.js'
import { runtimeHealth, type RuntimeHealth } from './capability-runtime-lifecycle.js'
import { readKnowledgeContextRuntimeStatus, type KnowledgeContextRuntimeStatus } from './knowledge-context-runtime.js'
import { capabilityPlanDiagnostics } from './capability-planning.js'
import { validationDiagnostics } from './capability-pre-execution.js'
import { dispatchDiagnostics } from './capability-dispatch.js'

export const CAPABILITY_RUNTIME_DIAGNOSTIC_SCHEMA_VERSION = 1 as const
export type CapabilityRuntimeDiagnostic = {
  schemaVersion: typeof CAPABILITY_RUNTIME_DIAGNOSTIC_SCHEMA_VERSION
  runtimeIdentity: { component: 'capability-runtime'; version: '1' }
  lifecycle: { readiness: 'ready' | 'warning' | 'unavailable'; initialized: boolean; lastRecoveryAt?: string; recovered: string[]; failedRecoveries: string[] }
  health: RuntimeHealth
  maintenance: { status: RuntimeBootstrapStatus['maintenance']; activeTasks: string[]; warning?: string }
  knowledgeRuntime?: KnowledgeContextRuntimeStatus
  capabilityExecution: { plans: ReturnType<typeof capabilityPlanDiagnostics>; validation: ReturnType<typeof validationDiagnostics>; dispatch: ReturnType<typeof dispatchDiagnostics>; readiness: 'ready' | 'warning' | 'unavailable' }
  warnings: string[]
  remediation: Array<{ code: string; message: string; automatic: false }>
}
function bounded(values: string[], limit = 32): string[] { return [...values].sort().slice(0, limit) }
export function getCapabilityRuntimeDiagnostic(options: RuntimeBootstrapOptions): CapabilityRuntimeDiagnostic | undefined {
  const bootstrap = readCapabilityRuntimeBootstrapStatus(options); if (!bootstrap) return undefined
  const health = runtimeHealth(options); const warnings: string[] = []; const remediation: CapabilityRuntimeDiagnostic['remediation'] = []
  if (!bootstrap.initialized) { warnings.push('Capability runtime lifecycle did not initialize.'); remediation.push({ code: 'runtime_recovery_failed', message: 'Inspect the capability runtime state before restarting execution.', automatic: false }) }
  if (bootstrap.failedRecoveries.length > 0) { warnings.push(`${bootstrap.failedRecoveries.length} execution recovery failure(s) were recorded.`); remediation.push({ code: 'recovery_failures', message: 'Review failed execution recovery records; no automatic retry was performed.', automatic: false }) }
  if (health.expired.length > 0) warnings.push(`${health.expired.length} execution lease(s) are expired.`)
  if (bootstrap.maintenance === 'failed') { warnings.push('Capability runtime maintenance failed.'); remediation.push({ code: 'maintenance_failed', message: 'Run bounded runtime maintenance after reviewing the maintenance error.', automatic: false }) }
  const adapterUnavailable = health.adapterAvailability.filter(item => !item.available); if (adapterUnavailable.length > 0) { warnings.push(`${adapterUnavailable.length} capability adapter(s) are unavailable.`); remediation.push({ code: 'adapter_unavailable', message: 'Review adapter health before approving capability execution.', automatic: false }) }
  const knowledgeRuntime = readKnowledgeContextRuntimeStatus({ registry: { rootDir: options.rootDir } })
  const capabilityExecution = { plans: capabilityPlanDiagnostics({ rootDir: options.rootDir }), validation: validationDiagnostics({ rootDir: options.rootDir }), dispatch: dispatchDiagnostics({ rootDir: options.rootDir }), readiness: 'ready' as 'ready' | 'warning' | 'unavailable' }
  if (!capabilityExecution.plans.ok || !capabilityExecution.validation.ok || !capabilityExecution.dispatch.ok) capabilityExecution.readiness = 'unavailable'
  else if (capabilityExecution.plans.value.pending.length > 0 || capabilityExecution.validation.value.pending.length > 0 || capabilityExecution.dispatch.value.rejected.length > 0) capabilityExecution.readiness = 'warning'
  if (knowledgeRuntime?.readiness === 'warning') warnings.push('Knowledge context runtime is degraded.')
  if (knowledgeRuntime?.readiness === 'unavailable') warnings.push('Knowledge context runtime is unavailable; repository operation remains available.')
  const readiness = !bootstrap.initialized ? 'unavailable' : warnings.length > 0 ? 'warning' : 'ready'
  return { schemaVersion: CAPABILITY_RUNTIME_DIAGNOSTIC_SCHEMA_VERSION, runtimeIdentity: { component: 'capability-runtime', version: '1' }, lifecycle: { readiness, initialized: bootstrap.initialized, lastRecoveryAt: bootstrap.lastRecoveryAt, recovered: bounded(bootstrap.recovered), failedRecoveries: bounded(bootstrap.failedRecoveries) }, health: { ...health, active: bounded(health.active), queued: bounded(health.queued), failed: bounded(health.failed), recovered: bounded(health.recovered), expired: bounded(health.expired), recentHistory: bounded(health.recentHistory) }, maintenance: { status: bootstrap.maintenance, activeTasks: bootstrap.maintenance === 'scheduled' ? ['runtime-maintenance'] : [], warning: bootstrap.maintenanceError }, ...(knowledgeRuntime ? { knowledgeRuntime } : {}), capabilityExecution, warnings: warnings.slice(0, 16), remediation: remediation.slice(0, 16) }
}
