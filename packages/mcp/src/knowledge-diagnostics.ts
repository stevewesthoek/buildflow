import type { KnowledgeIndex } from './knowledge-index.js'
import type { KnowledgeProvider } from './knowledge-provider.js'
import type { KnowledgeRefreshApprovalStore } from './knowledge-refresh-approval.js'
import type { KnowledgeRefreshExecutionRecord, KnowledgeRefreshProposal } from './knowledge-refresh-store.js'
import type { KnowledgeRefreshOwnershipRecord } from './knowledge-refresh-ownership.js'
import type { KnowledgeRetrievalDiagnostics } from './knowledge-retrieval.js'

type KnowledgeRuntimeDiagnostics = { ownerId?: string; leaseExpiresAt?: string; ownershipState?: KnowledgeRefreshOwnershipRecord['state']; ownershipHistory: number; interruptedExecutions: number; shutdownState?: 'running' | 'draining' | 'stopped' | 'failed' }
export type KnowledgeDiagnostics = {
  observedAt: string
  runtime?: KnowledgeRuntimeDiagnostics
  retrieval?: KnowledgeRetrievalDiagnostics
  providers: Array<{ providerId: string; status: string; documentCount: number; indexGeneration: number; indexSizeBytes: number; freshness: string; freshnessScore: number; failures: number; lifecycle: string; refreshTimestamp?: string; refreshHistory: number; pendingApprovals: number; approvedProposals: number; activeRefreshJobs: number; failedRefreshes: number; lastSuccessfulRefresh?: string; staleReason?: string }>
}

export function collectKnowledgeDiagnostics(providers: readonly KnowledgeProvider[], index: KnowledgeIndex, observedAt: string, approvals?: KnowledgeRefreshApprovalStore, durableProposals?: readonly KnowledgeRefreshProposal[], executions: readonly KnowledgeRefreshExecutionRecord[] = [], ownership?: KnowledgeRefreshOwnershipRecord, shutdownState?: KnowledgeRuntimeDiagnostics['shutdownState'], retrieval?: KnowledgeRetrievalDiagnostics): KnowledgeDiagnostics {
  return {
    observedAt,
    ...(ownership || shutdownState ? { runtime: { ...(ownership ? { ownerId: ownership.ownerId, leaseExpiresAt: ownership.leaseExpiresAt, ownershipState: ownership.state, ownershipHistory: ownership.events.length } : { ownershipHistory: 0 }), interruptedExecutions: executions.filter(item => item.state === 'running' && Boolean(item.leaseExpiresAt)).length, ...(shutdownState ? { shutdownState } : {}) } } : {}),
    ...(retrieval ? { retrieval: { ...retrieval } } : {}),
    providers: [...providers].sort((a, b) => a.providerId.localeCompare(b.providerId)).map(provider => {
      const status = index.status(provider.providerId)
      const events = approvals?.events.filter(event => event.providerId === provider.providerId) ?? []
      const pendingApprovals = [...(approvals?.plans.values() ?? [])].filter(plan => plan.providerId === provider.providerId && plan.approvalState === 'pending').length
      const pendingDurable = (durableProposals ?? []).filter(plan => plan.providerId === provider.providerId && plan.approvalState === 'pending').length
      const approvedProposals = (durableProposals ?? []).filter(plan => plan.providerId === provider.providerId && plan.approvalState === 'approved').length
      const activeRefreshJobs = executions.filter(item => item.providerId === provider.providerId && ['queued', 'running'].includes(item.state)).length
      const successful = [...events].reverse().find(event => event.eventType === 'refresh.scheduled')
      return { providerId: provider.providerId, status: provider.health, documentCount: status.documents, indexGeneration: status.generation, indexSizeBytes: status.indexSizeBytes, freshness: status.freshness.revision ?? status.freshness.strategy, freshnessScore: status.freshnessScore, failures: status.failed, lifecycle: status.lifecycle, refreshTimestamp: status.refreshTimestamp, refreshHistory: status.refreshHistory.length, pendingApprovals: pendingApprovals + pendingDurable, approvedProposals, activeRefreshJobs, failedRefreshes: events.filter(event => event.eventType === 'refresh.failed').length + executions.filter(item => item.providerId === provider.providerId && item.state === 'failed').length, ...(successful ? { lastSuccessfulRefresh: successful.occurredAt } : {}), ...(status.staleReason ? { staleReason: status.staleReason } : {}) }
    }),
  }
}
