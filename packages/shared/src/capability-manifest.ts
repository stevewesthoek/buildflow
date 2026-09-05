/**
 * R17.1: the canonical, declaration-only capability manifest contract.
 *
 * A manifest describes the narrowest behavior a future broker capability may
 * request. It does not grant authority and it is not an execution registry.
 * Existing Phase 16 policy evaluation and the established command, path,
 * network, source, and release guards remain authoritative.
 */

export const WORKBENCH_CAPABILITY_MANIFEST_KIND = 'workbench.capability.manifest' as const
export const WORKBENCH_CAPABILITY_MANIFEST_VERSION = 1 as const
export const CAPABILITY_MANIFEST_AUTHORITY = 'declaration-only' as const

export const CAPABILITY_MANIFEST_MANDATORY_FIELDS = [
  'id', 'version', 'inputSchema', 'outputSchema',
  'pathPolicy', 'cwdPolicy', 'networkPolicy', 'writePolicy',
  'timeout', 'risk', 'confirmation', 'validation', 'redaction', 'outputLimits'
] as const
export type CapabilityManifestMandatoryField = typeof CAPABILITY_MANIFEST_MANDATORY_FIELDS[number]

export const CAPABILITY_MANIFEST_MAX_SERIALIZED_BYTES = 64 * 1024
export const CAPABILITY_MANIFEST_MAX_SCHEMA_BYTES = 16 * 1024
export const CAPABILITY_MANIFEST_MAX_SCHEMA_DEPTH = 8
export const CAPABILITY_MANIFEST_MAX_SCHEMA_NODES = 256
export const CAPABILITY_MANIFEST_MAX_PROPERTIES = 64
export const CAPABILITY_MANIFEST_MAX_PATHS = 32
export const CAPABILITY_MANIFEST_MAX_PATH_BYTES = 16 * 1024 * 1024
export const CAPABILITY_MANIFEST_MAX_NETWORK_REQUESTS = 100
export const CAPABILITY_MANIFEST_MAX_TIMEOUT_MS = 300_000
export const CAPABILITY_MANIFEST_MAX_OUTPUT_BYTES = 1024 * 1024
export const CAPABILITY_MANIFEST_MAX_OUTPUT_ITEMS = 10_000
export const CAPABILITY_MANIFEST_MAX_INLINE_BYTES = 256 * 1024

export const CAPABILITY_JSON_TYPES = [
  'object', 'array', 'string', 'number', 'integer', 'boolean', 'null'
] as const
export type CapabilityJsonType = typeof CAPABILITY_JSON_TYPES[number]
export type CapabilityJsonValue = string | number | boolean | null

export type CapabilityJsonSchema = Readonly<{
  type: CapabilityJsonType
  title?: string
  description?: string
  properties?: Readonly<Record<string, CapabilityJsonSchema>>
  required?: readonly string[]
  additionalProperties?: false
  items?: CapabilityJsonSchema
  enum?: readonly CapabilityJsonValue[]
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  minItems?: number
  maxItems?: number
}>

export const CAPABILITY_PATH_MODES = ['none', 'source-relative', 'artifact-relative'] as const
export type CapabilityPathMode = typeof CAPABILITY_PATH_MODES[number]
export const CAPABILITY_PROTECTED_PATH_POLICIES = ['workbench-default', 'workbench-default-plus'] as const
export type CapabilityProtectedPathPolicy = typeof CAPABILITY_PROTECTED_PATH_POLICIES[number]
export type CapabilityPathPolicy = Readonly<{
  mode: CapabilityPathMode
  allowedRoots: readonly string[]
  protectedPaths: CapabilityProtectedPathPolicy
  additionalProtectedPaths: readonly string[]
  maxPaths: number
  maxBytes: number
}>

export const CAPABILITY_CWD_MODES = ['none', 'source-root', 'allowed-subdirectories'] as const
export type CapabilityCwdMode = typeof CAPABILITY_CWD_MODES[number]
export type CapabilityCwdPolicy = Readonly<{
  mode: CapabilityCwdMode
  allowedPaths: readonly string[]
}>

export const CAPABILITY_NETWORK_MODES = ['denied', 'allowlist'] as const
export type CapabilityNetworkMode = typeof CAPABILITY_NETWORK_MODES[number]
export const CAPABILITY_NETWORK_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
export type CapabilityNetworkMethod = typeof CAPABILITY_NETWORK_METHODS[number]
export type CapabilityNetworkPolicy = Readonly<{
  mode: CapabilityNetworkMode
  allowedTargets: readonly string[]
  allowedMethods: readonly CapabilityNetworkMethod[]
  maxRequests: number
}>

export const CAPABILITY_WRITE_MODES = ['none', 'source-scoped', 'explicit-paths', 'artifact-only'] as const
export type CapabilityWriteMode = typeof CAPABILITY_WRITE_MODES[number]
export type CapabilityWritePolicy = Readonly<{
  mode: CapabilityWriteMode
  allowedPaths: readonly string[]
  maxFiles: number
  maxBytes: number
}>

export type CapabilityTimeoutPolicy = Readonly<{
  defaultMs: number
  maxMs: number
}>

export const CAPABILITY_MANIFEST_RISKS = ['low', 'medium', 'high'] as const
export type CapabilityManifestRisk = typeof CAPABILITY_MANIFEST_RISKS[number]

export const CAPABILITY_CONFIRMATION_MODES = ['not_required', 'required', 'unavailable'] as const
export type CapabilityConfirmationMode = typeof CAPABILITY_CONFIRMATION_MODES[number]
export type CapabilityConfirmationPolicy = Readonly<{
  mode: CapabilityConfirmationMode
  reason?: string
}>

export const CAPABILITY_VALIDATION_MODES = ['none', 'required'] as const
export type CapabilityValidationMode = typeof CAPABILITY_VALIDATION_MODES[number]
export const CAPABILITY_VALIDATION_CHECKS = [
  'input-schema', 'output-schema', 'exit-status', 'file-integrity', 'verifier', 'evidence-reference'
] as const
export type CapabilityValidationCheck = typeof CAPABILITY_VALIDATION_CHECKS[number]
export type CapabilityValidationPolicy = Readonly<{
  mode: CapabilityValidationMode
  checks: readonly CapabilityValidationCheck[]
  verifierIds: readonly string[]
}>

export const CAPABILITY_REDACTION_MODES = ['standard', 'strict'] as const
export type CapabilityRedactionMode = typeof CAPABILITY_REDACTION_MODES[number]
export const CAPABILITY_REDACTION_PATTERNS = [
  'credentials', 'tokens', 'private-keys', 'authorization', 'environment', 'raw-output'
] as const
export type CapabilityRedactionPattern = typeof CAPABILITY_REDACTION_PATTERNS[number]
export type CapabilityRedactionPolicy = Readonly<{
  mode: CapabilityRedactionMode
  fields: readonly string[]
  patterns: readonly CapabilityRedactionPattern[]
  preserveEvidenceReferences: boolean
  inlineSecrets: 'never'
}>

export const CAPABILITY_OUTPUT_OVERFLOW_MODES = ['evidence-reference', 'truncate', 'reject'] as const
export type CapabilityOutputOverflowMode = typeof CAPABILITY_OUTPUT_OVERFLOW_MODES[number]
export type CapabilityOutputLimits = Readonly<{
  maxBytes: number
  maxItems: number
  maxInlineBytes: number
  overflow: CapabilityOutputOverflowMode
}>

