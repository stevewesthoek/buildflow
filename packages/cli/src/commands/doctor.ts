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
