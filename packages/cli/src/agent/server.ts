import Fastify from 'fastify'
import crypto from 'crypto'
import fs from 'fs'
import { promises as fsp } from 'fs'
import path from 'path'
import { Indexer } from './indexer'
import { VaultSearcher } from './search'
import { readFile, createFile, appendFile, listFolder } from './vault'
import { logToFile } from '../utils/logger'
import { createExportPlan } from './export'
import { loadConfig, getWorkspaces, getSources, getSourcesSafe, addSource, removeSource, setSourceEnabled, setSourceAutoIndex, markSourceAutoIndexed, getSourceDiscoverySettings, setSourceDiscoverySettings, discoverRepositories, getActiveSourceContext, setActiveSourceContext, getWriteMode, setWriteMode, getSourceIndexState, setSourceIndexStatus } from './config'
import { reconcileIndexStateFromDocs, flushIndexStateOnShutdown } from './index-state'
import { listWorkspaceTree, grepWorkspace, getWorkspaceInfo, resolveWorkspacePath, validateWorkspacePath } from './workspace'
import { getResolvedActiveSources, isAllowedArtifactRoot, isAllowedSafeWriteRoot, isBlockedWritePath, redactSecrets, resolveTargetSourceId, resolveWithinSource, shouldIncludeEntry, truncateContent, getDefaultWritePolicy, validateWriteTarget, normalizeRepoRelativePath } from './safe-access'
import type { Workspace } from '@buildflow/shared'
import { buildArtifactFilename, normalizeArtifactSlug, verifyWrittenFile } from './write-verification'
import { getAllowedCommandKinds, runSafeCommand, type SafeCommandKind } from './command-runner'
import { compactAgentJob, controlAgentJob, getAgentJob, listAgentJobs, startAgentJob, updateAgentJob, type AgentJobControlAction } from './agent-jobs'
import { listAgentEvents, appendAgentEvent } from './agent-events'
import { startLocalAgentPreflight } from './agent-runtime'
import { GPT_ACTION_DEFAULT_FILE_BYTES, GPT_ACTION_RESPONSE_BUDGET_BYTES } from './payload-budget'
import { prepareTaskContext } from './prepare-task-context'
import { handleFocusedRead } from './focused-read'

let cliVersion = '1.2.13-beta'
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf-8')) as { version?: string }
  if (pkg.version) cliVersion = pkg.version
} catch {
  // fallback to hardcoded version if package.json not found
}

