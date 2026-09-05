import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export type ClientWorkflowSessionState = 'active' | 'expired' | 'revoked' | 'cleared'
export type ClientWorkflowApprovalState = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled'

export type ClientWorkflowSession = {
  clientSessionId: string
  clientId: string
  ownerId: string
  state: ClientWorkflowSessionState
  createdAt: string
  expiresAt: string
  contextSessionId?: string
  internalRuntimeSessionId?: string
}

export type ClientCapabilityRequest = {
  requestId: string
  clientSessionId: string
  capabilityId: string
  operation: string
  state: ClientWorkflowApprovalState
  createdAt: string
  expiresAt: string
  approvedBy?: string
  planId?: string
  executionId?: string
  result?: unknown
  permissions: Array<'read' | 'write' | 'command' | 'git' | 'network' | 'capability'>
  budgets: { maximumBytes: number; maximumDurationMs: number; maximumQueries: number }
}

type Store = { version: 1; updatedAt: string; sessions: ClientWorkflowSession[]; requests: ClientCapabilityRequest[] }
export type ClientWorkflowStoreOptions = { rootDir?: string; now?: () => Date; maxSessions?: number; maxRequests?: number }
export type ClientWorkflowFailure = { ok: false; code: 'invalid_request' | 'session_missing' | 'session_expired' | 'session_revoked' | 'invalid_transition' | 'request_missing'; message: string }
export type ClientWorkflowResult<T> = { ok: true; value: T } | ClientWorkflowFailure

