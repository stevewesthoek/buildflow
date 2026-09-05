import type { KnowledgeContent, KnowledgeContentAccess, KnowledgeDocumentDescriptor, KnowledgeContentResult } from './knowledge-content.js'
import type { KnowledgeDocument } from './knowledge-document.js'
import type { KnowledgeIndex } from './knowledge-index.js'

export type KnowledgeMetadataQuery = { providerId?: string; metadata?: Readonly<Record<string, string>>; limit: number }
export type KnowledgeRetrievalQuery = { providerId?: string; documentId?: string; path?: string; metadata?: Readonly<Record<string, string>>; keywords?: string; limit?: number }
export type KnowledgeRetrievalReason = 'exact-document' | 'exact-path' | 'metadata-match' | 'keyword-match'
export type KnowledgeRetrievalMatch = { document: KnowledgeDocument; score: number; reasons: KnowledgeRetrievalReason[] }
export type KnowledgeContextBudget = { maximumRepositories: number; maximumFiles: number; maximumBytes: number; maximumTokens: number; maximumQueries: number }
export type KnowledgeContextAuthorization = { sessionId?: string; sessionStatus?: 'proposed' | 'confirmed' | 'expired' | 'cleared'; sourceIds: string[] }
export type KnowledgeContextPackageDocument = KnowledgeRetrievalMatch & { content: string; contentHash: string; truncated: boolean; bytes: number }
export type KnowledgeContextPackage = { packageId: string; authorization: { sessionId?: string; sourceIds: string[] }; documents: KnowledgeContextPackageDocument[]; sources: Array<{ providerId: string; freshness: string; indexGeneration: number; freshnessState: 'fresh' | 'stale' | 'unavailable' }>; warnings: string[]; files: number; bytes: number; tokens: number; queries: number }
export type KnowledgeRetrievalDiagnostics = { available: boolean; queryCount: number; latencyMs: number; packageBytes: number; failures: number }

export interface KnowledgeRetrievalBoundary {
  exact(providerId: string, documentId: string): KnowledgeDocument | undefined
  metadata(query: KnowledgeMetadataQuery): KnowledgeDocument[]
  content(providerId: string, documentId: string, maxBytes: number): Promise<KnowledgeContentResult<KnowledgeContent>>
}

export class IndexedKnowledgeRetrieval implements KnowledgeRetrievalBoundary {
  constructor(private readonly index: KnowledgeIndex, private readonly providers: ReadonlyMap<string, KnowledgeContentAccess>) {}

  exact(providerId: string, documentId: string): KnowledgeDocument | undefined { return this.index.get(providerId, documentId) }

  metadata(query: KnowledgeMetadataQuery): KnowledgeDocument[] {
    return this.index.list(query.providerId).filter(document => Object.entries(query.metadata ?? {}).every(([key, value]) => document.metadata[key] === value)).slice(0, query.limit)
  }

  async content(providerId: string, documentId: string, maxBytes: number): Promise<KnowledgeContentResult<KnowledgeContent>> {
    const document = this.exact(providerId, documentId)
    if (!document) return { ok: false, code: 'not_found', message: 'Knowledge document was not indexed.' }
    const provider = this.providers.get(providerId)
    if (!provider) return { ok: false, code: 'unavailable', message: 'Knowledge provider is unavailable.' }
    return provider.retrieveContent(documentId, maxBytes)
  }

  retrieve(query: KnowledgeRetrievalQuery): KnowledgeRetrievalMatch[] {
    const limit = Math.max(1, Math.min(query.limit ?? 20, 500))
    const terms = (query.keywords ?? '').toLocaleLowerCase().split(/\s+/).filter(Boolean)
    return this.index.list(query.providerId).map(document => {
      const reasons: KnowledgeRetrievalReason[] = []
      let score = 0
      if (query.documentId && document.documentId === query.documentId) { score += 1000; reasons.push('exact-document') }
      if (query.path && document.metadata.path === query.path) { score += 900; reasons.push('exact-path') }
      if (query.metadata && Object.entries(query.metadata).every(([key, value]) => document.metadata[key] === value)) { score += 300; reasons.push('metadata-match') }
      const searchable = `${document.documentId} ${Object.values(document.metadata).join(' ')}`.toLocaleLowerCase()
      const matched = terms.filter(term => searchable.includes(term))
      if (terms.length && matched.length) { score += Math.round(100 * matched.length / terms.length); reasons.push('keyword-match') }
      return { document, score, reasons }
    }).filter(match => match.score > 0).sort((a, b) => b.score - a.score || a.document.documentId.localeCompare(b.document.documentId)).slice(0, limit)
  }

