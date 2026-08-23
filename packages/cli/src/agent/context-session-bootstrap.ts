import crypto from 'node:crypto'
import {
  createContextSession,
  getContextSession,
  type ContextIntelligenceStoreOptions,
  type ContextStoreFailure
} from './context-intelligence-store'
import type { ContextAuthorityLevel, ContextSession, ContextSessionMode } from './context-intelligence-models'

export type ContextSessionBootstrapInput = {
  clientId: string
  ownerId: string
  createdBy: string
  sourceIds: string[]
  mode?: ContextSessionMode
  authorityLevel?: ContextAuthorityLevel
  existingSessionId?: string
}

export type ContextSessionBootstrapResult = {
  ok: true
  created: boolean
  reused: boolean
  session: ContextSession
  contextSessionId: string
} | {
  ok: false
  code: 'invalid_input' | 'session_unavailable' | 'owner_mismatch' | 'source_mismatch' | 'session_not_reusable'
  message: string
}

type ContextSessionBootstrapFailureCode = 'invalid_input' | 'session_unavailable' | 'owner_mismatch' | 'source_mismatch' | 'session_not_reusable'

function deterministicSessionId(input: ContextSessionBootstrapInput): string {
  const digest = crypto.createHash('sha256')
    .update([input.clientId, input.ownerId, input.createdBy, input.mode || 'single', ...input.sourceIds].join('\0'))
    .digest('hex')
    .slice(0, 32)
  return `context-bootstrap-${digest}`
}

function failure(code: ContextSessionBootstrapFailureCode, message: string): ContextSessionBootstrapResult {
  return { ok: false, code, message }
}

function isStoreFailure(value: unknown): value is ContextStoreFailure {
  return Boolean(value && typeof value === 'object' && 'ok' in value && (value as { ok?: unknown }).ok === false)
}

export function bootstrapContextSession(input: ContextSessionBootstrapInput, options?: ContextIntelligenceStoreOptions): ContextSessionBootstrapResult {
  if (!input || !input.clientId || !input.ownerId || !input.createdBy || !Array.isArray(input.sourceIds) || input.sourceIds.length === 0) {
    return failure('invalid_input', 'Context session bootstrap requires client, owner, creator, and source identity.')
  }
  const sessionId = input.existingSessionId || deterministicSessionId(input)
  const existing = getContextSession(sessionId, options)
  if (existing && isStoreFailure(existing)) return failure('session_unavailable', existing.message)
  if (existing) {
    const liveSession = existing as ContextSession
    if (liveSession.ownerId !== input.ownerId || liveSession.createdBy !== input.createdBy || liveSession.clientId !== input.clientId) return failure('owner_mismatch', 'Existing context session ownership does not match the bootstrap request.')
    if (liveSession.sourceIds.length !== input.sourceIds.length || liveSession.sourceIds.some((sourceId, index) => sourceId !== input.sourceIds[index])) return failure('source_mismatch', 'Existing context session source binding does not match the bootstrap request.')
    if (liveSession.status === 'expired' || liveSession.status === 'cleared') return failure('session_not_reusable', 'Expired or cleared context sessions cannot be reused.')
    return { ok: true, created: false, reused: true, session: liveSession, contextSessionId: liveSession.sessionId }
  }

  const created = createContextSession({
    sessionId,
    clientId: input.clientId,
    ownerId: input.ownerId,
    createdBy: input.createdBy,
    sourceIds: input.sourceIds,
    mode: input.mode || (input.sourceIds.length === 1 ? 'single' : 'multi'),
    authorityLevel: input.authorityLevel || 'inferred-suggestion'
  }, options)
  if (created.ok === false) return failure('session_unavailable', created.message)
  return { ok: true, created: created.created !== false, reused: created.created === false, session: created.session, contextSessionId: created.session.sessionId }
}

export class ContextSessionBootstrap {
  constructor(private readonly options?: ContextIntelligenceStoreOptions) {}
  bootstrap(input: ContextSessionBootstrapInput): ContextSessionBootstrapResult { return bootstrapContextSession(input, this.options) }
}
