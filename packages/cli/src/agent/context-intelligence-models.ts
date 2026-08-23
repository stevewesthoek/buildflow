import type { SourceIndexStatus } from './index-state'

export const CONTEXT_INTELLIGENCE_MODEL_VERSION = 1 as const

export type ContextSessionMode = 'single' | 'multi' | 'admin'
export type ContextSessionStatus = 'proposed' | 'confirmed' | 'expired' | 'cleared'
export type ContextAuthorityLevel = 'explicit-user' | 'confirmed-suggestion' | 'inferred-suggestion'

export type ContextSession = {
  schemaVersion: typeof CONTEXT_INTELLIGENCE_MODEL_VERSION
  sessionId: string
  clientId: string
  ownerId?: string
  createdBy?: string
  sourceIds: string[]
  mode: ContextSessionMode
  status: ContextSessionStatus
  authorityLevel: ContextAuthorityLevel
  createdAt: string
  confirmedAt?: string
  expiresAt?: string
}

export type ContextProposalCandidate = {
  sourceId: string
  confidenceScore: number
  matchReasons: string[]
}

export type ContextProposalConfirmationState = 'pending' | 'confirmed' | 'expired'
export type ContextProposalAmbiguityStatus = 'none' | 'ambiguous' | 'unresolved'
export type ContextActivationFailureReason =
  | 'proposal_missing'
  | 'proposal_expired'
  | 'source_missing'
  | 'source_disabled'
  | 'repository_unavailable'
  | 'confirmation_required'
  | 'store_unavailable'

export type ContextProposal = {
  schemaVersion: typeof CONTEXT_INTELLIGENCE_MODEL_VERSION
  proposalId: string
  sessionId?: string
  candidates: ContextProposalCandidate[]
  ambiguityStatus: ContextProposalAmbiguityStatus
  ambiguityReason?: string
  confirmationRequired: boolean
  confirmationState: ContextProposalConfirmationState
  createdAt: string
}

export type ContextEventType =
  | 'session.created'
  | 'proposal.created'
  | 'proposal.confirmed'
  | 'source.changed'
  | 'session.expired'
  | 'session.cleared'
  | 'proposal.activation_requested'
  | 'proposal.activation_confirmed'
  | 'proposal.activation_failed'

export type ContextEvent = {
  schemaVersion: typeof CONTEXT_INTELLIGENCE_MODEL_VERSION
  eventId: string
  eventType: ContextEventType
  sessionId: string
  clientId: string
  proposalId?: string
  sourceIds: string[]
  previousSourceIds?: string[]
  reasonCode?: ContextActivationFailureReason
  occurredAt: string
}

export type RepositoryGitStatus = 'clean' | 'dirty' | 'unknown' | 'unavailable'
export type RepositoryRuntimeAvailability = 'available' | 'unavailable' | 'unknown'
export type RepositoryFreshnessState =
  | 'fresh'
  | 'fresh_with_uncommitted_changes'
  | 'stale_revision'
  | 'stale_worktree'
  | 'indexing'
  | 'failed'
  | 'unavailable'
  | 'unknown'

export type RepositoryHealth = {
  schemaVersion: typeof CONTEXT_INTELLIGENCE_MODEL_VERSION
  sourceId: string
  canonicalRepositoryPath: string
  branchName?: string
  gitStatus: RepositoryGitStatus
  trackedChangedFileCount: number
  untrackedFileCount: number
  indexedRevision?: string
  indexGeneration?: string
  observedRevision?: string
  indexStatus: SourceIndexStatus
  freshnessState: RepositoryFreshnessState
  freshnessScore: number
  runtimeAvailability: RepositoryRuntimeAvailability
  lastCheckedAt: string
}

export type FreshnessOperation = 'read' | 'task_preparation' | 'mutation' | 'command' | 'commit'
export type FreshnessPolicyDecision = 'allow' | 'warn' | 'block'
export type FreshnessWarningCode =
  | 'uncommitted_changes'
  | 'stale_revision'
  | 'stale_worktree'
  | 'indexing'
  | 'index_failed'
  | 'repository_unavailable'
  | 'unknown_source_state'
  | 'override_applied'
  | 'override_not_permitted'

