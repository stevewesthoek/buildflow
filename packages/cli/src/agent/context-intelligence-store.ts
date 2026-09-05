import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getConfigDir } from '../utils/paths'
import {
  CONTEXT_INTELLIGENCE_MODEL_VERSION,
  isContextEvent,
  isContextProposal,
  isContextSession,
  type ContextAuthorityLevel,
  type ContextActivationFailureReason,
  type ContextEvent,
  type ContextEventType,
  type ContextProposal,
  type ContextProposalAmbiguityStatus,
  type ContextProposalCandidate,
  type ContextSession,
  type ContextSessionMode
} from './context-intelligence-models'

export const CONTEXT_INTELLIGENCE_STORE_VERSION = 1 as const
export const CONTEXT_INTELLIGENCE_STORE_FILENAME = 'context-intelligence.json'

export type ContextIntelligenceStoreOptions = {
  rootDir?: string
  maxSessions?: number
  maxProposals?: number
  maxEvents?: number
  now?: () => Date
}

export type ContextStoreFailure = {
  ok: false
  code:
    | 'CONTEXT_STORE_BUSY'
    | 'CONTEXT_STORE_CORRUPT'
    | 'CONTEXT_INVALID_INPUT'
    | 'CONTEXT_SESSION_NOT_FOUND'
    | 'CONTEXT_SESSION_DUPLICATE_CONFLICT'
    | 'CONTEXT_PROPOSAL_NOT_FOUND'
    | 'CONTEXT_PROPOSAL_DUPLICATE_CONFLICT'
    | 'CONTEXT_PROPOSAL_SESSION_MISMATCH'
    | 'CONTEXT_INVALID_TRANSITION'
    | 'CONTEXT_CONFIRMATION_REQUIRED'
    | 'CONTEXT_SESSION_NOT_AUTHORIZED'
    | 'CONTEXT_SESSION_EXPIRED'
  message: string
}

type ContextIntelligenceStore = {
  version: typeof CONTEXT_INTELLIGENCE_STORE_VERSION
  updatedAt: string
  sessions: ContextSession[]
  proposals: ContextProposal[]
  events: ContextEvent[]
}

type ContextSessionResult = { ok: true; created?: boolean; changed?: boolean; session: ContextSession } | ContextStoreFailure
type ContextProposalResult = { ok: true; created?: boolean; proposal: ContextProposal } | ContextStoreFailure
type ContextEventResult = { ok: true; event: ContextEvent } | ContextStoreFailure

export type ContextActivationEventInput = {
  eventType: 'proposal.activation_requested' | 'proposal.activation_failed'
  proposalId: string
  sessionId: string
  clientId: string
  sourceIds?: string[]
  reasonCode?: ContextActivationFailureReason
  occurredAt?: string
}

type CreateContextSessionInput = {
  sessionId?: string
  clientId: string
  ownerId?: string
  createdBy?: string
  sourceIds: string[]
  mode: ContextSessionMode
  authorityLevel?: ContextAuthorityLevel
  createdAt?: string
  expiresAt?: string
}

type CreateContextProposalInput = {
  proposalId?: string
  sessionId: string
  candidates: ContextProposalCandidate[]
  ambiguityStatus?: ContextProposalAmbiguityStatus
  ambiguityReason?: string
  confirmationRequired?: boolean
  createdAt?: string
}

const DEFAULT_MAX_SESSIONS = 500
const DEFAULT_MAX_PROPOSALS = 1_000
const DEFAULT_MAX_EVENTS = 2_000
const DEFAULT_SESSION_TTL_MS = 30 * 60_000
const MAX_SESSION_TTL_MS = 24 * 60 * 60_000
const SESSION_RETENTION_MS = 24 * 60 * 60_000
const PROPOSAL_RETENTION_MS = 24 * 60 * 60_000
const EVENT_RETENTION_MS = 7 * 24 * 60 * 60_000
const MAX_IDENTIFIER = 200
const MAX_SOURCE_IDS = 32
const LOCK_WAIT_MS = 250
const LOCK_STALE_MS = 30_000

function contextFailure(code: ContextStoreFailure['code'], message: string): ContextStoreFailure {
  return { ok: false, code, message }
}

function resolvedRoot(options?: ContextIntelligenceStoreOptions): string {
  return options?.rootDir ? path.resolve(options.rootDir) : getConfigDir()
}

