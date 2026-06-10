import { execFile } from 'child_process'
import { promises as fsp } from 'fs'
import path from 'path'
import { getSourcesSafe } from './config'

type GraphContextBody = {
  sourceId: string
  query?: string
  limit?: number
}

type GraphContextResult = {
  statusCode: number
  payload: Record<string, unknown>
}

type GraphArtifact = {
  path: string
  exists: boolean
  sizeBytes?: number
  modifiedAt?: string
}

const GRAPH_DIR = 'graphify-out'
const GRAPH_REPORT = `${GRAPH_DIR}/GRAPH_REPORT.md`
const GRAPH_JSON = `${GRAPH_DIR}/graph.json`
const GRAPH_MANIFEST = `${GRAPH_DIR}/manifest.json`
const MAX_REPORT_LINES = 220
const MAX_COMMUNITIES = 10
const MAX_MATCHES = 10

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(min, Math.min(max, Math.floor(numeric)))
}

function safeJoin(sourceRoot: string, relPath: string): string {
  const fullPath = path.resolve(sourceRoot, relPath)
  const root = path.resolve(sourceRoot)
  if (fullPath !== root && !fullPath.startsWith(`${root}${path.sep}`)) {
    throw new Error('Graph path escapes source root')
  }
  return fullPath
}

async function artifactInfo(sourceRoot: string, relPath: string): Promise<GraphArtifact> {
  try {
    const stat = await fsp.stat(safeJoin(sourceRoot, relPath))
    if (!stat.isFile()) return { path: relPath, exists: false }
    return {
      path: relPath,
      exists: true,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString()
    }
  } catch {
    return { path: relPath, exists: false }
  }
}

async function readReport(sourceRoot: string): Promise<string[]> {
  try {
    const raw = await fsp.readFile(safeJoin(sourceRoot, GRAPH_REPORT), 'utf8')
    return raw.split(/\r?\n/).slice(0, MAX_REPORT_LINES)
  } catch {
    return []
  }
}

function runGit(sourceRoot: string, args: string[]): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile('git', ['-C', sourceRoot, ...args], { timeout: 1500 }, (error, stdout) => {
      if (error) return resolve(undefined)
      const value = stdout.trim()
      resolve(value || undefined)
    })
  })
}

function extractBuiltCommit(lines: string[]): string | undefined {
  for (const line of lines) {
    const match = line.match(/Built from commit:\s*`?([0-9a-f]{7,40})`?/i)
    if (match) return match[1]
  }
  return undefined
}

function extractSectionLines(lines: string[], heading: string, limit: number): string[] {
  const start = lines.findIndex(line => line.trim().toLowerCase() === heading.toLowerCase())
  if (start < 0) return []
  const collected: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ') && collected.length > 0) break
    if (!line.trim()) continue
    collected.push(line)
    if (collected.length >= limit) break
  }
  return collected
}

function normalizeTerms(query?: string): string[] {
  if (!query) return []
  return query
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .map(term => term.trim())
    .filter(term => term.length >= 3)
    .slice(0, 12)
}

function matchReportLines(lines: string[], query?: string, limit = MAX_MATCHES): string[] {
  const terms = normalizeTerms(query)
  if (terms.length === 0) return []
  const matches: string[] = []
  for (const line of lines) {
    const lower = line.toLowerCase()
    if (!terms.some(term => lower.includes(term))) continue
    matches.push(line)
    if (matches.length >= limit) break
  }
  return matches
}

function classifyFreshness(params: {
  builtFromCommit?: string
  currentCommit?: string
  reportModifiedAt?: string
  latestCommitIso?: string
}) {
  if (params.builtFromCommit && params.currentCommit) {
    const currentMatches = params.currentCommit.startsWith(params.builtFromCommit) || params.builtFromCommit.startsWith(params.currentCommit)
    return {
      status: currentMatches ? 'fresh' : 'stale',
      basis: 'commit',
      builtFromCommit: params.builtFromCommit,
      currentCommit: params.currentCommit
    }
  }

  if (params.reportModifiedAt && params.latestCommitIso) {
    const reportMs = Date.parse(params.reportModifiedAt)
    const commitMs = Date.parse(params.latestCommitIso)
    if (Number.isFinite(reportMs) && Number.isFinite(commitMs)) {
      return {
        status: reportMs >= commitMs ? 'fresh' : 'stale',
        basis: 'mtime_vs_latest_commit',
        reportModifiedAt: params.reportModifiedAt,
        latestCommitAt: params.latestCommitIso
      }
    }
  }

  return {
    status: 'unknown',
    basis: 'metadata_unavailable',
    builtFromCommit: params.builtFromCommit,
    currentCommit: params.currentCommit,
    reportModifiedAt: params.reportModifiedAt,
    latestCommitAt: params.latestCommitIso
  }
}

