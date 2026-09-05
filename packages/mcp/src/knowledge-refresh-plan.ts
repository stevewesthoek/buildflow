import type { KnowledgeFreshness } from './knowledge-content.js'
import type { KnowledgeIndex } from './knowledge-index.js'

export type KnowledgeRefreshPlan = {
  planId: string
  providerId: string
  indexIdentity: string
  currentRevision?: string
  observedRevision?: string
  changeEstimate: { added: number; modified: number; removed: number; unchanged: number; bounded: boolean }
  affectedDocuments: string[]
  reason: string
  freshnessImpact: 'none' | 'stale' | 'unavailable'
  observedAt: string
  approvalState: 'pending' | 'approved' | 'rejected' | 'expired' | 'invalidated'
}

export function createRefreshPlan(index: KnowledgeIndex, providerId: string, observed: KnowledgeFreshness, estimate: KnowledgeRefreshPlan['changeEstimate'], affectedDocuments: string[], reason: string, observedAt: string, planId: string): KnowledgeRefreshPlan {
  const status = index.status(providerId)
  return { planId, providerId, indexIdentity: `${providerId}:${status.generation}`, currentRevision: status.freshness.revision, observedRevision: observed.revision, changeEstimate: { ...estimate, bounded: true }, affectedDocuments: [...new Set(affectedDocuments)].sort(), reason, freshnessImpact: observed.strategy === 'unknown' ? 'unavailable' : status.freshness.revision && observed.revision && status.freshness.revision !== observed.revision ? 'stale' : 'none', observedAt, approvalState: 'pending' }
}
