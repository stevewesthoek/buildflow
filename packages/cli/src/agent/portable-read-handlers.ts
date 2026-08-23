import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { getActiveWorkbenchRun } from './agent-jobs'
import { listWorkbenchActivity } from './agent-events'
import { listWorkbenchPacketRecords } from './workbench-packet-store'
import { getActiveSourceContext, getSourceIndexState, getSourcesSafe } from './config'
import { handleFocusedRead } from './focused-read'
import { handleGraphContextRouted } from './graph-context-router'
import { Indexer, getIndexedDocumentCountFromDisk } from './indexer'
import { prepareTaskContext } from './prepare-task-context'
import { VaultSearcher } from './search'
import { getResolvedActiveSources, redactSecrets, shouldIncludeEntry, truncateContent } from './safe-access'
import { readFile } from './vault'
import type { PortableExecutionContext, PortableOperationHandlers } from '../../../../apps/web/src/lib/actions/portable-operation-dispatcher'
import { PortableOperationError } from '../../../../apps/web/src/lib/actions/portable-operation-errors'
import { authorizeContextRead } from './context-broker'

const MAX_PATHS = 5
const MAX_FILE_BYTES = 4_000
const LARGE_FILE_BYTES = 100 * 1024

type Payload = Record<string, unknown>

export type PortableReadHandlerDependencies = {
  indexedFiles?: () => number
  indexingActive?: () => boolean
  indexingSourceIds?: () => string[]
  readResponseBudgetBytes?: number
  readMaxBytesPerFile?: number
  searcher?: (sourceIds?: string[]) => VaultSearcher
}

export const MAX_ACTIVE_RUN_ACTIVITY_EVENTS = 40

type ActivityListFn = (
  params: { runId?: string; sourceId?: string; limit?: number }
) => ReturnType<typeof listWorkbenchActivity>

export function projectPortableActiveRunActivity(
  sourceId: string,
  runId: string,
  listActivity: ActivityListFn = listWorkbenchActivity
) {
  return listActivity({ runId, sourceId, limit: MAX_ACTIVE_RUN_ACTIVITY_EVENTS }).projection
}

export function maybeProjectPortableActiveRunActivity(
  sourceId: string,
  runId: string,
  includeActivity: unknown,
  listActivity: ActivityListFn = listWorkbenchActivity
) {
  return includeActivity === true
    ? projectPortableActiveRunActivity(sourceId, runId, listActivity)
    : undefined
}

export function formatPortableActiveRunResponse<T extends object, P, A = never>(
  sourceId: string,
  run: T | null | undefined,
  packets: P[],
  activity?: A
) {
  return {
    status: 'ok' as const,
    sourceId,
    activeRun: run ? { ...run, packets } : null,
    ...(run && activity !== undefined ? { activity } : {})
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function sourceIds(payload: Payload, context?: PortableExecutionContext): string[] {
  if (context?.sourceId) return [context.sourceId]
  const many = Array.isArray(payload.sourceIds) ? payload.sourceIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0) : []
  if (many.length) return many
  const one = asString(payload.sourceId)
  return one ? [one] : getActiveSourceContext().activeSourceIds
}

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) ? Math.max(min, Math.min(max, Math.floor(numeric))) : fallback
}

function fail(code: 'invalid_request' | 'source_mismatch' | 'dependency_unavailable', message: string): never {
  throw new PortableOperationError(code, message)
}

