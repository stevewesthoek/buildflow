import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { KnowledgeContent, KnowledgeContentResult, KnowledgeDocumentDescriptor, KnowledgeFreshness, KnowledgeProviderIdentity } from './knowledge-content.js'
import type { KnowledgeProviderAdapter, KnowledgeProviderHealth } from './knowledge-provider-adapter.js'
import type { KnowledgeManifest } from './knowledge-provider.js'

export type FilesystemKnowledgeProviderOptions = {
  rootPath: string
  providerId: string
  providerVersion?: string
  maxDocuments?: number
  maxBytes?: number
  maxDepth?: number
  ignoreNames?: readonly string[]
  now?: () => Date
}
export type FilesystemKnowledgeDiagnostics = { providerId: string; location: string; available: boolean; discoveredDocumentCount: number; freshness?: string; checkedAt: string; failure?: string }

const MAX_DOCUMENTS = 10_000
const MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_IGNORES = new Set(['.git', 'node_modules', '.workbench-provider-state'])
const MEDIA_TYPES: Record<string, string> = { '.json': 'application/json', '.md': 'text/markdown', '.markdown': 'text/markdown', '.txt': 'text/plain', '.csv': 'text/csv', '.html': 'text/html', '.htm': 'text/html', '.xml': 'application/xml', '.yaml': 'application/yaml', '.yml': 'application/yaml', '.js': 'text/javascript', '.ts': 'text/typescript' }

function bounded(value: number, max: number): number { return Math.max(1, Math.min(Number.isInteger(value) ? value : max, max)) }
function iso(value: Date): string { return value.toISOString() }
function relative(root: string, file: string): string { return path.relative(root, file).split(path.sep).join('/') }
function descriptorPath(root: string, documentId: string): string { return path.resolve(root, ...documentId.split('/')) }

export class FilesystemKnowledgeProvider implements KnowledgeProviderAdapter {
  readonly identity: KnowledgeProviderIdentity
  private readonly root: string
  private readonly now: () => Date
  private readonly maxDocuments: number
  private readonly maxBytes: number
  private readonly maxDepth: number
  private readonly ignores: Set<string>
  private canonicalRoot?: string

  constructor(private readonly options: FilesystemKnowledgeProviderOptions) {
    this.root = path.resolve(options.rootPath)
    this.identity = { providerId: options.providerId, providerType: 'filesystem', providerVersion: options.providerVersion ?? '1' }
    this.now = options.now ?? (() => new Date())
    this.maxDocuments = bounded(options.maxDocuments ?? MAX_DOCUMENTS, MAX_DOCUMENTS)
    this.maxBytes = bounded(options.maxBytes ?? MAX_BYTES, MAX_BYTES)
    this.maxDepth = Math.max(0, Math.min(Number.isInteger(options.maxDepth) ? options.maxDepth! : 32, 64))
    this.ignores = new Set([...DEFAULT_IGNORES, ...(options.ignoreNames ?? [])])
  }

  async connect(): Promise<KnowledgeContentResult<KnowledgeProviderHealth>> {
    try { const stat = await fs.stat(this.root); if (!stat.isDirectory()) return { ok: true, value: { available: false, checkedAt: iso(this.now()), message: 'Configured filesystem root is not a directory.' } }; this.canonicalRoot = await fs.realpath(this.root); return { ok: true, value: { available: true, checkedAt: iso(this.now()) } } } catch { return { ok: true, value: { available: false, checkedAt: iso(this.now()), message: 'Configured filesystem root is unavailable.' } } }
  }

  async enumerateDocuments(limit: number): Promise<KnowledgeContentResult<KnowledgeDocumentDescriptor[]>> {
    if (!Number.isInteger(limit) || limit <= 0 || limit > this.maxDocuments) return { ok: false, code: 'invalid_request', message: 'Document limit is outside the configured bound.' }
    const root = await this.safeRoot(); if (!root.ok) return root
    const found: KnowledgeDocumentDescriptor[] = []
    try { await this.walk(root.value, root.value, 0, found, limit); return { ok: true, value: found.sort((a, b) => a.documentId.localeCompare(b.documentId)) } } catch { return { ok: false, code: 'unavailable', message: 'Filesystem enumeration failed safely.' } }
  }

  async getMetadata(documentId: string): Promise<KnowledgeContentResult<KnowledgeDocumentDescriptor>> { const file = await this.safeDocument(documentId); if (!file.ok) return file; try { const stat = await fs.stat(file.value.path); if (!stat.isFile()) return { ok: false, code: 'not_found', message: 'Filesystem document was not found.' }; return { ok: true, value: this.toDescriptor(file.value.root, file.value.path, stat) } } catch { return { ok: false, code: 'unavailable', message: 'Filesystem metadata is unavailable.' } } }