export type StaleContextMetadata = {
  schemaVersion: typeof CONTEXT_INTELLIGENCE_MODEL_VERSION
  sourceId: string
  freshnessState: RepositoryFreshnessState
  gitStatus: RepositoryGitStatus
  indexStatus: SourceIndexStatus
  indexedRevision?: string
  observedRevision?: string
  trackedChangedFileCount: number
  untrackedFileCount: number
  observedAt: string
}

export type FreshnessPolicyResult = {
  schemaVersion: typeof CONTEXT_INTELLIGENCE_MODEL_VERSION
  sourceId: string
  operation: FreshnessOperation
  decision: FreshnessPolicyDecision
  overrideRequested: boolean
  overrideApplied: boolean
  warningCodes: FreshnessWarningCode[]
  warnings: string[]
  blockReason?: string
  staleContext?: StaleContextMetadata
  evaluatedAt: string
}

export type ContextBudget = {
  schemaVersion: typeof CONTEXT_INTELLIGENCE_MODEL_VERSION
  maximumRepositories: number
  maximumFiles: number
  maximumBytes: number
  maximumQueries: number
}

export type IndexJobOperation = 'observe' | 'incremental' | 'full'
export type IndexJobPriority = 'interactive' | 'background' | 'maintenance'
export type IndexJobStatus = 'queued' | 'claimed' | 'observing' | 'planned' | 'running' | 'completed' | 'failed' | 'cancelled'

export type IndexJobResult = {
  indexedFiles?: number
  indexedRevision?: string
  indexGeneration?: string
  changedFileCount?: number
}

export type IndexJob = {
  schemaVersion: typeof CONTEXT_INTELLIGENCE_MODEL_VERSION
  jobId: string
  sourceId: string
  operation: IndexJobOperation
  mode?: IndexJobOperation
  priority: IndexJobPriority
  status: IndexJobStatus
  reason?: string
  changedPaths?: string[]
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
  error?: string
  result?: IndexJobResult
  attempt?: number
  maxAttempts?: number
  retryAfterMs?: number
  nextAttemptAt?: string
  leaseId?: string
  leaseOwner?: string
  leaseExpiresAt?: string
  cancelRequested?: boolean
  proposalId?: string
  contextSessionId?: string
}

const MAX_IDENTIFIER = 200
const MAX_SOURCE_IDS = 32
const MAX_PROPOSAL_CANDIDATES = 32
const MAX_MATCH_REASONS = 8
const MAX_TEXT = 240

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_IDENTIFIER
    && /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)
}

function validText(value: unknown, maxLength = MAX_TEXT): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
}

function validOptionalTimestamp(value: unknown): value is string | undefined {
  return value === undefined || validTimestamp(value)
}

function validEnum(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === 'string' && allowed.includes(value)
}

function validIndexStatus(value: unknown): value is SourceIndexStatus {
  return validEnum(value, ['ready', 'pending', 'indexing', 'failed', 'disabled', 'unknown'])
}

export function validateContextSession(value: unknown): string[] {
  const item = asRecord(value)
  if (!item) return ['ContextSession must be an object.']

  const errors: string[] = []
  if (item.schemaVersion !== CONTEXT_INTELLIGENCE_MODEL_VERSION) errors.push('schemaVersion is unsupported.')
  if (!validIdentifier(item.sessionId)) errors.push('sessionId is invalid.')
  if (!validIdentifier(item.clientId)) errors.push('clientId is invalid.')
  if (item.ownerId !== undefined && !validIdentifier(item.ownerId)) errors.push('ownerId is invalid.')
  if (item.createdBy !== undefined && !validIdentifier(item.createdBy)) errors.push('createdBy is invalid.')
  if (!Array.isArray(item.sourceIds) || item.sourceIds.length > MAX_SOURCE_IDS || !item.sourceIds.every(validIdentifier)) {
    errors.push('sourceIds must contain bounded valid identifiers.')
  } else if (new Set(item.sourceIds).size !== item.sourceIds.length) {
    errors.push('sourceIds must not contain duplicates.')
  }
  if (!validEnum(item.mode, ['single', 'multi', 'admin'])) errors.push('mode is invalid.')
  if (!validEnum(item.status, ['proposed', 'confirmed', 'expired', 'cleared'])) errors.push('status is invalid.')
  if (!validEnum(item.authorityLevel, ['explicit-user', 'confirmed-suggestion', 'inferred-suggestion'])) {
    errors.push('authorityLevel is invalid.')
  }
  if (!validTimestamp(item.createdAt)) errors.push('createdAt is invalid.')
  if (!validOptionalTimestamp(item.confirmedAt)) errors.push('confirmedAt is invalid.')
  if (!validOptionalTimestamp(item.expiresAt)) errors.push('expiresAt is invalid.')

  if (item.mode === 'single' && Array.isArray(item.sourceIds) && item.sourceIds.length !== 1) {
    errors.push('single mode requires exactly one sourceId.')
  }
  if (item.mode === 'multi' && Array.isArray(item.sourceIds) && item.sourceIds.length === 0) {
    errors.push('multi mode requires at least one sourceId.')
  }

  return errors
}

