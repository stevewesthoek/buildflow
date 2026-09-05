import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getConfigDir } from '../utils/paths'
import { extendContextSessionExpiry, getContextSession, type ContextIntelligenceStoreOptions } from './context-intelligence-store'
import type { ContextSession } from './context-intelligence-models'

export const MCP_CONTEXT_OBSERVABILITY_FILENAME = 'mcp-context-observability.json'
const MAX_EVENTS = 500
const MAX_FAILURES = 32

export type McpContextObservabilityEvent = {
  eventId: string
  occurredAt: string
  outcome: 'success' | 'rejected' | 'failure' | 'degraded'
  sessionId?: string
  requestId?: string
  sourceIds: string[]
  providerIds: string[]
  packageId?: string
  failureCode?: string
  freshnessWarnings: number
  packageBytes: number
  retrievalLatencyMs: number
  preparationLatencyMs: number
}

export type McpContextObservabilityStore = {
  version: 1
  updatedAt: string
  counters: {
    requests: number
    successfulDeliveries: number
    rejectedRequests: number
    authorizationFailures: number
    unavailableProviders: number
    staleContextUsage: number
    sourceCount: number
    knowledgeProviderCount: number
    packageBytes: number
    retrievalLatencyMs: number
    preparationLatencyMs: number
  }
  activeSessionIds: string[]
  recentFailures: Array<{ occurredAt: string; code: string; sessionId?: string; sourceIds: string[] }>
  events: McpContextObservabilityEvent[]
  sessions?: McpContextSessionLifecycleRecord[]
  renewalEvents?: McpContextRenewalAuditEvent[]
}

export type McpContextSessionLifecycleState = 'created' | 'confirmed' | 'active' | 'idle' | 'expired' | 'revoked' | 'unavailable'
export type McpContextRenewalState = 'none' | 'requested' | 'approved' | 'denied'
export type McpContextSessionLifecycleRecord = { sessionId: string; ownerId?: string; state: McpContextSessionLifecycleState; renewalState: McpContextRenewalState; createdAt: string; confirmedAt?: string; expiresAt?: string; lastActivityAt?: string; lastSuccessfulDeliveryAt?: string; requestCount: number; sourceIds: string[]; providerIds: string[]; failure?: string }
export type McpContextRenewalAuthorization = { authorizedBy: string; authority: 'explicit-user' | 'admin'; reason: string; requestId?: string }
export type McpContextRenewalAuditEvent = { eventId: string; eventType: 'renewal.requested' | 'renewal.approved' | 'renewal.denied' | 'renewal.executed' | 'renewal.expired'; occurredAt: string; sessionId: string; authorizedBy?: string; authority?: McpContextRenewalAuthorization['authority']; reason?: string; previousExpiresAt?: string; newExpiresAt?: string; requestId?: string }

export type McpContextObservabilityOptions = { storePath?: string; now?: () => Date; maxEvents?: number }

function target(options: McpContextObservabilityOptions = {}): string { return path.resolve(options.storePath || path.join(getConfigDir(), MCP_CONTEXT_OBSERVABILITY_FILENAME)) }
function empty(now: string): McpContextObservabilityStore { return { version: 1, updatedAt: now, counters: { requests: 0, successfulDeliveries: 0, rejectedRequests: 0, authorizationFailures: 0, unavailableProviders: 0, staleContextUsage: 0, sourceCount: 0, knowledgeProviderCount: 0, packageBytes: 0, retrievalLatencyMs: 0, preparationLatencyMs: 0 }, activeSessionIds: [], recentFailures: [], events: [], sessions: [], renewalEvents: [] } }
function read(options: McpContextObservabilityOptions = {}): McpContextObservabilityStore { try { const value = JSON.parse(fs.readFileSync(target(options), 'utf8')) as McpContextObservabilityStore; if (value.version === 1 && value.counters && Array.isArray(value.events)) return value } catch {} return empty((options.now || (() => new Date()))().toISOString()) }

