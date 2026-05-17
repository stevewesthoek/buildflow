import { promises as fsp } from 'fs'
import path from 'path'
import { performance } from 'perf_hooks'
import { Indexer } from '../packages/cli/src/agent/indexer'
import { VaultSearcher } from '../packages/cli/src/agent/search'
import { getSourcesSafe } from '../packages/cli/src/agent/config'
import type { IndexedDoc } from '../packages/shared/src/types'

type Measurement = {
  name: string
  sourceCount: number
  iterations: number
  minMs: number
  p50Ms: number
  p95Ms: number
  maxMs: number
  avgMs: number
  details?: Record<string, unknown>
}

const SOURCE_GROUP_SIZES = [1, 3, 10]
const SEARCH_ITERATIONS = 12
const READ_ITERATIONS = 6
const LIST_ITERATIONS = 4
const MAX_READ_BYTES = 96_000
const LIST_DEPTH = 3
const LIST_LIMIT = 100
const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.cache', '.turbo', '.vercel', '.npm', '.yarn', '.pnpm-store'])

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

function summarize(name: string, sourceCount: number, values: number[], details?: Record<string, unknown>): Measurement {
  const total = values.reduce((sum, value) => sum + value, 0)
  return {
    name,
    sourceCount,
    iterations: values.length,
    minMs: round(Math.min(...values)),
    p50Ms: round(percentile(values, 50)),
    p95Ms: round(percentile(values, 95)),
    maxMs: round(Math.max(...values)),
    avgMs: round(total / Math.max(values.length, 1)),
    ...(details ? { details } : {})
  }
}

async function timed<T>(fn: () => Promise<T> | T): Promise<{ durationMs: number; result: T }> {
  const startedAt = performance.now()
  const result = await fn()
  return { durationMs: performance.now() - startedAt, result }
}

function docsBySource(docs: IndexedDoc[]): Map<string, IndexedDoc[]> {
  const grouped = new Map<string, IndexedDoc[]>()
  for (const doc of docs) {
    const sourceDocs = grouped.get(doc.sourceId) || []
    sourceDocs.push(doc)
    grouped.set(doc.sourceId, sourceDocs)
  }
  return grouped
}

function chooseSourceGroups(sourceIds: string[]): string[][] {
  const groups: string[][] = []
  for (const size of SOURCE_GROUP_SIZES) {
    if (sourceIds.length >= size) groups.push(sourceIds.slice(0, size))
  }
  if (groups.length === 0 && sourceIds.length > 0) groups.push([sourceIds[0]])
  return groups
}

function chooseSearchQueries(docs: IndexedDoc[]): string[] {
  const preferred = ['README', 'package', 'src', 'docs', 'config', 'test']
  const pathTokens = docs
    .map(doc => doc.path.split(/[/.\-_]/).find(part => part.length >= 4 && /^[A-Za-z0-9]+$/.test(part)))
    .filter((value): value is string => Boolean(value))
  return Array.from(new Set([...preferred, ...pathTokens])).slice(0, 8)
}

function chooseReadDocs(sourceIds: string[], groupedDocs: Map<string, IndexedDoc[]>): IndexedDoc[] {
  return sourceIds.flatMap(sourceId => {
    const docs = groupedDocs.get(sourceId) || []
    return docs
      .filter(doc => doc.size <= MAX_READ_BYTES && !doc.path.includes('/node_modules/') && !doc.path.includes('/.git/'))
      .slice(0, 3)
  }).slice(0, 12)
}

async function readDocs(sourceRoots: Map<string, string>, docs: IndexedDoc[]): Promise<number> {
  let bytesRead = 0
  for (const doc of docs) {
    const root = sourceRoots.get(doc.sourceId)
    if (!root) continue
    const fullPath = path.resolve(path.join(root, doc.path))
    if (!fullPath.startsWith(path.resolve(root))) continue
    try {
      const stat = await fsp.stat(fullPath)
      if (!stat.isFile() || stat.size > MAX_READ_BYTES) continue
      const content = await fsp.readFile(fullPath, 'utf8')
      bytesRead += Buffer.byteLength(content, 'utf8')
    } catch {
      // Indexed files can disappear between indexing and diagnostics; skip stale paths.
    }
  }
  return bytesRead
}

function shouldIncludeEntry(name: string): boolean {
  if (!name || name.startsWith('.DS_Store')) return false
  if (SKIP_DIRS.has(name)) return false
  return true
}

async function listSource(sourceRoot: string): Promise<number> {
  let count = 0
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (count >= LIST_LIMIT || depth > LIST_DEPTH) return
    let entries: import('fs').Dirent[] = []
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (count >= LIST_LIMIT) break
      if (!shouldIncludeEntry(entry.name)) continue
      const fullPath = path.join(dir, entry.name)
      try {
        await fsp.stat(fullPath)
      } catch {
        continue
      }
      count += 1
      if (entry.isDirectory() && depth + 1 < LIST_DEPTH) await walk(fullPath, depth + 1)
    }
  }
  await walk(sourceRoot, 0)
  return count
}

