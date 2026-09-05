import crypto from 'node:crypto'
import type { AutonomyPermissionCategory } from './autonomy-policy'

export const AUTONOMY_DECISION_SCHEMA_VERSION = 1 as const
export const AUTONOMY_DECISION_POLICY_VERSION = 'r16.2' as const
export const AUTONOMY_DECISION_VALUES = ['APPROVED', 'DENIED'] as const
export type PersistedAutonomyDecisionValue = typeof AUTONOMY_DECISION_VALUES[number]

export const AUTONOMY_DECISION_MAX_ARGUMENT_BYTES = 32 * 1024
export const AUTONOMY_DECISION_MAX_POLICY_CONTEXT_BYTES = 64 * 1024
export const AUTONOMY_DECISION_MAX_TTL_MS = 24 * 60 * 60_000

export type AutonomyDecisionEvidenceReference = Readonly<{
  evidenceId: string
  kind: 'raw_log' | 'diff' | 'validation_result' | 'capability_result'
  reference: string
  recordedAt: string
}>

export type AutonomyPolicyBinding = Readonly<{
  version: string
  fingerprint: string
  context: string
}>

export type AutonomyDecisionRequestInput = Readonly<{
  operation: string
  category: AutonomyPermissionCategory
  sourceId: string
  runId: string
  sessionId: string
  actorId: string
  capabilityId: string
  paths?: readonly string[]
  arguments?: unknown
  policy: AutonomyPolicyBinding
}>

export type AutonomyDecisionRequest = Readonly<{
  operation: string
  category: AutonomyPermissionCategory
  sourceId: string
  runId: string
  sessionId: string
  actorId: string
  capabilityId: string
  paths: readonly string[]
  normalizedArgs: string
  policy: AutonomyPolicyBinding
  scopeFingerprint: string
  requestFingerprint: string
}>

export type PersistedAutonomyDecision = Readonly<{
  schemaVersion: typeof AUTONOMY_DECISION_SCHEMA_VERSION
  decisionId: string
  decision: PersistedAutonomyDecisionValue
  operation: string
  category: AutonomyPermissionCategory
  sourceId: string
  runId: string
  sessionId: string
  actorId: string
  requestActorId: string
  capabilityId: string
  paths: readonly string[]
  normalizedArgs: string
  policy: AutonomyPolicyBinding
  scopeFingerprint: string
  requestFingerprint: string
  evidenceRef: AutonomyDecisionEvidenceReference
  createdAt: string
  expiresAt: string
}>

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/
const HASH = /^[a-f0-9]{64}$/
const DECISION_ID = /^autonomy-decision-[A-Za-z0-9-]{1,100}$/
const EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/
const CATEGORIES = new Set<AutonomyPermissionCategory>([
  'read', 'write', 'command', 'git', 'network', 'capability', 'release'
])
const EVIDENCE_KINDS = new Set<AutonomyDecisionEvidenceReference['kind']>([
  'raw_log', 'diff', 'validation_result', 'capability_result'
])

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value)
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
}

