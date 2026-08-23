import fs from 'node:fs'
import path from 'node:path'
import type { KnowledgeSource } from '@workbench/shared'
import { getSourcesSafe } from './config'
import {
  createContextProposal,
  listContextEvents,
  type ContextIntelligenceStoreOptions,
  type ContextStoreFailure
} from './context-intelligence-store'
import type {
  ContextEvent,
  ContextProposal,
  ContextProposalAmbiguityStatus,
  ContextProposalCandidate
} from './context-intelligence-models'

const MAX_REFERENCE_LENGTH = 500
const MAX_CANDIDATES = 5
const HISTORY_MAX_AGE_MS = 7 * 24 * 60 * 60_000
const AMBIGUITY_MARGIN = 0.08
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/

type SourceAvailability = 'available' | 'disabled' | 'deleted' | 'invalid-path'

export type ContextResolverInput = {
  sessionId: string
  clientId: string
  reference: string
  sourceId?: string
  proposalId?: string
}

export type ContextResolverOptions = {
  sources?: KnowledgeSource[]
  sourceLoader?: () => KnowledgeSource[]
  recentEvents?: ContextEvent[]
  storeOptions?: ContextIntelligenceStoreOptions
  now?: () => Date
}

export type ContextResolverFailure = {
  ok: false
  code:
    | 'CONTEXT_RESOLVER_INVALID_INPUT'
    | 'CONTEXT_RESOLVER_REGISTRY_UNAVAILABLE'
    | 'CONTEXT_RESOLVER_SOURCE_UNKNOWN'
    | 'CONTEXT_RESOLVER_SOURCE_DISABLED'
    | 'CONTEXT_RESOLVER_SOURCE_DELETED'
    | 'CONTEXT_RESOLVER_SOURCE_INVALID_PATH'
    | 'CONTEXT_RESOLVER_SESSION_NOT_FOUND'
    | 'CONTEXT_RESOLVER_STORE_UNAVAILABLE'
  message: string
}

export type ContextResolutionResult = {
  ok: true
  proposal: ContextProposal
  created: boolean
} | ContextResolverFailure

type ScoredCandidate = ContextProposalCandidate & {
  source: KnowledgeSource
}

type SourceMatch = {
  score: number
  reasons: string[]
}

function failure(code: ContextResolverFailure['code'], message: string): ContextResolverFailure {
  return { ok: false, code, message }
}

function normalize(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function tokens(value: string): string[] {
  const normalized = normalize(value)
  return normalized ? normalized.split(' ') : []
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && IDENTIFIER_PATTERN.test(value)
}

function containsPhrase(reference: string, value: string): boolean {
  if (!value) return false
  return reference === value
    || reference.startsWith(`${value} `)
    || reference.endsWith(` ${value}`)
    || reference.includes(` ${value} `)
}

function tokenOverlap(referenceTokens: string[], value: string): number {
  const fieldTokens = Array.from(new Set(tokens(value)))
  if (fieldTokens.length === 0) return 0
  const matches = fieldTokens.filter(token => referenceTokens.includes(token)).length
  return matches / fieldTokens.length
}

function pathValues(source: KnowledgeSource): string[] {
  const values = [source.path]
  if (source.repoRoot) values.push(source.repoRoot)
  return values
}

function repositoryBasenames(source: KnowledgeSource): string[] {
  return Array.from(new Set(pathValues(source).map(value => path.basename(path.normalize(value))).filter(Boolean)))
}

function pathSegments(source: KnowledgeSource): string[] {
  return Array.from(new Set(pathValues(source).flatMap(value => value.split(/[\\/]/).filter(Boolean))))
}

function repositoryGroups(source: KnowledgeSource): string[] {
  return [source.repoGroupId, ...(source.repoRoot ? [path.basename(path.normalize(source.repoRoot))] : [])]
    .filter((value): value is string => Boolean(value))
}

function addReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) reasons.push(reason)
}