export function isContextSession(value: unknown): value is ContextSession {
  return validateContextSession(value).length === 0
}

export function validateContextProposal(value: unknown): string[] {
  const item = asRecord(value)
  if (!item) return ['ContextProposal must be an object.']

  const errors: string[] = []
  if (item.schemaVersion !== CONTEXT_INTELLIGENCE_MODEL_VERSION) errors.push('schemaVersion is unsupported.')
  if (!validIdentifier(item.proposalId)) errors.push('proposalId is invalid.')
  if (item.sessionId !== undefined && !validIdentifier(item.sessionId)) errors.push('sessionId is invalid.')
  if (!validEnum(item.ambiguityStatus, ['none', 'ambiguous', 'unresolved'])) errors.push('ambiguityStatus is invalid.')
  if (!Array.isArray(item.candidates) || item.candidates.length > MAX_PROPOSAL_CANDIDATES || (item.candidates.length === 0 && item.ambiguityStatus !== 'unresolved')) {
    errors.push('candidates must be bounded and non-empty unless unresolved.')
  } else {
    const sourceIds = new Set<string>()
    item.candidates.forEach((candidate, index) => {
      const entry = asRecord(candidate)
      if (!entry) {
        errors.push(`candidates[${index}] must be an object.`)
        return
      }
      if (!validIdentifier(entry.sourceId)) errors.push(`candidates[${index}].sourceId is invalid.`)
      if (typeof entry.sourceId === 'string') {
        if (sourceIds.has(entry.sourceId)) errors.push(`candidates[${index}].sourceId is duplicated.`)
        sourceIds.add(entry.sourceId)
      }
      if (typeof entry.confidenceScore !== 'number' || !Number.isFinite(entry.confidenceScore) || entry.confidenceScore < 0 || entry.confidenceScore > 1) {
        errors.push(`candidates[${index}].confidenceScore must be between 0 and 1.`)
      }
      if (!Array.isArray(entry.matchReasons) || entry.matchReasons.length === 0 || entry.matchReasons.length > MAX_MATCH_REASONS || !entry.matchReasons.every(reason => validText(reason, MAX_TEXT))) {
        errors.push(`candidates[${index}].matchReasons is invalid.`)
      }
    })
  }
  if (!validOptionalText(item.ambiguityReason)) errors.push('ambiguityReason is invalid.')
  if (typeof item.confirmationRequired !== 'boolean') errors.push('confirmationRequired must be boolean.')
  if (!validEnum(item.confirmationState, ['pending', 'confirmed', 'expired'])) errors.push('confirmationState is invalid.')
  if (!validTimestamp(item.createdAt)) errors.push('createdAt is invalid.')
  return errors
}

export function isContextProposal(value: unknown): value is ContextProposal {
  return validateContextProposal(value).length === 0
}