function requireSearchReady(sourceIds: string[]): void {
  const blocked = sourceIds
    .map(sourceId => ({ sourceId, state: getSourceIndexState(sourceId) }))
    .filter(({ state }) => !state || (state.indexStatus !== 'ready' && !(state.indexStatus === 'indexing' && (state.indexedFileCount ?? 0) > 0)))
  if (!blocked.length) return
  const details = blocked.map(item => ({
    sourceId: item.sourceId,
    indexStatus: item.state?.indexStatus || 'unknown',
    indexError: item.state?.indexError,
    indexedFileCount: item.state?.indexedFileCount,
    recoveryAction: item.state?.indexStatus === 'pending' ? 'Reindex from dashboard' : item.state?.indexStatus === 'failed' ? 'Reindex from dashboard or choose a ready source' : 'Choose a ready source'
  }))
  const message = blocked.map(item => item.state?.indexStatus === 'pending'
    ? `${item.sourceId} has not been indexed yet. Reindex it from the dashboard first.`
    : item.state?.indexStatus === 'indexing'
      ? `${item.sourceId} is being reindexed. Searching using the older index.`
      : item.state?.indexStatus === 'failed'
        ? `${item.sourceId} failed to index: ${item.state.indexError || 'unknown error'}. Reindex it from the dashboard.`
        : `${item.sourceId} is not ready for search.`).join(' ')
  throw new PortableOperationError('dependency_unavailable', `Source(s) not ready for search: ${blocked.map(item => item.sourceId).join(', ')}`, { details: { readinessMessage: message, sources: details } })
}

function brokerReadMetadata(sourceId: string, executionContext?: PortableExecutionContext, payload?: Payload) {
  const confirmationState = executionContext?.sourceId
    ? 'execution-context' as const
    : asString(payload?.sourceId)
      ? 'explicit-source-id' as const
      : 'active-source-context' as const
  const contextSessionId = typeof payload?.contextIntelligenceSessionId === 'string' ? payload.contextIntelligenceSessionId : undefined
  const result = authorizeContextRead(sourceId, contextSessionId, confirmationState)
  if (!result.ok) fail('source_mismatch', 'message' in result ? result.message : 'Context Broker authorization failed.')
  return result.metadata
}

async function readPaths(payload: Payload, context?: PortableExecutionContext, dependencies: PortableReadHandlerDependencies = {}): Promise<Record<string, unknown>> {
  const startedAt = Date.now()
  const paths = Array.isArray(payload.paths) ? payload.paths.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).slice(0, MAX_PATHS) : []
  if (!paths.length) fail('invalid_request', 'Paths required')
  const selected = sourceIds(payload, context)
  const targets = getResolvedActiveSources(selected.length ? selected : undefined)
  const contextMetadata = selected.length
    ? selected.map(sourceId => brokerReadMetadata(sourceId, context, payload))
    : []
  const maxBytes = bounded(payload.maxBytesPerFile, dependencies.readMaxBytesPerFile || 3_000, 1_000, MAX_FILE_BYTES)
  const budgetBytes = dependencies.readResponseBudgetBytes || 64 * 1024
  const files: Array<Record<string, unknown>> = []
  const skipped: Array<Record<string, unknown>> = []
  let returnedBytes = 0
  const responseBytes = (file: Record<string, unknown>) => Buffer.byteLength(JSON.stringify(file), 'utf8')
  for (const relPath of (Array.isArray(payload.paths) ? payload.paths : []).slice(MAX_PATHS)) {
    if (typeof relPath === 'string') skipped.push({ path: relPath, reason: 'max_paths_exceeded', suggestedMode: 'read_paths', suggestedNextAction: 'Split read_paths into at most 5 explicit paths.' })
  }
  for (const relPath of paths) {
    let candidate: Record<string, unknown> | undefined
    const errors: string[] = []
    for (const source of targets) {
      try {
        const fullPath = path.resolve(path.join(source.path, path.normalize(relPath)))
        if (!fullPath.startsWith(path.resolve(source.path))) throw new Error('Path escaped the source root')
        const stat = await fsp.stat(fullPath)
        if (!stat.isFile()) throw new Error('Not a file')
        if (stat.size > LARGE_FILE_BYTES) {
          candidate = { sourceId: source.id, path: relPath, contentReturned: false, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString(), reason: 'large_file_requires_focused_read', suggestedMode: 'grep_context' }
          skipped.push({ path: relPath, sourceId: source.id, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString(), reason: 'large_file_requires_focused_read', suggestedMode: 'grep_context', suggestedNextAction: 'Use grep_context with a specific pattern, then read_range around the matching line.', exampleNextCall: { mode: 'grep_context', sourceId: source.id, path: relPath, pattern: '<specific symbol or text>', before: 8, after: 12, maxMatches: 5 } })
          break
        }
        const result = await readFile(relPath, source.id)
        const content = truncateContent(redactSecrets(result.content), maxBytes)
        candidate = { sourceId: source.id, path: relPath, content: content.content, truncated: content.truncated, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() }
        break
      } catch {
        // A path can legitimately resolve in a later explicitly selected source.
        errors.push(source.id)
      }
    }
    if (!candidate) {
      files.push({ path: relPath, error: 'File not found in active sources', sourceErrors: errors.length ? errors : undefined })
      continue
    }
    if (candidate.contentReturned === false) {
      files.push(candidate)
      continue
    }
    if (returnedBytes + responseBytes(candidate) > budgetBytes) {
      skipped.push({ path: relPath, sourceId: candidate.sourceId, sizeBytes: candidate.sizeBytes, reason: 'response_budget_exceeded', suggestedMode: 'read_range', suggestedNextAction: 'Use read_range or grep_context for this file.' })
      continue
    }
    files.push(candidate)
    returnedBytes += responseBytes(candidate)
  }
  const nextBatch = skipped.length ? {
    paths: skipped.map(item => item.path).filter((value): value is string => typeof value === 'string'),
    maxBytesPerFile: maxBytes,
    ...(selected.length ? { sourceIds: selected } : {})
  } : undefined
  return { files, ...(skipped.length ? { skipped } : {}), nextBatch, budgetBytes, returnedBytes, contextMetadata: contextMetadata.length === 1 ? contextMetadata[0] : contextMetadata, timings: { totalMs: Date.now() - startedAt, sourceCount: targets.length, requestedPathCount: paths.length, returnedFileCount: files.length, skippedFileCount: skipped.length } }
}

