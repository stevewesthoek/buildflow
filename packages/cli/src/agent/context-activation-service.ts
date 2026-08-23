import fs from 'node:fs'
import type { KnowledgeSource } from '@workbench/shared'
import { getSourcesSafe } from './config'
import {
  confirmContextProposalForActivation,
  getContextProposal,
  getContextSession,
  recordContextActivationEvent,
  type ContextIntelligenceStoreOptions,
  type ContextStoreFailure
} from './context-intelligence-store'
import type {
  ContextActivationFailureReason,
  ContextProposal,
  ContextSession
} from './context-intelligence-models'

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/
const MAX_SOURCE_IDS = 32

export type ContextActivationRequest = {
  proposalId: string
  sessionId: string
  clientId: string
  selectedSourceIds: string[]
}
export type ContextActivationServiceOptions = {
  sources?: KnowledgeSource[]
  sourceLoader?: () => KnowledgeSource[]
  storeOptions?: ContextIntelligenceStoreOptions
}

export type ContextActivationSuccess = {
  ok: true
  proposal: ContextProposal
  session: ContextSession
}

export type ContextActivationFailure = {
  ok: false
  reason: ContextActivationFailureReason
  message: string
}

export type ContextActivationResult = ContextActivationSuccess | ContextActivationFailure

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && IDENTIFIER_PATTERN.test(value)
}

function validSourceIds(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= MAX_SOURCE_IDS
    && value.every(validIdentifier)
    && new Set(value).size === value.length
}

function failure(reason: ContextActivationFailureReason, message: string): ContextActivationFailure {
  return { ok: false, reason, message }
}

function storeFailureMessage(result: ContextStoreFailure): string {
  return result.message || 'Context intelligence store operation failed.'
}

function mapConfirmationFailure(result: ContextStoreFailure): ContextActivationFailureReason {
  if (result.code === 'CONTEXT_PROPOSAL_NOT_FOUND') return 'proposal_missing'
  if (result.code === 'CONTEXT_SESSION_NOT_FOUND') return 'proposal_missing'
  if (result.code === 'CONTEXT_SESSION_EXPIRED') return 'proposal_expired'
  if (result.code === 'CONTEXT_CONFIRMATION_REQUIRED'
    || result.code === 'CONTEXT_INVALID_TRANSITION'
    || result.code === 'CONTEXT_PROPOSAL_SESSION_MISMATCH'
    || result.code === 'CONTEXT_SESSION_NOT_AUTHORIZED') return 'confirmation_required'
  return 'store_unavailable'
}

function sourceAvailability(source: KnowledgeSource): 'available' | 'disabled' | 'unavailable' {
  if (source.enabled === false) return 'disabled'
  try {
    const metadata = fs.statSync(source.path)
    if (!metadata.isDirectory()) return 'unavailable'
    fs.accessSync(source.path, fs.constants.R_OK)
    return 'available'
  } catch {
    return 'unavailable'
  }
}

function loadSources(options: ContextActivationServiceOptions): KnowledgeSource[] | undefined {
  try {
    const sources = options.sources ? [...options.sources] : (options.sourceLoader || (() => getSourcesSafe({ refreshGitMetadata: false })))()
    return Array.isArray(sources) ? sources : undefined
  } catch {
    return undefined
  }
}

function recordFailure(input: ContextActivationRequest, reason: ContextActivationFailureReason, message: string, options: ContextActivationServiceOptions): ContextActivationFailure {
  const recorded = recordContextActivationEvent({
    eventType: 'proposal.activation_failed',
    proposalId: input.proposalId,
    sessionId: input.sessionId,
    clientId: input.clientId,
    sourceIds: Array.isArray(input.selectedSourceIds) ? input.selectedSourceIds.filter(validIdentifier).slice(0, MAX_SOURCE_IDS) : [],
    reasonCode: reason
  }, options.storeOptions)
  if (recorded.ok === false) return failure('store_unavailable', storeFailureMessage(recorded))
  return failure(reason, message)
}

function requestInputIsValid(input: ContextActivationRequest): boolean {
  return Boolean(input)
    && validIdentifier(input.proposalId)
    && validIdentifier(input.sessionId)
    && validIdentifier(input.clientId)
    && validSourceIds(input.selectedSourceIds)
}

