import fs from 'node:fs'
import path from 'node:path'
import {
  CAPABILITY_MANIFEST_MAX_OUTPUT_BYTES,
  evaluateAutonomyPolicy,
  evaluateConnectedRepositoryPath,
  type AutonomyPolicyEvaluation,
  type AutonomyPolicyEvaluationInput,
  type CapabilityJsonSchema,
  type CapabilityManifest,
  type CapabilityNetworkMethod
} from '@workbench/shared'
import { validateCapabilityBeforeExecution, type ExecutionValidationState } from './capability-pre-execution.js'
import type { CapabilityGrantSnapshot, CapabilityPlan } from './capability-planning.js'
import type { CapabilityJobEvidence, CapabilityJobHandlerResult, CapabilityJobIdentity } from './capability-execution-coordinator.js'
import type { ProviderInventoryRecord } from './provider-inventory.js'

/**
 * R17.3's only execution authority boundary. The registry still decides what
 * is configured; this guard decides whether this exact invocation may cross
 * into the configured handler.
 */

export type CapabilityRuntimeIdentity = Readonly<{
  sourceId: string
  sessionId: string
  runId: string
  requestId: string
  capabilityId: string
  capabilityVersion: string
  providerId: string
  bindingId?: string
}>

export type CapabilityPhase16Context = Readonly<{
  identity: Readonly<{ sourceId: string; sessionId: string; runId: string }>
  policyInput?: AutonomyPolicyEvaluationInput
  policyInputs?: readonly AutonomyPolicyEvaluationInput[]
  plan?: CapabilityPlan
  validationState?: Omit<ExecutionValidationState, 'plan'>
}>

export type CapabilityHardWritePolicy = Readonly<{
  allowed: boolean
  allowedPaths?: readonly string[]
  maxFiles?: number
  maxBytes?: number
}>

export type CapabilityHardNetworkPolicy = Readonly<{
  allowed: boolean
  allowedTargets?: readonly string[]
  allowedMethods?: readonly CapabilityNetworkMethod[]
  maxRequests?: number
}>

export type CapabilityValidationVerifier = (input: Readonly<{
  output: unknown
  request: CapabilityRuntimeIdentity
  authorized: CapabilityAuthorizedExecutionContext
}>) => boolean | Promise<boolean>

export type CapabilityRuntimeContext = Readonly<{
  sourceRoot?: string
  artifactRoot?: string
  hardWrite?: CapabilityHardWritePolicy
  hardNetwork?: CapabilityHardNetworkPolicy
  additionalProtectedPaths?: readonly string[]
  provider?: ProviderInventoryRecord
  validationVerifiers?: Readonly<Record<string, CapabilityValidationVerifier>>
}>

export type CapabilityGuardInput = Readonly<{
  manifest: CapabilityManifest
  arguments: unknown
  identity: CapabilityRuntimeIdentity
  phase16?: CapabilityPhase16Context
  capability: CapabilityRuntimeContext
  now?: () => Date
  requestedTimeoutMs?: number
}>

export type CapabilityPathBinding = Readonly<{
  requested: string
  relative: string
  canonical: string
}>

export type CapabilityNetworkBinding = Readonly<{
  target: string
  method: CapabilityNetworkMethod
}>

export type CapabilityAuthorizedExecutionContext = Readonly<{
  input: unknown
  sourceId: string
  sessionId: string
  runId: string
  requestId: string
  cwd?: string
  /** Present only when the manifest uses broker-authorized artifact-relative paths. */
  artifactRoot?: string
  paths: readonly CapabilityPathBinding[]
  writePaths: readonly CapabilityPathBinding[]
  networkRequests: readonly CapabilityNetworkBinding[]
  timeoutMs: number
  policy: Readonly<{ decisions: readonly AutonomyPolicyEvaluation[] }>
  confirmation: CapabilityManifest['confirmation']
  validation: CapabilityManifest['validation']
  redaction: CapabilityManifest['redaction']
  outputLimits: CapabilityManifest['outputLimits']
}>

export type CapabilityGuardRejection = Readonly<{
  ok: false
  code:
    | 'manifest_invalid'
    | 'identity_mismatch'
    | 'input_invalid'
    | 'path_not_allowed'
    | 'cwd_not_allowed'
    | 'write_not_allowed'
    | 'network_not_allowed'
    | 'phase16_policy_denied'
    | 'phase16_confirmation_required'
    | 'phase16_context_missing'
    | 'phase16_plan_invalid'
    | 'confirmation_required'
    | 'timeout_not_allowed'
    | 'runtime_context_missing'
  message: string
  trace: readonly string[]
}>

export type CapabilityGuardResult =
  | Readonly<{ ok: true; value: CapabilityAuthorizedExecutionContext }>
  | CapabilityGuardRejection

export type CapabilityOutputEnforcementOptions = Readonly<{
  request: CapabilityRuntimeIdentity
  authorized: CapabilityAuthorizedExecutionContext
  job: CapabilityJobIdentity
  validationVerifiers?: Readonly<Record<string, CapabilityValidationVerifier>>
}>

type RecordValue = Record<string, unknown>
type SchemaIssue = Readonly<{ path: string; code: string; message: string }>

