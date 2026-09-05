import fs from 'fs'
import { promises as fsp } from 'fs'
import path from 'path'
import matter from 'gray-matter'
import { getEnabledSources } from './config'
import { getConfigDir, getIndexPath, getIndexDir, getSourceIndexPath } from '../utils/paths'
import { IndexedDoc } from '@workbench/shared'
import { recordIndexTelemetry } from './index-graph-telemetry'
import {
  DEFAULT_IGNORE_PATTERNS,
  INDEX_SCAN_EXCLUSION_VERSION,
  INDEX_SCAN_POLICY_ID,
  INDEX_SCAN_POLICY_VERSION,
  MAX_INDEX_SCAN_BYTES,
  MAX_INDEX_SCAN_DIRECTORIES,
  MAX_INDEX_SCAN_ENTRIES_PER_DIRECTORY,
  MAX_INDEX_SCAN_FILES,
  MAX_INDEX_SCAN_RESULTS as POLICY_MAX_INDEX_SCAN_RESULTS,
  MAX_INDEX_SCAN_WALL_TIME_MS,
  MAX_INDEXABLE_FILE_BYTES,
  MAX_INDEX_SCAN_DEPTH,
  MAX_INDEX_SCAN_HARD_DEPTH,
  boundedScanOptions,
  indexFailureCodeForTermination,
  type IndexScanBudgetOptions,
  type IndexScanFailureCode
} from './index-scan-policy'

const MAX_INDEXABLE_BYTES = MAX_INDEXABLE_FILE_BYTES
const YIELD_EVERY_FILES = 25
const BUFFER_SAMPLE_BYTES = 4096
const ALLOWED_HIDDEN_INDEX_PREFIXES = ['.kiro/']
const ALLOWED_HIDDEN_INDEX_FILES = new Set(['.ai/current.md'])
export { DEFAULT_IGNORE_PATTERNS, INDEX_SCAN_EXCLUSION_VERSION, INDEX_SCAN_POLICY_ID, INDEX_SCAN_POLICY_VERSION, MAX_INDEX_SCAN_BYTES, MAX_INDEX_SCAN_DIRECTORIES, MAX_INDEX_SCAN_ENTRIES_PER_DIRECTORY, MAX_INDEX_SCAN_FILES, MAX_INDEX_SCAN_WALL_TIME_MS, MAX_INDEXABLE_FILE_BYTES, MAX_INDEX_SCAN_DEPTH, MAX_INDEX_SCAN_HARD_DEPTH }
export const MAX_INDEX_SCAN_RESULTS = POLICY_MAX_INDEX_SCAN_RESULTS

export type IndexerOptions = {
  yieldIfNeeded?: () => Promise<void>
  onProgress?: (progress: { completed: number; total: number; indexed: number }) => void | Promise<void>
}

export type ScanTerminationReason = 'completed' | 'depth_limit' | 'entries_limit' | 'result_limit' | 'directory_budget' | 'file_budget' | 'byte_budget' | 'time_budget' | 'source_missing' | 'symlink_rejected' | 'io_error'

export type IndexScanDepthBand = {
  directories: number
  files: number
  ignored: number
  bytes: number
}

export type ScanResult = {
  files: string[]
  entriesExamined: number
  directoriesVisited: number
  filesConsidered: number
  bytesConsidered: number
  maxDepth: number
  terminationReason: ScanTerminationReason
  depthLimitPaths: string[]
  budgetLimitPaths: string[]
  ignoredPathCount: number
  deepestLegitimatePath?: string
  deepestIgnoredPath?: string
  depthBands: Record<string, IndexScanDepthBand>
  policyVersion: string
  exclusionVersion: string
  policyIdentity: string
  effectiveLimits: Required<IndexScanBudgetOptions>
}

export class IndexScanError extends Error {
  readonly failureCode: IndexScanFailureCode
  readonly scan: ScanResult

  constructor(scan: ScanResult) {
    const pathDetail = scan.depthLimitPaths[0] || scan.budgetLimitPaths[0]
    const reason = scan.terminationReason === 'source_missing'
      ? 'source_missing_or_renamed'
      : scan.terminationReason === 'symlink_rejected'
        ? 'source_symlink_rejected'
        : scan.terminationReason === 'io_error'
          ? 'source_io_error'
          : `source_${scan.terminationReason}`
    super(`${reason}${pathDetail ? ` at ${pathDetail}` : ''}`)
    this.name = 'IndexScanError'
    this.failureCode = indexFailureCodeForTermination(scan.terminationReason)
    this.scan = scan
  }
}

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

