import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createKnowledgeDocument } from '../knowledge-document.js'
import { KnowledgeIndex } from '../knowledge-index.js'
import { KnowledgeIndexStore } from '../knowledge-index-store.js'

function fixture() { const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-knowledge-index-')); return { rootDir, cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true }) } }
function index() { const value = new KnowledgeIndex(); value.register(createKnowledgeDocument({ providerId: 'docs', documentId: 'one', metadata: { kind: 'guide' }, permissions: { visibility: 'workspace', principalIds: [] }, contentHash: 'hash' }, '2026-01-01T00:00:00.000Z')); value.commitGeneration({ strategy: 'revision', revision: 'r1', observedAt: '2026-01-01T00:00:00.000Z' }, '2026-01-01T00:00:00.000Z'); return value }

test('persists atomically and reloads after restart', () => { const f = fixture(); try { const store = new KnowledgeIndexStore({ rootDir: f.rootDir }); assert.equal(store.save('docs', index(), '2026-01-01T00:00:00.000Z').ok, true); const loaded = store.load('docs'); assert.equal(loaded.ok, true); if (loaded.ok) assert.deepEqual(loaded.value.snapshot(), index().snapshot()) } finally { f.cleanup() } })
test('fails closed for corruption, migration, and storage bounds', () => { const f = fixture(); try { const store = new KnowledgeIndexStore({ rootDir: f.rootDir, maxBytes: 20 }); const bounded = store.save('docs', index(), '2026-01-01T00:00:00.000Z'); assert.equal(bounded.ok, false); if (!bounded.ok) assert.equal(bounded.code, 'index_too_large'); const normal = new KnowledgeIndexStore({ rootDir: f.rootDir }); fs.mkdirSync(f.rootDir, { recursive: true }); fs.writeFileSync(normal.filePath('docs'), JSON.stringify({ schemaVersion: 99, providerId: 'docs', snapshot: {} })); const migration = normal.load('docs'); assert.equal(migration.ok, false); if (!migration.ok) assert.equal(migration.code, 'migration_required'); fs.writeFileSync(normal.filePath('docs'), '{not-json'); const corrupt = normal.load('docs'); assert.equal(corrupt.ok, false); if (!corrupt.ok) assert.equal(corrupt.code, 'index_corrupt') } finally { f.cleanup() } })
