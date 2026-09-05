import crypto from 'node:crypto'
import {
  EXTERNAL_MCP_INTAKE_KIND,
  EXTERNAL_MCP_INTAKE_VERSION,
  EXTERNAL_MCP_LIMITS,
  EXTERNAL_MCP_POLICY_VERSION,
  appendExternalMcpValidationEvidence,
  type ExternalMcpIntakeOptions,
  type ExternalMcpJsonObject,
  type ExternalMcpManifest,
  type ExternalMcpManifestEntry,
  type ExternalMcpValidationEvidence
} from './external-mcp-intake.js'

export const EXTERNAL_MCP_SCHEMA_VALIDATION_VERSION = 1 as const
export const EXTERNAL_MCP_SCHEMA_LIMITS = {
  maxBytes: EXTERNAL_MCP_LIMITS.maxSchemaBytes,
  maxNodes: EXTERNAL_MCP_LIMITS.maxSchemaNodes,
  maxDepth: EXTERNAL_MCP_LIMITS.maxSchemaDepth,
  maxProperties: EXTERNAL_MCP_LIMITS.maxSchemaProperties,
  maxUnionBranches: 0,
  maxRefs: 0,
  maxStringBytes: EXTERNAL_MCP_LIMITS.maxStringBytes,
  maxArrayItems: 128,
  maxObjectProperties: 64,
  maxIssues: EXTERNAL_MCP_LIMITS.maxValidationIssues
} as const

export type ExternalMcpSupportedSchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
export type ExternalMcpSchemaPrimitive = null | boolean | number | string
export type ExternalMcpSupportedSchema = {
  type: ExternalMcpSupportedSchemaType
  properties?: Record<string, ExternalMcpSupportedSchema>
  required?: string[]
  additionalProperties: false
  items?: ExternalMcpSupportedSchema
  enum?: ExternalMcpSchemaPrimitive[]
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  minItems?: number
  maxItems?: number
}

export type ExternalMcpValidationOutcome =
  | 'REQUEST_VALID' | 'REQUEST_SCHEMA_REJECTED' | 'REQUEST_TOO_LARGE'
  | 'RESULT_VALID' | 'RESULT_SCHEMA_REJECTED' | 'SCHEMA_DRIFT'
  | 'SCHEMA_MATCH' | 'MALFORMED_JSON' | 'UNSUPPORTED_CONTENT_TYPE'
  | 'OUTPUT_TOO_LARGE' | 'DEPTH_LIMIT_EXCEEDED' | 'INVALID_ENCODING'
  | 'TRUNCATED_RESULT' | 'UNAPPROVED_ENTRY' | 'ENTRY_UNAVAILABLE'
  | 'IDENTITY_MISMATCH' | 'PINNED_SCHEMA_UNAVAILABLE'
  | 'UNSUPPORTED_SCHEMA_FEATURE' | 'SCHEMA_COMPLEXITY_LIMIT'
  | 'EVIDENCE_PERSISTENCE_FAILED'

export type ExternalMcpContentType = 'application/json' | 'text/plain' | 'application/octet-stream'
export type ExternalMcpValidationOptions = ExternalMcpIntakeOptions & { ownerId: string }
export type ExternalMcpValidationTarget = {
  manifest: ExternalMcpManifest
  manifestId: string
  serverIdentity: string
  entryId: string
  approvalId: string
}
export type ExternalMcpRequestValidationInput = ExternalMcpValidationTarget & {
  payload: unknown
  contentType?: ExternalMcpContentType
  advertisedSchema?: ExternalMcpJsonObject
}
export type ExternalMcpResultValidationInput = ExternalMcpValidationTarget & {
  payload: unknown
  contentType: ExternalMcpContentType
  complete?: boolean
  advertisedSchema?: ExternalMcpJsonObject
}
export type ExternalMcpValidationIssue = { path: string; code: string; expected?: string; actual?: string }
export type ExternalMcpValidationResult = {
  ok: boolean
  outcome: ExternalMcpValidationOutcome
  manifestId: string
  serverIdentity: string
  entryId: string
  approvalId?: string
  schemaDigest?: string
  payloadDigest?: string
  requestDigest?: string
  resultDigest?: string
  contentType: string
  byteLength: number
  value?: unknown
  issues: ExternalMcpValidationIssue[]
  evidence?: ExternalMcpValidationEvidence
}

