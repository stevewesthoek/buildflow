import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  canonicalizeAutonomyValue,
  evaluateConnectedRepositoryPath,
  type AutonomyDecisionRequest
} from '@workbench/shared'
import { prepareAutonomyDecisionAuthorization } from './autonomy-decision-authorization'
import {
  ensurePendingApprovalIntent,
  type WorkbenchApprovalIntentRecord,
  type WorkbenchApprovalIntentStoreOptions
} from './workbench-approval-intents'
import type { AutonomyDecisionStoreOptions } from './autonomy-decision-store'

export const CODEX_REVIEW_CONTRACT_SCHEMA_VERSION = 1 as const
export const CODEX_REVIEW_CONTRACT_VERSION = 'r20.1' as const
export const CODEX_REVIEW_ADAPTER_ID = 'codex-cli' as const
export const CODEX_REVIEW_CAPABILITY_ID = 'codex-read-only-review' as const
export const CODEX_REVIEW_APPROVAL_OPERATION = 'read_workbench_context' as const

const MAX_SCOPE_PATHS = 32
const MAX_SCOPE_PATH_LENGTH = 500
const MAX_REFERENCE_COUNT = 8
const MAX_REFERENCE_LENGTH = 256
const MAX_OBJECTIVE_LENGTH = 500
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/
const SAFE_HEAD = /^[a-f0-9]{7,64}$/i
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/
const OBJECTIVE_CATEGORIES = ['architecture', 'bug', 'security', 'performance', 'quality', 'general'] as const
const CODEX_REVIEW_FINDING_FIELDS = Object.freeze(['findingId', 'severity', 'category', 'location', 'evidenceId', 'explanation', 'confidence', 'status']) as unknown as readonly ['findingId', 'severity', 'category', 'location', 'evidenceId', 'explanation', 'confidence', 'status']

export type CodexReviewObjectiveCategory = typeof OBJECTIVE_CATEGORIES[number]

export type CodexReviewObjective = Readonly<{
  category: CodexReviewObjectiveCategory
  summary: string
}>

export type CodexReviewContextReference = Readonly<{
  kind: 'evidence' | 'context'
  evidenceId: string
  reference: string
}>

export type CodexReviewAdapterIdentity = Readonly<{
  adapterId: typeof CODEX_REVIEW_ADAPTER_ID
  capabilityId: typeof CODEX_REVIEW_CAPABILITY_ID
  version: typeof CODEX_REVIEW_CONTRACT_VERSION
}>

export type CodexReviewRequest = Readonly<{
  schemaVersion: typeof CODEX_REVIEW_CONTRACT_SCHEMA_VERSION
  contractVersion: typeof CODEX_REVIEW_CONTRACT_VERSION
  reviewId: string
  authorityDigest: string
  source: Readonly<{
    sourceId: string
    revision: string
    head: string
  }>
  run: Readonly<{
    runId: string
    sessionId: string
  }>
  scope: Readonly<{
    paths: readonly string[]
    pathPolicyIdentity: string
  }>
  objective: CodexReviewObjective
  adapter: CodexReviewAdapterIdentity
  policy: Readonly<{
    identity: string
    autonomyLevel: number
    actorId: string
  }>
  contextReferences?: readonly CodexReviewContextReference[]
  budgetIdentity?: string
}>

export type CodexReviewRequestInput = Readonly<{
  sourceId: string
  sourceRevision: string
  sourceHead: string
  runId: string
  sessionId: string
  scope: Readonly<{
    paths: readonly string[]
    pathPolicyIdentity: string
  }>
  objective: CodexReviewObjective
  adapter?: Partial<CodexReviewAdapterIdentity>
  policy: Readonly<{
    identity: string
    autonomyLevel: number
    actorId: string
  }>
  contextReferences?: readonly CodexReviewContextReference[]
  budgetIdentity?: string
}>

/**
 * A roadmap packet may request review, but it cannot describe any review
 * capability beyond this fixed read-only adapter identity. Source/run/HEAD
 * and policy identity are supplied by the deterministic compiler later.
 */
export type CodexReviewDeclaration = Readonly<{
  required: true
  paths: readonly string[]
  objective: CodexReviewObjective
  adapter?: Partial<CodexReviewAdapterIdentity>
  contextReferences?: readonly CodexReviewContextReference[]
  budgetIdentity?: string
}>