export function getContextIntelligenceStorePath(options?: ContextIntelligenceStoreOptions): string {
  return path.join(resolvedRoot(options), CONTEXT_INTELLIGENCE_STORE_FILENAME)
}

function lockPath(options?: ContextIntelligenceStoreOptions): string {
  return `${getContextIntelligenceStorePath(options)}.lock`
}

function nowIso(options?: ContextIntelligenceStoreOptions): string {
  return (options?.now?.() || new Date()).toISOString()
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_IDENTIFIER
    && /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
}

function validSourceIds(value: unknown, allowEmpty = false): value is string[] {
  if (!Array.isArray(value) || value.length > MAX_SOURCE_IDS || (!allowEmpty && value.length === 0)) return false
  if (!value.every(validIdentifier)) return false
  return new Set(value).size === value.length
}

function proposalAmbiguityStatus(candidates: ContextProposalCandidate[], status?: ContextProposalAmbiguityStatus): ContextProposalAmbiguityStatus {
  if (status) return status
  if (candidates.length === 0) return 'unresolved'
  return candidates.length > 1 ? 'ambiguous' : 'none'
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function isStoreFailure(value: ContextIntelligenceStore | ContextStoreFailure): value is ContextStoreFailure {
  return 'ok' in value && value.ok === false
}

function migrateStoredProposal(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const proposal = value as Record<string, unknown>
  if (proposal.ambiguityStatus !== undefined) return value
  const candidates = Array.isArray(proposal.candidates) ? proposal.candidates : []
  return {
    ...proposal,
    ambiguityStatus: candidates.length === 0 ? 'unresolved' : candidates.length > 1 ? 'ambiguous' : 'none'
  }
}

function emptyStore(): ContextIntelligenceStore {
  return {
    version: CONTEXT_INTELLIGENCE_STORE_VERSION,
    updatedAt: new Date(0).toISOString(),
    sessions: [],
    proposals: [],
    events: []
  }
}

function readStore(options?: ContextIntelligenceStoreOptions): ContextIntelligenceStore | ContextStoreFailure {
  try {
    const target = getContextIntelligenceStorePath(options)
    if (!fs.existsSync(target)) return emptyStore()
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as Partial<ContextIntelligenceStore>
    const proposals = Array.isArray(parsed.proposals) ? parsed.proposals.map(migrateStoredProposal) : []
    if (parsed.version !== CONTEXT_INTELLIGENCE_STORE_VERSION
      || !Array.isArray(parsed.sessions)
      || !Array.isArray(parsed.proposals)
      || !Array.isArray(parsed.events)
      || !parsed.sessions.every(isContextSession)
      || !proposals.every(isContextProposal)
      || !parsed.events.every(isContextEvent)) {
      return contextFailure('CONTEXT_STORE_CORRUPT', 'Context intelligence store has an unsupported or invalid shape.')
    }
    return {
      version: CONTEXT_INTELLIGENCE_STORE_VERSION,
      updatedAt: validTimestamp(parsed.updatedAt) ? parsed.updatedAt : new Date(0).toISOString(),
      sessions: parsed.sessions,
      proposals: proposals as ContextProposal[],
      events: parsed.events
    }
  } catch {
    return contextFailure('CONTEXT_STORE_CORRUPT', 'Context intelligence store could not be read safely.')
  }
}

function pruneStore(store: ContextIntelligenceStore, options?: ContextIntelligenceStoreOptions, timestamp = nowIso(options)): void {
  const nowMs = Date.parse(timestamp)
  const sessionCutoff = nowMs - SESSION_RETENTION_MS
  const proposalCutoff = nowMs - PROPOSAL_RETENTION_MS
  const eventCutoff = nowMs - EVENT_RETENTION_MS
  const maxSessions = Math.max(10, Math.min(options?.maxSessions || DEFAULT_MAX_SESSIONS, 2_000))
  const maxProposals = Math.max(10, Math.min(options?.maxProposals || DEFAULT_MAX_PROPOSALS, 5_000))
  const maxEvents = Math.max(20, Math.min(options?.maxEvents || DEFAULT_MAX_EVENTS, 10_000))

  store.sessions = store.sessions
    .filter(session => !['expired', 'cleared'].includes(session.status) || Date.parse(session.expiresAt || session.createdAt) > sessionCutoff)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(-maxSessions)
  store.proposals = store.proposals
    .filter(proposal => proposal.confirmationState === 'pending' || Date.parse(proposal.createdAt) > proposalCutoff)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(-maxProposals)
  store.events = store.events
    .filter(event => Date.parse(event.occurredAt) > eventCutoff)
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
    .slice(-maxEvents)
}

function persistStore(store: ContextIntelligenceStore, options?: ContextIntelligenceStoreOptions, timestamp = nowIso(options)): void {
  pruneStore(store, options, timestamp)
  const target = getContextIntelligenceStorePath(options)
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  const payload: ContextIntelligenceStore = {
    version: CONTEXT_INTELLIGENCE_STORE_VERSION,
    updatedAt: timestamp,
    sessions: store.sessions,
    proposals: store.proposals,
    events: store.events
  }
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  fs.renameSync(temporary, target)
  fs.chmodSync(target, 0o600)
}

function acquireLock(options?: ContextIntelligenceStoreOptions): number | undefined {
  const target = lockPath(options)
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + LOCK_WAIT_MS
  while (Date.now() <= deadline) {
    try {
      return fs.openSync(target, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        if (Date.now() - fs.statSync(target).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(target, { force: true })
          continue
        }
      } catch {
        // Retry while the bounded lock window remains.
      }
    }
  }
  return undefined
}

function withLock<T>(options: ContextIntelligenceStoreOptions | undefined, callback: (store: ContextIntelligenceStore) => T): T | ContextStoreFailure {
  let descriptor: number | undefined
  try {
    descriptor = acquireLock(options)
    if (descriptor === undefined) return contextFailure('CONTEXT_STORE_BUSY', 'Context intelligence store is busy.')
    const store = readStore(options)
    if (isStoreFailure(store)) return store
    return callback(store)
  } catch {
    return contextFailure('CONTEXT_STORE_CORRUPT', 'Context intelligence store operation failed safely.')
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch {}
      try { fs.rmSync(lockPath(options), { force: true }) } catch {}
    }
  }
}