export type CapabilityManifest = Readonly<{
  kind: typeof WORKBENCH_CAPABILITY_MANIFEST_KIND
  manifestVersion: typeof WORKBENCH_CAPABILITY_MANIFEST_VERSION
  id: string
  version: string
  name: string
  description: string
  inputSchema: CapabilityJsonSchema
  outputSchema: CapabilityJsonSchema
  pathPolicy: CapabilityPathPolicy
  cwdPolicy: CapabilityCwdPolicy
  networkPolicy: CapabilityNetworkPolicy
  writePolicy: CapabilityWritePolicy
  timeout: CapabilityTimeoutPolicy
  risk: CapabilityManifestRisk
  confirmation: CapabilityConfirmationPolicy
  validation: CapabilityValidationPolicy
  redaction: CapabilityRedactionPolicy
  outputLimits: CapabilityOutputLimits
}>

/**
 * R18.1: a CLI capability is a declaration-only, structurally constrained
 * extension of CapabilityManifest. The base manifest remains authoritative for
 * paths, cwd, network, writes, timeout, confirmation, validation, redaction,
 * and output limits. This extension declares only the future process shape.
 */
export const CLI_CAPABILITY_MANIFEST_TYPE = 'cli' as const
export const CLI_CAPABILITY_MANIFEST_VERSION = 1 as const
export const CLI_CAPABILITY_EXECUTABLE_NAMES = ['git', 'gh', 'node', 'pnpm', 'rg'] as const
export type CliCapabilityExecutableName = typeof CLI_CAPABILITY_EXECUTABLE_NAMES[number]

export const CLI_CAPABILITY_ARGUMENT_TEMPLATE_KINDS = ['literal', 'input', 'path'] as const
export type CliCapabilityArgumentTemplateKind = typeof CLI_CAPABILITY_ARGUMENT_TEMPLATE_KINDS[number]
export const CLI_CAPABILITY_ARGUMENT_VALUE_TYPES = ['string', 'number', 'integer', 'boolean'] as const
export type CliCapabilityArgumentValueType = typeof CLI_CAPABILITY_ARGUMENT_VALUE_TYPES[number]
export const CLI_CAPABILITY_PATH_TEMPLATE_MODES = ['source-relative', 'artifact-relative'] as const
export type CliCapabilityPathTemplateMode = typeof CLI_CAPABILITY_PATH_TEMPLATE_MODES[number]
export const CLI_CAPABILITY_MAX_ARG_TEMPLATES = 64
export const CLI_CAPABILITY_MAX_LITERAL_LENGTH = 500

export type CliCapabilityExecutable = Readonly<{
  name: CliCapabilityExecutableName
}>

export type CliCapabilityArgumentTemplate =
  | Readonly<{ kind: 'literal'; value: string }>
  | Readonly<{ kind: 'input'; input: string; valueType: CliCapabilityArgumentValueType }>
  | Readonly<{ kind: 'path'; input: string; pathMode: CliCapabilityPathTemplateMode }>

export type CliCapabilityEnvironmentPolicy = Readonly<{
  mode: 'minimal'
  inheritedKeys: readonly []
}>

export type CliCapabilityDeclaration = Readonly<{
  executable: CliCapabilityExecutable
  argv: readonly CliCapabilityArgumentTemplate[]
  shell: false
  environment: CliCapabilityEnvironmentPolicy
}>

export type CliCapabilityManifest = CapabilityManifest & Readonly<{
  cli: CliCapabilityDeclaration
}>

export type CliCapabilityManifestValidationResult =
  | Readonly<{ ok: true; value: CliCapabilityManifest }>
  | Readonly<{
    ok: false
    code: 'CLI_CAPABILITY_MANIFEST_INVALID'
    message: string
    issues: readonly CapabilityManifestValidationIssue[]
  }>

export type CapabilityManifestValidationIssue = Readonly<{
  path: string
  code: string
  message: string
}>

export type CapabilityManifestValidationResult =
  | Readonly<{ ok: true; value: CapabilityManifest }>
  | Readonly<{
    ok: false
    code: 'CAPABILITY_MANIFEST_INVALID'
    message: string
    issues: readonly CapabilityManifestValidationIssue[]
  }>

export type CapabilityManifestCollectionValidationResult =
  | Readonly<{ ok: true; value: readonly CapabilityManifest[] }>
  | Readonly<{
    ok: false
    code: 'CAPABILITY_MANIFEST_COLLECTION_INVALID'
    message: string
    issues: readonly CapabilityManifestValidationIssue[]
  }>

export type CapabilityManifestInspection = Readonly<{
  id: string
  version: string
  name: string
  risk: CapabilityManifestRisk
  writes: boolean
  network: 'none' | 'bounded'
  pathScope: string
  cwdScope: string
  confirmation: 'no' | 'yes' | 'unavailable'
  timeout: string
  input: string
  output: string
  validation: string
  redaction: string
  outputLimit: string
}>

export type CliCapabilityManifestInspection = CapabilityManifestInspection & Readonly<{
  executable: CliCapabilityExecutableName
  fixedArguments: readonly string[]
  userControlledArguments: readonly string[]
  shell: 'no'
  arbitraryArguments: 'no'
  ambientNetwork: 'no'
  environment: 'minimal-no-inheritance'
  argvLength: number
}>

type MutableIssue = CapabilityManifestValidationIssue
type RecordValue = Record<string, unknown>

function isRecord(value: unknown): value is RecordValue {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function hasOwn(value: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function addIssue(issues: MutableIssue[], path: string, code: string, message: string): void {
  issues.push({ path, code, message })
}

function unknownKeys(value: RecordValue, allowed: readonly string[], path: string, issues: MutableIssue[]): void {
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) addIssue(issues, `${path}.${key}`, 'unknown_key', 'is not a recognized manifest field.')
  }
}

function requireRecord(value: unknown, path: string, issues: MutableIssue[]): value is RecordValue {
  if (!isRecord(value)) {
    addIssue(issues, path, 'type', 'must be an object.')
    return false
  }
  return true
}

function requireString(value: unknown, path: string, issues: MutableIssue[], maxLength = 512): string | false {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    addIssue(issues, path, 'string', `must be a non-empty string of at most ${maxLength} characters.`)
    return false
  }
  return value
}

function requireInteger(value: unknown, path: string, issues: MutableIssue[], minimum: number, maximum: number): number | false {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    addIssue(issues, path, 'integer', `must be an integer from ${minimum} through ${maximum}.`)
    return false
  }
  return value as number
}

function requireBoolean(value: unknown, path: string, issues: MutableIssue[]): value is boolean {
  if (typeof value !== 'boolean') {
    addIssue(issues, path, 'boolean', 'must be explicitly true or false.')
    return false
  }
  return true
}

function requireEnum<T extends string>(value: unknown, path: string, issues: MutableIssue[], allowed: readonly T[]): T | false {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    addIssue(issues, path, 'enum', `must be one of: ${allowed.join(', ')}.`)
    return false
  }
  return value as T
}

function validateStringArray(
  value: unknown,
  path: string,
  issues: MutableIssue[],
  options: Readonly<{ maxItems: number; itemMaxLength: number; relativePath?: boolean; identifier?: boolean }>
): string[] | false {
  if (!Array.isArray(value) || value.length > options.maxItems) {
    addIssue(issues, path, 'array', `must be an array of at most ${options.maxItems} strings.`)
    return false
  }
  const seen = new Set<string>()
  const strings: string[] = []
  for (const [index, item] of value.entries()) {
    const itemPath = `${path}[${index}]`
    if (typeof item !== 'string' || item.length === 0 || item.length > options.itemMaxLength) {
      addIssue(issues, itemPath, 'string', `must be a non-empty string of at most ${options.itemMaxLength} characters.`)
      continue
    }
    if (seen.has(item)) addIssue(issues, itemPath, 'duplicate', 'must be unique within the array.')
    seen.add(item)
    strings.push(item)
    if (options.relativePath && !isSafeRelativePath(item)) addIssue(issues, itemPath, 'path', 'must be a safe relative path without traversal.')
    if (options.identifier && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(item)) {
      addIssue(issues, itemPath, 'identifier', 'must be a bounded identifier using letters, numbers, dot, underscore, colon, or hyphen.')
    }
  }
  return strings
}

