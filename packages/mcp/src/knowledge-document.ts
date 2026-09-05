import crypto from 'node:crypto'

export type KnowledgeIndexState = 'unindexed' | 'indexed' | 'stale' | 'failed' | 'removed'

export type KnowledgePermissions = {
  visibility: 'private' | 'workspace' | 'organization' | 'public'
  principalIds: string[]
}

export type KnowledgeDocument = {
  providerId: string
  documentId: string
  metadata: Readonly<Record<string, string>>
  contentHash?: string
  createdAt: string
  updatedAt: string
  indexedAt?: string
  indexState: KnowledgeIndexState
  permissions: KnowledgePermissions
}

export type KnowledgeDocumentInput = Omit<KnowledgeDocument, 'createdAt' | 'updatedAt' | 'indexState'> & {
  createdAt?: string
  updatedAt?: string
  indexState?: KnowledgeIndexState
}

export function contentHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex')
}

export function createKnowledgeDocument(input: KnowledgeDocumentInput, now: string): KnowledgeDocument {
  if (!input.providerId || !input.documentId || !Number.isFinite(Date.parse(now))) throw new Error('invalid knowledge document')
  return {
    ...input,
    metadata: { ...input.metadata },
    permissions: { ...input.permissions, principalIds: [...input.permissions.principalIds] },
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
    indexState: input.indexState ?? 'unindexed',
  }
}
