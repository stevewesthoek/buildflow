import crypto from 'node:crypto'
import {
  authorizeCapabilityExecution,
  type CapabilityAuthorizedExecutionContext,
  type CapabilityGuardRejection,
  type CapabilityPhase16Context,
  type CapabilityRuntimeContext
} from './capability-runtime-enforcement.js'
import {
  appendExternalMcpPolicyEvidence,
  EXTERNAL_MCP_LIMITS,
  externalMcpManifestDigest,
  type ExternalMcpEntryKind,
  type ExternalMcpIntakeOptions,
  type ExternalMcpJsonObject,
  type ExternalMcpManifest,
  type ExternalMcpPolicyEvidence
} from './external-mcp-intake.js'
import type { CapabilityPermission } from './capability-resolution.js'
import type { CapabilityBudget } from './capability-planning.js'
import type { CapabilityJsonSchema, CapabilityManifest, CapabilityNetworkMethod } from '@workbench/shared'

export const EXTERNAL_MCP_POLICY_ENFORCEMENT_VERSION = 'r22.5' as const
export const EXTERNAL_MCP_POLICY_ENFORCEMENT_SOURCE = 'workbench-owned-r22.5' as const

export type ExternalMcpConfirmationClass = 'NO_CONFIRMATION_REQUIRED' | 'CONFIRMATION_REQUIRED' | 'PROHIBITED'
export type ExternalMcpEffect = 'read' | 'write'
export type ExternalMcpNetworkPolicy = Readonly<{
  mode: 'denied' | 'allowlist'
  allowedTargets: readonly string[]
  allowedMethods: readonly CapabilityNetworkMethod[]
  maxRequests: number
}>
export type ExternalMcpPathPolicy = Readonly<{
  mode: 'none' | 'source-relative' | 'artifact-relative'
  allowedRoots: readonly string[]
  allowedWriteRoots: readonly string[]
  additionalProtectedPaths: readonly string[]
  maxPaths: number
  maxBytes: number
}>

export type ExternalMcpPolicy = Readonly<{
  policyVersion: typeof EXTERNAL_MCP_POLICY_ENFORCEMENT_VERSION
  policyId: string
  policyDigest: string
  ownerId: string
  profile: string
  sourceId?: string
  sessionId?: string
  manifestId: string
  serverIdentity: string
  configuredServerId: string
  configuredEndpointIdentity: string
  transport: ExternalMcpManifest['server']['transport']
  entryId: string
  entryKind: ExternalMcpEntryKind
  approvalId: string
  effect: ExternalMcpEffect
  operation: string
  requiredPermissions: readonly CapabilityPermission[]
  requiredGrantId: string
  requiredPlanId: string
  requiredBudgets: CapabilityBudget
  network: ExternalMcpNetworkPolicy
  path: ExternalMcpPathPolicy
  confirmationClass: ExternalMcpConfirmationClass
  timeoutMs: number
}>

export type ExternalMcpPolicyInput = Omit<ExternalMcpPolicy, 'policyId' | 'policyDigest' | 'policyVersion'>

export type ExternalMcpRequest = Readonly<{
  ownerId: string
  profile: string
  sourceId?: string
  sessionId?: string
  runId: string
  requestId: string
  manifestId: string
  serverIdentity: string
  entryId: string
  approvalId: string
  transportEndpointIdentity: string
  redirectedEndpointIdentity?: string
  arguments: unknown
}>

export type ExternalMcpPolicyAuthorizationInput = Readonly<{
  policy: ExternalMcpPolicy
  manifest: ExternalMcpManifest
  request: ExternalMcpRequest
  phase16: CapabilityPhase16Context
  runtime: CapabilityRuntimeContext
  intakeOptions: ExternalMcpIntakeOptions & { ownerId: string }
  now?: () => Date
  requestedTimeoutMs?: number
}>

export type ExternalMcpPolicyFailureCode =
  | 'POLICY_INVALID'
  | 'MANIFEST_BINDING_MISMATCH'
  | 'ENTRY_BINDING_MISMATCH'
  | 'OWNER_BINDING_MISMATCH'
  | 'SOURCE_SESSION_MISMATCH'
  | 'TRANSPORT_ENDPOINT_MISMATCH'
  | 'REDIRECT_DENIED'
  | 'EFFECT_MISMATCH'
  | 'PLAN_BINDING_MISMATCH'
  | 'POLICY_EVIDENCE_FAILED'
  | CapabilityGuardRejection['code']

