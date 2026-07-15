import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  canonicalizeN8nWorkflow,
  hashCanonicalWorkflowTopology,
  stableSerializeCanonicalValue,
  validateControlledWorkflowTopologyManifest,
  parseControlledN8nWrapperContract,
  CONTROLLED_N8N_WRAPPER_CONTRACT_V1,
  type ControlledWorkflowMigrationEffect,
  type ControlledWorkflowMigrationEvent,
  type ControlledWorkflowMigrationOperation,
  type ControlledWorkflowReadbackResult
} from '@workbench/shared'
import {
  controlledN8nWorkflowGrantSchema,
  type ControlledN8nWorkflowGrant
} from './capability-grants'
import type { MutationDispatchKind } from './capability-mutation-dispatch-store'

export const N8N_WORKFLOW_MIGRATION_EXECUTOR_LIMITS = Object.freeze({
  maxWrapperBytes: 1_000_000,
  maxStdoutBytes: 500_000,
  maxStderrBytes: 60_000,
  maxIssues: 20,
  maxIssueMessageLength: 240,
  maxPublicReasonLength: 240,
  maxRawResponseBytes: 500_000,
  minimumTimeoutMs: 1_000,
  maximumTimeoutMs: 900_000,
  terminationGraceMs: 500
})

type ExecutableMigrationEffect = Extract<ControlledWorkflowMigrationEffect, {
  type: 'read_live_workflow' | 'apply_candidate' | 'apply_rollback' | 'readback_workflow'
}>

type FixedProcessSpecification = {
  executable: string
  executableSha256: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  stdin?: string
  shell: false
  timeoutMs: number
  stdoutLimitBytes: number
  stderrLimitBytes: number
  terminateProcessTree: true
  terminationGraceMs: number
  mayMutate: boolean
}

