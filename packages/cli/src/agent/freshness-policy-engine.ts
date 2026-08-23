import {
  CONTEXT_INTELLIGENCE_MODEL_VERSION,
  isFreshnessPolicyResult,
  isRepositoryHealth,
  type FreshnessOperation,
  type FreshnessPolicyResult,
  type FreshnessWarningCode,
  type RepositoryHealth,
  type StaleContextMetadata
} from './context-intelligence-models'

export type FreshnessPolicyInput = {
  health: RepositoryHealth
  operation: FreshnessOperation
  explicitOverride?: boolean
}
export type FreshnessPolicyOptions = {
  now?: () => Date
}

const WARNING_MESSAGES: Record<FreshnessWarningCode, string> = {
  uncommitted_changes: 'Repository has uncommitted changes.',
  stale_revision: 'Indexed context does not match the current repository revision.',
  stale_worktree: 'Repository worktree changed while indexing is pending.',
  indexing: 'Repository indexing is currently in progress.',
  index_failed: 'Repository index state is failed or unknown.',
  repository_unavailable: 'Repository is unavailable for fresh context.',
  unknown_source_state: 'Repository source state is unknown.',
  override_applied: 'Explicit freshness override was applied.',
  override_not_permitted: 'This operation requires the strongest freshness guarantee; override was not applied.'
}

function addCode(codes: FreshnessWarningCode[], code: FreshnessWarningCode): void {
  if (!codes.includes(code)) codes.push(code)
}

function warningCodesFor(health: RepositoryHealth): FreshnessWarningCode[] {
  const codes: FreshnessWarningCode[] = []
  switch (health.freshnessState) {
    case 'fresh_with_uncommitted_changes':
      addCode(codes, 'uncommitted_changes')
      break
    case 'stale_revision':
      addCode(codes, 'stale_revision')
      break
    case 'stale_worktree':
      addCode(codes, 'stale_worktree')
      break
    case 'indexing':
      addCode(codes, 'indexing')
      break
    case 'failed':
      addCode(codes, 'index_failed')
      break
    case 'unavailable':
      addCode(codes, 'repository_unavailable')
      break
    case 'unknown':
      addCode(codes, 'unknown_source_state')
      break
  }
  if (health.gitStatus === 'dirty') addCode(codes, 'uncommitted_changes')
  return codes
}

function staleMetadata(health: RepositoryHealth): StaleContextMetadata | undefined {
  if (health.freshnessState === 'fresh') return undefined
  return {
    schemaVersion: CONTEXT_INTELLIGENCE_MODEL_VERSION,
    sourceId: health.sourceId,
    freshnessState: health.freshnessState,
    gitStatus: health.gitStatus,
    indexStatus: health.indexStatus,
    indexedRevision: health.indexedRevision,
    observedRevision: health.observedRevision,
    trackedChangedFileCount: health.trackedChangedFileCount,
    untrackedFileCount: health.untrackedFileCount,
    observedAt: health.lastCheckedAt
  }
}

function result(input: FreshnessPolicyInput, options: FreshnessPolicyOptions, decision: FreshnessPolicyResult['decision'], warningCodes: FreshnessWarningCode[], blockReason?: string, overrideApplied = false): FreshnessPolicyResult {
  const warnings = warningCodes.map(code => WARNING_MESSAGES[code])
  const evaluatedAt = (options.now || (() => new Date()))().toISOString()
  const output: FreshnessPolicyResult = {
    schemaVersion: CONTEXT_INTELLIGENCE_MODEL_VERSION,
    sourceId: input.health.sourceId,
    operation: input.operation,
    decision,
    overrideRequested: input.explicitOverride === true,
    overrideApplied,
    warningCodes,
    warnings,
    blockReason,
    staleContext: staleMetadata(input.health),
    evaluatedAt
  }
  if (!isFreshnessPolicyResult(output)) throw new Error('Generated freshness policy result failed validation.')
  return output
}

function invalidHealthResult(input: FreshnessPolicyInput, options: FreshnessPolicyOptions): FreshnessPolicyResult {
  const health = input.health as Partial<RepositoryHealth> | undefined
  const fallback: RepositoryHealth = {
    schemaVersion: CONTEXT_INTELLIGENCE_MODEL_VERSION,
    sourceId: typeof health?.sourceId === 'string' && health.sourceId.length > 0 ? health.sourceId : 'unknown-source',
    canonicalRepositoryPath: typeof health?.canonicalRepositoryPath === 'string' && health.canonicalRepositoryPath.length > 0 ? health.canonicalRepositoryPath : 'unknown',
    branchName: health?.branchName,
    gitStatus: 'unknown',
    trackedChangedFileCount: 0,
    untrackedFileCount: 0,
    indexedRevision: health?.indexedRevision,
    observedRevision: health?.observedRevision,
    indexStatus: 'unknown',
    freshnessState: 'unknown',
    freshnessScore: 0,
    runtimeAvailability: 'unknown',
    lastCheckedAt: (options.now || (() => new Date()))().toISOString()
  }
  return result({ ...input, health: fallback }, options, 'block', ['unknown_source_state'], 'Repository health is invalid or incomplete.')
}

export function evaluateFreshnessPolicy(input: FreshnessPolicyInput, options: FreshnessPolicyOptions = {}): FreshnessPolicyResult {
  if (!input || !isRepositoryHealth(input.health)) return invalidHealthResult(input, options)

  const state = input.health.freshnessState
  const overrideRequested = input.explicitOverride === true
  const warningCodes = warningCodesFor(input.health)
  const knownSourceState = state !== 'unknown' && state !== 'unavailable'
  const isFresh = state === 'fresh'

  if (input.operation === 'read') {
    if (!knownSourceState) return result(input, options, 'block', warningCodes, 'Repository state is unavailable for read context.')
    return result(input, options, warningCodes.length > 0 ? 'warn' : 'allow', warningCodes)
  }

  if (input.operation === 'task_preparation') {
    if (!knownSourceState) return result(input, options, 'block', warningCodes, 'Task preparation requires a known repository source state.')
    return result(input, options, warningCodes.length > 0 ? 'warn' : 'allow', warningCodes)
  }

  if (input.operation === 'mutation') {
    if (isFresh) return result(input, options, 'allow', warningCodes)
    if (overrideRequested && knownSourceState) {
      addCode(warningCodes, 'override_applied')
      return result(input, options, 'warn', warningCodes, undefined, true)
    }
    return result(input, options, 'block', warningCodes, knownSourceState ? 'Mutation requires fresh repository context or an explicit override.' : 'Mutation requires an available, known repository state.')
  }

  if (isFresh) return result(input, options, 'allow', warningCodes)
  if (overrideRequested) addCode(warningCodes, 'override_not_permitted')
  return result(input, options, 'block', warningCodes, 'Commands and commits require the strongest fresh repository guarantee.')
}

export class FreshnessPolicyEngine {
  constructor(private readonly options: FreshnessPolicyOptions = {}) {}

  evaluate(input: FreshnessPolicyInput): FreshnessPolicyResult {
    return evaluateFreshnessPolicy(input, this.options)
  }
}
