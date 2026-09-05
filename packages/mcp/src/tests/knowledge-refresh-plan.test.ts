import assert from 'node:assert/strict'
import test from 'node:test'
import { KnowledgeIndex } from '../knowledge-index.js'
import { createRefreshPlan } from '../knowledge-refresh-plan.js'

test('creates deterministic revision-aware refresh plans', () => { const index = new KnowledgeIndex(); const input = { strategy: 'revision' as const, revision: 'r2', observedAt: '2026-01-01T00:00:00.000Z' }; const first = createRefreshPlan(index, 'docs', input, { added: 1, modified: 2, removed: 0, unchanged: 3, bounded: false }, ['z', 'a', 'a'], 'revision_changed', input.observedAt, 'plan-1'); const second = createRefreshPlan(index, 'docs', input, { added: 1, modified: 2, removed: 0, unchanged: 3, bounded: false }, ['a', 'z'], 'revision_changed', input.observedAt, 'plan-1'); assert.deepEqual(first, second); assert.deepEqual(first.affectedDocuments, ['a', 'z']); assert.equal(first.changeEstimate.bounded, true) })