export function recordMcpContextConsumption(input: Omit<McpContextObservabilityEvent, 'eventId' | 'occurredAt'>, options: McpContextObservabilityOptions = {}): void {
  try {
    const now = (options.now || (() => new Date()))().toISOString(); const store = read(options); const event = { ...input, ...(input.requestId ? { requestId: input.requestId.slice(0, 160) } : {}), eventId: `mcp-context-${crypto.randomUUID()}`, occurredAt: now, sourceIds: [...new Set(input.sourceIds)].sort().slice(0, 64), providerIds: [...new Set(input.providerIds)].sort().slice(0, 64), freshnessWarnings: Math.max(0, Math.min(32, input.freshnessWarnings)), packageBytes: Math.max(0, Math.min(10_000_000, input.packageBytes)), retrievalLatencyMs: Math.max(0, Math.min(120_000, input.retrievalLatencyMs)), preparationLatencyMs: Math.max(0, Math.min(120_000, input.preparationLatencyMs)) } satisfies McpContextObservabilityEvent
    const c = store.counters; c.requests += 1; if (event.outcome === 'success' || event.outcome === 'degraded') c.successfulDeliveries += 1; if (event.outcome === 'rejected') c.rejectedRequests += 1; if (event.outcome === 'rejected' && ['context_session_required', 'context_session_not_confirmed', 'source_not_active'].includes(event.failureCode || '')) c.authorizationFailures += 1; if (event.failureCode === 'source_unavailable' || event.failureCode === 'knowledge_runtime_unavailable') c.unavailableProviders += 1; c.staleContextUsage += event.freshnessWarnings > 0 ? 1 : 0; c.sourceCount += event.sourceIds.length; c.knowledgeProviderCount += event.providerIds.length; c.packageBytes += event.packageBytes; c.retrievalLatencyMs += event.retrievalLatencyMs; c.preparationLatencyMs += event.preparationLatencyMs
    if (event.sessionId && (event.outcome === 'success' || event.outcome === 'degraded')) store.activeSessionIds = [...new Set([...store.activeSessionIds, event.sessionId])].sort().slice(-64)
    if (event.outcome !== 'success' && event.outcome !== 'degraded' && event.failureCode) store.recentFailures = [...store.recentFailures, { occurredAt: now, code: event.failureCode, ...(event.sessionId ? { sessionId: event.sessionId } : {}), sourceIds: event.sourceIds }].slice(-MAX_FAILURES)
    store.events = [...store.events, event].slice(-(options.maxEvents ? Math.min(MAX_EVENTS, Math.max(1, options.maxEvents)) : MAX_EVENTS)); store.updatedAt = now; const file = target(options); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, JSON.stringify(store), { encoding: 'utf8', mode: 0o600 })
  } catch {}
}

export function getMcpContextDiagnostics(options: McpContextObservabilityOptions = {}): { status: 'ready' | 'degraded' | 'unavailable'; activeSessionIds: string[]; sessionLifecycle: { activeCount: number; idleCount: number; expiredCount: number; revokedCount: number; upcomingExpirations: Array<{ sessionId: string; expiresAt: string }> }; renewal: { requested: number; approved: number; denied: number; executed: number; expired: number; invalidStates: number }; bridge: { status: 'ready' | 'degraded'; recentFailures: McpContextObservabilityStore['recentFailures'] }; metrics: McpContextObservabilityStore['counters']; lastPackage?: { packageId: string; occurredAt: string; sourceIds: string[]; providerIds: string[] } } {
  const store = read(options); const sessions = store.sessions || []; const renewalEvents = store.renewalEvents || []; const now = (options.now || (() => new Date()))().getTime(); const last = [...store.events].reverse().find(event => event.packageId); const status = store.counters.requests === 0 ? 'unavailable' : store.recentFailures.length > 0 ? 'degraded' : 'ready'; return { status, activeSessionIds: [...store.activeSessionIds].sort().slice(0, 64), sessionLifecycle: { activeCount: sessions.filter(item => item.state === 'active' || item.state === 'confirmed').length, idleCount: sessions.filter(item => item.state === 'idle').length, expiredCount: sessions.filter(item => item.state === 'expired').length, revokedCount: sessions.filter(item => item.state === 'revoked').length, upcomingExpirations: sessions.filter(item => item.expiresAt && Date.parse(item.expiresAt) > now).sort((a, b) => Date.parse(a.expiresAt!) - Date.parse(b.expiresAt!)).slice(0, 16).map(item => ({ sessionId: item.sessionId, expiresAt: item.expiresAt! })) }, renewal: { requested: renewalEvents.filter(item => item.eventType === 'renewal.requested').length, approved: renewalEvents.filter(item => item.eventType === 'renewal.approved').length, denied: renewalEvents.filter(item => item.eventType === 'renewal.denied').length, executed: renewalEvents.filter(item => item.eventType === 'renewal.executed').length, expired: renewalEvents.filter(item => item.eventType === 'renewal.expired').length, invalidStates: sessions.filter(item => item.renewalState === 'approved' && item.state !== 'confirmed').length }, bridge: { status: store.recentFailures.length > 0 ? 'degraded' : 'ready', recentFailures: store.recentFailures.slice(-MAX_FAILURES) }, metrics: { ...store.counters }, ...(last?.packageId ? { lastPackage: { packageId: last.packageId, occurredAt: last.occurredAt, sourceIds: last.sourceIds, providerIds: last.providerIds } } : {}) }
}