type FixedProcessResult = {
  outcome: 'succeeded' | 'definitively_failed' | 'ambiguous' | 'timed_out'
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

type ExecutorHost = {
  sourceRoot: string
  sourceId: string
  sourceRootFingerprint: string
  apiOriginFingerprint?: string
  executeFixedProcess: (specification: FixedProcessSpecification) => Promise<FixedProcessResult>
  readConfiguredCredentialValues?: () => string[]
  /** Host-owned bridge: it holds the single plaintext dispatch authorization. */
  consumeMutationDispatch?: (binding: {
    operationId: string; sourceId: string; workflowId: string; kind: MutationDispatchKind; artifactSha256: string; wrapperSha256: string
  }) => { ok: true } | { ok: false; code: string }
  nowMs?: () => number
}

export type N8nWorkflowMigrationExecutorClassification =
  | 'succeeded'
  | 'definitively_failed'
  | 'ambiguous'
  | 'timed_out'
  | 'blocked'

export type N8nWorkflowMigrationExecutorReasonCode =
  | 'READ_SUCCEEDED'
  | 'INVALID_INVOCATION'
  | 'CALLER_PROCESS_CONFIGURATION_REJECTED'
  | 'EFFECT_NOT_SUPPORTED'
  | 'EFFECT_NOT_LEGAL'
  | 'SOURCE_ID_MISMATCH'
  | 'SOURCE_ROOT_FINGERPRINT_MISMATCH'
  | 'GRANT_DISABLED'
  | 'GRANT_IDENTITY_MISMATCH'
  | 'WORKFLOW_BINDING_MISMATCH'
  | 'WRAPPER_BINDING_MISMATCH'
  | 'CANONICALIZATION_VERSION_MISMATCH'
  | 'CANDIDATE_BINDING_MISMATCH'
  | 'ROLLBACK_BINDING_MISMATCH'
  | 'MANIFEST_BINDING_MISMATCH'
  | 'API_ORIGIN_MISMATCH'
  | 'ARTIFACT_PATH_OUTSIDE_GRANT'
  | 'ARTIFACT_HASH_MISMATCH'
  | 'ARTIFACT_INVALID'
  | 'MANIFEST_INVALID'
  | 'MANIFEST_EXPANDS_GRANT'
  | 'WRAPPER_NOT_EXECUTABLE'
  | 'MUTATION_ALREADY_REQUESTED'
  | 'MUTATION_COMMAND_UNPROVEN'
  | 'MUTATION_DISPATCH_NOT_RESERVED'
  | 'MUTATION_DISPATCH_REPLAYED'
  | 'PROCESS_DEFINITIVE_FAILURE'
  | 'PROCESS_AMBIGUOUS'
  | 'PROCESS_TIMED_OUT'
  | 'PROCESS_OUTPUT_TRUNCATED'
  | 'MALFORMED_RESPONSE'
  | 'RESPONSE_WORKFLOW_ID_MISMATCH'
  | 'PROTECTED_DOMAIN_MISMATCH'
  | 'CREDENTIAL_MATERIAL_DETECTED'
  | 'CREDENTIAL_SOURCE_UNAVAILABLE'
  | 'CANONICALIZATION_FAILED'
  | 'INTERNAL_EXECUTOR_FAILURE'

export type N8nWorkflowMigrationExecutorIssue = {
  code: N8nWorkflowMigrationExecutorReasonCode
  field: string
  message: string
}

export type N8nWorkflowMigrationExecutorResult = {
  effect: ExecutableMigrationEffect['type'] | 'unknown'
  classification: N8nWorkflowMigrationExecutorClassification
  workflowId: string
  operationId: string
  durationMs: number
  exitCode?: number
  signal?: NodeJS.Signals
  stdoutBytes: number
  stderrBytes: number
  outputTruncated: boolean
  responseParsed: boolean
  observedCanonicalSha256?: string
  readbackResult?: ControlledWorkflowReadbackResult
  readPurpose?: 'precondition' | 'reconciliation'
  protectedDomains?: 'unchanged' | 'unverified'
  reasonCode: N8nWorkflowMigrationExecutorReasonCode
  reason: string
  issues: N8nWorkflowMigrationExecutorIssue[]
}

type ParsedInvocation = {
  effect: ExecutableMigrationEffect
  operation: ControlledWorkflowMigrationOperation
  grant: ControlledN8nWorkflowGrant
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const CREDENTIAL_ASSIGNMENT_PATTERN = /(?:^|[^A-Za-z0-9_])["']?(?:authorization|x[-_]n8n[-_]api[-_]key|n8n[-_]?api[-_]?key|api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|client[-_]?secret|password|secret|token)["']?\s*[:=]/i
const TERMINAL_SIGNALS = new Set<NodeJS.Signals>([
  'SIGABRT', 'SIGALRM', 'SIGBUS', 'SIGCHLD', 'SIGCONT', 'SIGFPE', 'SIGHUP', 'SIGILL',
  'SIGINT', 'SIGIO', 'SIGIOT', 'SIGKILL', 'SIGPIPE', 'SIGPOLL', 'SIGPROF', 'SIGPWR',
  'SIGQUIT', 'SIGSEGV', 'SIGSTKFLT', 'SIGSTOP', 'SIGSYS', 'SIGTERM', 'SIGTRAP',
  'SIGTSTP', 'SIGTTIN', 'SIGTTOU', 'SIGURG', 'SIGUSR1', 'SIGUSR2', 'SIGVTALRM',
  'SIGWINCH', 'SIGXCPU', 'SIGXFSZ'
])

const REASON_MESSAGES: Record<N8nWorkflowMigrationExecutorReasonCode, string> = {
  READ_SUCCEEDED: 'The approved workflow read completed and was canonicalized.',
  INVALID_INVOCATION: 'The executor invocation is malformed.',
  CALLER_PROCESS_CONFIGURATION_REJECTED: 'Caller-supplied process configuration is not accepted.',
  EFFECT_NOT_SUPPORTED: 'The requested migration effect is not supported by this executor.',
  EFFECT_NOT_LEGAL: 'The requested effect is not legal for the supplied operation state.',
  SOURCE_ID_MISMATCH: 'The host, operation, and grant source identities do not match.',
  SOURCE_ROOT_FINGERPRINT_MISMATCH: 'The host source-root fingerprint does not match the approved operation.',
  GRANT_DISABLED: 'The supplied capability grant is disabled.',
  GRANT_IDENTITY_MISMATCH: 'The supplied grant identity or version does not match the approved operation.',
  WORKFLOW_BINDING_MISMATCH: 'The effect, operation, and grant workflow identities do not match.',
  WRAPPER_BINDING_MISMATCH: 'The approved wrapper path or digest does not match the operation binding.',
  CANONICALIZATION_VERSION_MISMATCH: 'The canonicalization version does not match the approved operation.',
  CANDIDATE_BINDING_MISMATCH: 'The candidate artifact path, digest, or canonical digest does not match.',
  ROLLBACK_BINDING_MISMATCH: 'The rollback artifact path, digest, or canonical digest does not match.',
  MANIFEST_BINDING_MISMATCH: 'The manifest path or digest does not match the approved operation.',
  API_ORIGIN_MISMATCH: 'The API-origin fingerprint does not match the approved operation and grant.',
  ARTIFACT_PATH_OUTSIDE_GRANT: 'An approved artifact path is outside the grant maximum roots.',
  ARTIFACT_HASH_MISMATCH: 'A wrapper or artifact digest changed after approval.',
  ARTIFACT_INVALID: 'An approved artifact is missing, unsafe, oversized, or invalid.',
  MANIFEST_INVALID: 'The approved topology manifest is malformed or inconsistent with the operation.',
  MANIFEST_EXPANDS_GRANT: 'The repository manifest attempts to exceed the Workbench-owned grant.',
  WRAPPER_NOT_EXECUTABLE: 'The approved wrapper is not an executable regular file.',
  MUTATION_ALREADY_REQUESTED: 'The operation counter proves that this mutation is no longer eligible for dispatch.',
  MUTATION_COMMAND_UNPROVEN: 'Repository evidence does not define an approved fixed mutation command.',
  MUTATION_DISPATCH_NOT_RESERVED: 'No matching one-time mutation dispatch is available.',
  MUTATION_DISPATCH_REPLAYED: 'The mutation dispatch was already consumed or is invalid.',
  PROCESS_DEFINITIVE_FAILURE: 'The fixed wrapper process failed without an ambiguous mutation outcome.',
  PROCESS_AMBIGUOUS: 'The host cannot prove the fixed wrapper process outcome.',
  PROCESS_TIMED_OUT: 'The fixed wrapper process timed out and was terminated without retry.',
  PROCESS_OUTPUT_TRUNCATED: 'The fixed wrapper exceeded a bounded output limit.',
  MALFORMED_RESPONSE: 'The fixed wrapper returned malformed bounded JSON.',
  RESPONSE_WORKFLOW_ID_MISMATCH: 'The fixed wrapper returned a different workflow identity.',
  PROTECTED_DOMAIN_MISMATCH: 'A protected workflow domain differs from the approved unchanged snapshot.',
  CREDENTIAL_MATERIAL_DETECTED: 'The wrapper response contained credential-like or authorization material.',
  CREDENTIAL_SOURCE_UNAVAILABLE: 'Configured credential values could not be loaded for secret-safe validation.',
  CANONICALIZATION_FAILED: 'The bounded workflow response could not be canonicalized.',
  INTERNAL_EXECUTOR_FAILURE: 'The executor failed closed before returning approved evidence.'
}

const PROCESS_CONFIGURATION_FIELDS = new Set([
  'executable', 'args', 'argv', 'shell', 'env', 'environment', 'cwd', 'endpoint',
  'method', 'headers', 'credentials', 'credentialValues', 'wrapperOperation'
])

const EFFECT_KEYS: Record<ExecutableMigrationEffect['type'], Set<string>> = {
  read_live_workflow: new Set(['type', 'operationId', 'workflowId', 'purpose', 'expectedLiveCanonicalSha256']),
  apply_candidate: new Set(['type', 'operationId', 'workflowId', 'artifactPath', 'artifactSha256']),
  apply_rollback: new Set(['type', 'operationId', 'workflowId', 'artifactPath', 'artifactSha256', 'automatic']),
  readback_workflow: new Set(['type', 'operationId', 'workflowId', 'expected'])
}

class ExecutorValidationError extends Error {
  constructor(
    readonly reasonCode: N8nWorkflowMigrationExecutorReasonCode,
    readonly field: string
  ) {
    super(REASON_MESSAGES[reasonCode])
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isFixedProcessResult(value: unknown): value is FixedProcessResult {
  if (!isRecord(value)) return false
  return (value.outcome === 'succeeded'
      || value.outcome === 'definitively_failed'
      || value.outcome === 'ambiguous'
      || value.outcome === 'timed_out')
    && (value.exitCode === null || (typeof value.exitCode === 'number' && Number.isInteger(value.exitCode)))
    && (value.signal === null || typeof value.signal === 'string')
    && typeof value.stdout === 'string'
    && typeof value.stderr === 'string'
    && typeof value.stdoutTruncated === 'boolean'
    && typeof value.stderrTruncated === 'boolean'
}

function rejectNestedProcessConfiguration(
  value: unknown,
  prefix: string,
  depth = 0,
  seen = new WeakSet<object>()
): void {
  if (!value || typeof value !== 'object') return
  if (depth > 8 || seen.has(value)) return fail('INVALID_INVOCATION', `${prefix}.structure`)
  seen.add(value)
  if (Array.isArray(value)) {
    for (const entry of value) rejectNestedProcessConfiguration(entry, prefix, depth + 1, seen)
    return
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (PROCESS_CONFIGURATION_FIELDS.has(key)) {
      return fail('CALLER_PROCESS_CONFIGURATION_REJECTED', `${prefix}.${key}`)
    }
    rejectNestedProcessConfiguration(record[key], prefix, depth + 1, seen)
  }
}

function fail(reasonCode: N8nWorkflowMigrationExecutorReasonCode, field: string): never {
  throw new ExecutorValidationError(reasonCode, field)
}

function effectName(value: unknown): N8nWorkflowMigrationExecutorResult['effect'] {
  if (!isRecord(value)) return 'unknown'
  return value.type === 'read_live_workflow'
    || value.type === 'apply_candidate'
    || value.type === 'apply_rollback'
    || value.type === 'readback_workflow'
    ? value.type
    : 'unknown'
}

function invocationReadPurpose(value: unknown): 'precondition' | 'reconciliation' | undefined {
  if (!isRecord(value) || !isRecord(value.effect) || value.effect.type !== 'read_live_workflow') return undefined
  return value.effect.purpose === 'precondition' || value.effect.purpose === 'reconciliation'
    ? value.effect.purpose
    : undefined
}

function boundedReason(reasonCode: N8nWorkflowMigrationExecutorReasonCode): string {
  return REASON_MESSAGES[reasonCode].slice(0, N8N_WORKFLOW_MIGRATION_EXECUTOR_LIMITS.maxPublicReasonLength)
}

function boundedInteger(value: unknown, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(Math.trunc(value), maximum))
    : 0
}

function boundedIssue(
  reasonCode: N8nWorkflowMigrationExecutorReasonCode,
  field: string
): N8nWorkflowMigrationExecutorIssue {
  return {
    code: reasonCode,
    field: field.slice(0, 160),
    message: boundedReason(reasonCode).slice(0, N8N_WORKFLOW_MIGRATION_EXECUTOR_LIMITS.maxIssueMessageLength)
  }
}

function baseResult(params: {
  effect: N8nWorkflowMigrationExecutorResult['effect']
  classification: N8nWorkflowMigrationExecutorClassification
  operationId: string
  workflowId: string
  durationMs: number
  stdoutBytes?: number
  stderrBytes?: number
  outputTruncated?: boolean
  responseParsed?: boolean
  reasonCode: N8nWorkflowMigrationExecutorReasonCode
  field?: string
  exitCode?: number | null
  signal?: NodeJS.Signals | null
  observedCanonicalSha256?: string
  readbackResult?: ControlledWorkflowReadbackResult
  readPurpose?: 'precondition' | 'reconciliation'
  protectedDomains?: 'unchanged' | 'unverified'
}): N8nWorkflowMigrationExecutorResult {
  const exitCode = typeof params.exitCode === 'number'
    && Number.isInteger(params.exitCode)
    && params.exitCode >= 0
    && params.exitCode <= 255
    ? params.exitCode
    : undefined
  const signal = params.signal && TERMINAL_SIGNALS.has(params.signal) ? params.signal : undefined
  const protectedDomains = params.protectedDomains
    || ((params.effect === 'read_live_workflow' || params.effect === 'readback_workflow')
      && params.reasonCode !== 'READ_SUCCEEDED'
      ? 'unverified'
      : undefined)
  return {
    effect: params.effect,
    classification: params.classification,
    workflowId: params.workflowId,
    operationId: params.operationId,
    durationMs: boundedInteger(params.durationMs, N8N_WORKFLOW_MIGRATION_EXECUTOR_LIMITS.maximumTimeoutMs),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(signal === undefined ? {} : { signal }),
    stdoutBytes: boundedInteger(params.stdoutBytes, N8N_WORKFLOW_MIGRATION_EXECUTOR_LIMITS.maxStdoutBytes),
    stderrBytes: boundedInteger(params.stderrBytes, N8N_WORKFLOW_MIGRATION_EXECUTOR_LIMITS.maxStderrBytes),
    outputTruncated: params.outputTruncated === true,
    responseParsed: params.responseParsed === true,
    ...(params.observedCanonicalSha256 && SHA256_PATTERN.test(params.observedCanonicalSha256)
      ? { observedCanonicalSha256: params.observedCanonicalSha256 }
      : {}),
    ...(params.readbackResult ? { readbackResult: params.readbackResult } : {}),
    ...(params.readPurpose ? { readPurpose: params.readPurpose } : {}),
    ...(protectedDomains ? { protectedDomains } : {}),
    reasonCode: params.reasonCode,
    reason: boundedReason(params.reasonCode),
    issues: params.reasonCode === 'READ_SUCCEEDED'
      ? []
      : [boundedIssue(params.reasonCode, params.field || 'executor')]
        .slice(0, N8N_WORKFLOW_MIGRATION_EXECUTOR_LIMITS.maxIssues)
  }
}

function parseOperation(value: unknown): ControlledWorkflowMigrationOperation {
  if (!isRecord(value)
    || value.storeVersion !== 1
    || typeof value.operationId !== 'string'
    || !value.operationId.trim()
    || value.operationId.length > 200) {
    return fail('INVALID_INVOCATION', 'operation')
  }
  rejectNestedProcessConfiguration(value, 'operation')
  if (!isRecord(value.binding)) return fail('INVALID_INVOCATION', 'operation.binding')
  const binding = value.binding
  const requiredStrings = [
    'sourceId', 'sourceRootFingerprint', 'grantId', 'workflowId', 'mode',
    'candidatePath', 'candidateSha256', 'rollbackPath', 'rollbackSha256',
    'manifestPath', 'manifestSha256', 'wrapperPath', 'wrapperSha256',
    'candidateCanonicalSha256', 'rollbackCanonicalSha256', 'expectedLiveCanonicalSha256'
  ]
  if (requiredStrings.some(key => typeof binding[key] !== 'string')) {
    return fail('INVALID_INVOCATION', 'operation.binding')
  }
  if (typeof binding.grantVersion !== 'number' || binding.canonicalizationVersion !== 1) {
    return fail('INVALID_INVOCATION', 'operation.binding')
  }
  if (binding.mode !== 'apply' && binding.mode !== 'rollback') {
    return fail('INVALID_INVOCATION', 'operation.binding.mode')
  }
  if ((value.candidateUpdateRequests !== 0 && value.candidateUpdateRequests !== 1)
    || (value.rollbackUpdateRequests !== 0 && value.rollbackUpdateRequests !== 1)
    || typeof value.readbackRequests !== 'number') {
    return fail('INVALID_INVOCATION', 'operation.requestCounters')
  }
  try {
    return structuredClone(value) as ControlledWorkflowMigrationOperation
  } catch {
    return fail('INVALID_INVOCATION', 'operation.structure')
  }
}

function parseEffect(value: unknown): ExecutableMigrationEffect {
  if (!isRecord(value) || typeof value.type !== 'string') return fail('EFFECT_NOT_SUPPORTED', 'effect')
  if (!Object.prototype.hasOwnProperty.call(EFFECT_KEYS, value.type)) {
    return fail('EFFECT_NOT_SUPPORTED', 'effect.type')
  }
  const type = value.type as ExecutableMigrationEffect['type']
  const allowedKeys = EFFECT_KEYS[type]
  for (const key of Object.keys(value)) {
    if (allowedKeys.has(key)) continue
    const processConfiguration = PROCESS_CONFIGURATION_FIELDS.has(key)
    return fail(
      processConfiguration ? 'CALLER_PROCESS_CONFIGURATION_REJECTED' : 'INVALID_INVOCATION',
      processConfiguration ? `effect.${key}` : 'effect.unexpectedField'
    )
  }
  if (typeof value.operationId !== 'string' || typeof value.workflowId !== 'string') {
    return fail('INVALID_INVOCATION', 'effect.identity')
  }
  if (type === 'read_live_workflow') {
    if ((value.purpose !== 'precondition' && value.purpose !== 'reconciliation')
      || typeof value.expectedLiveCanonicalSha256 !== 'string') {
      return fail('INVALID_INVOCATION', 'effect.read_live_workflow')
    }
  }
  if (type === 'apply_candidate' || type === 'apply_rollback') {
    if (typeof value.artifactPath !== 'string' || typeof value.artifactSha256 !== 'string') {
      return fail('INVALID_INVOCATION', 'effect.artifact')
    }
  }
  if (type === 'apply_rollback' && typeof value.automatic !== 'boolean') {
    return fail('INVALID_INVOCATION', 'effect.automatic')
  }
  if (type === 'readback_workflow'
    && value.expected !== 'candidate'
    && value.expected !== 'rollback'
    && value.expected !== 'approved_state') {
    return fail('INVALID_INVOCATION', 'effect.expected')
  }
  return { ...value } as ExecutableMigrationEffect
}

function parseInvocation(value: unknown): ParsedInvocation {
  if (!isRecord(value)) return fail('INVALID_INVOCATION', 'invocation')
  for (const key of Object.keys(value)) {
    if (key === 'effect' || key === 'operation' || key === 'grant') continue
    const processConfiguration = PROCESS_CONFIGURATION_FIELDS.has(key)
    return fail(
      processConfiguration ? 'CALLER_PROCESS_CONFIGURATION_REJECTED' : 'INVALID_INVOCATION',
      processConfiguration ? `invocation.${key}` : 'invocation.unexpectedField'
    )
  }
  const parsedGrant = controlledN8nWorkflowGrantSchema.safeParse(value.grant)
  if (!parsedGrant.success) return fail('INVALID_INVOCATION', 'grant')
  return {
    effect: parseEffect(value.effect),
    operation: parseOperation(value.operation),
    grant: parsedGrant.data
  }
}

function normalizeRepositoryPath(value: string): string {
  if (path.isAbsolute(value) || value.includes('\0')) return fail('ARTIFACT_INVALID', 'path')
  const normalized = path.posix.normalize(value.replace(/\\/g, '/'))
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    return fail('ARTIFACT_INVALID', 'path')
  }
  return normalized
}

function isWithinAllowedRoot(relativePath: string, roots: string[]): boolean {
  const normalizedPath = normalizeRepositoryPath(relativePath)
  return roots.some(root => {
    const normalizedRoot = normalizeRepositoryPath(root).replace(/\/$/, '')
    return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`)
  })
}

function resolvePinnedFile(sourceRoot: string, relativePath: string, field: string): string {
  const normalized = normalizeRepositoryPath(relativePath)
  const absolute = path.resolve(sourceRoot, normalized)
  if (absolute !== sourceRoot && !absolute.startsWith(`${sourceRoot}${path.sep}`)) {
    return fail('ARTIFACT_INVALID', field)
  }
  if (!fs.existsSync(absolute)) return fail('ARTIFACT_INVALID', field)
  const stat = fs.lstatSync(absolute)
  if (!stat.isFile() || stat.isSymbolicLink()) return fail('ARTIFACT_INVALID', field)
  const real = fs.realpathSync(absolute)
  if (real !== absolute || (real !== sourceRoot && !real.startsWith(`${sourceRoot}${path.sep}`))) {
    return fail('ARTIFACT_INVALID', field)
  }
  return real
}

function readPinnedArtifact(filePath: string, maximumBytes: number, field: string): {
  raw: string
  sha256: string
} {
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
    )
    const stat = fs.fstatSync(descriptor)
    if (!stat.isFile() || stat.size > maximumBytes) return fail('ARTIFACT_INVALID', field)
    const bytes = fs.readFileSync(descriptor)
    if (bytes.byteLength > maximumBytes) return fail('ARTIFACT_INVALID', field)
    return {
      raw: bytes.toString('utf8'),
      sha256: createHash('sha256').update(bytes).digest('hex')
    }
  } catch (error) {
    if (error instanceof ExecutorValidationError) throw error
    return fail('ARTIFACT_INVALID', field)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function configuredCredentialValues(host: ExecutorHost): string[] {
  let values: unknown
  try {
    values = host.readConfiguredCredentialValues?.() || []
  } catch {
    return fail('CREDENTIAL_SOURCE_UNAVAILABLE', 'credentialSource')
  }
  if (!Array.isArray(values)) return fail('CREDENTIAL_SOURCE_UNAVAILABLE', 'credentialSource')
  return [...new Set(values.filter(value => typeof value === 'string' && value.length >= 4))].slice(0, 100)
}

function containsCredentialMaterial(raw: string, configuredValues: string[]): boolean {
  if (CREDENTIAL_ASSIGNMENT_PATTERN.test(raw)) return true
  if (/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/i.test(raw)) return true
  return configuredValues.some(value => raw.includes(value))
}

function parseWorkflowArtifact(raw: string, workflowId: string, field: string, configuredValues: string[]): {
  canonicalSha256: string
  protectedSnapshot: string
} {
  if (containsCredentialMaterial(raw, configuredValues)) return fail('CREDENTIAL_MATERIAL_DETECTED', field)
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return fail('ARTIFACT_INVALID', field)
  }
  if (!isRecord(value) || value.id !== workflowId) return fail('ARTIFACT_INVALID', field)
  const canonical = canonicalizeN8nWorkflow(value)
  if (!canonical.ok) return fail('ARTIFACT_INVALID', field)
  return {
    canonicalSha256: hashCanonicalWorkflowTopology(canonical.topology, sha256Text),
    protectedSnapshot: stableSerializeCanonicalValue(canonical.protected)
  }
}

function validateManifest(params: {
  raw: string
  operation: ControlledWorkflowMigrationOperation
  grant: ControlledN8nWorkflowGrant
}): void {
  let value: unknown
  try {
    value = JSON.parse(params.raw)
  } catch {
    return fail('MANIFEST_INVALID', 'manifest')
  }
  const parsed = validateControlledWorkflowTopologyManifest(value)
  if (!parsed.ok) return fail('MANIFEST_INVALID', 'manifest')
  const { manifest } = parsed
  const binding = params.operation.binding
  if (manifest.workflow.id !== binding.workflowId
    || manifest.workflow.canonicalizationVersion !== binding.canonicalizationVersion
    || manifest.workflow.expectedLiveCanonicalSha256 !== binding.expectedLiveCanonicalSha256
    || manifest.workflow.candidateCanonicalSha256 !== binding.candidateCanonicalSha256
    || manifest.workflow.rollbackCanonicalSha256 !== binding.rollbackCanonicalSha256
    || manifest.artifacts.candidatePath !== binding.candidatePath
    || manifest.artifacts.candidateSha256 !== binding.candidateSha256
    || manifest.artifacts.rollbackPath !== binding.rollbackPath
    || manifest.artifacts.rollbackSha256 !== binding.rollbackSha256) {
    return fail('MANIFEST_BINDING_MISMATCH', 'manifest')
  }
  const allowedNodeTypes = params.grant.maximumPolicy.allowedNodeTypes
  if (allowedNodeTypes) {
    const allowed = new Set(allowedNodeTypes)
    if (manifest.nodes.add.some(node => !allowed.has(node.type))) {
      return fail('MANIFEST_EXPANDS_GRANT', 'manifest.nodes.add')
    }
  }
}

function validateBinding(params: {
  invocation: ParsedInvocation
  host: ExecutorHost
  configuredCredentialValues: string[]
}): {
  sourceRoot: string
  wrapperPath: string
  timeoutMs: number
  protectedSnapshot: string
} {
  const { effect, operation, grant } = params.invocation
  const { binding } = operation
  const host = params.host
  if (!grant.enabled) return fail('GRANT_DISABLED', 'grant.enabled')
  if (host.sourceId !== binding.sourceId || grant.sourceId !== binding.sourceId) {
    return fail('SOURCE_ID_MISMATCH', 'sourceId')
  }
  if (!SHA256_PATTERN.test(host.sourceRootFingerprint)
    || host.sourceRootFingerprint !== binding.sourceRootFingerprint) {
    return fail('SOURCE_ROOT_FINGERPRINT_MISMATCH', 'sourceRootFingerprint')
  }
  if (grant.grantId !== binding.grantId || grant.version !== binding.grantVersion) {
    return fail('GRANT_IDENTITY_MISMATCH', 'grant')
  }
  if (effect.operationId !== operation.operationId
    || effect.workflowId !== binding.workflowId
    || grant.workflowId !== binding.workflowId) {
    return fail('WORKFLOW_BINDING_MISMATCH', 'workflowId')
  }
  if (grant.wrapperPath !== binding.wrapperPath || grant.wrapperSha256 !== binding.wrapperSha256) {
    return fail('WRAPPER_BINDING_MISMATCH', 'wrapper')
  }
  if (grant.canonicalizationVersion !== binding.canonicalizationVersion || binding.canonicalizationVersion !== 1) {
    return fail('CANONICALIZATION_VERSION_MISMATCH', 'canonicalizationVersion')
  }
  if (grant.apiOriginFingerprint !== binding.apiOriginFingerprint
    || host.apiOriginFingerprint !== binding.apiOriginFingerprint) {
    return fail('API_ORIGIN_MISMATCH', 'apiOriginFingerprint')
  }

  const sourceRoot = fs.realpathSync(path.resolve(host.sourceRoot))
  const artifacts: Array<{
    path: string
    sha256: string
    roots: string[]
    field: 'candidate' | 'rollback' | 'manifest'
  }> = [
    { path: binding.candidatePath, sha256: binding.candidateSha256, roots: grant.allowedCandidateRoots, field: 'candidate' },
    { path: binding.rollbackPath, sha256: binding.rollbackSha256, roots: grant.allowedRollbackRoots, field: 'rollback' },
    { path: binding.manifestPath, sha256: binding.manifestSha256, roots: grant.allowedManifestRoots, field: 'manifest' }
  ]
  const artifactContents = new Map<string, string>()
  for (const artifact of artifacts) {
    if (!isWithinAllowedRoot(artifact.path, artifact.roots)) {
      return fail('ARTIFACT_PATH_OUTSIDE_GRANT', `${artifact.field}Path`)
    }
    const resolved = resolvePinnedFile(sourceRoot, artifact.path, `${artifact.field}Path`)
    const content = readPinnedArtifact(resolved, grant.maxArtifactBytes, `${artifact.field}Path`)
    if (content.sha256 !== artifact.sha256) return fail('ARTIFACT_HASH_MISMATCH', `${artifact.field}Sha256`)
    artifactContents.set(artifact.field, content.raw)
  }

  const candidateRaw = artifactContents.get('candidate')!
  const rollbackRaw = artifactContents.get('rollback')!
  const manifestRaw = artifactContents.get('manifest')!
  const candidate = parseWorkflowArtifact(
    candidateRaw,
    binding.workflowId,
    'candidatePath',
    params.configuredCredentialValues
  )
  const rollback = parseWorkflowArtifact(
    rollbackRaw,
    binding.workflowId,
    'rollbackPath',
    params.configuredCredentialValues
  )
  if (candidate.canonicalSha256 !== binding.candidateCanonicalSha256) {
    return fail('CANDIDATE_BINDING_MISMATCH', 'candidateCanonicalSha256')
  }
  if (rollback.canonicalSha256 !== binding.rollbackCanonicalSha256) {
    return fail('ROLLBACK_BINDING_MISMATCH', 'rollbackCanonicalSha256')
  }
  if (candidate.protectedSnapshot !== rollback.protectedSnapshot) {
    return fail('PROTECTED_DOMAIN_MISMATCH', 'approvedArtifacts.protectedDomains')
  }
  validateManifest({ raw: manifestRaw, operation, grant })

  if (effect.type === 'read_live_workflow') {
    if (effect.expectedLiveCanonicalSha256 !== binding.expectedLiveCanonicalSha256) {
      return fail('WORKFLOW_BINDING_MISMATCH', 'effect.expectedLiveCanonicalSha256')
    }
    if (effect.purpose === 'precondition'
      && (operation.status !== 'running'
        || operation.candidateUpdateRequests !== 0
        || operation.rollbackUpdateRequests !== 0)) {
      return fail('EFFECT_NOT_LEGAL', 'effect.purpose')
    }
    if (effect.purpose === 'reconciliation' && operation.status !== 'reconciling') {
      return fail('EFFECT_NOT_LEGAL', 'effect.purpose')
    }
  } else if (effect.type === 'readback_workflow') {
    const recoveredSuccessfulRollback = operation.status === 'reconciling'
      && effect.expected === 'rollback'
      && operation.rollbackUpdateRequests === 1
      && operation.evidence?.rollbackResult === 'succeeded'
    const legalExpected = operation.status === 'rolling_back'
      ? effect.expected === 'rollback'
      : operation.status === 'reconciling'
        && (recoveredSuccessfulRollback
          || (operation.binding.mode === 'rollback'
            ? effect.expected === 'approved_state'
            : effect.expected !== 'rollback'))
    if (!legalExpected) {
      return fail('EFFECT_NOT_LEGAL', 'effect.type')
    }
  } else if (effect.type === 'apply_candidate') {
    if (operation.binding.mode !== 'apply'
      || operation.status !== 'running'
      || effect.artifactPath !== binding.candidatePath
      || effect.artifactSha256 !== binding.candidateSha256) {
      return fail('EFFECT_NOT_LEGAL', 'effect.apply_candidate')
    }
  } else if (effect.type === 'apply_rollback') {
    const standalone = operation.binding.mode === 'rollback'
      && operation.status === 'running'
      && effect.automatic === false
    const automatic = operation.binding.mode === 'apply'
      && operation.status === 'rolling_back'
      && effect.automatic === true
    if ((!standalone && !automatic)
      || effect.artifactPath !== binding.rollbackPath
      || effect.artifactSha256 !== binding.rollbackSha256) {
      return fail('EFFECT_NOT_LEGAL', 'effect.apply_rollback')
    }
  }

  // Keep the pathname/type/digest check immediately adjacent to runner dispatch.
  const wrapperPath = resolvePinnedFile(sourceRoot, binding.wrapperPath, 'wrapperPath')
  if ((fs.statSync(wrapperPath).mode & 0o111) === 0) return fail('WRAPPER_NOT_EXECUTABLE', 'wrapperPath')
  const wrapperSha256 = readPinnedArtifact(
    wrapperPath,
    N8N_WORKFLOW_MIGRATION_EXECUTOR_LIMITS.maxWrapperBytes,
    'wrapperPath'
  ).sha256
  if (wrapperSha256 !== binding.wrapperSha256) return fail('ARTIFACT_HASH_MISMATCH', 'wrapperSha256')

  return {
    sourceRoot,
    wrapperPath,
    timeoutMs: Math.min(
      N8N_WORKFLOW_MIGRATION_EXECUTOR_LIMITS.maximumTimeoutMs,
      Math.max(N8N_WORKFLOW_MIGRATION_EXECUTOR_LIMITS.minimumTimeoutMs, grant.operationTimeoutMs)
    ),
    protectedSnapshot: candidate.protectedSnapshot
  }
}

function minimalN8nEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || '',
    CI: '1',
    NO_COLOR: '1'
  }
  for (const key of ['N8N_CONFIG_FILE', 'N8N_API_URL', 'N8N_API_KEY'] as const) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return env
}

function readPurpose(effect: ExecutableMigrationEffect): 'precondition' | 'reconciliation' | undefined {
  return effect.type === 'read_live_workflow' ? effect.purpose : undefined
}

function observedReadbackResult(
  effect: Extract<ExecutableMigrationEffect, { type: 'read_live_workflow' | 'readback_workflow' }>,
  operation: ControlledWorkflowMigrationOperation,
  observedCanonicalSha256: string
): ControlledWorkflowReadbackResult {
  const binding = operation.binding
  const preMutationFirst = effect.type === 'read_live_workflow' && effect.purpose === 'precondition'
  const rollbackFirst = (effect.type === 'readback_workflow' && effect.expected === 'rollback')
    || (binding.mode === 'rollback'
      && ((effect.type === 'readback_workflow' && effect.expected === 'approved_state')
        || (effect.type === 'read_live_workflow' && effect.purpose === 'reconciliation')))
  const ordered: Array<[string, ControlledWorkflowReadbackResult]> = preMutationFirst
    ? [
        [binding.expectedLiveCanonicalSha256, 'matches_pre_mutation'],
        [binding.candidateCanonicalSha256, 'matches_candidate'],
        [binding.rollbackCanonicalSha256, 'matches_rollback']
      ]
    : rollbackFirst
      ? [
          [binding.rollbackCanonicalSha256, 'matches_rollback'],
          [binding.candidateCanonicalSha256, 'matches_candidate'],
          [binding.expectedLiveCanonicalSha256, 'matches_pre_mutation']
        ]
      : [
          [binding.candidateCanonicalSha256, 'matches_candidate'],
          [binding.rollbackCanonicalSha256, 'matches_rollback'],
          [binding.expectedLiveCanonicalSha256, 'matches_pre_mutation']
        ]
  return ordered.find(([sha256]) => sha256 === observedCanonicalSha256)?.[1] || 'unexpected_state'
}

function processFailureResult(params: {
  invocation: ParsedInvocation
  process: FixedProcessResult
  startedAt: number
  nowMs: () => number
}): N8nWorkflowMigrationExecutorResult {
  const { effect, operation } = params.invocation
  const stdoutBytes = Buffer.byteLength(params.process.stdout, 'utf8')
  const stderrBytes = Buffer.byteLength(params.process.stderr, 'utf8')
  const outputTruncated = params.process.stdoutTruncated || params.process.stderrTruncated
  const reasonCode: N8nWorkflowMigrationExecutorReasonCode = params.process.outcome === 'timed_out'
    ? 'PROCESS_TIMED_OUT'
    : outputTruncated
      ? 'PROCESS_OUTPUT_TRUNCATED'
      : params.process.outcome === 'ambiguous'
        ? 'PROCESS_AMBIGUOUS'
        : 'PROCESS_DEFINITIVE_FAILURE'
  const classification: N8nWorkflowMigrationExecutorClassification = params.process.outcome === 'timed_out'
    ? 'timed_out'
    : params.process.outcome === 'ambiguous'
      ? 'ambiguous'
      : 'definitively_failed'
  return baseResult({
    effect: effect.type,
    classification,
    operationId: operation.operationId,
    workflowId: operation.binding.workflowId,
    durationMs: params.nowMs() - params.startedAt,
    stdoutBytes,
    stderrBytes,
    outputTruncated,
    responseParsed: false,
    reasonCode,
    exitCode: params.process.exitCode,
    signal: params.process.signal,
    readPurpose: readPurpose(effect)
  })
}

function blockedMutation(invocation: ParsedInvocation, reasonCode: 'MUTATION_DISPATCH_NOT_RESERVED' | 'MUTATION_DISPATCH_REPLAYED') {
  return baseResult({ effect: invocation.effect.type, classification: 'blocked', operationId: invocation.operation.operationId, workflowId: invocation.operation.binding.workflowId, durationMs: 0, reasonCode, field: invocation.effect.type })
}

async function executeMutation(params: { invocation: ParsedInvocation; validated: ReturnType<typeof validateBinding>; host: ExecutorHost; nowMs: () => number }): Promise<N8nWorkflowMigrationExecutorResult> {
  const { invocation, validated, host, nowMs } = params
  const effect = invocation.effect
  if (effect.type !== 'apply_candidate' && effect.type !== 'apply_rollback') return blockedMutation(invocation, 'MUTATION_DISPATCH_NOT_RESERVED')
  if (!parseControlledN8nWrapperContract(CONTROLLED_N8N_WRAPPER_CONTRACT_V1).ok) return blockedMutation(invocation, 'MUTATION_DISPATCH_NOT_RESERVED')
  const kind: MutationDispatchKind = effect.type === 'apply_candidate' ? 'candidate' : 'rollback'
  const consume = host.consumeMutationDispatch
  if (!consume) return blockedMutation(invocation, 'MUTATION_DISPATCH_NOT_RESERVED')
  const consumed = consume({ operationId: invocation.operation.operationId, sourceId: invocation.operation.binding.sourceId, workflowId: invocation.operation.binding.workflowId, kind, artifactSha256: effect.artifactSha256, wrapperSha256: invocation.operation.binding.wrapperSha256 })
  if (!consumed.ok) return blockedMutation(invocation, (consumed as { ok: false; code: string }).code.includes('REPLAY') ? 'MUTATION_DISPATCH_REPLAYED' : 'MUTATION_DISPATCH_NOT_RESERVED')
  const artifactPath = resolvePinnedFile(validated.sourceRoot, effect.artifactPath, 'effect.artifactPath')
  const payload = readPinnedArtifact(artifactPath, Math.min(invocation.grant.maxArtifactBytes, CONTROLLED_N8N_WRAPPER_CONTRACT_V1.limits.maximumPayloadBytes), 'effect.artifactPath')
  if (payload.sha256 !== effect.artifactSha256) return baseResult({ effect: effect.type, classification: 'blocked', operationId: invocation.operation.operationId, workflowId: invocation.operation.binding.workflowId, durationMs: 0, reasonCode: 'ARTIFACT_HASH_MISMATCH' })
  const startedAt = nowMs()
  let process: FixedProcessResult
  try {
    process = await host.executeFixedProcess({ executable: validated.wrapperPath, executableSha256: invocation.operation.binding.wrapperSha256, args: ['update-workflow', invocation.operation.binding.workflowId, '-'], cwd: validated.sourceRoot, env: minimalN8nEnvironment(), stdin: payload.raw, shell: false, timeoutMs: Math.min(validated.timeoutMs, CONTROLLED_N8N_WRAPPER_CONTRACT_V1.limits.maximumTotalTimeoutSeconds * 1000), stdoutLimitBytes: CONTROLLED_N8N_WRAPPER_CONTRACT_V1.limits.maximumResponseBytes, stderrLimitBytes: N8N_WORKFLOW_MIGRATION_EXECUTOR_LIMITS.maxStderrBytes, terminateProcessTree: true, terminationGraceMs: N8N_WORKFLOW_MIGRATION_EXECUTOR_LIMITS.terminationGraceMs, mayMutate: true })
  } catch { return baseResult({ effect: effect.type, classification: 'ambiguous', operationId: invocation.operation.operationId, workflowId: invocation.operation.binding.workflowId, durationMs: nowMs() - startedAt, reasonCode: 'PROCESS_AMBIGUOUS' }) }
  if (!isFixedProcessResult(process) || process.outcome !== 'succeeded' || process.exitCode !== 0 || process.stdoutTruncated || process.stderrTruncated) return processFailureResult({ invocation, process: isFixedProcessResult(process) ? process : { outcome: 'ambiguous', exitCode: null, signal: null, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false }, startedAt, nowMs })
  let wrapperResult: unknown
  try { wrapperResult = JSON.parse(process.stdout) } catch { return baseResult({ effect: effect.type, classification: 'ambiguous', operationId: invocation.operation.operationId, workflowId: invocation.operation.binding.workflowId, durationMs: nowMs() - startedAt, reasonCode: 'MALFORMED_RESPONSE' }) }
  if (!isRecord(wrapperResult) || wrapperResult.workflowId !== invocation.operation.binding.workflowId || typeof wrapperResult.classification !== 'string') return baseResult({ effect: effect.type, classification: 'ambiguous', operationId: invocation.operation.operationId, workflowId: invocation.operation.binding.workflowId, durationMs: nowMs() - startedAt, reasonCode: 'RESPONSE_WORKFLOW_ID_MISMATCH' })
  const classification = wrapperResult.classification
  if (classification !== 'succeeded' && classification !== 'definitively_failed' && classification !== 'ambiguous' && classification !== 'timed_out') return baseResult({ effect: effect.type, classification: 'ambiguous', operationId: invocation.operation.operationId, workflowId: invocation.operation.binding.workflowId, durationMs: nowMs() - startedAt, reasonCode: 'MALFORMED_RESPONSE' })
  return baseResult({ effect: effect.type, classification, operationId: invocation.operation.operationId, workflowId: invocation.operation.binding.workflowId, durationMs: nowMs() - startedAt, stdoutBytes: Buffer.byteLength(process.stdout), stderrBytes: Buffer.byteLength(process.stderr), responseParsed: true, reasonCode: classification === 'succeeded' ? 'READ_SUCCEEDED' : classification === 'timed_out' ? 'PROCESS_TIMED_OUT' : classification === 'ambiguous' ? 'PROCESS_AMBIGUOUS' : 'PROCESS_DEFINITIVE_FAILURE', exitCode: process.exitCode, signal: process.signal })
}

export function createN8nWorkflowMigrationExecutor(host: ExecutorHost) {
  const nowMs = host.nowMs || Date.now
  return async (value: unknown): Promise<N8nWorkflowMigrationExecutorResult> => {
    const effect = isRecord(value) ? effectName(value.effect) : 'unknown'
    const requestedReadPurpose = invocationReadPurpose(value)
    let invocation: ParsedInvocation
    let validated: ReturnType<typeof validateBinding>
    let credentialValues: string[]
    try {
      invocation = parseInvocation(value)
      credentialValues = configuredCredentialValues(host)
      validated = validateBinding({ invocation, host, configuredCredentialValues: credentialValues })
    } catch (error) {
      const reasonCode = error instanceof ExecutorValidationError
        ? error.reasonCode
        : 'INTERNAL_EXECUTOR_FAILURE'
      const field = error instanceof ExecutorValidationError ? error.field : 'executor'
      return baseResult({
        effect,
        classification: 'blocked',
        operationId: 'unknown',
        workflowId: 'unknown',
        durationMs: 0,
        reasonCode,
        field,
        readPurpose: requestedReadPurpose
      })
    }

    if (invocation.effect.type === 'apply_candidate' || invocation.effect.type === 'apply_rollback') return executeMutation({ invocation, validated, host, nowMs })

    const startedAt = nowMs()
    let processResult: FixedProcessResult
    try {
      processResult = await host.executeFixedProcess({
        executable: validated.wrapperPath,
        executableSha256: invocation.operation.binding.wrapperSha256,
        args: ['get-workflow', invocation.operation.binding.workflowId],
        cwd: validated.sourceRoot,
        env: minimalN8nEnvironment(),
        shell: false,
        timeoutMs: validated.timeoutMs,
        stdoutLimitBytes: Math.min(
          N8N_WORKFLOW_MIGRATION_EXECUTOR_LIMITS.maxStdoutBytes,
          invocation.grant.maxArtifactBytes
        ),
        stderrLimitBytes: N8N_WORKFLOW_MIGRATION_EXECUTOR_LIMITS.maxStderrBytes,
        terminateProcessTree: true,
        terminationGraceMs: N8N_WORKFLOW_MIGRATION_EXECUTOR_LIMITS.terminationGraceMs,
        mayMutate: false
      })
    } catch {
      return baseResult({
        effect: invocation.effect.type,
        classification: 'definitively_failed',
        operationId: invocation.operation.operationId,
        workflowId: invocation.operation.binding.workflowId,
        durationMs: nowMs() - startedAt,
        reasonCode: 'PROCESS_DEFINITIVE_FAILURE',
        readPurpose: readPurpose(invocation.effect)
      })
    }

    if (!isFixedProcessResult(processResult)) {
      return baseResult({
        effect: invocation.effect.type,
        classification: 'definitively_failed',
        operationId: invocation.operation.operationId,
        workflowId: invocation.operation.binding.workflowId,
        durationMs: nowMs() - startedAt,
        reasonCode: 'INTERNAL_EXECUTOR_FAILURE',
        readPurpose: readPurpose(invocation.effect)
      })
    }
    const stdoutBytes = Buffer.byteLength(processResult.stdout, 'utf8')
    const stderrBytes = Buffer.byteLength(processResult.stderr, 'utf8')
    const stdoutLimitBytes = Math.min(
      N8N_WORKFLOW_MIGRATION_EXECUTOR_LIMITS.maxStdoutBytes,
      invocation.grant.maxArtifactBytes
    )
    if (stdoutBytes > stdoutLimitBytes || stderrBytes > N8N_WORKFLOW_MIGRATION_EXECUTOR_LIMITS.maxStderrBytes) {
      processResult = {
        ...processResult,
        stdoutTruncated: processResult.stdoutTruncated || stdoutBytes > stdoutLimitBytes,
        stderrTruncated: processResult.stderrTruncated
          || stderrBytes > N8N_WORKFLOW_MIGRATION_EXECUTOR_LIMITS.maxStderrBytes
      }
    }
    if (processResult.outcome !== 'succeeded'
      || processResult.stdoutTruncated
      || processResult.stderrTruncated
      || processResult.exitCode !== 0) {
      return processFailureResult({ invocation, process: processResult, startedAt, nowMs })
    }
    if (stdoutBytes > N8N_WORKFLOW_MIGRATION_EXECUTOR_LIMITS.maxRawResponseBytes) {
      return baseResult({
        effect: invocation.effect.type,
        classification: 'definitively_failed',
        operationId: invocation.operation.operationId,
        workflowId: invocation.operation.binding.workflowId,
        durationMs: nowMs() - startedAt,
        stdoutBytes,
        stderrBytes,
        outputTruncated: true,
        responseParsed: false,
        reasonCode: 'PROCESS_OUTPUT_TRUNCATED',
        exitCode: processResult.exitCode,
        signal: processResult.signal,
        readPurpose: readPurpose(invocation.effect)
      })
    }
    if (containsCredentialMaterial(`${processResult.stdout}\n${processResult.stderr}`, credentialValues)) {
      return baseResult({
        effect: invocation.effect.type,
        classification: 'definitively_failed',
        operationId: invocation.operation.operationId,
        workflowId: invocation.operation.binding.workflowId,
        durationMs: nowMs() - startedAt,
        stdoutBytes,
        stderrBytes,
        responseParsed: false,
        reasonCode: 'CREDENTIAL_MATERIAL_DETECTED',
        exitCode: processResult.exitCode,
        signal: processResult.signal,
        readPurpose: readPurpose(invocation.effect)
      })
    }

    let workflow: unknown
    try {
      workflow = JSON.parse(processResult.stdout)
    } catch {
      return baseResult({
        effect: invocation.effect.type,
        classification: 'definitively_failed',
        operationId: invocation.operation.operationId,
        workflowId: invocation.operation.binding.workflowId,
        durationMs: nowMs() - startedAt,
        stdoutBytes,
        stderrBytes,
        responseParsed: false,
        reasonCode: 'MALFORMED_RESPONSE',
        exitCode: processResult.exitCode,
        signal: processResult.signal,
        readPurpose: readPurpose(invocation.effect)
      })
    }
    if (!isRecord(workflow) || workflow.id !== invocation.operation.binding.workflowId) {
      return baseResult({
        effect: invocation.effect.type,
        classification: 'definitively_failed',
        operationId: invocation.operation.operationId,
        workflowId: invocation.operation.binding.workflowId,
        durationMs: nowMs() - startedAt,
        stdoutBytes,
        stderrBytes,
        responseParsed: true,
        reasonCode: 'RESPONSE_WORKFLOW_ID_MISMATCH',
        exitCode: processResult.exitCode,
        signal: processResult.signal,
        readPurpose: readPurpose(invocation.effect)
      })
    }
    const canonical = canonicalizeN8nWorkflow(workflow)
    if (!canonical.ok) {
      return baseResult({
        effect: invocation.effect.type,
        classification: 'definitively_failed',
        operationId: invocation.operation.operationId,
        workflowId: invocation.operation.binding.workflowId,
        durationMs: nowMs() - startedAt,
        stdoutBytes,
        stderrBytes,
        responseParsed: true,
        reasonCode: 'CANONICALIZATION_FAILED',
        exitCode: processResult.exitCode,
        signal: processResult.signal,
        readPurpose: readPurpose(invocation.effect)
      })
    }
    if (stableSerializeCanonicalValue(canonical.protected) !== validated.protectedSnapshot) {
      return baseResult({
        effect: invocation.effect.type,
        classification: 'definitively_failed',
        operationId: invocation.operation.operationId,
        workflowId: invocation.operation.binding.workflowId,
        durationMs: nowMs() - startedAt,
        stdoutBytes,
        stderrBytes,
        responseParsed: true,
        reasonCode: 'PROTECTED_DOMAIN_MISMATCH',
        exitCode: processResult.exitCode,
        signal: processResult.signal,
        readPurpose: readPurpose(invocation.effect)
      })
    }
    const observedCanonicalSha256 = hashCanonicalWorkflowTopology(canonical.topology, sha256Text)
    const readbackResult = observedReadbackResult(invocation.effect, invocation.operation, observedCanonicalSha256)
    return baseResult({
      effect: invocation.effect.type,
      classification: 'succeeded',
      operationId: invocation.operation.operationId,
      workflowId: invocation.operation.binding.workflowId,
      durationMs: nowMs() - startedAt,
      stdoutBytes,
      stderrBytes,
      responseParsed: true,
      observedCanonicalSha256,
      readbackResult,
      protectedDomains: 'unchanged',
      reasonCode: 'READ_SUCCEEDED',
      exitCode: processResult.exitCode,
      signal: processResult.signal,
      readPurpose: readPurpose(invocation.effect)
    })
  }
}

function defaultConfiguredCredentialValues(): string[] {
  const values = new Set<string>()
  if (typeof process.env.N8N_API_KEY === 'string' && process.env.N8N_API_KEY.length >= 4) {
    values.add(process.env.N8N_API_KEY)
  }
  const home = process.env.HOME || ''
  const configPath = process.env.N8N_CONFIG_FILE || (home ? path.join(home, '.config/n8n/.env') : '')
  if (configPath) {
    try {
      if (!fs.existsSync(configPath)) return [...values]
      const stat = fs.statSync(configPath)
      if (!stat.isFile()) return [...values]
      if (stat.size > 1_000_000) throw new Error('credential source exceeds bounded size')
      for (const line of fs.readFileSync(configPath, 'utf8').split(/\r?\n/)) {
        const match = line.match(/^\s*(?:export\s+)?N8N_API_KEY\s*=\s*(.*)\s*$/)
        if (!match) continue
        const raw = match[1].trim()
        const quoted = raw.match(/^(['"])(.*?)\1(?:\s+#.*)?$/)
        const value = (quoted ? quoted[2] : raw.replace(/\s+#.*$/, '')).trim()
        if (value.length >= 4) values.add(value)
      }
    } catch {
      throw new Error('configured credential source is unavailable')
    }
  }
  return [...values]
}

function executeFixedNodeProcess(specification: FixedProcessSpecification): Promise<FixedProcessResult> {
  return new Promise(resolve => {
    try {
      const stat = fs.lstatSync(specification.executable)
      const real = fs.realpathSync(specification.executable)
      if (!stat.isFile()
        || stat.isSymbolicLink()
        || real !== specification.executable
        || (stat.mode & 0o111) === 0
        || readPinnedArtifact(
          real,
          N8N_WORKFLOW_MIGRATION_EXECUTOR_LIMITS.maxWrapperBytes,
          'wrapperPath'
        ).sha256 !== specification.executableSha256) {
        resolve({
          outcome: 'definitively_failed',
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false
        })
        return
      }
    } catch {
      resolve({
        outcome: 'definitively_failed',
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false
      })
      return
    }
    const child = spawn(specification.executable, specification.args, {
      cwd: specification.cwd,
      env: specification.env,
      shell: false,
      stdio: [specification.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      detached: specification.terminateProcessTree && process.platform !== 'win32'
    })
    let spawned = false
    let processErrored = false
    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    let stdoutTruncated = false
    let stderrTruncated = false
    let timedOut = false
    let outputTerminated = false
    let terminationStarted = false
    let settled = false
    let killTimer: NodeJS.Timeout | undefined

    const signalProcessTree = (signal: NodeJS.Signals) => {
      if (child.pid && specification.terminateProcessTree && process.platform !== 'win32') {
        try {
          process.kill(-child.pid, signal)
          return
        } catch {
          // Direct-child signaling is the bounded fallback.
        }
      }
      child.kill(signal)
    }
    const beginTermination = () => {
      if (terminationStarted) return
      terminationStarted = true
      signalProcessTree('SIGTERM')
      killTimer = setTimeout(
        () => signalProcessTree('SIGKILL'),
        specification.terminationGraceMs
      )
    }
    const timer = setTimeout(() => {
      timedOut = true
      beginTermination()
    }, specification.timeoutMs)
    const finish = (result: FixedProcessResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      resolve(result)
    }
    const append = (
      current: string,
      chunk: Buffer,
      limit: number,
      currentBytes: number
    ): { value: string; bytes: number; truncated: boolean } => {
      const remaining = Math.max(0, limit - currentBytes)
      const accepted = chunk.subarray(0, remaining)
      return {
        value: current + accepted.toString('utf8'),
        bytes: currentBytes + accepted.byteLength,
        truncated: accepted.byteLength < chunk.byteLength
      }
    }
    const terminateForOutput = () => {
      if (outputTerminated || (!stdoutTruncated && !stderrTruncated)) return
      outputTerminated = true
      beginTermination()
    }

    child.on('spawn', () => { spawned = true })
    if (specification.stdin !== undefined) child.stdin?.end(specification.stdin)
    child.stdout.on('data', chunk => {
      const next = append(stdout, Buffer.from(chunk), specification.stdoutLimitBytes, stdoutBytes)
      stdout = next.value
      stdoutBytes = next.bytes
      stdoutTruncated ||= next.truncated
      terminateForOutput()
    })
    child.stderr.on('data', chunk => {
      const next = append(stderr, Buffer.from(chunk), specification.stderrLimitBytes, stderrBytes)
      stderr = next.value
      stderrBytes = next.bytes
      stderrTruncated ||= next.truncated
      terminateForOutput()
    })
    child.on('error', () => {
      processErrored = true
      if (spawned) {
        beginTermination()
        return
      }
      finish({
        outcome: 'definitively_failed',
        exitCode: null,
        signal: null,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated
      })
    })
    child.on('close', (exitCode, signal) => {
      const truncated = stdoutTruncated || stderrTruncated
      let outcome: FixedProcessResult['outcome']
      if (timedOut) outcome = 'timed_out'
      else if (processErrored) outcome = spawned && specification.mayMutate ? 'ambiguous' : 'definitively_failed'
      else if (truncated) outcome = specification.mayMutate ? 'ambiguous' : 'definitively_failed'
      else if (exitCode === 0) outcome = 'succeeded'
      else outcome = exitCode === null && specification.mayMutate ? 'ambiguous' : 'definitively_failed'
      finish({ outcome, exitCode, signal, stdout, stderr, stdoutTruncated, stderrTruncated })
    })
  })
}

export function createNodeN8nWorkflowMigrationExecutor(host: Omit<
  ExecutorHost,
  'executeFixedProcess' | 'readConfiguredCredentialValues'
>) {
  return createN8nWorkflowMigrationExecutor({
    ...host,
    executeFixedProcess: executeFixedNodeProcess,
    readConfiguredCredentialValues: defaultConfiguredCredentialValues
  })
}

export function toControlledWorkflowMigrationEvent(
  result: N8nWorkflowMigrationExecutorResult,
  at: string
): ControlledWorkflowMigrationEvent {
  if (result.effect === 'apply_candidate') {
    const mutationResult = result.classification === 'succeeded'
      ? 'succeeded'
      : result.classification === 'ambiguous'
        ? 'ambiguous'
        : result.classification === 'timed_out'
          ? 'timed_out'
          : result.classification === 'blocked'
            ? 'not_started'
            : 'definitively_failed'
    return { type: 'mutation_result', result: mutationResult, at }
  }
  if (result.effect === 'apply_rollback') {
    const rollbackResult = result.classification === 'succeeded'
      ? 'succeeded'
      : result.classification === 'ambiguous'
        ? 'ambiguous'
        : result.classification === 'timed_out'
          ? 'timed_out'
          : result.classification === 'blocked'
            ? 'not_attempted'
            : 'definitively_failed'
    return { type: 'rollback_result', result: rollbackResult, at }
  }
  const readbackResult = result.classification === 'succeeded' && result.readbackResult
    ? result.readbackResult
    : 'unavailable'
  if (result.effect === 'read_live_workflow' && result.readPurpose === 'precondition') {
    return {
      type: 'precondition_readback',
      result: readbackResult,
      ...(result.protectedDomains ? { protectedDomains: result.protectedDomains } : {}),
      ...(result.observedCanonicalSha256 ? { observedCanonicalSha256: result.observedCanonicalSha256 } : {}),
      at
    }
  }
  return {
    type: 'readback_result',
    result: readbackResult,
    ...(result.protectedDomains ? { protectedDomains: result.protectedDomains } : {}),
    ...(result.observedCanonicalSha256 ? { observedCanonicalSha256: result.observedCanonicalSha256 } : {}),
    at
  }
}
