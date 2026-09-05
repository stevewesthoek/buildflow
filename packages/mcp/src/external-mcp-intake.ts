import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const EXTERNAL_MCP_INTAKE_VERSION = 1 as const
export const EXTERNAL_MCP_INTAKE_KIND = 'workbench.external-mcp.manifest' as const
export const EXTERNAL_MCP_INTAKE_STORE_VERSION = 1 as const
export const EXTERNAL_MCP_INTAKE_STORE_FILENAME = 'workbench-external-mcp-intake.json' as const
export const EXTERNAL_MCP_POLICY_VERSION = 'r22.1' as const

export const EXTERNAL_MCP_LIMITS = {
  maxServerReferenceBytes: 2_048,
  maxMetadataBytes: 64 * 1024,
  maxTools: 64,
  maxResources: 64,
  maxNameBytes: 256,
  maxDescriptionBytes: 4_096,
  maxSchemaBytes: 16 * 1024,
  maxSchemaDepth: 8,
  maxSchemaNodes: 256,
  maxSchemaProperties: 64,
  maxRequestBytes: 64 * 1024,
  maxResultBytes: 64 * 1024,
  maxMetadataDepth: 8,
  maxStringBytes: 4_096,
  maxEntries: 128,
  maxManifests: 128,
  maxManifestBytes: 256 * 1024,
  maxEvidence: 256,
  maxEvidenceBytes: 8 * 1024,
  maxValidationIssues: 16,
  maxOutputArtifacts: 128,
  maxOutputArtifactBytes: 32 * 1024,
  maxCredentialBindings: 128,
  maxCredentialEvidence: 256,
  maxCredentialEvidenceBytes: 8 * 1024,
  maxPolicyEvidence: 256,
  maxPolicyEvidenceBytes: 8 * 1024,
  maxBrokerExecutions: 256,
  maxBrokerExecutionBytes: 24 * 1024,
  maxCredentialScopes: 16,
  maxTimeoutMs: 300_000,
  maxScopes: 16
} as const

export type ExternalMcpTransport = 'stdio' | 'sse' | 'streamable-http'
export type ExternalMcpEntryKind = 'tool' | 'resource'
export type ExternalMcpEntryApprovalState = 'pending' | 'approved' | 'rejected' | 'revoked'
export type ExternalMcpEntryLifecycle = 'candidate' | 'approved' | 'drifted' | 'unavailable' | 'removed'
export type ExternalMcpManifestLifecycle = 'candidate' | 'approved_entries' | 'drifted' | 'unavailable'

export type ExternalMcpJsonValue = null | boolean | number | string | ExternalMcpJsonObject | ExternalMcpJsonValue[]
export type ExternalMcpJsonObject = { [key: string]: ExternalMcpJsonValue }

export type ExternalMcpServerReference = {
  serverId: string
  transport: ExternalMcpTransport
  endpoint: string
  ownerId: string
  profile: string
  sourceId?: string
  sessionId?: string
  compatibilityVersion: string
}

export type ExternalMcpSafetyHints = {
  safe?: boolean
  readOnly?: boolean
  destructive?: boolean
  trusted?: boolean
  requiresConfirmation?: boolean
}

export type ExternalMcpAuthenticationHints = {
  required: boolean
  audience?: string
  scopes?: string[]
}

export type ExternalMcpStaticServer = {
  claimedId: string
  protocolVersion: string
  displayName?: string
  description?: string
  endpointHint?: string
  transportHint?: ExternalMcpTransport
  authentication?: ExternalMcpAuthenticationHints
  safety?: ExternalMcpSafetyHints
  identityClaims?: string[]
}

export type ExternalMcpToolAdvertisement = {
  name: string
  description?: string
  inputSchema: ExternalMcpJsonObject
  resultSchema?: ExternalMcpJsonObject
  compatibilityVersion?: string
  safety?: ExternalMcpSafetyHints
}

export type ExternalMcpResourceAdvertisement = {
  uri: string
  name?: string
  description?: string
  mimeType?: string
  resultSchema?: ExternalMcpJsonObject
  compatibilityVersion?: string
}

export type ExternalMcpStaticDiscoverySnapshot = {
  server: ExternalMcpStaticServer
  tools: ExternalMcpToolAdvertisement[]
  resources: ExternalMcpResourceAdvertisement[]
  discoveredAt: string
}

export type ExternalMcpPolicyBinding = {
  policyVersion: typeof EXTERNAL_MCP_POLICY_VERSION
  allowedProfile: string
  capabilityClass: 'unassigned'
  networkPolicyRef: 'workbench-owned-r22.5'
  pathPolicyRef: 'workbench-owned-r22.5'
  confirmationPolicyRef: 'workbench-owned-r22.5'
  credentialAudiencePolicyRef: 'workbench-owned-r22.4'
  inputLimits: { maxBytes: number; maxItems: number; maxDepth: number; timeoutMs: number }
  outputLimits: { maxBytes: number; maxItems: number; maxDepth: number }
}

export type ExternalMcpEntryApproval = {
  state: ExternalMcpEntryApprovalState
  approvalId?: string
  requestId?: string
  approvedBy?: string
  approvedAt?: string
  bindingDigest?: string
  authority?: 'workbench-capability-approval'
}

export type ExternalMcpManifestEntry = {
  entryId: string
  kind: ExternalMcpEntryKind
  canonicalName: string
  advertisedUri?: string
  intakeDigest: string
  materialIdentityDigest: string
  declaredRequestSchemaDigest?: string
  declaredResultSchemaDigest?: string
  pinnedRequestSchema?: ExternalMcpJsonObject
  pinnedResultSchema?: ExternalMcpJsonObject
  compatibilityVersion: string
  metadata: {
    description?: string
    displayName?: string
    mimeType?: string
    safety?: ExternalMcpSafetyHints
  }
  approval: ExternalMcpEntryApproval
  lifecycle: ExternalMcpEntryLifecycle
  executionAuthority: 'none'
}

export type ExternalMcpManifest = {
  schemaVersion: typeof EXTERNAL_MCP_INTAKE_VERSION
  kind: typeof EXTERNAL_MCP_INTAKE_KIND
  manifestId: string
  manifestDigest: string
  server: {
    serverIdentity: string
    configuredServerId: string
    claimedServerId: string
    configuredEndpointIdentity: string
    transport: ExternalMcpTransport
    ownerId: string
    profile: string
    sourceId?: string
    sessionId?: string
    compatibilityVersion: string
    observedTransportHint?: ExternalMcpTransport
    observedEndpointHint?: string
    authenticationHints?: ExternalMcpAuthenticationHints
    safetyHints?: ExternalMcpSafetyHints
  }
  owner: { ownerId: string; profile: string; sourceId?: string; sessionId?: string }
  discovery: { staticDiscoveryDigest: string; discoveredAt: string; observedAt: string }
  entries: ExternalMcpManifestEntry[]
  policy: ExternalMcpPolicyBinding
  lifecycle: ExternalMcpManifestLifecycle
  lastUpdatedAt: string
}

export type ExternalMcpIntakeStore = {
  version: typeof EXTERNAL_MCP_INTAKE_STORE_VERSION
  ownerId: string
  updatedAt: string
  manifests: ExternalMcpManifest[]
  validationEvidence?: ExternalMcpValidationEvidence[]
  isolatedOutputs?: ExternalMcpOutputArtifactRecord[]
  credentialBindings?: ExternalMcpCredentialBinding[]
  credentialEvidence?: ExternalMcpCredentialEvidence[]
  policyEvidence?: ExternalMcpPolicyEvidence[]
  brokerExecutions?: ExternalMcpBrokerExecutionRecord[]
}

export type ExternalMcpPolicyEvidence = {
  evidenceId: string
  outcome: string
  ownerId: string
  profile: string
  sourceId?: string
  sessionId?: string
  manifestId: string
  serverIdentity: string
  entryId: string
  approvalId: string
  policyDigest: string
  requestDigest: string
  effect: 'read' | 'write'
  confirmationClass: 'NO_CONFIRMATION_REQUIRED' | 'CONFIRMATION_REQUIRED' | 'PROHIBITED'
  reason: string
  recordedAt: string
}

export type ExternalMcpBrokerLifecycle =
  | 'CREATED' | 'INTAKE_VERIFIED' | 'REQUEST_VALIDATED' | 'CREDENTIAL_ELIGIBLE'
  | 'POLICY_AUTHORIZED' | 'CONFIRMATION_REQUIRED' | 'READY_TO_DISPATCH'
  | 'DISPATCH_RESERVATION_PERSISTED' | 'DISPATCHED' | 'RESPONSE_RECEIVED'
  | 'RESULT_VALIDATED' | 'OUTPUT_ISOLATED' | 'COMPLETED' | 'DENIED' | 'FAILED'
  | 'TIMED_OUT' | 'CANCELLED' | 'OUTCOME_UNKNOWN' | 'RECONCILIATION_REQUIRED'

export type ExternalMcpBrokerTerminalStatus =
  | 'EXTERNAL_MCP_COMPLETED' | 'EXTERNAL_MCP_DENIED' | 'EXTERNAL_MCP_FAILED'
  | 'EXTERNAL_MCP_TIMEOUT' | 'EXTERNAL_MCP_CANCELLED'
  | 'EXTERNAL_MCP_OUTCOME_UNKNOWN' | 'EXTERNAL_MCP_RECONCILIATION_REQUIRED'

export type ExternalMcpBrokerExecutionRecord = {
  schemaVersion: 1
  executionId: string
  semanticExecutionId: string
  ownerId: string
  profile: string
  sourceId?: string
  sessionId?: string
  serverIdentity: string
  configuredEndpointIdentity: string
  transport: ExternalMcpTransport
  manifestId: string
  entryId: string
  entryKind: ExternalMcpEntryKind
  approvalId: string
  request: {
    requestId: string
    requestDigest?: string
    requestSchemaDigest?: string
    validationEvidenceId?: string
  }
  credential: {
    required: boolean
    credentialClass: 'none' | 'external-mcp-oauth'
    bindingId?: string
    credentialReferenceId?: string
    generation?: number
    audience?: string
    scopeDigest?: string
    evidenceId?: string
  }
  policy: {
    policyId: string
    policyDigest: string
    effect: 'read' | 'write'
    networkPolicyDigest: string
    pathPolicyDigest: string
    confirmationClass: 'NO_CONFIRMATION_REQUIRED' | 'CONFIRMATION_REQUIRED' | 'PROHIBITED'
    confirmationIdentity?: string
    evidenceId: string
    grantId: string
    planId: string
    timeoutMs: number
    budgets: { maximumBytes: number; maximumDurationMs: number; maximumQueries: number }
  }
  dispatch: {
    reservationId: string
    dispatchId?: string
    transportRequestId?: string
    responseTransportIdentity?: string
    dispatchCount: number
  }
  response?: {
    responseTransportIdentity: string
    responseBytes: number
    resultSchemaDigest: string
    resultDigest: string
    validationEvidenceId: string
  }
  output?: {
    artifactId: string
    isolationIdentity: string
    trustClass: 'EXTERNAL_UNTRUSTED_DATA'
  }
  lifecycle: ExternalMcpBrokerLifecycle
  terminalStatus?: ExternalMcpBrokerTerminalStatus
  terminalStage?: ExternalMcpBrokerLifecycle
  terminalReason?: string
  recovery: {
    state: 'NOT_REQUIRED' | 'RECONCILED' | 'RECONCILIATION_REQUIRED'
    restartCount: number
    lastAction: string
  }
  followUp: { executed: false; identity?: string }
  audit: {
    policyEvidenceId: string
    credentialEvidenceId?: string
    requestValidationEvidenceId?: string
    resultValidationEvidenceId?: string
    outputIsolationIdentity?: string
  }
  createdAt: string
  updatedAt: string
  terminalAt?: string
}