function sourceMatch(reference: string, source: KnowledgeSource, recentSourceIds: Set<string>, continuationRequest: boolean): SourceMatch {
  const referenceTokens = tokens(reference)
  const referenceText = normalize(reference)
  const sourceId = normalize(source.id)
  const label = normalize(source.label)
  const basenames = repositoryBasenames(source).map(normalize)
  const branches = source.branchName ? [normalize(source.branchName)] : []
  const groups = repositoryGroups(source).map(normalize)
  const segments = pathSegments(source).map(normalize)
  const reasons: string[] = []
  let score = 0

  if (containsPhrase(referenceText, sourceId)) {
    score = Math.max(score, 1)
    addReason(reasons, 'explicit sourceId match')
  }
  if (containsPhrase(referenceText, label)) {
    score = Math.max(score, 0.95)
    addReason(reasons, 'exact source label')
  }
  if (basenames.some(value => containsPhrase(referenceText, value))) {
    score = Math.max(score, 0.9)
    addReason(reasons, 'repository basename')
  }
  if (branches.some(value => containsPhrase(referenceText, value))) {
    score = Math.max(score, 0.84)
    addReason(reasons, 'branch name')
  }
  if (groups.some(value => containsPhrase(referenceText, value))) {
    score = Math.max(score, 0.82)
    addReason(reasons, 'repository group')
  }

  const labelOverlap = tokenOverlap(referenceTokens, source.label)
  if (labelOverlap > 0) {
    score = Math.max(score, 0.55 + (0.2 * labelOverlap))
    addReason(reasons, 'source label token match')
  }
  const groupOverlap = Math.max(...groups.map(value => tokenOverlap(referenceTokens, value)), 0)
  if (groupOverlap > 0) {
    score = Math.max(score, 0.5 + (0.18 * groupOverlap))
    addReason(reasons, 'repository group token match')
  }
  const segmentOverlap = Math.max(...segments.map(value => tokenOverlap(referenceTokens, value)), 0)
  if (segmentOverlap > 0) {
    score = Math.max(score, 0.5 + (0.16 * segmentOverlap))
    addReason(reasons, 'path segment match')
  }

  if (recentSourceIds.has(source.id)) {
    const recentScore = continuationRequest ? 0.72 : 0.18
    score = Math.max(score, recentScore)
    addReason(reasons, 'recent confirmed context')
  }

  return { score: Math.min(1, Number(score.toFixed(6))), reasons }
}

function sourceAvailability(source: KnowledgeSource): SourceAvailability {
  if (source.enabled === false) return 'disabled'
  try {
    const metadata = fs.statSync(source.path)
    if (!metadata.isDirectory()) return 'invalid-path'
    fs.accessSync(source.path, fs.constants.R_OK)
    return 'available'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'deleted' : 'invalid-path'
  }
}

function availabilityFailure(source: KnowledgeSource, availability: SourceAvailability): ContextResolverFailure {
  if (availability === 'disabled') return failure('CONTEXT_RESOLVER_SOURCE_DISABLED', `Source "${source.id}" is disabled.`)
  if (availability === 'deleted') return failure('CONTEXT_RESOLVER_SOURCE_DELETED', `Source "${source.id}" repository path is missing.`)
  return failure('CONTEXT_RESOLVER_SOURCE_INVALID_PATH', `Source "${source.id}" repository path is invalid.`)
}

function mapStoreFailure(result: ContextStoreFailure): ContextResolverFailure {
  if (result.code === 'CONTEXT_SESSION_NOT_FOUND') return failure('CONTEXT_RESOLVER_SESSION_NOT_FOUND', result.message)
  return failure('CONTEXT_RESOLVER_STORE_UNAVAILABLE', result.message)
}

function recentConfirmedSourceIds(events: ContextEvent[], clientId: string, now: Date): Set<string> {
  const nowMs = now.getTime()
  const sourceIds = new Set<string>()
  events
    .filter(event => event.eventType === 'proposal.confirmed' && event.clientId === clientId)
    .filter(event => {
      const occurredAt = Date.parse(event.occurredAt)
      return Number.isFinite(occurredAt) && occurredAt <= nowMs && nowMs - occurredAt <= HISTORY_MAX_AGE_MS
    })
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || left.eventId.localeCompare(right.eventId))
    .forEach(event => event.sourceIds.forEach(sourceId => sourceIds.add(sourceId)))
  return sourceIds
}

function ambiguityFor(candidates: ScoredCandidate[]): { status: ContextProposalAmbiguityStatus; reason?: string } {
  if (candidates.length === 0) return { status: 'unresolved', reason: 'No enabled repository matched the reference.' }
  if (candidates.length > 1 && candidates[1].confidenceScore >= candidates[0].confidenceScore - AMBIGUITY_MARGIN) {
    return { status: 'ambiguous', reason: 'Multiple repository candidates have similar deterministic scores.' }
  }
  return { status: 'none' }
}