function eventId(): string {
  return `context-event-${crypto.randomUUID()}`
}

function appendEvent(store: ContextIntelligenceStore, input: {
  eventType: ContextEventType
  session: ContextSession
  occurredAt: string
  proposalId?: string
  sourceIds?: string[]
  previousSourceIds?: string[]
  reasonCode?: ContextActivationFailureReason
}): ContextEvent {
  return appendEventRecord(store, {
    eventType: input.eventType,
    sessionId: input.session.sessionId,
    clientId: input.session.clientId,
    occurredAt: input.occurredAt,
    proposalId: input.proposalId,
    sourceIds: input.sourceIds || input.session.sourceIds,
    previousSourceIds: input.previousSourceIds,
    reasonCode: input.reasonCode
  })
}

function appendEventRecord(store: ContextIntelligenceStore, input: {
  eventType: ContextEventType
  sessionId: string
  clientId: string
  occurredAt: string
  proposalId?: string
  sourceIds?: string[]
  previousSourceIds?: string[]
  reasonCode?: ContextActivationFailureReason
}): ContextEvent {
  const event: ContextEvent = {
    schemaVersion: CONTEXT_INTELLIGENCE_MODEL_VERSION,
    eventId: eventId(),
    eventType: input.eventType,
    sessionId: input.sessionId,
    clientId: input.clientId,
    proposalId: input.proposalId,
    sourceIds: input.sourceIds || [],
    previousSourceIds: input.previousSourceIds,
    reasonCode: input.reasonCode,
    occurredAt: input.occurredAt
  }
  if (!isContextEvent(event)) throw new Error('Generated context event failed validation.')
  store.events.push(event)
  return event
}

function expireDueSessions(store: ContextIntelligenceStore, timestamp: string): boolean {
  const nowMs = Date.parse(timestamp)
  let changed = false
  for (const session of store.sessions) {
    if (!['proposed', 'confirmed'].includes(session.status) || !session.expiresAt || Date.parse(session.expiresAt) > nowMs) continue
    session.status = 'expired'
    for (const proposal of store.proposals) {
      if (proposal.sessionId === session.sessionId && proposal.confirmationState === 'pending') proposal.confirmationState = 'expired'
    }
    appendEvent(store, { eventType: 'session.expired', session, occurredAt: timestamp })
    changed = true
  }
  return changed
}

