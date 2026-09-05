import path from 'node:path'
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
import { getCapabilityRuntimeDiagnostic, type CapabilityRuntimeDiagnostic } from '../../../mcp/dist/capability-runtime-diagnostics.js'
import { readKnowledgeContextRuntimeStatus, type KnowledgeContextRuntimeStatus } from '../../../mcp/dist/knowledge-context-runtime.js'
import { getMcpContextDiagnostics, type McpContextObservabilityOptions } from './mcp-context-observability'
import { getMcpCapabilityDiagnostics, type McpCapabilityStoreOptions } from './mcp-session-capability-authorization'
import { mcpExecutionDiagnostics, type McpExecutionOptions } from '../../../mcp/dist/mcp-capability-adapter.js'
import { verifyMcpExecutionProvenance } from '../../../mcp/dist/mcp-execution-provenance.js'
import { getMcpContextWorkflowDiagnostics } from './mcp-context-workflow'
import { getProviderRuntimeProjection } from '../../../mcp/dist/provider-onboarding.js'
import { getProviderActivationDiagnostics } from '../../../mcp/dist/provider-activation.js'
import { getCapabilityProviderDiagnostics } from '../../../mcp/dist/capability-provider.js'
import { getMcpCapabilityAdoptionDiagnostics } from '../../../mcp/dist/mcp-capability-adoption.js'
import { getCapabilityEcosystemDiagnostics } from '../../../mcp/dist/capability-ecosystem-diagnostics.js'
import { getCodebaseMemoryProviderDiagnostics } from './cbm-graph-context'

export type DoctorRemediation = { code: string; message: string; automatic: false }
export type DoctorSession = { sessionId: string; clientId: string; ownerId?: string; status: ContextSession['status']; ownershipState?: 'owned' | 'unowned'; sourceIds: string[]; authorityLevel: ContextSession['authorityLevel']; expiresAt?: string; expired: boolean; confirmationRequired: boolean }
export type DoctorSource = { sourceId: string; label: string; path: string; active: boolean; health?: RepositoryHealth; jobs: QueueDiagnosticJob[]; freshnessAutomation?: FreshnessAutomationResult; remediations: DoctorRemediation[] }
export type ContextIntelligenceDoctorReport = {
  schemaVersion: 1
  generatedAt: string
  bounded: { maxSources: number; maxJobs: number; maxSessions: number; maxBytes: number }
  context: { mode: ActiveSourcesMode; activeSourceIds: string[]; confirmedSessions: DoctorSession[]; sessions: DoctorSession[]; ambiguousProposals: string[]; pendingConfirmation: string[] }
  sources: DoctorSource[]
  queue: { queued: QueueDiagnosticJob[]; running: QueueDiagnosticJob[]; stale: QueueDiagnosticJob[]; blocked: QueueDiagnosticJob[]; failed: QueueDiagnosticJob[]; recovered: QueueDiagnosticJob[]; lastSuccessfulIndexing: Record<string, string | undefined> }
  refreshAudit: { pendingApprovals: string[]; recentEvents: number; lastApprovedRefresh: Record<string, string | undefined>; failedRefreshAttempts: string[]; unresolvedStaleSources: string[] }
  knowledgeRefresh?: { pendingProposals: number; approvedProposals: number; activeJobs: number; failedJobs: number; lastSuccessfulRefresh?: string }
  knowledgeContext?: { activePackageId?: string; retrievalAvailable: boolean; packageBytes: number; retrievalLatencyMs: number; staleWarnings: number; failedAttempts: number }
  knowledgeRuntime?: KnowledgeContextRuntimeStatus
  capabilityRuntime?: CapabilityRuntimeDiagnostic
  providerRuntime?: ReturnType<typeof getProviderRuntimeProjection>
  providerActivation?: ReturnType<typeof getProviderActivationDiagnostics>
  capabilityProviders?: ReturnType<typeof getCapabilityProviderDiagnostics>
  capabilityEcosystem?: ReturnType<typeof getCapabilityEcosystemDiagnostics>
  mcpAdoption?: ReturnType<typeof getMcpCapabilityAdoptionDiagnostics>
  mcpContext?: ReturnType<typeof getMcpContextDiagnostics>
  mcpCapabilities?: ReturnType<typeof getMcpCapabilityDiagnostics>
  mcpExecution?: ReturnType<typeof mcpExecutionDiagnostics>
  mcpProvenance?: ReturnType<typeof verifyMcpExecutionProvenance>
  mcpWorkflow?: ReturnType<typeof getMcpContextWorkflowDiagnostics>
  structuralProvider?: ReturnType<typeof getCodebaseMemoryProviderDiagnostics>
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
  knowledgeRefreshLoader?: () => ContextIntelligenceDoctorReport['knowledgeRefresh']
  knowledgeContextLoader?: () => ContextIntelligenceDoctorReport['knowledgeContext']
  knowledgeRuntimeLoader?: () => KnowledgeContextRuntimeStatus | undefined
  mcpObservability?: McpContextObservabilityOptions
  mcpCapabilityAuthorization?: McpCapabilityStoreOptions
  mcpExecution?: McpExecutionOptions
}