export function activateContextProposal(input: ContextActivationRequest, options: ContextActivationServiceOptions = {}): ContextActivationResult {
  if (!requestInputIsValid(input)) {
    return failure('confirmation_required', 'Activation requires explicit confirmation of one or more valid candidate sources.')
  }

  const requested = recordContextActivationEvent({
    eventType: 'proposal.activation_requested',
    proposalId: input.proposalId,
    sessionId: input.sessionId,
    clientId: input.clientId,
    sourceIds: input.selectedSourceIds
  }, options.storeOptions)
  if (requested.ok === false) return failure('store_unavailable', storeFailureMessage(requested))

  const storedProposal = getContextProposal(input.proposalId, options.storeOptions)
  if (!storedProposal) return recordFailure(input, 'proposal_missing', 'The requested context proposal does not exist.', options)
  if ('ok' in storedProposal) return recordFailure(input, 'store_unavailable', storeFailureMessage(storedProposal), options)
  if (storedProposal.confirmationState === 'expired') {
    return recordFailure(input, 'proposal_expired', 'The requested context proposal has expired.', options)
  }
  if (storedProposal.confirmationState !== 'pending' || storedProposal.confirmationRequired !== true) {
    return recordFailure(input, 'confirmation_required', 'The context proposal is not pending explicit confirmation.', options)
  }
  if (!storedProposal.sessionId || storedProposal.sessionId !== input.sessionId) {
    return recordFailure(input, 'confirmation_required', 'The proposal is not bound to the requesting context session.', options)
  }

  const storedSession = getContextSession(input.sessionId, options.storeOptions)
  if (!storedSession) return recordFailure(input, 'proposal_missing', 'The context session bound to the proposal does not exist.', options)
  if ('ok' in storedSession) return recordFailure(input, 'store_unavailable', storeFailureMessage(storedSession), options)
  if (storedSession.clientId !== input.clientId) {
    return recordFailure(input, 'confirmation_required', 'The proposal is bound to a different client.', options)
  }
  if (storedSession.status === 'expired') return recordFailure(input, 'proposal_expired', 'The context session bound to the proposal has expired.', options)
  if (storedSession.status !== 'proposed') {
    return recordFailure(input, 'confirmation_required', 'Only proposed context sessions can be activated.', options)
  }

  const candidateIds = new Set(storedProposal.candidates.map(candidate => candidate.sourceId))
  if (!input.selectedSourceIds.every(sourceId => candidateIds.has(sourceId))) {
    return recordFailure(input, 'confirmation_required', 'Confirmation must select only sources proposed for this session.', options)
  }

  const sources = loadSources(options)
  if (!sources) return recordFailure(input, 'repository_unavailable', 'The source registry could not be loaded for activation.', options)
  const sourceById = new Map(sources.map(source => [source.id, source]))
  for (const sourceId of input.selectedSourceIds) {
    const source = sourceById.get(sourceId)
    if (!source) return recordFailure(input, 'source_missing', `Confirmed source "${sourceId}" is no longer registered.`, options)
    const availability = sourceAvailability(source)
    if (availability === 'disabled') return recordFailure(input, 'source_disabled', `Confirmed source "${sourceId}" is disabled.`, options)
    if (availability !== 'available') return recordFailure(input, 'repository_unavailable', `Confirmed source "${sourceId}" repository path is unavailable.`, options)
  }

  const confirmed = confirmContextProposalForActivation(input.proposalId, input.selectedSourceIds, options.storeOptions)
  if (confirmed.ok === false) {
    const reason = mapConfirmationFailure(confirmed)
    return recordFailure(input, reason, storeFailureMessage(confirmed), options)
  }

  return {
    ok: true,
    session: confirmed.session,
    proposal: { ...storedProposal, confirmationState: 'confirmed' }
  }
}

export class ContextActivationService {
  constructor(private readonly options: ContextActivationServiceOptions = {}) {}

  activate(input: ContextActivationRequest): ContextActivationResult {
    return activateContextProposal(input, this.options)
  }
}
