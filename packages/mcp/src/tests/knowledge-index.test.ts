import assert from 'node:assert/strict'
import test from 'node:test'
import { KnowledgeIndex } from '../knowledge-index.js'
import { createKnowledgeDocument } from '../knowledge-document.js'

const document = (id: string, state: 'unindexed' | 'indexed' = 'unindexed') => createKnowledgeDocument({ providerId: 'docs', documentId: id, metadata: { topic: id }, permissions: { visibility: 'workspace', principalIds: [] }, indexState: state }, '2026-01-01T00:00:00.000Z')

test('registers, updates, removes, and deterministically lists documents', () => {
  const index = new KnowledgeIndex()
  index.register(document('b'))
  index.register(document('a', 'indexed'))
  assert.deepEqual(index.list('docs').map(item => item.documentId), ['a', 'b'])
  assert.equal(index.update({ ...document('a'), indexState: 'stale' }).indexState, 'stale')
  assert.equal(index.remove('docs', 'b'), true)
  assert.equal(index.get('docs', 'b')?.indexState, 'removed')
})

test('commits generations and reports freshness and counts', () => {
  const index = new KnowledgeIndex()
  index.register(document('a', 'indexed'))
  index.commitGeneration({ strategy: 'revision', revision: 'r1', observedAt: '2026-01-01T00:00:00.000Z' }, '2026-01-01T00:00:00.000Z')
  const status = index.status('docs')
  assert.equal(status.lifecycle, 'ready')
  assert.equal(status.freshnessScore, 100)
  assert.equal(status.indexSizeBytes > 0, true)
  assert.equal(status.refreshHistory.length, 1)
})