async function main(): Promise<void> {
  const startedAt = performance.now()
  const sources = getSourcesSafe().filter(source => source.enabled !== false)
  const sourceRoots = new Map(sources.map(source => [source.id, source.path]))
  const indexer = new Indexer()
  const docs = indexer.getDocs()
  const groupedDocs = docsBySource(docs)
  const indexedSourceIds = sources
    .map(source => source.id)
    .filter(sourceId => (groupedDocs.get(sourceId)?.length || 0) > 0)
  const sourceGroups = chooseSourceGroups(indexedSourceIds)
  const searcher = new VaultSearcher(docs)
  const measurements: Measurement[] = []
  const notes: string[] = []

  if (indexedSourceIds.length === 0) {
    console.log(JSON.stringify({
      status: 'blocked',
      reason: 'no_indexed_sources',
      message: 'No indexed sources were available. Reindex at least one source before running diagnostics.',
      sourceCount: sources.length,
      durationMs: round(performance.now() - startedAt)
    }, null, 2))
    return
  }

  for (const group of sourceGroups) {
    const groupDocs = group.flatMap(sourceId => groupedDocs.get(sourceId) || [])
    const queries = chooseSearchQueries(groupDocs)
    const searchDurations: number[] = []
    let resultCount = 0
    for (let i = 0; i < SEARCH_ITERATIONS; i += 1) {
      const query = queries[i % queries.length] || 'README'
      const { durationMs, result } = await timed(() => searcher.search(query, 10, group))
      searchDurations.push(durationMs)
      resultCount += result.length
    }
    measurements.push(summarize('source_scoped_path_search', group.length, searchDurations, {
      queryCount: queries.length,
      avgResultCount: round(resultCount / SEARCH_ITERATIONS)
    }))

    const readDocsSample = chooseReadDocs(group, groupedDocs)
    const readDurations: number[] = []
    let bytesRead = 0
    if (readDocsSample.length > 0) {
      for (let i = 0; i < READ_ITERATIONS; i += 1) {
        const { durationMs, result } = await timed(() => readDocs(sourceRoots, readDocsSample))
        readDurations.push(durationMs)
        bytesRead += result
      }
      measurements.push(summarize('async_multi_file_read', group.length, readDurations, {
        fileCount: readDocsSample.length,
        avgBytesRead: Math.round(bytesRead / READ_ITERATIONS)
      }))
    } else {
      notes.push(`No small readable files found for read benchmark in source group ${group.join(', ')}.`)
    }

    const listDurations: number[] = []
    let listedEntries = 0
    for (let i = 0; i < LIST_ITERATIONS; i += 1) {
      const { durationMs, result } = await timed(async () => {
        let count = 0
        for (const sourceId of group) {
          const root = sourceRoots.get(sourceId)
          if (root) count += await listSource(root)
        }
        return count
      })
      listDurations.push(durationMs)
      listedEntries += result
    }
    measurements.push(summarize('async_tree_list', group.length, listDurations, {
      depth: LIST_DEPTH,
      limitPerRun: LIST_LIMIT,
      avgEntryCount: round(listedEntries / LIST_ITERATIONS)
    }))
  }

  const slowest = [...measurements].sort((a, b) => b.p95Ms - a.p95Ms).slice(0, 3)
  const recommendations = slowest.map(item => {
    if (item.name.includes('search') && item.p95Ms > 100) return 'Search p95 is high; consider moving source-scoped search to a worker thread or SQLite FTS.'
    if (item.name.includes('read') && item.p95Ms > 100) return 'Read p95 is high; batch file reads more aggressively and keep maxBytesPerFile low for GPT actions.'
    if (item.name.includes('list') && item.p95Ms > 100) return 'List p95 is high; add cursors/pagination and avoid deep multi-source tree walks.'
    return `${item.name} is currently below the 100ms p95 warning threshold for ${item.sourceCount} source(s).`
  })

  console.log(JSON.stringify({
    status: 'ok',
    durationMs: round(performance.now() - startedAt),
    configuredSourceCount: sources.length,
    indexedSourceCount: indexedSourceIds.length,
    benchmarkedSourceGroups: sourceGroups.map(group => group.length),
    measurements,
    slowest,
    recommendations: Array.from(new Set(recommendations)),
    notes
  }, null, 2))
}

main().catch(error => {
  console.error(JSON.stringify({
    status: 'failed',
    error: error instanceof Error ? error.message : String(error)
  }, null, 2))
  process.exit(1)
})