const FILE = 'workbench-mcp-client-workflow.json'
const MAX_STRING = 256
const iso = (value: string) => Number.isFinite(Date.parse(value))
const bounded = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= MAX_STRING
function file(options: ClientWorkflowStoreOptions): string { return path.join(path.resolve(options.rootDir ?? path.join(process.cwd(), '.workbench-provider-state')), FILE) }
function now(options: ClientWorkflowStoreOptions): string { return (options.now ?? (() => new Date()))().toISOString() }
function read(options: ClientWorkflowStoreOptions): Store { try { const value = JSON.parse(fs.readFileSync(file(options), 'utf8')) as Store; if (value.version !== 1 || !Array.isArray(value.sessions) || !Array.isArray(value.requests)) throw new Error('invalid'); return value } catch { return { version: 1, updatedAt: new Date(0).toISOString(), sessions: [], requests: [] } } }
function write(store: Store, options: ClientWorkflowStoreOptions): void { const target = file(options); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`; fs.writeFileSync(temp, JSON.stringify({ ...store, sessions: store.sessions.slice(-(options.maxSessions ?? 128)), requests: store.requests.slice(-(options.maxRequests ?? 256)) }), { encoding: 'utf8', mode: 0o600, flag: 'wx' }); fs.renameSync(temp, target); fs.chmodSync(target, 0o600) }
function failure(code: ClientWorkflowFailure['code'], message: string): ClientWorkflowFailure { return { ok: false, code, message } }
function active(session: ClientWorkflowSession, at: string): ClientWorkflowResult<ClientWorkflowSession> { if (session.state === 'expired' || Date.parse(session.expiresAt) <= Date.parse(at)) return failure('session_expired', 'Client session has expired.'); if (session.state === 'revoked') return failure('session_revoked', 'Client session has been revoked.'); if (session.state !== 'active') return failure('invalid_transition', 'Client session is not active.'); return { ok: true, value: session } }

export function createClientWorkflowSession(input: { clientId: string; ownerId: string; expiresAt: string }, options: ClientWorkflowStoreOptions = {}): ClientWorkflowResult<ClientWorkflowSession> {
  const at = now(options); if (!bounded(input.clientId) || !bounded(input.ownerId) || !iso(input.expiresAt) || Date.parse(input.expiresAt) <= Date.parse(at)) return failure('invalid_request', 'Client identity and a future expiry are required.')
  const session: ClientWorkflowSession = { clientSessionId: `mcp-client-${crypto.randomUUID()}`, clientId: input.clientId, ownerId: input.ownerId, state: 'active', createdAt: at, expiresAt: input.expiresAt }
  const store = read(options); store.sessions.push(session); store.updatedAt = at; write(store, options); return { ok: true, value: session }
}

export function getClientWorkflowSession(clientSessionId: string, options: ClientWorkflowStoreOptions = {}): ClientWorkflowResult<ClientWorkflowSession> { const session = read(options).sessions.find(item => item.clientSessionId === clientSessionId); if (!session) return failure('session_missing', 'Client session was not found.'); const result = active(session, now(options)); if (!result.ok && result.code === 'session_expired' && session.state === 'active') { session.state = 'expired'; const store = read(options); const index = store.sessions.findIndex(item => item.clientSessionId === session.clientSessionId); if (index >= 0) store.sessions[index] = session; store.updatedAt = now(options); write(store, options) } return result.ok ? result : { ...result, message: result.message }
}

export function transitionClientWorkflowSession(clientSessionId: string, state: Extract<ClientWorkflowSessionState, 'revoked' | 'cleared'>, options: ClientWorkflowStoreOptions = {}): ClientWorkflowResult<ClientWorkflowSession> { const store = read(options); const session = store.sessions.find(item => item.clientSessionId === clientSessionId); if (!session) return failure('session_missing', 'Client session was not found.'); if (session.state !== 'active') return failure(session.state === 'expired' ? 'session_expired' : 'invalid_transition', 'Only an active client session can be transitioned.'); session.state = state; store.updatedAt = now(options); write(store, options); return { ok: true, value: session } }

export function createClientCapabilityRequest(input: { clientSessionId: string; capabilityId: string; operation: string; expiresAt: string; permissions?: ClientCapabilityRequest['permissions']; budgets?: ClientCapabilityRequest['budgets'] }, options: ClientWorkflowStoreOptions = {}): ClientWorkflowResult<ClientCapabilityRequest> { const session = getClientWorkflowSession(input.clientSessionId, options); if (!session.ok) return session; const at = now(options); const permissions = [...new Set(input.permissions ?? ['read'])] as ClientCapabilityRequest['permissions']; const budgets = input.budgets ?? { maximumBytes: 40_000, maximumDurationMs: 30_000, maximumQueries: 1 }; if (!bounded(input.capabilityId) || !bounded(input.operation) || !iso(input.expiresAt) || Date.parse(input.expiresAt) <= Date.parse(at) || permissions.length < 1 || permissions.length > 6 || Object.values(budgets).some(value => !Number.isFinite(value) || value < 0 || value > 100_000_000)) return failure('invalid_request', 'Capability identity, bounded authority, and a future expiry are required.'); const request: ClientCapabilityRequest = { requestId: `mcp-capability-request-${crypto.randomUUID()}`, clientSessionId: input.clientSessionId, capabilityId: input.capabilityId, operation: input.operation, state: 'pending', createdAt: at, expiresAt: input.expiresAt, permissions, budgets }; const store = read(options); store.requests.push(request); store.updatedAt = at; write(store, options); return { ok: true, value: request } }

export function decideClientCapabilityRequest(requestId: string, state: Extract<ClientWorkflowApprovalState, 'approved' | 'rejected' | 'cancelled'>, approvedBy: string | undefined, options: ClientWorkflowStoreOptions = {}): ClientWorkflowResult<ClientCapabilityRequest> { const store = read(options); const request = store.requests.find(item => item.requestId === requestId); if (!request) return failure('request_missing', 'Capability request was not found.'); if (request.state !== 'pending') return failure('invalid_transition', 'Capability request is no longer awaiting approval.'); if (state === 'approved' && !bounded(approvedBy)) return failure('invalid_request', 'Explicit approver identity is required.'); request.state = state; request.approvedBy = approvedBy; store.updatedAt = now(options); write(store, options); return { ok: true, value: request } }

export function getClientCapabilityRequest(requestId: string, options: ClientWorkflowStoreOptions = {}): ClientWorkflowResult<ClientCapabilityRequest> { const request = read(options).requests.find(item => item.requestId === requestId); if (!request) return failure('request_missing', 'Capability request was not found.'); if (request.state === 'pending' && Date.parse(request.expiresAt) <= Date.parse(now(options))) { request.state = 'expired'; const store = read(options); const index = store.requests.findIndex(item => item.requestId === requestId); if (index >= 0) store.requests[index] = request; store.updatedAt = now(options); write(store, options) } return { ok: true, value: request } }

export function listClientCapabilityRequests(clientSessionId: string, options: ClientWorkflowStoreOptions = {}): ClientWorkflowResult<ClientCapabilityRequest[]> { const session = getClientWorkflowSession(clientSessionId, options); if (!session.ok) return session; return { ok: true, value: read(options).requests.filter(item => item.clientSessionId === clientSessionId).map(item => getClientCapabilityRequest(item.requestId, options)).filter((item): item is { ok: true; value: ClientCapabilityRequest } => item.ok).map(item => item.value) } }