function remediation(code: string, message: string): DoctorRemediation { return { code, message, automatic: false } }
function sessionView(session: ContextSession, proposals: ContextProposal[], now: string): DoctorSession {
  const expired = Boolean(session.expiresAt && Date.parse(session.expiresAt) <= Date.parse(now)) || session.status === 'expired'
  const proposal = proposals.find(item => item.sessionId === session.sessionId && item.confirmationState === 'pending')
  return { sessionId: session.sessionId, clientId: session.clientId, ...(session.ownerId ? { ownerId: session.ownerId } : {}), status: expired && session.status === 'confirmed' ? 'expired' : session.status, ownershipState: session.ownerId ? 'owned' : 'unowned', sourceIds: [...session.sourceIds].sort(), authorityLevel: session.authorityLevel, expiresAt: session.expiresAt, expired, confirmationRequired: Boolean(proposal?.confirmationRequired) }
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
    const capabilityRuntime = getCapabilityRuntimeDiagnostic({ rootDir: process.env.WORKBENCH_PROVIDER_STATE_DIR, adapters: [] })
    const providerRuntime = getProviderRuntimeProjection({ rootDir: process.env.WORKBENCH_PROVIDER_STATE_DIR, knowledgeRegistry: { rootDir: process.env.WORKBENCH_PROVIDER_STATE_DIR }, authorizedBy: 'doctor' })
    const providerActivation = getProviderActivationDiagnostics({ rootDir: process.env.WORKBENCH_PROVIDER_STATE_DIR, knowledgeRootDir: process.env.WORKBENCH_PROVIDER_STATE_DIR })
    const capabilityProviders = getCapabilityProviderDiagnostics({ rootDir: process.env.WORKBENCH_PROVIDER_STATE_DIR })
    const capabilityEcosystem = getCapabilityEcosystemDiagnostics({ rootDir: process.env.WORKBENCH_PROVIDER_STATE_DIR })
    const mcpAdoption = getMcpCapabilityAdoptionDiagnostics({ rootDir: process.env.WORKBENCH_PROVIDER_STATE_DIR })
    const knowledgeRefresh = (() => { try { return this.options.knowledgeRefreshLoader?.() } catch { return undefined } })()
    const knowledgeContext = (() => { try { return this.options.knowledgeContextLoader?.() } catch { return undefined } })()
    const knowledgeRuntime = (() => { try { return this.options.knowledgeRuntimeLoader?.() ?? readKnowledgeContextRuntimeStatus({ registry: { rootDir: process.env.WORKBENCH_PROVIDER_STATE_DIR } }) } catch { return undefined } })()
    const mcpContext = getMcpContextDiagnostics(this.options.mcpObservability)
    const mcpCapabilities = getMcpCapabilityDiagnostics(this.options.mcpCapabilityAuthorization)
    const mcpExecution = mcpExecutionDiagnostics(this.options.mcpExecution || { rootDir: process.env.WORKBENCH_PROVIDER_STATE_DIR })
    const mcpProvenance = verifyMcpExecutionProvenance(this.options.mcpExecution || { rootDir: process.env.WORKBENCH_PROVIDER_STATE_DIR })
    const mcpWorkflow = getMcpContextWorkflowDiagnostics()
    const structuralRoot = path.resolve(process.env.WORKBENCH_REPOSITORY_ROOT || process.cwd())
    const structuralSource = sources.find(source => path.resolve(source.path) === structuralRoot)
    const structuralProvider = getCodebaseMemoryProviderDiagnostics({ sourceId: structuralSource?.id || path.basename(structuralRoot), sourceRoot: structuralSource?.path || structuralRoot })
    const report: ContextIntelligenceDoctorReport = { schemaVersion: 1, generatedAt, bounded: { maxSources, maxJobs, maxSessions, maxBytes }, context: { mode: active.mode, activeSourceIds: [...active.activeSourceIds].sort(), confirmedSessions: sessionViews.filter(session => session.status === 'confirmed' && !session.expired), sessions: sessionViews, ambiguousProposals: proposals.filter(proposal => proposal.ambiguityStatus !== 'none').map(proposal => proposal.proposalId).sort(), pendingConfirmation: proposals.filter(proposal => proposal.confirmationState === 'pending' && proposal.confirmationRequired).map(proposal => proposal.proposalId).sort() }, sources: sourceReports, queue: { queued: queue.current.filter(item => item.job.status === 'queued').slice(0, maxJobs), running: queue.current.filter(item => ['claimed', 'observing', 'planned', 'running'].includes(item.job.status)).slice(0, maxJobs), stale: queue.stale.slice(0, maxJobs), blocked: queue.blocked.slice(0, maxJobs), failed: queue.failed.slice(0, maxJobs), recovered: queue.recovered.slice(0, maxJobs), lastSuccessfulIndexing: queue.lastSuccessfulIndexing }, refreshAudit: { pendingApprovals: refreshProposals.filter(proposal => proposal.approvalState === 'pending').map(proposal => proposal.proposalId).sort(), recentEvents: refreshEvents.length, lastApprovedRefresh, failedRefreshAttempts: refreshEvents.filter(event => event.eventType === 'refresh.job.failed').map(event => event.jobId || event.proposalId), unresolvedStaleSources }, ...(knowledgeRefresh ? { knowledgeRefresh } : {}), ...(knowledgeContext ? { knowledgeContext } : {}), ...(knowledgeRuntime ? { knowledgeRuntime } : {}), ...(capabilityRuntime ? { capabilityRuntime } : {}), providerRuntime, providerActivation, capabilityProviders, capabilityEcosystem, mcpAdoption, mcpContext, mcpCapabilities, mcpExecution, mcpProvenance, mcpWorkflow, remediations }
    report.structuralProvider = structuralProvider
    return boundDoctorReport(report, maxBytes)
  }
}

