import type { KnowledgeContent, KnowledgeContentAccess, KnowledgeContentResult, KnowledgeDocumentDescriptor, KnowledgeFreshness, KnowledgeProviderIdentity } from './knowledge-content.js'
import { boundedLimit } from './knowledge-content.js'

export type KnowledgeProviderHealth = { available: boolean; checkedAt: string; message?: string }
export type KnowledgeProviderAdapter = {
  readonly identity: KnowledgeProviderIdentity
  connect(): Promise<KnowledgeContentResult<KnowledgeProviderHealth>>
  enumerateDocuments(limit: number): Promise<KnowledgeContentResult<KnowledgeDocumentDescriptor[]>>
  getMetadata(documentId: string): Promise<KnowledgeContentResult<KnowledgeDocumentDescriptor>>
  retrieveContent(documentId: string, maxBytes: number): Promise<KnowledgeContentResult<KnowledgeContent>>
  observeFreshness(): Promise<KnowledgeContentResult<KnowledgeFreshness>>
}
export type KnowledgeAdapterLimits = { maxDocuments?: number; maxBytes?: number }

export function validateProviderAdapter(adapter: KnowledgeProviderAdapter): { valid: true } | { valid: false; reason: string } {
  if (!adapter.identity.providerId || !adapter.identity.providerType || !adapter.identity.providerVersion) return { valid: false, reason: 'provider_identity_missing' }
  for (const method of ['connect', 'enumerateDocuments', 'getMetadata', 'retrieveContent', 'observeFreshness'] as const) if (typeof adapter[method] !== 'function') return { valid: false, reason: `provider_method_missing:${method}` }
  return { valid: true }
}

export function asContentAccess(adapter: KnowledgeProviderAdapter, limits: KnowledgeAdapterLimits = {}): KnowledgeContentAccess {
  const validation = validateProviderAdapter(adapter)
  if (!validation.valid) throw new Error(validation.reason)
  const maxDocuments = Math.min(limits.maxDocuments ?? 10_000, 10_000)
  const maxBytes = Math.min(limits.maxBytes ?? 8 * 1024 * 1024, 8 * 1024 * 1024)
  return {
    identity: adapter.identity,
    enumerateDocuments: async limit => {
      if (!boundedLimit(limit, maxDocuments)) return { ok: false, code: 'invalid_request', message: 'Document enumeration limit is outside the configured bound.' }
      const result = await adapter.enumerateDocuments(limit)
      if (!result.ok) return result
      return { ok: true, value: [...result.value].sort((a, b) => a.documentId.localeCompare(b.documentId)).slice(0, limit) }
    },
    getMetadata: adapter.getMetadata.bind(adapter),
    retrieveContent: async (documentId, requestedBytes) => {
      if (!boundedLimit(requestedBytes, maxBytes)) return { ok: false, code: 'invalid_request', message: 'Content limit is outside the configured bound.' }
      return adapter.retrieveContent(documentId, requestedBytes)
    },
    observeFreshness: adapter.observeFreshness.bind(adapter),
  }
}