export function validateContextEvent(value: unknown): string[] {
  const item = asRecord(value)
  if (!item) return ['ContextEvent must be an object.']

  const errors: string[] = []
  if (item.schemaVersion !== CONTEXT_INTELLIGENCE_MODEL_VERSION) errors.push('schemaVersion is unsupported.')
  if (!validIdentifier(item.eventId)) errors.push('eventId is invalid.')
  if (!validEnum(item.eventType, ['session.created', 'proposal.created', 'proposal.confirmed', 'source.changed', 'session.expired', 'session.cleared', 'proposal.activation_requested', 'proposal.activation_confirmed', 'proposal.activation_failed'])) {
    errors.push('eventType is invalid.')
  }
  if (!validIdentifier(item.sessionId)) errors.push('sessionId is invalid.')
  if (!validIdentifier(item.clientId)) errors.push('clientId is invalid.')
  if (item.proposalId !== undefined && !validIdentifier(item.proposalId)) errors.push('proposalId is invalid.')
  if (!Array.isArray(item.sourceIds) || item.sourceIds.length > MAX_SOURCE_IDS || !item.sourceIds.every(validIdentifier)) {
    errors.push('sourceIds must contain bounded valid identifiers.')
  } else if (new Set(item.sourceIds).size !== item.sourceIds.length) {
    errors.push('sourceIds must not contain duplicates.')
  }
  if (item.previousSourceIds !== undefined) {
    if (!Array.isArray(item.previousSourceIds) || item.previousSourceIds.length > MAX_SOURCE_IDS || !item.previousSourceIds.every(validIdentifier)) {
      errors.push('previousSourceIds must contain bounded valid identifiers.')
    } else if (new Set(item.previousSourceIds).size !== item.previousSourceIds.length) {
      errors.push('previousSourceIds must not contain duplicates.')
    }
  }
  if (item.reasonCode !== undefined && !validEnum(item.reasonCode, ['proposal_missing', 'proposal_expired', 'source_missing', 'source_disabled', 'repository_unavailable', 'confirmation_required', 'store_unavailable'])) {
    errors.push('reasonCode is invalid.')
  }
  if (!validTimestamp(item.occurredAt)) errors.push('occurredAt is invalid.')
  return errors
}

export function isContextEvent(value: unknown): value is ContextEvent {
  return validateContextEvent(value).length === 0
}

export function validateRepositoryHealth(value: unknown): string[] {
  const item = asRecord(value)
  if (!item) return ['RepositoryHealth must be an object.']

  const errors: string[] = []
  if (item.schemaVersion !== CONTEXT_INTELLIGENCE_MODEL_VERSION) errors.push('schemaVersion is unsupported.')
  if (!validIdentifier(item.sourceId)) errors.push('sourceId is invalid.')
  if (!validText(item.canonicalRepositoryPath, 4096)) errors.push('canonicalRepositoryPath is invalid.')
  if (item.branchName !== undefined && !validText(item.branchName, 255)) errors.push('branchName is invalid.')
  if (!validEnum(item.gitStatus, ['clean', 'dirty', 'unknown', 'unavailable'])) errors.push('gitStatus is invalid.')
  if (typeof item.trackedChangedFileCount !== 'number' || !Number.isSafeInteger(item.trackedChangedFileCount) || item.trackedChangedFileCount < 0) {
    errors.push('trackedChangedFileCount must be a non-negative safe integer.')
  }
  if (typeof item.untrackedFileCount !== 'number' || !Number.isSafeInteger(item.untrackedFileCount) || item.untrackedFileCount < 0) {
    errors.push('untrackedFileCount must be a non-negative safe integer.')
  }
  if (!validOptionalText(item.indexedRevision, 256)) errors.push('indexedRevision is invalid.')
  if (!validOptionalTimestamp(item.indexGeneration)) errors.push('indexGeneration is invalid.')
  if (!validOptionalText(item.observedRevision, 256)) errors.push('observedRevision is invalid.')
  if (!validIndexStatus(item.indexStatus)) errors.push('indexStatus is invalid.')
  if (!validEnum(item.freshnessState, ['fresh', 'fresh_with_uncommitted_changes', 'stale_revision', 'stale_worktree', 'indexing', 'failed', 'unavailable', 'unknown'])) {
    errors.push('freshnessState is invalid.')
  }
  if (typeof item.freshnessScore !== 'number' || !Number.isFinite(item.freshnessScore) || item.freshnessScore < 0 || item.freshnessScore > 100) {
    errors.push('freshnessScore must be between 0 and 100.')
  }
  if (!validEnum(item.runtimeAvailability, ['available', 'unavailable', 'unknown'])) errors.push('runtimeAvailability is invalid.')
  if (!validTimestamp(item.lastCheckedAt)) errors.push('lastCheckedAt is invalid.')
  return errors
}

export function isRepositoryHealth(value: unknown): value is RepositoryHealth {
  return validateRepositoryHealth(value).length === 0
}

