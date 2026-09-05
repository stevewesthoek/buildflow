import crypto from 'node:crypto'
import {
  EXTERNAL_MCP_LIMITS,
  externalMcpManifestDigest,
  listExternalMcpCredentialBindings,
  mutateExternalMcpIntakeStore,
  type ExternalMcpCredentialBinding,
  type ExternalMcpCredentialClass,
  type ExternalMcpCredentialEvidence,
  type ExternalMcpIntakeOptions,
  type ExternalMcpManifest
} from './external-mcp-intake.js'

export const EXTERNAL_MCP_CREDENTIAL_POLICY_VERSION = 'r22.4' as const
export const EXTERNAL_MCP_CREDENTIAL_SOURCE = 'workbench-owned-reference' as const

export type ExternalMcpCredentialEligibilityOutcome =
  | 'CREDENTIAL_ELIGIBLE'
  | 'CREDENTIAL_REQUIRED'
  | 'CREDENTIAL_NOT_FOUND'
  | 'AUDIENCE_MISMATCH'
  | 'SCOPE_MISMATCH'
  | 'CREDENTIAL_TOO_BROAD'
  | 'CREDENTIAL_EXPIRED'
  | 'CREDENTIAL_REVOKED'
  | 'CREDENTIAL_STALE'
  | 'CREDENTIAL_GENERATION_MISMATCH'
  | 'CREDENTIAL_POLICY_DRIFT'
  | 'OWNER_MISMATCH'
  | 'SERVER_BINDING_MISMATCH'
  | 'ENTRY_BINDING_MISMATCH'
  | 'AMBIGUOUS_CREDENTIAL'
  | 'SECRET_POLICY_VIOLATION'
  | 'CREDENTIAL_CLASS_MISMATCH'
  | 'CREDENTIAL_SOURCE_MISMATCH'
  | 'ROTATION_RECONCILIATION_REQUIRED'
  | 'EVIDENCE_PERSISTENCE_FAILED'

export type ExternalMcpCredentialTarget = {
  manifest: ExternalMcpManifest
  manifestId: string
  serverIdentity: string
  entryId: string
  approvalId: string
}

export type ExternalMcpCredentialPolicy = {
  policyVersion: typeof EXTERNAL_MCP_CREDENTIAL_POLICY_VERSION
  bindingId: string
  ownerId: string
  profile: string
  sourceId?: string
  manifestId: string
  serverIdentity: string
  entryId: string
  approvalId: string
  credentialReferenceId: string
  credentialClass: 'external-mcp-oauth'
  credentialSource: typeof EXTERNAL_MCP_CREDENTIAL_SOURCE
  sourceIdentity: string
  requiredAudience: string
  requiredScopes: string[]
  exactScopes: true
  policyDigest: string
}

export type ExternalMcpCredentialPolicyInput = {
  target: ExternalMcpCredentialTarget
  credentialReferenceId: string
  credentialClass: ExternalMcpCredentialClass
  sourceIdentity: string
  requiredAudience: string
  requiredScopes: string[]
  advertisedAudience?: string
  advertisedScopes?: string[]
}

export type ExternalMcpCredentialCandidate = {
  referenceId: string
  sourceIdentity: string
  credentialClass: ExternalMcpCredentialClass
  audience: string
  scopes: string[]
}

export type ExternalMcpCredentialBindingResult = { ok: true; value: ExternalMcpCredentialBinding } | ExternalMcpCredentialFailure
export type ExternalMcpCredentialFailure = { ok: false; outcome: ExternalMcpCredentialEligibilityOutcome; message: string; evidence?: ExternalMcpCredentialEvidence }

export type ExternalMcpCredentialEligibilityInput = {
  policy: ExternalMcpCredentialPolicy
  expectedGeneration: number
  requestedAudience?: string
  requestedScopes?: string[]
  now: string
}

