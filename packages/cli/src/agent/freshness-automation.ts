import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { ContextBudget, ContextSession, RepositoryHealth, IndexJob } from './context-intelligence-models'
import { isContextSession } from './context-intelligence-models'
import { getConfigDir } from '../utils/paths'
import type { IndexLifecycleStoreOptions } from './index-lifecycle-store'
import { type QueueEnqueueInput, type QueueResult, type IndexQueueCoordinator } from './index-queue-coordinator'

export type FreshnessAutomationDecision = 'fresh' | 'refresh_recommended' | 'refresh_required' | 'blocked' | 'unavailable'
export type RefreshProposalApproval = 'pending' | 'approved' | 'rejected' | 'expired' | 'executed'
export type RefreshProposal = { schemaVersion: 1; proposalId: string; sourceId: string; sessionId?: string; reason: string; currentRevision?: string; indexedRevision?: string; freshnessState: RepositoryHealth['freshnessState']; recommendedAction: 'reuse' | 'incremental' | 'full' | 'manual_intervention'; estimatedImpact: { files: number; bytes: number; queries: number }; expiresAt: string; approvalState: RefreshProposalApproval; createdAt: string; approvedAt?: string; executedAt?: string }
export type FreshnessAutomationResult = { decision: FreshnessAutomationDecision; sourceId: string; reason: string; guidance: string; proposalRequired: boolean; recommendedAction: RefreshProposal['recommendedAction']; proposal?: RefreshProposal }
export type FreshnessAutomationInput = { health: RepositoryHealth; session?: ContextSession; jobs?: IndexJob[]; budget: ContextBudget; taskRequiresFresh?: boolean; now?: () => Date }
export type RefreshProposalStoreOptions = IndexLifecycleStoreOptions & { maxProposals?: number }
const FILE_NAME = 'refresh-proposals.json'
export type RefreshAuditEventType = 'proposal.created' | 'proposal.viewed' | 'proposal.approved' | 'proposal.rejected' | 'approval.expired' | 'refresh.job.created' | 'refresh.job.completed' | 'refresh.job.failed' | 'refresh.cancelled'
export type RefreshAuditEvent = { eventId: string; eventType: RefreshAuditEventType; sourceId: string; proposalId: string; sessionId?: string; actor?: string; occurredAt: string; jobId?: string; outcome?: string; failureCode?: string }
export type RefreshAuditStoreOptions = RefreshProposalStoreOptions & { maxAuditEvents?: number }
const AUDIT_FILE_NAME = 'refresh-audit.json'
function filePath(options?: RefreshProposalStoreOptions): string { return path.join(options?.rootDir ? path.resolve(options.rootDir) : getConfigDir(), FILE_NAME) }
function read(options?: RefreshProposalStoreOptions): RefreshProposal[] { try { const value = JSON.parse(fs.readFileSync(filePath(options), 'utf8')) as unknown; return Array.isArray(value) ? value as RefreshProposal[] : [] } catch { return [] } }
function write(items: RefreshProposal[], options?: RefreshProposalStoreOptions): void { const target = filePath(options); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); const tmp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`; fs.writeFileSync(tmp, JSON.stringify(items.slice(-(options?.maxProposals || 500))), { encoding: 'utf8', mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, target) }
function auditPath(options?: RefreshAuditStoreOptions): string { return path.join(options?.rootDir ? path.resolve(options.rootDir) : getConfigDir(), AUDIT_FILE_NAME) }
function readAudit(options?: RefreshAuditStoreOptions): RefreshAuditEvent[] { try { const value = JSON.parse(fs.readFileSync(auditPath(options), 'utf8')) as unknown; return Array.isArray(value) ? value as RefreshAuditEvent[] : [] } catch { return [] } }
function writeAudit(items: RefreshAuditEvent[], options?: RefreshAuditStoreOptions): void { const target = auditPath(options); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); const tmp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`; fs.writeFileSync(tmp, JSON.stringify(items.slice(-(options?.maxAuditEvents || 2_000))), { encoding: 'utf8', mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, target) }
function audit(event: Omit<RefreshAuditEvent, 'eventId'>, options?: RefreshAuditStoreOptions): RefreshAuditEvent { const next = { ...event, eventId: `refresh-audit-${crypto.randomUUID()}` }; writeAudit([...readAudit(options), next], options); return next }
function now(input: { now?: () => Date }): string { return (input.now || (() => new Date()))().toISOString() }
function activeSession(input: FreshnessAutomationInput): boolean { return Boolean(input.session && isContextSession(input.session) && input.session.status === 'confirmed' && input.session.sourceIds.includes(input.health.sourceId) && (!input.session.expiresAt || Date.parse(input.session.expiresAt) > Date.parse(now(input)))) }