function isSafeRelativePath(value: string): boolean {
  if (!value || value.startsWith('/') || value.startsWith('~') || value.includes('\\') || value.includes('\0')) return false
  const parts = value.split('/')
  return parts.every(part => part.length > 0 && part !== '.' && part !== '..')
}

function isNetworkTarget(value: string): boolean {
  if (value.includes('*') || value.includes(' ') || value.includes('\t') || value.includes('\n')) return false
  return /^(https?):\/\/(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$/.test(value)
}

function validateJsonSchema(value: unknown, path: string, issues: MutableIssue[], state: { nodes: number }, depth: number): void {
  if (!requireRecord(value, path, issues)) return
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch {
    addIssue(issues, path, 'json', 'must be JSON-serializable.')
  }
  if (serialized !== undefined && new TextEncoder().encode(serialized).length > CAPABILITY_MANIFEST_MAX_SCHEMA_BYTES) addIssue(issues, path, 'schema_size', `must be at most ${CAPABILITY_MANIFEST_MAX_SCHEMA_BYTES} UTF-8 bytes.`)
  if (depth > CAPABILITY_MANIFEST_MAX_SCHEMA_DEPTH) {
    addIssue(issues, path, 'schema_depth', `must not exceed depth ${CAPABILITY_MANIFEST_MAX_SCHEMA_DEPTH}.`)
    return
  }
  state.nodes += 1
  if (state.nodes > CAPABILITY_MANIFEST_MAX_SCHEMA_NODES) {
    addIssue(issues, path, 'schema_nodes', `must not exceed ${CAPABILITY_MANIFEST_MAX_SCHEMA_NODES} schema nodes.`)
    return
  }
  const type = requireEnum(value.type, `${path}.type`, issues, CAPABILITY_JSON_TYPES)
  if (!type) return

  const commonKeys = ['type', 'title', 'description', 'enum']
  const typeKeys: Record<CapabilityJsonType, readonly string[]> = {
    object: ['properties', 'required', 'additionalProperties'],
    array: ['items', 'minItems', 'maxItems'],
    string: ['minLength', 'maxLength'],
    number: ['minimum', 'maximum'],
    integer: ['minimum', 'maximum'],
    boolean: [],
    null: []
  }
  unknownKeys(value, [...commonKeys, ...typeKeys[type]], path, issues)

  if (hasOwn(value, 'title') && !requireString(value.title, `${path}.title`, issues, 120)) { /* issue recorded */ }
  if (hasOwn(value, 'description') && !requireString(value.description, `${path}.description`, issues, 500)) { /* issue recorded */ }

  if (hasOwn(value, 'enum')) {
    if (!Array.isArray(value.enum) || value.enum.length === 0 || value.enum.length > 32) {
      addIssue(issues, `${path}.enum`, 'enum_values', 'must be a non-empty array of at most 32 JSON scalar values.')
    } else {
      const seen = new Set<string>()
      for (const [index, item] of value.enum.entries()) {
        if (item !== null && !['string', 'number', 'boolean'].includes(typeof item)) {
          addIssue(issues, `${path}.enum[${index}]`, 'enum_value', 'must be a JSON scalar.')
        }
        const key = JSON.stringify(item)
        if (seen.has(key)) addIssue(issues, `${path}.enum[${index}]`, 'duplicate', 'must be unique within the enum.')
        seen.add(key)
        if (type === 'integer' && (typeof item !== 'number' || !Number.isInteger(item))) addIssue(issues, `${path}.enum[${index}]`, 'enum_type', 'must contain only integers for an integer schema.')
        if (type === 'number' && typeof item !== 'number') addIssue(issues, `${path}.enum[${index}]`, 'enum_type', 'must contain only numbers for a number schema.')
        if (type === 'string' && typeof item !== 'string') addIssue(issues, `${path}.enum[${index}]`, 'enum_type', 'must contain only strings for a string schema.')
        if (type === 'boolean' && typeof item !== 'boolean') addIssue(issues, `${path}.enum[${index}]`, 'enum_type', 'must contain only booleans for a boolean schema.')
        if (type === 'null' && item !== null) addIssue(issues, `${path}.enum[${index}]`, 'enum_type', 'must contain only null for a null schema.')
      }
    }
  }

  if (type === 'object') {
    if (!isRecord(value.properties)) {
      addIssue(issues, `${path}.properties`, 'required', 'must be an explicit object schema property map.')
    } else {
      const propertyNames = Object.keys(value.properties)
      if (propertyNames.length > CAPABILITY_MANIFEST_MAX_PROPERTIES) addIssue(issues, `${path}.properties`, 'property_count', `must contain at most ${CAPABILITY_MANIFEST_MAX_PROPERTIES} properties.`)
      for (const propertyName of propertyNames) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(propertyName)) addIssue(issues, `${path}.properties.${propertyName}`, 'property_name', 'must be a bounded property name.')
        validateJsonSchema(value.properties[propertyName], `${path}.properties.${propertyName}`, issues, state, depth + 1)
      }
    }
    if (!Array.isArray(value.required)) {
      addIssue(issues, `${path}.required`, 'required', 'must be an explicit array, including when no properties are required.')
    } else {
      const required = validateStringArray(value.required, `${path}.required`, issues, { maxItems: CAPABILITY_MANIFEST_MAX_PROPERTIES, itemMaxLength: 120 })
      if (required && isRecord(value.properties)) {
        const properties = new Set(Object.keys(value.properties))
        for (const [index, name] of required.entries()) if (!properties.has(name)) addIssue(issues, `${path}.required[${index}]`, 'required_property', 'must name a property declared in properties.')
      }
    }
    if (value.additionalProperties !== false) addIssue(issues, `${path}.additionalProperties`, 'closed_schema', 'must be false so unknown arguments are rejected.')
  }
  if (type === 'array') {
    if (!hasOwn(value, 'items')) addIssue(issues, `${path}.items`, 'required', 'must declare an item schema.')
    else validateJsonSchema(value.items, `${path}.items`, issues, state, depth + 1)
    if (hasOwn(value, 'minItems') && !requireInteger(value.minItems, `${path}.minItems`, issues, 0, CAPABILITY_MANIFEST_MAX_OUTPUT_ITEMS)) { /* issue recorded */ }
    if (hasOwn(value, 'maxItems') && !requireInteger(value.maxItems, `${path}.maxItems`, issues, 0, CAPABILITY_MANIFEST_MAX_OUTPUT_ITEMS)) { /* issue recorded */ }
    if (typeof value.minItems === 'number' && typeof value.maxItems === 'number' && value.minItems > value.maxItems) addIssue(issues, path, 'bounds', 'minItems must not exceed maxItems.')
  }
  if (type === 'string') {
    if (hasOwn(value, 'minLength') && !requireInteger(value.minLength, `${path}.minLength`, issues, 0, 4096)) { /* issue recorded */ }
    if (hasOwn(value, 'maxLength') && !requireInteger(value.maxLength, `${path}.maxLength`, issues, 0, 65_536)) { /* issue recorded */ }
    if (typeof value.minLength === 'number' && typeof value.maxLength === 'number' && value.minLength > value.maxLength) addIssue(issues, path, 'bounds', 'minLength must not exceed maxLength.')
  }
  if (type === 'number' || type === 'integer') {
    if (hasOwn(value, 'minimum') && (typeof value.minimum !== 'number' || !Number.isFinite(value.minimum))) addIssue(issues, `${path}.minimum`, 'number', 'must be a finite number.')
    if (hasOwn(value, 'maximum') && (typeof value.maximum !== 'number' || !Number.isFinite(value.maximum))) addIssue(issues, `${path}.maximum`, 'number', 'must be a finite number.')
    if (typeof value.minimum === 'number' && typeof value.maximum === 'number' && value.minimum > value.maximum) addIssue(issues, path, 'bounds', 'minimum must not exceed maximum.')
    if (type === 'integer' && ((typeof value.minimum === 'number' && !Number.isInteger(value.minimum)) || (typeof value.maximum === 'number' && !Number.isInteger(value.maximum)))) addIssue(issues, path, 'integer_bounds', 'integer schema bounds must be integers.')
  }
}