export type ExternalMcpCredentialEligibilityResult =
  | { ok: true; outcome: 'CREDENTIAL_ELIGIBLE'; credentialReferenceId: string; credentialClass: 'external-mcp-oauth'; generation: number; evidence: ExternalMcpCredentialEvidence }
  | ExternalMcpCredentialFailure

export type ExternalMcpCredentialRotationInput = {
  bindingId: string
  expectedGeneration: number
  nextReferenceId: string
  rotationId: string
  reason: string
  now: string
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/
const CREDENTIAL_REFERENCE = /^mcp-credential-ref-[a-z0-9-]{1,96}$/
const SOURCE_IDENTITY = /^workbench-credential-source-[A-Za-z0-9._:-]{1,128}$/
const BINDING_ID = /^mcp-credential-binding-[a-f0-9]{64}$/
const APPROVAL_ID = /^mcp-approval-[a-f0-9]{64}$/
const MANIFEST_ID = /^mcp-manifest-[a-f0-9]{64}$/
const ENTRY_ID = /^mcp-entry-[a-f0-9]{64}$/
const ROTATION_ID = /^mcp-rotation-[A-Za-z0-9._:-]{1,128}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const SCOPE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/
const CREDENTIAL_CLASSES: readonly ExternalMcpCredentialClass[] = ['external-mcp-oauth', 'workbench-action', 'workbench-mcp-local', 'provider', 'git', 'ssh']

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[] = []): boolean {
  return Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key))
}
function text(value: unknown, max = 256): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0\r\n]/.test(value) }
function authority(value: unknown): value is string { return text(value, 256) && !/[\s,;]/.test(value) }
function iso(value: unknown): value is string { return typeof value === 'string' && ISO.test(value) && Number.isFinite(Date.parse(value)) }
function sortedScopes(value: readonly string[]): string[] { return [...value].sort() }
function validScopes(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= EXTERNAL_MCP_LIMITS.maxCredentialScopes
    && value.every(item => text(item, EXTERNAL_MCP_LIMITS.maxStringBytes) && SCOPE.test(item))
    && new Set(value).size === value.length
    && JSON.stringify(value) === JSON.stringify(sortedScopes(value))
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`
}
function digest(value: unknown): string { return crypto.createHash('sha256').update(canonical(value), 'utf8').digest('hex') }
function fail(outcome: ExternalMcpCredentialEligibilityOutcome, message: string, evidence?: ExternalMcpCredentialEvidence): ExternalMcpCredentialFailure { return { ok: false, outcome, message, ...(evidence ? { evidence } : {}) } }
function storeFailure(code: 'persistence_failed' | 'credential_conflict' | 'credential_ambiguous', message: string): { ok: false; code: typeof code; message: string } { return { ok: false, code, message } }
function validPolicyShape(value: unknown): value is ExternalMcpCredentialPolicy {
  return record(value) && exactKeys(value, ['policyVersion', 'bindingId', 'ownerId', 'profile', 'sourceId', 'manifestId', 'serverIdentity', 'entryId', 'approvalId', 'credentialReferenceId', 'credentialClass', 'credentialSource', 'sourceIdentity', 'requiredAudience', 'requiredScopes', 'exactScopes', 'policyDigest'], ['policyVersion', 'bindingId', 'ownerId', 'profile', 'manifestId', 'serverIdentity', 'entryId', 'approvalId', 'credentialReferenceId', 'credentialClass', 'credentialSource', 'sourceIdentity', 'requiredAudience', 'requiredScopes', 'exactScopes', 'policyDigest'])
    && value.policyVersion === EXTERNAL_MCP_CREDENTIAL_POLICY_VERSION
    && BINDING_ID.test(String(value.bindingId))
    && validScopes(value.requiredScopes)
    && value.credentialClass === 'external-mcp-oauth'
    && value.credentialSource === EXTERNAL_MCP_CREDENTIAL_SOURCE
    && CREDENTIAL_REFERENCE.test(String(value.credentialReferenceId))
    && SOURCE_IDENTITY.test(String(value.sourceIdentity))
    && authority(value.requiredAudience)
    && value.exactScopes === true
    && text(value.ownerId) && text(value.profile) && text(value.manifestId) && text(value.serverIdentity) && text(value.entryId) && text(value.approvalId) && /^[a-f0-9]{64}$/.test(String(value.policyDigest))
}
function targetEntry(target: ExternalMcpCredentialTarget): ExternalMcpManifest['entries'][number] | undefined { return target.manifest.entries.find(entry => entry.entryId === target.entryId) }
function targetIssue(target: ExternalMcpCredentialTarget): ExternalMcpCredentialFailure | undefined {
  if (!record(target) || !record(target.manifest) || target.manifestId !== target.manifest.manifestId || target.serverIdentity !== target.manifest.server.serverIdentity || target.manifest.policy.credentialAudiencePolicyRef !== 'workbench-owned-r22.4') return fail('CREDENTIAL_POLICY_DRIFT', 'External MCP credential policy is not bound to the current Workbench manifest policy.')
  if (externalMcpManifestDigest(Object.fromEntries(Object.entries(target.manifest).filter(([key]) => key !== 'manifestDigest')) as Omit<ExternalMcpManifest, 'manifestDigest'>) !== target.manifest.manifestDigest) return fail('CREDENTIAL_POLICY_DRIFT', 'External MCP manifest integrity does not match its pinned digest.')
  const entry = targetEntry(target)
  if (!entry || entry.approval.state !== 'approved' || entry.lifecycle !== 'approved' || entry.approval.approvalId !== target.approvalId) return fail('ENTRY_BINDING_MISMATCH', 'External MCP credential binding requires one exact approved manifest entry.')
  return undefined
}
function validatePolicyInput(input: ExternalMcpCredentialPolicyInput): ExternalMcpCredentialFailure | undefined {
  if (!record(input) || !exactKeys(input, ['target', 'credentialReferenceId', 'credentialClass', 'sourceIdentity', 'requiredAudience', 'requiredScopes', 'advertisedAudience', 'advertisedScopes'], ['target', 'credentialReferenceId', 'credentialClass', 'sourceIdentity', 'requiredAudience', 'requiredScopes'])) return fail('SECRET_POLICY_VIOLATION', 'Credential policy input contains unsupported or secret-like fields.')
  const issue = targetIssue(input.target); if (issue) return issue
  if (input.credentialClass !== 'external-mcp-oauth') return fail('CREDENTIAL_CLASS_MISMATCH', 'Only the explicit external-mcp-oauth credential class may cross the external MCP boundary.')
  if (!CREDENTIAL_REFERENCE.test(input.credentialReferenceId) || !SOURCE_IDENTITY.test(input.sourceIdentity)) return fail('CREDENTIAL_SOURCE_MISMATCH', 'Credential use requires a Workbench-owned opaque reference and source identity.')
  if (!authority(input.requiredAudience) || !validScopes(input.requiredScopes)) return fail('CREDENTIAL_POLICY_DRIFT', 'Credential audience or scope policy is invalid or ambiguous.')
  if (input.advertisedAudience !== undefined && input.advertisedAudience !== input.requiredAudience) return fail('AUDIENCE_MISMATCH', 'Server OAuth metadata cannot replace the Workbench-pinned audience.')
  if (input.advertisedScopes !== undefined && (!validScopes(input.advertisedScopes) || JSON.stringify(sortedScopes(input.advertisedScopes)) !== JSON.stringify(input.requiredScopes))) return fail('SCOPE_MISMATCH', 'Server OAuth metadata cannot widen or replace the Workbench-pinned scope set.')
  return undefined
}

export function createExternalMcpCredentialPolicy(input: ExternalMcpCredentialPolicyInput): { ok: true; value: ExternalMcpCredentialPolicy } | ExternalMcpCredentialFailure {
  const issue = validatePolicyInput(input); if (issue) return issue
  const target = input.target
  const material = { policyVersion: EXTERNAL_MCP_CREDENTIAL_POLICY_VERSION, ownerId: target.manifest.owner.ownerId, profile: target.manifest.owner.profile, ...(target.manifest.owner.sourceId ? { sourceId: target.manifest.owner.sourceId } : {}), manifestId: target.manifest.manifestId, serverIdentity: target.manifest.server.serverIdentity, entryId: target.entryId, approvalId: target.approvalId, credentialReferenceId: input.credentialReferenceId, credentialClass: 'external-mcp-oauth' as const, credentialSource: EXTERNAL_MCP_CREDENTIAL_SOURCE, sourceIdentity: input.sourceIdentity, requiredAudience: input.requiredAudience, requiredScopes: sortedScopes(input.requiredScopes), exactScopes: true as const }
  const policyDigest = digest(material)
  return { ok: true, value: { ...material, bindingId: `mcp-credential-binding-${policyDigest}`, policyDigest } }
}

function bindingMatchesPolicy(binding: ExternalMcpCredentialBinding, policy: ExternalMcpCredentialPolicy): ExternalMcpCredentialEligibilityOutcome | undefined {
  if (binding.ownerId !== policy.ownerId || binding.profile !== policy.profile || binding.sourceId !== policy.sourceId) return 'OWNER_MISMATCH'
  if (binding.manifestId !== policy.manifestId || binding.serverIdentity !== policy.serverIdentity) return 'SERVER_BINDING_MISMATCH'
  if (binding.entryId !== policy.entryId || binding.approvalId !== policy.approvalId) return 'ENTRY_BINDING_MISMATCH'
  if (binding.bindingId !== policy.bindingId || binding.policyVersion !== policy.policyVersion || binding.credential.source !== EXTERNAL_MCP_CREDENTIAL_SOURCE || binding.credential.sourceIdentity !== policy.sourceIdentity || binding.credential.credentialClass !== policy.credentialClass || binding.policy.credentialReferenceId !== policy.credentialReferenceId || binding.policy.credentialClass !== policy.credentialClass || binding.policy.sourceIdentity !== policy.sourceIdentity || binding.policy.requiredAudience !== policy.requiredAudience || JSON.stringify(binding.policy.requiredScopes) !== JSON.stringify(policy.requiredScopes) || binding.policy.exactScopes !== true) return 'CREDENTIAL_POLICY_DRIFT'
  return undefined
}
function evidenceFor(binding: ExternalMcpCredentialBinding, outcome: ExternalMcpCredentialEligibilityOutcome, reason: string, now: string): ExternalMcpCredentialEvidence {
  const current = binding.credential
  const expiryState: ExternalMcpCredentialEvidence['expiryState'] = !iso(current.expiresAt) ? 'unknown' : Date.parse(current.expiresAt) <= Date.parse(now) ? 'expired' : 'active'
  const rotationIdentity = binding.rotationLineage.at(-1)?.rotationId
  const material = { outcome, bindingId: binding.bindingId, ownerId: binding.ownerId, profile: binding.profile, ...(binding.sourceId ? { sourceId: binding.sourceId } : {}), manifestId: binding.manifestId, serverIdentity: binding.serverIdentity, entryId: binding.entryId, approvalId: binding.approvalId, credentialReferenceId: current.referenceId, credentialClass: current.credentialClass, audience: current.audience, scopes: current.scopes, generation: current.generation, expiryState, revocationState: current.state, ...(rotationIdentity ? { rotationIdentity } : {}), policyVersion: EXTERNAL_MCP_CREDENTIAL_POLICY_VERSION, reason }
  return { evidenceId: `mcp-credential-evidence-${digest(material)}`, ...material, recordedAt: now }
}
function recordEvidence(store: { credentialEvidence?: ExternalMcpCredentialEvidence[] }, evidence: ExternalMcpCredentialEvidence): void {
  const existing = store.credentialEvidence ?? []
  if (!existing.some(item => item.evidenceId === evidence.evidenceId)) existing.push(evidence)
  store.credentialEvidence = existing.slice(-EXTERNAL_MCP_LIMITS.maxCredentialEvidence)
}

export function bindExternalMcpCredential(input: { policy: ExternalMcpCredentialPolicy; target: ExternalMcpCredentialTarget; expiresAt: string; now: string; credentialCandidate?: ExternalMcpCredentialCandidate }, options: ExternalMcpIntakeOptions & { ownerId: string }): ExternalMcpCredentialBindingResult {
  if (!record(input) || !exactKeys(input, ['policy', 'target', 'expiresAt', 'now', 'credentialCandidate'], ['policy', 'target', 'expiresAt', 'now']) || !iso(input.expiresAt) || !iso(input.now) || Date.parse(input.expiresAt) <= Date.parse(input.now)) return fail('CREDENTIAL_POLICY_DRIFT', 'Credential expiry must be known, canonical, and in the future.')
  const policy = input.policy
  if (!validPolicyShape(policy) || policy.bindingId !== `mcp-credential-binding-${policy.policyDigest}`) return fail('CREDENTIAL_POLICY_DRIFT', 'Credential policy is malformed or not Workbench-owned.')
  const targetProblem = targetIssue(input.target); if (targetProblem) return targetProblem
  if (policy.ownerId !== input.target.manifest.owner.ownerId || policy.profile !== input.target.manifest.owner.profile || policy.sourceId !== input.target.manifest.owner.sourceId || policy.manifestId !== input.target.manifest.manifestId || policy.serverIdentity !== input.target.manifest.server.serverIdentity || policy.entryId !== input.target.entryId || policy.approvalId !== input.target.approvalId) return fail('CREDENTIAL_POLICY_DRIFT', 'Credential policy does not match the exact approved Workbench MCP target.')
  if (policy.ownerId !== options.ownerId) return fail('OWNER_MISMATCH', 'Credential policy owner does not match the owner-local store.')
  if (input.credentialCandidate !== undefined) {
    const candidate = input.credentialCandidate
    if (!record(candidate) || !exactKeys(candidate, ['referenceId', 'sourceIdentity', 'credentialClass', 'audience', 'scopes'], ['referenceId', 'sourceIdentity', 'credentialClass', 'audience', 'scopes']) || !CREDENTIAL_REFERENCE.test(candidate.referenceId) || !SOURCE_IDENTITY.test(candidate.sourceIdentity) || !CREDENTIAL_CLASSES.includes(candidate.credentialClass) || !authority(candidate.audience) || !validScopes(candidate.scopes)) return fail('SECRET_POLICY_VIOLATION', 'Credential candidate contains unsupported or secret-like material.')
    if (candidate.referenceId !== policy.credentialReferenceId || candidate.sourceIdentity !== policy.sourceIdentity) return fail('CREDENTIAL_SOURCE_MISMATCH', 'Credential candidate source is not the Workbench-pinned source.')
    if (candidate.credentialClass !== policy.credentialClass) return fail('CREDENTIAL_CLASS_MISMATCH', 'Credential candidate class is not the Workbench-pinned external MCP class.')
    if (candidate.audience !== policy.requiredAudience) return fail('AUDIENCE_MISMATCH', 'Credential candidate audience does not match the Workbench-pinned audience.')
    if (candidate.scopes.some(scope => !policy.requiredScopes.includes(scope))) return fail('CREDENTIAL_TOO_BROAD', 'Credential candidate contains broader scopes than the approved minimum.')
    if (candidate.scopes.length !== policy.requiredScopes.length) return fail('SCOPE_MISMATCH', 'Credential candidate is missing an approved scope.')
  }
  const binding: ExternalMcpCredentialBinding = { schemaVersion: 1, bindingId: policy.bindingId, policyVersion: EXTERNAL_MCP_CREDENTIAL_POLICY_VERSION, ownerId: policy.ownerId, profile: policy.profile, ...(policy.sourceId ? { sourceId: policy.sourceId } : {}), manifestId: policy.manifestId, serverIdentity: policy.serverIdentity, entryId: policy.entryId, approvalId: policy.approvalId, credential: { referenceId: policy.credentialReferenceId, source: EXTERNAL_MCP_CREDENTIAL_SOURCE, sourceIdentity: policy.sourceIdentity, credentialClass: policy.credentialClass, audience: policy.requiredAudience, scopes: [...policy.requiredScopes], generation: 1, state: 'active', expiresAt: input.expiresAt }, policy: { credentialReferenceId: policy.credentialReferenceId, credentialClass: policy.credentialClass, sourceIdentity: policy.sourceIdentity, requiredAudience: policy.requiredAudience, requiredScopes: [...policy.requiredScopes], exactScopes: true }, rotationLineage: [], createdAt: input.now, updatedAt: input.now }
  const result = mutateExternalMcpIntakeStore(options.ownerId, options, store => {
    const bindings = store.credentialBindings ?? []
    const duplicateReference = bindings.find(item => item.credential.referenceId === binding.credential.referenceId && item.bindingId !== binding.bindingId)
    if (duplicateReference) return storeFailure('credential_ambiguous', 'Opaque credential reference is already bound to another exact MCP identity.')
    const existing = bindings.find(item => item.bindingId === binding.bindingId)
    if (existing) return JSON.stringify(existing) === JSON.stringify(binding) ? { ok: true, value: { value: existing, updatedAt: store.updatedAt } } : storeFailure('credential_conflict', 'Credential binding identity already exists with different authority.')
    bindings.push(binding); store.credentialBindings = bindings.slice(-EXTERNAL_MCP_LIMITS.maxCredentialBindings); return { ok: true, value: { value: binding, updatedAt: input.now } }
  })
  if (result.ok) return result
  return fail(result.code === 'credential_ambiguous' ? 'AMBIGUOUS_CREDENTIAL' : 'CREDENTIAL_POLICY_DRIFT', result.message)
}

function evaluateWithBinding(binding: ExternalMcpCredentialBinding, input: ExternalMcpCredentialEligibilityInput): { outcome: ExternalMcpCredentialEligibilityOutcome; reason: string } {
  const mismatch = bindingMatchesPolicy(binding, input.policy); if (mismatch) return { outcome: mismatch, reason: `External MCP credential rejected: ${mismatch}.` }
  if (input.requestedAudience !== undefined && input.requestedAudience !== input.policy.requiredAudience) return { outcome: 'AUDIENCE_MISMATCH', reason: 'External MCP credential rejected: AUDIENCE_MISMATCH.' }
  if (input.requestedScopes !== undefined && (!validScopes(input.requestedScopes) || JSON.stringify(sortedScopes(input.requestedScopes)) !== JSON.stringify(input.policy.requiredScopes))) return { outcome: 'SCOPE_MISMATCH', reason: 'External MCP credential rejected: SCOPE_MISMATCH.' }
  const credential = binding.credential
  if (credential.state === 'revoked') return { outcome: 'CREDENTIAL_REVOKED', reason: 'External MCP credential rejected: CREDENTIAL_REVOKED.' }
  if (credential.state === 'retired') return { outcome: 'CREDENTIAL_STALE', reason: 'External MCP credential rejected: CREDENTIAL_STALE.' }
  if (!iso(credential.expiresAt)) return { outcome: 'CREDENTIAL_EXPIRED', reason: 'External MCP credential rejected: CREDENTIAL_EXPIRED.' }
  if (Date.parse(credential.expiresAt) <= Date.parse(input.now)) return { outcome: 'CREDENTIAL_EXPIRED', reason: 'External MCP credential rejected: CREDENTIAL_EXPIRED.' }
  if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 1) return { outcome: 'CREDENTIAL_GENERATION_MISMATCH', reason: 'External MCP credential rejected: CREDENTIAL_GENERATION_MISMATCH.' }
  if (credential.generation !== input.expectedGeneration) return { outcome: 'CREDENTIAL_STALE', reason: 'External MCP credential rejected: CREDENTIAL_STALE.' }
  if (credential.audience !== input.policy.requiredAudience) return { outcome: 'AUDIENCE_MISMATCH', reason: 'External MCP credential rejected: AUDIENCE_MISMATCH.' }
  if (credential.scopes.some(scope => !input.policy.requiredScopes.includes(scope))) return { outcome: 'CREDENTIAL_TOO_BROAD', reason: 'External MCP credential rejected: CREDENTIAL_TOO_BROAD.' }
  if (credential.scopes.length !== input.policy.requiredScopes.length) return { outcome: 'SCOPE_MISMATCH', reason: 'External MCP credential rejected: SCOPE_MISMATCH.' }
  return { outcome: 'CREDENTIAL_ELIGIBLE', reason: 'External MCP credential eligible for this exact approved MCP identity.' }
}

export function evaluateExternalMcpCredentialEligibility(input: ExternalMcpCredentialEligibilityInput, options: ExternalMcpIntakeOptions & { ownerId: string }): ExternalMcpCredentialEligibilityResult {
  if (!record(input) || !exactKeys(input, ['policy', 'expectedGeneration', 'requestedAudience', 'requestedScopes', 'now'], ['policy', 'expectedGeneration', 'now']) || !iso(input.now)) return fail('SECRET_POLICY_VIOLATION', 'Credential eligibility input is malformed or contains unsupported authority.')
  if (record(input.policy) && !input.policy.credentialReferenceId) return fail('CREDENTIAL_REQUIRED', 'An approved Workbench-owned external MCP credential reference is required.')
  if (!validPolicyShape(input.policy) || input.policy.ownerId !== options.ownerId) return fail('OWNER_MISMATCH', 'Credential eligibility owner does not match the owner-local authority.')
  const listed = listExternalMcpCredentialBindings({ ...options, ownerId: options.ownerId })
  if (!listed.ok) return fail('CREDENTIAL_NOT_FOUND', 'External MCP credential authority could not be read safely.')
  const binding = listed.value.find(item => item.bindingId === input.policy.bindingId)
  if (!binding) return fail('CREDENTIAL_NOT_FOUND', 'No Workbench-owned credential binding exists for this exact MCP identity.')
  const decision = evaluateWithBinding(binding, input); const evidence = evidenceFor(binding, decision.outcome, decision.reason, input.now)
  const saved = mutateExternalMcpIntakeStore(options.ownerId, options, store => { recordEvidence(store, evidence); return { ok: true, value: { value: true, updatedAt: input.now } } })
  if (!saved.ok) return fail('EVIDENCE_PERSISTENCE_FAILED', 'Credential eligibility evidence could not be persisted safely.')
  if (decision.outcome !== 'CREDENTIAL_ELIGIBLE') return fail(decision.outcome, decision.reason, evidence)
  return { ok: true, outcome: 'CREDENTIAL_ELIGIBLE', credentialReferenceId: binding.credential.referenceId, credentialClass: 'external-mcp-oauth', generation: binding.credential.generation, evidence }
}

export function revokeExternalMcpCredentialBinding(bindingId: string, ownerId: string, now: string, options: ExternalMcpIntakeOptions): ExternalMcpCredentialBindingResult {
  if (!BINDING_ID.test(bindingId) || !iso(now)) return fail('CREDENTIAL_POLICY_DRIFT', 'Credential revocation request is malformed.')
  const result = mutateExternalMcpIntakeStore(ownerId, options, store => { const binding = (store.credentialBindings ?? []).find(item => item.bindingId === bindingId); if (!binding) return storeFailure('credential_conflict', 'Credential binding was not found.'); binding.credential.state = 'revoked'; binding.updatedAt = now; store.updatedAt = now; return { ok: true, value: { value: binding, updatedAt: now } } })
  return result.ok ? result : fail(result.code === 'credential_conflict' ? 'CREDENTIAL_NOT_FOUND' : 'EVIDENCE_PERSISTENCE_FAILED', result.message)
}

export function rotateExternalMcpCredentialBinding(input: ExternalMcpCredentialRotationInput, ownerId: string, options: ExternalMcpIntakeOptions): ExternalMcpCredentialBindingResult {
  if (!record(input) || !exactKeys(input, ['bindingId', 'expectedGeneration', 'nextReferenceId', 'rotationId', 'reason', 'now'], ['bindingId', 'expectedGeneration', 'nextReferenceId', 'rotationId', 'reason', 'now']) || !BINDING_ID.test(input.bindingId) || !CREDENTIAL_REFERENCE.test(input.nextReferenceId) || !ROTATION_ID.test(input.rotationId) || !text(input.reason, EXTERNAL_MCP_LIMITS.maxStringBytes) || !iso(input.now) || !Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 1) return fail('ROTATION_RECONCILIATION_REQUIRED', 'Credential rotation request is malformed or incomplete.')
  const result = mutateExternalMcpIntakeStore(ownerId, options, store => {
    const binding = (store.credentialBindings ?? []).find(item => item.bindingId === input.bindingId)
    if (!binding) return storeFailure('credential_conflict', 'Credential binding was not found.')
    if (binding.credential.state === 'revoked') return storeFailure('credential_conflict', 'Revoked credentials cannot be rotated into eligibility.')
    if (binding.credential.generation !== input.expectedGeneration) return storeFailure('credential_conflict', 'Credential rotation generation is stale.')
    if (binding.rotationLineage.some(item => item.rotationId === input.rotationId)) return storeFailure('credential_conflict', 'Credential rotation identity was already recorded.')
    if ((store.credentialBindings ?? []).some(item => item.credential.referenceId === input.nextReferenceId)) return storeFailure('credential_ambiguous', 'The next opaque credential reference is already bound.')
    const previous = binding.credential
    binding.rotationLineage.push({ rotationId: input.rotationId, previousReferenceId: previous.referenceId, previousGeneration: previous.generation, previousState: 'retired', newGeneration: previous.generation + 1, reason: input.reason, occurredAt: input.now })
    binding.credential = { ...previous, referenceId: input.nextReferenceId, generation: previous.generation + 1, state: 'active' }
    binding.updatedAt = input.now; store.updatedAt = input.now
    return { ok: true, value: { value: binding, updatedAt: input.now } }
  })
  if (result.ok) return result
  if (result.code === 'credential_ambiguous') return fail('AMBIGUOUS_CREDENTIAL', result.message)
  if (result.code === 'credential_conflict' && result.message.includes('revoked')) return fail('CREDENTIAL_REVOKED', result.message)
  if (result.code === 'credential_conflict' && result.message.includes('generation')) return fail('CREDENTIAL_STALE', result.message)
  if (result.code === 'credential_conflict' && result.message.includes('already recorded')) return fail('ROTATION_RECONCILIATION_REQUIRED', result.message)
  if (result.code === 'persistence_failed') return fail('ROTATION_RECONCILIATION_REQUIRED', 'Credential rotation did not commit atomically; the previous generation remains authoritative.')
  return fail(result.code === 'credential_conflict' ? 'CREDENTIAL_NOT_FOUND' : 'EVIDENCE_PERSISTENCE_FAILED', result.message)
}