export function recordContextActivationEvent(input: ContextActivationEventInput, options?: ContextIntelligenceStoreOptions): ContextEventResult {
  const occurredAt = input.occurredAt || nowIso(options)
  const sourceIds = input.sourceIds || []
  const validEventType = input.eventType === 'proposal.activation_requested' || input.eventType === 'proposal.activation_failed'
  const validReason = input.eventType === 'proposal.activation_failed'
    ? input.reasonCode !== undefined
    : input.reasonCode === undefined
  if (!validEventType || !validIdentifier(input.proposalId) || !validIdentifier(input.sessionId) || !validIdentifier(input.clientId)
    || !validSourceIds(sourceIds, true) || !validTimestamp(occurredAt) || !validReason) {
    return invalidInput('Context activation event input is invalid or unbounded.')
  }

  return withLock(options, store => {
    const event = appendEventRecord(store, {
      eventType: input.eventType,
      proposalId: input.proposalId,
      sessionId: input.sessionId,
      clientId: input.clientId,
      sourceIds,
      reasonCode: input.reasonCode,
      occurredAt
    })
    persistStore(store, options, occurredAt)
    return { ok: true, event }
  })
}

function invalidInput(message: string): ContextStoreFailure {
  return contextFailure('CONTEXT_INVALID_INPUT', message)
}

function sessionNotFound(): ContextStoreFailure {
  return contextFailure('CONTEXT_SESSION_NOT_FOUND', 'Context session was not found.')
}

function proposalNotFound(): ContextStoreFailure {
  return contextFailure('CONTEXT_PROPOSAL_NOT_FOUND', 'Context proposal was not found.')
}

function findSession(store: ContextIntelligenceStore, sessionId: string): ContextSession | undefined {
  return store.sessions.find(session => session.sessionId === sessionId)
}

function findProposal(store: ContextIntelligenceStore, proposalId: string): ContextProposal | undefined {
  return store.proposals.find(proposal => proposal.proposalId === proposalId)
}

function sessionBindingMatches(session: ContextSession, input: ContextSession): boolean {
  return session.clientId === input.clientId
    && session.mode === input.mode
    && session.authorityLevel === input.authorityLevel
    && session.ownerId === input.ownerId
    && session.createdBy === input.createdBy
    && sameStringArray(session.sourceIds, input.sourceIds)
}

export function createContextSession(input: CreateContextSessionInput, options?: ContextIntelligenceStoreOptions): ContextSessionResult {
  const sessionId = input.sessionId || `context-session-${crypto.randomUUID()}`
  const createdAt = input.createdAt || nowIso(options)
  const authorityLevel = input.authorityLevel || 'inferred-suggestion'
  if (!validIdentifier(sessionId) || !validIdentifier(input.clientId) || (input.ownerId !== undefined && !validIdentifier(input.ownerId)) || (input.createdBy !== undefined && !validIdentifier(input.createdBy)) || !validSourceIds(input.sourceIds, input.mode === 'admin')
    || !['single', 'multi', 'admin'].includes(input.mode)
    || !['explicit-user', 'confirmed-suggestion', 'inferred-suggestion'].includes(authorityLevel)
    || !validTimestamp(createdAt)) {
    return invalidInput('Context session input is invalid or unbounded.')
  }
  const expiresAt = input.expiresAt || new Date(Date.parse(createdAt) + DEFAULT_SESSION_TTL_MS).toISOString()
  if (!validTimestamp(expiresAt) || Date.parse(expiresAt) <= Date.parse(createdAt) || Date.parse(expiresAt) - Date.parse(createdAt) > MAX_SESSION_TTL_MS) {
    return invalidInput('Context session expiry is invalid or exceeds the allowed lifetime.')
  }

  const session: ContextSession = {
    schemaVersion: CONTEXT_INTELLIGENCE_MODEL_VERSION,
    sessionId,
    clientId: input.clientId,
    ...(input.ownerId ? { ownerId: input.ownerId } : {}),
    ...(input.createdBy ? { createdBy: input.createdBy } : {}),
    sourceIds: [...input.sourceIds],
    mode: input.mode,
    status: 'proposed',
    authorityLevel,
    createdAt,
    expiresAt
  }
  if (!isContextSession(session)) return invalidInput('Context session input failed validation.')

  return withLock(options, store => {
    const timestamp = nowIso(options)
    const expired = expireDueSessions(store, timestamp)
    const existing = findSession(store, sessionId)
    if (existing) {
      if (expired) persistStore(store, options, timestamp)
      return sessionBindingMatches(existing, session)
        ? { ok: true, created: false, session: existing }
        : contextFailure('CONTEXT_SESSION_DUPLICATE_CONFLICT', 'Context session identity is already bound to different context.')
    }
    store.sessions.push(session)
    appendEvent(store, { eventType: 'session.created', session, occurredAt: createdAt })
    persistStore(store, options, timestamp)
    return { ok: true, created: true, session }
  })
}