function validatePathPolicy(value: unknown, path: string, issues: MutableIssue[]): void {
  if (!requireRecord(value, path, issues)) return
  unknownKeys(value, ['mode', 'allowedRoots', 'protectedPaths', 'additionalProtectedPaths', 'maxPaths', 'maxBytes'], path, issues)
  const mode = requireEnum(value.mode, `${path}.mode`, issues, CAPABILITY_PATH_MODES)
  const allowedRoots = validateStringArray(value.allowedRoots, `${path}.allowedRoots`, issues, { maxItems: CAPABILITY_MANIFEST_MAX_PATHS, itemMaxLength: 200, relativePath: true })
  const protectedPaths = requireEnum(value.protectedPaths, `${path}.protectedPaths`, issues, CAPABILITY_PROTECTED_PATH_POLICIES)
  const additional = validateStringArray(value.additionalProtectedPaths, `${path}.additionalProtectedPaths`, issues, { maxItems: CAPABILITY_MANIFEST_MAX_PATHS, itemMaxLength: 200, relativePath: true })
  const maxPaths = requireInteger(value.maxPaths, `${path}.maxPaths`, issues, 0, CAPABILITY_MANIFEST_MAX_PATHS)
  const maxBytes = requireInteger(value.maxBytes, `${path}.maxBytes`, issues, 0, CAPABILITY_MANIFEST_MAX_PATH_BYTES)
  if (mode === 'none') {
    if (allowedRoots && allowedRoots.length !== 0) addIssue(issues, `${path}.allowedRoots`, 'none_scope', 'must be empty when path mode is none.')
    if (additional && additional.length !== 0) addIssue(issues, `${path}.additionalProtectedPaths`, 'none_scope', 'must be empty when path mode is none.')
    if (maxPaths !== false && maxPaths !== 0) addIssue(issues, `${path}.maxPaths`, 'none_scope', 'must be 0 when path mode is none.')
    if (maxBytes !== false && maxBytes !== 0) addIssue(issues, `${path}.maxBytes`, 'none_scope', 'must be 0 when path mode is none.')
  } else {
    if (allowedRoots && allowedRoots.length === 0) addIssue(issues, `${path}.allowedRoots`, 'bounded_scope', 'must name at least one allowed root for a bounded path mode.')
    if (maxPaths !== false && maxPaths === 0) addIssue(issues, `${path}.maxPaths`, 'bounded_scope', 'must be positive for a bounded path mode.')
    if (maxBytes !== false && maxBytes === 0) addIssue(issues, `${path}.maxBytes`, 'bounded_scope', 'must be positive for a bounded path mode.')
  }
  if (protectedPaths && protectedPaths !== 'workbench-default' && protectedPaths !== 'workbench-default-plus') addIssue(issues, `${path}.protectedPaths`, 'protected_paths', 'must retain the Workbench default protected-path baseline.')
}

function validateCwdPolicy(value: unknown, path: string, issues: MutableIssue[]): void {
  if (!requireRecord(value, path, issues)) return
  unknownKeys(value, ['mode', 'allowedPaths'], path, issues)
  const mode = requireEnum(value.mode, `${path}.mode`, issues, CAPABILITY_CWD_MODES)
  const allowed = validateStringArray(value.allowedPaths, `${path}.allowedPaths`, issues, { maxItems: CAPABILITY_MANIFEST_MAX_PATHS, itemMaxLength: 200, relativePath: true })
  if (mode === 'none' || mode === 'source-root') {
    if (allowed && allowed.length !== 0) addIssue(issues, `${path}.allowedPaths`, 'cwd_scope', `must be empty when cwd mode is ${mode}.`)
  } else if (mode === 'allowed-subdirectories' && allowed && allowed.length === 0) {
    addIssue(issues, `${path}.allowedPaths`, 'cwd_scope', 'must name at least one allowed source-relative subdirectory.')
  }
}

function validateNetworkPolicy(value: unknown, path: string, issues: MutableIssue[]): void {
  if (!requireRecord(value, path, issues)) return
  unknownKeys(value, ['mode', 'allowedTargets', 'allowedMethods', 'maxRequests'], path, issues)
  const mode = requireEnum(value.mode, `${path}.mode`, issues, CAPABILITY_NETWORK_MODES)
  const targets = validateStringArray(value.allowedTargets, `${path}.allowedTargets`, issues, { maxItems: CAPABILITY_MANIFEST_MAX_PATHS, itemMaxLength: 300 })
  const methodsValue = value.allowedMethods
  let methods: unknown[] | false = false
  if (!Array.isArray(methodsValue) || methodsValue.length > CAPABILITY_NETWORK_METHODS.length) addIssue(issues, `${path}.allowedMethods`, 'array', 'must be a unique array of bounded HTTP methods.')
  else {
    methods = methodsValue
    const seen = new Set<string>()
    for (const [index, method] of methodsValue.entries()) {
      if (typeof method !== 'string' || !CAPABILITY_NETWORK_METHODS.includes(method as CapabilityNetworkMethod)) addIssue(issues, `${path}.allowedMethods[${index}]`, 'method', `must be one of: ${CAPABILITY_NETWORK_METHODS.join(', ')}.`)
      else if (seen.has(method)) addIssue(issues, `${path}.allowedMethods[${index}]`, 'duplicate', 'must be unique.')
      seen.add(String(method))
    }
  }
  if (targets) for (const [index, target] of targets.entries()) if (!isNetworkTarget(target)) addIssue(issues, `${path}.allowedTargets[${index}]`, 'network_target', 'must be an explicit HTTP(S) origin/path without credentials or wildcards.')
  const maxRequests = requireInteger(value.maxRequests, `${path}.maxRequests`, issues, 0, CAPABILITY_MANIFEST_MAX_NETWORK_REQUESTS)
  if (mode === 'denied') {
    if (targets && targets.length !== 0) addIssue(issues, `${path}.allowedTargets`, 'denied_scope', 'must be empty when network mode is denied.')
    if (methods !== false && methods.length !== 0) addIssue(issues, `${path}.allowedMethods`, 'denied_scope', 'must be empty when network mode is denied.')
    if (maxRequests !== false && maxRequests !== 0) addIssue(issues, `${path}.maxRequests`, 'denied_scope', 'must be 0 when network mode is denied.')
  } else {
    if (targets && targets.length === 0) addIssue(issues, `${path}.allowedTargets`, 'bounded_scope', 'must contain at least one explicit target for allowlist mode.')
    if (methods !== false && methods.length === 0) addIssue(issues, `${path}.allowedMethods`, 'bounded_scope', 'must contain at least one method for allowlist mode.')
    if (maxRequests !== false && maxRequests === 0) addIssue(issues, `${path}.maxRequests`, 'bounded_scope', 'must be positive for allowlist mode.')
  }
}

