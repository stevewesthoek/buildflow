import type { KnowledgeContentAccess } from './knowledge-content.js'
import { createKnowledgeDocument } from './knowledge-document.js'
import type { KnowledgeIndex } from './knowledge-index.js'

export type KnowledgeIndexRun = {
  providerId: string
  generation: number
  registered: number
  removed: number
  failed: number
  added: number
  modified: number
  unchanged: number
  freshness: string
}

export type KnowledgeIndexerOptions = {
  now: () => string
  maxDocuments?: number
}

/** Deterministic metadata indexer. It never executes provider capabilities. */
export class KnowledgeIndexer {
  constructor(private readonly index: KnowledgeIndex, private readonly options: KnowledgeIndexerOptions) {}

  async indexProvider(provider: KnowledgeContentAccess): Promise<KnowledgeIndexRun> {
    const limit = Math.min(this.options.maxDocuments ?? 10_000, 10_000)
    const freshness = await provider.observeFreshness()
    if (!freshness.ok) throw new Error(`knowledge freshness observation failed: ${freshness.code}`)
    const enumeration = await provider.enumerateDocuments(limit)
    if (!enumeration.ok) throw new Error(`knowledge enumeration failed: ${enumeration.code}`)
    const descriptors = [...enumeration.value].sort((a, b) => a.documentId.localeCompare(b.documentId)).slice(0, limit)
    const existing = new Set(this.index.list(provider.identity.providerId).map(document => document.documentId))
    let registered = 0
    let failed = 0
    let added = 0
    let modified = 0
    let unchanged = 0
    for (const descriptor of descriptors) {
      if (!descriptor.documentId) { failed += 1; continue }
      const current = this.index.get(provider.identity.providerId, descriptor.documentId)
      const metadata = { ...(descriptor.metadata ?? {}), ...(descriptor.title ? { title: descriptor.title } : {}), ...(descriptor.mediaType ? { mediaType: descriptor.mediaType } : {}) }
      if (current && JSON.stringify(current.metadata) === JSON.stringify(metadata) && current.updatedAt === (descriptor.modifiedAt ?? current.updatedAt)) { unchanged += 1; existing.delete(descriptor.documentId); continue }
      const document = createKnowledgeDocument({
        providerId: provider.identity.providerId,
        documentId: descriptor.documentId,
        metadata,
        permissions: { visibility: 'private', principalIds: [] },
        contentHash: current?.contentHash,
        createdAt: current?.createdAt,
        updatedAt: descriptor.modifiedAt ?? this.options.now(),
        indexState: 'indexed',
      }, this.options.now())
      if (current) { this.index.update(document); modified += 1 } else { this.index.register(document); added += 1 }
      existing.delete(descriptor.documentId)
      registered += 1
    }
    let removed = 0
    for (const documentId of existing) if (this.index.remove(provider.identity.providerId, documentId)) removed += 1
    const generation = this.index.commitGeneration(freshness.value, this.options.now())
    return { providerId: provider.identity.providerId, generation: generation.generation, registered, removed, failed, added, modified, unchanged, freshness: freshness.value.revision ?? freshness.value.strategy }
  }
}