async function listFiles(payload: Payload, context?: PortableExecutionContext): Promise<Record<string, unknown>> {
  const startedAt = Date.now()
  const relPath = asString(payload.path) || ''
  const depth = bounded(payload.depth, 3, 1, 6)
  const limit = bounded(payload.limit, 100, 1, 100)
  const entries: Array<Record<string, unknown>> = []
  const targets = getResolvedActiveSources(sourceIds(payload, context))
  for (const source of targets) {
    const root = path.resolve(path.join(source.path, path.normalize(relPath)))
    if (!root.startsWith(path.resolve(source.path))) continue
    try {
      if (!(await fsp.stat(root)).isDirectory()) continue
      const walk = async (dir: string, current: string, currentDepth: number): Promise<void> => {
        if (entries.length >= limit || currentDepth >= depth) return
        for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
          if (entries.length >= limit) return
          if (!shouldIncludeEntry(entry.name)) continue
          const next = current ? `${current}/${entry.name}` : entry.name
          const stat = await fsp.stat(path.join(dir, entry.name))
          entries.push({ sourceId: source.id, path: next, type: entry.isDirectory() ? 'directory' : 'file', sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() })
          if (entry.isDirectory()) await walk(path.join(dir, entry.name), next, currentDepth + 1)
        }
      }
      await walk(root, relPath, 0)
    } catch { /* preserve the HTTP endpoint's skip-on-unreadable-source behaviour */ }
  }
  return { sourceId: targets[0]?.id, path: relPath, entries, nextCursor: undefined, cursor: payload.cursor, timings: { totalMs: Date.now() - startedAt, sourceCount: targets.length, entryCount: entries.length, depth, limit } }
}

function makeSearcher(sourceIds?: string[]): VaultSearcher {
  return new VaultSearcher(new Indexer(sourceIds).getDocs())
}