export function getContextSession(sessionId: string, options?: ContextIntelligenceStoreOptions): ContextSession | ContextStoreFailure | undefined {
  if (!validIdentifier(sessionId)) return invalidInput('Context session ID is invalid.')
  return withLock(options, store => {
    const timestamp = nowIso(options)
    const expired = expireDueSessions(store, timestamp)
    if (expired) persistStore(store, options, timestamp)
    return findSession(store, sessionId)
  })
}

export function listContextSessions(options?: ContextIntelligenceStoreOptions): ContextSession[] {
  const store = readStore(options)
  return 'ok' in store ? [] : [...store.sessions].sort((a, b) => a.sessionId.localeCompare(b.sessionId))
}

export function authorizeContextSession(sessionId: string, sourceId?: string, options?: ContextIntelligenceStoreOptions): { ok: true; session: ContextSession } | ContextStoreFailure {
  if (!validIdentifier(sessionId) || (sourceId !== undefined && !validIdentifier(sourceId))) return invalidInput('Context authorization input is invalid.')
  const session = getContextSession(sessionId, options)
  if (!session) return sessionNotFound()
  if ('ok' in session) return session
  if (session.status === 'expired') return contextFailure('CONTEXT_SESSION_EXPIRED', 'Expired context sessions cannot authorize context.')
  if (session.status !== 'confirmed') return contextFailure('CONTEXT_SESSION_NOT_AUTHORIZED', 'Context session must be confirmed before it can authorize context.')
  if (sourceId !== undefined && !session.sourceIds.includes(sourceId)) {
    return contextFailure('CONTEXT_SESSION_NOT_AUTHORIZED', 'Requested source is not bound to the confirmed context session.')
  }
  return { ok: true, session }
}

export function createContextProposal(input: CreateContextProposalInput, options?: ContextIntelligenceStoreOptions): ContextProposalResult {
  const proposalId = input.proposalId || `context-proposal-${crypto.randomUUID()}`
  const createdAt = input.createdAt || nowIso(options)
  const candidates = Array.isArray(input.candidates) ? input.candidates : []
  const ambiguityStatus = proposalAmbiguityStatus(candidates, input.ambiguityStatus)
  const confirmationRequired = input.confirmationRequired ?? true
  if (!validIdentifier(proposalId) || !validIdentifier(input.sessionId) || !Array.isArray(input.candidates) || candidates.length > 32 || (candidates.length === 0 && ambiguityStatus !== 'unresolved') || !validTimestamp(createdAt)
    || !['none', 'ambiguous', 'unresolved'].includes(ambiguityStatus)
    || (input.ambiguityReason !== undefined && (typeof input.ambiguityReason !== 'string' || input.ambiguityReason.length === 0 || input.ambiguityReason.length > 240))) {
    return invalidInput('Context proposal input is invalid or unbounded.')
  }
  if (!candidates.every(candidate => validIdentifier(candidate.sourceId)
    && Number.isFinite(candidate.confidenceScore)
    && candidate.confidenceScore >= 0
    && candidate.confidenceScore <= 1
    && Array.isArray(candidate.matchReasons)
    && candidate.matchReasons.length > 0
    && candidate.matchReasons.length <= 8
    && candidate.matchReasons.every(reason => typeof reason === 'string' && reason.length > 0 && reason.length <= 240))) {
    return invalidInput('Context proposal candidates are invalid or unbounded.')
  }
  const proposal: ContextProposal = {
    schemaVersion: CONTEXT_INTELLIGENCE_MODEL_VERSION,
    proposalId,
    sessionId: input.sessionId,
    candidates: candidates.map(candidate => ({ ...candidate, matchReasons: [...candidate.matchReasons] })),
    ambiguityStatus,
    ambiguityReason: input.ambiguityReason,
    confirmationRequired,
    confirmationState: 'pending',
    createdAt
  }
  if (!isContextProposal(proposal)) return invalidInput('Context proposal input failed validation.')

  return withLock(options, store => {
    const timestamp = nowIso(options)
    const expired = expireDueSessions(store, timestamp)
    const session = findSession(store, input.sessionId)
    if (!session) {
      if (expired) persistStore(store, options, timestamp)
      return sessionNotFound()
    }
    if (session.status !== 'proposed') {
      if (expired) persistStore(store, options, timestamp)
      return contextFailure('CONTEXT_INVALID_TRANSITION', 'Proposals can only be created for proposed context sessions.')
    }
    const existing = findProposal(store, proposalId)
    if (existing) {
      if (expired) persistStore(store, options, timestamp)
      return JSON.stringify(existing) === JSON.stringify(proposal)
        ? { ok: true, created: false, proposal: existing }
        : contextFailure('CONTEXT_PROPOSAL_DUPLICATE_CONFLICT', 'Context proposal identity is already bound to different candidates.')
    }
    store.proposals.push(proposal)
    appendEvent(store, { eventType: 'proposal.created', session, proposalId, occurredAt: createdAt, sourceIds: proposal.candidates.map(candidate => candidate.sourceId) })
    persistStore(store, options, timestamp)
    return { ok: true, created: true, proposal }
  })
}

