import {
  CONTEXT_INTELLIGENCE_MODEL_VERSION,
  isIndexJob,
  type IndexJob,
  type IndexJobOperation,
  type IndexJobPriority,
  type RepositoryHealth
} from './context-intelligence-models'

export type IndexRecommendation = 'none' | 'observe' | 'incremental' | 'full'
export type IndexPlanReasonCode =
  | 'fresh'
  | 'uncommitted_changes'
  | 'stale_revision'
  | 'stale_worktree'
  | 'indexing'
  | 'index_failed'
  | 'repository_unavailable'
  | 'unknown_source_state'
  | 'forced_full'
  | 'retry_scheduled'
  | 'retry_exhausted'

export type IndexRetryPlan = {
  attempt: number
  maxAttempts: number
  retryAllowed: boolean
  retryAfterMs: number
  nextAttemptAt?: string
}

export type IndexPlanningRequest = {
  health: RepositoryHealth
  requestedPriority?: IndexJobPriority
  forceFull?: boolean
  failureCount?: number
  lastFailureAt?: string
  jobId?: string
}

export type IndexPlan = {
  schemaVersion: typeof CONTEXT_INTELLIGENCE_MODEL_VERSION
  sourceId: string
  recommendation: IndexRecommendation
  operation: IndexJobOperation
  priority: IndexJobPriority
  reasonCodes: IndexPlanReasonCode[]
  rationale: string
  execution: 'recommendation_only'
  retry: IndexRetryPlan
  proposedJob?: IndexJob
  plannedAt: string
}

export type IndexPlannerOptions = {
  now?: () => Date
  maxAttempts?: number
  baseBackoffMs?: number
  maxBackoffMs?: number
}

const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_BASE_BACKOFF_MS = 1_000
const DEFAULT_MAX_BACKOFF_MS = 60_000

function addReason(reasons: IndexPlanReasonCode[], reason: IndexPlanReasonCode): void {
  if (!reasons.includes(reason)) reasons.push(reason)
}

function boundedFailureCount(value: number | undefined, maxAttempts: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(maxAttempts, Math.floor(value as number)))
}

function retryPlan(request: IndexPlanningRequest, options: IndexPlannerOptions, plannedAt: string): IndexRetryPlan {
  const maxAttempts = Math.max(1, Math.min(100, Math.floor(options.maxAttempts || DEFAULT_MAX_ATTEMPTS)))
  const attempt = boundedFailureCount(request.failureCount, maxAttempts)
  if (attempt === 0) return { attempt, maxAttempts, retryAllowed: true, retryAfterMs: 0 }
  if (attempt >= maxAttempts) return { attempt, maxAttempts, retryAllowed: false, retryAfterMs: 0 }

  const baseBackoffMs = Math.max(0, Math.min(86_400_000, Math.floor(options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS)))
  const maxBackoffMs = Math.max(baseBackoffMs, Math.min(86_400_000, Math.floor(options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS)))
  const retryAfterMs = Math.min(maxBackoffMs, baseBackoffMs * (2 ** (attempt - 1)))
  const failureAt = request.lastFailureAt && Number.isFinite(Date.parse(request.lastFailureAt))
    ? Date.parse(request.lastFailureAt)
    : Date.parse(plannedAt)
  return {
    attempt,
    maxAttempts,
    retryAllowed: true,
    retryAfterMs,
    nextAttemptAt: new Date(failureAt + retryAfterMs).toISOString()
  }
}