export type ExternalMcpPolicyEvidenceResult = ExternalMcpPolicyEvidence
export type ExternalMcpPolicyAuthorizationResult =
  | Readonly<{ ok: true; value: { requestDigest: string; policyDigest: string; transportEndpointIdentity: string; authorized: CapabilityAuthorizedExecutionContext; evidence: ExternalMcpPolicyEvidenceResult } }>
  | Readonly<{ ok: false; code: ExternalMcpPolicyFailureCode; message: string; evidence?: ExternalMcpPolicyEvidenceResult }>

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/
const SHA256 = /^[a-f0-9]{64}$/
const METHODS: readonly CapabilityNetworkMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
const PERMISSIONS: readonly CapabilityPermission[] = ['read', 'write', 'command', 'git', 'network', 'capability']
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const MAX_STRING = 512

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function bounded(value: unknown, max = MAX_STRING): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0\r\n]/.test(value) }
function iso(value: unknown): value is string { return typeof value === 'string' && ISO.test(value) && Number.isFinite(Date.parse(value)) }
function sortedUnique(values: readonly string[]): string[] { return [...new Set(values)].sort() }
function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)) }
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`
}
function digest(value: unknown): string { return crypto.createHash('sha256').update(canonical(value), 'utf8').digest('hex') }
function reject(code: ExternalMcpPolicyFailureCode, message: string): { ok: false; code: ExternalMcpPolicyFailureCode; message: string } { return { ok: false, code, message } }
function entryFor(manifest: ExternalMcpManifest, entryId: string) { return manifest.entries.find(entry => entry.entryId === entryId) }

function validNetwork(value: unknown): value is ExternalMcpNetworkPolicy {
  if (!record(value) || !['denied', 'allowlist'].includes(String(value.mode)) || !Array.isArray(value.allowedTargets) || !Array.isArray(value.allowedMethods) || !Number.isSafeInteger(value.maxRequests) || Number(value.maxRequests) < 0 || value.allowedTargets.some(item => !bounded(item)) || value.allowedMethods.some(item => !METHODS.includes(item as CapabilityNetworkMethod))) return false
  const maxRequests = Number(value.maxRequests)
  if (maxRequests > 100) return false
  return value.mode === 'denied' ? value.allowedTargets.length === 0 && value.allowedMethods.length === 0 && maxRequests === 0 : value.allowedTargets.length > 0 && value.allowedMethods.length > 0 && maxRequests > 0
}
function validPath(value: unknown): value is ExternalMcpPathPolicy {
  return record(value) && ['none', 'source-relative', 'artifact-relative'].includes(String(value.mode)) && Array.isArray(value.allowedRoots) && Array.isArray(value.allowedWriteRoots) && Array.isArray(value.additionalProtectedPaths) && Number.isSafeInteger(value.maxPaths) && Number(value.maxPaths) >= 0 && Number(value.maxPaths) <= 32 && Number.isSafeInteger(value.maxBytes) && Number(value.maxBytes) >= 0 && Number(value.maxBytes) <= 16 * 1024 * 1024 && [...value.allowedRoots, ...value.allowedWriteRoots, ...value.additionalProtectedPaths].every(item => bounded(item, 1024))
}
function validPolicyInput(input: ExternalMcpPolicyInput): boolean {
  return record(input) && exactKeys(input, ['ownerId', 'profile', 'sourceId', 'sessionId', 'manifestId', 'serverIdentity', 'configuredServerId', 'configuredEndpointIdentity', 'transport', 'entryId', 'entryKind', 'approvalId', 'effect', 'operation', 'requiredPermissions', 'requiredGrantId', 'requiredPlanId', 'requiredBudgets', 'network', 'path', 'confirmationClass', 'timeoutMs']) && bounded(input.ownerId) && bounded(input.profile) && (input.sourceId === undefined || bounded(input.sourceId)) && (input.sessionId === undefined || bounded(input.sessionId)) && /^mcp-manifest-[a-f0-9]{64}$/.test(input.manifestId) && bounded(input.serverIdentity) && IDENTIFIER.test(input.configuredServerId) && bounded(input.configuredEndpointIdentity, 2_000) && ['stdio', 'sse', 'streamable-http'].includes(input.transport) && /^mcp-entry-[a-f0-9]{64}$/.test(input.entryId) && ['tool', 'resource'].includes(input.entryKind) && /^mcp-approval-[a-f0-9]{64}$/.test(input.approvalId) && ['read', 'write'].includes(input.effect) && bounded(input.operation) && Array.isArray(input.requiredPermissions) && input.requiredPermissions.length > 0 && sortedUnique(input.requiredPermissions).length === input.requiredPermissions.length && input.requiredPermissions.every(item => PERMISSIONS.includes(item)) && bounded(input.requiredGrantId) && bounded(input.requiredPlanId) && record(input.requiredBudgets) && Object.values(input.requiredBudgets).every(value => Number.isSafeInteger(value) && Number(value) >= 0) && Number(input.requiredBudgets.maximumBytes) <= 64 * 1024 && Number(input.requiredBudgets.maximumDurationMs) <= EXTERNAL_MCP_LIMITS.maxTimeoutMs && Number(input.requiredBudgets.maximumQueries) <= 100 && validNetwork(input.network) && validPath(input.path) && ['NO_CONFIRMATION_REQUIRED', 'CONFIRMATION_REQUIRED', 'PROHIBITED'].includes(input.confirmationClass) && Number.isSafeInteger(input.timeoutMs) && input.timeoutMs > 0 && input.timeoutMs <= EXTERNAL_MCP_LIMITS.maxTimeoutMs
}
function policyMaterial(input: ExternalMcpPolicyInput): ExternalMcpPolicyInput { return { ...input, requiredPermissions: sortedUnique(input.requiredPermissions) as CapabilityPermission[], network: { ...input.network, allowedTargets: sortedUnique(input.network.allowedTargets), allowedMethods: [...input.network.allowedMethods].sort() }, path: { ...input.path, allowedRoots: sortedUnique(input.path.allowedRoots), allowedWriteRoots: sortedUnique(input.path.allowedWriteRoots), additionalProtectedPaths: sortedUnique(input.path.additionalProtectedPaths) } } }

export function createExternalMcpPolicy(input: ExternalMcpPolicyInput): { ok: true; value: ExternalMcpPolicy } | { ok: false; code: 'POLICY_INVALID' | 'MANIFEST_BINDING_MISMATCH' | 'ENTRY_BINDING_MISMATCH'; message: string } {
  if (!validPolicyInput(input)) return { ok: false, code: 'POLICY_INVALID', message: 'R22.5 policy is malformed, unbounded, or contains an unsupported authority.' }
  const material = policyMaterial(input)
  const policyDigest = digest({ policyVersion: EXTERNAL_MCP_POLICY_ENFORCEMENT_VERSION, ...material })
  return { ok: true, value: { ...material, policyVersion: EXTERNAL_MCP_POLICY_ENFORCEMENT_VERSION, policyId: `mcp-policy-${policyDigest}`, policyDigest } }
}

function manifestIntegrity(manifest: ExternalMcpManifest): boolean {
  const withoutDigest = { ...manifest }
  delete (withoutDigest as Partial<ExternalMcpManifest>).manifestDigest
  return externalMcpManifestDigest(withoutDigest as Omit<ExternalMcpManifest, 'manifestDigest'>) === manifest.manifestDigest
}
function targetFailure(input: ExternalMcpPolicyAuthorizationInput): { code: ExternalMcpPolicyFailureCode; message: string } | undefined {
  const { policy, manifest, request } = input
  if (!manifestIntegrity(manifest) || manifest.manifestId !== policy.manifestId || policy.manifestId !== request.manifestId || manifest.server.serverIdentity !== policy.serverIdentity || policy.serverIdentity !== request.serverIdentity || manifest.server.configuredServerId !== policy.configuredServerId || manifest.server.configuredEndpointIdentity !== policy.configuredEndpointIdentity || manifest.server.transport !== policy.transport) return { code: 'MANIFEST_BINDING_MISMATCH', message: 'R22.5 request is not bound to the exact Workbench-approved manifest and configured transport authority.' }
  if (manifest.policy.networkPolicyRef !== EXTERNAL_MCP_POLICY_ENFORCEMENT_SOURCE || manifest.policy.pathPolicyRef !== EXTERNAL_MCP_POLICY_ENFORCEMENT_SOURCE || manifest.policy.confirmationPolicyRef !== EXTERNAL_MCP_POLICY_ENFORCEMENT_SOURCE) return { code: 'MANIFEST_BINDING_MISMATCH', message: 'External MCP manifest has not crossed the Workbench-owned R22.5 policy boundary.' }
  const entry = entryFor(manifest, policy.entryId)
  if (!entry || entry.kind !== policy.entryKind || entry.approval.state !== 'approved' || entry.lifecycle !== 'approved' || entry.approval.approvalId !== policy.approvalId || entry.executionAuthority !== 'none' || request.entryId !== policy.entryId || request.approvalId !== policy.approvalId) return { code: 'ENTRY_BINDING_MISMATCH', message: 'R22.5 requires one exact approved entry and approval identity; no wildcard or server-selected entry is accepted.' }
  if (manifest.owner.ownerId !== policy.ownerId || manifest.owner.profile !== policy.profile || request.ownerId !== policy.ownerId || request.profile !== policy.profile) return { code: 'OWNER_BINDING_MISMATCH', message: 'R22.5 owner/profile identity does not match the approved manifest policy.' }
  if (manifest.owner.sourceId !== policy.sourceId || manifest.owner.sessionId !== policy.sessionId || request.sourceId !== policy.sourceId || request.sessionId !== policy.sessionId) return { code: 'SOURCE_SESSION_MISMATCH', message: 'R22.5 source/session identity does not match the approved manifest policy.' }
  if (request.transportEndpointIdentity !== policy.configuredEndpointIdentity) return { code: 'TRANSPORT_ENDPOINT_MISMATCH', message: 'The transport endpoint is not the exact configured Workbench endpoint.' }
  if (request.redirectedEndpointIdentity !== undefined) return { code: 'REDIRECT_DENIED', message: 'Redirects are not an approved transport authority.' }
  if (policy.effect === 'read' && record(request.arguments) && request.arguments.write === true) return { code: 'EFFECT_MISMATCH', message: 'A read-approved external MCP entry cannot receive a write request.' }
  if (!input.phase16.plan || input.phase16.plan.planId !== policy.requiredPlanId || input.phase16.plan.auditIdentity.grantId !== policy.requiredGrantId || input.phase16.plan.providerId !== policy.serverIdentity || input.phase16.plan.capabilityId !== policy.entryId || input.phase16.plan.requestedOperation !== policy.operation || input.phase16.plan.requiredPermissions.join(',') !== policy.requiredPermissions.join(',')) return { code: 'PLAN_BINDING_MISMATCH', message: 'The current capability plan/grant intersection is not the exact R22.5 policy binding.' }
  return undefined
}

function networkClaims(value: unknown): Array<{ target: string; method: CapabilityNetworkMethod }> {
  if (!record(value)) return []
  const claims: Array<{ target: string; method: CapabilityNetworkMethod }> = []
  const add = (target: unknown, method: unknown): void => {
    if (typeof target !== 'string') return
    const normalized = typeof method === 'string' ? method.toUpperCase() : 'GET'
    if (METHODS.includes(normalized as CapabilityNetworkMethod)) claims.push({ target, method: normalized as CapabilityNetworkMethod })
  }
  add(value.networkTarget, value.networkMethod)
  if (typeof value.network === 'string') add(value.network, value.networkMethod)
  if (record(value.network)) add(value.network.target, value.network.method)
  if (Array.isArray(value.networkRequests)) for (const item of value.networkRequests) if (record(item)) add(item.target, item.method)
  return claims
}
function networkTargetFailure(input: ExternalMcpPolicyAuthorizationInput): { code: ExternalMcpPolicyFailureCode; message: string } | undefined {
  const claims = networkClaims(input.request.arguments)
  if (claims.length === 0) return undefined
  if (input.policy.network.mode === 'denied') return { code: 'network_not_allowed', message: 'The Workbench-owned R22.5 policy denies tool network access.' }
  if (claims.length > input.policy.network.maxRequests) return { code: 'network_not_allowed', message: 'The external MCP request exceeds the Workbench-owned network request budget.' }
  if (claims.some(claim => !input.policy.network.allowedTargets.includes(claim.target) || !input.policy.network.allowedMethods.includes(claim.method))) return { code: 'network_not_allowed', message: 'The external MCP request target or method is not an exact Workbench-approved network binding.' }
  return undefined
}

function emptySchema(): CapabilityJsonSchema { return { type: 'object', properties: {}, required: [], additionalProperties: false } }
function capabilityManifest(policy: ExternalMcpPolicy, manifest: ExternalMcpManifest): CapabilityManifest {
  const entry = entryFor(manifest, policy.entryId)!
  const requestSchema = (entry.pinnedRequestSchema as unknown as CapabilityJsonSchema | undefined) ?? emptySchema()
  const resultSchema = (entry.pinnedResultSchema as unknown as CapabilityJsonSchema | undefined) ?? emptySchema()
  const pathMode = policy.path.mode
  return {
    kind: 'workbench.capability.manifest', manifestVersion: 1, id: policy.entryId, version: entry.compatibilityVersion, name: entry.canonicalName, description: 'Workbench-owned external MCP policy projection.', inputSchema: requestSchema, outputSchema: resultSchema,
    pathPolicy: { mode: pathMode, allowedRoots: policy.path.allowedRoots, protectedPaths: 'workbench-default-plus', additionalProtectedPaths: policy.path.additionalProtectedPaths, maxPaths: policy.path.maxPaths, maxBytes: policy.path.maxBytes },
    cwdPolicy: { mode: 'none', allowedPaths: [] },
    networkPolicy: policy.network,
    writePolicy: policy.effect === 'write' ? { mode: pathMode === 'artifact-relative' ? 'artifact-only' : 'source-scoped', allowedPaths: policy.path.allowedWriteRoots, maxFiles: policy.path.maxPaths, maxBytes: policy.path.maxBytes } : { mode: 'none', allowedPaths: [], maxFiles: 0, maxBytes: 0 },
    timeout: { defaultMs: policy.timeoutMs, maxMs: policy.timeoutMs }, risk: policy.effect === 'write' || policy.network.mode === 'allowlist' ? 'high' : 'low', confirmation: policy.confirmationClass === 'CONFIRMATION_REQUIRED' ? { mode: 'required', reason: 'Workbench-owned R22.5 policy requires confirmation for this exact external MCP operation.' } : policy.confirmationClass === 'PROHIBITED' ? { mode: 'unavailable', reason: 'Workbench-owned R22.5 policy prohibits this external MCP operation.' } : { mode: 'not_required' }, validation: { mode: 'none', checks: [], verifierIds: [] }, redaction: { mode: 'strict', fields: [], patterns: ['credentials', 'tokens', 'private-keys', 'authorization', 'environment', 'raw-output'], preserveEvidenceReferences: true, inlineSecrets: 'never' }, outputLimits: { maxBytes: 64 * 1024, maxItems: 256, maxInlineBytes: 64 * 1024, overflow: 'evidence-reference' }
  }
}

function evidence(input: ExternalMcpPolicyAuthorizationInput, outcome: string, reason: string, requestDigest: string, recordedAt: string): Omit<ExternalMcpPolicyEvidence, 'evidenceId'> {
  return { outcome, ownerId: input.policy.ownerId, profile: input.policy.profile, ...(input.policy.sourceId ? { sourceId: input.policy.sourceId } : {}), ...(input.policy.sessionId ? { sessionId: input.policy.sessionId } : {}), manifestId: input.policy.manifestId, serverIdentity: input.policy.serverIdentity, entryId: input.policy.entryId, approvalId: input.policy.approvalId, policyDigest: input.policy.policyDigest, requestDigest, effect: input.policy.effect, confirmationClass: input.policy.confirmationClass, reason: reason.slice(0, MAX_STRING), recordedAt }
}
function persistEvidence(input: ExternalMcpPolicyAuthorizationInput, outcome: string, reason: string, requestDigest: string, recordedAt: string): { ok: true; value: ExternalMcpPolicyEvidence } | { ok: false; code: 'POLICY_EVIDENCE_FAILED'; message: string } {
  const result = appendExternalMcpPolicyEvidence(evidence(input, outcome, reason, requestDigest, recordedAt), input.intakeOptions)
  return result.ok ? result : { ok: false, code: 'POLICY_EVIDENCE_FAILED', message: 'R22.5 policy decision evidence could not be persisted atomically.' }
}

export function authorizeExternalMcpRequest(input: ExternalMcpPolicyAuthorizationInput): ExternalMcpPolicyAuthorizationResult {
  const requestDigest = digest({ ownerId: input.request.ownerId, profile: input.request.profile, sourceId: input.request.sourceId ?? null, sessionId: input.request.sessionId ?? null, runId: input.request.runId, requestId: input.request.requestId, manifestId: input.request.manifestId, serverIdentity: input.request.serverIdentity, entryId: input.request.entryId, approvalId: input.request.approvalId, transportEndpointIdentity: input.request.transportEndpointIdentity, redirectedEndpointIdentity: input.request.redirectedEndpointIdentity ?? null, arguments: input.request.arguments })
  const at = (input.now ?? (() => new Date()))().toISOString()
  if (!iso(at)) return reject('POLICY_INVALID', 'R22.5 decision timestamp is not canonical.')
  const policyMaterialValue = { ...input.policy } as Record<string, unknown>
  delete policyMaterialValue.policyId; delete policyMaterialValue.policyDigest; delete policyMaterialValue.policyVersion
  const recreated = createExternalMcpPolicy(policyMaterialValue as unknown as ExternalMcpPolicyInput)
  if (!recreated.ok || recreated.value.policyDigest !== input.policy.policyDigest || recreated.value.policyId !== input.policy.policyId) return reject('POLICY_INVALID', 'R22.5 policy digest or identity does not match its Workbench-owned material.')
  const target = targetFailure(input)
  if (target) {
    const saved = persistEvidence(input, target.code, target.message, requestDigest, at)
    return saved.ok ? { ...reject(target.code, target.message), evidence: saved.value } : saved
  }
  if (input.policy.confirmationClass === 'PROHIBITED') {
    const saved = persistEvidence(input, 'PROHIBITED', 'R22.5 policy prohibits this exact external MCP operation.', requestDigest, at)
    return saved.ok ? { ...reject('phase16_policy_denied', 'R22.5 policy prohibits this exact external MCP operation.'), evidence: saved.value } : saved
  }
  const networkTarget = networkTargetFailure(input)
  if (networkTarget) {
    const saved = persistEvidence(input, networkTarget.code, networkTarget.message, requestDigest, at)
    return saved.ok ? { ...reject(networkTarget.code, networkTarget.message), evidence: saved.value } : saved
  }
  const manifest = capabilityManifest(input.policy, input.manifest)
  const guard = authorizeCapabilityExecution({ manifest, arguments: input.request.arguments, identity: { sourceId: input.request.sourceId ?? 'external-mcp-source', sessionId: input.request.sessionId ?? 'external-mcp-session', runId: input.request.runId, requestId: input.request.requestId, capabilityId: input.policy.entryId, capabilityVersion: entryFor(input.manifest, input.policy.entryId)!.compatibilityVersion, providerId: input.policy.serverIdentity, bindingId: input.policy.policyId }, phase16: input.phase16, capability: input.runtime, now: input.now, requestedTimeoutMs: input.requestedTimeoutMs })
  if (!guard.ok) {
    const saved = persistEvidence(input, guard.code, guard.message, requestDigest, at)
    return saved.ok ? { ...guard, evidence: saved.value } : saved
  }
  const saved = persistEvidence(input, 'AUTHORIZED', 'R22.5 policy, exact target, plan/grant, and existing runtime guards allowed the request.', requestDigest, at)
  return saved.ok ? { ok: true, value: { requestDigest, policyDigest: input.policy.policyDigest, transportEndpointIdentity: input.policy.configuredEndpointIdentity, authorized: guard.value, evidence: saved.value } } : saved
}