function canonicalJson(value: unknown, seen: Set<object>, depth: number): string {
  if (depth > 16) throw new Error('Autonomy decision value is too deeply nested.')
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      if (value.length > 16_000) throw new Error('Autonomy decision string is too large.')
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) throw new Error('Autonomy decision numbers must be finite.')
      return JSON.stringify(value)
    case 'undefined':
    case 'bigint':
    case 'function':
    case 'symbol':
      throw new Error('Autonomy decision values must be JSON-safe.')
  }
  const objectValue = value as object
  if (seen.has(objectValue)) throw new Error('Autonomy decision values must not be cyclic.')
  seen.add(objectValue)
  try {
    if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item, seen, depth + 1)).join(',')}]`
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key], seen, depth + 1)}`).join(',')}}`
  } finally {
    seen.delete(objectValue)
  }
}

export function canonicalizeAutonomyValue(value: unknown, maxBytes = AUTONOMY_DECISION_MAX_POLICY_CONTEXT_BYTES): string {
  const result = canonicalJson(value, new Set<object>(), 0)
  if (Buffer.byteLength(result, 'utf8') > maxBytes) throw new Error('Autonomy decision value exceeds its bounded size.')
  return result
}

/**
 * Normalize separators and harmless dot segments without resolving `..`.
 * Escapes remain visible to the hard repository-path guards and can never
 * become equivalent to an in-repository path through fingerprinting.
 */
export function normalizeAutonomyPath(value: string): string {
  const raw = value.replace(/\\/g, '/').replace(/\/+/g, '/').trim()
  const absolute = raw.startsWith('/')
  const trailing = raw.length > 1 && raw.endsWith('/')
  const parts = raw.split('/').filter(part => part !== '' && part !== '.')
  const normalized = `${absolute ? '/' : ''}${parts.join('/')}` || (absolute ? '/' : '')
  return trailing && normalized !== '/' ? `${normalized}/` : normalized
}

export function normalizeAutonomyPaths(values: readonly string[] = []): string[] {
  if (!Array.isArray(values) || values.length > 64) throw new Error('Autonomy decision paths are invalid.')
  const normalized = values.map(value => {
    if (typeof value !== 'string' || !value.trim() || value.length > 1_000) throw new Error('Autonomy decision path is invalid.')
    const result = normalizeAutonomyPath(value)
    if (!result) throw new Error('Autonomy decision path is empty.')
    return result
  })
  return [...new Set(normalized)].sort()
}

export function createAutonomyPolicyBinding(version: string, context: unknown): AutonomyPolicyBinding {
  if (!validIdentifier(version) || version.length > 64) throw new Error('Autonomy policy version is invalid.')
  const canonicalContext = canonicalizeAutonomyValue(context, AUTONOMY_DECISION_MAX_POLICY_CONTEXT_BYTES)
  return { version, fingerprint: sha256(`${version}\0${canonicalContext}`), context: canonicalContext }
}

function requestScopePayload(request: Pick<AutonomyDecisionRequest, 'operation' | 'category' | 'sourceId' | 'runId' | 'sessionId' | 'actorId' | 'capabilityId' | 'paths' | 'normalizedArgs'>): Record<string, unknown> {
  return {
    operation: request.operation,
    category: request.category,
    sourceId: request.sourceId,
    runId: request.runId,
    sessionId: request.sessionId,
    actorId: request.actorId,
    capabilityId: request.capabilityId,
    paths: request.paths,
    normalizedArgs: request.normalizedArgs
  }
}

export function createAutonomyScopeFingerprint(request: Pick<AutonomyDecisionRequest, 'operation' | 'category' | 'sourceId' | 'runId' | 'sessionId' | 'actorId' | 'capabilityId' | 'paths' | 'normalizedArgs'>): string {
  return sha256(canonicalizeAutonomyValue(requestScopePayload(request)))
}

export function createAutonomyRequestFingerprint(request: Omit<AutonomyDecisionRequest, 'scopeFingerprint' | 'requestFingerprint'>): string {
  return sha256(canonicalizeAutonomyValue({
    ...requestScopePayload(request),
    policy: request.policy
  }))
}

export function createAutonomyDecisionRequest(input: AutonomyDecisionRequestInput): AutonomyDecisionRequest {
  if (!input || !validIdentifier(input.operation) || !CATEGORIES.has(input.category)
    || !validIdentifier(input.sourceId) || !validIdentifier(input.runId)
    || !validIdentifier(input.sessionId) || !validIdentifier(input.actorId)
    || !validIdentifier(input.capabilityId)) {
    throw new Error('Autonomy decision request identity or operation is invalid.')
  }
  const paths = normalizeAutonomyPaths(input.paths)
  const normalizedArgs = canonicalizeAutonomyValue(input.arguments === undefined ? null : input.arguments, AUTONOMY_DECISION_MAX_ARGUMENT_BYTES)
  if (!input.policy || !validIdentifier(input.policy.version) || !HASH.test(input.policy.fingerprint)
    || typeof input.policy.context !== 'string' || input.policy.context.length === 0
    || Buffer.byteLength(input.policy.context, 'utf8') > AUTONOMY_DECISION_MAX_POLICY_CONTEXT_BYTES
    || canonicalizeAutonomyValue(JSON.parse(input.policy.context), AUTONOMY_DECISION_MAX_POLICY_CONTEXT_BYTES) !== input.policy.context
    || sha256(`${input.policy.version}\0${input.policy.context}`) !== input.policy.fingerprint) {
    throw new Error('Autonomy decision policy binding is invalid.')
  }
  const base = {
    operation: input.operation,
    category: input.category,
    sourceId: input.sourceId,
    runId: input.runId,
    sessionId: input.sessionId,
    actorId: input.actorId,
    capabilityId: input.capabilityId,
    paths,
    normalizedArgs,
    policy: input.policy
  }
  return {
    ...base,
    scopeFingerprint: createAutonomyScopeFingerprint(base),
    requestFingerprint: createAutonomyRequestFingerprint(base)
  }
}

export function buildPersistedAutonomyDecision(input: {
  decisionId: string
  decision: PersistedAutonomyDecisionValue
  request: AutonomyDecisionRequest
  actorId: string
  evidenceRef: AutonomyDecisionEvidenceReference
  createdAt: string
  expiresAt: string
}): PersistedAutonomyDecision {
  const actorId = input.actorId
  if (!DECISION_ID.test(input.decisionId) || !AUTONOMY_DECISION_VALUES.includes(input.decision)
    || !validIdentifier(actorId) || !validIso(input.createdAt) || !validIso(input.expiresAt)
    || Date.parse(input.expiresAt) <= Date.parse(input.createdAt)
    || Date.parse(input.expiresAt) - Date.parse(input.createdAt) > AUTONOMY_DECISION_MAX_TTL_MS) {
    throw new Error('Autonomy decision identity or bounded expiry is invalid.')
  }
  const ref = input.evidenceRef
  if (!ref || !EVIDENCE_ID.test(ref.evidenceId) || !EVIDENCE_KINDS.has(ref.kind)
    || !validIdentifier(ref.reference) || !validIso(ref.recordedAt)) {
    throw new Error('Autonomy decision evidence reference is invalid.')
  }
  const record: PersistedAutonomyDecision = {
    schemaVersion: AUTONOMY_DECISION_SCHEMA_VERSION,
    decisionId: input.decisionId,
    decision: input.decision,
    operation: input.request.operation,
    category: input.request.category,
    sourceId: input.request.sourceId,
    runId: input.request.runId,
    sessionId: input.request.sessionId,
    actorId,
    requestActorId: input.request.actorId,
    capabilityId: input.request.capabilityId,
    paths: [...input.request.paths],
    normalizedArgs: input.request.normalizedArgs,
    policy: input.request.policy,
    scopeFingerprint: input.request.scopeFingerprint,
    requestFingerprint: input.request.requestFingerprint,
    evidenceRef: { ...ref },
    createdAt: input.createdAt,
    expiresAt: input.expiresAt
  }
  if (!isPersistedAutonomyDecision(record)) throw new Error('Autonomy decision record failed canonical validation.')
  return record
}

export function isAutonomyDecisionRequest(value: unknown): value is AutonomyDecisionRequest {
  try {
    if (!value || typeof value !== 'object') return false
    const item = value as AutonomyDecisionRequest
    const rebuilt = createAutonomyDecisionRequest({
      operation: item.operation,
      category: item.category,
      sourceId: item.sourceId,
      runId: item.runId,
      sessionId: item.sessionId,
      actorId: item.actorId,
      capabilityId: item.capabilityId,
      paths: item.paths,
      arguments: JSON.parse(item.normalizedArgs),
      policy: item.policy
    })
    return rebuilt.scopeFingerprint === item.scopeFingerprint && rebuilt.requestFingerprint === item.requestFingerprint
  } catch {
    return false
  }
}

export function isPersistedAutonomyDecision(value: unknown): value is PersistedAutonomyDecision {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<PersistedAutonomyDecision>
  return item.schemaVersion === AUTONOMY_DECISION_SCHEMA_VERSION
    && typeof item.decisionId === 'string' && DECISION_ID.test(item.decisionId)
    && typeof item.decision === 'string' && AUTONOMY_DECISION_VALUES.includes(item.decision as PersistedAutonomyDecisionValue)
    && validIdentifier(item.operation) && CATEGORIES.has(item.category as AutonomyPermissionCategory)
    && validIdentifier(item.sourceId) && validIdentifier(item.runId) && validIdentifier(item.sessionId)
    && validIdentifier(item.actorId) && validIdentifier(item.requestActorId) && validIdentifier(item.capabilityId)
    && Array.isArray(item.paths) && item.paths.length <= 64
    && item.paths.every(path => typeof path === 'string' && path === normalizeAutonomyPath(path))
    && JSON.stringify([...item.paths].sort()) === JSON.stringify(item.paths)
    && typeof item.normalizedArgs === 'string'
    && (() => { try { return canonicalizeAutonomyValue(JSON.parse(item.normalizedArgs), AUTONOMY_DECISION_MAX_ARGUMENT_BYTES) === item.normalizedArgs } catch { return false } })()
    && !!item.policy && validIdentifier(item.policy.version) && HASH.test(item.policy.fingerprint)
    && typeof item.policy.context === 'string'
    && (() => { try { return canonicalizeAutonomyValue(JSON.parse(item.policy!.context), AUTONOMY_DECISION_MAX_POLICY_CONTEXT_BYTES) === item.policy!.context } catch { return false } })()
    && HASH.test(item.scopeFingerprint || '') && HASH.test(item.requestFingerprint || '')
    && !!item.evidenceRef && EVIDENCE_ID.test(item.evidenceRef.evidenceId)
    && EVIDENCE_KINDS.has(item.evidenceRef.kind) && validIdentifier(item.evidenceRef.reference)
    && validIso(item.evidenceRef.recordedAt) && validIso(item.createdAt) && validIso(item.expiresAt)
    && Date.parse(item.expiresAt as string) > Date.parse(item.createdAt as string)
    && Date.parse(item.expiresAt as string) - Date.parse(item.createdAt as string) <= AUTONOMY_DECISION_MAX_TTL_MS
    && (() => {
      try {
        const request = createAutonomyDecisionRequest({
          operation: item.operation!, category: item.category!, sourceId: item.sourceId!, runId: item.runId!,
          sessionId: item.sessionId!, actorId: item.requestActorId!, capabilityId: item.capabilityId!, paths: item.paths!,
          arguments: JSON.parse(item.normalizedArgs!), policy: item.policy!
        })
        return request.scopeFingerprint === item.scopeFingerprint && request.requestFingerprint === item.requestFingerprint
      } catch { return false }
    })()
}
