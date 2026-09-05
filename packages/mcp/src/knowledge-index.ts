import type { KnowledgeFreshness } from './knowledge-content.js'
import type { KnowledgeDocument, KnowledgeIndexState } from './knowledge-document.js'

export type KnowledgeIndexGeneration = {
  generation: number
  createdAt: string
  freshness: KnowledgeFreshness
  documentCount: number
}

export type KnowledgeIndexStatus = {
  providerId: string
  generation: number
  documents: number
  indexed: number
  stale: number
  failed: number
  freshness: KnowledgeFreshness
  lifecycle: KnowledgeIndexLifecycle
  lastFailure?: string
  refreshReason?: string
  refreshTimestamp?: string
  indexSizeBytes: number
  refreshHistory: KnowledgeRefreshRecord[]
  freshnessScore: number
  staleReason?: string
}

export type KnowledgeIndexLifecycle = 'created' | 'indexing' | 'ready' | 'stale' | 'refreshing' | 'failed' | 'unavailable'

export type KnowledgeIndexSnapshot = {
  documents: KnowledgeDocument[]
  generations: KnowledgeIndexGeneration[]
  freshness: KnowledgeFreshness
  lifecycle: KnowledgeIndexLifecycle
  lastFailure?: string
  refreshReason?: string
  refreshTimestamp?: string
  refreshHistory: KnowledgeRefreshRecord[]
  staleReason?: string
}

export type KnowledgeRefreshRecord = { generation: number; state: KnowledgeIndexLifecycle; reason?: string; timestamp: string; failure?: string }

export class KnowledgeIndex {
  private readonly documents = new Map<string, KnowledgeDocument>()
  private readonly generations: KnowledgeIndexGeneration[] = []
  private currentFreshness: KnowledgeFreshness = { strategy: 'unknown', observedAt: new Date(0).toISOString() }
  private lifecycle: KnowledgeIndexLifecycle = 'created'
  private lastFailure?: string
  private refreshReason?: string
  private refreshTimestamp?: string
  private refreshHistory: KnowledgeRefreshRecord[] = []
  private staleReason?: string

  register(document: KnowledgeDocument): KnowledgeDocument {
    this.documents.set(this.key(document.providerId, document.documentId), clone(document))
    return clone(document)
  }

  update(document: KnowledgeDocument): KnowledgeDocument {
    if (!this.documents.has(this.key(document.providerId, document.documentId))) throw new Error('knowledge document is not registered')
    return this.register(document)
  }

  remove(providerId: string, documentId: string): boolean {
    const document = this.documents.get(this.key(providerId, documentId))
    if (!document) return false
    document.indexState = 'removed'
    this.documents.set(this.key(providerId, documentId), document)
    return true
  }

  get(providerId: string, documentId: string): KnowledgeDocument | undefined {
    const document = this.documents.get(this.key(providerId, documentId))
    return document ? clone(document) : undefined
  }

  list(providerId?: string): KnowledgeDocument[] {
    return [...this.documents.values()]
      .filter(document => providerId === undefined || document.providerId === providerId)
      .sort((a, b) => `${a.providerId}:${a.documentId}`.localeCompare(`${b.providerId}:${b.documentId}`))
      .map(clone)
  }

  markState(providerId: string, documentId: string, state: KnowledgeIndexState, indexedAt?: string): boolean {
    const document = this.documents.get(this.key(providerId, documentId))
    if (!document) return false
    document.indexState = state
    if (indexedAt) document.indexedAt = indexedAt
    return true
  }

  commitGeneration(freshness: KnowledgeFreshness, createdAt: string): KnowledgeIndexGeneration {
    this.currentFreshness = { ...freshness }
    const generation: KnowledgeIndexGeneration = { generation: this.generations.length + 1, createdAt, freshness: { ...freshness }, documentCount: this.documents.size }
    this.generations.push(generation)
    this.lifecycle = 'ready'
    this.lastFailure = undefined
    this.refreshTimestamp = createdAt
    this.refreshHistory.push({ generation: generation.generation, state: 'ready', timestamp: createdAt, ...(this.refreshReason ? { reason: this.refreshReason } : {}) })
    return { ...generation, freshness: { ...generation.freshness } }
  }

  status(providerId: string): KnowledgeIndexStatus {
    const documents = this.list(providerId)
    return {
      providerId,
      generation: this.generations.at(-1)?.generation ?? 0,
      documents: documents.length,
      indexed: documents.filter(item => item.indexState === 'indexed').length,
      stale: documents.filter(item => item.indexState === 'stale').length,
      failed: documents.filter(item => item.indexState === 'failed').length,
      freshness: { ...this.currentFreshness },
      lifecycle: this.lifecycle,
      ...(this.lastFailure ? { lastFailure: this.lastFailure } : {}),
      ...(this.refreshReason ? { refreshReason: this.refreshReason } : {}),
      ...(this.refreshTimestamp ? { refreshTimestamp: this.refreshTimestamp } : {}),
      indexSizeBytes: Buffer.byteLength(JSON.stringify(this.snapshot()), 'utf8'),
      refreshHistory: [...this.refreshHistory],
      freshnessScore: this.lifecycle === 'ready' ? 100 : this.lifecycle === 'stale' ? 50 : 0,
      ...(this.staleReason ? { staleReason: this.staleReason } : {}),
    }
  }

  setLifecycle(lifecycle: KnowledgeIndexLifecycle, details?: { failure?: string; reason?: string; timestamp?: string }): void {
    this.lifecycle = lifecycle
    this.lastFailure = details?.failure
    this.refreshReason = details?.reason
    this.refreshTimestamp = details?.timestamp ?? this.refreshTimestamp
    this.staleReason = lifecycle === 'stale' ? details?.reason : undefined
    if (details?.timestamp) this.refreshHistory.push({ generation: this.generations.at(-1)?.generation ?? 0, state: lifecycle, timestamp: details.timestamp, ...(details.reason ? { reason: details.reason } : {}), ...(details.failure ? { failure: details.failure } : {}) })
  }

  snapshot(): KnowledgeIndexSnapshot {
    return { documents: this.list(), generations: this.generations.map(generation => ({ ...generation, freshness: { ...generation.freshness } })), freshness: { ...this.currentFreshness }, lifecycle: this.lifecycle, ...(this.lastFailure ? { lastFailure: this.lastFailure } : {}), ...(this.refreshReason ? { refreshReason: this.refreshReason } : {}), ...(this.refreshTimestamp ? { refreshTimestamp: this.refreshTimestamp } : {}), refreshHistory: [...this.refreshHistory], ...(this.staleReason ? { staleReason: this.staleReason } : {}) }
  }

  static fromSnapshot(snapshot: KnowledgeIndexSnapshot): KnowledgeIndex {
    const index = new KnowledgeIndex()
    for (const document of snapshot.documents) index.register(document)
    index.generations.push(...snapshot.generations.map(generation => ({ ...generation, freshness: { ...generation.freshness } })))
    index.currentFreshness = { ...snapshot.freshness }
    index.lifecycle = snapshot.lifecycle
    index.lastFailure = snapshot.lastFailure
    index.refreshReason = snapshot.refreshReason
    index.refreshTimestamp = snapshot.refreshTimestamp
    index.refreshHistory = [...snapshot.refreshHistory]
    index.staleReason = snapshot.staleReason
    return index
  }

  private key(providerId: string, documentId: string): string { return `${providerId}\u0000${documentId}` }
}

function clone(document: KnowledgeDocument): KnowledgeDocument {
  return { ...document, metadata: { ...document.metadata }, permissions: { ...document.permissions, principalIds: [...document.permissions.principalIds] } }
}
