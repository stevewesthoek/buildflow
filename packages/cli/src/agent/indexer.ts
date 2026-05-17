import fs from 'fs'
import { promises as fsp } from 'fs'
import path from 'path'
import matter from 'gray-matter'
import fg from 'fast-glob'
import { getEnabledSources } from './config'
import { getConfigDir, getIndexPath, getIndexDir, getSourceIndexPath } from '../utils/paths'
import { IndexedDoc } from '@buildflow/shared'

const DEFAULT_IGNORE_PATTERNS = [
  '**/.git/**',
  '**/.obsidian/**',
  '**/.next/**',
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/coverage/**',
  '**/.cache/**',
  '**/.turbo/**',
  '**/.vercel/**',
  '**/.npm/**',
  '**/.yarn/**',
  '**/.pnpm-store/**',
  '**/.DS_Store',
  '**/.idea/**',
  '**/.vscode/**',
  '**/pnpm-lock.yaml',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/bun.lockb',
  '**/*.tsbuildinfo',
  '**/docs/openapi.chatgpt.json'
]

const MAX_INDEXABLE_BYTES = 1024 * 1024
const YIELD_EVERY_FILES = 25
const BUFFER_SAMPLE_BYTES = 4096
const ALLOWED_HIDDEN_INDEX_PREFIXES = ['.kiro/']
const ALLOWED_HIDDEN_INDEX_FILES = new Set(['.ai/current.md'])

const shouldIndexRelativePath = (filePath: string): boolean => {
  const normalized = filePath.replace(/\\/g, '/')
  if (ALLOWED_HIDDEN_INDEX_FILES.has(normalized)) return true
  if (ALLOWED_HIDDEN_INDEX_PREFIXES.some(prefix => normalized.startsWith(prefix))) return true
  const parts = normalized.split('/')
  return !parts.some(part => part.startsWith('.'))
}

const yieldToEventLoop = async (): Promise<void> => {
  await new Promise<void>(resolve => setImmediate(resolve))
}

const isProbablyBinaryContent = (buffer: Buffer): boolean => {
  const sample = buffer.subarray(0, Math.min(buffer.length, BUFFER_SAMPLE_BYTES))
  for (const byte of sample) {
    if (byte === 0) return true
  }
  return false
}

function ensureIndexDir(): void {
  const dir = getIndexDir()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function readJsonArray<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return []
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    return Array.isArray(parsed) ? parsed as T[] : []
  } catch {
    return []
  }
}

export class Indexer {
  private docs: IndexedDoc[] = []

  constructor() {
    this.loadFromDisk()
  }

  async buildIndex(): Promise<void> {
    this.docs = []

    const sources = getEnabledSources()
    const patterns = ['**/*']
    const ignorePatterns = DEFAULT_IGNORE_PATTERNS

    for (const source of sources) {
      await this.buildIndexForSource(source.id, source.path, patterns, ignorePatterns)
    }
  }

  async buildIndexForSource(sourceId: string, sourcePath?: string, patterns: string[] = ['**/*'], ignorePatterns: string[] = DEFAULT_IGNORE_PATTERNS): Promise<number> {
    const source = getEnabledSources().find(item => item.id === sourceId)
    if (!source && !sourcePath) {
      throw new Error(`Source not found or disabled: ${sourceId}`)
    }

    const rootPath = sourcePath || source?.path
    if (!rootPath) {
      throw new Error(`Source path missing for: ${sourceId}`)
    }

    const nextDocs = this.docs.filter(doc => doc.sourceId !== sourceId)
    const sourceDocs: IndexedDoc[] = []

    let indexedFiles = 0
    let skippedFiles = 0
    let processedFiles = 0
    try {
      const sourceFiles = await fg(patterns, {
        cwd: rootPath,
        ignore: ignorePatterns,
        absolute: false,
        onlyFiles: true,
        dot: true,
        followSymbolicLinks: false
      })

      for (const filePath of sourceFiles) {
        try {
          if (!shouldIndexRelativePath(filePath)) {
            skippedFiles++
            continue
          }
          const fullPath = path.join(rootPath, filePath)
          const stat = await fsp.stat(fullPath)
          if (!stat.isFile()) {
            skippedFiles++
            continue
          }
          if (stat.size > MAX_INDEXABLE_BYTES) {
            skippedFiles++
            continue
          }

          const contentBuffer = await fsp.readFile(fullPath)
          if (isProbablyBinaryContent(contentBuffer)) {
            skippedFiles++
            continue
          }
          const content = contentBuffer.toString('utf8')

          let title = path.basename(filePath, path.extname(filePath))
          let tags: string[] = []

          if (filePath.endsWith('.md')) {
            const { data } = matter(content)
            title = data.title || title
            tags = data.tags || []
          }

          const doc: IndexedDoc = {
            sourceId,
            id: `${sourceId}:${filePath}`,
            path: filePath,
            title,
            extension: path.extname(filePath),
            modifiedAt: stat.mtime.toISOString(),
            size: stat.size,
            tags,
            contentPreview: content.slice(0, 200),
            content
          }

          nextDocs.push(doc)
          sourceDocs.push(doc)
          indexedFiles++
          processedFiles++
        } catch (err) {
          skippedFiles++
          console.warn(`Failed to index ${filePath} from ${sourceId}:`, err)
        }

        if (processedFiles % YIELD_EVERY_FILES === 0) {
          await yieldToEventLoop()
        }
      }
    } catch (err) {
      console.warn(`Failed to index source ${sourceId}:`, err)
      throw err
    }

    this.docs = nextDocs
    this.saveSourceToDisk(sourceId, sourceDocs)
    this.saveManifestToDisk()
    return indexedFiles
  }

