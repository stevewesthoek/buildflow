import assert from 'node:assert/strict'
import test from 'node:test'
import { KnowledgeIndex } from '../knowledge-index.js'
import { createKnowledgeDocument } from '../knowledge-document.js'
import { IndexedKnowledgeRetrieval } from '../knowledge-retrieval.js'
import type { KnowledgeContentAccess } from '../knowledge-content.js'

test('supports exact lookup, bounded metadata search, and provider content retrieval', async () => {
  const index = new KnowledgeIndex()
  index.register(createKnowledgeDocument({ providerId: 'docs', documentId: 'one', metadata: { topic: 'guide' }, permissions: { visibility: 'workspace', principalIds: [] } }, '2026-01-01T00:00:00.000Z'))
  const provider: KnowledgeContentAccess = { identity: { providerId: 'docs', providerType: 'generic', providerVersion: '1' }, enumerateDocuments: async () => ({ ok: true, value: [] }), getMetadata: async () => ({ ok: false, code: 'not_found', message: 'unused' }), retrieveContent: async (_id, maxBytes) => ({ ok: true, value: { documentId: 'one', content: 'bounded', contentHash: 'hash', truncated: maxBytes < 7 } }), observeFreshness: async () => ({ ok: true, value: { strategy: 'revision', revision: 'r1', observedAt: '2026-01-01T00:00:00.000Z' } }) }
  const retrieval = new IndexedKnowledgeRetrieval(index, new Map([['docs', provider]]))
  assert.equal(retrieval.exact('docs', 'one')?.documentId, 'one')
  assert.deepEqual(retrieval.metadata({ metadata: { topic: 'guide' }, limit: 1 }).map(item => item.documentId), ['one'])
  assert.equal((await retrieval.content('docs', 'one', 100)).ok, true)
  const missing = await retrieval.content('docs', 'missing', 100)
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.equal(missing.code, 'not_found')
})

test('ranks exact, path, metadata, and keyword matches deterministically', () => {
  const index = new KnowledgeIndex()
  index.register(createKnowledgeDocument({ providerId: 'docs', documentId: 'guides/auth.md', metadata: { path: 'guides/auth.md', topic: 'authentication' }, permissions: { visibility: 'workspace', principalIds: [] } }, '2026-01-01T00:00:00.000Z'))
  index.register(createKnowledgeDocument({ providerId: 'docs', documentId: 'notes/auth.txt', metadata: { path: 'notes/auth.txt', topic: 'authentication' }, permissions: { visibility: 'workspace', principalIds: [] } }, '2026-01-01T00:00:00.000Z'))
  const retrieval = new IndexedKnowledgeRetrieval(index, new Map())
  const exact = retrieval.retrieve({ documentId: 'guides/auth.md', limit: 2 }); assert.equal(exact[0]?.document.documentId, 'guides/auth.md'); assert.deepEqual(exact[0]?.reasons, ['exact-document'])
  const first = retrieval.retrieve({ keywords: 'authentication', limit: 2 }); const second = retrieval.retrieve({ keywords: 'authentication', limit: 2 }); assert.deepEqual(first, second); assert.equal(first[0]?.reasons.includes('keyword-match'), true)
  const metadata = retrieval.retrieve({ metadata: { topic: 'authentication' }, limit: 1 }); assert.equal(metadata.length, 1); assert.equal(metadata[0]?.reasons.includes('metadata-match'), true)
})

