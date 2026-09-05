import assert from 'node:assert/strict'
import test from 'node:test'
import type { KnowledgeContentAccess } from '../knowledge-content.js'
import { KnowledgeIndex } from '../knowledge-index.js'
import { KnowledgeIndexer } from '../knowledge-indexer.js'

test('enumerates metadata deterministically, removes missing documents, and commits a generation', async () => {
  const index = new KnowledgeIndex()
  const provider: KnowledgeContentAccess = {
    identity: { providerId: 'docs', providerType: 'generic', providerVersion: '1' },
    enumerateDocuments: async () => ({ ok: true, value: [{ documentId: 'b', metadata: { kind: 'guide' } }, { documentId: 'a', metadata: { kind: 'reference' } }] }),
    getMetadata: async () => ({ ok: false, code: 'not_found', message: 'unused' }),
    retrieveContent: async () => ({ ok: false, code: 'unavailable', message: 'unused' }),
    observeFreshness: async () => ({ ok: true, value: { strategy: 'revision', revision: 'r1', observedAt: '2026-01-01T00:00:00.000Z' } }),
  }
  const run = await new KnowledgeIndexer(index, { now: () => '2026-01-01T00:00:00.000Z' }).indexProvider(provider)
  assert.deepEqual(run, { providerId: 'docs', generation: 1, registered: 2, removed: 0, failed: 0, added: 2, modified: 0, unchanged: 0, freshness: 'r1' })
  assert.deepEqual(index.list('docs').map(item => item.documentId), ['a', 'b'])
})