  async retrieveContent(documentId: string, maxBytes: number): Promise<KnowledgeContentResult<KnowledgeContent>> { if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > this.maxBytes) return { ok: false, code: 'invalid_request', message: 'Content limit is outside the configured bound.' }; const file = await this.safeDocument(documentId); if (!file.ok) return file; try { const stat = await fs.stat(file.value.path); if (!stat.isFile()) return { ok: false, code: 'not_found', message: 'Filesystem document was not found.' }; if (stat.size > maxBytes) { const handle = await fs.open(file.value.path, 'r'); try { const buffer = Buffer.alloc(maxBytes); const read = await handle.read(buffer, 0, maxBytes, 0); const content = buffer.subarray(0, read.bytesRead).toString('utf8'); return { ok: true, value: { documentId, content, contentHash: crypto.createHash('sha256').update(content).digest('hex'), truncated: true } } } finally { await handle.close() } } const content = await fs.readFile(file.value.path, 'utf8'); return { ok: true, value: { documentId, content, contentHash: crypto.createHash('sha256').update(content).digest('hex'), truncated: false } } } catch { return { ok: false, code: 'unavailable', message: 'Filesystem document content is unavailable.' } } }

  async observeFreshness(): Promise<KnowledgeContentResult<KnowledgeFreshness>> { const root = await this.safeRoot(); if (!root.ok) return root; const documents = await this.enumerateDocuments(this.maxDocuments); if (!documents.ok) return documents; const parts: string[] = []; for (const document of documents.value) parts.push(`${document.documentId}\0${document.sizeBytes ?? 0}\0${document.modifiedAt ?? ''}`); const revision = crypto.createHash('sha256').update(parts.join('\n')).digest('hex'); return { ok: true, value: { strategy: 'revision', revision, observedAt: iso(this.now()) } } }
  async diagnostics(): Promise<FilesystemKnowledgeDiagnostics> { const checkedAt = iso(this.now()); const health = await this.connect(); if (!health.ok || !health.value.available) return { providerId: this.identity.providerId, location: this.root, available: false, discoveredDocumentCount: 0, checkedAt, failure: health.ok ? health.value.message : health.message }; const documents = await this.enumerateDocuments(this.maxDocuments); if (!documents.ok) return { providerId: this.identity.providerId, location: this.root, available: false, discoveredDocumentCount: 0, checkedAt, failure: documents.message }; const freshness = await this.observeFreshness(); return { providerId: this.identity.providerId, location: this.root, available: true, discoveredDocumentCount: documents.value.length, checkedAt, ...(freshness.ok && freshness.value.revision ? { freshness: freshness.value.revision } : {}) } }

  private async safeRoot(): Promise<KnowledgeContentResult<string>> { try { this.canonicalRoot = this.canonicalRoot ?? await fs.realpath(this.root); const stat = await fs.stat(this.canonicalRoot); if (!stat.isDirectory()) return { ok: false, code: 'unavailable', message: 'Configured filesystem root is not a directory.' }; return { ok: true, value: this.canonicalRoot } } catch { return { ok: false, code: 'unavailable', message: 'Configured filesystem root is unavailable.' } } }
  private async safeDocument(documentId: string): Promise<KnowledgeContentResult<{ root: string; path: string }>> { if (!documentId || path.isAbsolute(documentId) || documentId.split('/').some(part => part === '..' || part === '')) return { ok: false, code: 'invalid_request', message: 'Filesystem document identity is invalid.' }; const root = await this.safeRoot(); if (!root.ok) return root; const file = descriptorPath(root.value, documentId); try { const canonical = await fs.realpath(file); if (canonical !== root.value && !canonical.startsWith(`${root.value}${path.sep}`)) return { ok: false, code: 'unavailable', message: 'Filesystem document escapes the configured root.' }; return { ok: true, value: { root: root.value, path: canonical } } } catch { return { ok: false, code: 'not_found', message: 'Filesystem document was not found.' } } }
  private async walk(root: string, current: string, depth: number, output: KnowledgeDocumentDescriptor[], limit: number): Promise<void> { if (output.length >= limit || depth > this.maxDepth) return; const entries = (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)); for (const entry of entries) { if (output.length >= limit || this.ignores.has(entry.name)) continue; const candidate = path.join(current, entry.name); if (entry.isDirectory()) { await this.walk(root, candidate, depth + 1, output, limit); continue } if (!entry.isFile()) continue; const canonical = await fs.realpath(candidate); if (canonical !== root && !canonical.startsWith(`${root}${path.sep}`)) continue; const stat = await fs.stat(canonical); output.push(this.toDescriptor(root, canonical, stat)) } }
  private toDescriptor(root: string, file: string, stat: { size: number; mtime: Date }): KnowledgeDocumentDescriptor { const documentId = relative(root, file); return { documentId, title: path.basename(file), mediaType: MEDIA_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', sizeBytes: stat.size, modifiedAt: iso(stat.mtime), metadata: { path: documentId } } }
}

export function createFilesystemKnowledgeManifest(options: FilesystemKnowledgeProviderOptions, ownerId = 'local-user', now = new Date()): KnowledgeManifest {
  return { kind: 'workbench.knowledge.manifest', manifestVersion: 1, providerId: options.providerId, providerType: 'filesystem', providerVersion: options.providerVersion ?? '1', displayName: `Filesystem: ${path.basename(path.resolve(options.rootPath)) || 'root'}`, location: { kind: 'local-path', value: path.resolve(options.rootPath) }, ownership: { ownerType: 'user', ownerId }, capabilities: ['health', 'metadata', 'discovery', 'content', 'freshness'], supportedFormats: ['filesystem'], indexing: { full: true, incremental: true, observe: true }, freshness: { strategy: 'revision', observedAt: iso(now) }, permissions: ['read'], compatibility: { contractVersion: '1' } }
}