export function getContextProposal(proposalId: string, options?: ContextIntelligenceStoreOptions): ContextProposal | ContextStoreFailure | undefined {
  if (!validIdentifier(proposalId)) return invalidInput('Context proposal ID is invalid.')
  return withLock(options, store => {
    const timestamp = nowIso(options)
    const expired = expireDueSessions(store, timestamp)
    if (expired) persistStore(store, options, timestamp)
    return findProposal(store, proposalId)
  })
}

function confirmContextProposalInternal(proposalId: string, selectedSourceIds: string[], options?: ContextIntelligenceStoreOptions, activationConfirmed = false): ContextSessionResult {
  const timestamp = nowIso(options)
  if (!validIdentifier(proposalId) || !validSourceIds(selectedSourceIds)) return invalidInput('Context proposal confirmation input is invalid.')
  return withLock(options, store => {
    const expired = expireDueSessions(store, timestamp)
    const proposal = findProposal(store, proposalId)
    if (!proposal) {
      if (expired) persistStore(store, options, timestamp)
      return proposalNotFound()
    }
    if (!proposal.sessionId) {
      if (expired) persistStore(store, options, timestamp)
      return contextFailure('CONTEXT_PROPOSAL_SESSION_MISMATCH', 'Context proposal is not bound to a session.')
    }
    const session = findSession(store, proposal.sessionId)
    if (!session) {
      if (expired) persistStore(store, options, timestamp)
      return sessionNotFound()
    }
    if (session.status === 'expired') {
      if (expired) persistStore(store, options, timestamp)
      return contextFailure('CONTEXT_SESSION_EXPIRED', 'Expired context sessions cannot confirm proposals.')
    }
    if (session.status !== 'proposed' || proposal.confirmationState !== 'pending') {
      if (expired) persistStore(store, options, timestamp)
      return contextFailure('CONTEXT_INVALID_TRANSITION', 'Only pending proposals on proposed sessions can be confirmed.')
    }
    const candidateIds = new Set(proposal.candidates.map(candidate => candidate.sourceId))
    if (!selectedSourceIds.every(sourceId => candidateIds.has(sourceId)) || (session.mode === 'single' && selectedSourceIds.length !== 1)) {
      if (expired) persistStore(store, options, timestamp)
      return contextFailure('CONTEXT_CONFIRMATION_REQUIRED', 'Confirmation must select valid candidate sources for the session mode.')
    }

    const nextSession: ContextSession = {
      ...session,
      sourceIds: [...selectedSourceIds],
      status: 'confirmed',
      authorityLevel: session.authorityLevel === 'explicit-user' ? 'explicit-user' : 'confirmed-suggestion',
      confirmedAt: timestamp
    }
    if (!isContextSession(nextSession)) return invalidInput('Confirmed context session failed validation.')
    const nextProposal: ContextProposal = { ...proposal, confirmationState: 'confirmed' }
    if (!isContextProposal(nextProposal)) return invalidInput('Confirmed context proposal failed validation.')
    store.sessions[store.sessions.findIndex(item => item.sessionId === session.sessionId)] = nextSession
    store.proposals[store.proposals.findIndex(item => item.proposalId === proposal.proposalId)] = nextProposal
    appendEvent(store, { eventType: 'proposal.confirmed', session: nextSession, proposalId: proposal.proposalId, occurredAt: timestamp, sourceIds: nextSession.sourceIds })
    if (activationConfirmed) {
      appendEvent(store, { eventType: 'proposal.activation_confirmed', session: nextSession, proposalId: proposal.proposalId, occurredAt: timestamp, sourceIds: nextSession.sourceIds })
    }
    persistStore(store, options, timestamp)
    return { ok: true, session: nextSession }
  })
}