function validateWritePolicy(value: unknown, path: string, issues: MutableIssue[]): void {
  if (!requireRecord(value, path, issues)) return
  unknownKeys(value, ['mode', 'allowedPaths', 'maxFiles', 'maxBytes'], path, issues)
  const mode = requireEnum(value.mode, `${path}.mode`, issues, CAPABILITY_WRITE_MODES)
  const allowed = validateStringArray(value.allowedPaths, `${path}.allowedPaths`, issues, { maxItems: CAPABILITY_MANIFEST_MAX_PATHS, itemMaxLength: 200, relativePath: true })
  const maxFiles = requireInteger(value.maxFiles, `${path}.maxFiles`, issues, 0, CAPABILITY_MANIFEST_MAX_PATHS)
  const maxBytes = requireInteger(value.maxBytes, `${path}.maxBytes`, issues, 0, CAPABILITY_MANIFEST_MAX_PATH_BYTES)
  if (mode === 'none') {
    if (allowed && allowed.length !== 0) addIssue(issues, `${path}.allowedPaths`, 'none_scope', 'must be empty when write mode is none.')
    if (maxFiles !== false && maxFiles !== 0) addIssue(issues, `${path}.maxFiles`, 'none_scope', 'must be 0 when write mode is none.')
    if (maxBytes !== false && maxBytes !== 0) addIssue(issues, `${path}.maxBytes`, 'none_scope', 'must be 0 when write mode is none.')
  } else {
    if (allowed && allowed.length === 0) addIssue(issues, `${path}.allowedPaths`, 'bounded_scope', 'must name at least one allowed write path.')
    if (maxFiles !== false && maxFiles === 0) addIssue(issues, `${path}.maxFiles`, 'bounded_scope', 'must be positive for a write mode.')
    if (maxBytes !== false && maxBytes === 0) addIssue(issues, `${path}.maxBytes`, 'bounded_scope', 'must be positive for a write mode.')
  }
}

function validateTimeout(value: unknown, path: string, issues: MutableIssue[]): void {
  if (!requireRecord(value, path, issues)) return
  unknownKeys(value, ['defaultMs', 'maxMs'], path, issues)
  const defaultMs = requireInteger(value.defaultMs, `${path}.defaultMs`, issues, 1, CAPABILITY_MANIFEST_MAX_TIMEOUT_MS)
  const maxMs = requireInteger(value.maxMs, `${path}.maxMs`, issues, 1, CAPABILITY_MANIFEST_MAX_TIMEOUT_MS)
  if (defaultMs !== false && maxMs !== false && defaultMs > maxMs) addIssue(issues, path, 'bounds', 'defaultMs must not exceed maxMs.')
}

function validateConfirmation(value: unknown, path: string, issues: MutableIssue[]): void {
  if (!requireRecord(value, path, issues)) return
  unknownKeys(value, ['mode', 'reason'], path, issues)
  const mode = requireEnum(value.mode, `${path}.mode`, issues, CAPABILITY_CONFIRMATION_MODES)
  const hasReason = hasOwn(value, 'reason')
  if (hasReason && !requireString(value.reason, `${path}.reason`, issues, 300)) { /* issue recorded */ }
  if (mode === 'not_required' && hasReason) addIssue(issues, `${path}.reason`, 'unnecessary', 'must be omitted when confirmation is not required.')
  if ((mode === 'required' || mode === 'unavailable') && (!hasReason || typeof value.reason !== 'string' || value.reason.length === 0)) addIssue(issues, `${path}.reason`, 'reason_required', `must explain why confirmation is ${mode}.`)
}

function validateValidation(value: unknown, path: string, issues: MutableIssue[]): void {
  if (!requireRecord(value, path, issues)) return
  unknownKeys(value, ['mode', 'checks', 'verifierIds'], path, issues)
  const mode = requireEnum(value.mode, `${path}.mode`, issues, CAPABILITY_VALIDATION_MODES)
  const checksValue = value.checks
  let checks: unknown[] | false = false
  if (!Array.isArray(checksValue) || checksValue.length > CAPABILITY_VALIDATION_CHECKS.length) addIssue(issues, `${path}.checks`, 'array', 'must be a unique array of validation checks.')
  else {
    checks = checksValue
    const seen = new Set<string>()
    for (const [index, check] of checksValue.entries()) {
      if (typeof check !== 'string' || !CAPABILITY_VALIDATION_CHECKS.includes(check as CapabilityValidationCheck)) addIssue(issues, `${path}.checks[${index}]`, 'check', `must be one of: ${CAPABILITY_VALIDATION_CHECKS.join(', ')}.`)
      else if (seen.has(check)) addIssue(issues, `${path}.checks[${index}]`, 'duplicate', 'must be unique.')
      seen.add(String(check))
    }
  }
  const verifierIds = validateStringArray(value.verifierIds, `${path}.verifierIds`, issues, { maxItems: 32, itemMaxLength: 120, identifier: true })
  if (mode === 'none') {
    if (checks !== false && checks.length !== 0) addIssue(issues, `${path}.checks`, 'none_scope', 'must be empty when validation mode is none.')
    if (verifierIds && verifierIds.length !== 0) addIssue(issues, `${path}.verifierIds`, 'none_scope', 'must be empty when validation mode is none.')
  } else {
    if (checks !== false && checks.length === 0) addIssue(issues, `${path}.checks`, 'required_checks', 'must include at least one validation check when validation is required.')
    if (verifierIds && verifierIds.length === 0) addIssue(issues, `${path}.verifierIds`, 'required_verifier', 'must include at least one deterministic verifier ID when validation is required.')
  }
}

function validateRedaction(value: unknown, path: string, issues: MutableIssue[]): void {
  if (!requireRecord(value, path, issues)) return
  unknownKeys(value, ['mode', 'fields', 'patterns', 'preserveEvidenceReferences', 'inlineSecrets'], path, issues)
  requireEnum(value.mode, `${path}.mode`, issues, CAPABILITY_REDACTION_MODES)
  validateStringArray(value.fields, `${path}.fields`, issues, { maxItems: 64, itemMaxLength: 120, identifier: true })
  const patternsValue = value.patterns
  if (!Array.isArray(patternsValue) || patternsValue.length === 0 || patternsValue.length > CAPABILITY_REDACTION_PATTERNS.length) addIssue(issues, `${path}.patterns`, 'patterns', `must be a non-empty unique array selected from: ${CAPABILITY_REDACTION_PATTERNS.join(', ')}.`)
  else {
    const seen = new Set<string>()
    for (const [index, pattern] of patternsValue.entries()) {
      if (typeof pattern !== 'string' || !CAPABILITY_REDACTION_PATTERNS.includes(pattern as CapabilityRedactionPattern)) addIssue(issues, `${path}.patterns[${index}]`, 'pattern', `must be one of: ${CAPABILITY_REDACTION_PATTERNS.join(', ')}.`)
      else if (seen.has(pattern)) addIssue(issues, `${path}.patterns[${index}]`, 'duplicate', 'must be unique.')
      seen.add(String(pattern))
    }
  }
  requireBoolean(value.preserveEvidenceReferences, `${path}.preserveEvidenceReferences`, issues)
  if (value.inlineSecrets !== 'never') addIssue(issues, `${path}.inlineSecrets`, 'secret_policy', 'must be the literal value never.')
}

function validateOutputLimits(value: unknown, path: string, issues: MutableIssue[]): void {
  if (!requireRecord(value, path, issues)) return
  unknownKeys(value, ['maxBytes', 'maxItems', 'maxInlineBytes', 'overflow'], path, issues)
  const maxBytes = requireInteger(value.maxBytes, `${path}.maxBytes`, issues, 1, CAPABILITY_MANIFEST_MAX_OUTPUT_BYTES)
  const maxItems = requireInteger(value.maxItems, `${path}.maxItems`, issues, 1, CAPABILITY_MANIFEST_MAX_OUTPUT_ITEMS)
  const maxInlineBytes = requireInteger(value.maxInlineBytes, `${path}.maxInlineBytes`, issues, 1, CAPABILITY_MANIFEST_MAX_INLINE_BYTES)
  requireEnum(value.overflow, `${path}.overflow`, issues, CAPABILITY_OUTPUT_OVERFLOW_MODES)
  if (maxBytes !== false && maxInlineBytes !== false && maxInlineBytes > maxBytes) addIssue(issues, path, 'bounds', 'maxInlineBytes must not exceed maxBytes.')
}