export type ExternalMcpValidationEvidence = {
  evidenceId: string
  kind: 'request' | 'result'
  outcome: string
  manifestId: string
  serverIdentity: string
  entryId: string
  approvalId?: string
  schemaDigest?: string
  contentType: string
  payloadDigest?: string
  byteLength: number
  path?: string
  expected?: string
  actual?: string
  recordedAt: string
}

export type ExternalMcpValidationEvidenceInput = Omit<ExternalMcpValidationEvidence, 'evidenceId' | 'recordedAt'> & { recordedAt?: string }

export type ExternalMcpOutputArtifactRecord = {
  artifactId: string
  semanticIdentity: string
  trustClass: 'EXTERNAL_UNTRUSTED_DATA'
  contentKind: 'text' | 'json' | 'blocks'
  content: ExternalMcpJsonValue
  provenance: {
    serverIdentity: string
    manifestId: string
    entryId: string
    approvalId: string
    requestDigest?: string
    resultDigest: string
    pinnedResultSchemaDigest: string
    contentType: string
    validationVersion: number
    intakeVersion: number
    policyVersion: string
    outputIsolationVersion: number
    runtimeIdentity: string
    recordedAt: string
  }
  bounds: {
    originalResultBytes: number
    projectedBytes: number
    nodeCount: number
    blockCount: number
    projectionTruncated: 'YES' | 'NO'
  }
  redaction: {
    applied: 'YES' | 'NO'
    class: 'secret' | 'none'
    count: number
  }
  authority: 'none'
  state: 'OUTPUT_ISOLATED' | 'OUTPUT_REDACTED' | 'OUTPUT_PROJECTION_BOUNDED'
  createdAt: string
}

export type ExternalMcpCredentialClass = 'external-mcp-oauth' | 'workbench-action' | 'workbench-mcp-local' | 'provider' | 'git' | 'ssh'
export type ExternalMcpCredentialState = 'active' | 'retired' | 'revoked'
export type ExternalMcpCredentialBinding = {
  schemaVersion: 1
  bindingId: string
  policyVersion: 'r22.4'
  ownerId: string
  profile: string
  sourceId?: string
  manifestId: string
  serverIdentity: string
  entryId: string
  approvalId: string
  credential: {
    referenceId: string
    source: 'workbench-owned-reference'
    sourceIdentity: string
    credentialClass: ExternalMcpCredentialClass
    audience: string
    scopes: string[]
    generation: number
    state: ExternalMcpCredentialState
    expiresAt: string
  }
  policy: {
    credentialReferenceId: string
    credentialClass: ExternalMcpCredentialClass
    sourceIdentity: string
    requiredAudience: string
    requiredScopes: string[]
    exactScopes: true
  }
  rotationLineage: Array<{
    rotationId: string
    previousReferenceId?: string
    previousGeneration: number
    previousState: 'retired'
    newGeneration: number
    reason: string
    occurredAt: string
  }>
  createdAt: string
  updatedAt: string
}

export type ExternalMcpCredentialEvidence = {
  evidenceId: string
  outcome: string
  bindingId: string
  ownerId: string
  profile: string
  sourceId?: string
  manifestId: string
  serverIdentity: string
  entryId: string
  approvalId: string
  credentialReferenceId?: string
  credentialClass?: ExternalMcpCredentialClass
  audience?: string
  scopes?: string[]
  generation?: number
  expiryState: 'active' | 'expired' | 'unknown'
  revocationState: 'active' | 'revoked' | 'retired'
  rotationIdentity?: string
  policyVersion: 'r22.4'
  reason: string
  recordedAt: string
}

export type ExternalMcpIntakeOptions = {
  rootDir?: string
  now?: () => Date
  maxManifests?: number
  persistenceHook?: (stage: 'before-rename' | 'before-approval-rename') => void
}

export type ExternalMcpIntakeFailureCode =
  | 'invalid_reference'
  | 'invalid_snapshot'
  | 'duplicate_identity'
  | 'identity_conflict'
  | 'manifest_not_found'
  | 'manifest_drifted'
  | 'owner_mismatch'
  | 'approval_invalid'
  | 'wildcard_rejected'
  | 'persistence_unsafe'
  | 'persistence_failed'
  | 'store_corrupt'
  | 'store_busy'
  | 'evidence_invalid'
  | 'output_invalid'
  | 'credential_conflict'
  | 'credential_ambiguous'
  | 'broker_execution_invalid'

export type ExternalMcpIntakeFailure = { ok: false; code: ExternalMcpIntakeFailureCode; message: string; issues?: string[] }
export type ExternalMcpIntakeResult<T> = { ok: true; value: T } | ExternalMcpIntakeFailure

export type ExternalMcpIntakeProjection = {
  operation: 'static-intake'
  server: string
  transport: ExternalMcpTransport
  toolsDiscovered: number
  resourcesDiscovered: number
  approved: number
  pending: number
  drift: 'none' | 'present'
  unavailable: number
  executionEnabled: 'NO'
  manifestId: string
  lifecycle: ExternalMcpManifestLifecycle
}

const SHA256 = /^[a-f0-9]{64}$/
const IDENTIFIER = /^[a-z][a-z0-9._-]{0,159}$/
const ENTRY_ID = /^mcp-entry-[a-f0-9]{64}$/
const MANIFEST_ID = /^mcp-manifest-[a-f0-9]{64}$/
const APPROVAL_ID = /^mcp-approval-[a-f0-9]{64}$/
const OUTPUT_ID = /^mcp-output-[a-f0-9]{64}$/
const CREDENTIAL_BINDING_ID = /^mcp-credential-binding-[a-f0-9]{64}$/
const CREDENTIAL_REFERENCE_ID = /^mcp-credential-ref-[a-z0-9-]{1,96}$/
const CREDENTIAL_EVIDENCE_ID = /^mcp-credential-evidence-[a-f0-9]{64}$/
const POLICY_EVIDENCE_ID = /^mcp-policy-evidence-[a-f0-9]{64}$/
const BROKER_EXECUTION_ID = /^mcp-execution-[a-f0-9]{64}$/
const BROKER_RESERVATION_ID = /^mcp-reservation-[a-f0-9]{64}$/
const BROKER_DISPATCH_ID = /^mcp-dispatch-[a-f0-9]{64}$/
const ROTATION_ID = /^mcp-rotation-[A-Za-z0-9._:-]{1,128}$/
const OUTPUT_BLOCK_TYPES = new Set(['text', 'json', 'resource', 'resource_link', 'image'])
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const TRANSPORTS: readonly ExternalMcpTransport[] = ['stdio', 'sse', 'streamable-http']
const CREDENTIAL_CLASSES: readonly ExternalMcpCredentialClass[] = ['external-mcp-oauth', 'workbench-action', 'workbench-mcp-local', 'provider', 'git', 'ssh']
const CREDENTIAL_STATES: readonly ExternalMcpCredentialState[] = ['active', 'retired', 'revoked']
const SECRET_KEY = /(?:secret|token|password|passwd|credential|authorization|api[_-]?key|private[_-]?key)/i
const SECRET_VALUE = /(?:github_pat_|ghp_|gho_|ghu_|ghs_|ghr_|sk_live_|rk_live_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{8,}/
const KEY_VALUE_SECRET = /(?:password|passwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*["']?[^\s"']{8,}["']?/i

function failure(code: ExternalMcpIntakeFailureCode, message: string, issues?: string[]): ExternalMcpIntakeFailure { return { ok: false, code, message, ...(issues?.length ? { issues: issues.slice(0, 16) } : {}) } }
function byteLength(value: string): number { return Buffer.byteLength(value, 'utf8') }
function validText(value: unknown, maxBytes: number, allowEmpty = false): value is string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || byteLength(value) > maxBytes || value.includes('\0')) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(index + 1); if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return false; index += 1 }
    else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}
