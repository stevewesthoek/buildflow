import { getContextIntelligenceDoctorReport, serializeContextIntelligenceDoctorReport, type ContextIntelligenceDoctorReport, type DoctorRemediation, type DoctorSource } from '../agent/context-intelligence-doctor'

export const DOCTOR_EXIT_CODES = { healthy: 0, warnings: 1, actionRequired: 2, unavailable: 3 } as const

function remediationLines(remediations: DoctorRemediation[]): string[] { return remediations.map(item => `- ${item.message}`) }
function sourceLine(source: DoctorSource): string {
  const health = source.health
  const freshness = health ? `${health.freshnessState} (${health.freshnessScore})` : 'unavailable'
  const indexStatus = health?.indexStatus || 'unknown'
  const queue = source.jobs.length ? source.jobs.map(item => `${item.job.status}:${item.job.jobId}`).join(', ') : 'none'
  return `- ${source.sourceId}: ${source.path} | ${health?.branchName || 'branch unknown'} | HEAD ${health?.observedRevision || 'unknown'} | indexed ${health?.indexedRevision || 'none'} | freshness ${freshness} | index ${indexStatus} | queue ${queue}`
}

export function doctorExitCode(report: ContextIntelligenceDoctorReport): number {
  if (report.sources.length === 0) return DOCTOR_EXIT_CODES.unavailable
  if (report.sources.some(source => !source.health || source.health.runtimeAvailability === 'unavailable')) return DOCTOR_EXIT_CODES.unavailable
  if (report.queue.failed.length > 0 || report.queue.blocked.length > 0 || report.context.pendingConfirmation.length > 0 || report.context.sessions.some(session => session.expired)) return DOCTOR_EXIT_CODES.actionRequired
  if (report.capabilityRuntime && report.capabilityRuntime.lifecycle.readiness === 'unavailable') return DOCTOR_EXIT_CODES.unavailable
  if (report.capabilityRuntime && report.capabilityRuntime.lifecycle.readiness === 'warning') return DOCTOR_EXIT_CODES.warnings
  if (report.knowledgeRuntime && report.knowledgeRuntime.readiness !== 'ready') return DOCTOR_EXIT_CODES.warnings
  if (report.mcpContext && report.mcpContext.status === 'degraded') return DOCTOR_EXIT_CODES.warnings
  if (report.remediations.length > 0 || report.queue.stale.length > 0 || report.queue.running.length > 0) return DOCTOR_EXIT_CODES.warnings
  return DOCTOR_EXIT_CODES.healthy
}