export function confirmContextProposal(proposalId: string, selectedSourceIds: string[], options?: ContextIntelligenceStoreOptions): ContextSessionResult {
  return confirmContextProposalInternal(proposalId, selectedSourceIds, options, false)
}

export function confirmContextProposalForActivation(proposalId: string, selectedSourceIds: string[], options?: ContextIntelligenceStoreOptions): ContextSessionResult {
  return confirmContextProposalInternal(proposalId, selectedSourceIds, options, true)
}

export function replaceActiveContextSource(sessionId: string, sourceId: string, options?: ContextIntelligenceStoreOptions): ContextSessionResult {
  const timestamp = nowIso(options)
  if (!validIdentifier(sessionId) || !validIdentifier(sourceId)) return invalidInput('Active context source replacement input is invalid.')
  return withLock(options, store => {
    const expired = expireDueSessions(store, timestamp)
    const session = findSession(store, sessionId)
    if (!session) {
      if (expired) persistStore(store, options, timestamp)
      return sessionNotFound()
    }
    if (session.status === 'expired') {
      if (expired) persistStore(store, options, timestamp)
      return contextFailure('CONTEXT_SESSION_EXPIRED', 'Expired context sessions cannot change sources.')
    }
    if (session.status !== 'confirmed') {
      if (expired) persistStore(store, options, timestamp)
      return contextFailure('CONTEXT_INVALID_TRANSITION', 'Only confirmed context sessions can replace the active source.')
    }
    if (session.sourceIds.length === 1 && session.sourceIds[0] === sourceId) {
      if (expired) persistStore(store, options, timestamp)
      return { ok: true, changed: false, session }
    }
    const previousSourceIds = [...session.sourceIds]
    const nextSession: ContextSession = {
      ...session,
      sourceIds: [sourceId],
      mode: 'single',
      authorityLevel: 'explicit-user',
      confirmedAt: timestamp
    }
    if (!isContextSession(nextSession)) return invalidInput('Replaced context session failed validation.')
    store.sessions[store.sessions.findIndex(item => item.sessionId === session.sessionId)] = nextSession
    appendEvent(store, { eventType: 'source.changed', session: nextSession, occurredAt: timestamp, sourceIds: [sourceId], previousSourceIds })
    persistStore(store, options, timestamp)
    return { ok: true, changed: true, session: nextSession }
  })
}

export function expireContextSession(sessionId: string, options?: ContextIntelligenceStoreOptions): ContextSessionResult {
  const timestamp = nowIso(options)
  if (!validIdentifier(sessionId)) return invalidInput('Context session ID is invalid.')
  return withLock(options, store => {
    const expired = expireDueSessions(store, timestamp)
    const session = findSession(store, sessionId)
    if (!session) {
      if (expired) persistStore(store, options, timestamp)
      return sessionNotFound()
    }
    if (session.status === 'expired') {
      if (expired) persistStore(store, options, timestamp)
      return contextFailure('CONTEXT_INVALID_TRANSITION', 'Context session is already expired.')
    }
    if (session.status === 'cleared') {
      if (expired) persistStore(store, options, timestamp)
      return contextFailure('CONTEXT_INVALID_TRANSITION', 'Cleared context sessions cannot be expired.')
    }
    session.status = 'expired'
    for (const proposal of store.proposals) {
      if (proposal.sessionId === session.sessionId && proposal.confirmationState === 'pending') proposal.confirmationState = 'expired'
    }
    appendEvent(store, { eventType: 'session.expired', session, occurredAt: timestamp })
    persistStore(store, options, timestamp)
    return { ok: true, changed: true, session }
  })
}