export type CodexReviewFindingBoundary = Readonly<{
  schemaVersion: 1
  status: 'not_started'
  fields: readonly ['findingId', 'severity', 'category', 'location', 'evidenceId', 'explanation', 'confidence', 'status']
}>

export const CODEX_REVIEW_FINDING_BOUNDARY: CodexReviewFindingBoundary = Object.freeze({
  schemaVersion: 1,
  status: 'not_started',
  fields: CODEX_REVIEW_FINDING_FIELDS
})

/**
 * This is deliberately the complete R20.1 capability intersection. It is
 * data, not a prompt instruction, and contains no write-capable member.
 */
export type CodexReviewNoMutationAuthority = Readonly<{
  sourceRead: true
  write: false
  gitMutation: false
  commandExecution: false
  network: false
  credentials: false
  packageInstallation: false
  deployment: false
  externalServiceMutation: false
}>

export const CODEX_REVIEW_NO_MUTATION_AUTHORITY: CodexReviewNoMutationAuthority = Object.freeze({
  sourceRead: true,
  write: false,
  gitMutation: false,
  commandExecution: false,
  network: false,
  credentials: false,
  packageInstallation: false,
  deployment: false,
  externalServiceMutation: false
})

export type CodexReviewApprovalDecision = 'ALLOW' | 'DENY' | 'REQUIRES_CONFIRMATION'
export type CodexReviewStopCondition = 'approval_required' | 'review_admission_denied' | 'structured_findings_required'

export type CodexReviewRequirement = Readonly<{
  required: true
  taskId: string
  packetId: string
  request: CodexReviewRequest
  approvalDecision: CodexReviewApprovalDecision
  stopCondition: CodexReviewStopCondition
  findingBoundary: CodexReviewFindingBoundary
}>

export type CodexReviewRequestFailureCode =
  | 'INVALID_REQUEST'
  | 'UNSUPPORTED_FIELD'
  | 'UNSUPPORTED_ADAPTER'
  | 'INVALID_SCOPE'
  | 'PROTECTED_PATH'

export type CodexReviewRequestResult =
  | Readonly<{ ok: true; request: CodexReviewRequest }>
  | Readonly<{ ok: false; code: CodexReviewRequestFailureCode; message: string }>

export type CodexReviewAdmissionSource = Readonly<{
  sourceId: string
  sourceRoot: string
  enabled: boolean
  revision: string
  head: string
}>

export type CodexReviewAdmissionRun = Readonly<{
  runId: string
  sessionId: string
  sourceId: string
  status: 'active'
}>

export type CodexReviewAdmissionSession = Readonly<{
  sessionId: string
  status: 'active'
  lockedSourceIds: readonly string[]
}>

export type CodexReviewPhase16Authority = Readonly<{
  policyIdentity: string
  autonomyLevel: number
  actorId: string
  allowedPaths: readonly string[]
}>

export type CodexReviewAdmissionInput = Readonly<{
  request: CodexReviewRequest
  source: CodexReviewAdmissionSource
  run: CodexReviewAdmissionRun
  session: CodexReviewAdmissionSession
  phase16: CodexReviewPhase16Authority
  storeOptions?: AutonomyDecisionStoreOptions
}>

export type CodexReviewApprovalProjection = Readonly<{
  operation: typeof CODEX_REVIEW_APPROVAL_OPERATION
  requestFingerprint: string
  reused: boolean
  pendingApprovalId?: string
}>

export type CodexReviewAdmissionResult = Readonly<{
  ok: true
  decision: CodexReviewApprovalDecision
  request: CodexReviewRequest
  approvalRequest?: AutonomyDecisionRequest
  approval?: CodexReviewApprovalProjection
  authority: CodexReviewNoMutationAuthority
  stopCondition: CodexReviewStopCondition
  findingBoundary: CodexReviewFindingBoundary
  reasonCode: string
  message: string
}>

export type CodexReviewAdmissionFailure = Readonly<{
  ok: false
  decision: 'DENY'
  code: string
  message: string
  authority: CodexReviewNoMutationAuthority
  stopCondition: 'review_admission_denied'
}>

export type CodexReviewAdmissionOutcome = CodexReviewAdmissionResult | CodexReviewAdmissionFailure

type RecordValue = Record<string, unknown>

function record(value: unknown): value is RecordValue {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function onlyKeys(value: RecordValue, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every(key => allowed.has(key))
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\0\r\n]/.test(value)) return undefined
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized || undefined
}

function safeIdentity(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_ID.test(value) ? value : undefined
}

function normalizeReviewPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SCOPE_PATH_LENGTH) throw new Error('Review scope path is invalid.')
  const raw = value.replace(/\\/g, '/').trim()
  if (!raw || raw.startsWith('/') || raw.startsWith('~') || /^[A-Za-z]:\//.test(raw) || raw.includes('\0')) throw new Error('Review scope paths must be repository-relative.')
  const parts = raw.split('/').filter(part => part.length > 0 && part !== '.')
  if (parts.length === 0 || parts.includes('..')) throw new Error('Review scope paths must not contain traversal or repository-root scope.')
  const protection = evaluateConnectedRepositoryPath(raw)
  if (protection) throw new Error(protection.message)
  return parts.join('/')
}

function normalizeReviewPaths(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SCOPE_PATHS) throw new Error(`${label} must contain 1-${MAX_SCOPE_PATHS} exact paths.`)
  const paths = value.map(normalizeReviewPath)
  return [...new Set(paths)].sort((left, right) => left.localeCompare(right))
}

function normalizeAllowedPaths(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SCOPE_PATHS) throw new Error(`${label} must contain 1-${MAX_SCOPE_PATHS} bounded paths.`)
  const paths = value.map(item => item === '.' ? '.' : normalizeReviewPath(item))
  return [...new Set(paths)].sort((left, right) => left.localeCompare(right))
}

function normalizeObjective(value: unknown): CodexReviewObjective {
  if (!record(value) || !onlyKeys(value, ['category', 'summary']) || !OBJECTIVE_CATEGORIES.includes(value.category as CodexReviewObjectiveCategory)) throw new Error('Review objective category is invalid.')
  const summary = boundedText(value.summary, MAX_OBJECTIVE_LENGTH)
  if (!summary) throw new Error('Review objective summary is invalid.')
  return { category: value.category as CodexReviewObjectiveCategory, summary }
}

function normalizeAdapter(value: unknown): CodexReviewAdapterIdentity {
  if (value !== undefined && (!record(value) || !onlyKeys(value, ['adapterId', 'capabilityId', 'version']))) throw new Error('Review adapter identity contains an unsupported field.')
  const adapter = value as Partial<CodexReviewAdapterIdentity> | undefined
  if (adapter?.adapterId !== undefined && adapter.adapterId !== CODEX_REVIEW_ADAPTER_ID) throw new Error('Only the native codex-cli review adapter is supported.')
  if (adapter?.capabilityId !== undefined && adapter.capabilityId !== CODEX_REVIEW_CAPABILITY_ID) throw new Error('Only the fixed read-only Codex review capability is supported.')
  if (adapter?.version !== undefined && adapter.version !== CODEX_REVIEW_CONTRACT_VERSION) throw new Error('The Codex review contract version is unsupported.')
  return { adapterId: CODEX_REVIEW_ADAPTER_ID, capabilityId: CODEX_REVIEW_CAPABILITY_ID, version: CODEX_REVIEW_CONTRACT_VERSION }
}

function normalizeReferences(value: unknown): CodexReviewContextReference[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > MAX_REFERENCE_COUNT) throw new Error(`Review context references must contain at most ${MAX_REFERENCE_COUNT} entries.`)
  const references = value.map((item, index) => {
    if (!record(item) || !onlyKeys(item, ['kind', 'evidenceId', 'reference']) || !['evidence', 'context'].includes(String(item.kind))) throw new Error(`Review context reference ${index} is invalid.`)
    const evidenceId = safeIdentity(item.evidenceId)
    const reference = typeof item.reference === 'string' && SAFE_REFERENCE.test(item.reference) ? item.reference : undefined
    if (!evidenceId || !reference) throw new Error(`Review context reference ${index} is invalid.`)
    return { kind: item.kind as 'evidence' | 'context', evidenceId, reference }
  })
  const unique = [...new Map(references.map(item => [`${item.kind}:${item.evidenceId}:${item.reference}`, item])).values()]
  return unique.sort((left, right) => `${left.kind}:${left.evidenceId}:${left.reference}`.localeCompare(`${right.kind}:${right.evidenceId}:${right.reference}`))
}

function canonicalDigest(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalizeAutonomyValue(value), 'utf8').digest('hex')
}

function authorityPayload(request: Omit<CodexReviewRequest, 'reviewId' | 'authorityDigest'>): Omit<CodexReviewRequest, 'reviewId' | 'authorityDigest'> {
  return request
}