function validateCrossPolicyBounds(value: RecordValue, issues: MutableIssue[]): void {
  const pathPolicy = value.pathPolicy as RecordValue | undefined
  const writePolicy = value.writePolicy as RecordValue | undefined
  if (!isRecord(pathPolicy) || !isRecord(writePolicy)) return
  if (writePolicy.mode !== 'none' && pathPolicy.mode === 'none') addIssue(issues, 'writePolicy.mode', 'authority_boundary', 'cannot declare writes when pathPolicy.mode is none.')
  if (writePolicy.mode === 'source-scoped' && pathPolicy.mode !== 'source-relative') addIssue(issues, 'writePolicy.mode', 'scope_alignment', 'source-scoped writes require source-relative path policy.')
  if (writePolicy.mode === 'artifact-only' && pathPolicy.mode !== 'artifact-relative') addIssue(issues, 'writePolicy.mode', 'scope_alignment', 'artifact-only writes require artifact-relative path policy.')
}

function formatInvalidMessage(issues: readonly CapabilityManifestValidationIssue[], prefix = 'Capability manifest invalid'): string {
  return `${prefix}: ${issues.slice(0, 24).map(issue => `${issue.path} ${issue.message}`).join(' ')}${issues.length > 24 ? ' Further issues were omitted.' : ''}`
}

export function validateCapabilityManifest(value: unknown): CapabilityManifestValidationResult {
  const issues: MutableIssue[] = []
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch {
    addIssue(issues, '$', 'json', 'must be JSON-serializable.')
  }
  if (serialized === undefined) addIssue(issues, '$', 'json', 'must be a JSON object.')
  else if (new TextEncoder().encode(serialized).length > CAPABILITY_MANIFEST_MAX_SERIALIZED_BYTES) addIssue(issues, '$', 'size', `must be at most ${CAPABILITY_MANIFEST_MAX_SERIALIZED_BYTES} UTF-8 bytes.`)
  if (!isRecord(value)) {
    addIssue(issues, '$', 'type', 'must be an object.')
    return { ok: false, code: 'CAPABILITY_MANIFEST_INVALID', message: formatInvalidMessage(issues), issues }
  }

  const envelopeFields = ['kind', 'manifestVersion', 'id', 'version', 'name', 'description']
  unknownKeys(value, [...envelopeFields, ...CAPABILITY_MANIFEST_MANDATORY_FIELDS], '$', issues)
  for (const field of CAPABILITY_MANIFEST_MANDATORY_FIELDS) if (!hasOwn(value, field)) addIssue(issues, field, 'required', 'is required; the manifest has no implicit default.')
  if (value.kind !== WORKBENCH_CAPABILITY_MANIFEST_KIND) addIssue(issues, 'kind', 'kind', `must equal ${WORKBENCH_CAPABILITY_MANIFEST_KIND}.`)
  if (value.manifestVersion !== WORKBENCH_CAPABILITY_MANIFEST_VERSION) addIssue(issues, 'manifestVersion', 'version', `must equal ${WORKBENCH_CAPABILITY_MANIFEST_VERSION}.`)
  if (typeof value.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value.id)) addIssue(issues, 'id', 'identifier', 'must be a bounded stable identifier using letters, numbers, dot, underscore, colon, or hyphen.')
  if (typeof value.version !== 'string' || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value.version)) addIssue(issues, 'version', 'semver', 'must be strict semantic versioning such as 1.0.0 or 1.0.0-beta.1.')
  requireString(value.name, 'name', issues, 120)
  requireString(value.description, 'description', issues, 500)

  const schemaState = { nodes: 0 }
  if (hasOwn(value, 'inputSchema')) validateJsonSchema(value.inputSchema, 'inputSchema', issues, schemaState, 0)
  if (hasOwn(value, 'outputSchema')) validateJsonSchema(value.outputSchema, 'outputSchema', issues, schemaState, 0)
  if (isRecord(value.inputSchema) && value.inputSchema.type !== 'object') addIssue(issues, 'inputSchema.type', 'root_schema', 'must be object so capability arguments are explicit and bounded.')
  if (isRecord(value.outputSchema) && value.outputSchema.type !== 'object') addIssue(issues, 'outputSchema.type', 'root_schema', 'must be object so capability results are structured and bounded.')
  validatePathPolicy(value.pathPolicy, 'pathPolicy', issues)
  validateCwdPolicy(value.cwdPolicy, 'cwdPolicy', issues)
  validateNetworkPolicy(value.networkPolicy, 'networkPolicy', issues)
  validateWritePolicy(value.writePolicy, 'writePolicy', issues)
  validateTimeout(value.timeout, 'timeout', issues)
  if (!CAPABILITY_MANIFEST_RISKS.includes(value.risk as CapabilityManifestRisk)) addIssue(issues, 'risk', 'risk', `must be one of: ${CAPABILITY_MANIFEST_RISKS.join(', ')}; risk is informational.`)
  validateConfirmation(value.confirmation, 'confirmation', issues)
  validateValidation(value.validation, 'validation', issues)
  validateRedaction(value.redaction, 'redaction', issues)
  validateOutputLimits(value.outputLimits, 'outputLimits', issues)
  validateCrossPolicyBounds(value, issues)

  if (issues.length > 0) return { ok: false, code: 'CAPABILITY_MANIFEST_INVALID', message: formatInvalidMessage(issues), issues }
  return { ok: true, value: value as CapabilityManifest }
}

export function parseCapabilityManifest(value: unknown): CapabilityManifest {
  const result = validateCapabilityManifest(value)
  if (result.ok === false) throw new Error(result.message)
  return result.value
}

export function capabilityManifestIdentity(manifest: Pick<CapabilityManifest, 'id' | 'version'>): string {
  return `${manifest.id}@${manifest.version}`
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]))
}

export function serializeCapabilityManifest(manifest: CapabilityManifest): string {
  return JSON.stringify(canonicalize(manifest))
}

export function validateUniqueCapabilityManifestIdentities(manifests: readonly CapabilityManifest[]): readonly CapabilityManifestValidationIssue[] {
  const seen = new Map<string, number>()
  const issues: MutableIssue[] = []
  manifests.forEach((manifest, index) => {
    const identity = capabilityManifestIdentity(manifest)
    const previous = seen.get(identity)
    if (previous !== undefined) addIssue(issues, `manifests[${index}]`, 'duplicate_identity', `duplicates id/version identity ${identity} already declared at manifests[${previous}].`)
    else seen.set(identity, index)
  })
  return issues
}

export function validateCapabilityManifestCollection(values: readonly unknown[]): CapabilityManifestCollectionValidationResult {
  const issues: MutableIssue[] = []
  const manifests: CapabilityManifest[] = []
  values.forEach((value, index) => {
    const result = validateCapabilityManifest(value)
    if (result.ok === false) for (const issue of result.issues) issues.push({ ...issue, path: `manifests[${index}].${issue.path === '$' ? '' : issue.path}`.replace(/\.$/, '') })
    else manifests.push(result.value)
  })
  if (issues.length === 0) issues.push(...validateUniqueCapabilityManifestIdentities(manifests))
  if (issues.length > 0) return {
    ok: false,
    code: 'CAPABILITY_MANIFEST_COLLECTION_INVALID',
    message: formatInvalidMessage(issues, 'Capability manifest collection invalid'),
    issues
  }
  return { ok: true, value: manifests }
}