  removeSourceDocs(sourceId: string): number {
    const before = this.docs.length
    this.docs = this.docs.filter(doc => doc.sourceId !== sourceId)
    const removed = before - this.docs.length
    this.deleteSourceFromDisk(sourceId)
    this.saveManifestToDisk()
    return removed
  }

  private saveSourceToDisk(sourceId: string, docs: IndexedDoc[]): void {
    try {
      ensureIndexDir()
      const indexPath = getSourceIndexPath(sourceId)
      fs.writeFileSync(indexPath, JSON.stringify(docs))
    } catch (err) {
      console.warn(`Failed to save source index ${sourceId}:`, err)
    }
  }

  private deleteSourceFromDisk(sourceId: string): void {
    try {
      const indexPath = getSourceIndexPath(sourceId)
      if (fs.existsSync(indexPath)) fs.unlinkSync(indexPath)
    } catch (err) {
      console.warn(`Failed to delete source index ${sourceId}:`, err)
    }
  }

  private saveManifestToDisk(): void {
    try {
      const indexPath = getIndexPath()
      const dir = path.dirname(indexPath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const counts = this.docs.reduce<Record<string, number>>((acc, doc) => {
        acc[doc.sourceId] = (acc[doc.sourceId] || 0) + 1
        return acc
      }, {})
      const manifest = {
        version: 2,
        storage: 'per-source-json',
        sources: Object.entries(counts).map(([sourceId, count]) => ({
          sourceId,
          file: path.relative(getConfigDir(), getSourceIndexPath(sourceId)),
          count
        }))
      }
      fs.writeFileSync(indexPath, JSON.stringify(manifest))
    } catch (err) {
      console.warn('Failed to save index manifest:', err)
    }
  }

  private saveToDisk(): void {
    try {
      ensureIndexDir()
      const bySource = new Map<string, IndexedDoc[]>()
      for (const doc of this.docs) {
        const docs = bySource.get(doc.sourceId) || []
        docs.push(doc)
        bySource.set(doc.sourceId, docs)
      }
      for (const [sourceId, docs] of bySource.entries()) {
        this.saveSourceToDisk(sourceId, docs)
      }
      this.saveManifestToDisk()
    } catch (err) {
      console.warn('Failed to save index:', err)
    }
  }

  private loadFromDisk(): void {
    try {
      const indexDir = getIndexDir()
      if (fs.existsSync(indexDir)) {
        const sourceIndexFiles = fs.readdirSync(indexDir).filter(file => file.endsWith('.json'))
        const docs = sourceIndexFiles.flatMap(file => readJsonArray<IndexedDoc>(path.join(indexDir, file)))
        if (docs.length > 0) {
          this.docs = docs
          return
        }
      }

      const indexPath = getIndexPath()
      if (fs.existsSync(indexPath)) {
        const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf-8'))
        this.docs = Array.isArray(parsed) ? parsed as IndexedDoc[] : []
      }
    } catch (err) {
      console.warn('Failed to load index:', err)
    }
  }

  getDocs(): IndexedDoc[] {
    return this.docs
  }
}