function writeStore(store: McpContextObservabilityStore, options: McpContextObservabilityOptions): void { const file = target(options); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, JSON.stringify(store), { encoding: 'utf8', mode: 0o600 }) }
function renewalAudit(store: McpContextObservabilityStore, event: Omit<McpContextRenewalAuditEvent, 'eventId' | 'occurredAt'>, now: string): void { store.renewalEvents = [...(store.renewalEvents || []), { ...event, eventId: `mcp-renewal-${crypto.randomUUID()}`, occurredAt: now }].slice(-128) }

function lifecycleState(session: ContextSession, now: string, existing?: McpContextSessionLifecycleRecord): McpContextSessionLifecycleState {
  if (session.status === 'cleared') return 'revoked'
  if (session.expiresAt && Date.parse(session.expiresAt) <= Date.parse(now)) return 'expired'
  if (session.status !== 'confirmed') return 'created'
  if (existing?.lastActivityAt && Date.parse(now) - Date.parse(existing.lastActivityAt) > 15 * 60_000) return 'idle'
  return existing?.lastSuccessfulDeliveryAt ? 'active' : 'confirmed'
}

export function validateMcpContextSession(sessionId: string, options: { contextStore?: ContextIntelligenceStoreOptions; observability?: McpContextObservabilityOptions; ownerId?: string } = {}): { ok: true; lifecycle: McpContextSessionLifecycleRecord } | { ok: false; code: 'session_missing' | 'session_unconfirmed' | 'session_expired' | 'session_revoked' | 'session_unavailable' | 'owner_mismatch'; message: string } {
  const now = (options.observability?.now || (() => new Date()))().toISOString(); const value = getContextSession(sessionId, options.contextStore); if (!value) return { ok: false, code: 'session_missing', message: 'MCP context session does not exist.' }; if ('ok' in value) return { ok: false, code: 'session_unavailable', message: 'MCP context session could not be loaded.' }
  if (options.ownerId !== undefined && value.ownerId !== undefined && value.ownerId !== options.ownerId) return { ok: false, code: 'owner_mismatch', message: 'MCP context session ownership does not match the request owner.' }
  const store = read(options.observability); const prior = (store.sessions || []).find(item => item.sessionId === sessionId); const state = lifecycleState(value, now, prior); const lifecycle: McpContextSessionLifecycleRecord = { ...(prior || { sessionId, renewalState: 'none' as const, requestCount: 0, sourceIds: [...value.sourceIds], providerIds: [], createdAt: value.createdAt }), ...(value.ownerId ? { ownerId: value.ownerId } : {}), state, sourceIds: [...value.sourceIds].sort(), ...(value.confirmedAt ? { confirmedAt: value.confirmedAt } : {}), ...(value.expiresAt ? { expiresAt: value.expiresAt } : {}), ...(state === 'unavailable' ? { failure: 'session_unavailable' } : {}) }
  store.sessions = [...(store.sessions || []).filter(item => item.sessionId !== sessionId), lifecycle].sort((a, b) => a.sessionId.localeCompare(b.sessionId)).slice(-64); store.updatedAt = now; writeStore(store, options.observability || {})
  if (state === 'expired') return { ok: false, code: 'session_expired', message: 'MCP context session has expired.' }; if (state === 'revoked') return { ok: false, code: 'session_revoked', message: 'MCP context session has been revoked.' }; if (state === 'created') return { ok: false, code: 'session_unconfirmed', message: 'MCP context session is not confirmed.' }; return { ok: true, lifecycle }
}

export function touchMcpContextSession(sessionId: string, sourceIds: string[], providerIds: string[], successful: boolean, options: McpContextObservabilityOptions = {}): void {
  const now = (options.now || (() => new Date()))().toISOString(); const store = read(options); const item = (store.sessions || []).find(record => record.sessionId === sessionId); if (!item) return; item.requestCount += 1; item.lastActivityAt = now; item.sourceIds = [...new Set(sourceIds)].sort().slice(0, 64); item.providerIds = [...new Set(providerIds)].sort().slice(0, 64); if (successful) { item.state = 'active'; item.lastSuccessfulDeliveryAt = now }; store.updatedAt = now; writeStore(store, options)
}

export function requestMcpContextSessionRenewal(sessionId: string, options: McpContextObservabilityOptions = {}): { ok: true; state: 'requested' } | { ok: false; code: 'session_missing' | 'session_expired' | 'session_revoked' | 'renewal_not_allowed' } {
  const now = (options.now || (() => new Date()))().toISOString(); const store = read(options); const item = (store.sessions || []).find(record => record.sessionId === sessionId); if (!item) return { ok: false, code: 'session_missing' }; if (item.state === 'expired') { renewalAudit(store, { eventType: 'renewal.expired', sessionId, reason: 'session_expired' }, now); writeStore(store, options); return { ok: false, code: 'session_expired' } } if (item.state === 'revoked') return { ok: false, code: 'session_revoked' }; if (item.renewalState === 'requested' || item.renewalState === 'approved') return { ok: false, code: 'renewal_not_allowed' }; item.renewalState = 'requested'; renewalAudit(store, { eventType: 'renewal.requested', sessionId }, now); store.updatedAt = now; writeStore(store, options); return { ok: true, state: 'requested' }
}