function globMatches(filePath: string, patterns: string[]): boolean {
  const normalized = filePath.replace(/\\/g, '/')
  return patterns.some(pattern => {
    const candidate = pattern.replace(/\\/g, '/')
    if (candidate === '**/*' || candidate === '*') return true
    const escaped = candidate
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
    return new RegExp(`^${escaped}$`).test(normalized)
  })
}

function ignoredPath(filePath: string, ignorePatterns: string[]): boolean {
  const parts = filePath.replace(/\\/g, '/').split('/')
  return ignorePatterns.some(pattern => {
    const normalized = pattern.replace(/\\/g, '/')
    const name = normalized.replace(/^\*\*\//, '').replace(/\/\*\*\/?$/, '').replace(/\*$/, '')
    return parts.some(part => part === name || (name.endsWith('/') && part === name.slice(0, -1)))
  })
}

function hiddenPathShouldBePruned(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/')
  if (normalized === '.ai' || normalized === '.ai/current.md') return false
  if (normalized === '.kiro' || normalized.startsWith('.kiro/')) return false
  return normalized.split('/').some(part => part.startsWith('.'))
}

function exclusionKind(filePath: string, ignorePatterns: string[]): 'ignored_generated' | 'hidden_excluded' | undefined {
  if (ignoredPath(filePath, ignorePatterns)) return 'ignored_generated'
  if (hiddenPathShouldBePruned(filePath)) return 'hidden_excluded'
  return undefined
}

function depthBand(depth: number): string {
  if (depth <= 3) return '0-3'
  if (depth <= 5) return '4-5'
  if (depth <= 8) return '6-8'
  if (depth <= 10) return '9-10'
  return '11+'
}

function newDepthBand(): IndexScanDepthBand {
  return { directories: 0, files: 0, ignored: 0, bytes: 0 }
}

export async function boundedSourceScan(rootPath: string, patterns: string[], ignorePatterns: string[], options: IndexScanBudgetOptions = {}): Promise<ScanResult> {
  const effectiveLimits = boundedScanOptions(options)
  const base = {
    files: [] as string[],
    entriesExamined: 0,
    directoriesVisited: 0,
    filesConsidered: 0,
    bytesConsidered: 0,
    maxDepth: 0,
    terminationReason: 'completed' as ScanTerminationReason,
    depthLimitPaths: [] as string[],
    budgetLimitPaths: [] as string[],
    ignoredPathCount: 0,
    deepestLegitimatePath: undefined as string | undefined,
    deepestIgnoredPath: undefined as string | undefined,
    depthBands: {} as Record<string, IndexScanDepthBand>,
    policyVersion: INDEX_SCAN_POLICY_VERSION,
    exclusionVersion: INDEX_SCAN_EXCLUSION_VERSION,
    policyIdentity: INDEX_SCAN_POLICY_ID,
    effectiveLimits
  }
  const result = (): ScanResult => base
  const startedAt = Date.now()
  let symlinkRejected = false
  const recordPath = (list: string[], relative: string): void => {
    if (relative && list.length < 32) list.push(relative)
  }
  const timedOut = (): boolean => Date.now() - startedAt >= effectiveLimits.maxWallTimeMs
  const fail = (reason: ScanTerminationReason, relative?: string): void => {
    if (base.terminationReason !== 'completed') return
    base.terminationReason = reason
    if (reason === 'depth_limit') recordPath(base.depthLimitPaths, relative || '')
    if (reason.endsWith('budget') || reason === 'entries_limit' || reason === 'result_limit' || reason === 'time_budget') recordPath(base.budgetLimitPaths, relative || '')
  }
  const trackBand = (depth: number): IndexScanDepthBand => {
    const key = depthBand(depth)
    if (!base.depthBands[key]) base.depthBands[key] = newDepthBand()
    return base.depthBands[key]
  }

  let rootStat
  try { rootStat = await fsp.lstat(rootPath) } catch {
    base.terminationReason = 'source_missing'
    return result()
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    base.terminationReason = 'symlink_rejected'
    return result()
  }

  const stack: Array<{ absolute: string; relative: string; depth: number }> = [{ absolute: rootPath, relative: '', depth: 0 }]
  while (stack.length > 0 && base.terminationReason === 'completed') {
    if (timedOut()) { fail('time_budget'); break }
    const current = stack.pop()!
    if (base.directoriesVisited >= effectiveLimits.maxDirectories) { fail('directory_budget', current.relative); break }
    base.directoriesVisited++
    base.maxDepth = Math.max(base.maxDepth, current.depth)
    trackBand(current.depth).directories++

    const entries: fs.Dirent[] = []
    try {
      const directory = await fsp.opendir(current.absolute)
      for await (const entry of directory) {
        base.entriesExamined++
        if (timedOut()) { fail('time_budget', current.relative); break }
        entries.push(entry)
        if (entries.length > MAX_INDEX_SCAN_ENTRIES_PER_DIRECTORY) {
          fail('entries_limit', current.relative)
          break
        }
      }
      entries.sort((a, b) => a.name.localeCompare(b.name))
    } catch {
      fail('io_error', current.relative)
    }
    // Preserve the historical bounded behavior: inspect the already-capped
    // directory entries even after discovering the per-directory entry limit,
    // so the bounded result set remains useful alongside the failure reason.
    if (base.terminationReason !== 'completed' && base.terminationReason !== 'entries_limit') break

    for (const entry of entries) {
      if (timedOut()) { fail('time_budget', current.relative); break }
      const relative = current.relative ? path.posix.join(current.relative, entry.name) : entry.name
      const depth = current.depth + 1
      const band = trackBand(depth)
      const excluded = exclusionKind(relative, ignorePatterns)
      if (excluded) {
        base.ignoredPathCount++
        band.ignored++
        if (!base.deepestIgnoredPath || relative.split('/').length > base.deepestIgnoredPath.split('/').length) base.deepestIgnoredPath = relative
        continue
      }
      const absolute = path.join(current.absolute, entry.name)
      if (entry.isSymbolicLink()) {
        // Reject the link itself but continue scanning independent safe files;
        // callers receive the truthful rejection reason without losing safe
        // source results discovered in the same directory.
        symlinkRejected = true
        continue
      }
      if (entry.isDirectory()) {
        if (current.depth >= effectiveLimits.maxDepth) {
          base.maxDepth = Math.max(base.maxDepth, depth)
          fail('depth_limit', relative)
        } else {
          stack.push({ absolute, relative, depth })
        }
        if (base.terminationReason !== 'completed') break
        continue
      }
      if (!entry.isFile() || !globMatches(relative, patterns)) continue
      if (base.filesConsidered >= effectiveLimits.maxFiles) { fail('file_budget', relative); break }
      let stat: fs.Stats
      try { stat = await fsp.stat(absolute) } catch { fail('io_error', relative); break }
      const consideredBytes = Math.min(stat.size, MAX_INDEXABLE_BYTES)
      if (base.bytesConsidered + consideredBytes > effectiveLimits.maxBytes) { fail('byte_budget', relative); break }
      base.filesConsidered++
      base.bytesConsidered += consideredBytes
      band.files++
      band.bytes += consideredBytes
      if (!base.deepestLegitimatePath || depth > base.deepestLegitimatePath.split('/').length) base.deepestLegitimatePath = relative
      if (base.files.length >= MAX_INDEX_SCAN_RESULTS) { fail('result_limit', relative); break }
      base.files.push(relative)
    }
    if (base.terminationReason === 'completed') await yieldToEventLoop()
  }
  if (base.terminationReason === 'completed' && symlinkRejected) base.terminationReason = 'symlink_rejected'
  return result()
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

  constructor(sourceIds?: string[], private readonly options: IndexerOptions = {}) {
    this.loadFromDisk(sourceIds)
  }

  async buildIndex(): Promise<void> {
    this.docs = []

    const sources = getEnabledSources({ includeIndexState: false, refreshGitMetadata: false })
    const patterns = ['**/*']
    const ignorePatterns = DEFAULT_IGNORE_PATTERNS

    for (const source of sources) {
      await this.buildIndexForSource(source.id, source.path, patterns, ignorePatterns)
    }
  }

  async buildIndexForSource(sourceId: string, sourcePath?: string, patterns: string[] = ['**/*'], ignorePatterns: string[] = DEFAULT_IGNORE_PATTERNS, progressOptions: IndexerOptions = {}): Promise<number> {
    const onProgress = progressOptions.onProgress ?? this.options.onProgress
    const startedAt = Date.now()
    // Source-management reindexes provide an explicit sourcePath. Avoid
    // hydrating every configured source (including Git/index bindings) during
    // the synchronous prefix of this async method; native startup must remain
    // responsive while a source begins rebuilding.
    const source = sourcePath
      ? undefined
      : getEnabledSources({ includeIndexState: false, refreshGitMetadata: false }).find(item => item.id === sourceId)
    if (!source && !sourcePath) {
      recordIndexTelemetry({
        sourceId,
        durationMs: Date.now() - startedAt,
        outcome: 'failure',
        reasonCode: 'source_not_found'
      })
      throw new Error(`Source not found or disabled: ${sourceId}`)
    }

    const rootPath = sourcePath || source?.path
    if (!rootPath) {
      recordIndexTelemetry({
        sourceId,
        durationMs: Date.now() - startedAt,
        outcome: 'failure',
        reasonCode: 'source_path_missing'
      })
      throw new Error(`Source path missing for: ${sourceId}`)
    }

    const nextDocs = this.docs.filter(doc => doc.sourceId !== sourceId)
    const sourceDocs: IndexedDoc[] = []

    let indexedFiles = 0
    let skippedFiles = 0
    let processedFiles = 0
    let scan: ScanResult | undefined
    try {
      scan = await boundedSourceScan(rootPath, patterns, ignorePatterns)
      if (scan.terminationReason !== 'completed') {
        throw new IndexScanError(scan)
      }

      await onProgress?.({ completed: 0, total: scan.files.length, indexed: 0 })

      for (const filePath of scan.files) {
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
        } catch (err) {
          skippedFiles++
          console.warn(`Failed to index ${filePath} from ${sourceId}:`, err)
        } finally {
          processedFiles++
          if (processedFiles === scan.files.length || processedFiles % YIELD_EVERY_FILES === 0) {
            await onProgress?.({ completed: processedFiles, total: scan.files.length, indexed: indexedFiles })
          }
        }

        if (processedFiles % YIELD_EVERY_FILES === 0) {
          await yieldToEventLoop()
          await this.options.yieldIfNeeded?.()
        }
      }
    } catch (err) {
      recordIndexTelemetry({
        sourceId,
        durationMs: Date.now() - startedAt,
        indexedFileCount: scan?.filesConsidered,
        directoriesVisited: scan?.directoriesVisited,
        filesConsidered: scan?.filesConsidered,
        bytesConsidered: scan?.bytesConsidered,
        entriesExamined: scan?.entriesExamined,
        maxDepth: scan?.maxDepth,
        resultsEmitted: scan?.files.length,
        terminationReason: scan?.terminationReason,
        outcome: 'failure',
        reasonCode: 'index_failed'
      })
      console.warn(`Failed to index source ${sourceId}:`, err)
      throw err
    }

    this.docs = nextDocs
    this.saveSourceToDisk(sourceId, sourceDocs)
    this.saveManifestToDisk()
    recordIndexTelemetry({
      sourceId,
      durationMs: Date.now() - startedAt,
      indexedFileCount: indexedFiles,
      directoriesVisited: scan.directoriesVisited,
      filesConsidered: scan.filesConsidered,
      bytesConsidered: scan.bytesConsidered,
      entriesExamined: scan.entriesExamined,
      maxDepth: scan.maxDepth,
      resultsEmitted: scan.files.length,
      terminationReason: scan.terminationReason,
      outcome: 'success',
      reasonCode: 'index_completed'
    })
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
        version: 3,
        storage: 'per-source-json',
        policyVersion: INDEX_SCAN_POLICY_VERSION,
        exclusionVersion: INDEX_SCAN_EXCLUSION_VERSION,
        policyIdentity: INDEX_SCAN_POLICY_ID,
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

  private loadFromDisk(sourceIds?: string[]): void {
    try {
      const selectedSourceIds = Array.isArray(sourceIds)
        ? Array.from(new Set(sourceIds.filter(sourceId => typeof sourceId === 'string' && sourceId.trim().length > 0)))
        : []
      if (selectedSourceIds.length > 0) {
        this.docs = selectedSourceIds.flatMap(sourceId => readJsonArray<IndexedDoc>(getSourceIndexPath(sourceId)))
        return
      }
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

/// Reads only the small v2 manifest. Status and GUI source hydration must not
/// deserialize every indexed document merely to report a count.
export function getIndexedDocumentCountFromDisk(): number {
  try {
    const parsed = JSON.parse(fs.readFileSync(getIndexPath(), 'utf-8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 0
    const sources = (parsed as { sources?: unknown }).sources
    if (!Array.isArray(sources)) return 0
    return sources.reduce((total, source) => {
      if (!source || typeof source !== 'object') return total
      const count = (source as { count?: unknown }).count
      return Number.isSafeInteger(count) && (count as number) >= 0 ? total + (count as number) : total
    }, 0)
  } catch {
    return 0
  }
}
