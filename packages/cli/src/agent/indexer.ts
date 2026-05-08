import fs from 'fs'
import { promises as fsp } from 'fs'
import path from 'path'
import matter from 'gray-matter'
import fg from 'fast-glob'
import { getEnabledSources } from './config'
import { getIndexPath } from '../utils/paths'
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
  '**/.*/**',
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

    this.saveToDisk()
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
    this.saveToDisk()
    return indexedFiles
  }

  removeSourceDocs(sourceId: string): number {
    const before = this.docs.length
    this.docs = this.docs.filter(doc => doc.sourceId !== sourceId)
    const removed = before - this.docs.length
    this.saveToDisk()
    return removed
  }

  private saveToDisk(): void {
    try {
      const indexPath = getIndexPath()
      const dir = path.dirname(indexPath)

      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }

      fs.writeFileSync(indexPath, JSON.stringify(this.docs, null, 2))
    } catch (err) {
      console.warn('Failed to save index:', err)
    }
  }

  private loadFromDisk(): void {
    try {
      const indexPath = getIndexPath()
      if (fs.existsSync(indexPath)) {
        const content = fs.readFileSync(indexPath, 'utf-8')
        this.docs = JSON.parse(content)
      }
    } catch (err) {
      console.warn('Failed to load index:', err)
    }
  }

  getDocs(): IndexedDoc[] {
    return this.docs
  }
}