function boundDoctorReport(report: ContextIntelligenceDoctorReport, maxBytes: number): ContextIntelligenceDoctorReport {
  if (Buffer.byteLength(JSON.stringify(report), 'utf8') <= maxBytes) return report
  const reduced = { ...report, sources: report.sources.slice(0, 32).map(source => ({ ...source, jobs: source.jobs.slice(0, 20), remediations: source.remediations.slice(0, 8) })), queue: { ...report.queue, queued: report.queue.queued.slice(0, 20), running: report.queue.running.slice(0, 20), blocked: report.queue.blocked.slice(0, 20), failed: report.queue.failed.slice(0, 20), recovered: report.queue.recovered.slice(0, 20) }, mcpContext: { ...report.mcpContext, activeSessionIds: report.mcpContext?.activeSessionIds.slice(0, 16) || [], sessionLifecycle: report.mcpContext ? { ...report.mcpContext.sessionLifecycle, upcomingExpirations: report.mcpContext.sessionLifecycle.upcomingExpirations.slice(0, 4) } : { activeCount: 0, idleCount: 0, expiredCount: 0, revokedCount: 0, upcomingExpirations: [] }, bridge: report.mcpContext ? { ...report.mcpContext.bridge, recentFailures: report.mcpContext.bridge.recentFailures.slice(-4) } : { status: 'ready' as const, recentFailures: [] } }, mcpExecution: report.mcpExecution ? { ...report.mcpExecution, pending: report.mcpExecution.pending.slice(0, 8), admitted: report.mcpExecution.admitted.slice(-8), completed: report.mcpExecution.completed.slice(-8), failed: report.mcpExecution.failed.slice(-8), denied: report.mcpExecution.denied.slice(-8), cancelled: report.mcpExecution.cancelled.slice(-8), recentErrors: report.mcpExecution.recentErrors.slice(-8), metrics: { ...report.mcpExecution.metrics, capabilityUsage: Object.fromEntries(Object.entries(report.mcpExecution.metrics.capabilityUsage).slice(0, 16)), failureCategories: Object.fromEntries(Object.entries(report.mcpExecution.metrics.failureCategories).slice(0, 16)) } } : undefined }
  if (Buffer.byteLength(JSON.stringify(reduced), 'utf8') <= maxBytes) return reduced
  return { ...reduced, mcpContext: undefined, mcpCapabilities: undefined, mcpExecution: undefined, mcpWorkflow: undefined }
}

export function getContextIntelligenceDoctorReport(options?: ContextIntelligenceDoctorOptions): ContextIntelligenceDoctorReport { return new ContextIntelligenceDoctor(options).report() }
export function serializeContextIntelligenceDoctorReport(report: ContextIntelligenceDoctorReport): string { return JSON.stringify(report) }