export function validateStaleContextMetadata(value: unknown): string[] {
  const item = asRecord(value)
  if (!item) return ['StaleContextMetadata must be an object.']
  const errors: string[] = []
  if (item.schemaVersion !== CONTEXT_INTELLIGENCE_MODEL_VERSION) errors.push('schemaVersion is unsupported.')
  if (!validIdentifier(item.sourceId)) errors.push('sourceId is invalid.')
  if (!validEnum(item.freshnessState, ['fresh', 'fresh_with_uncommitted_changes', 'stale_revision', 'stale_worktree', 'indexing', 'failed', 'unavailable', 'unknown'])) errors.push('freshnessState is invalid.')
  if (!validEnum(item.gitStatus, ['clean', 'dirty', 'unknown', 'unavailable'])) errors.push('gitStatus is invalid.')
  if (!validIndexStatus(item.indexStatus)) errors.push('indexStatus is invalid.')
  if (!validOptionalText(item.indexedRevision, 256)) errors.push('indexedRevision is invalid.')
  if (!validOptionalText(item.observedRevision, 256)) errors.push('observedRevision is invalid.')
  if (typeof item.trackedChangedFileCount !== 'number' || !Number.isSafeInteger(item.trackedChangedFileCount) || item.trackedChangedFileCount < 0) errors.push('trackedChangedFileCount is invalid.')
  if (typeof item.untrackedFileCount !== 'number' || !Number.isSafeInteger(item.untrackedFileCount) || item.untrackedFileCount < 0) errors.push('untrackedFileCount is invalid.')
  if (!validTimestamp(item.observedAt)) errors.push('observedAt is invalid.')
  return errors
}

export function isStaleContextMetadata(value: unknown): value is StaleContextMetadata {
  return validateStaleContextMetadata(value).length === 0
}

export function validateFreshnessPolicyResult(value: unknown): string[] {
  const item = asRecord(value)
  if (!item) return ['FreshnessPolicyResult must be an object.']
  const errors: string[] = []
  if (item.schemaVersion !== CONTEXT_INTELLIGENCE_MODEL_VERSION) errors.push('schemaVersion is unsupported.')
  if (!validIdentifier(item.sourceId)) errors.push('sourceId is invalid.')
  if (!validEnum(item.operation, ['read', 'task_preparation', 'mutation', 'command', 'commit'])) errors.push('operation is invalid.')
  if (!validEnum(item.decision, ['allow', 'warn', 'block'])) errors.push('decision is invalid.')
  if (typeof item.overrideRequested !== 'boolean') errors.push('overrideRequested must be boolean.')
  if (typeof item.overrideApplied !== 'boolean') errors.push('overrideApplied must be boolean.')
  if (!Array.isArray(item.warningCodes) || item.warningCodes.length > 8 || !item.warningCodes.every(code => validEnum(code, ['uncommitted_changes', 'stale_revision', 'stale_worktree', 'indexing', 'index_failed', 'repository_unavailable', 'unknown_source_state', 'override_applied', 'override_not_permitted']))) errors.push('warningCodes are invalid.')
  if (!Array.isArray(item.warnings) || item.warnings.length > 8 || !item.warnings.every(warning => validText(warning))) errors.push('warnings are invalid.')
  if (!validOptionalText(item.blockReason)) errors.push('blockReason is invalid.')
  if (item.staleContext !== undefined && !isStaleContextMetadata(item.staleContext)) errors.push('staleContext is invalid.')
  if (!validTimestamp(item.evaluatedAt)) errors.push('evaluatedAt is invalid.')
  return errors
}

export function isFreshnessPolicyResult(value: unknown): value is FreshnessPolicyResult {
  return validateFreshnessPolicyResult(value).length === 0
}

export function validateContextBudget(value: unknown): string[] {
  const item = asRecord(value)
  if (!item) return ['ContextBudget must be an object.']

  const errors: string[] = []
  if (item.schemaVersion !== CONTEXT_INTELLIGENCE_MODEL_VERSION) errors.push('schemaVersion is unsupported.')
  for (const field of ['maximumRepositories', 'maximumFiles', 'maximumBytes', 'maximumQueries']) {
    const numberValue = item[field]
    if (typeof numberValue !== 'number' || !Number.isSafeInteger(numberValue) || numberValue < 0) {
      errors.push(`${field} must be a non-negative safe integer.`)
    }
  }
  return errors
}

export function isContextBudget(value: unknown): value is ContextBudget {
  return validateContextBudget(value).length === 0
}

