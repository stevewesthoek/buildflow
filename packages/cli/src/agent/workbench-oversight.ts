import type { AgentJobStatus, CompactStatusProjection } from './agent-jobs'

export type WorkbenchOversightEngine = 'direct' | 'codex' | 'future_adapter' | 'human'
export type WorkbenchOversightProfile = 'economy' | 'balanced' | 'frontier'
export type WorkbenchOversightHealth = 'healthy' | 'degraded' | 'blocked' | 'unknown'

export type WorkbenchOversightExecutionProfile = {
  engine: WorkbenchOversightEngine
  profile: WorkbenchOversightProfile
}

export type WorkbenchOversightRunInput = {
  repository: string
  runId: string
  status: AgentJobStatus
  updatedAt: string
  executionProfile: WorkbenchOversightExecutionProfile
  compactStatus: CompactStatusProjection
  lastEvidence?: string
}

export type WorkbenchOversightRunProjection = {
  repository: string
  runId: string
  status: AgentJobStatus
  currentPhase?: string
  activeTask?: string
  currentPosition: string
  completionPercent: number
  health: WorkbenchOversightHealth
  blocker?: string
  nextAction?: string
  lastEvidence: string
  executionProfile: WorkbenchOversightExecutionProfile
  stale: boolean
  reasonCodes: string[]
  updatedAt: string
}

export type WorkbenchOversightRepositoryProjection = WorkbenchOversightRunProjection & {
  duplicateRunCount: number
  runCount: number
}

export type WorkbenchOversightReport = {
  version: 1
  health: WorkbenchOversightHealth
  repositoryCount: number
  runCount: number
  duplicateRunCount: number
  staleRunCount: number
  reasonCodes: string[]
  repositories: WorkbenchOversightRepositoryProjection[]
  headline: string
  nextAction: string
  text: string
  narrowText: string
}

export type WorkbenchOversightInput = {
  runs: WorkbenchOversightRunInput[]
  now?: Date
  staleAfterMs?: number
  maxRepositories?: number
}

const MAX_TEXT_BYTES = 1_000
const MAX_HEADLINE_BYTES = 180
const MAX_NEXT_ACTION_BYTES = 220
const DEFAULT_STALE_AFTER_MS = 5 * 60_000
const DEFAULT_MAX_REPOSITORIES = 6

const STATUS_PRIORITY: Record<AgentJobStatus, number> = {
  running: 0,
  needs_confirmation: 1,
  blocked: 2,
  paused: 3,
  queued: 4,
  completed: 5,
  failed: 6,
  cancelled: 7
}

function boundedText(value: string, limit: number): string {
  const buffer = Buffer.from(value || '', 'utf8')
  if (buffer.byteLength <= limit) return value
  return buffer.subarray(0, limit).toString('utf8')
}

function normalizeText(value: string | undefined): string | undefined {
  const text = String(value || '').trim()
  return text || undefined
}

function parseTimestamp(value: string | undefined): number {
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
}

function summarizeStatus(status: AgentJobStatus, stale: boolean): { health: WorkbenchOversightHealth; reasonCodes: string[] } {
  if (stale) return { health: 'degraded', reasonCodes: ['stale_run'] }
  if (status === 'blocked' || status === 'needs_confirmation') return { health: 'blocked', reasonCodes: ['blocked_run'] }
  if (status === 'paused') return { health: 'degraded', reasonCodes: ['paused_run'] }
  if (status === 'failed' || status === 'cancelled') return { health: 'degraded', reasonCodes: [`${status}_run`] }
  if (status === 'completed') return { health: 'healthy', reasonCodes: ['completed_run'] }
  return { health: 'healthy', reasonCodes: ['active_run'] }
}

function projectRun(input: WorkbenchOversightRunInput, nowMs: number, staleAfterMs: number): WorkbenchOversightRunProjection {
  const currentPhase = normalizeText(input.compactStatus.phaseTitle)
  const activeTask = normalizeText(input.compactStatus.taskTitle)
  const currentPosition = normalizeText(input.compactStatus.currentPosition) || 'No active task'
  const completionPercent = Math.min(100, Math.max(0, Math.round(input.compactStatus.overall.percent)))
  const stale = Number.isFinite(parseTimestamp(input.updatedAt)) ? nowMs - parseTimestamp(input.updatedAt) > staleAfterMs : true
  const lastEvidence = normalizeText(input.lastEvidence) || 'unknown'
  const statusSummary = summarizeStatus(input.status, stale)
  const reasonCodes = [...statusSummary.reasonCodes]
  if (input.compactStatus.blocker) reasonCodes.push('blocker_present')
  if (input.compactStatus.nextAction) reasonCodes.push('next_action_present')
  if (lastEvidence === 'unknown') reasonCodes.push('last_evidence_missing')
  return {
    repository: input.repository,
    runId: input.runId,
    status: input.status,
    currentPhase,
    activeTask,
    currentPosition,
    completionPercent,
    health: statusSummary.health,
    blocker: normalizeText(input.compactStatus.blocker),
    nextAction: normalizeText(input.compactStatus.nextAction),
    lastEvidence,
    executionProfile: input.executionProfile,
    stale,
    reasonCodes: [...new Set(reasonCodes)].slice(0, 8),
    updatedAt: input.updatedAt
  }
}