async function readContext(payload: Payload, executionContext?: PortableExecutionContext, dependencies: PortableReadHandlerDependencies = {}): Promise<Record<string, unknown>> {
  const mode = asString(payload.mode)
  if (!mode) fail('invalid_request', 'mode is required')
  if (mode === 'read_paths') return readPaths(payload, executionContext)
  if (mode === 'list_files') return listFiles(payload, executionContext)
  if (mode === 'search_and_read' && !asString(payload.path)) {
    const query = asString(payload.query)
    const selected = sourceIds(payload, executionContext)
    if (!query || !selected.length) fail('invalid_request', 'query and sourceId or sourceIds are required')
    requireSearchReady(selected)
    const search = (dependencies.searcher ? dependencies.searcher(selected) : makeSearcher(selected)).searchBounded(query, bounded(payload.limit, 5, 1, MAX_PATHS), selected, { startedAt: Date.now(), deadlineMs: 1200, maxDocsPerSource: 1500, maxContentDocsPerSource: 350 })
    const matches = search.results.slice(0, MAX_PATHS)
    if (!matches.length) return { mode, results: [], noMatches: true, query, ...(search.sourceWarnings.length ? { sourceWarnings: search.sourceWarnings } : {}) }
    const matchedSourceIds = Array.from(new Set(matches.map(match => typeof match.sourceId === 'string' ? match.sourceId : '').filter(Boolean)))
    const read = await readPaths({ paths: matches.map(match => match.path), sourceIds: matchedSourceIds.length ? matchedSourceIds : selected, maxBytesPerFile: payload.maxBytesPerFile }, undefined)
    return { mode, results: matches.map(match => ({ sourceId: match.sourceId, path: match.path, title: match.title, snippet: match.snippet })), ...read }
  }
  if (mode === 'grep_context' || mode === 'read_range' || mode === 'read_symbol' || mode === 'search_and_read') {
    const sourceId = executionContext?.sourceId || asString(payload.sourceId)
    const filePath = asString(payload.path)
    if (!sourceId || !filePath) fail('invalid_request', 'sourceId and path are required')
    const contextMetadata = brokerReadMetadata(sourceId, executionContext, payload)
    const result = await handleFocusedRead({ ...payload, sourceId, path: filePath, mode } as Parameters<typeof handleFocusedRead>[0])
    if (result.statusCode >= 400) fail(result.statusCode === 404 ? 'source_mismatch' : 'invalid_request', String(result.payload.error || 'Focused read failed'))
    return { ...result.payload, contextMetadata }
  }
  if (mode === 'graph_context') {
    const sourceId = executionContext?.sourceId || asString(payload.sourceId)
    if (!sourceId) fail('invalid_request', 'sourceId is required')
    const contextMetadata = brokerReadMetadata(sourceId, executionContext, payload)
    const result = await handleGraphContextRouted({ sourceId, query: asString(payload.query), limit: bounded(payload.limit, 8, 1, 10) }, {
      sourceResolver: getSourcesSafe,
      telemetryRecorder: () => undefined
    })
    if (result.statusCode >= 400) fail(result.statusCode === 404 ? 'source_mismatch' : 'invalid_request', String(result.payload.error || 'Graph context failed'))
    return { ...result.payload, contextMetadata }
  }
  if (mode === 'active_run') {
    const sourceId = executionContext?.sourceId || asString(payload.sourceId)
    if (!sourceId) fail('invalid_request', 'sourceId is required')
    const source = getSourcesSafe().find(item => item.id === sourceId && item.enabled)
    if (!source) fail('source_mismatch', `Source not found or disabled: ${sourceId}`)
    const run = getActiveWorkbenchRun(sourceId)
    const packets = run && typeof run.id === 'string'
      ? listWorkbenchPacketRecords({ runId: run.id, limit: 10 }).map(record => ({
          packetId: record.packet.packetId,
          taskId: record.packet.taskId,
          status: record.status,
          exactPaths: record.exactPaths,
          reservedAt: record.reservedAt,
          updatedAt: record.updatedAt
        }))
      : []
    const activity = run && typeof run.id === 'string'
      ? maybeProjectPortableActiveRunActivity(sourceId, run.id, payload.includeActivity)
      : undefined
    return formatPortableActiveRunResponse(sourceId, run, packets, activity)
  }
  if (mode === 'search' || mode === 'search_and_read' || mode === 'prepare_task_context') {
    const query = asString(payload.query)
    const selected = sourceIds(payload, executionContext)
    if (!query || !selected.length) fail('invalid_request', 'query and sourceId or sourceIds are required')
    requireSearchReady(selected)
    if (mode === 'prepare_task_context' && selected.length !== 1) {
      fail('dependency_unavailable', 'Context Broker requires one authorized source for task context preparation.')
    }
    const preparation = mode === 'prepare_task_context'
      ? authorizeContextRead(selected[0], typeof payload.contextIntelligenceSessionId === 'string' ? payload.contextIntelligenceSessionId : undefined, executionContext?.sourceId ? 'execution-context' : asString(payload.sourceId) ? 'explicit-source-id' : 'active-source-context')
      : undefined
    if (preparation && !preparation.ok) fail('dependency_unavailable', 'message' in preparation ? preparation.message : 'Context preparation failed.')
    const searcher = dependencies.searcher ? dependencies.searcher(selected) : makeSearcher(selected)
    if (mode === 'prepare_task_context') {
      const prepared = await prepareTaskContext({ query, sourceIds: selected, searcher, limit: bounded(payload.limit, 5, 1, 5), paths: Array.isArray(payload.paths) ? payload.paths.filter((value): value is string => typeof value === 'string').slice(0, MAX_PATHS) : undefined, maxBytesPerFile: bounded(payload.maxBytesPerFile, 3_000, 1_000, MAX_FILE_BYTES) })
      return { ...prepared, contextMetadata: preparation && preparation.ok ? preparation.metadata : undefined }
    }
    const startedAt = Date.now()
    const effectiveQuery = mode === 'search' && !/^(?:content|full):/i.test(query)
      ? `content:${query}`
      : query
    const search = searcher.searchBounded(effectiveQuery, bounded(payload.limit, 5, 1, 10), selected, { startedAt, deadlineMs: 1200, maxDocsPerSource: 1500, maxContentDocsPerSource: 350 })
    return { status: search.results.length === 0 && search.sourceWarnings.length ? 'needs_narrower_scope' : search.partial ? 'partial' : 'ok', results: search.results, ...(search.sourceWarnings.length ? { sourceWarnings: search.sourceWarnings, suggestedNarrowerMode: search.mode === 'content' ? 'grep_context' : 'graph_context', suggestedNextAction: 'Use graph_context for map-level discovery, then grep_context/read_range/read_paths on exact files or paths.' } : {}), timings: { totalMs: Date.now() - startedAt, sourceCount: selected.length, searchedSourceCount: search.searchedSourceCount, searchedDocCount: search.searchedDocCount, totalDocCount: search.totalDocCount, resultCount: search.results.length } }
  }
  fail('invalid_request', `Unsupported read mode: ${mode}`)
}

