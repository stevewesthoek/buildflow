import type { KnowledgeSource } from '@workbench/shared'
import { getSourcesSafe } from './config'
import { activateContextProposal, type ContextActivationRequest, type ContextActivationResult } from './context-activation-service'
import { getContextSession, type ContextIntelligenceStoreOptions } from './context-intelligence-store'
import { evaluateFreshnessPolicy } from './freshness-policy-engine'
import { bootstrapContextSession, type ContextSessionBootstrapInput, type ContextSessionBootstrapResult } from './context-session-bootstrap'
import { planIndex, type IndexPlan, type IndexPlannerOptions } from './index-planner'
import { planIndexLifecycle, type IndexLifecyclePlan, type PathSnapshot } from './index-lifecycle-planner'
import { resolveContext, type ContextResolutionResult, type ContextResolverOptions } from './context-resolver'
import { observeRepositoryHealth, type RepositoryHealthObservationResult, type RepositoryHealthObserverOptions } from './repository-health-observer'
import type { ContextBudget, ContextProposal, ContextSession, FreshnessPolicyResult, RepositoryHealth } from './context-intelligence-models'

export type ContextBrokerOptions = {
  sources?: KnowledgeSource[]
  sourceLoader?: () => KnowledgeSource[]
  storeOptions?: ContextIntelligenceStoreOptions
  resolver?: Omit<ContextResolverOptions, 'sources' | 'sourceLoader' | 'storeOptions'>
  observer?: Omit<RepositoryHealthObserverOptions, 'sources' | 'sourceLoader'>
  indexRecordLoader?: RepositoryHealthObserverOptions['indexRecordLoader']
  planner?: IndexPlannerOptions
  budget?: ContextBudget
}

export type ContextBrokerRequest = {
  sessionId: string
  clientId: string
  reference: string
  sourceId?: string
  estimatedFiles?: number
  estimatedBytes?: number
  queryCount?: number
}

export type ContextBrokerProposalResult = {
  ok: true
  proposal: ContextProposal
  health: RepositoryHealth[]
  indexPlans: IndexPlan[]
  requiresConfirmation: true
} | {
  ok: false
  code: 'budget_exceeded' | 'source_unavailable' | 'resolution_failed' | 'observation_failed'
  message: string
  resolution?: ContextResolutionResult
}

export type ContextBrokerActivationResult = ContextActivationResult

export type ContextPreparationMetadata = {
  selectedSource: string
  authorizationState: 'authorized'
  confirmationState: 'explicit-source-id' | 'active-source-context' | 'execution-context'
  freshnessState: RepositoryHealth['freshnessState']
  indexedRevision?: string
  observedRevision?: string
  indexGeneration?: string
  warnings: string[]
}

export type ContextPreparationResult = {
  ok: true
  metadata: ContextPreparationMetadata
  health: RepositoryHealth
  indexPlan: IndexPlan
} | {
  ok: false
  code: 'source_unavailable' | 'source_not_authorized' | 'observation_failed'
  message: string
}

export type ContextOperationAuthorizationResult = {
  ok: true
  metadata: ContextPreparationMetadata & { operation: 'mutation' | 'command'; freshnessDecision: FreshnessPolicyResult['decision'] }
  policy: FreshnessPolicyResult
} | {
  ok: false
  code: 'context_session_required' | 'context_session_not_confirmed' | 'source_not_active' | 'source_unavailable' | 'freshness_blocked'
  message: string
  policy?: FreshnessPolicyResult
}

export type ContextReadAuthorizationResult = ContextPreparationResult | {
  ok: false
  code: 'context_session_required' | 'context_session_not_confirmed' | 'source_not_active'
  message: string
}

const DEFAULT_BUDGET: ContextBudget = {
  schemaVersion: 1,
  maximumRepositories: 1,
  maximumFiles: 5_000,
  maximumBytes: 10_000_000,
  maximumQueries: 20
}

function loadSources(options: ContextBrokerOptions): KnowledgeSource[] | undefined {
  try {
    const sources = options.sources ? [...options.sources] : (options.sourceLoader || (() => getSourcesSafe({ refreshGitMetadata: false })))()
    return Array.isArray(sources) ? sources : undefined
  } catch {
    return undefined
  }
}

function sourceIds(proposal: ContextProposal): string[] {
  return proposal.candidates.map(candidate => candidate.sourceId)
}

