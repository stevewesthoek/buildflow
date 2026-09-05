import type { KnowledgeContentAccess } from './knowledge-content.js'
import { KnowledgeIndex } from './knowledge-index.js'
import { KnowledgeIndexStore } from './knowledge-index-store.js'
import { KnowledgeIndexer, type KnowledgeIndexRun } from './knowledge-indexer.js'

export type KnowledgeRefreshResult = KnowledgeIndexRun & { state: 'ready' | 'failed'; reason: string; previousGeneration: number; indexBytes?: number }

export class KnowledgeRefreshEngine {
  constructor(private readonly store: KnowledgeIndexStore, private readonly now: () => string) {}

  async refresh(provider: KnowledgeContentAccess, reason = 'manual'): Promise<KnowledgeRefreshResult> {
    const loaded = this.store.load(provider.identity.providerId)
    let index: KnowledgeIndex | undefined
    if (loaded.ok) index = loaded.value
    else if (loaded.code === 'index_missing') index = new KnowledgeIndex()
    if (!index) throw new Error(`knowledge index unavailable: ${loaded.ok ? 'unknown' : loaded.code}`)
    const previousGeneration = index.status(provider.identity.providerId).generation
    const previousFreshness = index.status(provider.identity.providerId).freshness
    index.setLifecycle(previousGeneration === 0 ? 'indexing' : 'refreshing', { reason, timestamp: this.now() })
    const observed = await provider.observeFreshness()
    if (observed.ok && previousGeneration > 0 && previousFreshness.revision && observed.value.revision && previousFreshness.revision !== observed.value.revision) index.setLifecycle('stale', { reason: 'provider_revision_changed', timestamp: this.now() })
    const preSave = this.store.save(provider.identity.providerId, index, this.now())
    if (!preSave.ok) throw new Error(`knowledge refresh state persistence failed: ${preSave.code}`)
    try {
      const run = await new KnowledgeIndexer(index, { now: this.now }).indexProvider(provider)
      const saved = this.store.save(provider.identity.providerId, index, this.now())
      if (!saved.ok) throw new Error(`knowledge refresh persistence failed: ${saved.code}`)
      return { ...run, state: 'ready', reason, previousGeneration }
    } catch (error) {
      index.setLifecycle('failed', { failure: error instanceof Error ? error.message : 'unknown refresh failure', reason, timestamp: this.now() })
      this.store.save(provider.identity.providerId, index, this.now())
      throw error
    }
  }
}
