import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { FilesystemKnowledgeProvider, createFilesystemKnowledgeManifest } from '../filesystem-knowledge-provider.js'
import { KnowledgeIndex } from '../knowledge-index.js'
import { KnowledgeIndexStore } from '../knowledge-index-store.js'
import { KnowledgeRefreshEngine } from '../knowledge-refresh.js'
import { collectKnowledgeDiagnostics } from '../knowledge-diagnostics.js'
import { registerKnowledgeProvider, transitionKnowledgeProvider, updateKnowledgeProviderHealth } from '../knowledge-provider.js'

test('registers and discovers bounded filesystem documents without exposing content', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-filesystem-provider-'))
  try {
    await fs.mkdir(path.join(root, 'nested'))
    await fs.writeFile(path.join(root, 'README.md'), '# local')
    await fs.writeFile(path.join(root, 'nested', 'data.json'), '{}')
    const options = { rootPath: root, providerId: 'filesystem.docs', now: () => new Date('2026-01-01T00:00:00.000Z') }
    const provider = new FilesystemKnowledgeProvider(options)
    const connected = await provider.connect(); assert.equal(connected.ok, true); if (connected.ok) assert.equal(connected.value.available, true)
    const documents = await provider.enumerateDocuments(10); assert.equal(documents.ok, true); if (documents.ok) assert.deepEqual(documents.value.map(item => item.documentId), ['nested/data.json', 'README.md'])
    const metadata = await provider.getMetadata('README.md'); assert.equal(metadata.ok, true); if (metadata.ok) { assert.equal(metadata.value.mediaType, 'text/markdown'); assert.equal(metadata.value.metadata?.path, 'README.md') }
    const content = await provider.retrieveContent('README.md', 100); assert.equal(content.ok, true); if (content.ok) assert.equal(content.value.content, '# local')
    const manifest = createFilesystemKnowledgeManifest(options, 'test', new Date('2026-01-01T00:00:00.000Z')); const registered = registerKnowledgeProvider(manifest, 'test', { rootDir: path.join(root, '.registry') }); assert.equal(registered.ok, true); assert.equal(transitionKnowledgeProvider('filesystem.docs', 'enabled', { rootDir: path.join(root, '.registry') }).ok, true)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('fails closed for unavailable roots and invalid or escaping document identities', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-filesystem-provider-')); const missing = path.join(root, 'missing')
  try {
    const provider = new FilesystemKnowledgeProvider({ rootPath: missing, providerId: 'filesystem.missing' }); const health = await provider.connect(); assert.equal(health.ok, true); if (health.ok) assert.equal(health.value.available, false); const documents = await provider.enumerateDocuments(10); assert.equal(documents.ok, false); if (!documents.ok) assert.equal(documents.code, 'unavailable')
    const available = new FilesystemKnowledgeProvider({ rootPath: root, providerId: 'filesystem.safe' }); const invalid = await available.getMetadata('../outside'); assert.equal(invalid.ok, false); if (!invalid.ok) assert.equal(invalid.code, 'invalid_request')
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('reports a configured file path as unavailable instead of treating it as a source root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-filesystem-permission-')); const file = path.join(root, 'not-a-root.txt')
  try { await fs.writeFile(file, 'not a directory'); const provider = new FilesystemKnowledgeProvider({ rootPath: file, providerId: 'filesystem.file-root' }); const health = await provider.connect(); assert.equal(health.ok, true); if (health.ok) { assert.equal(health.value.available, false); assert.match(health.value.message ?? '', /directory/) } } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('refresh integration observes added, modified, and removed filesystem documents', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-filesystem-refresh-')); const state = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-filesystem-index-state-'))
  try {
    await fs.writeFile(path.join(root, 'a.txt'), 'a'); await fs.writeFile(path.join(root, 'b.txt'), 'b')
    const provider = new FilesystemKnowledgeProvider({ rootPath: root, providerId: 'filesystem.refresh', now: () => new Date('2026-01-01T00:00:00.000Z') }); const store = new KnowledgeIndexStore({ rootDir: state }); const engine = new KnowledgeRefreshEngine(store, () => '2026-01-01T00:00:00.000Z')
    const first = await engine.refresh(provider); assert.equal(first.added, 2); assert.equal(first.removed, 0)
    await fs.rm(path.join(root, 'b.txt')); await fs.writeFile(path.join(root, 'a.txt'), 'changed'); await fs.writeFile(path.join(root, 'c.txt'), 'c'); await fs.utimes(path.join(root, 'a.txt'), new Date('2026-01-01T00:00:02.000Z'), new Date('2026-01-01T00:00:02.000Z'))
    const second = await engine.refresh(provider, 'filesystem-change'); assert.equal(second.added, 1); assert.equal(second.modified, 1); assert.equal(second.removed, 1); assert.equal(second.generation, 2)
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(state, { recursive: true, force: true }) }
})

test('filesystem diagnostics report location and counts without document content', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-filesystem-diagnostics-'))
  try { await fs.writeFile(path.join(root, 'note.txt'), 'secret-content'); const options = { rootPath: root, providerId: 'filesystem.diag', now: () => new Date('2026-01-01T00:00:00.000Z') }; const provider = new FilesystemKnowledgeProvider(options); const providerDiagnostics = await provider.diagnostics(); assert.equal(providerDiagnostics.available, true); assert.equal(providerDiagnostics.location, root); assert.equal(providerDiagnostics.discoveredDocumentCount, 1); const manifest = createFilesystemKnowledgeManifest(options); const registered = { ...manifest, health: 'healthy' as const, lifecycle: 'enabled' as const, lastCheckedAt: '2026-01-01T00:00:00.000Z', auditIdentity: { registeredAt: '2026-01-01T00:00:00.000Z', registeredBy: 'test' } }; const diagnostics = collectKnowledgeDiagnostics([registered], new KnowledgeIndex(), '2026-01-01T00:00:00.000Z'); const encoded = JSON.stringify({ providerDiagnostics, diagnostics }); assert.match(encoded, /filesystem\.diag/); assert.doesNotMatch(encoded, /secret-content/) } finally { await fs.rm(root, { recursive: true, force: true }) }
})