function observe(sourceId: string, options: ContextBrokerOptions): RepositoryHealthObservationResult {
  return observeRepositoryHealth(sourceId, {
    ...options.observer,
    sources: options.sources,
    sourceLoader: options.sourceLoader,
    indexRecordLoader: options.indexRecordLoader
  })
}

export function prepareAuthorizedContext(sourceId: string, confirmationState: ContextPreparationMetadata['confirmationState'], options: ContextBrokerOptions = {}): ContextPreparationResult {
  const sources = loadSources(options)
  if (!sources) return { ok: false, code: 'observation_failed', message: 'The source registry could not be loaded.' }
  const source = sources.find(item => item.id === sourceId)
  if (!source || source.enabled === false) return { ok: false, code: 'source_not_authorized', message: `Source "${sourceId}" is not an enabled registered source.` }
  const observed = observe(sourceId, options)
  if (!observed.ok || !observed.health || observed.health.runtimeAvailability !== 'available') {
    return { ok: false, code: 'observation_failed', message: `Repository health could not be observed for source "${sourceId}".` }
  }
  const indexPlan = planIndex({ health: observed.health }, options.planner)
  const warnings = indexPlan.reasonCodes
    .filter(reason => reason !== 'fresh')
    .map(reason => `Context source ${sourceId}: ${reason}.`)
  return {
    ok: true,
    health: observed.health,
    indexPlan,
    metadata: {
      selectedSource: sourceId,
      authorizationState: 'authorized',
      confirmationState,
      freshnessState: observed.health.freshnessState,
      indexedRevision: observed.health.indexedRevision,
      observedRevision: observed.health.observedRevision,
      indexGeneration: observed.health.indexGeneration,
      warnings
    }
  }
}

export function authorizeContextOperation(sourceId: string, operation: 'mutation' | 'command', contextSessionId: string | undefined, explicitOverride: boolean, options: ContextBrokerOptions = {}): ContextOperationAuthorizationResult {
  if (!contextSessionId) return { ok: false, code: 'context_session_required', message: 'Context Broker authorization requires a Context Intelligence session.' }
  const session = getContextSession(contextSessionId, options.storeOptions)
  if (!session || ('ok' in session)) return { ok: false, code: 'context_session_required', message: 'The Context Intelligence session could not be loaded.' }
  if (session.status !== 'confirmed') return { ok: false, code: 'context_session_not_confirmed', message: 'Mutation and command operations require a confirmed Context Intelligence session.' }
  if (!session.sourceIds.includes(sourceId)) return { ok: false, code: 'source_not_active', message: `Source "${sourceId}" is not active in the confirmed context session.` }
  const prepared = prepareAuthorizedContext(sourceId, 'execution-context', options)
  if (!prepared.ok) return { ok: false, code: 'source_unavailable', message: 'message' in prepared ? prepared.message : 'Repository context could not be prepared.' }
  const policy = evaluateFreshnessPolicy({ health: prepared.health, operation, explicitOverride }, { now: options.storeOptions?.now })
  if (policy.decision === 'block') return { ok: false, code: 'freshness_blocked', message: policy.blockReason || 'Freshness policy blocked the operation.', policy }
  return {
    ok: true,
    policy,
    metadata: { ...prepared.metadata, operation, freshnessDecision: policy.decision }
  }
}

export function authorizeContextRead(sourceId: string, contextSessionId: string | undefined, confirmationState: ContextPreparationMetadata['confirmationState'], options: ContextBrokerOptions = {}): ContextReadAuthorizationResult {
  if (!contextSessionId) return prepareAuthorizedContext(sourceId, confirmationState, options)
  const session = getContextSession(contextSessionId, options.storeOptions)
  if (!session || ('ok' in session)) return { ok: false, code: 'context_session_required', message: 'The Context Intelligence session could not be loaded.' }
  if (session.status !== 'confirmed') return { ok: false, code: 'context_session_not_confirmed', message: 'Repository reads require a confirmed Context Intelligence session.' }
  if (!session.sourceIds.includes(sourceId)) return { ok: false, code: 'source_not_active', message: `Source "${sourceId}" is not active in the confirmed context session.` }
  return prepareAuthorizedContext(sourceId, 'execution-context', options)
}