function requestFromNormalized(input: {
  sourceId: string
  sourceRevision: string
  sourceHead: string
  runId: string
  sessionId: string
  paths: string[]
  pathPolicyIdentity: string
  objective: CodexReviewObjective
  adapter: CodexReviewAdapterIdentity
  policy: { identity: string; autonomyLevel: number; actorId: string }
  contextReferences?: CodexReviewContextReference[]
  budgetIdentity?: string
}): CodexReviewRequest {
  const payload: Omit<CodexReviewRequest, 'reviewId' | 'authorityDigest'> = {
    schemaVersion: CODEX_REVIEW_CONTRACT_SCHEMA_VERSION,
    contractVersion: CODEX_REVIEW_CONTRACT_VERSION,
    source: { sourceId: input.sourceId, revision: input.sourceRevision, head: input.sourceHead.toLowerCase() },
    run: { runId: input.runId, sessionId: input.sessionId },
    scope: { paths: input.paths, pathPolicyIdentity: input.pathPolicyIdentity },
    objective: input.objective,
    adapter: input.adapter,
    policy: input.policy,
    ...(input.contextReferences && input.contextReferences.length > 0 ? { contextReferences: input.contextReferences } : {}),
    ...(input.budgetIdentity ? { budgetIdentity: input.budgetIdentity } : {})
  }
  const authorityDigest = canonicalDigest(authorityPayload(payload))
  return {
    ...payload,
    reviewId: `codex-review-${authorityDigest.slice(0, 32)}`,
    authorityDigest
  }
}