function schemaInspection(schema: CapabilityJsonSchema): string {
  if (schema.type === 'object') return `object; required=${schema.required?.join(',') || 'none'}; fields=${Object.keys(schema.properties || {}).join(',') || 'none'}; closed=true`
  if (schema.type === 'array') return `array of ${schema.items?.type || 'unknown'}; maxItems=${schema.maxItems ?? 'manifest-bounded'}`
  return schema.type + (schema.enum ? `; enum=${schema.enum.map(String).join('|')}` : '')
}

export function inspectCapabilityManifest(manifest: CapabilityManifest): CapabilityManifestInspection {
  const pathScope = manifest.pathPolicy.mode === 'none'
    ? 'none'
    : `${manifest.pathPolicy.mode} roots=${manifest.pathPolicy.allowedRoots.join(',')} maxPaths=${manifest.pathPolicy.maxPaths} maxBytes=${manifest.pathPolicy.maxBytes}`
  const cwdScope = manifest.cwdPolicy.mode === 'allowed-subdirectories'
    ? `${manifest.cwdPolicy.mode}=${manifest.cwdPolicy.allowedPaths.join(',')}`
    : manifest.cwdPolicy.mode
  return {
    id: manifest.id,
    version: manifest.version,
    name: manifest.name,
    risk: manifest.risk,
    writes: manifest.writePolicy.mode !== 'none',
    network: manifest.networkPolicy.mode === 'denied' ? 'none' : 'bounded',
    pathScope,
    cwdScope,
    confirmation: manifest.confirmation.mode === 'not_required' ? 'no' : manifest.confirmation.mode === 'required' ? 'yes' : 'unavailable',
    timeout: `default=${manifest.timeout.defaultMs}ms max=${manifest.timeout.maxMs}ms`,
    input: schemaInspection(manifest.inputSchema),
    output: schemaInspection(manifest.outputSchema),
    validation: `${manifest.validation.mode}; checks=${manifest.validation.checks.join(',') || 'none'}; verifiers=${manifest.validation.verifierIds.join(',') || 'none'}`,
    redaction: `${manifest.redaction.mode}; patterns=${manifest.redaction.patterns.join(',')}; inlineSecrets=${manifest.redaction.inlineSecrets}`,
    outputLimit: `maxBytes=${manifest.outputLimits.maxBytes} maxItems=${manifest.outputLimits.maxItems} maxInlineBytes=${manifest.outputLimits.maxInlineBytes} overflow=${manifest.outputLimits.overflow}`
  }
}

export function formatCapabilityManifestInspection(manifest: CapabilityManifest): string {
  const inspection = inspectCapabilityManifest(manifest)
  return [
    `Capability ${inspection.name} (${inspection.id}@${inspection.version})`,
    `Risk: ${inspection.risk}; writes: ${inspection.writes ? 'yes' : 'no'}; network: ${inspection.network}`,
    `Paths: ${inspection.pathScope}; cwd: ${inspection.cwdScope}`,
    `Confirmation: ${inspection.confirmation}; timeout: ${inspection.timeout}`,
    `Input: ${inspection.input}`,
    `Output: ${inspection.output}`,
    `Validation: ${inspection.validation}`,
    `Redaction: ${inspection.redaction}`,
    `Output limits: ${inspection.outputLimit}`,
    `Authority: ${CAPABILITY_MANIFEST_AUTHORITY}; Phase 16 effective authorization remains authoritative.`
  ].join('\n')
}