function selectRepositoryRun(runs: WorkbenchOversightRunProjection[]): { selected: WorkbenchOversightRunProjection; duplicateRunCount: number } {
  const deduped = new Map<string, WorkbenchOversightRunProjection>()
  let duplicateRunCount = 0
  for (const run of runs) {
    const existing = deduped.get(run.runId)
    if (!existing) {
      deduped.set(run.runId, run)
      continue
    }
    duplicateRunCount += 1
    const existingTime = parseTimestamp(existing.updatedAt)
    const candidateTime = parseTimestamp(run.updatedAt)
    if (candidateTime > existingTime || (candidateTime === existingTime && run.currentPosition.localeCompare(existing.currentPosition) < 0)) {
      deduped.set(run.runId, run)
    }
  }

  const ordered = [...deduped.values()].sort((a, b) => {
    const rankDelta = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status]
    if (rankDelta !== 0) return rankDelta
    const timeDelta = parseTimestamp(b.updatedAt) - parseTimestamp(a.updatedAt)
    if (timeDelta !== 0) return timeDelta
    return a.runId.localeCompare(b.runId)
  })
  const selected = ordered[0]
  if (!selected) {
    throw new Error('At least one run is required')
  }
  return { selected, duplicateRunCount }
}

export function projectWorkbenchOversightRun(input: WorkbenchOversightRunInput, options: { now?: Date; staleAfterMs?: number } = {}): WorkbenchOversightRunProjection {
  const nowMs = (options.now ?? new Date()).getTime()
  const staleAfterMs = Math.max(1, Math.floor(options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS))
  return projectRun(input, nowMs, staleAfterMs)
}

export function aggregateWorkbenchOversight(input: WorkbenchOversightInput): WorkbenchOversightReport {
  const nowMs = (input.now ?? new Date()).getTime()
  const staleAfterMs = Math.max(1, Math.floor(input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS))
  const maxRepositories = Math.max(1, Math.floor(input.maxRepositories ?? DEFAULT_MAX_REPOSITORIES))

  const runProjections = input.runs.map(run => projectRun(run, nowMs, staleAfterMs))
  const grouped = new Map<string, WorkbenchOversightRunProjection[]>()
  for (const run of runProjections) {
    const bucket = grouped.get(run.repository) || []
    bucket.push(run)
    grouped.set(run.repository, bucket)
  }

  const repositories = [...grouped.entries()].map(([repository, runs]) => {
    const { selected, duplicateRunCount } = selectRepositoryRun(runs)
    return {
      ...selected,
      repository,
      duplicateRunCount,
      runCount: runs.length
    }
  }).sort((a, b) => {
    const healthRank = { blocked: 0, degraded: 1, healthy: 2, unknown: 3 } as const
    const healthDelta = healthRank[a.health] - healthRank[b.health]
    if (healthDelta !== 0) return healthDelta
    const timeDelta = parseTimestamp(b.updatedAt) - parseTimestamp(a.updatedAt)
    if (timeDelta !== 0) return timeDelta
    return a.repository.localeCompare(b.repository)
  }).slice(0, maxRepositories)

  const duplicateRunCount = repositories.reduce((count, item) => count + item.duplicateRunCount, 0)
  const staleRunCount = repositories.filter(item => item.stale).length
  const health: WorkbenchOversightHealth =
    repositories.some(item => item.health === 'blocked') ? 'blocked'
      : repositories.some(item => item.health === 'degraded') ? 'degraded'
        : repositories.length > 0 ? 'healthy'
          : 'unknown'
  const reasonCodes = [
    ...new Set(repositories.flatMap(item => item.reasonCodes).concat(
      duplicateRunCount > 0 ? ['duplicate_run_suppressed'] : [],
      staleRunCount > 0 ? ['stale_run_present'] : []
    ))
  ].slice(0, 10)

  const headline = `oversight ${repositories.length} repos ${health}`
  const nextAction =
    health === 'blocked'
      ? 'Inspect the blocked repository before continuing.'
      : health === 'degraded'
        ? 'Review stale or paused runs and resume what is safe.'
        : repositories.length > 0
          ? 'Continue with the currently active repositories.'
          : 'No persisted runs are available.'
  const text = [
    `Repositories ${repositories.length} · Runs ${runProjections.length} · Stale ${staleRunCount} · Duplicates ${duplicateRunCount}`,
    ...repositories.map(item => [
      `${item.repository} · ${item.runId} · ${item.status}`,
      `Phase ${item.currentPhase || 'unknown'} · Task ${item.activeTask || 'unknown'}`,
      `P ${item.completionPercent}% · ${item.health}${item.stale ? ' · stale' : ''}${item.blocker ? ` · blocker ${item.blocker}` : ''}${item.nextAction ? ` · next ${item.nextAction}` : ''}`,
      `Evidence ${item.lastEvidence}`,
      `Exec ${item.executionProfile.engine}/${item.executionProfile.profile}`
    ].join(' | '))
  ].join('\n')
  const narrowText = [
    `Repos ${repositories.length} · Runs ${runProjections.length} · ${health}`,
    ...repositories.map(item => `${item.repository} · ${item.status} · ${item.completionPercent}%${item.stale ? ' · stale' : ''} · ${item.lastEvidence}`)
  ].join('\n')

  return {
    version: 1,
    health,
    repositoryCount: repositories.length,
    runCount: runProjections.length,
    duplicateRunCount,
    staleRunCount,
    reasonCodes,
    repositories,
    headline: boundedText(headline, MAX_HEADLINE_BYTES),
    nextAction: boundedText(nextAction, MAX_NEXT_ACTION_BYTES),
    text: boundedText(text, MAX_TEXT_BYTES),
    narrowText: boundedText(narrowText, MAX_TEXT_BYTES)
  }
}

export function buildWorkbenchOversightReport(input: WorkbenchOversightInput): WorkbenchOversightReport {
  return aggregateWorkbenchOversight(input)
}
