import { Ajv, type ValidateFunction } from 'ajv'

export const WORKBENCH_SYNC_CONTRACT_VERSION = '1' as const
export const WORKBENCH_SYNC_ENVELOPE_KIND = 'workbench.sync.envelope' as const
export const WORKBENCH_SYNC_MANIFEST_KIND = 'workbench.sync.manifest' as const

export const WORKBENCH_SYNC_SCOPE_VALUES = ['run_state', 'routing_metadata', 'device_health', 'approval_state'] as const
export type WorkbenchSyncScope = typeof WORKBENCH_SYNC_SCOPE_VALUES[number]

export const WORKBENCH_SYNC_DIRECTION_VALUES = ['push', 'pull', 'bidirectional'] as const
export type WorkbenchSyncDirection = typeof WORKBENCH_SYNC_DIRECTION_VALUES[number]

export type WorkbenchSyncEnvelope = {
  kind: typeof WORKBENCH_SYNC_ENVELOPE_KIND
  contractVersion: typeof WORKBENCH_SYNC_CONTRACT_VERSION
  envelopeId: string
  sourceDeviceId: string
  targetDeviceId: string
  scope: WorkbenchSyncScope
  direction: WorkbenchSyncDirection
  encryptedPayloadB64: string
  payloadSha256: string
  payloadSizeBytes: number
  nonce: string
  createdAt: string
  expiresAt: string
}

export type WorkbenchSyncManifest = {
  kind: typeof WORKBENCH_SYNC_MANIFEST_KIND
  contractVersion: typeof WORKBENCH_SYNC_CONTRACT_VERSION
  manifestId: string
  deviceId: string
  allowedScopes: WorkbenchSyncScope[]
  maxPayloadBytes: number
  retentionMs: number
  createdAt: string
}

export const WORKBENCH_SYNC_FORBIDDEN_SCOPES = ['secrets', 'credentials', 'full_repository', 'worktree_contents'] as const

type JsonSchema = Record<string, unknown>
const boundedString = (maxLength: number): JsonSchema => ({ type: 'string', minLength: 1, maxLength })

export const WORKBENCH_SYNC_ENVELOPE_SCHEMA: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Workbench Sync Envelope',
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'contractVersion', 'envelopeId', 'sourceDeviceId', 'targetDeviceId', 'scope', 'direction', 'encryptedPayloadB64', 'payloadSha256', 'payloadSizeBytes', 'nonce', 'createdAt', 'expiresAt'],
  properties: {
    kind: { const: WORKBENCH_SYNC_ENVELOPE_KIND },
    contractVersion: { const: WORKBENCH_SYNC_CONTRACT_VERSION },
    envelopeId: boundedString(128),
    sourceDeviceId: boundedString(128),
    targetDeviceId: boundedString(128),
    scope: { enum: [...WORKBENCH_SYNC_SCOPE_VALUES] },
    direction: { enum: [...WORKBENCH_SYNC_DIRECTION_VALUES] },
    encryptedPayloadB64: boundedString(1048576),
    payloadSha256: boundedString(64),
    payloadSizeBytes: { type: 'integer', minimum: 1, maximum: 1048576 },
    nonce: boundedString(64),
    createdAt: boundedString(64),
    expiresAt: boundedString(64)
  }
}

export const WORKBENCH_SYNC_MANIFEST_SCHEMA: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Workbench Sync Manifest',
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'contractVersion', 'manifestId', 'deviceId', 'allowedScopes', 'maxPayloadBytes', 'retentionMs', 'createdAt'],
  properties: {
    kind: { const: WORKBENCH_SYNC_MANIFEST_KIND },
    contractVersion: { const: WORKBENCH_SYNC_CONTRACT_VERSION },
    manifestId: boundedString(128),
    deviceId: boundedString(128),
    allowedScopes: { type: 'array', items: { enum: [...WORKBENCH_SYNC_SCOPE_VALUES] } },
    maxPayloadBytes: { type: 'integer', minimum: 1, maximum: 1048576 },
    retentionMs: { type: 'integer', minimum: 1000 },
    createdAt: boundedString(64)
  }
}

let envelopeValidator: ValidateFunction | undefined
let manifestValidator: ValidateFunction | undefined

function getEnvelopeValidator(): ValidateFunction {
  if (!envelopeValidator) {
    const ajv = new Ajv({ strict: false, allErrors: true })
    envelopeValidator = ajv.compile(WORKBENCH_SYNC_ENVELOPE_SCHEMA)
  }
  return envelopeValidator
}

function getManifestValidator(): ValidateFunction {
  if (!manifestValidator) {
    const ajv = new Ajv({ strict: false, allErrors: true })
    manifestValidator = ajv.compile(WORKBENCH_SYNC_MANIFEST_SCHEMA)
  }
  return manifestValidator
}