export function proposeContext(request: ContextBrokerRequest, options: ContextBrokerOptions = {}): ContextBrokerProposalResult {
  const budget = options.budget || DEFAULT_BUDGET
  if ((request.estimatedFiles !== undefined && request.estimatedFiles > budget.maximumFiles)
    || (request.estimatedBytes !== undefined && request.estimatedBytes > budget.maximumBytes)
    || (request.queryCount !== undefined && request.queryCount > budget.maximumQueries)) {
    return { ok: false, code: 'budget_exceeded', message: 'Context request exceeds the configured file, byte, or query budget.' }
  }
  const resolution = resolveContext(request, {
    ...options.resolver,
    sources: options.sources,
    sourceLoader: options.sourceLoader,
    storeOptions: options.storeOptions
  })
  if (!resolution.ok) return { ok: false, code: 'resolution_failed', message: 'message' in resolution ? resolution.message : 'Context resolution failed.', resolution }

  const candidates = sourceIds(resolution.proposal)
  if (candidates.length === 0) return { ok: false, code: 'source_unavailable', message: 'No usable repository candidate was resolved.', resolution }
  if (candidates.length > budget.maximumRepositories) {
    return { ok: false, code: 'budget_exceeded', message: `Context proposal exceeds the repository budget of ${budget.maximumRepositories}.`, resolution }
  }

  const health: RepositoryHealth[] = []
  const indexPlans: IndexPlan[] = []
  for (const sourceId of candidates) {
    const observed = observe(sourceId, options)
    if (!observed.ok || !observed.health) {
      return { ok: false, code: 'observation_failed', message: `Repository health could not be observed for source "${sourceId}".`, resolution }
    }
    health.push(observed.health)
    indexPlans.push(planIndex({ health: observed.health }, options.planner))
  }

  return { ok: true, proposal: resolution.proposal, health, indexPlans, requiresConfirmation: true }
}

export function activateProposedContext(request: ContextActivationRequest, options: ContextBrokerOptions = {}): ContextBrokerActivationResult {
  return activateContextProposal(request, {
    sources: options.sources,
    sourceLoader: options.sourceLoader,
    storeOptions: options.storeOptions
  })
}

export function authorizeActiveContext(sessionId: string, sourceId: string | undefined, options: ContextBrokerOptions = {}): { ok: true; session: ContextSession } | { ok: false; code: 'not_authorized' | 'session_unavailable'; message: string } {
  const session = getContextSession(sessionId, options.storeOptions)
  if (!session || ('ok' in session)) return { ok: false, code: 'session_unavailable', message: 'Context session could not be loaded.' }
  if (session.status !== 'confirmed') return { ok: false, code: 'not_authorized', message: 'Only confirmed context sessions may authorize repository context.' }
  if (sourceId && !session.sourceIds.includes(sourceId)) return { ok: false, code: 'not_authorized', message: 'The requested source is not active in this context session.' }
  const now = options.storeOptions?.now ? options.storeOptions.now() : new Date()
  if (session.expiresAt && Date.parse(session.expiresAt) <= now.getTime()) return { ok: false, code: 'not_authorized', message: 'The context session has expired.' }
  return { ok: true, session }
}

export class ContextBroker {
  constructor(private readonly options: ContextBrokerOptions = {}) {}
  propose(request: ContextBrokerRequest): ContextBrokerProposalResult { return proposeContext(request, this.options) }
  activate(request: ContextActivationRequest): ContextBrokerActivationResult { return activateProposedContext(request, this.options) }
  authorize(sessionId: string, sourceId?: string): ReturnType<typeof authorizeActiveContext> { return authorizeActiveContext(sessionId, sourceId, this.options) }
  bootstrap(input: ContextSessionBootstrapInput): ContextSessionBootstrapResult { return bootstrapContextSession(input, this.options.storeOptions) }
  planIndexLifecycle(sourceId: string, indexedPaths: PathSnapshot = [], observedPaths: PathSnapshot = []): { ok: true; health: RepositoryHealth; plan: IndexLifecyclePlan } | { ok: false; code: 'source_not_authorized' | 'observation_failed'; message: string } {
    const sources = loadSources(this.options)
    const source = sources?.find(item => item.id === sourceId)
    if (!source || source.enabled === false) return { ok: false, code: 'source_not_authorized', message: `Source "${sourceId}" is not an enabled registered source.` }
    const observed = observe(sourceId, this.options)
    if (!observed.ok || !observed.health) return { ok: false, code: 'observation_failed', message: `Repository health could not be observed for source "${sourceId}".` }
    return { ok: true, health: observed.health, plan: planIndexLifecycle(observed.health, indexedPaths, observedPaths, this.options.planner) }
  }
}
