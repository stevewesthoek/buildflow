import type { KnowledgeSource, ActiveSourcesMode } from '@workbench/shared'
import { getActiveSourceContext } from './config'
import { listContextProposals, listContextSessions, type ContextIntelligenceStoreOptions } from './context-intelligence-store'
import type { ContextBudget, ContextProposal, ContextSession, RepositoryHealth } from './context-intelligence-models'
import { evaluateFreshnessAutomation, type FreshnessAutomationResult } from './freshness-automation'
import { observeRepositoryHealth, type RepositoryHealthObserverOptions } from './repository-health-observer'
import { collectIndexQueueDiagnostics, type QueueDiagnosticJob, type QueueDiagnosticsOptions } from './index-queue-observability'
import type { IndexLifecycleStoreOptions } from './index-lifecycle-store'
import type { QueueHistoryStoreOptions } from './index-queue-observability'
import { listRefreshAuditEvents, listRefreshProposals, type RefreshAuditStoreOptions } from './freshness-automation'

export type DoctorRemediation = { code: string; message: string; automatic: false }
export type DoctorSession = { sessionId: string; clientId: string; status: ContextSession['status']; sourceIds: string[]; authorityLevel: ContextSession['authorityLevel']; expiresAt?: string; expired: boolean; confirmationRequired: boolean }
export type DoctorSource = { sourceId: string; label: string; path: string; active: boolean; health?: RepositoryHealth; jobs: QueueDiagnosticJob[]; freshnessAutomation?: FreshnessAutomationResult; remediations: DoctorRemediation[] }
export type ContextIntelligenceDoctorReport = {
  schemaVersion: 1
  generatedAt: string
  bounded: { maxSources: number; maxJobs: number; maxSessions: number; maxBytes: number }
  context: { mode: ActiveSourcesMode; activeSourceIds: string[]; confirmedSessions: DoctorSession[]; sessions: DoctorSession[]; ambiguousProposals: string[]; pendingConfirmation: string[] }
  sources: DoctorSource[]
  queue: { queued: QueueDiagnosticJob[]; running: QueueDiagnosticJob[]; stale: QueueDiagnosticJob[]; blocked: QueueDiagnosticJob[]; failed: QueueDiagnosticJob[]; recovered: QueueDiagnosticJob[]; lastSuccessfulIndexing: Record<string, string | undefined> }
  refreshAudit: { pendingApprovals: string[]; recentEvents: number; lastApprovedRefresh: Record<string, string | undefined>; failedRefreshAttempts: string[]; unresolvedStaleSources: string[] }
  remediations: DoctorRemediation[]
}
export type ContextIntelligenceDoctorOptions = {
  sources?: KnowledgeSource[]
  sourceLoader?: () => KnowledgeSource[]
  activeContextLoader?: () => { mode: ActiveSourcesMode; activeSourceIds: string[] }
  contextStore?: ContextIntelligenceStoreOptions
  observer?: Omit<RepositoryHealthObserverOptions, 'sources' | 'sourceLoader'>
  indexStore?: IndexLifecycleStoreOptions
  historyStore?: QueueHistoryStoreOptions
  now?: () => Date
  maxSources?: number
  maxJobs?: number
  maxSessions?: number
  maxBytes?: number
  contextBudget?: ContextBudget
  refreshStore?: RefreshAuditStoreOptions
}

function remediation(code: string, message: string): DoctorRemediation { return { code, message, automatic: false } }
function sessionView(session: ContextSession, proposals: ContextProposal[], now: string): DoctorSession {
  const expired = Boolean(session.expiresAt && Date.parse(session.expiresAt) <= Date.parse(now)) || session.status === 'expired'
  const proposal = proposals.find(item => item.sessionId === session.sessionId && item.confirmationState === 'pending')
  return { sessionId: session.sessionId, clientId: session.clientId, status: expired && session.status === 'confirmed' ? 'expired' : session.status, sourceIds: [...session.sourceIds].sort(), authorityLevel: session.authorityLevel, expiresAt: session.expiresAt, expired, confirmationRequired: Boolean(proposal?.confirmationRequired) }
}