const CLI_FORBIDDEN_SHELL_FIELDS = ['command', 'commandString', 'shellCommand', 'shellString'] as const
const CLI_ARBITRARY_ARGUMENT_FIELDS = ['additionalArgs', 'allowAdditionalArgs', 'inheritArgs', 'passthrough', 'trailingArgs', 'userArgs'] as const
const CLI_SHELL_COMPOSITION_PATTERN = /[\0\r\n;|<>`]|\$\(|&&|\|\|/
const CLI_SHELL_LAUNCH_PATTERN = /(?:^|[\s/])(?:sh|bash|zsh)\s+-c(?:\s|$)/i

function cliInvalidMessage(issues: readonly CapabilityManifestValidationIssue[]): string {
  return formatInvalidMessage(issues, 'CLI capability manifest invalid')
}

function cliBaseValue(value: RecordValue): RecordValue {
  const base: RecordValue = {}
  for (const [key, item] of Object.entries(value)) if (key !== 'cli') base[key] = item
  return base
}

function cliInputSchemaProperty(value: RecordValue, input: string): RecordValue | undefined {
  const inputSchema = value.inputSchema
  if (!isRecord(inputSchema) || !isRecord(inputSchema.properties)) return undefined
  const property = inputSchema.properties[input]
  return isRecord(property) ? property : undefined
}

function validateCliExecutable(value: unknown, path: string, issues: MutableIssue[]): void {
  if (typeof value === 'string') {
    addIssue(issues, path, 'shell_string', 'shell command strings are not supported; use the structured executable object.')
    return
  }
  if (!requireRecord(value, path, issues)) return
  unknownKeys(value, ['name'], path, issues)
  const name = requireString(value.name, `${path}.name`, issues, 120)
  if (!name) return
  if (CLI_SHELL_LAUNCH_PATTERN.test(name) || CLI_SHELL_COMPOSITION_PATTERN.test(name)) {
    addIssue(issues, `${path}.name`, 'shell_string', 'shell command strings are not supported; use one allowlisted executable name.')
  }
  if (!CLI_CAPABILITY_EXECUTABLE_NAMES.includes(name as CliCapabilityExecutableName)) {
    addIssue(issues, `${path}.name`, 'executable_not_allowlisted', `must be one of: ${CLI_CAPABILITY_EXECUTABLE_NAMES.join(', ')}.`)
  }
}

function validateCliInputBinding(
  manifest: RecordValue,
  template: RecordValue,
  path: string,
  issues: MutableIssue[],
  expectedType: CliCapabilityArgumentValueType | 'string'
): void {
  const input = requireString(template.input, `${path}.input`, issues, 120)
  if (!input) return
  const property = cliInputSchemaProperty(manifest, input)
  if (!property) {
    addIssue(issues, `${path}.input`, 'undeclared_input', `references undeclared input '${input}'.`)
    return
  }
  if (property.type !== expectedType) {
    addIssue(issues, `${path}.input`, 'incompatible_input_type', `input '${input}' has type ${String(property.type)} but the template requires ${expectedType}.`)
  }
}

function validateCliArgumentTemplate(manifest: RecordValue, value: unknown, path: string, issues: MutableIssue[]): void {
  if (!requireRecord(value, path, issues)) return
  for (const key of CLI_ARBITRARY_ARGUMENT_FIELDS) {
    if (hasOwn(value, key)) addIssue(issues, `${path}.${key}`, 'arbitrary_arguments', 'arbitrary argument inheritance is prohibited; declare each argv position explicitly.')
  }
  const kind = requireEnum(value.kind, `${path}.kind`, issues, CLI_CAPABILITY_ARGUMENT_TEMPLATE_KINDS)
  if (!kind) {
    if (typeof value.kind === 'string' && (value.kind === 'passthrough' || value.kind === 'inherit' || value.kind === 'trailing')) {
      addIssue(issues, `${path}.kind`, 'arbitrary_arguments', 'arbitrary argument inheritance is prohibited; declare each argv position explicitly.')
    }
    return
  }

  if (kind === 'literal') {
    unknownKeys(value, ['kind', 'value'], path, issues)
    const literal = requireString(value.value, `${path}.value`, issues, CLI_CAPABILITY_MAX_LITERAL_LENGTH)
    if (literal && CLI_SHELL_COMPOSITION_PATTERN.test(literal)) addIssue(issues, `${path}.value`, 'shell_string', 'shell command strings and shell composition are not supported in literal arguments.')
    if (literal && CLI_SHELL_LAUNCH_PATTERN.test(literal)) addIssue(issues, `${path}.value`, 'shell_string', 'sh -c, bash -c, and zsh -c forms are not supported.')
    return
  }

  if (kind === 'input') {
    unknownKeys(value, ['kind', 'input', 'valueType'], path, issues)
    const valueType = requireEnum(value.valueType, `${path}.valueType`, issues, CLI_CAPABILITY_ARGUMENT_VALUE_TYPES)
    if (valueType) validateCliInputBinding(manifest, value, path, issues, valueType)
    return
  }

  unknownKeys(value, ['kind', 'input', 'pathMode'], path, issues)
  const pathMode = requireEnum(value.pathMode, `${path}.pathMode`, issues, CLI_CAPABILITY_PATH_TEMPLATE_MODES)
  validateCliInputBinding(manifest, value, path, issues, 'string')
  if (pathMode) {
    const pathPolicy = manifest.pathPolicy
    const pathPolicyMode = isRecord(pathPolicy) ? pathPolicy.mode : undefined
    if (pathPolicyMode !== pathMode) {
      addIssue(issues, `${path}.pathMode`, 'path_binding', `must match pathPolicy.mode ${String(pathPolicyMode)}; typed paths cannot expand path authority.`)
    }
  }
}

function validateCliEnvironment(value: unknown, path: string, issues: MutableIssue[]): void {
  if (!requireRecord(value, path, issues)) return
  unknownKeys(value, ['mode', 'inheritedKeys'], path, issues)
  requireEnum(value.mode, `${path}.mode`, issues, ['minimal'] as const)
  const inheritedKeys = validateStringArray(value.inheritedKeys, `${path}.inheritedKeys`, issues, { maxItems: 0, itemMaxLength: 120, identifier: true })
  if (inheritedKeys && inheritedKeys.length > 0) addIssue(issues, `${path}.inheritedKeys`, 'ambient_environment', 'arbitrary environment inheritance is prohibited; inheritedKeys must be empty.')
}

function validateCliDeclaration(manifest: RecordValue, value: unknown, path: string, issues: MutableIssue[]): void {
  if (typeof value === 'string') {
    addIssue(issues, path, 'shell_string', 'shell command strings are not supported; use the structured CLI declaration.')
    return
  }
  if (!requireRecord(value, path, issues)) return
  unknownKeys(value, ['executable', 'argv', 'shell', 'environment'], path, issues)
  for (const key of CLI_FORBIDDEN_SHELL_FIELDS) {
    if (hasOwn(value, key)) addIssue(issues, `${path}.${key}`, 'shell_string', 'shell command strings are not supported; use structured executable and argv templates.')
  }
  for (const key of CLI_ARBITRARY_ARGUMENT_FIELDS) {
    if (hasOwn(value, key)) addIssue(issues, `${path}.${key}`, 'arbitrary_arguments', 'arbitrary argument inheritance is prohibited; declare each argv position explicitly.')
  }
  validateCliExecutable(value.executable, `${path}.executable`, issues)
  if (value.shell !== false) addIssue(issues, `${path}.shell`, 'shell_not_allowed', 'must be the literal value false; CLI capabilities never invoke a shell.')

  if (!Array.isArray(value.argv)) {
    addIssue(issues, `${path}.argv`, 'structured_argv', 'must be an array of typed argument templates; shell strings are not supported.')
  } else {
    if (value.argv.length > CLI_CAPABILITY_MAX_ARG_TEMPLATES) addIssue(issues, `${path}.argv`, 'argument_count', `must contain at most ${CLI_CAPABILITY_MAX_ARG_TEMPLATES} declared argument positions.`)
    for (const [index, template] of value.argv.entries()) validateCliArgumentTemplate(manifest, template, `${path}.argv[${index}]`, issues)
    for (let index = 0; index < value.argv.length - 1; index += 1) {
      const current = value.argv[index]
      const next = value.argv[index + 1]
      if (isRecord(current) && isRecord(next) && current.kind === 'literal' && next.kind === 'literal' && typeof current.value === 'string' && typeof next.value === 'string' && /^(?:sh|bash|zsh)$/i.test(current.value) && next.value === '-c') {
        addIssue(issues, `${path}.argv[${index}]`, 'shell_string', 'sh -c, bash -c, and zsh -c forms are not supported.')
      }
    }
  }
  validateCliEnvironment(value.environment, `${path}.environment`, issues)

  const networkPolicy = manifest.networkPolicy
  if (isRecord(networkPolicy) && networkPolicy.mode !== 'denied') {
    addIssue(issues, 'networkPolicy.mode', 'ambient_network', 'ambient network is prohibited; CLI manifests must use networkPolicy.mode denied.')
  }
}

export function validateCliCapabilityManifest(value: unknown): CliCapabilityManifestValidationResult {
  const issues: MutableIssue[] = []
  if (!isRecord(value)) {
    addIssue(issues, '$', 'type', 'must be an object containing a structured cli declaration.')
    return { ok: false, code: 'CLI_CAPABILITY_MANIFEST_INVALID', message: cliInvalidMessage(issues), issues }
  }

  const baseResult = validateCapabilityManifest(cliBaseValue(value))
  if (baseResult.ok === false) issues.push(...baseResult.issues)
  if (!hasOwn(value, 'cli')) addIssue(issues, 'cli', 'required', 'is required; CLI execution shape has no implicit default.')
  else validateCliDeclaration(value, value.cli, 'cli', issues)

  if (issues.length > 0) return { ok: false, code: 'CLI_CAPABILITY_MANIFEST_INVALID', message: cliInvalidMessage(issues), issues }
  return { ok: true, value: value as CliCapabilityManifest }
}

export function parseCliCapabilityManifest(value: unknown): CliCapabilityManifest {
  const result = validateCliCapabilityManifest(value)
  if (result.ok === false) throw new Error(result.message)
  return result.value
}

export function serializeCliCapabilityManifest(manifest: CliCapabilityManifest): string {
  return JSON.stringify(canonicalize(manifest))
}

export function inspectCliCapabilityManifest(manifest: CliCapabilityManifest): CliCapabilityManifestInspection {
  const base = inspectCapabilityManifest(manifest)
  const fixedArguments: string[] = []
  const userControlledArguments: string[] = []
  for (const template of manifest.cli.argv) {
    if (template.kind === 'literal') fixedArguments.push(template.value)
    else if (template.kind === 'input') userControlledArguments.push(`input ${template.input}:${template.valueType}`)
    else userControlledArguments.push(`path ${template.input}:${template.pathMode}`)
  }
  return {
    ...base,
    executable: manifest.cli.executable.name,
    fixedArguments,
    userControlledArguments,
    shell: 'no',
    arbitraryArguments: 'no',
    ambientNetwork: 'no',
    environment: 'minimal-no-inheritance',
    argvLength: manifest.cli.argv.length
  }
}

export function formatCliCapabilityManifestInspection(manifest: CliCapabilityManifest): string {
  const inspection = inspectCliCapabilityManifest(manifest)
  return [
    `CLI: ${inspection.executable}`,
    'Arguments:',
    `  fixed: ${inspection.fixedArguments.join(' ') || 'none'}`,
    `  user-controlled: ${inspection.userControlledArguments.join(', ') || 'none'}`,
    `  maximum positions: ${inspection.argvLength}`,
    `Shell: ${inspection.shell}`,
    `Arbitrary inherited args: ${inspection.arbitraryArguments}`,
    `Environment: ${inspection.environment}`,
    `Ambient network: ${inspection.ambientNetwork}`,
    `Writes: ${inspection.writes ? 'yes' : 'no'}`,
    `Paths: ${inspection.pathScope}`,
    `CWD: ${inspection.cwdScope}`,
    `Timeout: ${inspection.timeout}`,
    `Output: ${inspection.output}`,
    `Authority: ${CAPABILITY_MANIFEST_AUTHORITY}; Phase 16 effective authorization remains authoritative.`
  ].join('\n')
}
