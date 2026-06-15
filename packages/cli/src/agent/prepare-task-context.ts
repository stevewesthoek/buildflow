import { SearchResult } from '@workbench/shared'
import { VaultSearcher } from './search'
import { readFile } from './vault'
import { redactSecrets, truncateContent } from './safe-access'
import { GPT_ACTION_DEFAULT_FILE_BYTES } from './payload-budget'

const MAX_CANDIDATE_RESULTS = 12
const MAX_FILES_TO_EXCERPT = 3
const DEFAULT_CONTEXT_BYTES_PER_FILE = 800
const LARGE_FILE_FOCUSED_READ_THRESHOLD_BYTES = 100 * 1024

type CandidateFile = {
  sourceId: string
  path: string
  title?: string
  score?: number
  snippet?: string
  contentExcerpt?: string
  truncated?: boolean
  sizeBytes?: number
  modifiedAt?: string
  error?: string
}

type PreparedContext = {
  mode: 'prepare_task_context'
  status: 'ok'
  query: string
  sourceIds: string[]
  summary: string
  topFiles: Array<{
    sourceId?: string
    path: string
    reason: string
    confidence?: number
    suggestedRead?: boolean
  }>
  exactReadPlan: Array<{
    sourceId?: string
    path: string
    purpose: string
    maxBytesPerFile: number
    suggestedMode?: 'read_paths' | 'grep_context'
  }>
  uncertainty: string[]
  searchNotes: string[]
  candidates: Array<{
    sourceId: string
    path: string
    score?: number
    snippet?: string
    sizeBytes?: number
    modifiedAt?: string
  }>
  strategy: {
    kind: 'deterministic_search'
    localAiUsed: false
    reason: string
  }
  timings: {
    totalMs: number
    searchMs: number
    readMs: number
  }
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  if (value === null || value === undefined) return fallback
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(min, Math.min(max, Math.floor(numeric)))
}

function dedupeResults(results: SearchResult[], seedPaths: Array<{ sourceId: string; path: string }>): CandidateFile[] {
  const seen = new Set<string>()
  const candidates: CandidateFile[] = []

  for (const seed of seedPaths) {
    const key = `${seed.sourceId}::${seed.path}`
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push({ sourceId: seed.sourceId, path: seed.path, snippet: 'User-provided seed path.' })
  }

  for (const result of results) {
    const key = `${result.sourceId}::${result.path}`
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push({
      sourceId: result.sourceId,
      path: result.path,
      title: result.title,
      score: result.score,
      snippet: result.snippet,
      sizeBytes: result.sizeBytes,
      modifiedAt: result.modifiedAt
    })
  }

  return candidates.slice(0, MAX_CANDIDATE_RESULTS)
}

function confidenceFromScore(score: number | undefined): number | undefined {
  if (typeof score !== 'number') return undefined
  return Math.max(0, Math.min(1, 1 - score))
}

function summarizeCandidate(candidate: CandidateFile): string {
  if (candidate.snippet) return candidate.snippet.slice(0, 240)
  if (candidate.contentExcerpt) return candidate.contentExcerpt.replace(/\s+/g, ' ').slice(0, 240)
  return 'Search matched this path or its contents.'
}

