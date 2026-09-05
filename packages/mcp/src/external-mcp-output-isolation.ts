import crypto from 'node:crypto'
import {
  EXTERNAL_MCP_INTAKE_VERSION,
  EXTERNAL_MCP_LIMITS,
  EXTERNAL_MCP_POLICY_VERSION,
  appendExternalMcpOutputArtifact,
  type ExternalMcpIntakeOptions,
  type ExternalMcpJsonValue,
  type ExternalMcpManifestEntry,
  type ExternalMcpOutputArtifactRecord,
  type ExternalMcpValidationEvidence,
  listExternalMcpOutputArtifacts
} from './external-mcp-intake.js'
import {
  EXTERNAL_MCP_SCHEMA_VALIDATION_VERSION,
  validateExternalMcpResult,
  type ExternalMcpContentType,
  type ExternalMcpResultValidationInput,
  type ExternalMcpValidationResult,
  type ExternalMcpValidationTarget
} from './external-mcp-schema-validation.js'
import { redactCapabilityValue } from './capability-runtime-enforcement.js'

export const EXTERNAL_MCP_OUTPUT_ISOLATION_VERSION = 1 as const
export const EXTERNAL_MCP_OUTPUT_LIMITS = {
  maxProjectionBytes: EXTERNAL_MCP_LIMITS.maxOutputArtifactBytes,
  maxNodes: EXTERNAL_MCP_LIMITS.maxSchemaNodes,
  maxDepth: EXTERNAL_MCP_LIMITS.maxSchemaDepth,
  maxArrayItems: 128,
  maxObjectProperties: 64,
  maxBlocks: 16,
  maxTextBytes: EXTERNAL_MCP_LIMITS.maxStringBytes
} as const

export type ExternalMcpOutputTrustClass = 'EXTERNAL_UNTRUSTED_DATA'
export type ExternalMcpOutputContentKind = 'text' | 'json' | 'blocks'
export type ExternalMcpOutputIsolationState = ExternalMcpOutputArtifactRecord['state']
export type ExternalMcpOutputIsolationOutcome =
  | 'OUTPUT_ISOLATED'
  | 'OUTPUT_REDACTED'
  | 'OUTPUT_PROJECTION_BOUNDED'
  | 'UNSUPPORTED_OUTPUT_KIND'
  | 'OUTPUT_TOO_LARGE'
  | 'PROVENANCE_MISMATCH'
  | 'RESULT_IDENTITY_MISMATCH'
  | 'R22_2_VALIDATION_REQUIRED'
  | 'OUTPUT_PERSISTENCE_FAILED'

export type ExternalMcpOutputIsolationInput = {
  result: ExternalMcpValidationResult
  target: ExternalMcpValidationTarget
  contentKind?: ExternalMcpOutputContentKind
  runtimeIdentity?: string
}

export type ExternalMcpOutputArtifact = Readonly<ExternalMcpOutputArtifactRecord>
export type ExternalMcpModelProjection = Readonly<{
  boundary: 'external-mcp-output'
  trustClass: ExternalMcpOutputTrustClass
  contentKind: ExternalMcpOutputContentKind
  provenance: ExternalMcpOutputArtifact['provenance']
  content: ExternalMcpJsonValue
  bounds: ExternalMcpOutputArtifact['bounds']
  redaction: ExternalMcpOutputArtifact['redaction']
  authority: 'none'
}>
export type ExternalMcpHumanProjection = Readonly<{
  title: 'External MCP result'
  server: string
  entry: string
  validation: 'PASS'
  trust: 'EXTERNAL / UNTRUSTED'
  content: string
  followUpExecuted: 'NO'
  authority: 'none'
}>
export type ExternalMcpOutputIsolationSuccess = {
  ok: true
  outcome: Extract<ExternalMcpOutputIsolationOutcome, 'OUTPUT_ISOLATED' | 'OUTPUT_REDACTED' | 'OUTPUT_PROJECTION_BOUNDED'>
  artifact: ExternalMcpOutputArtifact
  modelProjection: ExternalMcpModelProjection
  humanProjection: ExternalMcpHumanProjection
}
export type ExternalMcpOutputIsolationFailure = {
  ok: false
  outcome: Exclude<ExternalMcpOutputIsolationOutcome, 'OUTPUT_ISOLATED' | 'OUTPUT_REDACTED' | 'OUTPUT_PROJECTION_BOUNDED'>
  issues: readonly string[]
}
export type ExternalMcpOutputIsolationResult = ExternalMcpOutputIsolationSuccess | ExternalMcpOutputIsolationFailure