type RecordValue = Record<string, unknown>
type SchemaInspection = { ok: true; schema: ExternalMcpSupportedSchema; canonical: string; digest: string } | { ok: false; outcome: 'UNSUPPORTED_SCHEMA_FEATURE' | 'SCHEMA_COMPLEXITY_LIMIT'; issues: ExternalMcpValidationIssue[] }
type ResolvedTarget = { ok: true; entry: ExternalMcpManifestEntry; requestSchema?: SchemaInspection; resultSchema?: SchemaInspection } | { ok: false; outcome: 'UNAPPROVED_ENTRY' | 'ENTRY_UNAVAILABLE' | 'IDENTITY_MISMATCH' | 'PINNED_SCHEMA_UNAVAILABLE'; issues: ExternalMcpValidationIssue[] }

const SCHEMA_KEYS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems'])
const SCHEMA_TYPES: readonly ExternalMcpSupportedSchemaType[] = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
const SHA256 = /^[a-f0-9]{64}$/
const MANIFEST_ID = /^mcp-manifest-[a-f0-9]{64}$/
const ENTRY_ID = /^mcp-entry-[a-f0-9]{64}$/
const APPROVAL_ID = /^mcp-approval-[a-f0-9]{64}$/

function record(value: unknown): value is RecordValue { return !!value && typeof value === 'object' && !Array.isArray(value) }
function bytes(value: string): number { return Buffer.byteLength(value, 'utf8') }
function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('non-finite'); return JSON.stringify(value) }
  if (typeof value !== 'object' || seen.has(value)) throw new Error('unsupported-json')
  seen.add(value)
  try {
    if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item, seen)).join(',')}]`
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as RecordValue)[key], seen)}`).join(',')}}`
  } finally { seen.delete(value) }
}
function digest(value: unknown): string { return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex') }
function safePayloadDigest(value: unknown): string | undefined {
  try { if (value instanceof Uint8Array) return crypto.createHash('sha256').update(value).digest('hex'); if ((Array.isArray(value) || record(value)) && valueShapeIssue(value)) return undefined; return digest(value) } catch { return undefined }
}
function issue(path: string, code: string, expected?: string, actual?: string): ExternalMcpValidationIssue { return { path, code, ...(expected ? { expected } : {}), ...(actual ? { actual } : {}) } }
function validPrimitive(value: unknown): value is ExternalMcpSchemaPrimitive { return value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) }
function integer(value: unknown, max: number): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max }

function inspectSchema(value: unknown, currentPath = '$', depth = 0, state = { nodes: 0, properties: 0 }): SchemaInspection {
  const problems: ExternalMcpValidationIssue[] = []
  const visit = (current: unknown, path: string, level: number): ExternalMcpSupportedSchema | undefined => {
    state.nodes += 1
    if (state.nodes > EXTERNAL_MCP_SCHEMA_LIMITS.maxNodes || level > EXTERNAL_MCP_SCHEMA_LIMITS.maxDepth) { problems.push(issue(path, 'schema_complexity')); return undefined }
    if (!record(current)) { problems.push(issue(path, 'schema_shape', 'object', typeof current)); return undefined }
    for (const key of Object.keys(current)) if (!SCHEMA_KEYS.has(key)) problems.push(issue(`${path}.${key}`, 'unsupported_schema_feature'))
    const type = current.type
    if (typeof type !== 'string' || !SCHEMA_TYPES.includes(type as ExternalMcpSupportedSchemaType)) problems.push(issue(`${path}.type`, 'unsupported_schema_type'))
    const typed = type as ExternalMcpSupportedSchemaType
    if (current.additionalProperties !== undefined && current.additionalProperties !== false) problems.push(issue(`${path}.additionalProperties`, 'closed_objects_required', 'false'))
    if (typed === 'object' && current.additionalProperties !== false) problems.push(issue(`${path}.additionalProperties`, 'closed_objects_required', 'false'))
    const result: ExternalMcpSupportedSchema = { type: typed, additionalProperties: false }
    if (record(current.properties)) {
      if (typed !== 'object') problems.push(issue(`${path}.properties`, 'properties_require_object'))
      const propertyEntries = Object.entries(current.properties)
      state.properties += propertyEntries.length
      if (state.properties > EXTERNAL_MCP_SCHEMA_LIMITS.maxProperties) problems.push(issue(`${path}.properties`, 'schema_properties_limit'))
      result.properties = {}
      for (const [name, child] of propertyEntries) {
        if (!name || bytes(name) > EXTERNAL_MCP_LIMITS.maxNameBytes) problems.push(issue(`${path}.properties`, 'property_name_limit'))
        const inspected = visit(child, `${path}.properties.${name}`, level + 1)
        if (inspected) result.properties[name] = inspected
      }
    } else if (current.properties !== undefined) problems.push(issue(`${path}.properties`, 'schema_shape', 'object'))
    if (Array.isArray(current.required)) {
      if (typed !== 'object' || new Set(current.required).size !== current.required.length || !current.required.every(item => typeof item === 'string' && !!result.properties?.[item])) problems.push(issue(`${path}.required`, 'required_shape'))
      result.required = current.required.filter((item): item is string => typeof item === 'string')
    } else if (current.required !== undefined) problems.push(issue(`${path}.required`, 'schema_shape', 'array'))
    if (current.items !== undefined) {
      const inspected = visit(current.items, `${path}.items`, level + 1)
      if (typed !== 'array') problems.push(issue(`${path}.items`, 'items_require_array'))
      if (inspected) result.items = inspected
    } else if (typed === 'array') problems.push(issue(`${path}.items`, 'array_items_required'))
    if (Array.isArray(current.enum)) {
      if (!current.enum.every(validPrimitive) || !current.enum.every(item => item === null || typed === 'null' || (typed === 'integer' && typeof item === 'number' && Number.isInteger(item)) || (typed === 'number' && typeof item === 'number') || (typed === 'string' && typeof item === 'string') || (typed === 'boolean' && typeof item === 'boolean'))) problems.push(issue(`${path}.enum`, 'enum_shape'))
      result.enum = current.enum.filter(validPrimitive)
    } else if (current.enum !== undefined) problems.push(issue(`${path}.enum`, 'schema_shape', 'array'))
    for (const key of ['minLength', 'maxLength'] as const) if (current[key] !== undefined) { if (!integer(current[key], EXTERNAL_MCP_LIMITS.maxStringBytes)) problems.push(issue(`${path}.${key}`, 'string_limit')); else result[key] = current[key] }
    for (const key of ['minItems', 'maxItems'] as const) if (current[key] !== undefined) { if (!integer(current[key], EXTERNAL_MCP_SCHEMA_LIMITS.maxArrayItems)) problems.push(issue(`${path}.${key}`, 'array_limit')); else result[key] = current[key] }
    for (const key of ['minimum', 'maximum'] as const) if (current[key] !== undefined) { if (typeof current[key] !== 'number' || !Number.isFinite(current[key])) problems.push(issue(`${path}.${key}`, 'number_limit')); else result[key] = current[key] }
    return result
  }
  const schema = visit(value, currentPath, depth)
  if (problems.length) {
    const complexity = problems.some(item => ['schema_complexity', 'schema_properties_limit'].includes(item.code))
    return { ok: false, outcome: complexity ? 'SCHEMA_COMPLEXITY_LIMIT' : 'UNSUPPORTED_SCHEMA_FEATURE', issues: problems.slice(0, EXTERNAL_MCP_SCHEMA_LIMITS.maxIssues) }
  }
  if (!schema) return { ok: false, outcome: 'UNSUPPORTED_SCHEMA_FEATURE', issues: [issue('$', 'schema_shape')] }
  try {
    const canonical = canonicalJson(value)
    if (bytes(canonical) > EXTERNAL_MCP_SCHEMA_LIMITS.maxBytes) return { ok: false, outcome: 'SCHEMA_COMPLEXITY_LIMIT', issues: [issue('$', 'schema_bytes')] }
    return { ok: true, schema, canonical, digest: crypto.createHash('sha256').update(canonical, 'utf8').digest('hex') }
  } catch { return { ok: false, outcome: 'UNSUPPORTED_SCHEMA_FEATURE', issues: [issue('$', 'schema_encoding')] } }
}

function schemaFromEntry(entry: ExternalMcpManifestEntry, kind: 'request' | 'result'): SchemaInspection {
  const schema = kind === 'request' ? entry.pinnedRequestSchema : entry.pinnedResultSchema
  const declared = kind === 'request' ? entry.declaredRequestSchemaDigest : entry.declaredResultSchemaDigest
  if (!schema || !declared || !SHA256.test(declared)) return { ok: false, outcome: 'UNSUPPORTED_SCHEMA_FEATURE', issues: [issue('$', 'pinned_schema_missing')] }
  const inspected = inspectSchema(schema)
  if (!inspected.ok) return inspected
  return inspected.digest === declared ? inspected : { ok: false, outcome: 'UNSUPPORTED_SCHEMA_FEATURE', issues: [issue('$', 'pinned_schema_digest_mismatch', declared, inspected.digest)] }
}
function expectedApprovalId(manifest: ExternalMcpManifest, entryId: string): string { return `mcp-approval-${digest({ manifestId: manifest.manifestId, entryId, owner: manifest.owner, policyVersion: EXTERNAL_MCP_POLICY_VERSION })}` }
function expectedBindingDigest(manifest: ExternalMcpManifest, entry: ExternalMcpManifestEntry, approvalId: string): string { return digest({ manifestId: manifest.manifestId, entryId: entry.entryId, policy: manifest.policy, approvalId, requestSchemaDigest: entry.declaredRequestSchemaDigest ?? null, resultSchemaDigest: entry.declaredResultSchemaDigest ?? null }) }
function resolveTarget(target: ExternalMcpValidationTarget): ResolvedTarget {
  const manifest = target.manifest
  const manifestWithoutDigest = { ...manifest }; delete (manifestWithoutDigest as Partial<ExternalMcpManifest>).manifestDigest
  if (manifest.schemaVersion !== EXTERNAL_MCP_INTAKE_VERSION || manifest.kind !== EXTERNAL_MCP_INTAKE_KIND || target.manifestId !== manifest.manifestId || target.serverIdentity !== manifest.server.serverIdentity || !MANIFEST_ID.test(target.manifestId) || !ENTRY_ID.test(target.entryId) || !APPROVAL_ID.test(target.approvalId)) return { ok: false, outcome: 'IDENTITY_MISMATCH', issues: [issue('$', 'identity')] }
  const entry = manifest.entries.find(item => item.entryId === target.entryId)
  if (!entry) return { ok: false, outcome: 'UNAPPROVED_ENTRY', issues: [issue('$', 'entry_missing')] }
  if (entry.lifecycle === 'unavailable' || entry.lifecycle === 'removed') return { ok: false, outcome: 'ENTRY_UNAVAILABLE', issues: [issue('$', 'entry_unavailable')] }
  if (entry.lifecycle !== 'approved' || entry.approval.state !== 'approved' || entry.executionAuthority !== 'none') return { ok: false, outcome: 'UNAPPROVED_ENTRY', issues: [issue('$', 'entry_not_approved')] }
  if (entry.approval.approvalId !== target.approvalId || expectedApprovalId(manifest, entry.entryId) !== target.approvalId || entry.approval.bindingDigest !== expectedBindingDigest(manifest, entry, target.approvalId) || manifest.policy.policyVersion !== EXTERNAL_MCP_POLICY_VERSION) return { ok: false, outcome: 'IDENTITY_MISMATCH', issues: [issue('$', 'approval_binding')] }
  const requestSchema = schemaFromEntry(entry, 'request'); const resultSchema = schemaFromEntry(entry, 'result')
  if (digest(manifestWithoutDigest) !== manifest.manifestDigest && requestSchema.ok && resultSchema.ok) return { ok: false, outcome: 'IDENTITY_MISMATCH', issues: [issue('$', 'manifest_digest')] }
  return { ok: true, entry, requestSchema: requestSchema.ok ? requestSchema : undefined, resultSchema: resultSchema.ok ? resultSchema : undefined }
}
function targetBase(input: ExternalMcpValidationTarget, contentType: string): { manifestId: string; serverIdentity: string; entryId: string; approvalId: string; contentType: string; byteLength: number } { return { manifestId: input.manifestId, serverIdentity: input.serverIdentity, entryId: input.entryId, approvalId: input.approvalId, contentType, byteLength: 0 } }
function finalize(input: ExternalMcpValidationTarget, options: ExternalMcpValidationOptions, kind: 'request' | 'result', outcome: ExternalMcpValidationOutcome, contentType: string, byteLength: number, schemaDigest: string | undefined, payloadDigest: string | undefined, issues: ExternalMcpValidationIssue[], value?: unknown): ExternalMcpValidationResult {
  const evidenceInput = { kind, outcome, manifestId: input.manifestId, serverIdentity: input.serverIdentity, entryId: input.entryId, ...(input.approvalId ? { approvalId: input.approvalId } : {}), ...(schemaDigest ? { schemaDigest } : {}), contentType, ...(payloadDigest ? { payloadDigest } : {}), byteLength: Math.min(byteLength, EXTERNAL_MCP_LIMITS.maxResultBytes), ...(issues[0]?.path ? { path: issues[0].path } : {}), ...(issues[0]?.expected ? { expected: issues[0].expected } : {}), ...(issues[0]?.actual ? { actual: issues[0].actual } : {}) }
  const stored = appendExternalMcpValidationEvidence(evidenceInput, { ...options, now: options.now })
  const evidence = stored.ok ? stored.value : undefined
  const finalOutcome = stored.ok ? outcome : 'EVIDENCE_PERSISTENCE_FAILED'
  const boundDigest = payloadDigest && schemaDigest ? digest({ version: EXTERNAL_MCP_SCHEMA_VALIDATION_VERSION, kind, serverIdentity: input.serverIdentity, manifestId: input.manifestId, entryId: input.entryId, approvalId: input.approvalId, schemaDigest, payloadDigest, policyVersion: EXTERNAL_MCP_POLICY_VERSION }) : undefined
  return { ...targetBase(input, contentType), outcome: finalOutcome, ok: finalOutcome === 'REQUEST_VALID' || finalOutcome === 'RESULT_VALID' || finalOutcome === 'SCHEMA_MATCH', schemaDigest, payloadDigest, ...(kind === 'request' && boundDigest ? { requestDigest: boundDigest } : {}), ...(kind === 'result' && boundDigest ? { resultDigest: boundDigest } : {}), byteLength, value, issues: issues.slice(0, EXTERNAL_MCP_SCHEMA_LIMITS.maxIssues), ...(evidence ? { evidence } : {}) }
}
function schemaDrift(input: ExternalMcpValidationTarget, options: ExternalMcpValidationOptions, kind: 'request' | 'result', advertised: ExternalMcpJsonObject | undefined): ExternalMcpValidationResult | undefined {
  if (advertised === undefined) return undefined
  const resolved = resolveTarget(input)
  if (!resolved.ok) return finalize(input, options, kind, resolved.outcome, 'application/json', 0, undefined, undefined, resolved.issues)
  const pinned = kind === 'request' ? resolved.requestSchema : resolved.resultSchema
  if (!pinned?.ok) return finalize(input, options, kind, 'PINNED_SCHEMA_UNAVAILABLE', 'application/json', 0, undefined, undefined, [issue('$', 'pinned_schema_unavailable')])
  const latest = inspectSchema(advertised)
  if (!latest.ok || latest.digest !== pinned.digest) return finalize(input, options, kind, 'SCHEMA_DRIFT', 'application/json', 0, pinned.digest, undefined, latest.ok ? [issue('$', 'schema_drift', pinned.digest, latest.digest)] : latest.issues)
  return undefined
}
function decodeJson(payload: unknown, contentType: ExternalMcpContentType, maxBytes: number): { outcome?: ExternalMcpValidationOutcome; value?: unknown; byteLength: number; payloadDigest?: string } {
  let raw: string
  let byteLength: number
  if (payload instanceof Uint8Array) {
    byteLength = payload.byteLength; if (byteLength > maxBytes) return { outcome: 'OUTPUT_TOO_LARGE', byteLength, payloadDigest: safePayloadDigest(payload) }
    try { raw = new TextDecoder('utf-8', { fatal: true }).decode(payload) } catch { return { outcome: 'INVALID_ENCODING', byteLength, payloadDigest: safePayloadDigest(payload) } }
  } else if (typeof payload === 'string') {
    raw = payload; byteLength = bytes(raw); if (byteLength > maxBytes) return { outcome: 'OUTPUT_TOO_LARGE', byteLength, payloadDigest: safePayloadDigest(raw) }
  } else {
    try { const shape = valueShapeIssue(payload); if (shape) return { outcome: shape.code === 'depth' ? 'DEPTH_LIMIT_EXCEEDED' : 'OUTPUT_TOO_LARGE', byteLength: 0, payloadDigest: safePayloadDigest(payload) }; const canonical = canonicalJson(payload); byteLength = bytes(canonical); if (byteLength > maxBytes) return { outcome: 'OUTPUT_TOO_LARGE', byteLength, payloadDigest: safePayloadDigest(payload) }; return { value: payload, byteLength, payloadDigest: safePayloadDigest(payload) } } catch { return { outcome: 'MALFORMED_JSON', byteLength: 0 } }
  }
  if (raw.includes('\0')) return { outcome: 'INVALID_ENCODING', byteLength, payloadDigest: safePayloadDigest(raw) }
  if (contentType !== 'application/json') return { outcome: 'UNSUPPORTED_CONTENT_TYPE', byteLength, payloadDigest: safePayloadDigest(raw) }
  try { const value = JSON.parse(raw) as unknown; return { value, byteLength, payloadDigest: safePayloadDigest(value) } } catch { return { outcome: 'MALFORMED_JSON', byteLength, payloadDigest: safePayloadDigest(raw) } }
}
function validateValue(schema: ExternalMcpSupportedSchema, value: unknown, currentPath: string, issues: ExternalMcpValidationIssue[], state: { nodes: number; depth: number }): void {
  if (issues.length >= EXTERNAL_MCP_SCHEMA_LIMITS.maxIssues) return
  state.nodes += 1
  if (state.nodes > EXTERNAL_MCP_SCHEMA_LIMITS.maxNodes) { issues.push(issue(currentPath, 'nodes')); return }
  if (state.depth > EXTERNAL_MCP_SCHEMA_LIMITS.maxDepth) { issues.push(issue(currentPath, 'depth')); return }
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  const matches = schema.type === 'object' ? record(value) : schema.type === 'array' ? Array.isArray(value) : schema.type === 'integer' ? typeof value === 'number' && Number.isSafeInteger(value) : schema.type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === schema.type || (schema.type === 'null' && value === null)
  if (!matches) { issues.push(issue(currentPath, 'type', schema.type, actual)); return }
  if (schema.enum && !schema.enum.some(item => Object.is(item, value))) issues.push(issue(currentPath, 'enum', 'declared value', actual))
  if (typeof value === 'string') { if (bytes(value) > EXTERNAL_MCP_SCHEMA_LIMITS.maxStringBytes || (schema.maxLength !== undefined && value.length > schema.maxLength) || (schema.minLength !== undefined && value.length < schema.minLength)) issues.push(issue(currentPath, 'string_limit', schema.maxLength?.toString(), value.length.toString())) }
  if (typeof value === 'number') { if ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) issues.push(issue(currentPath, 'number_limit', `${schema.minimum ?? '-∞'}..${schema.maximum ?? '∞'}`, value.toString())) }
  if (Array.isArray(value)) { if (value.length > EXTERNAL_MCP_SCHEMA_LIMITS.maxArrayItems || (schema.maxItems !== undefined && value.length > schema.maxItems) || (schema.minItems !== undefined && value.length < schema.minItems)) issues.push(issue(currentPath, 'array_limit', schema.maxItems?.toString(), value.length.toString())); if (schema.items) { state.depth += 1; for (let index = 0; index < value.length; index += 1) validateValue(schema.items!, value[index], `${currentPath}[${index}]`, issues, state); state.depth -= 1 } }
  if (record(value)) { const keys = Object.keys(value); if (keys.length > EXTERNAL_MCP_SCHEMA_LIMITS.maxObjectProperties) issues.push(issue(currentPath, 'object_limit')); for (const key of keys.sort()) if (!schema.properties?.[key]) issues.push(issue(`${currentPath}.${key}`, 'unknown', 'declared property', 'unknown')); for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) issues.push(issue(`${currentPath}.${key}`, 'required', 'present', 'missing')); state.depth += 1; for (const key of Object.keys(schema.properties ?? {}).sort()) if (Object.hasOwn(value, key)) validateValue(schema.properties![key]!, value[key], `${currentPath}.${key}`, issues, state); state.depth -= 1 }
}
function valueShapeIssue(value: unknown, currentPath = '$', depth = 0, state = { nodes: 0 }): ExternalMcpValidationIssue | undefined {
  state.nodes += 1
  if (depth > EXTERNAL_MCP_SCHEMA_LIMITS.maxDepth) return issue(currentPath, 'depth')
  if (state.nodes > EXTERNAL_MCP_SCHEMA_LIMITS.maxNodes) return issue(currentPath, 'nodes')
  if (typeof value === 'string') { if (value.includes('\0')) return issue(currentPath, 'nul'); if (bytes(value) > EXTERNAL_MCP_SCHEMA_LIMITS.maxStringBytes) return issue(currentPath, 'string_bytes') }
  if (Array.isArray(value)) {
    if (value.length > EXTERNAL_MCP_SCHEMA_LIMITS.maxArrayItems) return issue(currentPath, 'array_items')
    for (let index = 0; index < value.length; index += 1) { const found = valueShapeIssue(value[index], `${currentPath}[${index}]`, depth + 1, state); if (found) return found }
  }
  if (record(value)) {
    if (Object.keys(value).length > EXTERNAL_MCP_SCHEMA_LIMITS.maxObjectProperties) return issue(currentPath, 'object_properties')
    for (const key of Object.keys(value).sort()) { const found = valueShapeIssue(value[key], `${currentPath}.${key}`, depth + 1, state); if (found) return found }
  }
  return undefined
}
function validateAgainst(input: ExternalMcpValidationTarget, options: ExternalMcpValidationOptions, kind: 'request' | 'result', payload: unknown, contentType: ExternalMcpContentType, schema: SchemaInspection | undefined, complete = true): ExternalMcpValidationResult {
  const maxBytes = kind === 'request' ? EXTERNAL_MCP_LIMITS.maxRequestBytes : EXTERNAL_MCP_LIMITS.maxResultBytes
  if (!schema?.ok) return finalize(input, options, kind, 'PINNED_SCHEMA_UNAVAILABLE', contentType, 0, undefined, undefined, [issue('$', 'pinned_schema_unavailable')])
  if (kind === 'request' && contentType !== 'application/json') return finalize(input, options, kind, 'UNSUPPORTED_CONTENT_TYPE', contentType, 0, schema.digest, safePayloadDigest(payload), [issue('$', 'request_requires_json')])
  if (kind === 'result' && !['application/json', 'text/plain'].includes(contentType)) return finalize(input, options, kind, 'UNSUPPORTED_CONTENT_TYPE', contentType, 0, schema.digest, safePayloadDigest(payload), [issue('$', 'unsupported_content_type')])
  if (kind === 'result' && !complete) return finalize(input, options, kind, 'TRUNCATED_RESULT', contentType, 0, schema.digest, undefined, [issue('$', 'truncated_result')])
  if (kind === 'result' && contentType === 'text/plain') {
    if (schema.schema.type !== 'string' || typeof payload !== 'string') return finalize(input, options, kind, 'UNSUPPORTED_CONTENT_TYPE', contentType, typeof payload === 'string' ? bytes(payload) : 0, schema.digest, safePayloadDigest(payload), [issue('$', 'text_result_requires_string_schema')])
    const length = bytes(payload); if (payload.includes('\0')) return finalize(input, options, kind, 'INVALID_ENCODING', contentType, length, schema.digest, safePayloadDigest(payload), [issue('$', 'nul')]); if (length > maxBytes) return finalize(input, options, kind, 'OUTPUT_TOO_LARGE', contentType, length, schema.digest, safePayloadDigest(payload), [issue('$', 'result_bytes')]); const issues: ExternalMcpValidationIssue[] = []; validateValue(schema.schema, payload, '$', issues, { nodes: 0, depth: 0 }); return finalize(input, options, kind, issues.length ? 'RESULT_SCHEMA_REJECTED' : 'RESULT_VALID', contentType, length, schema.digest, safePayloadDigest(payload), issues, issues.length ? undefined : payload)
  }
  const decoded = decodeJson(payload, contentType, maxBytes)
  if (decoded.outcome) return finalize(input, options, kind, kind === 'request' && decoded.outcome === 'OUTPUT_TOO_LARGE' ? 'REQUEST_TOO_LARGE' : decoded.outcome, contentType, decoded.byteLength, schema.digest, decoded.payloadDigest, [issue('$', decoded.outcome.toLowerCase())])
  const shapeIssue = valueShapeIssue(decoded.value)
  if (shapeIssue?.code === 'depth') return finalize(input, options, kind, 'DEPTH_LIMIT_EXCEEDED', contentType, decoded.byteLength, schema.digest, decoded.payloadDigest, [shapeIssue])
  if (shapeIssue?.code === 'nul') return finalize(input, options, kind, 'INVALID_ENCODING', contentType, decoded.byteLength, schema.digest, decoded.payloadDigest, [shapeIssue])
  if (shapeIssue?.code === 'nodes' || shapeIssue?.code === 'array_items' || shapeIssue?.code === 'object_properties' || shapeIssue?.code === 'string_bytes') return finalize(input, options, kind, kind === 'request' ? 'REQUEST_TOO_LARGE' : 'OUTPUT_TOO_LARGE', contentType, decoded.byteLength, schema.digest, decoded.payloadDigest, [shapeIssue])
  const issues: ExternalMcpValidationIssue[] = []; validateValue(schema.schema, decoded.value, '$', issues, { nodes: 0, depth: 0 }); return finalize(input, options, kind, issues.length ? kind === 'request' ? 'REQUEST_SCHEMA_REJECTED' : 'RESULT_SCHEMA_REJECTED' : kind === 'request' ? 'REQUEST_VALID' : 'RESULT_VALID', contentType, decoded.byteLength, schema.digest, decoded.payloadDigest, issues, issues.length ? undefined : decoded.value)
}

export function validateExternalMcpRequest(input: ExternalMcpRequestValidationInput, options: ExternalMcpValidationOptions): ExternalMcpValidationResult {
  const drift = schemaDrift(input, options, 'request', input.advertisedSchema); if (drift) return drift
  const resolved = resolveTarget(input); if (!resolved.ok) return finalize(input, options, 'request', resolved.outcome, input.contentType ?? 'application/json', 0, undefined, safePayloadDigest(input.payload), resolved.issues)
  if (resolved.entry.kind !== 'tool') return finalize(input, options, 'request', 'UNAPPROVED_ENTRY', input.contentType ?? 'application/json', 0, undefined, safePayloadDigest(input.payload), [issue('$', 'resource_has_no_request')])
  return validateAgainst(input, options, 'request', input.payload, input.contentType ?? 'application/json', resolved.requestSchema)
}
export function validateExternalMcpResult(input: ExternalMcpResultValidationInput, options: ExternalMcpValidationOptions): ExternalMcpValidationResult {
  const drift = schemaDrift(input, options, 'result', input.advertisedSchema); if (drift) return drift
  const resolved = resolveTarget(input); if (!resolved.ok) return finalize(input, options, 'result', resolved.outcome, input.contentType, 0, undefined, safePayloadDigest(input.payload), resolved.issues)
  if (resolved.entry.kind !== 'tool' && resolved.entry.kind !== 'resource') return finalize(input, options, 'result', 'UNAPPROVED_ENTRY', input.contentType, 0, undefined, safePayloadDigest(input.payload), [issue('$', 'unsupported_entry')])
  return validateAgainst(input, options, 'result', input.payload, input.contentType, resolved.resultSchema, input.complete ?? true)
}
export function reconcileExternalMcpSchema(input: ExternalMcpValidationTarget & { kind: 'request' | 'result'; advertisedSchema: ExternalMcpJsonObject }, options: ExternalMcpValidationOptions): ExternalMcpValidationResult {
  const resolved = resolveTarget(input)
  if (!resolved.ok) return finalize(input, options, input.kind, resolved.outcome, 'application/json', 0, undefined, undefined, resolved.issues)
  const pinned = input.kind === 'request' ? resolved.requestSchema : resolved.resultSchema
  if (!pinned?.ok) return finalize(input, options, input.kind, 'PINNED_SCHEMA_UNAVAILABLE', 'application/json', 0, undefined, undefined, [issue('$', 'pinned_schema_unavailable')])
  const advertised = inspectSchema(input.advertisedSchema)
  if (!advertised.ok || advertised.digest !== pinned.digest) return finalize(input, options, input.kind, 'SCHEMA_DRIFT', 'application/json', 0, pinned.digest, undefined, advertised.ok ? [issue('$', 'schema_drift', pinned.digest, advertised.digest)] : advertised.issues)
  return finalize(input, options, input.kind, 'SCHEMA_MATCH', 'application/json', 0, pinned.digest, undefined, [])
}
export function inspectExternalMcpSchema(schema: ExternalMcpJsonObject): SchemaInspection { return inspectSchema(schema) }