  async packageContext(query: KnowledgeRetrievalQuery, authorization: KnowledgeContextAuthorization, budget: KnowledgeContextBudget): Promise<{ ok: true; package: KnowledgeContextPackage; diagnostics: KnowledgeRetrievalDiagnostics } | { ok: false; code: 'authorization_required' | 'source_not_authorized' | 'source_unavailable' | 'budget_exceeded' | 'retrieval_failed'; message: string; diagnostics: KnowledgeRetrievalDiagnostics }> {
    const started = Date.now(); const queryCount = 1
    if (queryCount > budget.maximumQueries || budget.maximumFiles <= 0 || budget.maximumBytes <= 0 || budget.maximumTokens <= 0) return { ok: false, code: 'budget_exceeded', message: 'Context retrieval budget is invalid or exhausted.', diagnostics: { available: true, queryCount, latencyMs: Date.now() - started, packageBytes: 0, failures: 0 } }
    if (authorization.sessionId && authorization.sessionStatus !== 'confirmed') return { ok: false, code: 'authorization_required', message: 'Context packaging requires a confirmed context session.', diagnostics: { available: false, queryCount, latencyMs: Date.now() - started, packageBytes: 0, failures: 1 } }
    const matches = this.retrieve({ ...query, limit: Math.min(query.limit ?? budget.maximumFiles, budget.maximumFiles) }); const providerIds = [...new Set(matches.map(match => match.document.providerId))]
    if (providerIds.length > budget.maximumRepositories) return { ok: false, code: 'budget_exceeded', message: 'Context package exceeds the repository budget.', diagnostics: { available: true, queryCount, latencyMs: Date.now() - started, packageBytes: 0, failures: 0 } }
    for (const providerId of providerIds) if (!authorization.sourceIds.includes(providerId)) return { ok: false, code: 'source_not_authorized', message: `Source "${providerId}" is not authorized by the active context session.`, diagnostics: { available: false, queryCount, latencyMs: Date.now() - started, packageBytes: 0, failures: 1 } }
    const sources: KnowledgeContextPackage['sources'] = []; const warnings: string[] = []; const documents: KnowledgeContextPackageDocument[] = []; let bytes = 0; let tokens = 0
    for (const providerId of providerIds) {
      const provider = this.providers.get(providerId); if (!provider) return { ok: false, code: 'source_unavailable', message: `Knowledge source "${providerId}" is unavailable.`, diagnostics: { available: false, queryCount, latencyMs: Date.now() - started, packageBytes: bytes, failures: 1 } }
      const freshness = await provider.observeFreshness(); if (!freshness.ok) return { ok: false, code: 'source_unavailable', message: `Knowledge source "${providerId}" freshness is unavailable.`, diagnostics: { available: false, queryCount, latencyMs: Date.now() - started, packageBytes: bytes, failures: 1 } }
      const status = this.index.status(providerId); const stale = Boolean(status.freshness.revision && freshness.value.revision && status.freshness.revision !== freshness.value.revision); sources.push({ providerId, freshness: freshness.value.revision ?? freshness.value.strategy, indexGeneration: status.generation, freshnessState: stale ? 'stale' : 'fresh' }); if (stale) warnings.push(`Source "${providerId}" has changed since index generation ${status.generation}.`)
      for (const match of matches.filter(item => item.document.providerId === providerId)) { if (documents.length >= budget.maximumFiles) break; const remaining = budget.maximumBytes - bytes; const remainingTokenBytes = Math.max(1, (budget.maximumTokens - tokens) * 4); if (remaining <= 0 || budget.maximumTokens <= tokens) { warnings.push('Context token or byte budget reached.'); break } const content = await this.content(providerId, match.document.documentId, Math.min(remaining, remainingTokenBytes)); if (!content.ok) return { ok: false, code: 'retrieval_failed', message: `Document "${match.document.documentId}" could not be retrieved.`, diagnostics: { available: false, queryCount, latencyMs: Date.now() - started, packageBytes: bytes, failures: 1 } }; const document = { ...match, content: content.value.content, contentHash: content.value.contentHash, truncated: content.value.truncated, bytes: Buffer.byteLength(content.value.content, 'utf8') }; const documentTokens = Math.ceil(document.bytes / 4); documents.push(document); bytes += document.bytes; tokens += documentTokens }
    }
    const value = { packageId: `knowledge-context-${cryptoHash(JSON.stringify({ authorization, query, documents: documents.map(item => [item.document.providerId, item.document.documentId, item.contentHash]) }))}`, authorization: { ...(authorization.sessionId ? { sessionId: authorization.sessionId } : {}), sourceIds: [...authorization.sourceIds].sort() }, documents, sources, warnings, files: documents.length, bytes, tokens, queries: queryCount } satisfies KnowledgeContextPackage
    return { ok: true, package: value, diagnostics: { available: true, queryCount, latencyMs: Date.now() - started, packageBytes: Buffer.byteLength(JSON.stringify(value), 'utf8'), failures: 0 } }
  }
}

function cryptoHash(value: string): string { let hash = 2166136261; for (const char of value) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619) } return (hash >>> 0).toString(16).padStart(8, '0') }

export function descriptorMatches(document: KnowledgeDocument, descriptor: KnowledgeDocumentDescriptor): boolean {
  return document.documentId === descriptor.documentId
}