export function approveMcpContextSessionRenewal(sessionId: string, newExpiresAt: string, authorization: McpContextRenewalAuthorization | undefined, options: { contextStore?: ContextIntelligenceStoreOptions; observability?: McpContextObservabilityOptions } = {}): { ok: true; state: 'approved' } | { ok: false; code: 'authorization_required' | 'session_missing' | 'session_expired' | 'session_revoked' | 'renewal_not_requested' | 'renewal_limit_exceeded' } {
  const now = (options.observability?.now || (() => new Date()))().toISOString(); const store = read(options.observability); const item = (store.sessions || []).find(record => record.sessionId === sessionId); if (!authorization || !authorization.authorizedBy || !authorization.reason || !['explicit-user', 'admin'].includes(authorization.authority)) { renewalAudit(store, { eventType: 'renewal.denied', sessionId, reason: 'authorization_required' }, now); writeStore(store, options.observability || {}); return { ok: false, code: 'authorization_required' } } if (!item) return { ok: false, code: 'session_missing' }; if (item.state === 'expired') return { ok: false, code: 'session_expired' }; if (item.state === 'revoked') return { ok: false, code: 'session_revoked' }; if (item.renewalState !== 'requested') return { ok: false, code: 'renewal_not_requested' }; const previous = item.expiresAt; if (!previous || Date.parse(newExpiresAt) <= Date.parse(previous) || Date.parse(newExpiresAt) - Date.parse(previous) > 30 * 60_000 || Date.parse(newExpiresAt) - Date.parse(item.createdAt) > 24 * 60 * 60_000) { renewalAudit(store, { eventType: 'renewal.denied', sessionId, authorizedBy: authorization.authorizedBy, authority: authorization.authority, reason: 'renewal_limit_exceeded', previousExpiresAt: previous, newExpiresAt, requestId: authorization.requestId }, now); writeStore(store, options.observability || {}); return { ok: false, code: 'renewal_limit_exceeded' } } item.renewalState = 'approved'; renewalAudit(store, { eventType: 'renewal.approved', sessionId, authorizedBy: authorization.authorizedBy, authority: authorization.authority, reason: authorization.reason, previousExpiresAt: previous, newExpiresAt, requestId: authorization.requestId }, now); store.updatedAt = now; writeStore(store, options.observability || {}); return { ok: true, state: 'approved' }
}

export function executeMcpContextSessionRenewal(sessionId: string, options: { contextStore?: ContextIntelligenceStoreOptions; observability?: McpContextObservabilityOptions } = {}): { ok: true; state: 'executed'; previousExpiresAt: string; newExpiresAt: string } | { ok: false; code: 'renewal_not_approved' | 'session_expired' | 'session_revoked' | 'session_missing' } {
  const now = (options.observability?.now || (() => new Date()))().toISOString(); const store = read(options.observability); const item = (store.sessions || []).find(record => record.sessionId === sessionId); if (!item) return { ok: false, code: 'session_missing' }; if (item.state === 'expired') return { ok: false, code: 'session_expired' }; if (item.state === 'revoked') return { ok: false, code: 'session_revoked' }; if (item.renewalState !== 'approved' || !item.expiresAt) return { ok: false, code: 'renewal_not_approved' }; const audit = [...(store.renewalEvents || [])].reverse().find(event => event.eventType === 'renewal.approved' && event.sessionId === sessionId); if (!audit?.newExpiresAt) return { ok: false, code: 'renewal_not_approved' }; const result = extendContextSessionExpiry(sessionId, audit.newExpiresAt, options.contextStore); if ('code' in result) return { ok: false, code: result.code === 'CONTEXT_SESSION_EXPIRED' ? 'session_expired' : 'renewal_not_approved' }; item.renewalState = 'none'; item.expiresAt = audit.newExpiresAt; item.state = 'confirmed'; renewalAudit(store, { eventType: 'renewal.executed', sessionId, authorizedBy: audit.authorizedBy, authority: audit.authority, reason: audit.reason, previousExpiresAt: audit.previousExpiresAt, newExpiresAt: audit.newExpiresAt, requestId: audit.requestId }, now); store.updatedAt = now; writeStore(store, options.observability || {}); return { ok: true, state: 'executed', previousExpiresAt: audit.previousExpiresAt!, newExpiresAt: audit.newExpiresAt }
}