export function extendContextSessionExpiry(sessionId: string, newExpiresAt: string, options?: ContextIntelligenceStoreOptions): ContextSessionResult {
  const timestamp = nowIso(options)
  if (!validIdentifier(sessionId) || !validTimestamp(newExpiresAt)) return invalidInput('Context session renewal input is invalid.')
  return withLock(options, store => {
    const expired = expireDueSessions(store, timestamp)
    const session = findSession(store, sessionId)
    if (!session) { if (expired) persistStore(store, options, timestamp); return sessionNotFound() }
    if (session.status === 'expired') return contextFailure('CONTEXT_SESSION_EXPIRED', 'Expired context sessions cannot be renewed.')
    if (session.status === 'cleared') return contextFailure('CONTEXT_INVALID_TRANSITION', 'Cleared context sessions cannot be renewed.')
    if (session.status !== 'confirmed') return contextFailure('CONTEXT_SESSION_NOT_AUTHORIZED', 'Only confirmed context sessions can be renewed.')
    const currentExpiry = session.expiresAt ? Date.parse(session.expiresAt) : Date.parse(session.createdAt)
    const nextExpiry = Date.parse(newExpiresAt)
    if (nextExpiry <= currentExpiry || nextExpiry - currentExpiry > 30 * 60_000 || nextExpiry - Date.parse(session.createdAt) > 24 * 60 * 60_000) return contextFailure('CONTEXT_INVALID_INPUT', 'Context session renewal exceeds the allowed extension or lifetime.')
    const nextSession = { ...session, expiresAt: newExpiresAt }
    if (!isContextSession(nextSession)) return invalidInput('Renewed context session failed validation.')
    store.sessions[store.sessions.findIndex(item => item.sessionId === sessionId)] = nextSession
    persistStore(store, options, timestamp)
    return { ok: true, changed: true, session: nextSession }
  })
}

export function clearContextSession(sessionId: string, options?: ContextIntelligenceStoreOptions): ContextSessionResult {
  const timestamp = nowIso(options)
  if (!validIdentifier(sessionId)) return invalidInput('Context session ID is invalid.')
  return withLock(options, store => {
    const expired = expireDueSessions(store, timestamp)
    const session = findSession(store, sessionId)
    if (!session) {
      if (expired) persistStore(store, options, timestamp)
      return sessionNotFound()
    }
    if (session.status === 'cleared') {
      if (expired) persistStore(store, options, timestamp)
      return contextFailure('CONTEXT_INVALID_TRANSITION', 'Context session is already cleared.')
    }
    session.status = 'cleared'
    for (const proposal of store.proposals) {
      if (proposal.sessionId === session.sessionId && proposal.confirmationState === 'pending') proposal.confirmationState = 'expired'
    }
    appendEvent(store, { eventType: 'session.cleared', session, occurredAt: timestamp })
    persistStore(store, options, timestamp)
    return { ok: true, changed: true, session }
  })
}

export function listContextEvents(query: { sessionId?: string; eventType?: ContextEventType } = {}, options?: ContextIntelligenceStoreOptions): ContextEvent[] | ContextStoreFailure {
  if (query.sessionId !== undefined && !validIdentifier(query.sessionId)) return invalidInput('Context event session ID is invalid.')
  return withLock(options, store => store.events.filter(event => {
    if (query.sessionId && event.sessionId !== query.sessionId) return false
    if (query.eventType && event.eventType !== query.eventType) return false
    return true
  }))
}

export function listContextProposals(sessionId?: string, options?: ContextIntelligenceStoreOptions): ContextProposal[] | ContextStoreFailure {
  if (sessionId !== undefined && !validIdentifier(sessionId)) return invalidInput('Context proposal session ID is invalid.')
  return withLock(options, store => store.proposals.filter(proposal => !sessionId || proposal.sessionId === sessionId))
}