function containsSecretLike(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === 'string') return SECRET_VALUE.test(value) || KEY_VALUE_SECRET.test(value)
  if (!record(value)) return false
  if (seen.has(value)) return true
  seen.add(value)
  try { return Object.entries(value).some(([key, child]) => SECRET_KEY.test(key) || containsSecretLike(child, seen)) } finally { seen.delete(value) }
}
function iso(value: unknown): value is string { return typeof value === 'string' && ISO.test(value) && Number.isFinite(Date.parse(value)) }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function hasTraversal(value: string): boolean { return value.split(/[\\/]+/).includes('..') }
function sorted<T>(values: readonly T[], compare: (a: T, b: T) => number): T[] { return [...values].sort(compare) }
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`
}
function digest(value: unknown): string { return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex') }
function boundedJson(value: unknown, maxDepth: number, maxBytes: number, label: string): string | undefined {
  const visit = (current: unknown, depth: number): boolean => {
    if (depth > maxDepth || current === undefined || typeof current === 'function' || typeof current === 'symbol') return false
    if (typeof current === 'number' && !Number.isFinite(current)) return false
    if (typeof current === 'string' && !validText(current, EXTERNAL_MCP_LIMITS.maxStringBytes, true)) return false
    if (Array.isArray(current)) return current.every(item => visit(item, depth + 1))
    if (record(current)) return Object.keys(current).every(key => validText(key, EXTERNAL_MCP_LIMITS.maxStringBytes) && visit(current[key], depth + 1))
    return current === null || typeof current === 'boolean' || typeof current === 'number' || typeof current === 'string'
  }
  if (!visit(value, 0)) return undefined
  const serialized = canonicalJson(value)
  return byteLength(serialized) <= maxBytes ? serialized : undefined
}
function canonicalSchema(value: ExternalMcpJsonObject | undefined): ExternalMcpJsonObject | undefined {
  if (!value) return undefined
  return JSON.parse(canonicalJson(value)) as ExternalMcpJsonObject
}
function canonicalEndpoint(transport: ExternalMcpTransport, endpoint: string): string | undefined {
  if (!validText(endpoint, EXTERNAL_MCP_LIMITS.maxServerReferenceBytes)) return undefined
  const value = endpoint.trim()
  if (transport === 'stdio') return value
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return undefined
    url.hash = ''
    url.hostname = url.hostname.toLowerCase()
    return url.toString()
  } catch { return undefined }
}
function storePath(options: ExternalMcpIntakeOptions): string | ExternalMcpIntakeFailure {
  const root = options.rootDir ?? path.join(process.cwd(), '.workbench-provider-state')
  if (!path.isAbsolute(root) || hasTraversal(root)) return failure('persistence_unsafe', 'External MCP intake store root must be an absolute canonical path without traversal.')
  try {
    const stat = fs.lstatSync(root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return failure('persistence_unsafe', 'External MCP intake store root must be a non-symlink directory.')
    return path.join(fs.realpathSync(root), EXTERNAL_MCP_INTAKE_STORE_FILENAME)
  } catch { return failure('persistence_unsafe', 'External MCP intake store root is unavailable.') }
}
function validateHints(value: unknown): value is ExternalMcpSafetyHints {
  return record(value) && Object.keys(value).every(key => ['safe', 'readOnly', 'destructive', 'trusted', 'requiresConfirmation'].includes(key) && typeof value[key] === 'boolean')
}
function validateAuth(value: unknown): value is ExternalMcpAuthenticationHints {
  return record(value) && typeof value.required === 'boolean'
    && (value.audience === undefined || validText(value.audience, EXTERNAL_MCP_LIMITS.maxStringBytes))
    && (value.scopes === undefined || (Array.isArray(value.scopes) && value.scopes.length <= EXTERNAL_MCP_LIMITS.maxScopes && value.scopes.every(item => validText(item, EXTERNAL_MCP_LIMITS.maxStringBytes))))
}
function validateSchema(value: unknown, label: string): string | undefined {
  if (!record(value)) return undefined
  return boundedJson(value, EXTERNAL_MCP_LIMITS.maxSchemaDepth, EXTERNAL_MCP_LIMITS.maxSchemaBytes, label)
}
function validateReference(reference: ExternalMcpServerReference): ExternalMcpIntakeFailure | undefined {
  if (!record(reference) || !IDENTIFIER.test(reference.serverId) || !TRANSPORTS.includes(reference.transport) || !validText(reference.endpoint, EXTERNAL_MCP_LIMITS.maxServerReferenceBytes) || !validText(reference.ownerId, EXTERNAL_MCP_LIMITS.maxStringBytes) || !validText(reference.profile, EXTERNAL_MCP_LIMITS.maxStringBytes) || !validText(reference.compatibilityVersion, EXTERNAL_MCP_LIMITS.maxStringBytes) || (reference.sourceId !== undefined && !validText(reference.sourceId, EXTERNAL_MCP_LIMITS.maxStringBytes)) || (reference.sessionId !== undefined && !validText(reference.sessionId, EXTERNAL_MCP_LIMITS.maxStringBytes))) return failure('invalid_reference', 'Configured external MCP server reference is invalid or unbounded.')
  if (!canonicalEndpoint(reference.transport, reference.endpoint)) return failure('invalid_reference', 'Configured external MCP endpoint is not valid for its typed transport.')
  return undefined
}
function validateSnapshot(snapshot: ExternalMcpStaticDiscoverySnapshot): ExternalMcpIntakeFailure | undefined {
  if (!record(snapshot) || !record(snapshot.server) || !Array.isArray(snapshot.tools) || !Array.isArray(snapshot.resources) || !iso(snapshot.discoveredAt)) return failure('invalid_snapshot', 'Static MCP discovery snapshot has an invalid top-level shape.')
  if (containsSecretLike(snapshot)) return failure('invalid_snapshot', 'Static MCP discovery metadata contains credential-shaped material and cannot be retained.')
  const server = snapshot.server
  const invalidServer = !validText(server.claimedId, EXTERNAL_MCP_LIMITS.maxStringBytes)
    || !validText(server.protocolVersion, EXTERNAL_MCP_LIMITS.maxStringBytes)
    || (server.displayName !== undefined && !validText(server.displayName, EXTERNAL_MCP_LIMITS.maxDescriptionBytes))
    || (server.description !== undefined && !validText(server.description, EXTERNAL_MCP_LIMITS.maxDescriptionBytes))
    || (server.endpointHint !== undefined && !validText(server.endpointHint, EXTERNAL_MCP_LIMITS.maxServerReferenceBytes))
    || (server.transportHint !== undefined && !TRANSPORTS.includes(server.transportHint))
    || (server.authentication !== undefined && !validateAuth(server.authentication))
    || (server.safety !== undefined && !validateHints(server.safety))
    || (server.identityClaims !== undefined && (!Array.isArray(server.identityClaims) || server.identityClaims.length > 16 || !server.identityClaims.every(item => validText(item, EXTERNAL_MCP_LIMITS.maxStringBytes))))
  if (invalidServer) return failure('invalid_snapshot', 'Static MCP server metadata is invalid or unbounded.')
  if (server.identityClaims && new Set(server.identityClaims).size !== server.identityClaims.length) return failure('duplicate_identity', 'Static MCP snapshot contains duplicate server identity claims.')
  if (snapshot.tools.length > EXTERNAL_MCP_LIMITS.maxTools || snapshot.resources.length > EXTERNAL_MCP_LIMITS.maxResources) return failure('invalid_snapshot', 'Static MCP tool/resource counts exceed the bounded intake limits.')
  const toolKeys = new Map<string, string>(); const resourceKeys = new Set<string>()
  for (const tool of snapshot.tools) {
    if (!record(tool) || !validText(tool.name, EXTERNAL_MCP_LIMITS.maxNameBytes) || tool.name.includes('/') || tool.name.includes('\\') || (tool.description !== undefined && !validText(tool.description, EXTERNAL_MCP_LIMITS.maxDescriptionBytes)) || validateSchema(tool.inputSchema, 'tool input schema') === undefined || (tool.resultSchema !== undefined && validateSchema(tool.resultSchema, 'tool result schema') === undefined) || (tool.compatibilityVersion !== undefined && !validText(tool.compatibilityVersion, EXTERNAL_MCP_LIMITS.maxStringBytes)) || (tool.safety !== undefined && !validateHints(tool.safety))) return failure('invalid_snapshot', `Tool ${String(tool.name)} is malformed or unbounded.`)
    const material = digest({ name: tool.name.trim(), inputSchema: tool.inputSchema, resultSchema: tool.resultSchema ?? null, compatibilityVersion: tool.compatibilityVersion ?? 'unknown' })
    const prior = toolKeys.get(tool.name.trim())
    if (prior !== undefined) return prior === material ? failure('duplicate_identity', `Tool ${tool.name} is duplicated.`) : failure('identity_conflict', `Tool ${tool.name} has conflicting material definitions.`)
    toolKeys.set(tool.name.trim(), material)
  }
  for (const resource of snapshot.resources) {
    if (!record(resource) || !validText(resource.uri, EXTERNAL_MCP_LIMITS.maxNameBytes) || (resource.name !== undefined && !validText(resource.name, EXTERNAL_MCP_LIMITS.maxNameBytes)) || (resource.description !== undefined && !validText(resource.description, EXTERNAL_MCP_LIMITS.maxDescriptionBytes)) || (resource.mimeType !== undefined && !validText(resource.mimeType, EXTERNAL_MCP_LIMITS.maxStringBytes)) || (resource.resultSchema !== undefined && validateSchema(resource.resultSchema, 'resource result schema') === undefined) || (resource.compatibilityVersion !== undefined && !validText(resource.compatibilityVersion, EXTERNAL_MCP_LIMITS.maxStringBytes))) return failure('invalid_snapshot', 'Resource metadata is malformed or unbounded.')
    const uri = resource.uri.trim(); if (resourceKeys.has(uri)) return failure('duplicate_identity', `Resource ${uri} is duplicated.`); resourceKeys.add(uri)
  }
  const serialized = boundedJson(snapshot, EXTERNAL_MCP_LIMITS.maxMetadataDepth, EXTERNAL_MCP_LIMITS.maxMetadataBytes, 'static MCP snapshot')
  if (!serialized) return failure('invalid_snapshot', 'Static MCP discovery metadata is too deep, invalidly encoded, or oversized.')
  return undefined
}
function serverAuthority(reference: ExternalMcpServerReference): { endpoint: string; digest: string; identity: string } {
  const endpoint = canonicalEndpoint(reference.transport, reference.endpoint)!; const material = { version: EXTERNAL_MCP_INTAKE_VERSION, serverId: reference.serverId, transport: reference.transport, endpoint, ownerId: reference.ownerId, profile: reference.profile, sourceId: reference.sourceId ?? null, sessionId: reference.sessionId ?? null, compatibilityVersion: reference.compatibilityVersion }
  const digestValue = digest(material)
  return { endpoint, digest: digestValue, identity: `mcp-server-${digestValue}` }
}
function entryParts(serverIdentity: string, kind: ExternalMcpEntryKind, name: string, requestSchema: unknown, resultSchema: unknown, compatibilityVersion: string, metadata: ExternalMcpManifestEntry['metadata']): { entryId: string; intakeDigest: string; materialIdentityDigest: string; requestDigest?: string; resultDigest?: string } {
  const requestDigest = requestSchema === undefined ? undefined : digest(requestSchema); const resultDigest = resultSchema === undefined ? undefined : digest(resultSchema)
  const material = { serverIdentity, kind, name, requestDigest: requestDigest ?? null, resultDigest: resultDigest ?? null, compatibilityVersion }
  const entryId = `mcp-entry-${digest(material)}`
  return { entryId, intakeDigest: digest({ ...material, metadata }), materialIdentityDigest: digest(material), ...(requestDigest ? { requestDigest } : {}), ...(resultDigest ? { resultDigest } : {}) }
}
function policy(reference: ExternalMcpServerReference): ExternalMcpPolicyBinding { return { policyVersion: EXTERNAL_MCP_POLICY_VERSION, allowedProfile: reference.profile, capabilityClass: 'unassigned', networkPolicyRef: 'workbench-owned-r22.5', pathPolicyRef: 'workbench-owned-r22.5', confirmationPolicyRef: 'workbench-owned-r22.5', credentialAudiencePolicyRef: 'workbench-owned-r22.4', inputLimits: { maxBytes: 64 * 1024, maxItems: 128, maxDepth: 8, timeoutMs: EXTERNAL_MCP_LIMITS.maxTimeoutMs }, outputLimits: { maxBytes: 64 * 1024, maxItems: 256, maxDepth: 8 } } }
function manifestSemanticId(serverIdentity: string, entries: readonly ExternalMcpManifestEntry[], binding: ExternalMcpPolicyBinding): string { return `mcp-manifest-${digest({ serverIdentity, entries: sorted(entries, (a, b) => a.entryId.localeCompare(b.entryId)).map(entry => ({ entryId: entry.entryId, materialIdentityDigest: entry.materialIdentityDigest })), policy: binding })}` }
function manifestDigest(manifest: Omit<ExternalMcpManifest, 'manifestDigest'>): string { return digest(manifest) }
function validateApprovalBinding(manifest: ExternalMcpManifest, entry: ExternalMcpManifestEntry, approval: ExternalMcpApprovalInput): string | undefined {
  if (!approval || approval.manifestId !== manifest.manifestId || approval.entryId !== entry.entryId || approval.capabilityId !== entry.entryId || approval.authority !== 'workbench-capability-approval' || approval.ownerId !== manifest.owner.ownerId || approval.profile !== manifest.owner.profile || approval.sourceId !== manifest.owner.sourceId || !validText(approval.requestId, EXTERNAL_MCP_LIMITS.maxStringBytes) || !validText(approval.approvedBy, EXTERNAL_MCP_LIMITS.maxStringBytes) || !iso(approval.approvedAt) || approval.policyVersion !== EXTERNAL_MCP_POLICY_VERSION || approval.capabilityClass !== 'unassigned') return 'Approval is not an exact Workbench-owned binding for this manifest entry.'
  const expected = `mcp-approval-${digest({ manifestId: manifest.manifestId, entryId: entry.entryId, owner: manifest.owner, policyVersion: EXTERNAL_MCP_POLICY_VERSION })}`
  if (approval.approvalId !== undefined && approval.approvalId !== expected) return 'Approval identity does not match the canonical manifest/entry binding.'
  return undefined
}
export type ExternalMcpApprovalInput = { manifestId: string; entryId: string; capabilityId: string; authority: 'workbench-capability-approval'; ownerId: string; profile: string; sourceId?: string; requestId: string; approvedBy: string; approvedAt: string; policyVersion: typeof EXTERNAL_MCP_POLICY_VERSION; capabilityClass: 'unassigned'; approvalId?: string }
function validEvidence(value: unknown): value is ExternalMcpValidationEvidence {
  if (!record(value)) return false
  const length = value.byteLength
  return validText(value.evidenceId, EXTERNAL_MCP_LIMITS.maxStringBytes)
    && ['request', 'result'].includes(String(value.kind))
    && validText(value.outcome, EXTERNAL_MCP_LIMITS.maxStringBytes)
    && MANIFEST_ID.test(String(value.manifestId))
    && validText(value.serverIdentity, EXTERNAL_MCP_LIMITS.maxStringBytes)
    && ENTRY_ID.test(String(value.entryId))
    && (value.approvalId === undefined || APPROVAL_ID.test(String(value.approvalId)))
    && (value.schemaDigest === undefined || SHA256.test(String(value.schemaDigest)))
    && validText(value.contentType, EXTERNAL_MCP_LIMITS.maxStringBytes)
    && (value.payloadDigest === undefined || SHA256.test(String(value.payloadDigest)))
    && typeof length === 'number' && Number.isSafeInteger(length) && length >= 0 && length <= EXTERNAL_MCP_LIMITS.maxResultBytes
    && (value.path === undefined || validText(value.path, EXTERNAL_MCP_LIMITS.maxStringBytes, true))
    && (value.expected === undefined || validText(value.expected, EXTERNAL_MCP_LIMITS.maxStringBytes, true))
    && (value.actual === undefined || validText(value.actual, EXTERNAL_MCP_LIMITS.maxStringBytes, true))
    && iso(value.recordedAt)
}
function validOutputArtifact(value: unknown): value is ExternalMcpOutputArtifactRecord {
  if (!record(value) || !OUTPUT_ID.test(String(value.artifactId)) || !SHA256.test(String(value.semanticIdentity)) || value.artifactId !== `mcp-output-${value.semanticIdentity}` || value.trustClass !== 'EXTERNAL_UNTRUSTED_DATA' || !['text', 'json', 'blocks'].includes(String(value.contentKind)) || !boundedJson(value.content, 8, EXTERNAL_MCP_LIMITS.maxOutputArtifactBytes, 'isolated output')) return false
  if (value.contentKind === 'text' && typeof value.content !== 'string') return false
  if (value.contentKind === 'blocks' && (!Array.isArray(value.content) || !value.content.every(item => record(item) && typeof item.type === 'string' && OUTPUT_BLOCK_TYPES.has(item.type)))) return false
  const provenance = value.provenance; const bounds = value.bounds; const redaction = value.redaction
  const boundedInteger = (candidate: unknown, max: number): candidate is number => typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0 && candidate <= max
  return record(provenance) && validText(provenance.serverIdentity, EXTERNAL_MCP_LIMITS.maxStringBytes) && MANIFEST_ID.test(String(provenance.manifestId)) && ENTRY_ID.test(String(provenance.entryId)) && APPROVAL_ID.test(String(provenance.approvalId)) && (provenance.requestDigest === undefined || SHA256.test(String(provenance.requestDigest))) && SHA256.test(String(provenance.resultDigest)) && SHA256.test(String(provenance.pinnedResultSchemaDigest)) && validText(provenance.contentType, EXTERNAL_MCP_LIMITS.maxStringBytes) && boundedInteger(provenance.validationVersion, Number.MAX_SAFE_INTEGER) && provenance.validationVersion > 0 && provenance.intakeVersion === EXTERNAL_MCP_INTAKE_VERSION && provenance.policyVersion === EXTERNAL_MCP_POLICY_VERSION && boundedInteger(provenance.outputIsolationVersion, Number.MAX_SAFE_INTEGER) && provenance.outputIsolationVersion > 0 && validText(provenance.runtimeIdentity, EXTERNAL_MCP_LIMITS.maxStringBytes) && iso(provenance.recordedAt)
    && record(bounds) && boundedInteger(bounds.originalResultBytes, EXTERNAL_MCP_LIMITS.maxResultBytes) && boundedInteger(bounds.projectedBytes, EXTERNAL_MCP_LIMITS.maxOutputArtifactBytes) && boundedInteger(bounds.nodeCount, EXTERNAL_MCP_LIMITS.maxSchemaNodes) && boundedInteger(bounds.blockCount, EXTERNAL_MCP_LIMITS.maxEntries) && ['YES', 'NO'].includes(String(bounds.projectionTruncated))
    && record(redaction) && ['YES', 'NO'].includes(String(redaction.applied)) && ['secret', 'none'].includes(String(redaction.class)) && boundedInteger(redaction.count, EXTERNAL_MCP_LIMITS.maxValidationIssues) && value.authority === 'none' && ['OUTPUT_ISOLATED', 'OUTPUT_REDACTED', 'OUTPUT_PROJECTION_BOUNDED'].includes(String(value.state)) && iso(value.createdAt)
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[] = []): boolean {
  const keys = Object.keys(value)
  return keys.every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key))
}
function validAuthority(value: unknown): value is string {
  return validText(value, EXTERNAL_MCP_LIMITS.maxStringBytes) && !/[\s,;\0]/.test(value)
}
function validScopeSet(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= EXTERNAL_MCP_LIMITS.maxCredentialScopes
    && value.every(item => validText(item, EXTERNAL_MCP_LIMITS.maxStringBytes) && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(item))
    && new Set(value).size === value.length
    && [...value].sort().every((item, index, sortedValues) => item === sortedValues[index])
}
function validCredentialBinding(value: unknown): value is ExternalMcpCredentialBinding {
  if (!record(value) || !exactKeys(value, ['schemaVersion', 'bindingId', 'policyVersion', 'ownerId', 'profile', 'sourceId', 'manifestId', 'serverIdentity', 'entryId', 'approvalId', 'credential', 'policy', 'rotationLineage', 'createdAt', 'updatedAt'], ['schemaVersion', 'bindingId', 'policyVersion', 'ownerId', 'profile', 'manifestId', 'serverIdentity', 'entryId', 'approvalId', 'credential', 'policy', 'rotationLineage', 'createdAt', 'updatedAt']) || value.schemaVersion !== 1 || !CREDENTIAL_BINDING_ID.test(String(value.bindingId)) || value.policyVersion !== 'r22.4' || !validText(value.ownerId, EXTERNAL_MCP_LIMITS.maxStringBytes) || !validText(value.profile, EXTERNAL_MCP_LIMITS.maxStringBytes) || (value.sourceId !== undefined && !validText(value.sourceId, EXTERNAL_MCP_LIMITS.maxStringBytes)) || !MANIFEST_ID.test(String(value.manifestId)) || !validText(value.serverIdentity, EXTERNAL_MCP_LIMITS.maxStringBytes) || !ENTRY_ID.test(String(value.entryId)) || !APPROVAL_ID.test(String(value.approvalId)) || !iso(value.createdAt) || !iso(value.updatedAt)) return false
  const credential = value.credential
  if (!record(credential) || !exactKeys(credential, ['referenceId', 'source', 'sourceIdentity', 'credentialClass', 'audience', 'scopes', 'generation', 'state', 'expiresAt'], ['referenceId', 'source', 'sourceIdentity', 'credentialClass', 'audience', 'scopes', 'generation', 'state', 'expiresAt'])) return false
  if (!CREDENTIAL_REFERENCE_ID.test(String(credential.referenceId)) || credential.source !== 'workbench-owned-reference' || !validText(credential.sourceIdentity, EXTERNAL_MCP_LIMITS.maxStringBytes) || !CREDENTIAL_CLASSES.includes(credential.credentialClass as ExternalMcpCredentialClass) || !validAuthority(credential.audience) || !validScopeSet(credential.scopes) || !Number.isSafeInteger(credential.generation) || Number(credential.generation) < 1 || !CREDENTIAL_STATES.includes(credential.state as ExternalMcpCredentialState) || !iso(credential.expiresAt)) return false
  const policy = value.policy
  if (!record(policy) || !exactKeys(policy, ['credentialReferenceId', 'credentialClass', 'sourceIdentity', 'requiredAudience', 'requiredScopes', 'exactScopes'], ['credentialReferenceId', 'credentialClass', 'sourceIdentity', 'requiredAudience', 'requiredScopes', 'exactScopes'])) return false
  if (!CREDENTIAL_REFERENCE_ID.test(String(policy.credentialReferenceId)) || !CREDENTIAL_CLASSES.includes(policy.credentialClass as ExternalMcpCredentialClass) || !validText(policy.sourceIdentity, EXTERNAL_MCP_LIMITS.maxStringBytes) || !validAuthority(policy.requiredAudience) || !validScopeSet(policy.requiredScopes) || policy.exactScopes !== true || credential.sourceIdentity !== policy.sourceIdentity || credential.credentialClass !== policy.credentialClass || credential.audience !== policy.requiredAudience || JSON.stringify(credential.scopes) !== JSON.stringify(policy.requiredScopes)) return false
  if (!Array.isArray(value.rotationLineage) || value.rotationLineage.length > EXTERNAL_MCP_LIMITS.maxCredentialEvidence) return false
  for (const item of value.rotationLineage) {
    if (!record(item) || !exactKeys(item, ['rotationId', 'previousReferenceId', 'previousGeneration', 'previousState', 'newGeneration', 'reason', 'occurredAt'], ['rotationId', 'previousGeneration', 'previousState', 'newGeneration', 'reason', 'occurredAt']) || !ROTATION_ID.test(String(item.rotationId)) || (item.previousReferenceId !== undefined && !CREDENTIAL_REFERENCE_ID.test(String(item.previousReferenceId))) || !Number.isSafeInteger(item.previousGeneration) || Number(item.previousGeneration) < 1 || item.previousState !== 'retired' || !Number.isSafeInteger(item.newGeneration) || Number(item.newGeneration) !== Number(item.previousGeneration) + 1 || !validText(item.reason, EXTERNAL_MCP_LIMITS.maxStringBytes) || !iso(item.occurredAt)) return false
  }
  return true
}
function validCredentialEvidence(value: unknown): value is ExternalMcpCredentialEvidence {
  if (!record(value) || !exactKeys(value, ['evidenceId', 'outcome', 'bindingId', 'ownerId', 'profile', 'sourceId', 'manifestId', 'serverIdentity', 'entryId', 'approvalId', 'credentialReferenceId', 'credentialClass', 'audience', 'scopes', 'generation', 'expiryState', 'revocationState', 'rotationIdentity', 'policyVersion', 'reason', 'recordedAt'], ['evidenceId', 'outcome', 'bindingId', 'ownerId', 'profile', 'manifestId', 'serverIdentity', 'entryId', 'approvalId', 'expiryState', 'revocationState', 'policyVersion', 'reason', 'recordedAt'])) return false
  if (!CREDENTIAL_EVIDENCE_ID.test(String(value.evidenceId)) || !validText(value.outcome, EXTERNAL_MCP_LIMITS.maxStringBytes) || !CREDENTIAL_BINDING_ID.test(String(value.bindingId)) || !validText(value.ownerId, EXTERNAL_MCP_LIMITS.maxStringBytes) || !validText(value.profile, EXTERNAL_MCP_LIMITS.maxStringBytes) || (value.sourceId !== undefined && !validText(value.sourceId, EXTERNAL_MCP_LIMITS.maxStringBytes)) || !MANIFEST_ID.test(String(value.manifestId)) || !validText(value.serverIdentity, EXTERNAL_MCP_LIMITS.maxStringBytes) || !ENTRY_ID.test(String(value.entryId)) || !APPROVAL_ID.test(String(value.approvalId)) || (value.credentialReferenceId !== undefined && !CREDENTIAL_REFERENCE_ID.test(String(value.credentialReferenceId))) || (value.credentialClass !== undefined && !CREDENTIAL_CLASSES.includes(value.credentialClass as ExternalMcpCredentialClass)) || (value.audience !== undefined && !validAuthority(value.audience)) || (value.scopes !== undefined && !validScopeSet(value.scopes)) || (value.generation !== undefined && (!Number.isSafeInteger(value.generation) || Number(value.generation) < 1)) || !['active', 'expired', 'unknown'].includes(String(value.expiryState)) || !['active', 'revoked', 'retired'].includes(String(value.revocationState)) || (value.rotationIdentity !== undefined && !ROTATION_ID.test(String(value.rotationIdentity))) || value.policyVersion !== 'r22.4' || !validText(value.reason, EXTERNAL_MCP_LIMITS.maxStringBytes) || !iso(value.recordedAt)) return false
  return byteLength(JSON.stringify(value)) <= EXTERNAL_MCP_LIMITS.maxCredentialEvidenceBytes
}
function validPolicyEvidence(value: unknown): value is ExternalMcpPolicyEvidence {
  if (!record(value) || !exactKeys(value, ['evidenceId', 'outcome', 'ownerId', 'profile', 'sourceId', 'sessionId', 'manifestId', 'serverIdentity', 'entryId', 'approvalId', 'policyDigest', 'requestDigest', 'effect', 'confirmationClass', 'reason', 'recordedAt'], ['evidenceId', 'outcome', 'ownerId', 'profile', 'manifestId', 'serverIdentity', 'entryId', 'approvalId', 'policyDigest', 'requestDigest', 'effect', 'confirmationClass', 'reason', 'recordedAt'])) return false
  return POLICY_EVIDENCE_ID.test(String(value.evidenceId))
    && validText(value.outcome, EXTERNAL_MCP_LIMITS.maxStringBytes)
    && validText(value.ownerId, EXTERNAL_MCP_LIMITS.maxStringBytes)
    && validText(value.profile, EXTERNAL_MCP_LIMITS.maxStringBytes)
    && (value.sourceId === undefined || validText(value.sourceId, EXTERNAL_MCP_LIMITS.maxStringBytes))
    && (value.sessionId === undefined || validText(value.sessionId, EXTERNAL_MCP_LIMITS.maxStringBytes))
    && MANIFEST_ID.test(String(value.manifestId))
    && validText(value.serverIdentity, EXTERNAL_MCP_LIMITS.maxStringBytes)
    && ENTRY_ID.test(String(value.entryId))
    && APPROVAL_ID.test(String(value.approvalId))
    && SHA256.test(String(value.policyDigest))
    && SHA256.test(String(value.requestDigest))
    && ['read', 'write'].includes(String(value.effect))
    && ['NO_CONFIRMATION_REQUIRED', 'CONFIRMATION_REQUIRED', 'PROHIBITED'].includes(String(value.confirmationClass))
    && validText(value.reason, EXTERNAL_MCP_LIMITS.maxStringBytes)
    && iso(value.recordedAt)
    && byteLength(JSON.stringify(value)) <= EXTERNAL_MCP_LIMITS.maxPolicyEvidenceBytes
}
function validBrokerExecution(value: unknown): value is ExternalMcpBrokerExecutionRecord {
  if (!record(value) || !exactKeys(value, ['schemaVersion', 'executionId', 'semanticExecutionId', 'ownerId', 'profile', 'sourceId', 'sessionId', 'serverIdentity', 'configuredEndpointIdentity', 'transport', 'manifestId', 'entryId', 'entryKind', 'approvalId', 'request', 'credential', 'policy', 'dispatch', 'response', 'output', 'lifecycle', 'terminalStatus', 'terminalStage', 'terminalReason', 'recovery', 'followUp', 'audit', 'createdAt', 'updatedAt', 'terminalAt'], ['schemaVersion', 'executionId', 'semanticExecutionId', 'ownerId', 'profile', 'serverIdentity', 'configuredEndpointIdentity', 'transport', 'manifestId', 'entryId', 'entryKind', 'approvalId', 'request', 'credential', 'policy', 'dispatch', 'lifecycle', 'recovery', 'followUp', 'audit', 'createdAt', 'updatedAt']) || value.schemaVersion !== 1 || !BROKER_EXECUTION_ID.test(String(value.executionId)) || !BROKER_EXECUTION_ID.test(String(value.semanticExecutionId)) || !validText(value.ownerId, EXTERNAL_MCP_LIMITS.maxStringBytes) || !validText(value.profile, EXTERNAL_MCP_LIMITS.maxStringBytes) || (value.sourceId !== undefined && !validText(value.sourceId, EXTERNAL_MCP_LIMITS.maxStringBytes)) || (value.sessionId !== undefined && !validText(value.sessionId, EXTERNAL_MCP_LIMITS.maxStringBytes)) || !validText(value.serverIdentity, EXTERNAL_MCP_LIMITS.maxStringBytes) || !validText(value.configuredEndpointIdentity, EXTERNAL_MCP_LIMITS.maxServerReferenceBytes) || !TRANSPORTS.includes(value.transport as ExternalMcpTransport) || !MANIFEST_ID.test(String(value.manifestId)) || !ENTRY_ID.test(String(value.entryId)) || !['tool', 'resource'].includes(String(value.entryKind)) || !APPROVAL_ID.test(String(value.approvalId)) || !iso(value.createdAt) || !iso(value.updatedAt) || (value.terminalAt !== undefined && !iso(value.terminalAt)) || !['CREATED', 'INTAKE_VERIFIED', 'REQUEST_VALIDATED', 'CREDENTIAL_ELIGIBLE', 'POLICY_AUTHORIZED', 'CONFIRMATION_REQUIRED', 'READY_TO_DISPATCH', 'DISPATCH_RESERVATION_PERSISTED', 'DISPATCHED', 'RESPONSE_RECEIVED', 'RESULT_VALIDATED', 'OUTPUT_ISOLATED', 'COMPLETED', 'DENIED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'OUTCOME_UNKNOWN', 'RECONCILIATION_REQUIRED'].includes(String(value.lifecycle))) return false
  const request = value.request
  if (!record(request) || !exactKeys(request, ['requestId', 'requestDigest', 'requestSchemaDigest', 'validationEvidenceId'], ['requestId']) || !validText(request.requestId, EXTERNAL_MCP_LIMITS.maxStringBytes) || (request.requestDigest !== undefined && !SHA256.test(String(request.requestDigest))) || (request.requestSchemaDigest !== undefined && !SHA256.test(String(request.requestSchemaDigest))) || (request.validationEvidenceId !== undefined && !/^mcp-validation-[a-f0-9]{64}$/.test(String(request.validationEvidenceId)))) return false
  const credential = value.credential
  if (!record(credential) || !exactKeys(credential, ['required', 'credentialClass', 'bindingId', 'credentialReferenceId', 'generation', 'audience', 'scopeDigest', 'evidenceId'], ['required', 'credentialClass']) || typeof credential.required !== 'boolean' || !['none', 'external-mcp-oauth'].includes(String(credential.credentialClass)) || (credential.bindingId !== undefined && !CREDENTIAL_BINDING_ID.test(String(credential.bindingId))) || (credential.credentialReferenceId !== undefined && !CREDENTIAL_REFERENCE_ID.test(String(credential.credentialReferenceId))) || (credential.generation !== undefined && (!Number.isSafeInteger(credential.generation) || Number(credential.generation) < 1)) || (credential.audience !== undefined && !validAuthority(credential.audience)) || (credential.scopeDigest !== undefined && !SHA256.test(String(credential.scopeDigest))) || (credential.evidenceId !== undefined && !CREDENTIAL_EVIDENCE_ID.test(String(credential.evidenceId))) || (credential.required && credential.credentialClass !== 'external-mcp-oauth') || (!credential.required && credential.credentialClass !== 'none')) return false
  const policy = value.policy as Record<string, unknown>
  const policyBudgets = record(policy.budgets) ? policy.budgets : undefined
  if (!record(policy) || !exactKeys(policy, ['policyId', 'policyDigest', 'effect', 'networkPolicyDigest', 'pathPolicyDigest', 'confirmationClass', 'confirmationIdentity', 'evidenceId', 'grantId', 'planId', 'timeoutMs', 'budgets'], ['policyId', 'policyDigest', 'effect', 'networkPolicyDigest', 'pathPolicyDigest', 'confirmationClass', 'evidenceId', 'grantId', 'planId', 'timeoutMs', 'budgets']) || !validText(policy.policyId, EXTERNAL_MCP_LIMITS.maxStringBytes) || !SHA256.test(String(policy.policyDigest)) || !['read', 'write'].includes(String(policy.effect)) || !SHA256.test(String(policy.networkPolicyDigest)) || !SHA256.test(String(policy.pathPolicyDigest)) || !['NO_CONFIRMATION_REQUIRED', 'CONFIRMATION_REQUIRED', 'PROHIBITED'].includes(String(policy.confirmationClass)) || (policy.confirmationIdentity !== undefined && !SHA256.test(String(policy.confirmationIdentity))) || !POLICY_EVIDENCE_ID.test(String(policy.evidenceId)) || !validText(policy.grantId, EXTERNAL_MCP_LIMITS.maxStringBytes) || !validText(policy.planId, EXTERNAL_MCP_LIMITS.maxStringBytes) || !Number.isSafeInteger(policy.timeoutMs) || Number(policy.timeoutMs) < 1 || Number(policy.timeoutMs) > EXTERNAL_MCP_LIMITS.maxTimeoutMs || !policyBudgets || !['maximumBytes', 'maximumDurationMs', 'maximumQueries'].every(key => Number.isSafeInteger(policyBudgets[key]) && Number(policyBudgets[key]) >= 0)) return false
  const dispatch = value.dispatch
  if (!record(dispatch) || !exactKeys(dispatch, ['reservationId', 'dispatchId', 'transportRequestId', 'responseTransportIdentity', 'dispatchCount'], ['reservationId', 'dispatchCount']) || !BROKER_RESERVATION_ID.test(String(dispatch.reservationId)) || (dispatch.dispatchId !== undefined && !BROKER_DISPATCH_ID.test(String(dispatch.dispatchId))) || (dispatch.transportRequestId !== undefined && !validText(dispatch.transportRequestId, EXTERNAL_MCP_LIMITS.maxStringBytes)) || (dispatch.responseTransportIdentity !== undefined && !validText(dispatch.responseTransportIdentity, EXTERNAL_MCP_LIMITS.maxStringBytes)) || !Number.isSafeInteger(dispatch.dispatchCount) || Number(dispatch.dispatchCount) < 0 || Number(dispatch.dispatchCount) > 1) return false
  if (value.response !== undefined) {
    const response = value.response
    if (!record(response) || !exactKeys(response, ['responseTransportIdentity', 'responseBytes', 'resultSchemaDigest', 'resultDigest', 'validationEvidenceId'], ['responseTransportIdentity', 'responseBytes', 'resultSchemaDigest', 'resultDigest', 'validationEvidenceId']) || !validText(response.responseTransportIdentity, EXTERNAL_MCP_LIMITS.maxStringBytes) || !Number.isSafeInteger(response.responseBytes) || Number(response.responseBytes) < 0 || Number(response.responseBytes) > EXTERNAL_MCP_LIMITS.maxResultBytes || !SHA256.test(String(response.resultSchemaDigest)) || !SHA256.test(String(response.resultDigest)) || !/^mcp-validation-[a-f0-9]{64}$/.test(String(response.validationEvidenceId))) return false
  }
  if (value.output !== undefined) {
    const output = value.output
    if (!record(output) || !exactKeys(output, ['artifactId', 'isolationIdentity', 'trustClass'], ['artifactId', 'isolationIdentity', 'trustClass']) || !OUTPUT_ID.test(String(output.artifactId)) || !SHA256.test(String(output.isolationIdentity)) || output.trustClass !== 'EXTERNAL_UNTRUSTED_DATA') return false
  }
  const recovery = value.recovery
  if (!record(recovery) || !exactKeys(recovery, ['state', 'restartCount', 'lastAction'], ['state', 'restartCount', 'lastAction']) || !['NOT_REQUIRED', 'RECONCILED', 'RECONCILIATION_REQUIRED'].includes(String(recovery.state)) || !Number.isSafeInteger(recovery.restartCount) || Number(recovery.restartCount) < 0 || !validText(recovery.lastAction, EXTERNAL_MCP_LIMITS.maxStringBytes)) return false
  if (!record(value.followUp) || !exactKeys(value.followUp, ['executed', 'identity'], ['executed']) || value.followUp.executed !== false || (value.followUp.identity !== undefined && !SHA256.test(String(value.followUp.identity)))) return false
  const audit = value.audit
  if (!record(audit) || !exactKeys(audit, ['policyEvidenceId', 'credentialEvidenceId', 'requestValidationEvidenceId', 'resultValidationEvidenceId', 'outputIsolationIdentity'], ['policyEvidenceId']) || !POLICY_EVIDENCE_ID.test(String(audit.policyEvidenceId)) || (audit.credentialEvidenceId !== undefined && !CREDENTIAL_EVIDENCE_ID.test(String(audit.credentialEvidenceId))) || (audit.requestValidationEvidenceId !== undefined && !/^mcp-validation-[a-f0-9]{64}$/.test(String(audit.requestValidationEvidenceId))) || (audit.resultValidationEvidenceId !== undefined && !/^mcp-validation-[a-f0-9]{64}$/.test(String(audit.resultValidationEvidenceId))) || (audit.outputIsolationIdentity !== undefined && !SHA256.test(String(audit.outputIsolationIdentity)))) return false
  return (value.terminalStatus === undefined || ['EXTERNAL_MCP_COMPLETED', 'EXTERNAL_MCP_DENIED', 'EXTERNAL_MCP_FAILED', 'EXTERNAL_MCP_TIMEOUT', 'EXTERNAL_MCP_CANCELLED', 'EXTERNAL_MCP_OUTCOME_UNKNOWN', 'EXTERNAL_MCP_RECONCILIATION_REQUIRED'].includes(String(value.terminalStatus))) && (value.terminalStage === undefined || ['CREATED', 'INTAKE_VERIFIED', 'REQUEST_VALIDATED', 'CREDENTIAL_ELIGIBLE', 'POLICY_AUTHORIZED', 'CONFIRMATION_REQUIRED', 'READY_TO_DISPATCH', 'DISPATCH_RESERVATION_PERSISTED', 'DISPATCHED', 'RESPONSE_RECEIVED', 'RESULT_VALIDATED', 'OUTPUT_ISOLATED', 'COMPLETED', 'DENIED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'OUTCOME_UNKNOWN', 'RECONCILIATION_REQUIRED'].includes(String(value.terminalStage))) && (value.terminalReason === undefined || validText(value.terminalReason, EXTERNAL_MCP_LIMITS.maxStringBytes)) && byteLength(JSON.stringify(value)) <= EXTERNAL_MCP_LIMITS.maxBrokerExecutionBytes
}
function readStore(options: ExternalMcpIntakeOptions, ownerId: string): ExternalMcpIntakeResult<ExternalMcpIntakeStore> {
  const target = storePath(options); if (typeof target !== 'string') return target
  try {
    if (!fs.existsSync(target)) return { ok: true, value: { version: EXTERNAL_MCP_INTAKE_STORE_VERSION, ownerId, updatedAt: new Date(0).toISOString(), manifests: [], validationEvidence: [], isolatedOutputs: [], brokerExecutions: [] } }
    if (fs.lstatSync(target).isSymbolicLink()) return failure('persistence_unsafe', 'External MCP intake store cannot be a symlink.')
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as ExternalMcpIntakeStore
    if (parsed.version !== EXTERNAL_MCP_INTAKE_STORE_VERSION || parsed.ownerId !== ownerId || !iso(parsed.updatedAt) || !Array.isArray(parsed.manifests) || parsed.manifests.length > EXTERNAL_MCP_LIMITS.maxManifests || !parsed.manifests.every(item => item.schemaVersion === EXTERNAL_MCP_INTAKE_VERSION && item.kind === EXTERNAL_MCP_INTAKE_KIND && MANIFEST_ID.test(item.manifestId) && SHA256.test(item.manifestDigest) && Array.isArray(item.entries) && item.entries.length <= EXTERNAL_MCP_LIMITS.maxEntries) || (parsed.validationEvidence !== undefined && (!Array.isArray(parsed.validationEvidence) || parsed.validationEvidence.length > EXTERNAL_MCP_LIMITS.maxEvidence || !parsed.validationEvidence.every(validEvidence))) || (parsed.isolatedOutputs !== undefined && (!Array.isArray(parsed.isolatedOutputs) || parsed.isolatedOutputs.length > EXTERNAL_MCP_LIMITS.maxOutputArtifacts || !parsed.isolatedOutputs.every(validOutputArtifact))) || (parsed.credentialBindings !== undefined && (!Array.isArray(parsed.credentialBindings) || parsed.credentialBindings.length > EXTERNAL_MCP_LIMITS.maxCredentialBindings || !parsed.credentialBindings.every(validCredentialBinding))) || (parsed.credentialEvidence !== undefined && (!Array.isArray(parsed.credentialEvidence) || parsed.credentialEvidence.length > EXTERNAL_MCP_LIMITS.maxCredentialEvidence || !parsed.credentialEvidence.every(validCredentialEvidence))) || (parsed.policyEvidence !== undefined && (!Array.isArray(parsed.policyEvidence) || parsed.policyEvidence.length > EXTERNAL_MCP_LIMITS.maxPolicyEvidence || !parsed.policyEvidence.every(validPolicyEvidence))) || (parsed.brokerExecutions !== undefined && (!Array.isArray(parsed.brokerExecutions) || parsed.brokerExecutions.length > EXTERNAL_MCP_LIMITS.maxBrokerExecutions || !parsed.brokerExecutions.every(validBrokerExecution)))) return failure('store_corrupt', 'External MCP intake store is corrupt, unsupported, or owned by another owner.')
    return { ok: true, value: parsed }
  } catch { return failure('store_corrupt', 'External MCP intake store could not be read safely.') }
}
function persistStore(store: ExternalMcpIntakeStore, options: ExternalMcpIntakeOptions, approval = false): ExternalMcpIntakeResult<true> {
  const target = storePath(options); if (typeof target !== 'string') return target
  const serialized = JSON.stringify({ ...store, manifests: store.manifests.slice(-(options.maxManifests ?? EXTERNAL_MCP_LIMITS.maxManifests)), validationEvidence: (store.validationEvidence ?? []).slice(-EXTERNAL_MCP_LIMITS.maxEvidence), isolatedOutputs: (store.isolatedOutputs ?? []).slice(-EXTERNAL_MCP_LIMITS.maxOutputArtifacts), credentialBindings: (store.credentialBindings ?? []).slice(-EXTERNAL_MCP_LIMITS.maxCredentialBindings), credentialEvidence: (store.credentialEvidence ?? []).slice(-EXTERNAL_MCP_LIMITS.maxCredentialEvidence), policyEvidence: (store.policyEvidence ?? []).slice(-EXTERNAL_MCP_LIMITS.maxPolicyEvidence), brokerExecutions: (store.brokerExecutions ?? []).slice(-EXTERNAL_MCP_LIMITS.maxBrokerExecutions) })
  if (byteLength(serialized) > EXTERNAL_MCP_LIMITS.maxManifestBytes * EXTERNAL_MCP_LIMITS.maxManifests) return failure('persistence_failed', 'External MCP intake store exceeds its bounded persistence size.')
  let temp: string | undefined
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
    fs.writeFileSync(temp, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); options.persistenceHook?.(approval ? 'before-approval-rename' : 'before-rename'); fs.renameSync(temp, target); temp = undefined; fs.chmodSync(target, 0o600); return { ok: true, value: true }
  } catch { return failure('persistence_failed', 'External MCP intake persistence failed before a complete atomic commit.') }
  finally { if (temp) try { fs.unlinkSync(temp) } catch { /* best-effort cleanup of this unique temp file */ } }
}
function currentLifecycle(entries: readonly ExternalMcpManifestEntry[], drifted: boolean): ExternalMcpManifestLifecycle { if (entries.some(entry => entry.lifecycle === 'unavailable' || entry.lifecycle === 'removed')) return 'unavailable'; if (drifted) return 'drifted'; return entries.some(entry => entry.approval.state === 'approved') ? 'approved_entries' : 'candidate' }
function projection(manifest: ExternalMcpManifest): ExternalMcpIntakeProjection { return { operation: 'static-intake', server: manifest.server.configuredServerId, transport: manifest.server.transport, toolsDiscovered: manifest.entries.filter(entry => entry.kind === 'tool' && entry.lifecycle !== 'unavailable').length, resourcesDiscovered: manifest.entries.filter(entry => entry.kind === 'resource' && entry.lifecycle !== 'unavailable').length, approved: manifest.entries.filter(entry => entry.approval.state === 'approved' && entry.lifecycle === 'approved').length, pending: manifest.entries.filter(entry => entry.approval.state === 'pending' && entry.lifecycle === 'candidate').length, drift: manifest.lifecycle === 'drifted' ? 'present' : 'none', unavailable: manifest.entries.filter(entry => entry.lifecycle === 'unavailable' || entry.lifecycle === 'removed').length, executionEnabled: 'NO', manifestId: manifest.manifestId, lifecycle: manifest.lifecycle } }

export function getExternalMcpIntakeStorePath(options: ExternalMcpIntakeOptions = {}): string | undefined { const result = storePath(options); return typeof result === 'string' ? result : undefined }
export function externalMcpManifestDigest(manifest: Omit<ExternalMcpManifest, 'manifestDigest'>): string { return manifestDigest(manifest) }
export function buildExternalMcpProjection(manifest: ExternalMcpManifest): ExternalMcpIntakeProjection { return projection(manifest) }

export function intakeExternalMcpSnapshot(reference: ExternalMcpServerReference, snapshot: ExternalMcpStaticDiscoverySnapshot, options: ExternalMcpIntakeOptions = {}): ExternalMcpIntakeResult<{ manifest: ExternalMcpManifest; projection: ExternalMcpIntakeProjection; staticDiscoveryDigest: string }> {
  const referenceError = validateReference(reference); if (referenceError) return referenceError
  const snapshotError = validateSnapshot(snapshot); if (snapshotError) return snapshotError
  const authority = serverAuthority(reference); const storeResult = readStore(options, reference.ownerId); if (!storeResult.ok) return storeResult
  const store = storeResult.value; const observedAt = (options.now ?? (() => new Date()))().toISOString()
  const staticDiscoveryDigest = digest({ server: snapshot.server, tools: sorted(snapshot.tools, (a, b) => a.name.localeCompare(b.name)), resources: sorted(snapshot.resources, (a, b) => a.uri.localeCompare(b.uri)) })
  const previousExact = store.manifests.filter(item => item.server.serverIdentity === authority.identity && item.owner.ownerId === reference.ownerId && item.owner.profile === reference.profile).sort((a, b) => b.lastUpdatedAt.localeCompare(a.lastUpdatedAt))[0]
  const previousSameConfigured = store.manifests.filter(item => item.server.configuredServerId === reference.serverId && item.owner.ownerId === reference.ownerId && item.owner.profile === reference.profile).sort((a, b) => b.lastUpdatedAt.localeCompare(a.lastUpdatedAt))[0]
  const observedServerDigest = digest({ claimedId: snapshot.server.claimedId, transportHint: snapshot.server.transportHint ?? null, endpointHint: snapshot.server.endpointHint ?? null })
  const priorObservedServerDigest = previousExact ? digest({ claimedId: previousExact.server.claimedServerId, transportHint: previousExact.server.observedTransportHint ?? null, endpointHint: previousExact.server.observedEndpointHint ?? null }) : undefined
  const serverDrift = !!previousSameConfigured && (!previousExact || priorObservedServerDigest !== observedServerDigest)
  const priorEntries = new Map((previousExact?.entries ?? []).map(entry => [entry.entryId, entry]))
  const entries: ExternalMcpManifestEntry[] = []
  for (const tool of sorted(snapshot.tools, (a, b) => a.name.localeCompare(b.name))) {
    const metadata = { ...(tool.description !== undefined ? { description: tool.description } : {}), ...(tool.safety !== undefined ? { safety: tool.safety } : {}) }
    const parts = entryParts(authority.identity, 'tool', tool.name.trim(), tool.inputSchema, tool.resultSchema, tool.compatibilityVersion ?? reference.compatibilityVersion, metadata)
    const prior = priorEntries.get(parts.entryId); const carried = !serverDrift && prior?.approval.state === 'approved' && prior.materialIdentityDigest === parts.materialIdentityDigest
    entries.push({ entryId: parts.entryId, kind: 'tool', canonicalName: tool.name.trim(), intakeDigest: parts.intakeDigest, materialIdentityDigest: parts.materialIdentityDigest, declaredRequestSchemaDigest: parts.requestDigest, ...(parts.resultDigest ? { declaredResultSchemaDigest: parts.resultDigest } : {}), pinnedRequestSchema: canonicalSchema(tool.inputSchema), ...(tool.resultSchema ? { pinnedResultSchema: canonicalSchema(tool.resultSchema) } : {}), compatibilityVersion: tool.compatibilityVersion ?? reference.compatibilityVersion, metadata, approval: carried ? prior!.approval : { state: 'pending' }, lifecycle: carried ? 'approved' : serverDrift ? 'drifted' : 'candidate', executionAuthority: 'none' })
  }
  for (const resource of sorted(snapshot.resources, (a, b) => a.uri.localeCompare(b.uri))) {
    const metadata = { ...(resource.description !== undefined ? { description: resource.description } : {}), ...(resource.name !== undefined ? { displayName: resource.name } : {}), ...(resource.mimeType !== undefined ? { mimeType: resource.mimeType } : {}) }
    const parts = entryParts(authority.identity, 'resource', resource.uri.trim(), undefined, resource.resultSchema, resource.compatibilityVersion ?? reference.compatibilityVersion, metadata)
    const prior = priorEntries.get(parts.entryId); const carried = !serverDrift && prior?.approval.state === 'approved' && prior.materialIdentityDigest === parts.materialIdentityDigest
    entries.push({ entryId: parts.entryId, kind: 'resource', canonicalName: resource.name?.trim() || resource.uri.trim(), advertisedUri: resource.uri.trim(), intakeDigest: parts.intakeDigest, materialIdentityDigest: parts.materialIdentityDigest, ...(parts.resultDigest ? { declaredResultSchemaDigest: parts.resultDigest } : {}), ...(resource.resultSchema ? { pinnedResultSchema: canonicalSchema(resource.resultSchema) } : {}), compatibilityVersion: resource.compatibilityVersion ?? reference.compatibilityVersion, metadata, approval: carried ? prior!.approval : { state: 'pending' }, lifecycle: carried ? 'approved' : serverDrift ? 'drifted' : 'candidate', executionAuthority: 'none' })
  }
  if (previousExact) for (const prior of previousExact.entries) if (!entries.some(entry => entry.entryId === prior.entryId)) entries.push({ ...prior, approval: prior.approval.state === 'approved' ? { ...prior.approval, state: 'revoked' } : prior.approval, lifecycle: 'unavailable', executionAuthority: 'none' })
  const binding = policy(reference); const manifestId = manifestSemanticId(authority.identity, entries, binding)
  const base: Omit<ExternalMcpManifest, 'manifestDigest'> = { schemaVersion: EXTERNAL_MCP_INTAKE_VERSION, kind: EXTERNAL_MCP_INTAKE_KIND, manifestId, server: { serverIdentity: authority.identity, configuredServerId: reference.serverId, claimedServerId: snapshot.server.claimedId, configuredEndpointIdentity: authority.endpoint, transport: reference.transport, ownerId: reference.ownerId, profile: reference.profile, ...(reference.sourceId ? { sourceId: reference.sourceId } : {}), ...(reference.sessionId ? { sessionId: reference.sessionId } : {}), compatibilityVersion: reference.compatibilityVersion, ...(snapshot.server.transportHint ? { observedTransportHint: snapshot.server.transportHint } : {}), ...(snapshot.server.endpointHint ? { observedEndpointHint: snapshot.server.endpointHint } : {}), ...(snapshot.server.authentication ? { authenticationHints: snapshot.server.authentication } : {}), ...(snapshot.server.safety ? { safetyHints: snapshot.server.safety } : {}) }, owner: { ownerId: reference.ownerId, profile: reference.profile, ...(reference.sourceId ? { sourceId: reference.sourceId } : {}), ...(reference.sessionId ? { sessionId: reference.sessionId } : {}) }, discovery: { staticDiscoveryDigest, discoveredAt: snapshot.discoveredAt, observedAt }, entries: sorted(entries, (a, b) => a.entryId.localeCompare(b.entryId)), policy: binding, lifecycle: currentLifecycle(entries, serverDrift || (!!previousExact && digest({ entries: previousExact.entries.map(entry => ({ entryId: entry.entryId, materialIdentityDigest: entry.materialIdentityDigest })).sort() }) !== digest({ entries: entries.map(entry => ({ entryId: entry.entryId, materialIdentityDigest: entry.materialIdentityDigest })).sort() }))), lastUpdatedAt: observedAt }
  const manifest: ExternalMcpManifest = { ...base, manifestDigest: manifestDigest(base) }
  const existingIndex = store.manifests.findIndex(item => item.manifestId === manifest.manifestId); if (existingIndex >= 0) store.manifests[existingIndex] = manifest; else store.manifests.push(manifest)
  store.updatedAt = observedAt; const persisted = persistStore(store, options); if (!persisted.ok) return persisted
  return { ok: true, value: { manifest, projection: projection(manifest), staticDiscoveryDigest } }
}

export function listExternalMcpManifests(options: ExternalMcpIntakeOptions & { ownerId: string }): ExternalMcpIntakeResult<ExternalMcpManifest[]> { const result = readStore(options, options.ownerId); return result.ok ? { ok: true, value: result.value.manifests } : result }
export function listExternalMcpValidationEvidence(options: ExternalMcpIntakeOptions & { ownerId: string }): ExternalMcpIntakeResult<ExternalMcpValidationEvidence[]> {
  const result = readStore(options, options.ownerId)
  return result.ok ? { ok: true, value: [...(result.value.validationEvidence ?? [])] } : result
}
export function listExternalMcpOutputArtifacts(options: ExternalMcpIntakeOptions & { ownerId: string }): ExternalMcpIntakeResult<ExternalMcpOutputArtifactRecord[]> {
  const result = readStore(options, options.ownerId)
  return result.ok ? { ok: true, value: [...(result.value.isolatedOutputs ?? [])] } : result
}
export function listExternalMcpCredentialBindings(options: ExternalMcpIntakeOptions & { ownerId: string }): ExternalMcpIntakeResult<ExternalMcpCredentialBinding[]> {
  const result = readStore(options, options.ownerId)
  return result.ok ? { ok: true, value: [...(result.value.credentialBindings ?? [])] } : result
}
export function listExternalMcpCredentialEvidence(options: ExternalMcpIntakeOptions & { ownerId: string }): ExternalMcpIntakeResult<ExternalMcpCredentialEvidence[]> {
  const result = readStore(options, options.ownerId)
  return result.ok ? { ok: true, value: [...(result.value.credentialEvidence ?? [])] } : result
}
export function listExternalMcpPolicyEvidence(options: ExternalMcpIntakeOptions & { ownerId: string }): ExternalMcpIntakeResult<ExternalMcpPolicyEvidence[]> {
  const result = readStore(options, options.ownerId)
  return result.ok ? { ok: true, value: [...(result.value.policyEvidence ?? [])] } : result
}
export function listExternalMcpBrokerExecutions(options: ExternalMcpIntakeOptions & { ownerId: string }): ExternalMcpIntakeResult<ExternalMcpBrokerExecutionRecord[]> {
  const result = readStore(options, options.ownerId)
  return result.ok ? { ok: true, value: [...(result.value.brokerExecutions ?? [])] } : result
}
export function upsertExternalMcpBrokerExecution(input: ExternalMcpBrokerExecutionRecord, options: ExternalMcpIntakeOptions & { ownerId: string }): ExternalMcpIntakeResult<ExternalMcpBrokerExecutionRecord> {
  if (!validBrokerExecution(input) || input.ownerId !== options.ownerId) return failure('broker_execution_invalid', 'External MCP broker execution is outside the bounded owner-local contract.')
  const storeResult = readStore(options, options.ownerId); if (!storeResult.ok) return storeResult
  const store = storeResult.value; const executions = store.brokerExecutions ?? []; const index = executions.findIndex(item => item.executionId === input.executionId)
  if (index >= 0 && executions[index].semanticExecutionId !== input.semanticExecutionId) return failure('broker_execution_invalid', 'External MCP execution identity conflicts with retained semantic lineage.')
  const terminal = (value: ExternalMcpBrokerExecutionRecord): boolean => value.terminalStatus !== undefined
  if (index >= 0 && terminal(executions[index]) && (!terminal(input) || executions[index].terminalStatus !== input.terminalStatus)) return failure('broker_execution_invalid', 'Terminal external MCP execution lineage cannot be reopened or changed.')
  if (index >= 0) executions[index] = input; else executions.push(input)
  store.brokerExecutions = executions.slice(-EXTERNAL_MCP_LIMITS.maxBrokerExecutions); store.updatedAt = input.updatedAt
  const persisted = persistStore(store, options); return persisted.ok ? { ok: true, value: input } : persisted
}
export type ExternalMcpIntakeStoreMutation<T> = (store: ExternalMcpIntakeStore) => ExternalMcpIntakeResult<{ value: T; updatedAt?: string }>
export function mutateExternalMcpIntakeStore<T>(ownerId: string, options: ExternalMcpIntakeOptions, mutation: ExternalMcpIntakeStoreMutation<T>): ExternalMcpIntakeResult<T> {
  const result = readStore(options, ownerId); if (!result.ok) return result
  try {
    const changed = mutation(result.value); if (!changed.ok) return changed
    result.value.updatedAt = changed.value.updatedAt ?? result.value.updatedAt
    const persisted = persistStore(result.value, { ...options, now: options.now ?? (() => new Date(changed.value.updatedAt ?? new Date().toISOString())) })
    return persisted.ok ? { ok: true, value: changed.value.value } : persisted
  } catch { return failure('persistence_failed', 'External MCP intake mutation failed safely before an atomic commit.') }
}
export function appendExternalMcpOutputArtifact(input: ExternalMcpOutputArtifactRecord, options: ExternalMcpIntakeOptions & { ownerId: string }): ExternalMcpIntakeResult<ExternalMcpOutputArtifactRecord> {
  if (!validOutputArtifact(input) || byteLength(JSON.stringify(input)) > EXTERNAL_MCP_LIMITS.maxOutputArtifactBytes) return failure('output_invalid', 'External MCP output artifact is outside the bounded isolation contract.')
  const storeResult = readStore(options, options.ownerId); if (!storeResult.ok) return storeResult
  const store = storeResult.value; const existing = store.isolatedOutputs ?? []; const prior = existing.find(item => item.semanticIdentity === input.semanticIdentity)
  if (prior) return { ok: true, value: prior }
  existing.push(input); store.isolatedOutputs = existing.slice(-EXTERNAL_MCP_LIMITS.maxOutputArtifacts); store.updatedAt = input.createdAt
  const persisted = persistStore(store, options); return persisted.ok ? { ok: true, value: input } : persisted
}
export function appendExternalMcpValidationEvidence(input: ExternalMcpValidationEvidenceInput, options: ExternalMcpIntakeOptions & { ownerId: string }): ExternalMcpIntakeResult<ExternalMcpValidationEvidence> {
  if (!MANIFEST_ID.test(input.manifestId) || !ENTRY_ID.test(input.entryId) || !validText(input.serverIdentity, EXTERNAL_MCP_LIMITS.maxStringBytes) || !validText(input.outcome, EXTERNAL_MCP_LIMITS.maxStringBytes) || !validText(input.contentType, EXTERNAL_MCP_LIMITS.maxStringBytes) || !Number.isSafeInteger(input.byteLength) || input.byteLength < 0 || input.byteLength > EXTERNAL_MCP_LIMITS.maxResultBytes || (input.approvalId !== undefined && !APPROVAL_ID.test(input.approvalId)) || (input.schemaDigest !== undefined && !SHA256.test(input.schemaDigest)) || (input.payloadDigest !== undefined && !SHA256.test(input.payloadDigest))) return failure('evidence_invalid', 'Validation evidence is outside the bounded owner-local contract.')
  const recordedAt = input.recordedAt ?? new Date().toISOString()
  if (!iso(recordedAt) || (input.path !== undefined && !validText(input.path, EXTERNAL_MCP_LIMITS.maxStringBytes, true)) || (input.expected !== undefined && !validText(input.expected, EXTERNAL_MCP_LIMITS.maxStringBytes, true)) || (input.actual !== undefined && !validText(input.actual, EXTERNAL_MCP_LIMITS.maxStringBytes, true))) return failure('evidence_invalid', 'Validation evidence timestamp or diagnostics are invalid.')
  const identity = { ...input }; delete identity.recordedAt
  const evidenceId = `mcp-validation-${digest(identity)}`
  const evidence: ExternalMcpValidationEvidence = { ...input, evidenceId, recordedAt }
  if (!validEvidence(evidence) || byteLength(JSON.stringify(evidence)) > EXTERNAL_MCP_LIMITS.maxEvidenceBytes) return failure('evidence_invalid', 'Validation evidence exceeds its bounded persistence size.')
  const storeResult = readStore(options, options.ownerId); if (!storeResult.ok) return storeResult
  const store = storeResult.value; const existing = store.validationEvidence ?? []; if (!existing.some(item => item.evidenceId === evidence.evidenceId)) existing.push(evidence); store.validationEvidence = existing.slice(-EXTERNAL_MCP_LIMITS.maxEvidence); store.updatedAt = recordedAt
  const persisted = persistStore(store, options); return persisted.ok ? { ok: true, value: existing.find(item => item.evidenceId === evidence.evidenceId)! } : persisted
}
export function appendExternalMcpPolicyEvidence(input: Omit<ExternalMcpPolicyEvidence, 'evidenceId'> & { evidenceId?: string }, options: ExternalMcpIntakeOptions & { ownerId: string }): ExternalMcpIntakeResult<ExternalMcpPolicyEvidence> {
  const { evidenceId: _evidenceId, recordedAt: _recordedAt, ...identity } = input
  const evidence: ExternalMcpPolicyEvidence = { ...input, evidenceId: input.evidenceId ?? `mcp-policy-evidence-${digest(identity)}` }
  if (!validPolicyEvidence(evidence) || evidence.ownerId !== options.ownerId) return failure('evidence_invalid', 'Policy evidence is outside the bounded owner-local contract.')
  const storeResult = readStore(options, options.ownerId); if (!storeResult.ok) return storeResult
  const store = storeResult.value; const existing = store.policyEvidence ?? []; if (!existing.some(item => item.evidenceId === evidence.evidenceId)) existing.push(evidence); store.policyEvidence = existing.slice(-EXTERNAL_MCP_LIMITS.maxPolicyEvidence); store.updatedAt = evidence.recordedAt
  const persisted = persistStore(store, options); return persisted.ok ? { ok: true, value: existing.find(item => item.evidenceId === evidence.evidenceId)! } : persisted
}
export function approveExternalMcpEntry(input: ExternalMcpApprovalInput, options: ExternalMcpIntakeOptions & { ownerId: string }): ExternalMcpIntakeResult<ExternalMcpManifest> {
  if (input.entryId === '*' || input.entryId.toLowerCase() === 'all' || input.entryId.startsWith('server:')) return failure('wildcard_rejected', 'External MCP approval must target one exact tool/resource identity.')
  if (!MANIFEST_ID.test(input.manifestId) || !ENTRY_ID.test(input.entryId)) return failure('approval_invalid', 'External MCP approval identity is not canonical.')
  const storeResult = readStore(options, options.ownerId); if (!storeResult.ok) return storeResult; const store = storeResult.value; const index = store.manifests.findIndex(manifest => manifest.manifestId === input.manifestId); if (index < 0) return failure('manifest_not_found', 'External MCP manifest was not found.')
  const manifest = store.manifests[index]; const entry = manifest.entries.find(item => item.entryId === input.entryId); if (!entry) return failure('manifest_not_found', 'External MCP manifest entry was not found.'); if (manifest.owner.ownerId !== options.ownerId) return failure('owner_mismatch', 'External MCP manifest is owned by another owner.'); if (entry.lifecycle !== 'candidate' || entry.approval.state !== 'pending') return failure('manifest_drifted', 'Only a current pending candidate entry may be approved.')
  const bindingError = validateApprovalBinding(manifest, entry, input); if (bindingError) return failure('approval_invalid', bindingError)
  const approvalId = `mcp-approval-${digest({ manifestId: manifest.manifestId, entryId: entry.entryId, owner: manifest.owner, policyVersion: EXTERNAL_MCP_POLICY_VERSION })}`
  entry.approval = { state: 'approved', approvalId, requestId: input.requestId, approvedBy: input.approvedBy, approvedAt: input.approvedAt, bindingDigest: digest({ manifestId: manifest.manifestId, entryId: entry.entryId, policy: manifest.policy, approvalId, requestSchemaDigest: entry.declaredRequestSchemaDigest ?? null, resultSchemaDigest: entry.declaredResultSchemaDigest ?? null }), authority: 'workbench-capability-approval' }; entry.lifecycle = 'approved'; entry.executionAuthority = 'none'; manifest.lifecycle = currentLifecycle(manifest.entries, false); manifest.lastUpdatedAt = (options.now ?? (() => new Date()))().toISOString(); const manifestWithoutDigest = { ...manifest }; delete (manifestWithoutDigest as Partial<ExternalMcpManifest>).manifestDigest; manifest.manifestDigest = manifestDigest(manifestWithoutDigest as Omit<ExternalMcpManifest, 'manifestDigest'>); store.updatedAt = manifest.lastUpdatedAt
  const persisted = persistStore(store, options, true); return persisted.ok ? { ok: true, value: manifest } : persisted
}