export function createPortableReadHandlers(dependencies: PortableReadHandlerDependencies = {}): PortableOperationHandlers {
  return {
    getWorkbenchStatus: payload => {
      const include = asString((payload as Payload).include)
      const sources = getSourcesSafe()
      const active = getActiveSourceContext()
      return {
        connected: true,
        sourceCount: sources.length,
        sourcesAvailable: sources.length > 0,
        indexedFiles: dependencies.indexedFiles ? dependencies.indexedFiles() : getIndexedDocumentCountFromDisk(),
        ...(dependencies.indexingActive ? { indexingActive: dependencies.indexingActive() } : {}),
        ...(dependencies.indexingSourceIds ? { indexingSourceIds: dependencies.indexingSourceIds() } : {}),
        ...(include === 'sources' || include === 'all' ? { sources } : {}),
        ...(include === 'active' || include === 'all' ? { activeSourceIds: active.activeSourceIds, contextMode: active.mode } : {})
      }
    },
    readWorkbenchContext: (payload, context) => contextReadWithDependencies(payload as Payload, context, dependencies)
  }
}

async function contextReadWithDependencies(payload: Payload, context: PortableExecutionContext, dependencies: PortableReadHandlerDependencies): Promise<Record<string, unknown>> {
  if (asString(payload.mode) === 'read_paths') return readPaths(payload, context, dependencies)
  return readContext(payload, context, dependencies)
}