function recommendationFor(request: IndexPlanningRequest, retry: IndexRetryPlan): { recommendation: IndexRecommendation; operation: IndexJobOperation; reasons: IndexPlanReasonCode[]; rationale: string } {
  const health = request.health
  const reasons: IndexPlanReasonCode[] = []
  if (!retry.retryAllowed) {
    addReason(reasons, 'retry_exhausted')
    return { recommendation: 'none', operation: 'observe', reasons, rationale: 'Retry limit reached; no index work is recommended.' }
  }

  if (health.freshnessState === 'fresh') {
    addReason(reasons, 'fresh')
    return { recommendation: 'none', operation: 'observe', reasons, rationale: 'Repository index is fresh; no index work is recommended.' }
  }
  if (health.freshnessState === 'indexing' || health.indexStatus === 'indexing') {
    addReason(reasons, 'indexing')
    return { recommendation: 'none', operation: 'observe', reasons, rationale: 'Indexing is already in progress; no duplicate work is recommended.' }
  }
  if (health.freshnessState === 'unavailable' || health.runtimeAvailability === 'unavailable') {
    addReason(reasons, 'repository_unavailable')
    return { recommendation: 'observe', operation: 'observe', reasons, rationale: 'Repository is unavailable; observe again before planning index work.' }
  }
  if (health.freshnessState === 'unknown' || health.runtimeAvailability === 'unknown') {
    addReason(reasons, 'unknown_source_state')
    return { recommendation: 'observe', operation: 'observe', reasons, rationale: 'Repository state is unknown; observe before planning index work.' }
  }
  if (request.forceFull) {
    addReason(reasons, 'forced_full')
    return { recommendation: 'full', operation: 'full', reasons, rationale: 'Explicit full-index planning request was received.' }
  }
  if (health.freshnessState === 'fresh_with_uncommitted_changes') {
    addReason(reasons, 'uncommitted_changes')
    return { recommendation: 'incremental', operation: 'incremental', reasons, rationale: 'Uncommitted changes are present; incremental index work is recommended.' }
  }
  if (health.freshnessState === 'stale_worktree') {
    addReason(reasons, 'stale_worktree')
    return { recommendation: 'incremental', operation: 'incremental', reasons, rationale: 'The worktree changed while indexing was pending; incremental index work is recommended.' }
  }
  if (health.freshnessState === 'stale_revision') {
    addReason(reasons, 'stale_revision')
    return health.indexedRevision
      ? { recommendation: 'incremental', operation: 'incremental', reasons, rationale: 'The repository revision changed after indexing; incremental index work is recommended.' }
      : { recommendation: 'full', operation: 'full', reasons, rationale: 'The repository is stale and has no indexed revision; full index work is recommended.' }
  }
  addReason(reasons, 'index_failed')
  return { recommendation: 'full', operation: 'full', reasons, rationale: 'Index state is failed or otherwise not usable; full index work is recommended.' }
}

function priorityFor(request: IndexPlanningRequest, recommendation: IndexRecommendation): IndexJobPriority {
  if (request.requestedPriority) return request.requestedPriority
  if (recommendation === 'observe' || recommendation === 'none') return 'maintenance'
  return 'background'
}

function proposedJob(request: IndexPlanningRequest, plan: Omit<IndexPlan, 'proposedJob'>): IndexJob | undefined {
  if (plan.recommendation === 'none') return undefined
  const jobId = request.jobId || `index-plan-${plan.sourceId}-${plan.plannedAt.replace(/[^A-Za-z0-9]/g, '')}`
  const job: IndexJob = {
    schemaVersion: CONTEXT_INTELLIGENCE_MODEL_VERSION,
    jobId,
    sourceId: plan.sourceId,
    operation: plan.operation,
    priority: plan.priority,
    status: 'queued',
    createdAt: plan.plannedAt,
    updatedAt: plan.plannedAt,
    attempt: plan.retry.attempt,
    maxAttempts: plan.retry.maxAttempts,
    retryAfterMs: plan.retry.retryAfterMs,
    nextAttemptAt: plan.retry.nextAttemptAt
  }
  if (!isIndexJob(job)) throw new Error('Generated proposed index job failed validation.')
  return job
}

export function planIndex(request: IndexPlanningRequest, options: IndexPlannerOptions = {}): IndexPlan {
  const plannedAt = (options.now || (() => new Date()))().toISOString()
  const retry = retryPlan(request, options, plannedAt)
  const recommendation = recommendationFor(request, retry)
  const priority = priorityFor(request, recommendation.recommendation)
  if (request.failureCount && request.failureCount > 0 && retry.retryAllowed) addReason(recommendation.reasons, 'retry_scheduled')
  const planBase: Omit<IndexPlan, 'proposedJob'> = {
    schemaVersion: CONTEXT_INTELLIGENCE_MODEL_VERSION,
    sourceId: request.health.sourceId,
    recommendation: recommendation.recommendation,
    operation: recommendation.operation,
    priority,
    reasonCodes: recommendation.reasons,
    rationale: recommendation.rationale,
    execution: 'recommendation_only',
    retry,
    plannedAt
  }
  return { ...planBase, proposedJob: proposedJob(request, planBase) }
}

export class IndexPlanner {
  constructor(private readonly options: IndexPlannerOptions = {}) {}

  plan(request: IndexPlanningRequest): IndexPlan {
    return planIndex(request, this.options)
  }
}