export function evaluateFreshnessAutomation(input: FreshnessAutomationInput): FreshnessAutomationResult {
  const health = input.health
  if (!health || health.runtimeAvailability !== 'available' || ['unavailable', 'unknown'].includes(health.freshnessState)) return { decision: 'unavailable', sourceId: health?.sourceId || 'unknown-source', reason: 'repository_unavailable', guidance: 'Refresh blocked because source is unavailable.', proposalRequired: false, recommendedAction: 'manual_intervention' }
  if (input.budget.maximumRepositories < 1 || input.budget.maximumFiles < 1 || input.budget.maximumBytes < 1 || input.budget.maximumQueries < 1) return { decision: 'blocked', sourceId: health.sourceId, reason: 'context_budget_exhausted', guidance: 'Refresh blocked because the context budget cannot admit a repository refresh.', proposalRequired: false, recommendedAction: 'manual_intervention' }
  if (!activeSession(input)) return { decision: 'blocked', sourceId: health.sourceId, reason: 'confirmation_required', guidance: 'Context is stale; confirmation required before refresh.', proposalRequired: true, recommendedAction: 'incremental' }
  if (health.freshnessState === 'fresh') return { decision: 'fresh', sourceId: health.sourceId, reason: 'fresh', guidance: 'Repository context is fresh; no refresh is needed.', proposalRequired: false, recommendedAction: 'reuse' }
  const required = input.taskRequiresFresh === true || ['failed', 'stale_revision'].includes(health.freshnessState)
  const action = health.indexedRevision ? 'incremental' : 'full'
  return { decision: required ? 'refresh_required' : 'refresh_recommended', sourceId: health.sourceId, reason: health.freshnessState, guidance: required ? 'Context is stale and task preparation requires refreshed index.' : 'Repository HEAD changed since last index. Incremental refresh recommended.', proposalRequired: true, recommendedAction: action }
}