export class ContextIntelligenceDoctor {
  constructor(private readonly options: ContextIntelligenceDoctorOptions = {}) {}
  report(): ContextIntelligenceDoctorReport {
    const maxSources = Math.max(1, Math.min(this.options.maxSources || 64, 256))
    const maxJobs = Math.max(1, Math.min(this.options.maxJobs || 500, 2_000))
    const maxSessions = Math.max(1, Math.min(this.options.maxSessions || 200, 2_000))
    const maxBytes = Math.max(4_000, Math.min(this.options.maxBytes || 32_000, 128_000))
    const generatedAt = (this.options.now || (() => new Date()))().toISOString()
    let sources: KnowledgeSource[] = []
    try { sources = (this.options.sources ? [...this.options.sources] : this.options.sourceLoader?.() || getActiveSourceContext({ refreshGitMetadata: false }).sources).slice(0, maxSources) } catch { sources = [] }
    const active = (() => { try { return this.options.activeContextLoader?.() || getActiveSourceContext({ refreshGitMetadata: false }) } catch { return { mode: 'all' as const, activeSourceIds: [] } } })()
    const sessions = listContextSessions(this.options.contextStore).slice(0, maxSessions)
    const proposalResult = listContextProposals(undefined, this.options.contextStore)
    const proposals = Array.isArray(proposalResult) ? proposalResult : []
    const sessionViews = sessions.map(session => sessionView(session, proposals, generatedAt))
    const queue = collectIndexQueueDiagnostics({ sources, observer: this.options.observer, indexStore: this.options.indexStore, historyStore: this.options.historyStore, now: this.options.now })
    const refreshProposals = listRefreshProposals(this.options.refreshStore)
    const refreshEvents = listRefreshAuditEvents(this.options.refreshStore)
    const jobs = queue.sources.flatMap(item => [item])
    const sourceReports = sources.map(source => {
      const observed = observeRepositoryHealth(source.id, { ...this.options.observer, now: this.options.observer?.now || this.options.now, sources, sourceLoader: () => sources })
      const health = observed.health
      const sourceJobs = jobs.filter(item => item.job.sourceId === source.id).slice(0, maxJobs)
      const confirmedSession = sessionViews.find(session => session.status === 'confirmed' && !session.expired && session.sourceIds.includes(source.id))
      const automation = health ? evaluateFreshnessAutomation({ health, session: confirmedSession ? sessions.find(session => session.sessionId === confirmedSession.sessionId) : undefined, jobs: sourceJobs.map(item => item.job), budget: this.options.contextBudget || { schemaVersion: 1, maximumRepositories: 1, maximumFiles: 5_000, maximumBytes: 10_000_000, maximumQueries: 20 }, now: this.options.now }) : undefined
      const remediations: DoctorRemediation[] = []
      if (!health || health.runtimeAvailability === 'unavailable') remediations.push(remediation('source_unavailable', 'Source unavailable; check repository path.'))
      else if (health.freshnessState === 'stale_revision' || health.freshnessState === 'stale_worktree' || health.freshnessState === 'fresh_with_uncommitted_changes') remediations.push(remediation('refresh_recommended', 'Repository changed since last index; incremental refresh recommended.'))
      if (sourceJobs.some(item => item.job.status === 'failed')) remediations.push(remediation('manual_intervention_required', 'Index failed after retry limit; manual intervention required.'))
      if (sessionViews.some(session => session.expired && session.sourceIds.includes(source.id))) remediations.push(remediation('session_expired', 'Context session expired; confirmation required.'))
      if (automation && automation.decision !== 'fresh') remediations.push(remediation(`freshness_${automation.decision}`, automation.guidance))
      return { sourceId: source.id, label: source.label, path: source.path, active: active.activeSourceIds.length === 0 || active.activeSourceIds.includes(source.id), health, jobs: sourceJobs, freshnessAutomation: automation, remediations }
    }).sort((a, b) => a.sourceId.localeCompare(b.sourceId))
    const remediations = Array.from(new Map(sourceReports.flatMap(source => source.remediations).map(item => [item.code, item])).values()).sort((a, b) => a.code.localeCompare(b.code))
    const lastApprovedRefresh: Record<string, string | undefined> = {}
    for (const event of refreshEvents.filter(event => event.eventType === 'proposal.approved')) lastApprovedRefresh[event.sourceId] = event.occurredAt
    const unresolvedStaleSources = sourceReports.filter(source => source.freshnessAutomation && source.freshnessAutomation.decision !== 'fresh' && !refreshProposals.some(proposal => proposal.sourceId === source.sourceId && ['approved', 'executed'].includes(proposal.approvalState))).map(source => source.sourceId)
    const report: ContextIntelligenceDoctorReport = { schemaVersion: 1, generatedAt, bounded: { maxSources, maxJobs, maxSessions, maxBytes }, context: { mode: active.mode, activeSourceIds: [...active.activeSourceIds].sort(), confirmedSessions: sessionViews.filter(session => session.status === 'confirmed' && !session.expired), sessions: sessionViews, ambiguousProposals: proposals.filter(proposal => proposal.ambiguityStatus !== 'none').map(proposal => proposal.proposalId).sort(), pendingConfirmation: proposals.filter(proposal => proposal.confirmationState === 'pending' && proposal.confirmationRequired).map(proposal => proposal.proposalId).sort() }, sources: sourceReports, queue: { queued: queue.current.filter(item => item.job.status === 'queued').slice(0, maxJobs), running: queue.current.filter(item => ['claimed', 'observing', 'planned', 'running'].includes(item.job.status)).slice(0, maxJobs), stale: queue.stale.slice(0, maxJobs), blocked: queue.blocked.slice(0, maxJobs), failed: queue.failed.slice(0, maxJobs), recovered: queue.recovered.slice(0, maxJobs), lastSuccessfulIndexing: queue.lastSuccessfulIndexing }, refreshAudit: { pendingApprovals: refreshProposals.filter(proposal => proposal.approvalState === 'pending').map(proposal => proposal.proposalId).sort(), recentEvents: refreshEvents.length, lastApprovedRefresh, failedRefreshAttempts: refreshEvents.filter(event => event.eventType === 'refresh.job.failed').map(event => event.jobId || event.proposalId), unresolvedStaleSources }, remediations }
    return boundDoctorReport(report, maxBytes)
  }
}

function boundDoctorReport(report: ContextIntelligenceDoctorReport, maxBytes: number): ContextIntelligenceDoctorReport {
  if (Buffer.byteLength(JSON.stringify(report), 'utf8') <= maxBytes) return report
  const reduced = { ...report, sources: report.sources.slice(0, 32).map(source => ({ ...source, jobs: source.jobs.slice(0, 20), remediations: source.remediations.slice(0, 8) })), queue: { ...report.queue, queued: report.queue.queued.slice(0, 20), running: report.queue.running.slice(0, 20), blocked: report.queue.blocked.slice(0, 20), failed: report.queue.failed.slice(0, 20), recovered: report.queue.recovered.slice(0, 20) } }
  return reduced
}

export function getContextIntelligenceDoctorReport(options?: ContextIntelligenceDoctorOptions): ContextIntelligenceDoctorReport { return new ContextIntelligenceDoctor(options).report() }
export function serializeContextIntelligenceDoctorReport(report: ContextIntelligenceDoctorReport): string { return JSON.stringify(report) }