export async function handleGraphContext(body: GraphContextBody): Promise<GraphContextResult> {
  const startedAt = Date.now()
  const sourceId = body?.sourceId
  const limit = boundedInt(body?.limit, 8, 1, 10)

  try {
    if (!sourceId || typeof sourceId !== 'string') {
      return { statusCode: 400, payload: { error: 'sourceId is required' } }
    }

    const source = getSourcesSafe().find(item => item.id === sourceId && item.enabled)
    if (!source) {
      return { statusCode: 404, payload: { error: `Source not found or disabled: ${sourceId}` } }
    }

    const artifacts = await Promise.all([
      artifactInfo(source.path, GRAPH_REPORT),
      artifactInfo(source.path, GRAPH_JSON),
      artifactInfo(source.path, GRAPH_MANIFEST)
    ])
    const graphAvailable = artifacts.some(artifact => artifact.exists)

    if (!graphAvailable) {
      return {
        statusCode: 200,
        payload: {
          mode: 'graph_context',
          sourceId,
          graphAvailable: false,
          artifacts,
          freshness: { status: 'unknown', basis: 'missing_graphify_out' },
          warning: 'No cached Graphify artifacts were found at graphify-out/. Continue with focused reads or prepare_task_context.',
          nextActions: [
            { mode: 'prepare_task_context', query: body.query || 'Describe the concrete task goal.', limit: 5 }
          ],
          diagnostics: {
            operation: 'graph_context',
            elapsedMs: Date.now() - startedAt,
            phase: 'missing_graph_artifacts'
          }
        }
      }
    }

    const reportArtifact = artifacts.find(artifact => artifact.path === GRAPH_REPORT)
    const reportLines = await readReport(source.path)
    const builtFromCommit = extractBuiltCommit(reportLines)
    const [currentCommit, latestCommitIso] = await Promise.all([
      runGit(source.path, ['rev-parse', 'HEAD']),
      runGit(source.path, ['log', '-1', '--format=%cI'])
    ])
    const freshness = classifyFreshness({
      builtFromCommit,
      currentCommit,
      reportModifiedAt: reportArtifact?.modifiedAt,
      latestCommitIso
    })

    const communityHubs = extractSectionLines(reportLines, '## Community Hubs (Navigation)', limit)
    const godNodes = extractSectionLines(reportLines, '## God Nodes (most connected - your core abstractions)', limit)
    const matches = matchReportLines(reportLines, body.query, limit)

    return {
      statusCode: 200,
      payload: {
        mode: 'graph_context',
        sourceId,
        graphAvailable: true,
        artifacts,
        freshness,
        communityHubs,
        godNodes,
        matches,
        warning: freshness.status === 'fresh'
          ? 'Graph is a navigation aid. Verify exact source with focused reads before patching.'
          : 'Graph may be stale or freshness is unknown. Use it only as a navigation hint and verify with exact focused reads before patching.',
        nextActions: [
          { mode: 'grep_context', path: '<suggested-file>', pattern: '<specific symbol or phrase>', before: 8, after: 12, maxMatches: 5 },
          { mode: 'read_symbol', path: '<suggested-typescript-file>', symbol: '<suggested-symbol>' }
        ],
        diagnostics: {
          operation: 'graph_context',
          elapsedMs: Date.now() - startedAt,
          phase: 'completed_report_metadata_only',
          reportLinesRead: reportLines.length,
          note: 'Phase 1 reads cached Graphify metadata/report sections only. It does not parse full graph.json.'
        }
      }
    }
  } catch (err) {
    return {
      statusCode: 400,
      payload: {
        error: String(err),
        mode: 'graph_context',
        sourceId,
        diagnostics: {
          operation: 'graph_context',
          elapsedMs: Date.now() - startedAt,
          phase: 'failed',
          suggestedNextAction: 'Continue with grep_context, read_range, read_symbol, or prepare_task_context.'
        }
      }
    }
  }
}