test('packages confirmed context with freshness warnings and bounded bytes', async () => {
  const index = new KnowledgeIndex(); index.register(createKnowledgeDocument({ providerId: 'docs', documentId: 'one', metadata: { path: 'one.txt', topic: 'guide' }, permissions: { visibility: 'workspace', principalIds: [] } }, '2026-01-01T00:00:00.000Z')); index.commitGeneration({ strategy: 'revision', revision: 'old', observedAt: '2026-01-01T00:00:00.000Z' }, '2026-01-01T00:00:00.000Z')
  const provider: KnowledgeContentAccess = { identity: { providerId: 'docs', providerType: 'generic', providerVersion: '1' }, enumerateDocuments: async () => ({ ok: true, value: [] }), getMetadata: async () => ({ ok: false, code: 'not_found', message: 'unused' }), retrieveContent: async () => ({ ok: true, value: { documentId: 'one', content: 'bounded content', contentHash: 'hash', truncated: false } }), observeFreshness: async () => ({ ok: true, value: { strategy: 'revision', revision: 'new', observedAt: '2026-01-01T00:00:01.000Z' } }) }
  const retrieval = new IndexedKnowledgeRetrieval(index, new Map([['docs', provider]])); const result = await retrieval.packageContext({ documentId: 'one' }, { sessionId: 'session-1', sessionStatus: 'confirmed', sourceIds: ['docs'] }, { maximumRepositories: 1, maximumFiles: 1, maximumBytes: 100, maximumTokens: 25, maximumQueries: 1 }); assert.equal(result.ok, true)
  if (result.ok) { assert.equal(result.package.files, 1); assert.equal(result.package.documents[0]?.content, 'bounded content'); assert.equal(result.package.sources[0]?.freshnessState, 'stale'); assert.equal(result.package.warnings.length, 1); assert.equal(result.diagnostics.failures, 0) }
})

test('fails closed for unconfirmed, unauthorized, unavailable, and over-budget context requests', async () => {
  const index = new KnowledgeIndex(); index.register(createKnowledgeDocument({ providerId: 'docs', documentId: 'one', metadata: { path: 'one.txt' }, permissions: { visibility: 'private', principalIds: [] } }, '2026-01-01T00:00:00.000Z'))
  const provider: KnowledgeContentAccess = { identity: { providerId: 'docs', providerType: 'generic', providerVersion: '1' }, enumerateDocuments: async () => ({ ok: true, value: [] }), getMetadata: async () => ({ ok: false, code: 'not_found', message: 'unused' }), retrieveContent: async () => ({ ok: false, code: 'unavailable', message: 'offline' }), observeFreshness: async () => ({ ok: false, code: 'unavailable', message: 'offline' }) }
  const retrieval = new IndexedKnowledgeRetrieval(index, new Map([['docs', provider]])); const base = { documentId: 'one' }
  assert.equal((await retrieval.packageContext(base, { sessionId: 's', sessionStatus: 'proposed', sourceIds: ['docs'] }, { maximumRepositories: 1, maximumFiles: 1, maximumBytes: 100, maximumTokens: 25, maximumQueries: 1 })).ok, false)
  const unauthorized = await retrieval.packageContext(base, { sessionId: 's', sessionStatus: 'confirmed', sourceIds: [] }, { maximumRepositories: 1, maximumFiles: 1, maximumBytes: 100, maximumTokens: 25, maximumQueries: 1 }); assert.equal(unauthorized.ok, false); if (!unauthorized.ok) assert.equal(unauthorized.code, 'source_not_authorized')
  const unavailable = await retrieval.packageContext(base, { sessionId: 's', sessionStatus: 'confirmed', sourceIds: ['docs'] }, { maximumRepositories: 1, maximumFiles: 1, maximumBytes: 100, maximumTokens: 25, maximumQueries: 1 }); assert.equal(unavailable.ok, false); if (!unavailable.ok) assert.equal(unavailable.code, 'source_unavailable')
  const budget = await retrieval.packageContext(base, { sessionId: 's', sessionStatus: 'confirmed', sourceIds: ['docs'] }, { maximumRepositories: 1, maximumFiles: 0, maximumBytes: 100, maximumTokens: 25, maximumQueries: 1 }); assert.equal(budget.ok, false); if (!budget.ok) assert.equal(budget.code, 'budget_exceeded')
})