export function validateIndexJob(value: unknown): string[] {
  const item = asRecord(value)
  if (!item) return ['IndexJob must be an object.']

  const errors: string[] = []
  if (item.schemaVersion !== CONTEXT_INTELLIGENCE_MODEL_VERSION) errors.push('schemaVersion is unsupported.')
  if (!validIdentifier(item.jobId)) errors.push('jobId is invalid.')
  if (!validIdentifier(item.sourceId)) errors.push('sourceId is invalid.')
  if (!validEnum(item.operation, ['observe', 'incremental', 'full'])) errors.push('operation is invalid.')
  if (!validEnum(item.priority, ['interactive', 'background', 'maintenance'])) errors.push('priority is invalid.')
  if (!validEnum(item.status, ['queued', 'claimed', 'observing', 'planned', 'running', 'completed', 'failed', 'cancelled'])) errors.push('status is invalid.')
  if (!validTimestamp(item.createdAt)) errors.push('createdAt is invalid.')
  if (!validTimestamp(item.updatedAt)) errors.push('updatedAt is invalid.')
  if (!validOptionalTimestamp(item.startedAt)) errors.push('startedAt is invalid.')
  if (!validOptionalTimestamp(item.completedAt)) errors.push('completedAt is invalid.')
  if (!validOptionalText(item.error, 500)) errors.push('error is invalid.')
  if (item.mode !== undefined && !validEnum(item.mode, ['observe', 'incremental', 'full'])) errors.push('mode is invalid.')
  if (item.reason !== undefined && !validText(item.reason, 500)) errors.push('reason is invalid.')
  if (item.changedPaths !== undefined && (!Array.isArray(item.changedPaths) || item.changedPaths.length > 5_000 || !item.changedPaths.every(path => validText(path, 1_000)))) errors.push('changedPaths is invalid.')
  if (item.result !== undefined) {
    const result = asRecord(item.result)
    if (!result || (result.indexedFiles !== undefined && (!Number.isSafeInteger(result.indexedFiles) || (result.indexedFiles as number) < 0)) || (result.changedFileCount !== undefined && (!Number.isSafeInteger(result.changedFileCount) || (result.changedFileCount as number) < 0)) || !validOptionalText(result.indexedRevision, 256) || !validOptionalTimestamp(result.indexGeneration)) errors.push('result is invalid.')
  }
  if (item.attempt !== undefined && (!Number.isSafeInteger(item.attempt) || (item.attempt as number) < 0 || (item.attempt as number) > 100)) errors.push('attempt is invalid.')
  if (item.maxAttempts !== undefined && (!Number.isSafeInteger(item.maxAttempts) || (item.maxAttempts as number) < 1 || (item.maxAttempts as number) > 100)) errors.push('maxAttempts is invalid.')
  if (item.attempt !== undefined && item.maxAttempts !== undefined && (item.attempt as number) > (item.maxAttempts as number)) errors.push('attempt cannot exceed maxAttempts.')
  if (item.retryAfterMs !== undefined && (!Number.isSafeInteger(item.retryAfterMs) || (item.retryAfterMs as number) < 0 || (item.retryAfterMs as number) > 86_400_000)) errors.push('retryAfterMs is invalid.')
  if (!validOptionalTimestamp(item.nextAttemptAt)) errors.push('nextAttemptAt is invalid.')
  if (item.leaseId !== undefined && !validIdentifier(item.leaseId)) errors.push('leaseId is invalid.')
  if (item.leaseOwner !== undefined && !validIdentifier(item.leaseOwner)) errors.push('leaseOwner is invalid.')
  if (!validOptionalTimestamp(item.leaseExpiresAt)) errors.push('leaseExpiresAt is invalid.')
  if (item.cancelRequested !== undefined && typeof item.cancelRequested !== 'boolean') errors.push('cancelRequested is invalid.')
  if (item.proposalId !== undefined && !validIdentifier(item.proposalId)) errors.push('proposalId is invalid.')
  if (item.contextSessionId !== undefined && !validIdentifier(item.contextSessionId)) errors.push('contextSessionId is invalid.')
  return errors
}

export function isIndexJob(value: unknown): value is IndexJob {
  return validateIndexJob(value).length === 0
}

function validOptionalText(value: unknown, maxLength = MAX_TEXT): value is string | undefined {
  return value === undefined || validText(value, maxLength)
}