export function validateSyncEnvelope(
  input: unknown
): { valid: true; envelope: WorkbenchSyncEnvelope } | { valid: false; errors: string[] } {
  const validate = getEnvelopeValidator()
  if (validate(input)) return { valid: true, envelope: input as WorkbenchSyncEnvelope }
  return { valid: false, errors: (validate.errors ?? []).map(e => `${e.instancePath} ${e.message ?? ''}`.trim()) }
}

export function validateSyncManifest(
  input: unknown
): { valid: true; manifest: WorkbenchSyncManifest } | { valid: false; errors: string[] } {
  const validate = getManifestValidator()
  if (validate(input)) return { valid: true, manifest: input as WorkbenchSyncManifest }
  return { valid: false, errors: (validate.errors ?? []).map(e => `${e.instancePath} ${e.message ?? ''}`.trim()) }
}

export type WorkbenchSyncState = {
  manifests: Map<string, WorkbenchSyncManifest>
  envelopes: Map<string, WorkbenchSyncEnvelope>
  maxEnvelopes: number
}

export function createSyncState(maxEnvelopes = 100): WorkbenchSyncState {
  return { manifests: new Map(), envelopes: new Map(), maxEnvelopes }
}

export function registerSyncManifest(
  state: WorkbenchSyncState,
  manifest: WorkbenchSyncManifest
): { registered: true } | { registered: false; reason: string } {
  const validation = validateSyncManifest(manifest)
  if (!validation.valid) return { registered: false, reason: `invalid_manifest: ${validation.errors.join(', ')}` }
  if (manifest.allowedScopes.length === 0) return { registered: false, reason: 'no_scopes_allowed' }
  if (manifest.allowedScopes.some(isForbiddenScope)) return { registered: false, reason: 'forbidden_scope_requested' }
  state.manifests.set(manifest.deviceId, manifest)
  return { registered: true }
}

export function submitSyncEnvelope(
  state: WorkbenchSyncState,
  envelope: WorkbenchSyncEnvelope
): { accepted: true } | { accepted: false; reason: string } {
  const validation = validateSyncEnvelope(envelope)
  if (!validation.valid) return { accepted: false, reason: `invalid_envelope: ${validation.errors.join(', ')}` }
  const targetManifest = state.manifests.get(envelope.targetDeviceId)
  if (!targetManifest) return { accepted: false, reason: 'target_device_no_manifest' }
  if (!targetManifest.allowedScopes.includes(envelope.scope)) {
    return { accepted: false, reason: `scope_not_allowed: ${envelope.scope}` }
  }
  if (envelope.payloadSizeBytes > targetManifest.maxPayloadBytes) {
    return { accepted: false, reason: 'payload_exceeds_max_size' }
  }
  if (state.envelopes.has(envelope.envelopeId)) return { accepted: false, reason: 'envelope_id_already_exists' }
  if (envelope.sourceDeviceId === envelope.targetDeviceId) {
    return { accepted: false, reason: 'cannot_sync_to_self' }
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.encryptedPayloadB64)) return { accepted: false, reason: 'invalid_payload_encoding' }
  if (!/^[a-fA-F0-9]{64}$/.test(envelope.payloadSha256)) return { accepted: false, reason: 'invalid_payload_hash' }
  const createdAt = new Date(envelope.createdAt).getTime()
  const expiresAt = new Date(envelope.expiresAt).getTime()
  if (isNaN(createdAt) || isNaN(expiresAt) || expiresAt <= createdAt) return { accepted: false, reason: 'invalid_envelope_expiry' }
  if (expiresAt - createdAt > targetManifest.retentionMs) return { accepted: false, reason: 'envelope_retention_exceeded' }
  if (state.envelopes.size >= state.maxEnvelopes) {
    return { accepted: false, reason: 'envelope_limit_reached' }
  }
  state.envelopes.set(envelope.envelopeId, envelope)
  return { accepted: true }
}

export function expireEnvelopes(
  state: WorkbenchSyncState,
  nowIso: string
): { expiredCount: number } {
  const now = new Date(nowIso).getTime()
  let expiredCount = 0
  for (const [id, envelope] of state.envelopes) {
    const expiresAt = new Date(envelope.expiresAt).getTime()
    if (!isNaN(now) && !isNaN(expiresAt) && now >= expiresAt) {
      state.envelopes.delete(id)
      expiredCount++
    }
  }
  return { expiredCount }
}

export function listPendingEnvelopes(
  state: WorkbenchSyncState,
  targetDeviceId: string
): WorkbenchSyncEnvelope[] {
  return [...state.envelopes.values()].filter(e => e.targetDeviceId === targetDeviceId)
}

export function isForbiddenScope(scope: string): boolean {
  return (WORKBENCH_SYNC_FORBIDDEN_SCOPES as readonly string[]).includes(scope)
}