export function formatDoctorHuman(report: ContextIntelligenceDoctorReport): string {
  const lines = [
    'Workbench Context Intelligence Doctor',
    '======================================',
    `Generated: ${report.generatedAt}`,
    '',
    `Context: ${report.context.mode}`,
    `Active sources: ${report.context.activeSourceIds.length ? report.context.activeSourceIds.join(', ') : 'all/default'}`,
    `Confirmed sessions: ${report.context.confirmedSessions.length}`,
    `Pending confirmation: ${report.context.pendingConfirmation.length}`,
    `Ambiguous proposals: ${report.context.ambiguousProposals.length}`,
    '',
    'Repositories:',
    ...report.sources.map(sourceLine),
    '',
    `Queue: queued=${report.queue.queued.length} running=${report.queue.running.length} blocked=${report.queue.blocked.length} failed=${report.queue.failed.length} recovered=${report.queue.recovered.length}`,
    ...(report.capabilityRuntime ? [
      '',
      'Capability Runtime:',
      `- lifecycle=${report.capabilityRuntime.lifecycle.readiness} initialized=${report.capabilityRuntime.lifecycle.initialized} recovered=${report.capabilityRuntime.lifecycle.recovered.length} failedRecoveries=${report.capabilityRuntime.lifecycle.failedRecoveries.length}`,
      `- active=${report.capabilityRuntime.health.active.length} queued=${report.capabilityRuntime.health.queued.length} failed=${report.capabilityRuntime.health.failed.length} expired=${report.capabilityRuntime.health.expired.length} cancelled=${report.capabilityRuntime.health.cancellationCount}`,
      `- maintenance=${report.capabilityRuntime.maintenance.status} adapters=${report.capabilityRuntime.health.adapterAvailability.length}`,
      ...(report.capabilityRuntime.warnings.length ? report.capabilityRuntime.warnings.map(item => `- warning: ${item}`) : ['- warnings: none'])
    ] : []),
    ...(report.knowledgeRuntime ? [
      '',
      'Knowledge Runtime:',
      `- readiness=${report.knowledgeRuntime.readiness} initialized=${report.knowledgeRuntime.initialized} providers=${report.knowledgeRuntime.providerCount} enabled=${report.knowledgeRuntime.enabledProviders.length} available=${report.knowledgeRuntime.availableProviders.length}`,
      `- retrievalReady=${report.knowledgeRuntime.retrievalReady} retrievalFailures=${report.knowledgeRuntime.retrievalFailures} lastInitialization=${report.knowledgeRuntime.lastInitializedAt} lastRetrieval=${report.knowledgeRuntime.lastSuccessfulRetrievalAt || 'never'}`,
      ...(report.knowledgeRuntime.warnings.length ? report.knowledgeRuntime.warnings.map(item => `- warning: ${item}`) : ['- warnings: none'])
    ] : []),
    ...(report.providerRuntime ? [
      '',
      'Provider Runtime:',
      `- enabled=${report.providerRuntime.ok ? report.providerRuntime.value.enabled.length : 0} unavailable=${report.providerRuntime.ok ? report.providerRuntime.value.unavailable.length : 0}`,
      ...(report.providerRuntime.ok ? Object.entries(report.providerRuntime.value.health).sort(([a], [b]) => a.localeCompare(b)).map(([id, health]) => `- ${id}: ${health}`) : [`- warning: ${'message' in report.providerRuntime ? report.providerRuntime.message : 'unknown error'}`])
    ] : []),
    ...(report.providerActivation ? [
      '',
      'Provider Activation:',
      `- active=${report.providerActivation.activeProviderIds.length} failed=${report.providerActivation.failedActivations.length} blocked=${report.providerActivation.blockedProviderIds.length}`,
      ...(report.providerActivation.recentEvents.length ? report.providerActivation.recentEvents.slice(-8).map(item => `- event: ${item.eventType} provider=${item.providerId}`) : ['- events: none'])
    ] : []),
    '',
    'MCP Context:',
    `- status=${report.mcpContext?.status || 'unavailable'} bridge=${report.mcpContext?.bridge.status || 'unavailable'} activeSessions=${report.mcpContext?.activeSessionIds.length || 0}`,
    `- lifecycle active=${report.mcpContext?.sessionLifecycle.activeCount || 0} idle=${report.mcpContext?.sessionLifecycle.idleCount || 0} expired=${report.mcpContext?.sessionLifecycle.expiredCount || 0} revoked=${report.mcpContext?.sessionLifecycle.revokedCount || 0} upcoming=${report.mcpContext?.sessionLifecycle.upcomingExpirations.length || 0}`,
    `- renewal requested=${report.mcpContext?.renewal.requested || 0} approved=${report.mcpContext?.renewal.approved || 0} denied=${report.mcpContext?.renewal.denied || 0} executed=${report.mcpContext?.renewal.executed || 0} invalid=${report.mcpContext?.renewal.invalidStates || 0}`,
    `- capability grants approved=${report.mcpCapabilities?.grants.approved || 0} denied=${report.mcpCapabilities?.grants.denied || 0} expired=${report.mcpCapabilities?.grants.expired || 0} revoked=${report.mcpCapabilities?.grants.revoked || 0} orphaned=${report.mcpCapabilities?.grants.orphaned || 0} lifetimeViolations=${report.mcpCapabilities?.grants.exceedingSessionLifetime || 0}`,
    `- executions admitted=${report.mcpExecution?.admitted.length || 0} pending=${report.mcpExecution?.pending.length || 0} completed=${report.mcpExecution?.completed.length || 0} denied=${report.mcpExecution?.denied.length || 0} failed=${report.mcpExecution?.failed.length || 0}`,
    `- execution metrics admitted=${report.mcpExecution?.metrics.admitted || 0} rejected=${report.mcpExecution?.metrics.rejected || 0} averageLatencyMs=${report.mcpExecution?.metrics.averageLatencyMs || 0}`,
    `- requests=${report.mcpContext?.metrics.requests || 0} deliveries=${report.mcpContext?.metrics.successfulDeliveries || 0} rejected=${report.mcpContext?.metrics.rejectedRequests || 0} authorizationFailures=${report.mcpContext?.metrics.authorizationFailures || 0}`,
    ...(report.mcpContext?.bridge.recentFailures.length ? report.mcpContext.bridge.recentFailures.slice(-8).map(item => `- failure: ${item.code}`) : ['- recent failures: none']),
    'Last successful indexing:',
    ...Object.keys(report.queue.lastSuccessfulIndexing).sort().map(sourceId => `- ${sourceId}: ${report.queue.lastSuccessfulIndexing[sourceId] || 'never'}`),
    '',
    'Remediation suggestions:',
    ...(report.remediations.length ? remediationLines(report.remediations) : ['- none']),
    '',
    `Exit code: ${doctorExitCode(report)}`
  ]
  return lines.join('\n')
}

export async function doctorCommand(json = false): Promise<number> {
  try {
    const report = getContextIntelligenceDoctorReport()
    process.stdout.write(json ? `${serializeContextIntelligenceDoctorReport(report)}\n` : `${formatDoctorHuman(report)}\n`)
    return doctorExitCode(report)
  } catch (error) {
    process.stderr.write(`Workbench doctor unavailable: ${error instanceof Error ? error.message : String(error)}\n`)
    return DOCTOR_EXIT_CODES.unavailable
  }
}