export function createRefreshProposal(input: FreshnessAutomationInput, storeOptions?: RefreshProposalStoreOptions): { ok: true; proposal: RefreshProposal } | { ok: false; code: string; message: string } {
  const decision = evaluateFreshnessAutomation(input)
  if (!decision.proposalRequired) return { ok: false, code: decision.reason, message: decision.guidance }
  const createdAt = now(input)
  const proposal: RefreshProposal = { schemaVersion: 1, proposalId: `refresh-proposal-${crypto.randomUUID()}`, sourceId: input.health.sourceId, sessionId: input.session?.sessionId, reason: decision.reason, currentRevision: input.health.observedRevision, indexedRevision: input.health.indexedRevision, freshnessState: input.health.freshnessState, recommendedAction: decision.recommendedAction, estimatedImpact: { files: Math.min(input.budget.maximumFiles, input.health.trackedChangedFileCount + input.health.untrackedFileCount), bytes: input.budget.maximumBytes, queries: Math.min(input.budget.maximumQueries, 1) }, expiresAt: new Date(Date.parse(createdAt) + 30 * 60_000).toISOString(), approvalState: 'pending', createdAt }
  write([...read(storeOptions), proposal], storeOptions)
  audit({ eventType: 'proposal.created', sourceId: proposal.sourceId, proposalId: proposal.proposalId, sessionId: proposal.sessionId, occurredAt: createdAt, outcome: 'pending' }, storeOptions)
  return { ok: true, proposal }
}
export function listRefreshProposals(options?: RefreshProposalStoreOptions): RefreshProposal[] { return read(options).sort((a, b) => a.createdAt.localeCompare(b.createdAt)) }
export function getRefreshProposal(proposalId: string, options?: RefreshProposalStoreOptions): RefreshProposal | undefined { const proposal = read(options).find(item => item.proposalId === proposalId); if (proposal) audit({ eventType: 'proposal.viewed', sourceId: proposal.sourceId, proposalId: proposal.proposalId, sessionId: proposal.sessionId, occurredAt: new Date().toISOString(), outcome: proposal.approvalState }, options); return proposal }
export function listRefreshAuditEvents(options?: RefreshAuditStoreOptions): RefreshAuditEvent[] { return readAudit(options).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.eventId.localeCompare(b.eventId)) }
export function auditRefreshExecutionEvent(eventType: 'refresh.job.completed' | 'refresh.job.failed' | 'refresh.cancelled', job: IndexJob, outcome: string, options?: RefreshAuditStoreOptions): RefreshAuditEvent | undefined {
  if (!job.proposalId) return undefined
  return audit({ eventType, sourceId: job.sourceId, proposalId: job.proposalId, sessionId: job.contextSessionId, occurredAt: new Date().toISOString(), jobId: job.jobId, outcome, failureCode: eventType === 'refresh.job.failed' ? outcome : undefined }, options)
}
export function approveRefreshProposal(proposalId: string, confirmed: boolean, options?: RefreshProposalStoreOptions, nowFn?: () => Date): { ok: true; proposal: RefreshProposal } | { ok: false; code: string; message: string } {
  const items = read(options); const index = items.findIndex(item => item.proposalId === proposalId); if (index < 0) return { ok: false, code: 'proposal_missing', message: 'Refresh proposal was not found.' }
  const proposal = items[index]; const current = (nowFn || options?.now || (() => new Date()))().toISOString(); if (Date.parse(proposal.expiresAt) <= Date.parse(current)) { proposal.approvalState = 'expired'; write(items, options); audit({ eventType: 'approval.expired', sourceId: proposal.sourceId, proposalId: proposal.proposalId, sessionId: proposal.sessionId, occurredAt: current, outcome: 'expired' }, options); return { ok: false, code: 'proposal_expired', message: 'Refresh proposal has expired.' } }
  if (!confirmed) { audit({ eventType: 'proposal.rejected', sourceId: proposal.sourceId, proposalId: proposal.proposalId, sessionId: proposal.sessionId, occurredAt: current, outcome: 'confirmation_required' }, options); return { ok: false, code: 'confirmation_required', message: 'Explicit confirmation is required before refresh.' } }
  if (proposal.approvalState !== 'pending') return { ok: false, code: 'invalid_transition', message: `Refresh proposal is ${proposal.approvalState}.` }
  proposal.approvalState = 'approved'; proposal.approvedAt = current; write(items, options); audit({ eventType: 'proposal.approved', sourceId: proposal.sourceId, proposalId: proposal.proposalId, sessionId: proposal.sessionId, occurredAt: current, outcome: 'approved' }, options); return { ok: true, proposal }
}
export function approveAndCreateIndexJob(proposalId: string, confirmed: boolean, coordinator: IndexQueueCoordinator, options?: RefreshProposalStoreOptions): QueueResult | { ok: false; code: string; message: string } {
  const approval = approveRefreshProposal(proposalId, confirmed, options); if (!('proposal' in approval)) return approval
  const proposal = approval.proposal
  const input: QueueEnqueueInput = { sourceId: proposal.sourceId, proposalId: proposal.proposalId, contextSessionId: proposal.sessionId, operation: proposal.recommendedAction === 'full' ? 'full' : 'incremental', mode: proposal.recommendedAction === 'full' ? 'full' : 'incremental', priority: 'interactive', reason: proposal.reason, changedPaths: [] }
  const result = coordinator.enqueue(input)
  if (result.ok) { proposal.approvalState = 'executed'; proposal.executedAt = new Date().toISOString(); write([...read(options).filter(item => item.proposalId !== proposal.proposalId), proposal], options); audit({ eventType: 'refresh.job.created', sourceId: proposal.sourceId, proposalId: proposal.proposalId, sessionId: proposal.sessionId, occurredAt: proposal.executedAt, jobId: result.job.jobId, outcome: 'queued' }, options) }
  return result
}