export async function startLocalServer(port: number = 3052): Promise<void> {
  const fastify = Fastify({ logger: true })
  const READ_FILES_RESPONSE_BUDGET_BYTES = GPT_ACTION_RESPONSE_BUDGET_BYTES
  const DEFAULT_READ_FILES_MAX_BYTES_PER_FILE = GPT_ACTION_DEFAULT_FILE_BYTES

  const indexer = new Indexer()
  const config = loadConfig()
  const indexingSources = new Set<string>()
  let searcher = new VaultSearcher(indexer.getDocs())

  // Do not block local server startup on a full index build. If no index is present,
  // mark sources pending and let the background startup queue index one source at a time.
  if (indexer.getDocs().length === 0) {
    console.log('[Indexer] No existing index found; starting server and indexing pending sources in background.')
  }
  reconcileIndexStateFromDocs(indexer.getDocs(), getSourcesSafe())

  // Ensure pending enabled sources without usable index are queued for immediate indexing at startup
  const queuePendingSourcesAtStartup = (): void => {
    const sources = getSourcesSafe()
    for (const source of sources) {
      if (!source.enabled || source.indexStatus !== 'pending' || indexingSources.has(source.id)) continue
      // Only auto-index if source has no previous index (indexedFileCount is 0 or undefined)
      if ((source.indexedFileCount ?? 0) > 0) {
        console.log(`[Startup] Skipping startup reindex for ${source.id} (has usable previous index with ${source.indexedFileCount} files)`)
        continue
      }
      console.log(`[Startup] Queuing pending source for initial indexing: ${source.id}`)
      reindexSourceInBackground(source.id, source.path, 'auto')
      break // Only start one at a time; others will be picked up by the sweep
    }
  }
  setTimeout(queuePendingSourcesAtStartup, 1000)

  const assertWriteMode = (isArtifact = false, relPath?: string): void => {
    const mode = getWriteMode()
    if (mode === 'readOnly') {
      throw new Error('Write mode is readOnly')
    }
    if (mode === 'artifactsOnly') {
      if (!relPath || !isAllowedArtifactRoot(relPath)) {
        throw new Error('Write mode blocks non-artifact paths')
      }
      if (!relPath.startsWith('docs/product') && !relPath.startsWith('.buildflow')) {
        throw new Error('Write mode blocks non-artifact paths')
      }
    }
  }

  const writeError = (reply: any, code: number, payload: Record<string, unknown>) =>
    reply.code(code).send({ status: 'error', verified: false, ...payload })

  const verifiedWrite = (fullPath: string) => {
    const content = fs.readFileSync(fullPath, 'utf8')
    return {
      verified: true,
      verifiedAt: new Date().toISOString(),
      bytesOnDisk: Buffer.byteLength(content, 'utf8'),
      contentHash: crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
      contentPreview: content.slice(0, 200)
    }
  }

  const buildConfirmationToken = (sourceId: string, operation: string, normalizedPath: string, toPath?: string) =>
    `confirm:${sourceId}:${operation}:${normalizedPath}${toPath ? `->${toPath}` : ''}`

  const confirmationPayload = (
    sourceId: string,
    operation: string,
    requestedPath: string,
    normalizedPath: string,
    reason: string,
    summary: string,
    matchedConfirmationGlob?: string,
    toPath?: string
  ) => ({
    status: 'needs_confirmation',
    code: 'REQUIRES_EXPLICIT_CONFIRMATION',
    sourceId,
    operation,
    requestedPath,
    normalizedPath,
    ...(toPath ? { to: toPath } : {}),
    reason,
    summary,
    matchedConfirmationGlob,
    confirmationToken: buildConfirmationToken(sourceId, operation, normalizedPath, toPath)
  })

  const confirmOperation = (body: Record<string, unknown>, sourceId: string, operation: string, normalizedPath: string, toPath?: string) => {
    const expected = buildConfirmationToken(sourceId, operation, normalizedPath, toPath)
    if (body.confirmationToken === expected) return true
    if (body.confirmedByUser === true) return true
    return false
  }

  const countRecursiveEntries = (targetPath: string) => {
    let files = 0
    let directories = 0
    const walk = (current: string) => {
      if (!fs.existsSync(current)) return
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const next = path.join(current, entry.name)
        if (entry.isDirectory()) {
          directories += 1
          walk(next)
        } else {
          files += 1
        }
      }
    }
    walk(targetPath)
    return { files, directories }
  }

  const ensureParentDirectory = (targetPath: string, allowRecursive: boolean) => {
    const parent = path.dirname(targetPath)
    if (fs.existsSync(parent)) return true
    if (allowRecursive) {
      fs.mkdirSync(parent, { recursive: true })
      return true
    }
    return false
  }

  const refreshSearcherFromDocs = (): void => {
    const docs = indexer.getDocs()
    reconcileIndexStateFromDocs(docs, getSourcesSafe())
    searcher.rebuild(docs)
  }

  const reindexSourceInBackground = (sourceId: string, sourcePath: string, reason: 'manual' | 'auto' | 'add' = 'manual'): boolean => {
    if (indexingSources.has(sourceId)) return false

    setSourceIndexStatus(sourceId, {
      indexed: false,
      indexStatus: 'indexing',
      indexError: undefined
    })

    indexingSources.add(sourceId)
    void (async () => {
      try {
        const indexedFileCount = await indexer.buildIndexForSource(sourceId, sourcePath)
        refreshSearcherFromDocs()
        const completedAt = new Date().toISOString()
        setSourceIndexStatus(sourceId, {
          indexed: true,
          indexStatus: 'ready',
          indexedFileCount,
          lastIndexedAt: completedAt,
          indexError: undefined
        })
        if (reason === 'auto') {
          markSourceAutoIndexed(sourceId, completedAt)
        }
      } catch (err) {
        setSourceIndexStatus(sourceId, {
          indexed: false,
          indexStatus: 'failed',
          indexError: String(err)
        })
      } finally {
        indexingSources.delete(sourceId)
      }
    })().catch(err => {
      console.error(`Background reindex failed for ${sourceId}:`, err)
    })
    return true
  }

  const shouldAutoIndexSource = (source: ReturnType<typeof getSourcesSafe>[number], now: number): boolean => {
    if (!source.enabled || source.autoIndexEnabled === false) return false
    if (source.indexStatus === 'indexing' || indexingSources.has(source.id)) return false
    try {
      if (!fs.existsSync(source.path) || !fs.statSync(source.path).isDirectory()) return false
    } catch {
      return false
    }
    const intervalMs = Math.max(1, source.autoIndexIntervalMinutes || 5) * 60_000
    const lastRun = source.lastAutoIndexedAt || source.lastIndexedAt
    if (!lastRun) return true
    const lastRunMs = Date.parse(lastRun)
    if (!Number.isFinite(lastRunMs)) return true
    return now - lastRunMs >= intervalMs
  }

  const runAutoIndexSweep = (): void => {
    const now = Date.now()
    for (const source of getSourcesSafe()) {
      if (indexingSources.size > 0) break
      if (!shouldAutoIndexSource(source, now)) continue
      reindexSourceInBackground(source.id, source.path, 'auto')
    }
  }

  const autoIndexTimer = setInterval(runAutoIndexSweep, 30_000)
  autoIndexTimer.unref?.()
  fastify.addHook('onClose', async () => clearInterval(autoIndexTimer))

  const rejectUnindexedSources = (sourceIds: string[], reply: any) => {
    const blocked = sourceIds
      .map(sourceId => ({ sourceId, state: getSourceIndexState(sourceId) }))
      .filter(({ state }) => {
        if (!state) return true
        if (state.indexStatus === 'ready') return false
        // Allow search to proceed with older index if currently reindexing and has indexed documents
        if (state.indexStatus === 'indexing' && (state.indexedFileCount ?? 0) > 0) return false
        return true
      })

    if (blocked.length > 0) {
      const messages = blocked.map(item => {
        if (item.state?.indexStatus === 'pending') {
          return `${item.sourceId} has not been indexed yet. Reindex it from the dashboard first.`
        }
        if (item.state?.indexStatus === 'indexing') {
          return `${item.sourceId} is being reindexed. Searching using the older index.`
        }
        if (item.state?.indexStatus === 'failed') {
          return `${item.sourceId} failed to index: ${item.state.indexError || 'unknown error'}. Reindex it from the dashboard.`
        }
        return `${item.sourceId} is not ready for search.`
      })

      return reply.code(409).send({
        error: `Source(s) not ready for search: ${blocked.map(item => item.sourceId).join(', ')}`,
        message: messages.join(' '),
        details: blocked.map(item => ({
          sourceId: item.sourceId,
          indexStatus: item.state?.indexStatus || 'unknown',
          indexError: item.state?.indexError,
          indexedFileCount: item.state?.indexedFileCount,
          recoveryAction: item.state?.indexStatus === 'pending'
            ? 'Reindex from dashboard'
            : item.state?.indexStatus === 'failed'
              ? 'Reindex from dashboard or choose a ready source'
              : 'Choose a ready source'
        }))
      })
    }

    return null
  }

  // Health endpoint
  fastify.get('/health', async (request, reply) => {
      return {
        status: 'ok',
        port,
        vaultPath: config?.vaultPath || 'not configured',
        indexedFiles: indexer.getDocs().length,
        indexingActive: indexingSources.size > 0,
        indexingSourceIds: Array.from(indexingSources),
        version: cliVersion
      }
  })

  // Status endpoint
  fastify.post<{ Body: Record<string, unknown> }>('/api/status', async (request, reply) => {
    return {
      online: true,
      deviceName: 'Local Agent',
      vaultConnected: true
    }
  })

  fastify.get('/api/status', async (request, reply) => {
    try {
      const sources = getSourcesSafe()
      const sourceCount = sources.length

      return reply.header('Cache-Control', 'no-store').send({
        connected: true,
        sourceCount,
        sourcesAvailable: sourceCount > 0,
        indexedFiles: indexer.getDocs().length,
        indexingActive: indexingSources.size > 0,
        indexingSourceIds: Array.from(indexingSources)
      })
    } catch (err) {
      return reply.code(500).header('Cache-Control', 'no-store').send({
        error: String(err)
      })
    }
  })

  fastify.get('/api/commands/allowed', async (request, reply) => {
    return reply.header('Cache-Control', 'no-store').send({
      status: 'ok',
      commandKinds: getAllowedCommandKinds()
    })
  })

  fastify.post<{ Body: { sourceId: string; goal: string; maxIterations?: number; autonomyLevel?: 'supervised' | 'hands_off_safe'; documentationPath?: string; reviewEveryStep?: boolean; autoCommit?: boolean; autoPush?: boolean; full?: boolean } }>('/api/agent-jobs/start', async (request, reply) => {
    try {
      const { sourceId, goal, maxIterations, autonomyLevel, documentationPath, reviewEveryStep, autoCommit, autoPush, full } = request.body
      if (!sourceId || typeof sourceId !== 'string') return reply.code(400).send({ error: 'sourceId is required' })
      const source = getSourcesSafe().find(item => item.id === sourceId)
      if (!source || !source.enabled) return reply.code(404).send({ error: `Source not found or disabled: ${sourceId}` })
      if (source.indexStatus !== 'ready') return reply.code(409).send({ error: `Source is not ready for sequential work: ${sourceId}`, indexStatus: source.indexStatus })
      const job = startAgentJob({ sourceId, goal, maxIterations, autonomyLevel, documentationPath, reviewEveryStep, autoCommit, autoPush })
      appendAgentEvent({
        jobId: job.id,
        sourceId,
        type: 'job_started',
        message: 'Sequential job created. Custom GPT remains the reasoning and coding engine; local BuildFlow handles deterministic control-plane work.',
        status: job.status
      })
      if (autonomyLevel === 'hands_off_safe') {
        setImmediate(() => startLocalAgentPreflight({ jobId: job.id, sourceId, sourceRoot: source.path }))
      }
      return reply.header('Cache-Control', 'no-store').send({ status: 'ok', job: full === true ? job : compactAgentJob(job) })
    } catch (err) {
      return reply.code(400).header('Cache-Control', 'no-store').send({ error: String(err) })
    }
  })

  fastify.post<{ Body: { jobId?: string; status?: 'queued' | 'running' | 'paused' | 'cancelled' | 'needs_confirmation' | 'blocked' | 'completed' | 'failed'; currentIteration?: number; blockedReason?: string; requiresConfirmation?: boolean; confirmationReason?: string; nextActions?: string[]; summary?: string; lastKnownGitStatus?: string; roadmapPhases?: any[]; activeTaskId?: string; completedTaskCount?: number; full?: boolean; limit?: number } }>('/api/agent-jobs/status', async (request, reply) => {
    try {
      const { jobId, full, limit, ...patch } = request.body || {}
      if (!jobId) {
        const maxJobs = Math.min(20, Math.max(1, Number(limit || 10)))
        const jobs = listAgentJobs().slice(0, maxJobs)
        const events = listAgentEvents({ limit: 20 })
        return reply.header('Cache-Control', 'no-store').send({
          status: 'ok',
          jobs: full === true ? jobs : jobs.map(compactAgentJob),
          events: events.events,
          eventBytes: events.returnedBytes,
          eventBudgetBytes: events.budgetBytes
        })
      }
      const job = Object.keys(patch).length > 0 ? updateAgentJob(jobId, patch) : getAgentJob(jobId)
      if (!job) return reply.code(404).send({ error: `Agent job not found: ${jobId}` })
      const events = listAgentEvents({ jobId, limit: 20 })
      return reply.header('Cache-Control', 'no-store').send({
        status: 'ok',
        job: full === true ? job : compactAgentJob(job),
        events: events.events,
        eventBytes: events.returnedBytes,
        eventBudgetBytes: events.budgetBytes
      })
    } catch (err) {
      return reply.code(400).header('Cache-Control', 'no-store').send({ error: String(err) })
    }
  })

  fastify.post<{ Body: { jobId: string; action?: AgentJobControlAction | 'events'; reason?: string; limit?: number; full?: boolean } }>('/api/agent-jobs/control', async (request, reply) => {
    try {
      const { jobId, action = 'events', reason, limit, full } = request.body || {}
      if (!jobId || typeof jobId !== 'string') return reply.code(400).send({ error: 'jobId is required' })
      const existing = getAgentJob(jobId)
      if (!existing) return reply.code(404).send({ error: `Agent job not found: ${jobId}` })

      let job = existing
      if (action === 'pause' || action === 'resume' || action === 'cancel') {
        job = controlAgentJob(jobId, action, reason)
        appendAgentEvent({
          jobId,
          sourceId: job.sourceId,
          type: action === 'pause' ? 'job_paused' : action === 'resume' ? 'control_requested' : 'job_cancelled',
          message: reason ? `${action} requested: ${reason}` : `${action} requested.`,
          status: job.status
        })
        if (action === 'resume' && job.autonomyLevel === 'hands_off_safe') {
          const source = getSourcesSafe().find(item => item.id === job.sourceId)
          if (source?.enabled) setImmediate(() => startLocalAgentPreflight({ jobId: job.id, sourceId: job.sourceId, sourceRoot: source.path }))
        }
      } else if (action !== 'events') {
        return reply.code(400).send({ error: `Unsupported control action: ${action}` })
      }

      const events = listAgentEvents({ jobId, limit })
      return reply.header('Cache-Control', 'no-store').send({
        status: 'ok',
        action,
        job: full === true ? job : compactAgentJob(job),
        events: events.events,
        returnedBytes: events.returnedBytes,
        budgetBytes: events.budgetBytes
      })
    } catch (err) {
      return reply.code(400).header('Cache-Control', 'no-store').send({ error: String(err) })
    }
  })

  fastify.post<{ Body: { sourceId: string; commandKind: SafeCommandKind; timeoutMs?: number; paths?: string[]; packageDir?: string; scriptName?: string; marker?: string; message?: string; body?: string; remote?: string; branch?: string; patternSet?: 'forbidden_runtime_execution' | 'forbidden_secret_material' | 'forbidden_upload_network' | 'forbidden_all_high_risk'; confirmedByUser?: boolean; confirmationToken?: string } }>('/api/commands/run', async (request, reply) => {
    try {
      const { sourceId, commandKind, timeoutMs, paths, packageDir, scriptName, marker, message, body, remote, branch, patternSet, confirmedByUser, confirmationToken } = request.body
      if (!sourceId || typeof sourceId !== 'string') return reply.code(400).send({ error: 'sourceId is required' })
      if (!commandKind || !getAllowedCommandKinds().includes(commandKind)) return reply.code(400).send({ error: 'commandKind is not allowlisted' })
      const source = getSourcesSafe().find(item => item.id === sourceId)
      if (!source || !source.enabled) return reply.code(404).send({ error: `Source not found or disabled: ${sourceId}` })
      const result = await runSafeCommand({ sourceId, sourceRoot: source.path, commandKind, timeoutMs, paths, packageDir, scriptName, marker, message, body, remote, branch, patternSet, confirmedByUser, confirmationToken })
      return reply.header('Cache-Control', 'no-store').send(result)
    } catch (err) {
      return reply.code(400).header('Cache-Control', 'no-store').send({ error: String(err) })
    }
  })

  // Search endpoint
  fastify.post<{ Body: { query: string; limit?: number; sourceId?: string; sourceIds?: string[] } }>('/api/search', async (request, reply) => {
    const startedAt = Date.now()
    try {
      const { query, limit = 10, sourceId, sourceIds } = request.body
      const resolveStartedAt = Date.now()
      const resolvedSourceIds = sourceIds && sourceIds.length > 0 ? sourceIds : sourceId ? [sourceId] : getActiveSourceContext().activeSourceIds
      const sourceResolveMs = Date.now() - resolveStartedAt
      const readinessStartedAt = Date.now()
      const rejection = rejectUnindexedSources(resolvedSourceIds, reply)
      const readinessMs = Date.now() - readinessStartedAt
      if (rejection) return rejection
      const searchStartedAt = Date.now()
      const results = searcher.search(query, limit, resolvedSourceIds)
      const searchMs = Date.now() - searchStartedAt

      logToFile({
        timestamp: new Date().toISOString(),
        tool: 'search',
        status: 'success'
      })

      return {
        results,
        timings: {
          totalMs: Date.now() - startedAt,
          sourceResolveMs,
          readinessMs,
          searchMs,
          sourceCount: resolvedSourceIds.length,
          resultCount: results.length
        }
      }
    } catch (err) {
      return reply.code(400).send({ error: String(err), timings: { totalMs: Date.now() - startedAt } })
    }
  })

  fastify.post<{ Body: { query: string; sourceId?: string; sourceIds?: string[]; limit?: number; paths?: string[]; maxBytesPerFile?: number } }>('/api/prepare-task-context', async (request, reply) => {
    try {
      const { query, sourceId, sourceIds, limit, paths, maxBytesPerFile } = request.body
      if (!query || typeof query !== 'string') return reply.code(400).send({ error: 'query is required' })
      const resolvedSourceIds = sourceIds && sourceIds.length > 0 ? sourceIds : sourceId ? [sourceId] : getActiveSourceContext().activeSourceIds
      if (resolvedSourceIds.length === 0) return reply.code(400).send({ error: 'sourceId or sourceIds required' })
      const rejection = rejectUnindexedSources(resolvedSourceIds, reply)
      if (rejection) return rejection

      const prepared = await prepareTaskContext({
        query,
        sourceIds: resolvedSourceIds,
        searcher,
        limit,
        paths,
        maxBytesPerFile
      })

      return reply.header('Cache-Control', 'no-store').send(prepared)
    } catch (err) {
      return reply.code(400).header('Cache-Control', 'no-store').send({ error: String(err) })
    }
  })

  fastify.post<{ Body: { mode: 'grep_context' | 'read_range' | 'read_symbol' | 'search_and_read'; sourceId: string; path: string; pattern?: string; query?: string; regex?: boolean; before?: number; after?: number; maxMatches?: number; startLine?: number; endLine?: number; symbol?: string } }>('/api/focused-read', async (request, reply) => {
    const result = await handleFocusedRead(request.body)
    return reply.code(result.statusCode).header('Cache-Control', 'no-store').send(result.payload)
  })

  // Read endpoint (multi-source aware with guardrails)
  fastify.post<{ Body: { path: string; workspace?: string; sourceId?: string; sourceIds?: string[]; maxBytes?: number } }>('/api/read', async (request, reply) => {
    try {
      const { path: relPath, workspace, sourceId, sourceIds, maxBytes = 60000 } = request.body

      if (workspace) {
        // Workspace-aware read with guardrails
        const ws = getWorkspaceInfo(workspace)
        const validation = validateWorkspacePath(ws, relPath)
        if (!validation.valid) {
          return reply.code(400).send({ error: validation.error })
        }

        const fullPath = resolveWorkspacePath(ws, relPath)

        // Check file existence and size
        if (!fs.existsSync(fullPath)) {
          return reply.code(404).send({ error: 'File not found' })
        }

        const stat = fs.statSync(fullPath)
        if (!stat.isFile()) {
          return reply.code(400).send({ error: 'Not a file' })
        }

        // Enforce safe file size limit (1MB)
        const maxSize = 1024 * 1024
        if (stat.size > maxSize) {
          return reply.code(400).send({ error: `File too large (${stat.size} bytes, max ${maxSize})` })
        }

        const content = fs.readFileSync(fullPath, 'utf-8')

        logToFile({
          timestamp: new Date().toISOString(),
          tool: 'read_file',
          path: relPath,
          workspace,
          status: 'success',
          size: stat.size
        })

        return { path: relPath, content }
      } else {
        const resolvedSourceIds = sourceIds && sourceIds.length > 0 ? sourceIds : sourceId ? [sourceId] : getActiveSourceContext().activeSourceIds
        const targets = getResolvedActiveSources(resolvedSourceIds.length > 0 ? resolvedSourceIds : undefined)
        const matches: Array<{ sourceId: string; content: string; size: number; modifiedAt: string }> = []
        const errors: Array<{ sourceId: string; error: string }> = []
        for (const sid of targets.map(source => source.id)) {
          try {
            const result = await readFile(relPath, sid)
            const fullMatch = targets.find(source => source.id === sid)
            if (!fullMatch) continue
            const fullPath = path.join(fullMatch.path, path.normalize(relPath))
            const stat = fs.statSync(fullPath)
            matches.push({ sourceId: sid, content: result.content, size: stat.size, modifiedAt: stat.mtime.toISOString() })
          } catch (err) {
            errors.push({ sourceId: sid, error: String(err) })
          }
        }
        if (matches.length === 0) {
          return reply.code(404).send({ error: 'File not found in active sources', attemptedSourceErrors: errors.length > 0 ? errors : undefined })
        }
        if (!sourceId && matches.length > 1) {
          return reply.code(400).send({ error: `Ambiguous path across active sources: ${matches.map(m => m.sourceId).join(', ')}` })
        }
        const chosen = matches[0]
        const content = redactSecrets(chosen.content)
        const truncated = truncateContent(content, maxBytes)
        return { sourceId: chosen.sourceId, path: relPath, content: truncated.content, truncated: truncated.truncated, sizeBytes: chosen.size, modifiedAt: chosen.modifiedAt }
      }
    } catch (err) {
      return reply.code(400).send({ error: String(err) })
    }
  })

  fastify.post<{ Body: { sourceId?: string; sourceIds?: string[]; paths: string[]; maxBytesPerFile?: number } }>('/api/read-files', async (request, reply) => {
    const startedAt = Date.now()
    try {
      const { sourceId, sourceIds, paths: relPaths, maxBytesPerFile = DEFAULT_READ_FILES_MAX_BYTES_PER_FILE } = request.body
      if (!Array.isArray(relPaths) || relPaths.length === 0) return reply.code(400).send({ error: 'Paths required' })
      const resolvedSourceIds = sourceIds && sourceIds.length > 0 ? sourceIds : sourceId ? [sourceId] : getActiveSourceContext().activeSourceIds
      const targets = getResolvedActiveSources(resolvedSourceIds.length > 0 ? resolvedSourceIds : undefined)
      const files: Array<Record<string, unknown>> = []
      const skipped: Array<Record<string, unknown>> = []
      const normalizedPaths = relPaths.slice(0, 10)
      let returnedBytes = 0

      const approxResponseBytes = (file: { sourceId?: string; path: string; content?: string; truncated?: boolean; sizeBytes?: number; modifiedAt?: string }) =>
        Buffer.byteLength(JSON.stringify(file), 'utf8')

      for (const relPath of normalizedPaths) {
        let found = false
        const pathErrors: string[] = []
        let bestCandidate: { sourceId: string; content: string; sizeBytes: number; modifiedAt: string; truncated: boolean; responseBytes: number } | null = null
        for (const source of targets) {
          try {
            const result = await readFile(relPath, source.id)
            const content = redactSecrets(result.content)
            const truncated = truncateContent(content, maxBytesPerFile)
            const fullPath = path.join(source.path, path.normalize(relPath))
            const stat = await fsp.stat(fullPath)
            const candidate = {
              sourceId: source.id,
              path: relPath,
              content: truncated.content,
              truncated: truncated.truncated,
              sizeBytes: stat.size,
              modifiedAt: stat.mtime.toISOString()
            }
            bestCandidate = {
              ...candidate,
              responseBytes: approxResponseBytes(candidate)
            }
            found = true
            break
          } catch (err) {
            pathErrors.push(`${source.id}: ${String(err)}`)
          }
        }
        if (!found || !bestCandidate) {
          files.push({ path: relPath, error: 'File not found in active sources', sourceErrors: pathErrors.length > 0 ? pathErrors : undefined })
          continue
        }

        const wouldExceedBudget = returnedBytes + bestCandidate.responseBytes > READ_FILES_RESPONSE_BUDGET_BYTES
        const fileTooLarge = bestCandidate.sizeBytes > maxBytesPerFile
        if (wouldExceedBudget) {
          skipped.push({
            path: relPath,
            sourceId: bestCandidate.sourceId,
            sizeBytes: bestCandidate.sizeBytes,
            reason: fileTooLarge ? 'file_too_large' : 'response_budget_exceeded'
          })
          continue
        }

        files.push({
          sourceId: bestCandidate.sourceId,
          path: relPath,
          content: bestCandidate.content,
          truncated: bestCandidate.truncated,
          sizeBytes: bestCandidate.sizeBytes,
          modifiedAt: bestCandidate.modifiedAt
        })
        returnedBytes += bestCandidate.responseBytes
      }
      const nextBatch = skipped.length > 0
        ? {
            paths: skipped.map(item => item.path).filter((value): value is string => typeof value === 'string' && value.length > 0),
            maxBytesPerFile,
            ...(sourceIds && sourceIds.length > 0 ? { sourceIds } : sourceId ? { sourceId } : resolvedSourceIds.length > 0 ? { sourceIds: resolvedSourceIds } : {})
          }
        : undefined
      return {
        files,
        skipped: skipped.length > 0 ? skipped : undefined,
        nextBatch,
        budgetBytes: READ_FILES_RESPONSE_BUDGET_BYTES,
        returnedBytes,
        timings: {
          totalMs: Date.now() - startedAt,
          sourceCount: targets.length,
          requestedPathCount: normalizedPaths.length,
          returnedFileCount: files.length,
          skippedFileCount: skipped.length
        }
      }
    } catch (err) {
      return reply.code(400).send({ error: String(err), timings: { totalMs: Date.now() - startedAt } })
    }
  })

  fastify.post<{ Body: { sourceId?: string; mode?: 'single' | 'multi' | 'all'; activeSourceIds?: string[] }; Querystring: { lite?: string } }>('/api/get-active-sources', async (request) => {
    const active = getActiveSourceContext()
    if (request.query?.lite === '1' || request.query?.lite === 'true') {
      return { mode: active.mode, activeSourceIds: active.activeSourceIds, sources: [] }
    }
    const sources = getSourcesSafe().map(source => ({ ...source, active: active.activeSourceIds.includes(source.id), type: (source as any).type || 'unknown' }))
    return { mode: active.mode, activeSourceIds: active.activeSourceIds, sources }
  })

  fastify.post<{ Body: { mode: 'single' | 'multi' | 'all'; activeSourceIds?: string[] } }>('/api/set-active-sources', async (request, reply) => {
    try {
      const { mode, activeSourceIds = [] } = request.body
      const result = setActiveSourceContext(mode, activeSourceIds)
      const sources = getSourcesSafe().map(source => ({ ...source, active: result.activeSourceIds.includes(source.id), type: (source as any).type || 'unknown' }))

      return { status: 'ok', mode: result.mode, activeSourceIds: result.activeSourceIds, sources }
    } catch (err) {
      return reply.code(400).send({ error: String(err) })
    }
  })

  fastify.get('/api/write-mode', async () => {
    return { writeMode: getWriteMode() }
  })

  fastify.post<{ Body: { writeMode: 'readOnly' | 'artifactsOnly' | 'safeWrites' } }>('/api/write-mode', async (request, reply) => {
    try {
      const { writeMode } = request.body
      return { writeMode: setWriteMode(writeMode) }
    } catch (err) {
      return reply.code(400).send({ error: String(err) })
    }
  })

  fastify.post<{ Body: { sourceId?: string; artifactType: string; title: string; content: string; folder?: string; filename?: string } }>('/api/create-artifact', async (request, reply) => {
    try {
      const { sourceId, artifactType, title, content, folder, filename } = request.body
      const defaults: Record<string, string> = {
        implementation_plan: 'docs/product/plans',
        codex_prompt: 'docs/product/prompts/codex',
        claude_prompt: 'docs/product/prompts/claude',
        architecture_note: 'docs/product/architecture',
        research_summary: 'docs/product/research',
        test_plan: 'docs/product/testing',
        migration_plan: 'docs/product/migrations',
        task_brief: 'docs/product/tasks',
        general_doc: 'docs/product/notes'
      }
      const targetFolder = folder || defaults[artifactType]
      if (!targetFolder) return reply.code(400).send({ error: 'Unknown artifact type' })
      assertWriteMode(true, targetFolder)
      const relFilename = buildArtifactFilename(title, filename)
      const relPath = `${targetFolder.replace(/\/$/, '')}/${Date.now()}-${relFilename}`
      const resolvedSourceId = resolveTargetSourceId(sourceId)
      const sourceRoot = getResolvedActiveSources([resolvedSourceId])[0]?.path
      const validation = validateWriteTarget({ sourceId: resolvedSourceId, requestedPath: relPath, changeType: 'create', sourceRoot })
      if (!validation.ok) {
        const blocked = validation as Extract<typeof validation, { ok: false }>
        return writeError(reply, 403, {
          sourceId: resolvedSourceId,
          path: blocked.requestedPath,
          requestedPath: blocked.requestedPath,
          normalizedPath: blocked.normalizedPath,
          sourceRootRelativePath: blocked.sourceRootRelativePath,
          changeType: 'create',
          error: { ...blocked.error, policy: blocked.policy }
        })
      }
      if (fs.existsSync(validation.fullPath)) return reply.code(409).send({ error: 'Artifact already exists' })
      fs.mkdirSync(validation.parentPath, { recursive: true })
      fs.writeFileSync(validation.fullPath, content, 'utf-8')
      return { status: 'created', sourceId: resolvedSourceId, requestedPath: relPath, normalizedPath: validation.normalizedPath, path: relPath, artifactType, created: true, ...verifiedWrite(validation.fullPath) }
    } catch (err) {
      return reply.code(400).send({ error: String(err) })
    }
  })

  fastify.post<{ Body: { sourceId?: string; sourceIds?: string[]; path?: string; depth?: number; limit?: number; cursor?: string } }>('/api/list-files', async (request, reply) => {
    const startedAt = Date.now()
    try {
      const { sourceId, sourceIds, path: relPath = '', depth = 3, limit = 100, cursor } = request.body
      const resolvedSourceIds = sourceIds && sourceIds.length > 0 ? sourceIds : sourceId ? [sourceId] : getActiveSourceContext().activeSourceIds
      const targets = getResolvedActiveSources(resolvedSourceIds.length > 0 ? resolvedSourceIds : undefined)
      const entries: Array<Record<string, unknown>> = []

      for (const source of targets) {
        const fullPath = path.resolve(path.join(source.path, path.normalize(relPath)))
        if (!fullPath.startsWith(path.resolve(source.path))) continue
        let stat: fs.Stats
        try {
          stat = await fsp.stat(fullPath)
        } catch {
          continue
        }
        if (!stat.isDirectory()) continue

        const walk = async (dir: string, currentRel: string, currentDepth: number): Promise<void> => {
          if (entries.length >= limit || currentDepth > depth) return
          const dirEntries = await fsp.readdir(dir, { withFileTypes: true })
          for (const entry of dirEntries) {
            if (entries.length >= limit) break
            if (!shouldIncludeEntry(entry.name)) continue
            const nextRel = currentRel ? `${currentRel}/${entry.name}` : entry.name
            const nextFull = path.join(dir, entry.name)
            const nextStat = await fsp.stat(nextFull)
            entries.push({
              sourceId: source.id,
              path: nextRel,
              type: entry.isDirectory() ? 'directory' : 'file',
              sizeBytes: nextStat.size,
              modifiedAt: nextStat.mtime.toISOString()
            })
            if (entry.isDirectory() && currentDepth + 1 < depth) await walk(nextFull, nextRel, currentDepth + 1)
          }
        }

        await walk(fullPath, relPath, 0)
      }

      return {
        sourceId: targets[0]?.id,
        path: relPath,
        entries,
        nextCursor: undefined,
        cursor,
        timings: {
          totalMs: Date.now() - startedAt,
          sourceCount: targets.length,
          entryCount: entries.length,
          depth,
          limit
        }
      }
    } catch (err) {
      return reply.code(400).send({ error: String(err), timings: { totalMs: Date.now() - startedAt } })
    }
  })

  fastify.post<{ Body: { sourceId?: string; path: string; content: string; mode?: 'createOnly' | 'overwrite'; reason?: string; confirmedByUser?: boolean; confirmationToken?: string } }>('/api/write-file', async (request, reply) => {
    try {
      const { sourceId, path: relPath, content, mode = 'createOnly' } = request.body
      assertWriteMode(false, relPath)
      if (!relPath || typeof content !== 'string') return reply.code(400).send({ error: 'Path and content required' })
      const resolvedSourceId = resolveTargetSourceId(sourceId)
      const sourceRoot = getResolvedActiveSources([resolvedSourceId])[0]?.path
      const validation = validateWriteTarget({ sourceId: resolvedSourceId, requestedPath: relPath, changeType: mode === 'overwrite' ? 'overwrite' : 'create', sourceRoot, content, confirmedByUser: request.body.confirmedByUser, confirmationToken: request.body.confirmationToken })
      if (!validation.ok) {
        const blocked = validation as Extract<typeof validation, { ok: false }>
        return writeError(reply, 403, {
          sourceId: resolvedSourceId,
          path: blocked.requestedPath,
          requestedPath: blocked.requestedPath,
          normalizedPath: blocked.normalizedPath,
          sourceRootRelativePath: blocked.sourceRootRelativePath,
          changeType: mode === 'overwrite' ? 'overwrite' : 'create',
          error: { ...blocked.error, policy: blocked.policy }
        })
      }
      if (mode === 'createOnly' && fs.existsSync(validation.fullPath)) return reply.code(409).send({ error: 'File already exists' })
      fs.mkdirSync(validation.parentPath, { recursive: true })
      fs.writeFileSync(validation.fullPath, content, 'utf-8')
      return { status: 'updated', sourceId: resolvedSourceId, requestedPath: relPath, normalizedPath: validation.normalizedPath, path: relPath, bytesWritten: Buffer.byteLength(content, 'utf8'), created: mode === 'createOnly', overwritten: mode === 'overwrite', changeType: mode === 'overwrite' ? 'overwrite' : 'create', ...verifiedWrite(validation.fullPath) }
    } catch (err) {
      return reply.code(400).send({ error: String(err) })
    }
  })

  fastify.post<{ Body: { sourceId?: string; path: string; find: string; replace: string; allowMultiple?: boolean; confirmedByUser?: boolean; confirmationToken?: string } }>('/api/patch-file', async (request, reply) => {
    try {
      const { sourceId, path: relPath, find, replace, allowMultiple = false } = request.body
      assertWriteMode(false, relPath)
      if (!relPath || typeof find !== 'string' || find.length === 0) return reply.code(400).send({ error: 'Path and find required' })
      if (typeof replace !== 'string') return reply.code(400).send({ error: 'Replace required' })
      const resolvedSourceId = resolveTargetSourceId(sourceId)
      const sourceRoot = getResolvedActiveSources([resolvedSourceId])[0]?.path
      const validation = validateWriteTarget({ sourceId: resolvedSourceId, requestedPath: relPath, changeType: 'patch', sourceRoot, content: replace, confirmedByUser: request.body.confirmedByUser, confirmationToken: request.body.confirmationToken })
      if (!validation.ok) {
        const blocked = validation as Extract<typeof validation, { ok: false }>
        return writeError(reply, 403, {
          sourceId: resolvedSourceId,
          path: blocked.requestedPath,
          requestedPath: blocked.requestedPath,
          normalizedPath: blocked.normalizedPath,
          sourceRootRelativePath: blocked.sourceRootRelativePath,
          changeType: 'patch',
          error: { ...blocked.error, policy: blocked.policy }
        })
      }
      if (!fs.existsSync(validation.fullPath)) return reply.code(404).send({ error: 'File not found' })
      const original = fs.readFileSync(validation.fullPath, 'utf-8')
      const matches = original.split(find).length - 1
      if (matches === 0) {
        return writeError(reply, 409, {
          sourceId: resolvedSourceId,
          path: relPath,
          requestedPath: relPath,
          normalizedPath: validation.normalizedPath,
          sourceRootRelativePath: validation.sourceRootRelativePath,
          changeType: 'patch',
          error: {
            code: 'PATCH_FIND_NOT_FOUND',
            message: 'The patch text was not found, so no file was changed.',
            userMessage: 'The patch text was not found, so no file was changed.',
            reason: 'find_not_found',
            hint: 'Adjust the find text so it matches the current file content.',
            policy: validation.policy
          }
        })
      }
      if (matches !== 1 && allowMultiple !== true) {
        return writeError(reply, 409, {
          sourceId: resolvedSourceId,
          path: relPath,
          requestedPath: relPath,
          normalizedPath: validation.normalizedPath,
          sourceRootRelativePath: validation.sourceRootRelativePath,
          changeType: 'patch',
          error: {
            code: 'PATCH_MULTIPLE_MATCHES',
            message: 'The patch text matched multiple places.',
            userMessage: 'The patch text matched multiple places. Provide a more specific find string.',
            reason: 'multiple_matches',
            hint: 'Use a more specific find string or set allowMultiple to true.',
            policy: validation.policy
          }
        })
      }
      const updated = allowMultiple === true ? original.split(find).join(replace) : original.replace(find, replace)
      fs.writeFileSync(validation.fullPath, updated, 'utf-8')
      return { status: 'updated', sourceId: resolvedSourceId, requestedPath: relPath, normalizedPath: validation.normalizedPath, path: relPath, changeType: 'patch', replacements: allowMultiple === true ? matches : 1, matchCount: matches, bytesBefore: Buffer.byteLength(original, 'utf8'), bytesAfter: Buffer.byteLength(updated, 'utf8'), ...verifiedWrite(validation.fullPath) }
    } catch (err) {
      return reply.code(400).send({ error: String(err) })
    }
  })

  fastify.post<{ Body: { sourceId?: string; path: string; confirmedByUser?: boolean; confirmationToken?: string; recursive?: boolean; onlyIfEmpty?: boolean } }>('/api/delete-file', async (request, reply) => {
    try {
      const { sourceId, path: relPath, recursive = false, onlyIfEmpty = true } = request.body
      if (!relPath) return reply.code(400).send({ error: 'Path required' })
      const resolvedSourceId = resolveTargetSourceId(sourceId)
      const sourceRoot = getResolvedActiveSources([resolvedSourceId])[0]?.path
      const validation = validateWriteTarget({ sourceId: resolvedSourceId, requestedPath: relPath, changeType: recursive ? 'delete_directory' : 'delete_file', sourceRoot, confirmedByUser: request.body.confirmedByUser, confirmationToken: request.body.confirmationToken })
      if (!validation.ok) {
        const blocked = validation as Extract<typeof validation, { ok: false }>
        return writeError(reply, 403, {
          sourceId: resolvedSourceId,
          path: blocked.requestedPath,
          requestedPath: blocked.requestedPath,
          normalizedPath: blocked.normalizedPath,
          sourceRootRelativePath: blocked.sourceRootRelativePath,
          changeType: recursive ? 'delete_directory' : 'delete_file',
          error: { ...blocked.error, policy: blocked.policy }
        })
      }
      if (!fs.existsSync(validation.fullPath)) return reply.code(404).send({ error: 'File not found' })
      const stat = fs.statSync(validation.fullPath)
      const operation = recursive || stat.isDirectory() ? 'delete_directory' : 'delete_file'
      if (stat.isDirectory()) {
        const directoryEmptyBefore = fs.readdirSync(validation.fullPath).length === 0
        if (!recursive) {
          if (!directoryEmptyBefore) {
            return reply.code(409).send({ status: 'error', verified: false, code: 'DIRECTORY_NOT_EMPTY', sourceId: resolvedSourceId, path: relPath, requestedPath: relPath, normalizedPath: validation.normalizedPath, changeType: 'delete_directory', reason: 'directory_not_empty', hint: 'Use recursive:true with confirmation or empty the directory first.' })
          }
          fs.rmdirSync(validation.fullPath)
          return { status: 'deleted', sourceId: resolvedSourceId, requestedPath: relPath, normalizedPath: validation.normalizedPath, path: relPath, changeType: 'rmdir', operation: 'rmdir', verified: true, existsBefore: true, existsAfter: false, directoryEmptyBefore }
        }
        const { files, directories } = countRecursiveEntries(validation.fullPath)
        if (!recursive && onlyIfEmpty && fs.readdirSync(validation.fullPath).length > 0) {
          return reply.code(409).send({ status: 'error', verified: false, code: 'DIRECTORY_NOT_EMPTY', sourceId: resolvedSourceId, path: relPath, requestedPath: relPath, normalizedPath: validation.normalizedPath, changeType: operation, reason: 'directory_not_empty', hint: 'Pass recursive:true with confirmation or delete the contents first.' })
        }
        if (!confirmOperation(request.body, resolvedSourceId, operation, validation.normalizedPath)) {
          return reply.code(403).send(confirmationPayload(resolvedSourceId, operation, relPath, validation.normalizedPath, 'recursive_delete_requires_confirmation', 'This deletes a directory and its contents.'))
        }
        fs.rmSync(validation.fullPath, { recursive: true, force: false })
        return { status: 'deleted', sourceId: resolvedSourceId, requestedPath: relPath, normalizedPath: validation.normalizedPath, path: relPath, changeType: operation, operation, verified: true, existsBefore: true, existsAfter: false, deletedFileCount: files, deletedDirectoryCount: directories }
      }
      if (!confirmOperation(request.body, resolvedSourceId, operation, validation.normalizedPath)) {
        const matchedConfirmationGlob = validation.policy.confirmationRequiredGlobs.find(pattern => pattern === relPath || relPath.startsWith(pattern.replace('/**', '')))
        return reply.code(403).send(confirmationPayload(resolvedSourceId, operation, relPath, validation.normalizedPath, 'confirmation_required_path', 'This deletes a protected path.', matchedConfirmationGlob))
      }
      fs.unlinkSync(validation.fullPath)
      return { status: 'deleted', sourceId: resolvedSourceId, requestedPath: relPath, normalizedPath: validation.normalizedPath, path: relPath, changeType: operation, operation, verified: true, existsBefore: true, existsAfter: false }
    } catch (err) {
      return reply.code(400).send({ error: String(err) })
    }
  })

  fastify.post<{ Body: { sourceId?: string; path: string; to: string; overwrite?: boolean; createParents?: boolean; confirmedByUser?: boolean; confirmationToken?: string } }>('/api/move-file', async (request, reply) => {
    try {
      const { sourceId, path: fromPath, to, overwrite = false, createParents = false } = request.body
      if (!fromPath || !to) return reply.code(400).send({ error: 'From and to required' })
      const resolvedSourceId = resolveTargetSourceId(sourceId)
      const sourceRoot = getResolvedActiveSources([resolvedSourceId])[0]?.path
      const validation = validateWriteTarget({ sourceId: resolvedSourceId, requestedPath: fromPath, changeType: 'move', sourceRoot, toPath: to, confirmedByUser: request.body.confirmedByUser, confirmationToken: request.body.confirmationToken })
      if (!validation.ok) {
        const blocked = validation as Extract<typeof validation, { ok: false }>
        return writeError(reply, 403, { sourceId: resolvedSourceId, path: blocked.requestedPath, requestedPath: blocked.requestedPath, normalizedPath: blocked.normalizedPath, to, sourceRootRelativePath: blocked.sourceRootRelativePath, changeType: 'move', error: { ...blocked.error, policy: blocked.policy } })
      }
      const fromExists = fs.existsSync(validation.fullPath)
      if (!fromExists) return reply.code(404).send({ error: 'Source path not found' })
      const target = path.resolve(path.join(sourceRoot, normalizeRepoRelativePath(to)))
      if (!target.startsWith(path.resolve(sourceRoot))) return reply.code(403).send({ error: 'Target path blocked' })
      if (fs.existsSync(target) && !overwrite) return reply.code(409).send({ error: 'Target already exists' })
      if (!confirmOperation(request.body, resolvedSourceId, 'move', validation.normalizedPath, normalizeRepoRelativePath(to))) {
        return reply.code(403).send(confirmationPayload(resolvedSourceId, 'move', fromPath, validation.normalizedPath, 'confirmation_required_path', 'This move/rename is confirmation-gated.', undefined, normalizeRepoRelativePath(to)))
      }
      if (createParents) fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.renameSync(validation.fullPath, target)
      return { status: 'moved', sourceId: resolvedSourceId, from: fromPath, to: normalizeRepoRelativePath(to), verified: true, sourceExistsAfter: false, targetExistsAfter: true, contentHashBefore: verifiedWrite(target).contentHash, contentHashAfter: verifiedWrite(target).contentHash }
    } catch (err) {
      return reply.code(400).send({ error: String(err) })
    }
  })

  fastify.post<{ Body: { sourceId?: string; path: string; createParents?: boolean; confirmedByUser?: boolean; confirmationToken?: string } }>('/api/mkdir', async (request, reply) => {
    try {
      const { sourceId, path: relPath, createParents = false } = request.body
      if (!relPath) return reply.code(400).send({ error: 'Path required' })
      const resolvedSourceId = resolveTargetSourceId(sourceId)
      const sourceRoot = getResolvedActiveSources([resolvedSourceId])[0]?.path
      const validation = validateWriteTarget({ sourceId: resolvedSourceId, requestedPath: relPath, changeType: 'mkdir', sourceRoot, confirmedByUser: request.body.confirmedByUser, confirmationToken: request.body.confirmationToken })
      if (!validation.ok) {
        const blocked = validation as Extract<typeof validation, { ok: false }>
        return writeError(reply, 403, { sourceId: resolvedSourceId, path: blocked.requestedPath, requestedPath: blocked.requestedPath, normalizedPath: blocked.normalizedPath, sourceRootRelativePath: blocked.sourceRootRelativePath, changeType: 'mkdir', error: { ...blocked.error, policy: blocked.policy } })
      }
      if (fs.existsSync(validation.fullPath)) return reply.code(409).send({ error: 'Target already exists' })
      const allowRecursive = createParents || validation.policy.allowCreateParentDirectories
      if (!ensureParentDirectory(validation.fullPath, allowRecursive)) {
        return reply.code(409).send({
          status: 'error',
          verified: false,
          code: 'PARENT_DIRECTORY_MISSING',
          sourceId: resolvedSourceId,
          path: relPath,
          requestedPath: relPath,
          normalizedPath: validation.normalizedPath,
          changeType: 'mkdir',
          reason: 'parent_directory_missing',
          hint: 'Pass createParents:true to create the missing parent directories.'
        })
      }
      fs.mkdirSync(validation.fullPath, { recursive: allowRecursive })
      return { status: 'created', sourceId: resolvedSourceId, requestedPath: relPath, normalizedPath: validation.normalizedPath, path: relPath, changeType: 'mkdir', verified: true, existsAfter: true }
    } catch (err) {
      return reply.code(400).send({ error: String(err) })
    }
  })

  fastify.post<{ Body: { sourceId?: string; path: string; recursive?: boolean; onlyIfEmpty?: boolean; confirmedByUser?: boolean; confirmationToken?: string } }>('/api/rmdir', async (request, reply) => {
    try {
      const { sourceId, path: relPath, recursive = false, onlyIfEmpty = true } = request.body
      if (!relPath) return reply.code(400).send({ error: 'Path required' })
      const resolvedSourceId = resolveTargetSourceId(sourceId)
      const sourceRoot = getResolvedActiveSources([resolvedSourceId])[0]?.path
      const validation = validateWriteTarget({ sourceId: resolvedSourceId, requestedPath: relPath, changeType: 'rmdir', sourceRoot, confirmedByUser: request.body.confirmedByUser, confirmationToken: request.body.confirmationToken })
      if (!validation.ok) {
        const blocked = validation as Extract<typeof validation, { ok: false }>
        return writeError(reply, 403, { sourceId: resolvedSourceId, path: blocked.requestedPath, requestedPath: blocked.requestedPath, normalizedPath: blocked.normalizedPath, sourceRootRelativePath: blocked.sourceRootRelativePath, changeType: 'rmdir', error: { ...blocked.error, policy: blocked.policy } })
      }
      if (!fs.existsSync(validation.fullPath)) return reply.code(404).send({ error: 'Directory not found' })
      if (!fs.statSync(validation.fullPath).isDirectory()) return reply.code(400).send({ error: 'Not a directory' })
      const directoryEmptyBefore = fs.readdirSync(validation.fullPath).length === 0
      if (!directoryEmptyBefore) {
        return reply.code(409).send({ status: 'error', verified: false, code: 'DIRECTORY_NOT_EMPTY', sourceId: resolvedSourceId, path: relPath, requestedPath: relPath, normalizedPath: validation.normalizedPath, changeType: 'rmdir', reason: 'directory_not_empty', hint: 'Pass recursive:true with confirmation or empty the directory first.' })
      }
      fs.rmdirSync(validation.fullPath)
      return { status: 'deleted', sourceId: resolvedSourceId, requestedPath: relPath, normalizedPath: validation.normalizedPath, path: relPath, changeType: 'rmdir', operation: 'rmdir', verified: true, existsBefore: true, existsAfter: false, directoryEmptyBefore }
    } catch (err) {
      return reply.code(400).send({ error: String(err) })
    }
  })

  fastify.post<{ Body: { sourceId?: string; title: string; content: string; folder?: string } }>('/api/create-plan', async (request, reply) => {
    try {
      const { sourceId, title, content, folder = 'docs/product/plans' } = request.body
      if (!title || !content) return reply.code(400).send({ error: 'Title and content required' })
      assertWriteMode(true, folder)
      if (isBlockedWritePath(folder) || !isAllowedArtifactRoot(folder)) return reply.code(403).send({ error: 'Plan folder blocked' })
      const safeSlug = normalizeArtifactSlug(title)
      const filename = `${Date.now()}-${safeSlug}.md`
      const relPath = `${folder.replace(/\/$/, '')}/${filename}`
      const { fullPath, sourceId: resolvedSourceId } = resolveWithinSource(relPath, resolveTargetSourceId(sourceId))
      fs.mkdirSync(path.dirname(fullPath), { recursive: true })
      if (fs.existsSync(fullPath)) return reply.code(409).send({ error: 'Plan already exists' })
      fs.writeFileSync(fullPath, content, 'utf-8')
      const verification = verifyWrittenFile({ fullPath, expectedContent: content })
      return { status: 'created', sourceId: resolvedSourceId, path: relPath, ...verification }
    } catch (err) {
      return reply.code(400).send({ error: String(err) })
    }
  })

  fastify.post<{ Body: { sourceId?: string; path: string; content: string; separator?: string; reason?: string; confirmedByUser?: boolean; confirmationToken?: string } }>('/api/append-file', async (request, reply) => {
    try {
      const { sourceId, path: relPath, content, separator = '\n\n' } = request.body
      assertWriteMode(false, relPath)
      if (!relPath || typeof content !== 'string') return reply.code(400).send({ error: 'Path and content required' })
      const resolvedSourceId = resolveTargetSourceId(sourceId)
      const sourceRoot = getResolvedActiveSources([resolvedSourceId])[0]?.path
      const validation = validateWriteTarget({ sourceId: resolvedSourceId, requestedPath: relPath, changeType: 'append', sourceRoot, content, confirmedByUser: request.body.confirmedByUser, confirmationToken: request.body.confirmationToken })
      if (!validation.ok) {
        const blocked = validation as Extract<typeof validation, { ok: false }>
        return writeError(reply, 403, {
          sourceId: resolvedSourceId,
          path: blocked.requestedPath,
          requestedPath: blocked.requestedPath,
          normalizedPath: blocked.normalizedPath,
          sourceRootRelativePath: blocked.sourceRootRelativePath,
          changeType: 'append',
          error: { ...blocked.error, policy: blocked.policy }
        })
      }
      if (!fs.existsSync(validation.fullPath)) return reply.code(404).send({ error: 'File not found' })
      const appended = `${separator}${content}`
      fs.appendFileSync(validation.fullPath, appended, 'utf-8')
      return { status: 'updated', sourceId: resolvedSourceId, requestedPath: relPath, normalizedPath: validation.normalizedPath, path: relPath, changeType: 'append', bytesAppended: Buffer.byteLength(appended, 'utf8'), ...verifiedWrite(validation.fullPath) }
    } catch (err) {
      return reply.code(400).send({ error: String(err) })
    }
  })

  // Create endpoint
  fastify.post<{ Body: { path?: string; content: string } }>('/api/create', async (request, reply) => {
    try {
      let { path, content } = request.body

      // Generate path if not provided
      if (!path) {
        const timestamp = new Date().toISOString().split('T')[0]
        const slug = content.slice(0, 50).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
        path = `BuildFlow/Inbox/${timestamp}-${slug}.md`
      }

      // Add frontmatter
      const frontmatter = `---\ncreated: ${new Date().toISOString()}\nsource: buildflow\ntype: plan\n---\n\n`
      const fullContent = frontmatter + content

      const result = await createFile(path, fullContent)
      await indexer.buildIndex()
      searcher = new VaultSearcher(indexer.getDocs())

      return result
    } catch (err) {
      return reply.code(400).send({ error: String(err) })
    }
  })

  // Append endpoint
  fastify.post<{ Body: { path: string; content: string } }>('/api/append', async (request, reply) => {
    try {
      const { path, content } = request.body
      const result = await appendFile(path, content)
      await indexer.buildIndex()
      searcher = new VaultSearcher(indexer.getDocs())

      return result
    } catch (err) {
      return reply.code(400).send({ error: String(err) })
    }
  })

  // Export plan endpoint
  fastify.post<{ Body: Record<string, unknown> }>('/api/export-plan', async (request, reply) => {
    try {
      const result = await createExportPlan(request.body)
      await indexer.buildIndex()
      searcher = new VaultSearcher(indexer.getDocs())

      return result
    } catch (err) {
      return reply.code(400).send({ error: String(err) })
    }
  })

  // List folder endpoint
  fastify.get<{ Querystring: { path?: string } }>('/api/list', async (request, reply) => {
    try {
      const { path } = request.query
      const result = await listFolder(path)
      return { items: result }
    } catch (err) {
      return reply.code(400).send({ error: String(err) })
    }
  })

  // Knowledge sources listing endpoint (multi-source aware)
  fastify.get<{ Params: Record<string, unknown> }>('/api/sources', async (request, reply) => {
    try {
      const sources = getSources()
      return { sources }
    } catch (err) {
      return reply.code(400).send({ error: String(err) })
    }
  })

  fastify.get('/api/sources/discovery', async (request, reply) => {
    try {
      const result = discoverRepositories()
      return reply.header('Cache-Control', 'no-store').send(result)
    } catch (err) {
      return reply.code(400).header('Cache-Control', 'no-store').send({ error: String(err), settings: getSourceDiscoverySettings(), repositories: [] })
    }
  })

  fastify.post<{ Body: { rootPath?: string; intervalMinutes?: number } }>('/api/sources/discovery', async (request, reply) => {
    try {
      const { rootPath, intervalMinutes } = request.body || {}
      if (rootPath !== undefined && typeof rootPath !== 'string') return reply.code(400).send({ error: 'Invalid rootPath' })
      if (intervalMinutes !== undefined && typeof intervalMinutes !== 'number') return reply.code(400).send({ error: 'Invalid intervalMinutes' })
      setSourceDiscoverySettings({ rootPath, intervalMinutes })
      const result = discoverRepositories()
      return reply.header('Cache-Control', 'no-store').send(result)
    } catch (err) {
      return reply.code(400).header('Cache-Control', 'no-store').send({ error: String(err), settings: getSourceDiscoverySettings(), repositories: [] })
    }
  })

  fastify.get<{ Querystring: { lite?: string } }>('/api/sources/list', async (request, reply) => {
    try {
      const active = getActiveSourceContext()
      const lite = request.query?.lite === '1' || request.query?.lite === 'true'
      const sources = getSourcesSafe().map(source => ({
        id: source.id,
        label: source.label,
        enabled: source.enabled,
        active: active.activeSourceIds.includes(source.id),
        type: (source as any).type || 'unknown',
        indexed: source.indexStatus === 'ready',
        indexStatus: source.indexStatus || 'unknown',
        indexedFileCount: source.indexedFileCount,
        ...(lite ? {} : {
          lastIndexedAt: source.lastIndexedAt,
          indexError: source.indexError,
          autoIndexEnabled: source.autoIndexEnabled,
          autoIndexIntervalMinutes: source.autoIndexIntervalMinutes,
          lastAutoIndexedAt: source.lastAutoIndexedAt
        }),
        writable: source.enabled !== false,
        writeProfile: 'repo_app_maintainer',
        ...(lite ? {} : { writePolicy: getDefaultWritePolicy() })
      }))

      return reply.header('Cache-Control', 'no-store').send({ sources })
    } catch (err) {
      return reply.code(500).header('Cache-Control', 'no-store').send({
        error: String(err)
      })
    }
  })

  fastify.post<{ Body: { path?: string; label?: string; id?: string } }>('/api/sources/add', async (request, reply) => {
    try {
      const { path, label, id } = request.body || {}
      if (typeof path !== 'string' || !path.trim()) {
        return reply.code(400).send({ error: 'Missing or invalid path' })
      }
      if (label !== undefined && typeof label !== 'string') {
        return reply.code(400).send({ error: 'Invalid label' })
      }
      if (id !== undefined && typeof id !== 'string') {
        return reply.code(400).send({ error: 'Invalid id' })
      }

      const sources = addSource(path, label, id)
      const targetSource = id ? sources.find(source => source.id === id) : sources[sources.length - 1]
      if (targetSource?.id && targetSource?.path) {
        reindexSourceInBackground(targetSource.id, targetSource.path)
      }
      return { status: 'accepted', sources: getSourcesSafe(), indexingSourceId: targetSource?.id }
    } catch (err) {
      return reply.code(400).send({ error: String(err) })
    }
  })

  fastify.post<{ Body: { sourceId?: string } }>('/api/sources/remove', async (request, reply) => {
    try {
      const { sourceId } = request.body || {}
      if (typeof sourceId !== 'string' || !sourceId.trim()) {
        return reply.code(400).send({ error: 'Missing or invalid sourceId' })
      }

      const sources = removeSource(sourceId)
      indexer.removeSourceDocs(sourceId)
      refreshSearcherFromDocs()
      return { status: 'removed', sources }
    } catch (err) {
      return reply.code(400).send({ error: String(err) })
    }
  })

  fastify.post<{ Body: { sourceId?: string; enabled?: boolean } }>('/api/sources/toggle', async (request, reply) => {
    try {
      const { sourceId, enabled } = request.body || {}
      if (typeof sourceId !== 'string' || !sourceId.trim()) {
        return reply.code(400).send({ error: 'Missing or invalid sourceId' })
      }
      if (typeof enabled !== 'boolean') {
        return reply.code(400).send({ error: 'Missing or invalid enabled value' })
      }

      const sources = setSourceEnabled(sourceId, enabled)
      return { sources }
    } catch (err) {
      return reply.code(400).send({ error: String(err) })
    }
  })

  fastify.post<{ Body: { sourceId?: string; autoIndexEnabled?: boolean; autoIndexIntervalMinutes?: number } }>('/api/sources/auto-index', async (request, reply) => {
    try {
      const { sourceId, autoIndexEnabled, autoIndexIntervalMinutes } = request.body || {}
      if (typeof sourceId !== 'string' || !sourceId.trim()) {
        return reply.code(400).send({ error: 'Missing or invalid sourceId' })
      }
      if (autoIndexEnabled !== undefined && typeof autoIndexEnabled !== 'boolean') {
        return reply.code(400).send({ error: 'Invalid autoIndexEnabled value' })
      }
      if (autoIndexIntervalMinutes !== undefined && typeof autoIndexIntervalMinutes !== 'number') {
        return reply.code(400).send({ error: 'Invalid autoIndexIntervalMinutes value' })
      }

      const sources = setSourceAutoIndex(sourceId, {
        enabled: autoIndexEnabled,
        intervalMinutes: autoIndexIntervalMinutes
      })
      return { sources }
    } catch (err) {
      return reply.code(400).send({ error: String(err) })
    }
  })

  fastify.post<{ Body: { sourceId?: string } }>('/api/sources/reindex', async (request, reply) => {
    try {
      const { sourceId } = request.body || {}
      if (typeof sourceId !== 'string' || !sourceId.trim()) {
        return reply.code(400).send({ error: 'Missing or invalid sourceId' })
      }

      const source = getSourcesSafe().find(item => item.id === sourceId)
      if (!source) {
        return reply.code(404).send({ error: `Source not found: ${sourceId}` })
      }
      if (!source.enabled) {
        return reply.code(400).send({ error: `Source is disabled: ${sourceId}` })
      }
      if (!fs.existsSync(source.path)) {
        setSourceIndexStatus(sourceId, {
          indexed: false,
          indexStatus: 'failed',
          indexError: `Source path not found: ${source.path}`
        })
        return reply.code(404).send({ error: `Source path not found: ${source.path}` })
      }
      if (!fs.statSync(source.path).isDirectory()) {
        setSourceIndexStatus(sourceId, {
          indexed: false,
          indexStatus: 'failed',
          indexError: `Source path is not a directory: ${source.path}`
        })
        return reply.code(400).send({ error: `Source path is not a directory: ${source.path}` })
      }
      fs.accessSync(source.path, fs.constants.R_OK)

      if (indexingSources.has(sourceId)) {
        return reply.code(202).send({
          status: 'indexing',
          sourceId,
          indexStatus: 'indexing'
        })
      }

      reindexSourceInBackground(sourceId, source.path)

      return reply.code(202).send({
        status: 'indexing',
        sourceId,
        indexStatus: 'indexing'
      })
    } catch (err) {
      const bodySourceId = request.body?.sourceId
      if (typeof bodySourceId === 'string' && bodySourceId.trim()) {
        setSourceIndexStatus(bodySourceId, {
          indexed: false,
          indexStatus: 'failed',
          indexError: String(err)
        })
      }
      return reply.code(400).send({ error: String(err) })
    }
  })

  // Workspaces listing endpoint
  fastify.get<{ Params: Record<string, unknown> }>('/api/workspaces', async (request, reply) => {
    try {
      const workspaces = getWorkspaces()
      const details = workspaces.map(ws => ({
        name: ws.name,
        root: ws.root,
        mode: ws.mode
      }))
      return { workspaces: details }
    } catch (err) {
      return reply.code(400).send({ error: String(err) })
    }
  })

  // Tree inspection endpoint
  fastify.post<{ Body: { workspace: string; path?: string; maxDepth?: number; maxEntries?: number } }>(
    '/api/tree',
    async (request, reply) => {
      try {
        const { workspace, path = '', maxDepth = 3, maxEntries = 100 } = request.body
        const tree = listWorkspaceTree(workspace, path, maxDepth, 0, maxEntries)

        logToFile({
          timestamp: new Date().toISOString(),
          tool: 'tree',
          workspace,
          path,
          status: 'success'
        })

        return { tree, count: tree.length }
      } catch (err) {
        return reply.code(400).send({ error: String(err) })
      }
    }
  )

  // Grep/search endpoint
  fastify.post<{
    Body: {
      workspace: string
      pattern: string
      maxResults?: number
      maxLineLength?: number
    }
  }>('/api/grep', async (request, reply) => {
    try {
      const { workspace, pattern, maxResults = 100, maxLineLength = 500 } = request.body
      const results = grepWorkspace(workspace, pattern, { maxResults, maxLineLength })

      logToFile({
        timestamp: new Date().toISOString(),
        tool: 'grep',
        workspace,
        pattern,
        status: 'success',
        matches: results.length
      })

      return { results, count: results.length }
    } catch (err) {
      return reply.code(400).send({ error: String(err) })
    }
  })

  // Context assembly endpoint (workspace-native)
  fastify.post<{
    Body: {
      workspace: string
      query?: string
      maxDepth?: number
      maxResults?: number
    }
  }>('/api/context', async (request, reply) => {
    try {
      const { workspace, query = '', maxDepth = 2, maxResults = 20 } = request.body
      const ws = getWorkspaceInfo(workspace)
      const tree = listWorkspaceTree(workspace, '', maxDepth, 0, 50)

      // Search within workspace only (not global vault)
      let matches = []
      if (query) {
        matches = grepWorkspace(workspace, query, { maxResults })
      }

      const summary = `Workspace: ${ws.name}\nRoot: ${ws.root}\nMode: ${ws.mode}\nTree items: ${tree.length}`

      // Find entrypoints: check all tree items for common names
      const entrypointNames = ['README.md', 'index.md', 'MANIFEST.md', 'package.json', 'tsconfig.json']
      const entrypoints = entrypointNames.filter(
        name => tree.some(n => n.name === name && n.type === 'file')
      )

      // Extract key files: get content of identified entrypoints
      const keyFiles = []
      for (const ep of entrypoints.slice(0, 3)) {
        try {
          const epPath = tree.find(n => n.name === ep && n.type === 'file')?.path
          if (epPath) {
            const fullPath = resolveWorkspacePath(ws, epPath)
            const stat = fs.statSync(fullPath)
            // Enforce safe read limits
            if (stat.size > 50000) {
              continue // Skip files > 50KB
            }
            const content = fs.readFileSync(fullPath, 'utf-8')
            keyFiles.push({
              path: epPath,
              content: content.slice(0, 2000)
            })
          }
        } catch (err) {
          // Skip if can't read
        }
      }

      logToFile({
        timestamp: new Date().toISOString(),
        tool: 'context',
        workspace,
        query,
        status: 'success',
        matchCount: matches.length
      })

      return {
        workspace,
        summary,
        tree,
        matches,
        entrypoints,
        keyFiles
      }
    } catch (err) {
      return reply.code(400).send({ error: String(err) })
    }
  })

  // Compound execute-task endpoint for internal dashboard jobs: execute steps -> validate -> optional commit -> optional push.
  fastify.post<{ Body: {
    jobId: string
    sourceId: string
    task: { id: string; title: string; phase: string }
    steps: Array<{
      type: 'read_files' | 'write_file' | 'patch_file' | 'append_file' | 'delete_file' | 'run_command' | 'search'
      paths?: string[]
      maxBytesPerFile?: number
      path?: string
      content?: string
      find?: string
      replace?: string
      allowMultiple?: boolean
      separator?: string
      mode?: 'createOnly' | 'overwrite'
      commandKind?: string
      timeoutMs?: number
      message?: string
      body?: string
      remote?: string
      branch?: string
      query?: string
      limit?: number
    }>
    validate?: { commands: Array<{ commandKind: string; timeoutMs?: number; paths?: string[] }> }
    autoCommit?: { message: string; body?: string; paths: string[] }
    autoPush?: { remote?: string; branch?: string }
  } }>('/api/agent-jobs/execute-task', async (request, reply) => {
    const { jobId, sourceId, task, steps, validate, autoCommit, autoPush } = request.body
    if (!jobId || typeof jobId !== 'string') return reply.code(400).send({ error: 'jobId is required' })
    if (!sourceId || typeof sourceId !== 'string') return reply.code(400).send({ error: 'sourceId is required' })
    if (!Array.isArray(steps) || steps.length === 0) return reply.code(400).send({ error: 'steps array is required' })

    const job = getAgentJob(jobId)
    if (!job) return reply.code(404).send({ error: 'Job not found' })
    if (!['running', 'queued'].includes(job.status)) return reply.code(409).send({ error: `Job is ${job.status}` })

    const startedAt = Date.now()
    const stepResults: Array<{ type: string; status: 'ok' | 'failed'; data?: unknown; error?: string }> = []

    // Execute steps sequentially
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]
      let endpoint: string
      let body: Record<string, unknown>

      switch (step.type) {
        case 'read_files':
          endpoint = '/api/read-files'
          body = { sourceId, paths: step.paths, maxBytesPerFile: step.maxBytesPerFile || 12000 }
          break
        case 'write_file':
          endpoint = '/api/write-file'
          body = { sourceId, path: step.path, content: step.content, mode: step.mode || 'createOnly' }
          break
        case 'patch_file':
          endpoint = '/api/patch-file'
          body = { sourceId, path: step.path, find: step.find, replace: step.replace, allowMultiple: step.allowMultiple }
          break
        case 'append_file':
          endpoint = '/api/append-file'
          body = { sourceId, path: step.path, content: step.content, separator: step.separator }
          break
        case 'delete_file':
          endpoint = '/api/delete-file'
          body = { sourceId, path: step.path, confirmedByUser: true }
          break
        case 'run_command':
          endpoint = '/api/commands/run'
          body = { sourceId, commandKind: step.commandKind, timeoutMs: step.timeoutMs, paths: step.paths, message: step.message, body: step.body, remote: step.remote, branch: step.branch }
          break
        case 'search':
          endpoint = '/api/search'
          body = { sourceId, query: step.query, limit: step.limit || 5 }
          break
        default:
          stepResults.push({ type: step.type, status: 'failed', error: 'Unknown step type' })
          return reply.header('Cache-Control', 'no-store').send({ status: 'failed', completedPhase: 'none', failedAt: { phase: 'steps', stepIndex: i, error: 'Unknown step type' }, stepResults, durationMs: Date.now() - startedAt })
      }

      const res = await fastify.inject({ method: 'POST', url: endpoint, payload: body })
      const data = JSON.parse(res.payload)

      if (res.statusCode >= 400) {
        stepResults.push({ type: step.type, status: 'failed', error: data.error || `HTTP ${res.statusCode}`, data })
        appendAgentEvent({ jobId, sourceId, type: 'task_step_failed', message: `Step ${i + 1} (${step.type}) failed: ${data.error || res.statusCode}`, status: job.status })
        return reply.header('Cache-Control', 'no-store').send({ status: 'failed', completedPhase: 'none', failedAt: { phase: 'steps', stepIndex: i, error: data.error || `HTTP ${res.statusCode}` }, stepResults, durationMs: Date.now() - startedAt })
      }

      stepResults.push({ type: step.type, status: 'ok', data })
    }

    // Validation phase
    let validationResults: Array<{ commandKind: string; status: string; durationMs: number; stdout?: string; stderr?: string }> | undefined
    if (validate && validate.commands.length > 0) {
      validationResults = []
      for (const cmd of validate.commands) {
        const res = await fastify.inject({ method: 'POST', url: '/api/commands/run', payload: { sourceId, commandKind: cmd.commandKind, timeoutMs: cmd.timeoutMs || 120000, paths: cmd.paths } })
        const data = JSON.parse(res.payload)
        validationResults.push({ commandKind: cmd.commandKind, status: data.status, durationMs: data.durationMs, stdout: typeof data.stdout === 'string' ? data.stdout.slice(0, 2000) : undefined, stderr: typeof data.stderr === 'string' ? data.stderr.slice(0, 1000) : undefined })
        if (data.status !== 'completed') {
          appendAgentEvent({ jobId, sourceId, type: 'validation_failed', message: `Validation ${cmd.commandKind} failed`, status: job.status })
          return reply.header('Cache-Control', 'no-store').send({ status: 'failed', completedPhase: 'steps', failedAt: { phase: 'validation', error: `${cmd.commandKind} failed` }, stepResults, validationResults, durationMs: Date.now() - startedAt })
        }
      }
    }

    // Commit phase
    let commitResult: { status: string; stdout?: string } | undefined
    if (autoCommit) {
      // Stage files
      const addRes = await fastify.inject({ method: 'POST', url: '/api/commands/run', payload: { sourceId, commandKind: 'git_add_paths', paths: autoCommit.paths } })
      const addData = JSON.parse(addRes.payload)
      if (addData.status !== 'completed') {
        return reply.header('Cache-Control', 'no-store').send({ status: 'failed', completedPhase: validate ? 'validation' : 'steps', failedAt: { phase: 'commit', error: `git add failed: ${addData.stderr || addData.error}` }, stepResults, validationResults, durationMs: Date.now() - startedAt })
      }

      // Commit
      const commitRes = await fastify.inject({ method: 'POST', url: '/api/commands/run', payload: { sourceId, commandKind: 'git_commit', message: autoCommit.message, body: autoCommit.body } })
      const commitData = JSON.parse(commitRes.payload)
      commitResult = { status: commitData.status, stdout: typeof commitData.stdout === 'string' ? commitData.stdout.slice(0, 500) : undefined }
      if (commitData.status !== 'completed') {
        return reply.header('Cache-Control', 'no-store').send({ status: 'failed', completedPhase: validate ? 'validation' : 'steps', failedAt: { phase: 'commit', error: `git commit failed: ${commitData.stderr || commitData.error}` }, stepResults, validationResults, commitResult, durationMs: Date.now() - startedAt })
      }
      appendAgentEvent({ jobId, sourceId, type: 'task_committed', message: `Committed: ${autoCommit.message}`, status: job.status })
    }

    // Push phase
    let pushResult: { status: string; stdout?: string } | undefined
    if (autoPush) {
      const pushRes = await fastify.inject({ method: 'POST', url: '/api/commands/run', payload: { sourceId, commandKind: 'git_push', remote: autoPush.remote, branch: autoPush.branch } })
      const pushData = JSON.parse(pushRes.payload)
      pushResult = { status: pushData.status, stdout: typeof pushData.stdout === 'string' ? pushData.stdout.slice(0, 500) : undefined }
      if (pushData.status !== 'completed') {
        return reply.header('Cache-Control', 'no-store').send({ status: 'partial', completedPhase: 'commit', failedAt: { phase: 'push', error: `git push failed: ${pushData.stderr || pushData.error}` }, stepResults, validationResults, commitResult, pushResult, durationMs: Date.now() - startedAt })
      }
      appendAgentEvent({ jobId, sourceId, type: 'task_pushed', message: `Pushed: ${autoCommit?.message || 'changes'}`, status: job.status })
    }

    // Final git status
    const statusRes = await fastify.inject({ method: 'POST', url: '/api/commands/run', payload: { sourceId, commandKind: 'git_status_short' } })
    const statusData = JSON.parse(statusRes.payload)

    const completedPhase = autoPush ? 'push' : autoCommit ? 'commit' : validate ? 'validation' : 'steps'

    return reply.header('Cache-Control', 'no-store').send({
      status: 'completed',
      completedPhase,
      stepResults,
      validationResults,
      commitResult,
      pushResult,
      gitStatus: statusData.stdout || '',
      durationMs: Date.now() - startedAt
    })
  })

  // Batch endpoint: execute multiple operations in one request
  fastify.post<{ Body: { operations: Array<{ endpoint: string; body: Record<string, unknown> }> } }>('/api/batch', async (request, reply) => {
    const { operations } = request.body
    if (!Array.isArray(operations) || operations.length === 0 || operations.length > 5) {
      return reply.code(400).send({ error: 'operations must be 1-5 items' })
    }
    const results: Array<{ endpoint: string; status: number; data: unknown }> = []
    for (const op of operations) {
      try {
        const res = await fastify.inject({ method: 'POST', url: op.endpoint, payload: op.body })
        results.push({ endpoint: op.endpoint, status: res.statusCode, data: JSON.parse(res.payload) })
      } catch (err) {
        results.push({ endpoint: op.endpoint, status: 500, data: { error: String(err) } })
      }
    }
    return reply.header('Cache-Control', 'no-store').send({ status: 'ok', results })
  })

  fastify.addHook('onClose', async () => {
    flushIndexStateOnShutdown()
  })

  await fastify.listen({ port, host: '127.0.0.1' })
  console.log(`Local agent running on http://127.0.0.1:${port}`)
}