export function createCodexReadOnlyReviewRequest(input: CodexReviewRequestInput): CodexReviewRequestResult {
  try {
    const value = input as unknown as RecordValue
    if (!record(value) || !onlyKeys(value, ['sourceId', 'sourceRevision', 'sourceHead', 'runId', 'sessionId', 'scope', 'objective', 'adapter', 'policy', 'contextReferences', 'budgetIdentity'])) return { ok: false, code: 'UNSUPPORTED_FIELD', message: 'Codex review request contains an unsupported authority field.' }
    const sourceId = safeIdentity(value.sourceId)
    const sourceRevision = boundedText(value.sourceRevision, 200)
    const sourceHead = typeof value.sourceHead === 'string' && SAFE_HEAD.test(value.sourceHead) ? value.sourceHead : undefined
    const runId = safeIdentity(value.runId)
    const sessionId = safeIdentity(value.sessionId)
    if (!sourceId || !sourceRevision || !sourceHead || !runId || !sessionId) return { ok: false, code: 'INVALID_REQUEST', message: 'Codex review source, revision, HEAD, run, and session identities are invalid.' }
    if (!record(value.scope) || !onlyKeys(value.scope, ['paths', 'pathPolicyIdentity'])) return { ok: false, code: 'INVALID_SCOPE', message: 'Codex review scope must contain only exact paths and a path-policy identity.' }
    const paths = normalizeReviewPaths(value.scope.paths, 'Codex review scope')
    const pathPolicyIdentity = safeIdentity(value.scope.pathPolicyIdentity)
    if (!pathPolicyIdentity) return { ok: false, code: 'INVALID_SCOPE', message: 'Codex review path-policy identity is invalid.' }
    const objective = normalizeObjective(value.objective)
    const adapter = normalizeAdapter(value.adapter)
    if (!record(value.policy) || !onlyKeys(value.policy, ['identity', 'autonomyLevel', 'actorId'])) return { ok: false, code: 'INVALID_REQUEST', message: 'Codex review policy identity is invalid.' }
    const policyIdentity = safeIdentity(value.policy.identity)
    const actorId = safeIdentity(value.policy.actorId)
    if (!policyIdentity || !actorId || !Number.isInteger(value.policy.autonomyLevel) || Number(value.policy.autonomyLevel) < 0 || Number(value.policy.autonomyLevel) > 6) return { ok: false, code: 'INVALID_REQUEST', message: 'Codex review policy identity or autonomy level is invalid.' }
    const contextReferences = normalizeReferences(value.contextReferences)
    const budgetIdentity = value.budgetIdentity === undefined ? undefined : safeIdentity(value.budgetIdentity)
    if (value.budgetIdentity !== undefined && !budgetIdentity) return { ok: false, code: 'INVALID_REQUEST', message: 'Codex review budget identity is invalid.' }
    return {
      ok: true,
      request: requestFromNormalized({
        sourceId,
        sourceRevision,
        sourceHead,
        runId,
        sessionId,
        paths,
        pathPolicyIdentity,
        objective,
        adapter,
        policy: { identity: policyIdentity, autonomyLevel: Number(value.policy.autonomyLevel), actorId },
        contextReferences,
        budgetIdentity
      })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Codex review request is invalid.'
    const code: CodexReviewRequestFailureCode = /protected|secret|credential|private key|Git internals/i.test(message) ? 'PROTECTED_PATH' : /scope|path/i.test(message) ? 'INVALID_SCOPE' : /adapter/i.test(message) ? 'UNSUPPORTED_ADAPTER' : 'INVALID_REQUEST'
    return { ok: false, code, message }
  }
}

export function normalizeCodexReviewDeclaration(value: unknown, taskPaths: readonly string[]): CodexReviewDeclaration {
  if (!record(value) || !onlyKeys(value, ['required', 'paths', 'objective', 'adapter', 'contextReferences', 'budgetIdentity']) || value.required !== true) throw new Error('A Codex review declaration must be explicitly required and contain no authority fields.')
  const allowed = new Set(taskPaths)
  const paths = normalizeReviewPaths(value.paths, 'Codex review declaration')
  if (paths.some(item => !allowed.has(item))) throw new Error('Codex review declaration paths must be exact task paths.')
  const objective = normalizeObjective(value.objective)
  const adapter = normalizeAdapter(value.adapter)
  const contextReferences = normalizeReferences(value.contextReferences)
  const budgetIdentity = value.budgetIdentity === undefined ? undefined : safeIdentity(value.budgetIdentity)
  if (value.budgetIdentity !== undefined && !budgetIdentity) throw new Error('Codex review budget identity is invalid.')
  return {
    required: true,
    paths,
    objective,
    ...(adapter ? { adapter } : {}),
    ...(contextReferences && contextReferences.length > 0 ? { contextReferences } : {}),
    ...(budgetIdentity ? { budgetIdentity } : {})
  }
}

export function compileCodexReviewRequirement(input: {
  taskId: string
  packetId: string
  sourceId: string
  sourceRevision: string
  sourceHead: string
  runId: string
  sessionId: string
  declaration: CodexReviewDeclaration
  policy: { identity: string; autonomyLevel: number; actorId: string }
}): CodexReviewRequirement {
  const result = createCodexReadOnlyReviewRequest({
    sourceId: input.sourceId,
    sourceRevision: input.sourceRevision,
    sourceHead: input.sourceHead,
    runId: input.runId,
    sessionId: input.sessionId,
    scope: { paths: input.declaration.paths, pathPolicyIdentity: input.policy.identity },
    objective: input.declaration.objective,
    ...(input.declaration.adapter ? { adapter: input.declaration.adapter } : {}),
    policy: input.policy,
    ...(input.declaration.contextReferences ? { contextReferences: input.declaration.contextReferences } : {}),
    ...(input.declaration.budgetIdentity ? { budgetIdentity: input.declaration.budgetIdentity } : {})
  })
  if (result.ok === false) throw new Error(result.message)
  if (!safeIdentity(input.taskId) || !safeIdentity(input.packetId)) throw new Error('Codex review task and packet identities are invalid.')
  return {
    required: true,
    taskId: input.taskId,
    packetId: input.packetId,
    request: result.request,
    approvalDecision: 'REQUIRES_CONFIRMATION',
    stopCondition: 'approval_required',
    findingBoundary: CODEX_REVIEW_FINDING_BOUNDARY
  }
}

export function validateCodexReviewRequirement(value: unknown): value is CodexReviewRequirement {
  if (!record(value) || !onlyKeys(value, ['required', 'taskId', 'packetId', 'request', 'approvalDecision', 'stopCondition', 'findingBoundary']) || value.required !== true || !safeIdentity(value.taskId) || !safeIdentity(value.packetId)) return false
  if (!['ALLOW', 'DENY', 'REQUIRES_CONFIRMATION'].includes(String(value.approvalDecision)) || !['approval_required', 'review_admission_denied', 'structured_findings_required'].includes(String(value.stopCondition))) return false
  const boundary = value.findingBoundary as RecordValue
  if (!record(boundary) || !onlyKeys(boundary, ['schemaVersion', 'status', 'fields']) || boundary.schemaVersion !== 1 || boundary.status !== 'not_started' || JSON.stringify(boundary.fields) !== JSON.stringify(CODEX_REVIEW_FINDING_BOUNDARY.fields)) return false
  const request = value.request as RecordValue
  if (!record(request) || !onlyKeys(request, ['schemaVersion', 'contractVersion', 'reviewId', 'authorityDigest', 'source', 'run', 'scope', 'objective', 'adapter', 'policy', 'contextReferences', 'budgetIdentity']) || request.schemaVersion !== CODEX_REVIEW_CONTRACT_SCHEMA_VERSION) return false
  const source = request.source
  const run = request.run
  const scope = request.scope
  const policy = request.policy
  if (!record(source) || !record(run) || !record(scope) || !record(policy)) return false
  if (!onlyKeys(source, ['sourceId', 'revision', 'head']) || !onlyKeys(run, ['runId', 'sessionId']) || !onlyKeys(scope, ['paths', 'pathPolicyIdentity']) || !onlyKeys(policy, ['identity', 'autonomyLevel', 'actorId'])) return false
  if (!SAFE_HEAD.test(String(source.head || ''))) return false
  try {
    const rebuilt = createCodexReadOnlyReviewRequest({
      sourceId: String(source.sourceId),
      sourceRevision: String(source.revision),
      sourceHead: String(source.head),
      runId: String(run.runId),
      sessionId: String(run.sessionId),
      scope: scope as CodexReviewRequestInput['scope'],
      objective: request.objective as CodexReviewObjective,
      adapter: request.adapter as Partial<CodexReviewAdapterIdentity>,
      policy: policy as CodexReviewRequestInput['policy'],
      ...(request.contextReferences ? { contextReferences: request.contextReferences as CodexReviewContextReference[] } : {}),
      ...(request.budgetIdentity ? { budgetIdentity: String(request.budgetIdentity) } : {})
    })
    return rebuilt.ok && rebuilt.request.reviewId === request.reviewId && rebuilt.request.authorityDigest === request.authorityDigest
      && rebuilt.request.run.runId === request.runId && rebuilt.request.scope.paths.length > 0
  } catch {
    return false
  }
}

function requestArguments(request: CodexReviewRequest): Record<string, unknown> {
  return {
    reviewMode: 'read_only',
    reviewAuthority: request
  }
}

function inScope(candidate: string, roots: readonly string[]): boolean {
  return roots.some(root => root === '.' || candidate === root || candidate.startsWith(`${root}/`))
}

function admissionFailure(code: string, message: string): CodexReviewAdmissionFailure {
  return { ok: false, decision: 'DENY', code, message, authority: CODEX_REVIEW_NO_MUTATION_AUTHORITY, stopCondition: 'review_admission_denied' }
}

function checkNoMutationInput(input: unknown): boolean {
  if (!record(input) || !onlyKeys(input, ['request', 'source', 'run', 'session', 'phase16', 'storeOptions'])) return false
  if (!record(input.source) || !onlyKeys(input.source, ['sourceId', 'sourceRoot', 'enabled', 'revision', 'head'])) return false
  if (!record(input.run) || !onlyKeys(input.run, ['runId', 'sessionId', 'sourceId', 'status'])) return false
  if (!record(input.session) || !onlyKeys(input.session, ['sessionId', 'status', 'lockedSourceIds'])) return false
  if (!record(input.phase16) || !onlyKeys(input.phase16, ['policyIdentity', 'autonomyLevel', 'actorId', 'allowedPaths'])) return false
  if (input.storeOptions !== undefined && (!record(input.storeOptions) || !onlyKeys(input.storeOptions, ['rootDir', 'storePath', 'maxRecords', 'now']))) return false
  return true
}

function sourcePathsRemainInsideRoot(sourceRoot: string, paths: readonly string[]): string | undefined {
  if (typeof sourceRoot !== 'string' || !path.isAbsolute(sourceRoot)) return 'Source root must be an absolute directory.'
  let realRoot: string
  try {
    realRoot = fs.realpathSync(sourceRoot)
    if (!fs.statSync(realRoot).isDirectory()) return 'Source root is not a directory.'
  } catch {
    return 'Source root is unavailable.'
  }
  for (const relative of paths) {
    let realCandidate: string
    try {
      realCandidate = fs.realpathSync(path.resolve(realRoot, ...relative.split('/')))
    } catch {
      return `Review path does not exist: ${relative}`
    }
    if (realCandidate !== realRoot && !realCandidate.startsWith(`${realRoot}${path.sep}`)) return `Review path escapes the locked source through a symlink: ${relative}`
  }
  return undefined
}

function reviewApprovalReason(request: CodexReviewRequest): string {
  return `Codex read-only review · source=${request.source.sourceId} · paths=${request.scope.paths.join(',')} · Writes=NO · Git=NO · Network=NO · Credentials=NO`.slice(0, 160)
}

function nowFor(options?: WorkbenchApprovalIntentStoreOptions): string {
  return (options?.now?.() || new Date()).toISOString()
}

export function admitCodexReadOnlyReview(input: CodexReviewAdmissionInput): CodexReviewAdmissionOutcome {
  if (!checkNoMutationInput(input)) return admissionFailure('UNSUPPORTED_AUTHORITY', 'Codex review admission accepts no mutation, command, network, credential, or arbitrary authority fields.')
  if (!validateCodexReviewRequirement({
    required: true,
    taskId: 'review-task',
    packetId: 'review-packet',
    request: input.request,
    approvalDecision: 'REQUIRES_CONFIRMATION',
    stopCondition: 'approval_required',
    findingBoundary: CODEX_REVIEW_FINDING_BOUNDARY
  })) {
    const rebuilt = createCodexReadOnlyReviewRequest({
      sourceId: input.request.source.sourceId,
      sourceRevision: input.request.source.revision,
      sourceHead: input.request.source.head,
      runId: input.request.run.runId,
      sessionId: input.request.run.sessionId,
      scope: input.request.scope,
      objective: input.request.objective,
      adapter: input.request.adapter,
      policy: input.request.policy,
      ...(input.request.contextReferences ? { contextReferences: input.request.contextReferences } : {}),
      ...(input.request.budgetIdentity ? { budgetIdentity: input.request.budgetIdentity } : {})
    })
    if (!rebuilt.ok || rebuilt.request.authorityDigest !== input.request.authorityDigest || rebuilt.request.reviewId !== input.request.reviewId) return admissionFailure('REQUEST_INVALID', 'Codex review request integrity validation failed.')
  }
  const { request, source, run, session, phase16 } = input
  if (!safeIdentity(source.sourceId) || typeof source.sourceRoot !== 'string' || !safeIdentity(source.revision) || !SAFE_HEAD.test(source.head) || !safeIdentity(run.runId) || !safeIdentity(run.sessionId) || !safeIdentity(run.sourceId) || !safeIdentity(session.sessionId) || !Array.isArray(session.lockedSourceIds) || session.lockedSourceIds.some(item => !safeIdentity(item))) return admissionFailure('REQUEST_INVALID', 'Codex review admission authority fields are malformed.')
  if (source.enabled !== true) return admissionFailure('SOURCE_DISABLED', 'The selected Workbench source is disabled.')
  if (source.sourceId !== request.source.sourceId || run.sourceId !== request.source.sourceId || session.lockedSourceIds.length !== 1 || session.lockedSourceIds[0] !== request.source.sourceId) return admissionFailure('SOURCE_LOCK_MISMATCH', 'Codex review source authority is not locked to exactly one active source.')
  if (source.revision !== request.source.revision || source.head.toLowerCase() !== request.source.head.toLowerCase()) return admissionFailure('SOURCE_STALE', 'Codex review source revision or HEAD is stale.')
  if (run.runId !== request.run.runId || run.sessionId !== request.run.sessionId || run.status !== 'active') return admissionFailure('RUN_MISMATCH', 'Codex review run authority is not the active requested run.')
  if (session.sessionId !== request.run.sessionId || session.status !== 'active') return admissionFailure('SESSION_MISMATCH', 'Codex review session authority is not active or does not match the request.')
  if (phase16.policyIdentity !== request.policy.identity || phase16.autonomyLevel !== request.policy.autonomyLevel || phase16.actorId !== request.policy.actorId) return admissionFailure('POLICY_MISMATCH', 'Codex review policy identity, autonomy level, or actor does not match Phase 16 authority.')
  let allowedPaths: string[]
  try { allowedPaths = normalizeAllowedPaths(phase16.allowedPaths, 'Phase 16 review path policy') } catch (error) { return admissionFailure('PATH_POLICY_INVALID', error instanceof Error ? error.message : 'Phase 16 review path policy is invalid.') }
  if (request.scope.paths.some(item => !inScope(item, allowedPaths))) return admissionFailure('PATH_SCOPE_DENIED', 'Codex review scope exceeds the approved Phase 16 path intersection.')
  const rootError = sourcePathsRemainInsideRoot(source.sourceRoot, request.scope.paths)
  if (rootError) return admissionFailure(rootError.includes('symlink') ? 'SYMLINK_ESCAPE' : rootError.includes('does not exist') ? 'PATH_NOT_FOUND' : 'SOURCE_ROOT_INVALID', rootError)

  const authorization = prepareAutonomyDecisionAuthorization({
    operation: CODEX_REVIEW_APPROVAL_OPERATION,
    category: 'read',
    sourceId: request.source.sourceId,
    runId: request.run.runId,
    sessionId: request.run.sessionId,
    actorId: request.policy.actorId,
    capabilityId: request.adapter.capabilityId,
    paths: request.scope.paths,
    arguments: requestArguments(request),
    storeOptions: input.storeOptions
  })
  const approvalRequest = authorization.request
  if (!approvalRequest) return admissionFailure('PHASE16_UNAVAILABLE', authorization.message || 'Phase 16 did not produce an exact approval request.')
  if (authorization.status === 'unavailable') return admissionFailure('PHASE16_UNAVAILABLE', authorization.message || 'Phase 16 approval authority is unavailable.')
  if (authorization.status === 'denied') return admissionFailure('PHASE16_DENIED', authorization.message || 'Phase 16 denied the exact Codex review authority.')
  if (authorization.status === 'requires_confirmation') {
    const approvalOptions = input.storeOptions as WorkbenchApprovalIntentStoreOptions | undefined
    const pending = ensurePendingApprovalIntent({
      sourceId: request.source.sourceId,
      runId: request.run.runId,
      sessionId: request.run.sessionId,
      requestId: request.reviewId,
      operationKind: CODEX_REVIEW_APPROVAL_OPERATION,
      paths: [...request.scope.paths],
      reason: reviewApprovalReason(request),
      requestDigest: approvalRequest.requestFingerprint,
      decisionRequest: approvalRequest,
      evidenceRef: {
        evidenceId: request.reviewId,
        kind: 'capability_result',
        reference: `workbench://codex-review/${request.authorityDigest}`,
        recordedAt: nowFor(approvalOptions)
      },
      options: approvalOptions
    })
    if (pending.ok === false) return admissionFailure('APPROVAL_PREPARATION_FAILED', pending.message)
    return {
      ok: true,
      decision: 'REQUIRES_CONFIRMATION',
      request,
      approvalRequest,
      approval: { operation: CODEX_REVIEW_APPROVAL_OPERATION, requestFingerprint: approvalRequest.requestFingerprint, reused: false, pendingApprovalId: pending.record.approvalId },
      authority: CODEX_REVIEW_NO_MUTATION_AUTHORITY,
      stopCondition: 'approval_required',
      findingBoundary: CODEX_REVIEW_FINDING_BOUNDARY,
      reasonCode: 'CONFIRMATION_REQUIRED',
      message: 'One exact Phase 16 approval is required for this bounded Codex read-only review.'
    }
  }
  const reused = authorization.reasonCode === 'PERSISTED_APPROVAL_REUSED' || (authorization.lookup?.ok === true && authorization.lookup.state === 'matched')
  return {
    ok: true,
    decision: 'ALLOW',
    request,
    approvalRequest,
    approval: { operation: CODEX_REVIEW_APPROVAL_OPERATION, requestFingerprint: approvalRequest.requestFingerprint, reused },
    authority: CODEX_REVIEW_NO_MUTATION_AUTHORITY,
    stopCondition: 'structured_findings_required',
    findingBoundary: CODEX_REVIEW_FINDING_BOUNDARY,
    reasonCode: authorization.reasonCode || 'PHASE16_APPROVED',
    message: reused ? 'The identical approved Codex read-only review authority was reused.' : 'Codex read-only review authority is admitted.'
  }
}

export function formatCodexReviewApproval(request: CodexReviewRequest): string {
  return [
    'Review: Codex read-only review',
    `Source: ${request.source.sourceId}`,
    `Revision/HEAD: ${request.source.revision} / ${request.source.head}`,
    `Scope: ${request.scope.paths.join(', ')}`,
    `Objective: ${request.objective.category} — ${request.objective.summary}`,
    'Writes: NO',
    'Git mutation: NO',
    'Network: NO',
    'Credentials forwarded: NO'
  ].join('\n')
}
