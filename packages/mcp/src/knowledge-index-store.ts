import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { KnowledgeIndex, type KnowledgeIndexSnapshot } from './knowledge-index.js'

export const KNOWLEDGE_INDEX_SCHEMA_VERSION = 1 as const
export const KNOWLEDGE_INDEX_FILENAME = 'workbench-knowledge-index.json' as const
export type KnowledgeIndexStoreOptions = { rootDir: string; maxBytes?: number; maxDocuments?: number }
export type KnowledgeIndexStoreResult<T> = { ok: true; value: T } | { ok: false; code: 'index_missing' | 'index_corrupt' | 'index_too_large' | 'index_limit' | 'migration_required' | 'index_busy'; message: string }

type PersistedIndex = { schemaVersion: typeof KNOWLEDGE_INDEX_SCHEMA_VERSION; providerId: string; updatedAt: string; snapshot: KnowledgeIndexSnapshot }

export class KnowledgeIndexStore {
  constructor(private readonly options: KnowledgeIndexStoreOptions) {}

  filePath(providerId: string): string { return path.join(path.resolve(this.options.rootDir), `${providerId}-${KNOWLEDGE_INDEX_FILENAME}`) }

  load(providerId: string): KnowledgeIndexStoreResult<KnowledgeIndex> {
    const file = this.filePath(providerId)
    try {
      if (!fs.existsSync(file)) return { ok: false, code: 'index_missing', message: 'Knowledge index does not exist.' }
      if (fs.statSync(file).size > (this.options.maxBytes ?? 8 * 1024 * 1024)) return { ok: false, code: 'index_too_large', message: 'Knowledge index exceeds the configured storage bound.' }
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<PersistedIndex>
      if (parsed.schemaVersion !== KNOWLEDGE_INDEX_SCHEMA_VERSION) return { ok: false, code: 'migration_required', message: 'Knowledge index schema requires migration.' }
      if (parsed.providerId !== providerId || !parsed.snapshot || !Array.isArray(parsed.snapshot.documents) || parsed.snapshot.documents.length > (this.options.maxDocuments ?? 10_000)) return { ok: false, code: 'index_corrupt', message: 'Knowledge index shape is invalid.' }
      return { ok: true, value: KnowledgeIndex.fromSnapshot(parsed.snapshot) }
    } catch { return { ok: false, code: 'index_corrupt', message: 'Knowledge index could not be read safely.' } }
  }

  save(providerId: string, index: KnowledgeIndex, updatedAt: string): KnowledgeIndexStoreResult<boolean> {
    const snapshot = index.snapshot()
    if (snapshot.documents.length > (this.options.maxDocuments ?? 10_000)) return { ok: false, code: 'index_limit', message: 'Knowledge index document limit reached.' }
    const payload: PersistedIndex = { schemaVersion: KNOWLEDGE_INDEX_SCHEMA_VERSION, providerId, updatedAt, snapshot }
    const serialized = JSON.stringify(payload)
    if (Buffer.byteLength(serialized, 'utf8') > (this.options.maxBytes ?? 8 * 1024 * 1024)) return { ok: false, code: 'index_too_large', message: 'Knowledge index exceeds the configured storage bound.' }
    const directory = path.resolve(this.options.rootDir)
    const file = this.filePath(providerId)
    const lock = `${file}.lock`
    let fd: number | undefined
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
      try { fd = fs.openSync(lock, 'wx', 0o600) } catch { return { ok: false, code: 'index_busy', message: 'Knowledge index is busy.' } }
      const temp = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
      fs.writeFileSync(temp, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      fs.renameSync(temp, file)
      fs.chmodSync(file, 0o600)
      return { ok: true, value: true }
    } catch { return { ok: false, code: 'index_corrupt', message: 'Knowledge index persistence failed safely.' } }
    finally { if (fd !== undefined) { try { fs.closeSync(fd) } catch {} ; try { fs.rmSync(lock, { force: true }) } catch {} } }
  }
}