const MAX_TRACE = 12
const MAX_INPUT_BYTES = 64 * 1024
const MAX_ERROR_MESSAGE = 1_000
const SECRET_KEY = /(?:secret|token|password|passwd|credential|authorization|api[_-]?key|private[_-]?key)/i
const PRIVATE_KEY = /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/gi
const SECRET_VALUE = /(?:github_pat_|ghp_|gho_|ghu_|ghs_|ghr_|sk_live_|rk_live_|xox[baprs]-|AKIA)[A-Za-z0-9_\-]{8,}/g
const KEY_VALUE_SECRET = /((?:password|passwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*)(["']?)([^\s"']{8,})\2/gi

function record(value: unknown): value is RecordValue { return !!value && typeof value === 'object' && !Array.isArray(value) }
function bounded(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max }
function trace(...values: string[]): readonly string[] { return values.filter(Boolean).slice(0, MAX_TRACE) }
function reject(code: CapabilityGuardRejection['code'], message: string, ...details: string[]): CapabilityGuardRejection {
  return { ok: false, code, message, trace: trace(code, ...details) }
}
function prefixOrEqual(parent: string, child: string): boolean {
  return parent === child || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`)
}
function jsonBytes(value: unknown): number | undefined {
  try {
    const serialized = JSON.stringify(value)
    return serialized === undefined ? undefined : Buffer.byteLength(serialized, 'utf8')
  } catch { return undefined }
}

function normalizedJson(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) throw new Error('cyclic')
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map(item => normalizedJson(item, seen))
    const object = value as RecordValue
    return Object.fromEntries(Object.keys(object).sort().map(key => [key, normalizedJson(object[key], seen)]))
  } finally { seen.delete(value) }
}

function schemaTypeMatches(type: CapabilityJsonSchema['type'], value: unknown): boolean {
  if (type === 'null') return value === null
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return record(value)
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'boolean') return typeof value === 'boolean'
  return typeof value === 'string'
}

function sameScalar(left: unknown, right: unknown): boolean {
  return left === right && (typeof left !== 'number' || Object.is(left, right))
}

function validateJsonValue(schema: CapabilityJsonSchema, value: unknown, currentPath: string, issues: SchemaIssue[], state: { nodes: number }): void {
  if (issues.length >= 24) return
  state.nodes += 1
  if (state.nodes > 10_000) { issues.push({ path: currentPath, code: 'nodes', message: 'contains too many nested values.' }); return }
  if (!schemaTypeMatches(schema.type, value)) {
    issues.push({ path: currentPath, code: 'type', message: `must be ${schema.type}.` })
    return
  }
  if (schema.enum && !schema.enum.some(item => sameScalar(item, value))) issues.push({ path: currentPath, code: 'enum', message: 'must use a declared value.' })
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) issues.push({ path: currentPath, code: 'minLength', message: `must contain at least ${schema.minLength} characters.` })
    if (schema.maxLength !== undefined && value.length > schema.maxLength) issues.push({ path: currentPath, code: 'maxLength', message: `must contain at most ${schema.maxLength} characters.` })
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) issues.push({ path: currentPath, code: 'minimum', message: `must be at least ${schema.minimum}.` })
    if (schema.maximum !== undefined && value > schema.maximum) issues.push({ path: currentPath, code: 'maximum', message: `must be at most ${schema.maximum}.` })
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) issues.push({ path: currentPath, code: 'minItems', message: `must contain at least ${schema.minItems} items.` })
    if (schema.maxItems !== undefined && value.length > schema.maxItems) issues.push({ path: currentPath, code: 'maxItems', message: `must contain at most ${schema.maxItems} items.` })
    if (schema.items) value.forEach((item, index) => validateJsonValue(schema.items!, item, `${currentPath}[${index}]`, issues, state))
  }
  if (record(value)) {
    const properties = schema.properties || {}
    for (const key of Object.keys(value).sort()) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) issues.push({ path: `${currentPath}.${key}`, code: 'unknown', message: 'is not declared by the capability input/output schema.' })
    }
    for (const key of schema.required || []) if (!Object.prototype.hasOwnProperty.call(value, key)) issues.push({ path: `${currentPath}.${key}`, code: 'required', message: 'is required.' })
    for (const key of Object.keys(properties).sort()) if (Object.prototype.hasOwnProperty.call(value, key)) validateJsonValue(properties[key]!, value[key], `${currentPath}.${key}`, issues, state)
  }
}

function inputRejection(manifest: CapabilityManifest, value: unknown): CapabilityGuardRejection | undefined {
  const bytes = jsonBytes(value)
  if (bytes === undefined || bytes > MAX_INPUT_BYTES) return reject('input_invalid', `Rejected: capability input exceeds the bounded ${MAX_INPUT_BYTES}-byte request limit. Reduce the arguments and retry.`, 'input_size')
  const issues: SchemaIssue[] = []
  validateJsonValue(manifest.inputSchema, value, '$', issues, { nodes: 0 })
  const issue = issues[0]
  if (!issue) return undefined
  const argument = issue.path.startsWith('$.') ? issue.path.slice(2).split(/[.[\]]/)[0] : issue.path
  if (issue.code === 'unknown') return reject('input_invalid', `Rejected: argument '${argument}' is not declared by capability ${manifest.id}@${manifest.version}. Remove it or use a declared argument.`, issue.path)
  if (issue.code === 'required') return reject('input_invalid', `Rejected: argument '${argument}' is required by capability ${manifest.id}@${manifest.version}. Provide it and retry.`, issue.path)
  return reject('input_invalid', `Rejected: argument '${argument}' is invalid for capability ${manifest.id}@${manifest.version}; ${issue.message} Correct the argument and retry.`, issue.path)
}

function safeRelative(value: string): boolean {
  if (!value || value.startsWith('/') || value.startsWith('~') || value.includes('\\') || value.includes('\0')) return false
  return value.split('/').every(part => part.length > 0 && part !== '..')
}

function realpathWithMissingTail(candidate: string): string | undefined {
  let current = path.resolve(candidate)
  const tail: string[] = []
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) return undefined
    tail.unshift(path.basename(current))
    current = parent
  }
  try { return path.resolve(fs.realpathSync.native(current), ...tail) } catch { return undefined }
}

function canonicalRoot(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const resolved = path.resolve(value)
    if (!fs.statSync(resolved).isDirectory()) return undefined
    return fs.realpathSync.native(resolved)
  } catch { return undefined }
}

function hasSymlinkComponent(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return true
  let current = root
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component)
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return true
    } catch {
      break
    }
  }
  return false
}

function extractStrings(input: RecordValue, keys: readonly string[]): string[] {
  const values: string[] = []
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string') values.push(value)
    else if (Array.isArray(value)) values.push(...value.filter((item): item is string => typeof item === 'string'))
  }
  return values
}

function extractPathClaims(input: unknown, manifest: CapabilityManifest): string[] {
  if (!record(input)) return []
  const claims = extractStrings(input, ['path', 'paths', 'file', 'files', 'writePath', 'writePaths'])
  // R18.1 CLI manifests can bind a source path under any declared input name
  // (for example `root`). Bring those typed path arguments through the same
  // canonical-root, symlink, protected-path, and Phase 16 checks as legacy
  // generic path fields. The handler must never authorize a path merely
  // because it appeared in an argv template.
  const cli = (manifest as RecordValue).cli
  if (record(cli) && Array.isArray(cli.argv)) {
    for (const template of cli.argv) {
      if (!record(template) || template.kind !== 'path' || typeof template.input !== 'string') continue
      const value = input[template.input]
      if (typeof value === 'string') claims.push(value)
    }
  }
  return [...new Set(claims)]
}

function extractWriteClaims(input: unknown, writeMode: CapabilityManifest['writePolicy']['mode'], manifest: CapabilityManifest): string[] {
  if (!record(input)) return []
  const explicit = extractStrings(input, ['writePath', 'writePaths'])
  if (writeMode === 'artifact-only') {
    const cli = (manifest as RecordValue).cli
    const templates = record(cli) && Array.isArray(cli.argv) ? cli.argv : []
    const cliPathClaims = templates.flatMap(template => record(template) && template.kind === 'path' && typeof template.input === 'string' && typeof input[template.input] === 'string' ? [input[template.input] as string] : [])
    return [...new Set([...explicit, ...extractStrings(input, ['path', 'paths']), ...cliPathClaims])]
  }
  if (writeMode !== 'none') return [...new Set([...explicit, ...extractStrings(input, ['path', 'paths'])])]
  return explicit
}

function extractNetworkClaims(input: unknown): CapabilityNetworkBinding[] {
  if (!record(input)) return []
  const values: CapabilityNetworkBinding[] = []
  const add = (target: unknown, method: unknown): void => {
    if (typeof target !== 'string') return
    const normalizedMethod = typeof method === 'string' ? method.toUpperCase() : 'GET'
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(normalizedMethod)) return
    values.push({ target, method: normalizedMethod as CapabilityNetworkMethod })
  }
  add(input.networkTarget, input.networkMethod)
  if (typeof input.network === 'string') add(input.network, input.networkMethod)
  if (record(input.network)) add(input.network.target, input.network.method)
  const requests = Array.isArray(input.networkRequests) ? input.networkRequests : []
  for (const item of requests) if (record(item)) add(item.target, item.method)
  return values
}

function relativePath(root: string, candidate: string): string {
  return path.relative(root, candidate).split(path.sep).join('/')
}

function protectedRelative(value: string, manifest: CapabilityManifest, capability: CapabilityRuntimeContext): boolean {
  if (evaluateConnectedRepositoryPath(value)) return true
  const protectedPaths = [...manifest.pathPolicy.additionalProtectedPaths, ...(capability.additionalProtectedPaths || [])]
  return protectedPaths.some(item => prefixOrEqual(item, value))
}

function resolvePathClaim(requested: string, manifest: CapabilityManifest, capability: CapabilityRuntimeContext): CapabilityPathBinding | CapabilityGuardRejection {
  if (manifest.pathPolicy.mode === 'none') return reject('path_not_allowed', 'Rejected: this capability does not declare path access. Remove the path argument and retry.', 'path_policy=none')
  if (!safeRelative(requested)) return reject('path_not_allowed', 'Rejected: the requested path is absolute, empty, or contains unsafe traversal. Use a declared source-relative path.', 'path_shape')
  const rootValue = manifest.pathPolicy.mode === 'artifact-relative' ? capability.artifactRoot : capability.sourceRoot
  const root = canonicalRoot(rootValue)
  if (!root) return reject('runtime_context_missing', 'Rejected: the capability source/artifact root is unavailable, so its path cannot be authorized safely.', 'root_missing')
  const candidate = path.resolve(root, requested)
  const canonical = realpathWithMissingTail(candidate)
  if (!canonical || !prefixOrEqual(root, canonical)) return reject('path_not_allowed', 'Rejected: the requested path escapes the configured source or artifact root. Use a path inside the selected source.', 'root_escape')
  if (manifest.pathPolicy.mode === 'artifact-relative' && hasSymlinkComponent(root, candidate)) return reject('path_not_allowed', 'Rejected: artifact-relative output paths may not traverse a symbolic link. Use a direct path inside the broker-created output root.', 'artifact_symlink')
  const canonicalRelative = relativePath(root, canonical)
  if (!manifest.pathPolicy.allowedRoots.some(item => prefixOrEqual(item, canonicalRelative))) return reject('path_not_allowed', 'Rejected: the requested path is outside this capability manifest’s declared path roots. Use one of its declared roots.', 'manifest_root')
  if (protectedRelative(canonicalRelative, manifest, capability)) return reject('path_not_allowed', 'Rejected: the requested path is protected by Workbench safety policy. Use a non-sensitive path inside the declared scope.', 'protected_path')
  return { requested, relative: canonicalRelative, canonical }
}

function cwdFor(input: unknown, manifest: CapabilityManifest, capability: CapabilityRuntimeContext): string | undefined | CapabilityGuardRejection {
  if (!record(input) || input.cwd === undefined) {
    if (manifest.cwdPolicy.mode === 'source-root') {
      const root = canonicalRoot(capability.sourceRoot)
      if (!root) return reject('runtime_context_missing', 'Rejected: the source root is unavailable for this capability’s cwd policy.', 'cwd_root_missing')
      return root
    }
    return undefined
  }
  if (typeof input.cwd !== 'string' || !safeRelative(input.cwd)) return reject('cwd_not_allowed', 'Rejected: requested cwd must be a safe relative directory inside the selected source. Use a declared cwd path.', 'cwd_shape')
  if (manifest.cwdPolicy.mode === 'none') return reject('cwd_not_allowed', 'Rejected: this capability does not permit a working directory. Remove cwd and retry.', 'cwd_policy=none')
  const sourceRoot = canonicalRoot(capability.sourceRoot)
  if (!sourceRoot) return reject('runtime_context_missing', 'Rejected: the source root is unavailable for this capability’s cwd policy.', 'cwd_root_missing')
  if (manifest.cwdPolicy.mode === 'source-root' && input.cwd !== '.' && input.cwd !== '') return reject('cwd_not_allowed', 'Rejected: cwd must be the selected source root for this capability. Remove the override or use the source root.', 'cwd_source_root')
  if (manifest.cwdPolicy.mode === 'allowed-subdirectories' && !manifest.cwdPolicy.allowedPaths.some(item => prefixOrEqual(item, input.cwd as string))) return reject('cwd_not_allowed', 'Rejected: requested cwd is outside the manifest’s declared source subdirectories. Use a declared cwd path.', 'cwd_manifest_scope')
  const candidate = path.resolve(sourceRoot, input.cwd)
  const canonical = realpathWithMissingTail(candidate)
  if (!canonical || !prefixOrEqual(sourceRoot, canonical)) return reject('cwd_not_allowed', 'Rejected: requested cwd escapes the selected source. Use a source-relative directory.', 'cwd_root_escape')
  if (manifest.cwdPolicy.mode === 'allowed-subdirectories' && !manifest.cwdPolicy.allowedPaths.some(item => prefixOrEqual(item, relativePath(sourceRoot, canonical)))) return reject('cwd_not_allowed', 'Rejected: requested cwd is outside the manifest’s declared source subdirectories. Use a declared cwd path.', 'cwd_canonical_scope')
  return canonical
}

function targetAllowed(target: string, allowed: readonly string[]): boolean { return allowed.some(item => prefixOrEqual(item, target)) }

function policyScopes(input: CapabilityPhase16Context, identity: CapabilityRuntimeIdentity, paths: readonly CapabilityPathBinding[], network: readonly CapabilityNetworkBinding[]): readonly AutonomyPolicyEvaluationInput[] {
  const base = input.policyInputs || (input.policyInput ? [input.policyInput] : [])
  const sorted = [...base].sort((left, right) => `${String(left.category)}:${String(left.operation)}`.localeCompare(`${String(right.category)}:${String(right.operation)}`))
  return sorted.flatMap(policy => {
    const category = policy.category
    const scopes = category === 'network'
      ? network.map(item => ({ networkTarget: item.target }))
      : category === 'write' || category === 'read'
        ? paths.map(item => ({ path: item.relative }))
        : category === 'capability' ? [{ capabilityId: identity.capabilityId }] : [policy.scope || {}]
    return (scopes.length > 0 ? scopes : [policy.scope || {}]).map(scope => ({ ...policy, scope }))
  })
}

function phase16FailureMessage(evaluation: AutonomyPolicyEvaluation): { code: CapabilityGuardRejection['code']; message: string } {
  if (evaluation.decision === 'requires_confirmation') return { code: 'phase16_confirmation_required', message: 'Rejected: the current Phase 16 policy requires confirmation for this exact capability operation. Confirm that exact operation and retry.' }
  if (evaluation.reasonCode === 'NETWORK_NOT_GRANTED') return { code: 'phase16_policy_denied', message: 'Rejected: the current Phase 16 policy does not allow the requested network target.' }
  if (evaluation.reasonCode === 'PROTECTED_PATH' || evaluation.reasonCode === 'SCOPE_EMPTY') return { code: 'phase16_policy_denied', message: 'Rejected: the current Phase 16 policy does not allow the requested path scope.' }
  if (evaluation.reasonCode === 'PERSISTED_DENIAL' || evaluation.reasonCode === 'CONFIRMATION_DENIED') return { code: 'phase16_policy_denied', message: 'Rejected: an existing exact Phase 16 denial applies; no new confirmation prompt is created.' }
  return { code: 'phase16_policy_denied', message: `Rejected: the current Phase 16 policy denies this capability operation (${evaluation.reasonCode}). Change the governing policy or request a permitted operation.` }
}

function phase16Guard(input: CapabilityGuardInput, paths: readonly CapabilityPathBinding[], network: readonly CapabilityNetworkBinding[]): CapabilityGuardRejection | { decisions: readonly AutonomyPolicyEvaluation[] } {
  const phase16 = input.phase16
  if (!phase16 || !phase16.identity || phase16.identity.sourceId !== input.identity.sourceId || phase16.identity.sessionId !== input.identity.sessionId || phase16.identity.runId !== input.identity.runId) return reject('phase16_context_missing', 'Rejected: the current Phase 16 policy context does not match this source, session, and run. Re-establish the exact execution context and retry.', 'identity')
  const policyInputs = policyScopes(phase16, input.identity, paths, network)
  if (policyInputs.length === 0) return reject('phase16_context_missing', 'Rejected: no current Phase 16 policy evaluator context was supplied. Establish the governing policy before execution.', 'policy_input')
  const decisions: AutonomyPolicyEvaluation[] = []
  for (const policy of policyInputs) {
    const evaluation = evaluateAutonomyPolicy(policy)
    decisions.push(evaluation)
    if (evaluation.decision !== 'allowed') {
      const failure = phase16FailureMessage(evaluation)
      return reject(failure.code, failure.message, evaluation.reasonCode)
    }
  }
  if (phase16.plan) {
    if (!phase16.validationState) return reject('phase16_plan_invalid', 'Rejected: the approved capability plan has no current validation context. Revalidate the plan and retry.', 'validation_state_missing')
    const validation = validateCapabilityBeforeExecution({
      capabilityPlanId: phase16.plan.planId,
      contextSessionId: input.identity.sessionId,
      providerId: input.identity.providerId,
      capabilityId: input.identity.capabilityId,
      manifestDigest: phase16.plan.capabilityManifestDigest,
      requestedOperation: phase16.plan.requestedOperation,
      timestamp: (input.now || (() => new Date()))().toISOString()
    }, { ...phase16.validationState, plan: phase16.plan })
    if (!validation.allowed) return reject('phase16_plan_invalid', `Rejected: the approved capability plan is not currently executable (${validation.reasons[0] || 'validation_failed'}). Revalidate or approve the exact current plan.`, validation.reasons[0] || 'validation')
  }
  return { decisions }
}

function confirmationGuard(manifest: CapabilityManifest, phase16: CapabilityPhase16Context): CapabilityGuardRejection | undefined {
  if (manifest.confirmation.mode !== 'required') return undefined
  const inputs = phase16.policyInputs || (phase16.policyInput ? [phase16.policyInput] : [])
  const satisfied = inputs.some(input => {
    const confirmation = input.confirmation
    return record(confirmation) && (confirmation.state === 'confirmed' || confirmation.state === 'not_required' || confirmation.persistedDecision === 'APPROVED')
  })
  return satisfied ? undefined : reject('confirmation_required', `Rejected: ${manifest.confirmation.reason || 'this capability requires explicit confirmation.'} Confirm this exact source, session, run, and capability request, then retry.`, 'manifest_confirmation')
}

function writeGuard(input: CapabilityGuardInput, paths: readonly CapabilityPathBinding[], writes: readonly CapabilityPathBinding[]): CapabilityGuardRejection | undefined {
  const manifest = input.manifest
  const recordInput = record(input.arguments) ? input.arguments : undefined
  const explicitWrite = recordInput?.write === true || writes.length > 0
  if (!explicitWrite) return undefined
  if (manifest.writePolicy.mode === 'none') return reject('write_not_allowed', 'Rejected: this capability does not permit writes. Remove the write request and retry.', 'manifest_write=none')
  if (writes.length > manifest.writePolicy.maxFiles) return reject('write_not_allowed', 'Rejected: the requested write file count exceeds the capability manifest limit. Reduce the write paths and retry.', 'manifest_maxFiles')
  const allowedByPath = writes.every(item => manifest.writePolicy.allowedPaths.some(root => prefixOrEqual(root, item.relative)))
  if (!allowedByPath) return reject('write_not_allowed', 'Rejected: one or more write paths are outside the capability manifest’s declared write scope. Use a declared write path.', 'manifest_write_scope')
  const contentBytes = recordInput && typeof recordInput.content === 'string' ? Buffer.byteLength(recordInput.content, 'utf8') : 0
  if (contentBytes > manifest.writePolicy.maxBytes) return reject('write_not_allowed', 'Rejected: requested write content exceeds the capability manifest byte limit. Reduce the content and retry.', 'manifest_maxBytes')
  const hard = input.capability.hardWrite
  if (manifest.writePolicy.mode === 'artifact-only') {
    const artifactRoot = canonicalRoot(input.capability.artifactRoot)
    if (!artifactRoot) return reject('runtime_context_missing', 'Rejected: artifact-only execution has no broker-authorized output root.', 'artifact_root_missing')
    if (writes.some(item => !prefixOrEqual(artifactRoot, item.canonical))) return reject('write_not_allowed', 'Rejected: artifact-only execution may write only inside the broker-created output root.', 'artifact_root_scope')
  }
  if (hard && !hard.allowed) return reject('write_not_allowed', 'Rejected: the current Phase 16/hard write policy does not allow writes for this request.', 'hard_write_denied')
  if (hard?.maxFiles !== undefined && writes.length > hard.maxFiles) return reject('write_not_allowed', 'Rejected: the current hard write policy allows fewer files than this request. Reduce the write paths and retry.', 'hard_maxFiles')
  if (hard?.maxBytes !== undefined && contentBytes > hard.maxBytes) return reject('write_not_allowed', 'Rejected: the current hard write policy allows fewer write bytes than this request. Reduce the content and retry.', 'hard_maxBytes')
  if (hard?.allowedPaths && writes.some(item => !hard.allowedPaths!.some(root => prefixOrEqual(root, item.relative)))) return reject('write_not_allowed', 'Rejected: one or more write paths are outside the current hard write policy. Use an allowed source path.', 'hard_write_scope')
  return undefined
}

function networkGuard(input: CapabilityGuardInput, network: readonly CapabilityNetworkBinding[]): CapabilityGuardRejection | undefined {
  const manifest = input.manifest
  const recordInput = record(input.arguments) ? input.arguments : undefined
  const requested = network.length > 0 || recordInput?.networkAccess === true
  if (!requested) return undefined
  if (manifest.networkPolicy.mode === 'denied') return reject('network_not_allowed', 'Rejected: this capability does not permit network access. Remove the network request and retry.', 'manifest_network=denied')
  if (network.length > manifest.networkPolicy.maxRequests) return reject('network_not_allowed', 'Rejected: the requested network call count exceeds the capability manifest limit. Reduce the requests and retry.', 'manifest_maxRequests')
  for (const item of network) {
    if (!targetAllowed(item.target, manifest.networkPolicy.allowedTargets) || !manifest.networkPolicy.allowedMethods.includes(item.method)) return reject('network_not_allowed', 'Rejected: the requested network target or method is not declared by this capability. Use an explicit allowlisted target and method.', 'manifest_network_scope')
  }
  const hard = input.capability.hardNetwork
  if (hard && !hard.allowed) return reject('network_not_allowed', 'Rejected: the current Phase 16/hard network policy denies network access for this request.', 'hard_network_denied')
  if (hard?.maxRequests !== undefined && network.length > hard.maxRequests) return reject('network_not_allowed', 'Rejected: the current hard network policy allows fewer requests than this request. Reduce the requests and retry.', 'hard_maxRequests')
  for (const item of network) {
    if (hard?.allowedTargets && !targetAllowed(item.target, hard.allowedTargets)) return reject('network_not_allowed', 'Rejected: the requested network target is outside the current hard network allowlist.', 'hard_network_target')
    if (hard?.allowedMethods && !hard.allowedMethods.includes(item.method)) return reject('network_not_allowed', 'Rejected: the requested network method is outside the current hard network allowlist.', 'hard_network_method')
  }
  return undefined
}

export function authorizeCapabilityExecution(input: CapabilityGuardInput): CapabilityGuardResult {
  const manifestResult = input.manifest
  if (!manifestResult || typeof manifestResult !== 'object') return reject('manifest_invalid', 'Rejected: configured capability manifest is unavailable or invalid. Repair the configured manifest before retrying.', 'manifest')
  const identity = input.identity
  if (identity.capabilityId !== manifestResult.id || identity.capabilityVersion !== manifestResult.version || (input.capability.provider && input.capability.provider.providerId !== identity.providerId)) return reject('identity_mismatch', 'Rejected: capability, provider, or version identity does not match the configured manifest. Refresh the exact capability binding and retry.', 'identity')
  const inputFailure = inputRejection(manifestResult, input.arguments)
  if (inputFailure) return inputFailure
  const pathClaims = extractPathClaims(input.arguments, manifestResult)
  if (pathClaims.length > manifestResult.pathPolicy.maxPaths) return reject('path_not_allowed', 'Rejected: the requested path count exceeds the capability manifest limit. Reduce the paths and retry.', 'manifest_maxPaths')
  const paths: CapabilityPathBinding[] = []
  for (const requested of pathClaims) {
    const resolved = resolvePathClaim(requested, manifestResult, input.capability)
    if ('ok' in resolved && resolved.ok === false) return resolved
    paths.push(resolved as CapabilityPathBinding)
  }
  const writes: CapabilityPathBinding[] = []
  for (const requested of extractWriteClaims(input.arguments, manifestResult.writePolicy.mode, manifestResult)) {
    const existing = paths.find(item => item.requested === requested)
    const resolved = existing || resolvePathClaim(requested, manifestResult, input.capability)
    if ('ok' in resolved && resolved.ok === false) return resolved
    writes.push(resolved as CapabilityPathBinding)
  }
  const cwd = cwdFor(input.arguments, manifestResult, input.capability)
  if (typeof cwd !== 'string' && cwd !== undefined) return cwd
  const network = extractNetworkClaims(input.arguments)
  const writeFailure = writeGuard(input, paths, [...new Map(writes.map(item => [item.relative, item])).values()])
  if (writeFailure) return writeFailure
  const networkFailure = networkGuard(input, network)
  if (networkFailure) return networkFailure
  const policy = phase16Guard(input, paths, network)
  if ('ok' in policy) return policy
  if (!input.phase16) return reject('phase16_context_missing', 'Rejected: the current Phase 16 policy context is unavailable. Establish the governing policy before execution.', 'policy_context')
  const confirmationFailure = confirmationGuard(manifestResult, input.phase16)
  if (confirmationFailure) return confirmationFailure
  const requestedTimeout = input.requestedTimeoutMs
  if (requestedTimeout !== undefined && (!Number.isInteger(requestedTimeout) || requestedTimeout < 1 || requestedTimeout > manifestResult.timeout.maxMs)) return reject('timeout_not_allowed', `Rejected: requested timeout must be from 1 through ${manifestResult.timeout.maxMs} ms for this capability. Adjust timeoutMs and retry.`, 'manifest_timeout')
  const timeoutMs = requestedTimeout ?? manifestResult.timeout.defaultMs
  let normalized: unknown
  try { normalized = normalizedJson(input.arguments) } catch { return reject('input_invalid', 'Rejected: capability arguments must be finite JSON data without cycles. Correct the arguments and retry.', 'json') }
  return { ok: true, value: Object.freeze({
    input: normalized,
    sourceId: identity.sourceId,
    sessionId: identity.sessionId,
    runId: identity.runId,
    requestId: identity.requestId,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(manifestResult.pathPolicy.mode === 'artifact-relative' ? { artifactRoot: canonicalRoot(input.capability.artifactRoot) } : {}),
    paths: Object.freeze(paths),
    writePaths: Object.freeze([...new Map(writes.map(item => [item.relative, item])).values()]),
    networkRequests: Object.freeze(network),
    timeoutMs,
    policy: { decisions: Object.freeze(policy.decisions) },
    confirmation: manifestResult.confirmation,
    validation: manifestResult.validation,
    redaction: manifestResult.redaction,
    outputLimits: manifestResult.outputLimits
  }) }
}

function keyIsProtected(key: string, policy: CapabilityManifest['redaction']): boolean {
  return policy.fields.includes(key) || SECRET_KEY.test(key)
}

function redactText(value: string, policy: CapabilityManifest['redaction'], rawOutput = false): string {
  let result = value.replace(PRIVATE_KEY, '[REDACTED PRIVATE KEY]').replace(SECRET_VALUE, '[REDACTED]')
  result = result.replace(KEY_VALUE_SECRET, '$1[REDACTED]')
  if (rawOutput) result = '[REDACTED]'
  return result
}

function redactValue(value: unknown, policy: CapabilityManifest['redaction'], parentPath: string[] = [], seen = new Set<object>()): unknown {
  if (typeof value === 'string') return redactText(value, policy)
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[REDACTED CYCLIC VALUE]'
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map(item => redactValue(item, policy, parentPath, seen))
    const object = value as RecordValue
    const output: RecordValue = {}
    for (const key of Object.keys(object).sort()) {
      const nextPath = [...parentPath, key]
      const preserveReference = policy.preserveEvidenceReferences && /^(?:evidence|result)(?:Id|Ref)$/i.test(key)
      const rawField = policy.patterns.includes('raw-output') && /^(?:raw|content|body|text|payload|output)$/i.test(key)
      Object.defineProperty(output, key, { value: preserveReference ? object[key] : keyIsProtected(key, policy) ? '[REDACTED]' : rawField && typeof object[key] === 'string' ? redactText(object[key], policy, true) : redactValue(object[key], policy, nextPath, seen), enumerable: true, configurable: true, writable: true })
    }
    return output
  } finally { seen.delete(value) }
}

export function redactCapabilityText(value: string): string { return redactText(value, { mode: 'strict', fields: [], patterns: ['credentials', 'tokens', 'private-keys', 'authorization', 'environment'], preserveEvidenceReferences: true, inlineSecrets: 'never' }) }
export function redactCapabilityValue(value: unknown): unknown { return redactValue(value, { mode: 'strict', fields: [], patterns: ['credentials', 'tokens', 'private-keys', 'authorization', 'environment'], preserveEvidenceReferences: true, inlineSecrets: 'never' }) }

function boundedCapabilityEvidence(value: CapabilityJobEvidence | undefined, policy: CapabilityManifest['redaction']): CapabilityJobEvidence | undefined {
  if (!value || typeof value.content !== 'string' || value.redactionState !== 'redacted') return undefined
  const redacted = redactText(value.content, policy)
  const contentBytes = Buffer.byteLength(redacted, 'utf8')
  const bounded = contentBytes <= 32 * 1024 ? redacted : Buffer.from(redacted, 'utf8').subarray(0, 32 * 1024).toString('utf8')
  return {
    content: bounded,
    byteLength: Number.isInteger(value.byteLength) && value.byteLength >= 0 ? Math.min(value.byteLength, CAPABILITY_MANIFEST_MAX_OUTPUT_BYTES) : contentBytes,
    truncated: value.truncated || bounded !== redacted,
    redactionState: 'redacted'
  }
}

function outputItemCount(value: unknown): number {
  if (Array.isArray(value)) return value.length + value.reduce((total, item) => total + outputItemCount(item), 0)
  if (record(value)) { let total = 0; for (const item of Object.values(value)) total += outputItemCount(item); return total }
  return 0
}

function safeReference(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.startsWith('workbench://') && value.length <= 300 ? value : fallback
}

function failedResult(code: string, message: string, options: CapabilityOutputEnforcementOptions, outputBytes?: number, outputState: 'rejected' = 'rejected'): CapabilityJobHandlerResult {
  return { status: 'failed', resultRef: `workbench://capability-jobs/${options.job.jobId}/result`, evidenceRef: options.job.evidenceRef, outputBytes, outputState, failure: { code, message: redactCapabilityText(message).slice(0, MAX_ERROR_MESSAGE), retryable: false } }
}

export async function enforceCapabilityResult(manifest: CapabilityManifest, result: CapabilityJobHandlerResult, options: CapabilityOutputEnforcementOptions): Promise<CapabilityJobHandlerResult> {
  if (!['succeeded', 'failed', 'cancelled'].includes(result.status)) return failedResult('handler_invalid_result', 'Capability handler returned an unsupported terminal status.', options)
  const baseReference = `workbench://capability-jobs/${options.job.jobId}/result`
  if (result.status !== 'succeeded') {
    return {
      ...result,
      resultRef: baseReference,
      evidenceRef: options.job.evidenceRef,
      ...(result.failure ? { failure: { ...result.failure, message: redactCapabilityText(result.failure.message).slice(0, MAX_ERROR_MESSAGE), retryable: result.failure.retryable ?? false } } : {})
    }
  }
  const rawBytes = jsonBytes(result.output)
  if (rawBytes === undefined) return failedResult('output_invalid_json', 'Capability handler output is not bounded JSON data.', options)
  if (rawBytes > CAPABILITY_MANIFEST_MAX_OUTPUT_BYTES) return failedResult('output_limit_exceeded', `Capability output exceeded the hard ${CAPABILITY_MANIFEST_MAX_OUTPUT_BYTES}-byte result limit; the bounded result reference contains only failure metadata.`, options, rawBytes)
  const redacted = redactValue(result.output, manifest.redaction)
  const outputBytes = jsonBytes(redacted)
  if (outputBytes === undefined) return failedResult('output_invalid_json', 'Capability output could not be serialized after redaction.', options)
  const evidence = boundedCapabilityEvidence(result.evidence, manifest.redaction)
  const schemaIssues: SchemaIssue[] = []
  validateJsonValue(manifest.outputSchema, redacted, '$', schemaIssues, { nodes: 0 })
  if (schemaIssues[0]) return failedResult('output_schema_invalid', `Capability output does not satisfy the declared output schema at ${schemaIssues[0].path}; correct the handler result before retrying.`, options, outputBytes)
  const itemCount = outputItemCount(redacted)
  const overLimit = outputBytes > manifest.outputLimits.maxBytes || outputBytes > manifest.outputLimits.maxInlineBytes || itemCount > manifest.outputLimits.maxItems
  if (overLimit) {
    if (manifest.outputLimits.overflow === 'evidence-reference') {
      return { status: 'succeeded', resultRef: baseReference, evidenceRef: options.job.evidenceRef, outputBytes, outputState: 'evidence-reference', ...(evidence ? { evidence } : {}) }
    }
    const detail = manifest.outputLimits.overflow === 'truncate' ? 'truncation is not exposed as a complete result' : 'the manifest overflow mode is reject'
    return failedResult('output_limit_exceeded', `Capability output exceeded its declared result limits; ${detail}. Use the bounded result reference and reduce the result before retrying.`, options, outputBytes)
  }
  if (manifest.validation.mode === 'required') {
    const checks = manifest.validation.checks
    if (checks.includes('verifier') || checks.includes('file-integrity')) {
      for (const verifierId of manifest.validation.verifierIds) {
        const verifier = options.validationVerifiers?.[verifierId]
        if (!verifier) return failedResult('validation_unavailable', `Required capability validator '${verifierId}' is unavailable; execution cannot report success. Configure the validator and retry.`, options, outputBytes)
        let passed = false
        try { passed = await verifier({ output: redacted, request: options.request, authorized: options.authorized }) } catch { passed = false }
        if (!passed) return failedResult('validation_failed', `Required capability validator '${verifierId}' rejected the result; inspect the bounded evidence and correct the operation before retrying.`, options, outputBytes)
      }
    }
  }
  return {
    status: 'succeeded',
    output: redacted,
    outputBytes,
    outputState: 'inline',
    resultRef: baseReference,
    evidenceRef: options.job.evidenceRef,
    ...(evidence ? { evidence } : {})
  }
}