function buildPreparedContext(query: string, candidates: CandidateFile[], totalMs: number, searchMs: number, readMs: number): PreparedContext {
  const readable = candidates.filter(candidate => !candidate.error).slice(0, 5)
  const errored = candidates.filter(candidate => candidate.error)
  const largeCandidates = readable.filter(candidate => typeof candidate.sizeBytes === 'number' && candidate.sizeBytes > LARGE_FILE_FOCUSED_READ_THRESHOLD_BYTES)

  return {
    mode: 'prepare_task_context',
    status: 'ok',
    query,
    sourceIds: Array.from(new Set(candidates.map(candidate => candidate.sourceId))),
    summary: readable.length > 0
      ? `Found ${readable.length} likely relevant file(s). Read the exact plan before editing.`
      : 'No strong candidate files were found. Refine the query or provide exact paths.',
    topFiles: readable.map(candidate => ({
      sourceId: candidate.sourceId,
      path: candidate.path,
      reason: summarizeCandidate(candidate),
      confidence: confidenceFromScore(candidate.score),
      suggestedRead: true
    })),
    exactReadPlan: readable.slice(0, 3).map(candidate => {
      const largeFile = typeof candidate.sizeBytes === 'number' && candidate.sizeBytes > LARGE_FILE_FOCUSED_READ_THRESHOLD_BYTES
      return {
        sourceId: candidate.sourceId,
        path: candidate.path,
        purpose: largeFile
          ? 'Large file: use grep_context with a specific symbol or text, then read_range around the match.'
          : 'Read this file to inspect the relevant implementation before changing code.',
        maxBytesPerFile: GPT_ACTION_DEFAULT_FILE_BYTES,
        suggestedMode: largeFile ? 'grep_context' as const : 'read_paths' as const
      }
    }),
    uncertainty: [
      ...(readable.length === 0 ? ['No matching files found from the current index.'] : []),
      ...(errored.length > 0 ? [`${errored.length} candidate file(s) could not be excerpted.`] : [])
    ],
    searchNotes: [
      'Deterministic source-index ranking was used.',
      largeCandidates.length > 0
        ? 'Large candidates require focused modes; do not request top-of-file fallback content.'
        : 'Use exact read_paths for the planned files before editing.'
    ],
    candidates: candidates.slice(0, MAX_CANDIDATE_RESULTS).map(candidate => ({
      sourceId: candidate.sourceId,
      path: candidate.path,
      score: candidate.score,
      snippet: candidate.snippet,
      sizeBytes: candidate.sizeBytes,
      modifiedAt: candidate.modifiedAt
    })),
    strategy: {
      kind: 'deterministic_search',
      localAiUsed: false,
      reason: 'Deterministic source-index ranking.'
    },
    timings: { totalMs, searchMs, readMs }
  }
}

export async function prepareTaskContext(params: {
  query: string
  sourceIds: string[]
  searcher: VaultSearcher
  limit?: number
  paths?: string[]
  maxBytesPerFile?: number
}): Promise<PreparedContext> {
  const startedAt = Date.now()
  const query = params.query.trim()
  const sourceIds = Array.from(new Set(params.sourceIds.filter(Boolean)))
  const limit = boundedInt(params.limit, 8, 3, MAX_CANDIDATE_RESULTS)
  const maxBytesPerFile = boundedInt(params.maxBytesPerFile, DEFAULT_CONTEXT_BYTES_PER_FILE, 800, GPT_ACTION_DEFAULT_FILE_BYTES)
  const seedPaths = Array.isArray(params.paths)
    ? params.paths.filter(path => typeof path === 'string' && path.trim().length > 0).slice(0, 5).flatMap(path => sourceIds.map(sourceId => ({ sourceId, path })))
    : []

  const searchStartedAt = Date.now()
  const pathResults = params.searcher.search(query, limit, sourceIds)
  const contentResults = params.searcher.search(`content:${query}`, limit, sourceIds)
  const searchMs = Date.now() - searchStartedAt
  const candidates = dedupeResults([...pathResults, ...contentResults], seedPaths).slice(0, limit)

  const readStartedAt = Date.now()
  for (const candidate of candidates.slice(0, MAX_FILES_TO_EXCERPT)) {
    try {
      if (typeof candidate.sizeBytes === 'number' && candidate.sizeBytes > LARGE_FILE_FOCUSED_READ_THRESHOLD_BYTES) {
        candidate.truncated = true
        continue
      }
      const file = await readFile(candidate.path, candidate.sourceId)
      const redacted = redactSecrets(file.content)
      const truncated = truncateContent(redacted, maxBytesPerFile)
      candidate.contentExcerpt = truncated.content
      candidate.truncated = truncated.truncated
    } catch (err) {
      candidate.error = String(err)
    }
  }
  const readMs = Date.now() - readStartedAt

  return buildPreparedContext(query, candidates, Date.now() - startedAt, searchMs, readMs)
}
