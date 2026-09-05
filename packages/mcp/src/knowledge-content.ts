export type KnowledgeProviderIdentity = {
  providerId: string
  providerType: string
  providerVersion: string
}

export type KnowledgeFreshness = {
  strategy: 'revision' | 'timestamp' | 'external' | 'unknown'
  revision?: string
  observedAt: string
}

export type KnowledgeDocumentDescriptor = {
  documentId: string
  title?: string
  mediaType?: string
  sizeBytes?: number
  modifiedAt?: string
  metadata?: Readonly<Record<string, string>>
}

export type KnowledgeContent = {
  documentId: string
  content: string
  contentHash: string
  truncated: boolean
}

export type KnowledgeContentResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: 'not_found' | 'unavailable' | 'invalid_request' | 'too_large'; message: string }

/** Read-only provider boundary. Providers never receive execution authority. */
export interface KnowledgeContentAccess {
  readonly identity: KnowledgeProviderIdentity
  enumerateDocuments(limit: number): Promise<KnowledgeContentResult<KnowledgeDocumentDescriptor[]>>
  getMetadata(documentId: string): Promise<KnowledgeContentResult<KnowledgeDocumentDescriptor>>
  retrieveContent(documentId: string, maxBytes: number): Promise<KnowledgeContentResult<KnowledgeContent>>
  observeFreshness(): Promise<KnowledgeContentResult<KnowledgeFreshness>>
}

export function boundedLimit(value: number, maximum: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= maximum
}