export function resolveContext(input: ContextResolverInput, options: ContextResolverOptions = {}): ContextResolutionResult {
  if (!input || typeof input !== 'object') {
    return failure('CONTEXT_RESOLVER_INVALID_INPUT', 'Context resolution input is required.')
  }
  const reference = typeof input.reference === 'string' ? input.reference.trim() : ''
  if (!validIdentifier(input.sessionId) || !validIdentifier(input.clientId) || (!reference && !input.sourceId)
    || reference.length > MAX_REFERENCE_LENGTH
    || (input.sourceId !== undefined && !validIdentifier(input.sourceId))) {
    return failure('CONTEXT_RESOLVER_INVALID_INPUT', 'Context resolution input requires a bounded reference or explicit sourceId.')
  }

  let sources: KnowledgeSource[]
  try {
    sources = options.sources ? [...options.sources] : (options.sourceLoader || (() => getSourcesSafe({ refreshGitMetadata: false })))()
  } catch {
    return failure('CONTEXT_RESOLVER_REGISTRY_UNAVAILABLE', 'The Workbench source registry could not be loaded.')
  }
  if (!Array.isArray(sources)) return failure('CONTEXT_RESOLVER_REGISTRY_UNAVAILABLE', 'The Workbench source registry returned an invalid collection.')

  const sourceById = new Map(sources.map(source => [source.id, source]))
  if (input.sourceId) {
    const source = sourceById.get(input.sourceId)
    if (!source) return failure('CONTEXT_RESOLVER_SOURCE_UNKNOWN', `Source "${input.sourceId}" is not registered.`)
    const availability = sourceAvailability(source)
    if (availability !== 'available') return availabilityFailure(source, availability)
  }

  const now = options.now || options.storeOptions?.now || (() => new Date())
  let events: ContextEvent[]
  if (options.recentEvents !== undefined) {
    events = [...options.recentEvents]
  } else {
    const eventResult = listContextEvents({ eventType: 'proposal.confirmed' }, options.storeOptions)
    if (!Array.isArray(eventResult)) return mapStoreFailure(eventResult)
    events = eventResult
  }

  const recentSourceIds = recentConfirmedSourceIds(events, input.clientId, now())
  const continuationRequest = /\b(continue|previous|resume|again|last)\b/i.test(reference)
  const rawMatches = sources
    .map(source => ({ source, match: sourceMatch(reference, source, recentSourceIds, continuationRequest) }))
    .filter(entry => entry.match.score > 0)

  if (input.sourceId) {
    const source = sourceById.get(input.sourceId) as KnowledgeSource
    const match = sourceMatch(input.sourceId, source, recentSourceIds, false)
    rawMatches.splice(0, rawMatches.length, { source, match: { score: 1, reasons: ['explicit sourceId'] } })
  }

  const strongInvalidMatch = rawMatches
    .filter(entry => entry.match.score >= 0.82)
    .sort((left, right) => right.match.score - left.match.score || left.source.id.localeCompare(right.source.id))[0]
  if (strongInvalidMatch) {
    const availability = sourceAvailability(strongInvalidMatch.source)
    if (availability !== 'available') return availabilityFailure(strongInvalidMatch.source, availability)
  }

  const candidates: ScoredCandidate[] = rawMatches
    .filter(entry => sourceAvailability(entry.source) === 'available')
    .map(entry => ({
      source: entry.source,
      sourceId: entry.source.id,
      confidenceScore: entry.match.score,
      matchReasons: entry.match.reasons
    }))
    .sort((left, right) => right.confidenceScore - left.confidenceScore || left.sourceId.localeCompare(right.sourceId))
    .slice(0, MAX_CANDIDATES)
  const ambiguity = ambiguityFor(candidates)

  const proposalResult = createContextProposal({
    proposalId: input.proposalId,
    sessionId: input.sessionId,
    candidates: candidates.map(({ source: _source, ...candidate }) => candidate),
    ambiguityStatus: ambiguity.status,
    ambiguityReason: ambiguity.reason,
    confirmationRequired: true,
    createdAt: now().toISOString()
  }, options.storeOptions)
  if (proposalResult.ok === false) return mapStoreFailure(proposalResult)
  return { ok: true, proposal: proposalResult.proposal, created: proposalResult.created === true }
}

export const resolveContextProposal = resolveContext