type BoundState = { nodes: number; truncated: boolean; blockCount: number }
type RecordValue = Record<string, unknown>
const SHA256 = /^[a-f0-9]{64}$/
const CONTENT_TYPES: readonly ExternalMcpContentType[] = ['application/json', 'text/plain', 'application/octet-stream']
const BLOCK_TYPES = new Set(['text', 'json', 'resource', 'resource_link', 'image'])

function record(value: unknown): value is RecordValue { return !!value && typeof value === 'object' && !Array.isArray(value) }
function bytes(value: string): number { return Buffer.byteLength(value, 'utf8') }
function canonical(value: unknown, seen = new Set<object>()): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('non-finite'); return JSON.stringify(value) }
  if (typeof value !== 'object' || seen.has(value)) throw new Error('unsupported-json')
  seen.add(value)
  try {
    if (Array.isArray(value)) return `[${value.map(item => canonical(item, seen)).join(',')}]`
    const object = value as RecordValue
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key], seen)}`).join(',')}}`
  } finally { seen.delete(value) }
}
function digest(value: unknown): string { return crypto.createHash('sha256').update(canonical(value), 'utf8').digest('hex') }
function issue(value: string): ExternalMcpOutputIsolationFailure { return { ok: false, outcome: 'PROVENANCE_MISMATCH', issues: [value] } }
function truncateText(value: string): string {
  if (bytes(value) <= EXTERNAL_MCP_OUTPUT_LIMITS.maxTextBytes) return value
  let result = ''; let size = 0
  for (const character of value) { const next = bytes(character); if (size + next > EXTERNAL_MCP_OUTPUT_LIMITS.maxTextBytes) break; result += character; size += next }
  return result
}
function boundValue(value: unknown, depth: number, state: BoundState): ExternalMcpJsonValue {
  state.nodes += 1
  if (depth > EXTERNAL_MCP_OUTPUT_LIMITS.maxDepth || state.nodes > EXTERNAL_MCP_OUTPUT_LIMITS.maxNodes) { state.truncated = true; return null }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') { const bounded = truncateText(value); state.truncated ||= bounded !== value; return bounded }
  if (Array.isArray(value)) {
    const items = value.slice(0, EXTERNAL_MCP_OUTPUT_LIMITS.maxArrayItems).map(item => boundValue(item, depth + 1, state))
    if (value.length > EXTERNAL_MCP_OUTPUT_LIMITS.maxArrayItems) state.truncated = true
    return items
  }
  if (record(value)) {
    const keys = Object.keys(value).sort(); const output: Record<string, ExternalMcpJsonValue> = {}
    for (const key of keys.slice(0, EXTERNAL_MCP_OUTPUT_LIMITS.maxObjectProperties)) Object.defineProperty(output, key, { value: boundValue(value[key], depth + 1, state), enumerable: true, configurable: true, writable: true })
    if (keys.length > EXTERNAL_MCP_OUTPUT_LIMITS.maxObjectProperties) state.truncated = true
    return output
  }
  state.truncated = true
  return null
}
function countRedaction(before: unknown, after: unknown): number {
  try { return canonical(before) === canonical(after) ? 0 : 1 } catch { return 1 }
}
function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (!value || typeof value !== 'object' || seen.has(value as object)) return value
  seen.add(value as object)
  for (const child of Object.values(value as RecordValue)) deepFreeze(child, seen)
  return Object.freeze(value)
}
function entryFor(target: ExternalMcpValidationTarget): ExternalMcpManifestEntry | undefined {
  return target.manifest.entries.find(item => item.entryId === target.entryId)
}
function evidenceMatches(result: ExternalMcpValidationResult, target: ExternalMcpValidationTarget): boolean {
  const evidence = result.evidence as ExternalMcpValidationEvidence | undefined
  return !!evidence
    && evidence.kind === 'result'
    && evidence.outcome === 'RESULT_VALID'
    && evidence.manifestId === target.manifestId
    && evidence.serverIdentity === target.serverIdentity
    && evidence.entryId === target.entryId
    && evidence.approvalId === target.approvalId
    && evidence.schemaDigest === result.schemaDigest
    && evidence.payloadDigest !== undefined
    && evidence.payloadDigest === result.payloadDigest
    && result.resultDigest !== undefined
}
type VerifiedR22Result = { ok: true; result: ExternalMcpValidationResult } | ExternalMcpOutputIsolationFailure
function verifyR22Result(input: ExternalMcpOutputIsolationInput, options: ExternalMcpOutputIsolationOptions): VerifiedR22Result {
  const { result, target } = input
  const entry = entryFor(target)
  if (options.ownerId !== target.manifest.owner.ownerId || options.ownerId !== target.manifest.server.ownerId || target.manifest.owner.ownerId !== target.manifest.server.ownerId || !entry || entry.kind !== 'tool' && entry.kind !== 'resource') return issue('owner_or_entry_mismatch')
  if (!result.ok || result.outcome !== 'RESULT_VALID') return { ok: false, outcome: 'R22_2_VALIDATION_REQUIRED', issues: ['exact_result_valid_required'] }
  if (result.manifestId !== target.manifestId || result.serverIdentity !== target.serverIdentity || result.entryId !== target.entryId || result.approvalId !== target.approvalId || result.schemaDigest !== entry.declaredResultSchemaDigest) return issue('result_target_mismatch')
  if (!SHA256.test(result.resultDigest ?? '') || !evidenceMatches(result, target) || result.value === undefined) return { ok: false, outcome: 'R22_2_VALIDATION_REQUIRED', issues: ['exact_result_valid_with_evidence_required'] }
  if (!CONTENT_TYPES.includes(result.contentType as ExternalMcpContentType)) return { ok: false, outcome: 'R22_2_VALIDATION_REQUIRED', issues: ['unsupported_validation_content_type'] }
  const revalidatedPayload = result.contentType === 'application/json' ? JSON.stringify(result.value) : result.value
  const revalidatedInput: ExternalMcpResultValidationInput = { ...target, payload: revalidatedPayload, contentType: result.contentType as ExternalMcpContentType }
  const revalidated = validateExternalMcpResult(revalidatedInput, options)
  if (!revalidated.ok || revalidated.outcome !== 'RESULT_VALID') return { ok: false, outcome: 'R22_2_VALIDATION_REQUIRED', issues: ['result_revalidation_failed'] }
  if (revalidated.resultDigest !== result.resultDigest || revalidated.schemaDigest !== result.schemaDigest) return { ok: false, outcome: 'RESULT_IDENTITY_MISMATCH', issues: ['result_digest_mismatch'] }
  return { ok: true, result }
}
function normalizeContent(value: unknown, kind: ExternalMcpOutputContentKind, state: BoundState): ExternalMcpJsonValue | ExternalMcpOutputIsolationFailure {
  if (kind === 'text' && typeof value !== 'string') return { ok: false, outcome: 'UNSUPPORTED_OUTPUT_KIND', issues: ['text_content_requires_string'] }
  if (kind === 'blocks') {
    if (!Array.isArray(value)) return { ok: false, outcome: 'UNSUPPORTED_OUTPUT_KIND', issues: ['blocks_content_requires_array'] }
    if (value.length > EXTERNAL_MCP_OUTPUT_LIMITS.maxBlocks) return { ok: false, outcome: 'OUTPUT_TOO_LARGE', issues: ['content_block_limit'] }
    state.blockCount = value.length
    for (const block of value) if (!record(block) || typeof block.type !== 'string' || !BLOCK_TYPES.has(block.type)) return { ok: false, outcome: 'UNSUPPORTED_OUTPUT_KIND', issues: ['unsupported_content_block_type'] }
  }
  return value as ExternalMcpJsonValue
}
function isIsolationFailure(value: ExternalMcpJsonValue | ExternalMcpOutputIsolationFailure): value is ExternalMcpOutputIsolationFailure { return record(value) && value.ok === false && Array.isArray(value.issues) }
function projectionFor(artifact: ExternalMcpOutputArtifact): ExternalMcpModelProjection {
  return deepFreeze({ boundary: 'external-mcp-output', trustClass: artifact.trustClass, contentKind: artifact.contentKind, provenance: artifact.provenance, content: artifact.content, bounds: artifact.bounds, redaction: artifact.redaction, authority: 'none' })
}
export function buildExternalMcpHumanProjection(artifact: ExternalMcpOutputArtifact): ExternalMcpHumanProjection {
  return deepFreeze({ title: 'External MCP result', server: artifact.provenance.serverIdentity, entry: artifact.provenance.entryId, validation: 'PASS', trust: 'EXTERNAL / UNTRUSTED', content: JSON.stringify(artifact.content), followUpExecuted: 'NO', authority: 'none' })
}
export function buildExternalMcpModelProjection(artifact: ExternalMcpOutputArtifact): ExternalMcpModelProjection { return projectionFor(artifact) }
export function isolateExternalMcpResult(input: ExternalMcpOutputIsolationInput, options: ExternalMcpOutputIsolationOptions): ExternalMcpOutputIsolationResult {
  const verified = verifyR22Result(input, options)
  if (!verified.ok) return verified
  const result = verified.result
  const kind = input.contentKind ?? (result.contentType === 'text/plain' ? 'text' : 'json')
  const state: BoundState = { nodes: 0, truncated: false, blockCount: 0 }
  const normalized = normalizeContent(result.value, kind, state)
  if (isIsolationFailure(normalized)) return normalized
  const redacted = redactCapabilityValue(normalized)
  const bounded = boundValue(redacted, 0, state)
  let projectedBytes = bytes(canonical(bounded));
  if (projectedBytes > EXTERNAL_MCP_OUTPUT_LIMITS.maxProjectionBytes) { state.truncated = true; projectedBytes = bytes(canonical(null)) }
  const content = state.truncated && projectedBytes === bytes(canonical(null)) ? null : bounded
  const redactionCount = countRedaction(normalized, redacted)
  const redaction = { applied: redactionCount ? 'YES' as const : 'NO' as const, class: redactionCount ? 'secret' as const : 'none' as const, count: redactionCount }
  const bounds = { originalResultBytes: result.byteLength, projectedBytes, nodeCount: state.nodes, blockCount: state.blockCount, projectionTruncated: state.truncated ? 'YES' as const : 'NO' as const }
  const provenance = { serverIdentity: input.target.serverIdentity, manifestId: input.target.manifestId, entryId: input.target.entryId, approvalId: input.target.approvalId, ...(result.requestDigest ? { requestDigest: result.requestDigest } : {}), resultDigest: result.resultDigest!, pinnedResultSchemaDigest: result.schemaDigest!, contentType: result.contentType, validationVersion: EXTERNAL_MCP_SCHEMA_VALIDATION_VERSION, intakeVersion: EXTERNAL_MCP_INTAKE_VERSION, policyVersion: EXTERNAL_MCP_POLICY_VERSION, outputIsolationVersion: EXTERNAL_MCP_OUTPUT_ISOLATION_VERSION, runtimeIdentity: input.runtimeIdentity ?? 'workbench-mcp-local', recordedAt: (options.now ?? (() => new Date()))().toISOString() }
  const projectionDigest = digest({ contentKind: kind, content })
  const semanticIdentity = digest({ serverIdentity: provenance.serverIdentity, manifestId: provenance.manifestId, entryId: provenance.entryId, approvalId: provenance.approvalId, requestDigest: provenance.requestDigest ?? null, resultDigest: provenance.resultDigest, pinnedResultSchemaDigest: provenance.pinnedResultSchemaDigest, contentType: provenance.contentType, validationVersion: provenance.validationVersion, intakeVersion: provenance.intakeVersion, policyVersion: provenance.policyVersion, outputIsolationVersion: provenance.outputIsolationVersion, contentKind: kind, projectionDigest, redaction, projectionTruncated: bounds.projectionTruncated })
  const artifact: ExternalMcpOutputArtifact = deepFreeze({ artifactId: `mcp-output-${semanticIdentity}`, semanticIdentity, trustClass: 'EXTERNAL_UNTRUSTED_DATA', contentKind: kind, content, provenance, bounds, redaction, authority: 'none', state: state.truncated ? 'OUTPUT_PROJECTION_BOUNDED' : redactionCount ? 'OUTPUT_REDACTED' : 'OUTPUT_ISOLATED', createdAt: provenance.recordedAt })
  const persisted = appendExternalMcpOutputArtifact(artifact, options)
  if (!persisted.ok) return { ok: false, outcome: 'OUTPUT_PERSISTENCE_FAILED', issues: [persisted.code] }
  const saved = deepFreeze(persisted.value)
  return { ok: true, outcome: saved.state, artifact: saved, modelProjection: projectionFor(saved), humanProjection: buildExternalMcpHumanProjection(saved) }
}
export function listIsolatedExternalMcpResults(options: ExternalMcpIntakeOptions & { ownerId: string }): ReturnType<typeof listExternalMcpOutputArtifacts> { return listExternalMcpOutputArtifacts(options) }
export type ExternalMcpOutputIsolationOptions = ExternalMcpIntakeOptions & { ownerId: string }
