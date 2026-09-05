import crypto from 'node:crypto'
import {
  listExternalMcpBrokerExecutions,
  listExternalMcpOutputArtifacts,
  upsertExternalMcpBrokerExecution,
  type ExternalMcpBrokerExecutionRecord,
  type ExternalMcpBrokerLifecycle,
  type ExternalMcpBrokerTerminalStatus,
  type ExternalMcpIntakeOptions,
  type ExternalMcpJsonObject,
  type ExternalMcpManifestEntry,
  type ExternalMcpTransport,
  type ExternalMcpCredentialEvidence,
  type ExternalMcpPolicyEvidence,
  type ExternalMcpValidationEvidence
} from './external-mcp-intake.js'
import {
  evaluateExternalMcpCredentialEligibility,
  type ExternalMcpCredentialEligibilityInput,
  type ExternalMcpCredentialPolicy
} from './external-mcp-credential-binding.js'
import {
  validateExternalMcpRequest,
  validateExternalMcpResult,
  type ExternalMcpContentType,
  type ExternalMcpValidationResult
} from './external-mcp-schema-validation.js'
import {
  buildExternalMcpHumanProjection,
  buildExternalMcpModelProjection,
  isolateExternalMcpResult,
  type ExternalMcpOutputArtifact,
  type ExternalMcpOutputIsolationResult
} from './external-mcp-output-isolation.js'
import {
  authorizeExternalMcpRequest,
  type ExternalMcpPolicyAuthorizationInput,
  type ExternalMcpPolicyFailureCode
} from './external-mcp-policy-enforcement.js'
import { redactCapabilityText } from './capability-runtime-enforcement.js'

export const EXTERNAL_MCP_BROKER_VERSION = 'r22.6' as const
export const EXTERNAL_MCP_BROKER_LIMITS = Object.freeze({
  maxExecutions: 256,
  maxRequestBytes: 64 * 1024,
  maxResponseBytes: 64 * 1024,
  maxErrorBytes: 1_000,
  maxRecoveryRecords: 256,
  maxTimeoutMs: 300_000
})

export type ExternalMcpTransportResponse = Readonly<{
  status: 'response'
  payload: unknown
  contentType: ExternalMcpContentType
  responseTransportIdentity: string
  advertisedSchema?: ExternalMcpJsonObject
}>

export type ExternalMcpTransportFailure = Readonly<{
  status: 'failed' | 'outcome_unknown'
  code?: string
  message?: string
  dispatched?: boolean
}>

export type ExternalMcpTransportAdapter = Readonly<{
  transport: ExternalMcpTransport
  dispatch: (input: Readonly<{
    entry: ExternalMcpManifestEntry
    request: ExternalMcpPolicyAuthorizationInput['request']
    dispatchId: string
    signal: AbortSignal
    timeoutMs: number
  }>) => Promise<ExternalMcpTransportResponse | ExternalMcpTransportFailure>
  /** Optional trustworthy retained-response reconciliation. It never dispatches. */
  reconcile?: (input: Readonly<{
    execution: ExternalMcpBrokerExecutionRecord
    signal: AbortSignal
  }>) => Promise<ExternalMcpTransportResponse | undefined>
}>

export type ExternalMcpBrokerCredentialInput = Readonly<{
  policy: ExternalMcpCredentialPolicy
  expectedGeneration: number
  requestedAudience?: string
  requestedScopes?: string[]
}>

export type ExternalMcpBrokerInput = Readonly<{
  authorization: ExternalMcpPolicyAuthorizationInput
  credential?: ExternalMcpBrokerCredentialInput
  transport: ExternalMcpTransportAdapter
  contentKind?: 'text' | 'json' | 'blocks'
  signal?: AbortSignal
}>

export type ExternalMcpBrokerSuccess = Readonly<{
  ok: true
  value: {
    execution: ExternalMcpBrokerExecutionRecord
    artifact?: ExternalMcpOutputArtifact
    modelProjection?: ReturnType<typeof buildExternalMcpModelProjection>
    humanProjection?: ReturnType<typeof buildExternalMcpHumanProjection>
  }
}>

export type ExternalMcpBrokerFailureCode =
  | 'BROKER_INPUT_INVALID'
  | 'BROKER_STORE_FAILED'
  | 'BROKER_EXECUTION_RECONCILED'
  | 'REQUEST_VALIDATION_FAILED'
  | 'CREDENTIAL_NOT_ELIGIBLE'
  | 'POLICY_DENIED'
  | 'CONFIRMATION_REQUIRED'
  | 'DISPATCH_FAILED'
  | 'EXTERNAL_MCP_TIMEOUT'
  | 'EXTERNAL_MCP_CANCELLED'
  | 'EXTERNAL_MCP_OUTCOME_UNKNOWN'
  | 'RESULT_VALIDATION_FAILED'
  | 'OUTPUT_ISOLATION_FAILED'
  | ExternalMcpPolicyFailureCode

export type ExternalMcpBrokerFailure = Readonly<{
  ok: false
  code: ExternalMcpBrokerFailureCode
  message: string
  execution?: ExternalMcpBrokerExecutionRecord
}>

export type ExternalMcpBrokerResult = ExternalMcpBrokerSuccess | ExternalMcpBrokerFailure

const SHA256 = /^[a-f0-9]{64}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function bounded(value: unknown, max = 512): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0\r\n]/.test(value) }
function iso(value: unknown): value is string { return typeof value === 'string' && ISO.test(value) && Number.isFinite(Date.parse(value)) }
function canonical(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (seen.has(value)) throw new Error('cyclic-json')
  seen.add(value)
  try {
    if (Array.isArray(value)) return `[${value.map(item => canonical(item, seen)).join(',')}]`
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key], seen)}`).join(',')}}`
  } finally { seen.delete(value) }
}
function digest(value: unknown): string { return crypto.createHash('sha256').update(canonical(value), 'utf8').digest('hex') }
function safeMessage(value: unknown, fallback: string): string {
  if (!bounded(value, EXTERNAL_MCP_BROKER_LIMITS.maxErrorBytes)) return fallback
  return redactCapabilityText(value).slice(0, EXTERNAL_MCP_BROKER_LIMITS.maxErrorBytes)
}
function transportResponseBytes(response: ExternalMcpTransportResponse): number | undefined {
  try {
    const serialized = response.contentType === 'application/json' ? JSON.stringify(response.payload) : typeof response.payload === 'string' ? response.payload : undefined
    if (serialized === undefined) return undefined
    const bytes = Buffer.byteLength(serialized, 'utf8')
    return bytes <= EXTERNAL_MCP_BROKER_LIMITS.maxResponseBytes ? bytes : undefined
  } catch { return undefined }
}
function terminal(status: ExternalMcpBrokerTerminalStatus): boolean { return status.startsWith('EXTERNAL_MCP_') }
function lifecycleFor(status: ExternalMcpBrokerTerminalStatus): ExternalMcpBrokerLifecycle {
  if (status === 'EXTERNAL_MCP_COMPLETED') return 'COMPLETED'
  if (status === 'EXTERNAL_MCP_DENIED') return 'DENIED'
  if (status === 'EXTERNAL_MCP_TIMEOUT') return 'TIMED_OUT'
  if (status === 'EXTERNAL_MCP_CANCELLED') return 'CANCELLED'
  if (status === 'EXTERNAL_MCP_OUTCOME_UNKNOWN') return 'OUTCOME_UNKNOWN'
  if (status === 'EXTERNAL_MCP_RECONCILIATION_REQUIRED') return 'RECONCILIATION_REQUIRED'
  return 'FAILED'
}
function terminalCode(status: ExternalMcpBrokerTerminalStatus): ExternalMcpBrokerFailureCode {
  if (status === 'EXTERNAL_MCP_DENIED') return 'POLICY_DENIED'
  if (status === 'EXTERNAL_MCP_TIMEOUT') return 'EXTERNAL_MCP_TIMEOUT'
  if (status === 'EXTERNAL_MCP_CANCELLED') return 'EXTERNAL_MCP_CANCELLED'
  if (status === 'EXTERNAL_MCP_OUTCOME_UNKNOWN' || status === 'EXTERNAL_MCP_RECONCILIATION_REQUIRED') return 'EXTERNAL_MCP_OUTCOME_UNKNOWN'
  if (status === 'EXTERNAL_MCP_FAILED') return 'DISPATCH_FAILED'
  return 'BROKER_EXECUTION_RECONCILED'
}
function policyDigest(value: ExternalMcpPolicyAuthorizationInput['policy']): string {
  return digest({ network: value.network, path: value.path })
}
function confirmationIdentity(input: ExternalMcpPolicyAuthorizationInput, requestDigest: string): string | undefined {
  if (input.policy.confirmationClass !== 'CONFIRMATION_REQUIRED') return undefined
  return digest({ policyDigest: input.policy.policyDigest, requestDigest, identity: input.phase16.identity, confirmation: input.phase16.policyInput?.confirmation ?? null })
}
function semanticIdentity(input: ExternalMcpBrokerInput, requestSchemaDigest: string | undefined): string {
  const { authorization, credential } = input
  return digest({
    version: EXTERNAL_MCP_BROKER_VERSION,
    ownerId: authorization.request.ownerId,
    profile: authorization.request.profile,
    sourceId: authorization.request.sourceId ?? null,
    sessionId: authorization.request.sessionId ?? null,
    serverIdentity: authorization.policy.serverIdentity,
    configuredEndpointIdentity: authorization.policy.configuredEndpointIdentity,
    transport: authorization.policy.transport,
    manifestId: authorization.policy.manifestId,
    entryId: authorization.policy.entryId,
    approvalId: authorization.policy.approvalId,
    policyDigest: authorization.policy.policyDigest,
    requestSchemaDigest: requestSchemaDigest ?? null,
    credentialGeneration: credential?.expectedGeneration ?? null,
    arguments: authorization.request.arguments
  })
}
function currentExecution(input: ExternalMcpBrokerInput, requestSchemaDigest: string | undefined, policyEvidenceId: string): ExternalMcpBrokerExecutionRecord {
  const { authorization, credential } = input
  const semantic = semanticIdentity(input, requestSchemaDigest)
  const at = (authorization.now ?? (() => new Date()))().toISOString()
  const credentialPolicy = credential?.policy
  const credentialEvidenceId = undefined
  const credentialData = credential
    ? { required: true as const, credentialClass: 'external-mcp-oauth' as const, bindingId: credentialPolicy?.bindingId, credentialReferenceId: credentialPolicy?.credentialReferenceId, generation: credential.expectedGeneration, audience: credentialPolicy?.requiredAudience, scopeDigest: credentialPolicy ? digest(credentialPolicy.requiredScopes) : undefined, ...(credentialEvidenceId ? { evidenceId: credentialEvidenceId } : {}) }
    : { required: false as const, credentialClass: 'none' as const }
  return {
    schemaVersion: 1,
    executionId: `mcp-execution-${semantic}`,
    semanticExecutionId: `mcp-execution-${semantic}`,
    ownerId: authorization.policy.ownerId,
    profile: authorization.policy.profile,
    ...(authorization.policy.sourceId ? { sourceId: authorization.policy.sourceId } : {}),
    ...(authorization.policy.sessionId ? { sessionId: authorization.policy.sessionId } : {}),
    serverIdentity: authorization.policy.serverIdentity,
    configuredEndpointIdentity: authorization.policy.configuredEndpointIdentity,
    transport: authorization.policy.transport,
    manifestId: authorization.policy.manifestId,
    entryId: authorization.policy.entryId,
    entryKind: authorization.policy.entryKind,
    approvalId: authorization.policy.approvalId,
    request: { requestId: authorization.request.requestId, ...(requestSchemaDigest ? { requestSchemaDigest } : {}) },
    credential: credentialData,
    policy: { policyId: authorization.policy.policyId, policyDigest: authorization.policy.policyDigest, effect: authorization.policy.effect, networkPolicyDigest: policyDigest(authorization.policy), pathPolicyDigest: digest(authorization.policy.path), confirmationClass: authorization.policy.confirmationClass, evidenceId: policyEvidenceId, grantId: authorization.policy.requiredGrantId, planId: authorization.policy.requiredPlanId, timeoutMs: authorization.policy.timeoutMs, budgets: authorization.policy.requiredBudgets },
    dispatch: { reservationId: `mcp-reservation-${semantic}`, dispatchCount: 0 },
    lifecycle: 'CREATED',
    recovery: { state: 'NOT_REQUIRED', restartCount: 0, lastAction: 'not_recovered' },
    followUp: { executed: false },
    audit: { policyEvidenceId },
    createdAt: at,
    updatedAt: at
  }
}
function save(input: ExternalMcpBrokerInput, execution: ExternalMcpBrokerExecutionRecord): ExternalMcpBrokerExecutionRecord | undefined {
  const saved = upsertExternalMcpBrokerExecution(execution, input.authorization.intakeOptions)
  return saved.ok ? saved.value : undefined
}
function withLifecycle(input: ExternalMcpBrokerInput, execution: ExternalMcpBrokerExecutionRecord, lifecycle: ExternalMcpBrokerLifecycle, fields: Partial<ExternalMcpBrokerExecutionRecord> = {}): ExternalMcpBrokerExecutionRecord | undefined {
  const at = (input.authorization.now ?? (() => new Date()))().toISOString()
  return save(input, { ...execution, ...fields, lifecycle, updatedAt: at })
}
function finish(input: ExternalMcpBrokerInput, execution: ExternalMcpBrokerExecutionRecord, status: ExternalMcpBrokerTerminalStatus, reason: string, stage: ExternalMcpBrokerLifecycle): ExternalMcpBrokerFailure {
  const at = (input.authorization.now ?? (() => new Date()))().toISOString()
  const updated = save(input, { ...execution, lifecycle: lifecycleFor(status), terminalStatus: status, terminalStage: stage, terminalReason: safeMessage(reason, 'External MCP operation reached a terminal state.'), terminalAt: at, updatedAt: at })
  return { ok: false, code: terminalCode(status), message: safeMessage(reason, 'External MCP operation was not completed.'), ...(updated ? { execution: updated } : {}) }
}
function completed(input: ExternalMcpBrokerInput, execution: ExternalMcpBrokerExecutionRecord): ExternalMcpBrokerSuccess | ExternalMcpBrokerFailure {
  const artifactId = execution.output?.artifactId
  if (!artifactId) return { ok: false, code: 'BROKER_STORE_FAILED', message: 'Completed external MCP execution has no isolated output reference.', execution }
  const listed = listExternalMcpOutputArtifacts(input.authorization.intakeOptions)
  if (!listed.ok) return { ok: false, code: 'BROKER_STORE_FAILED', message: 'Completed external MCP output could not be reloaded safely.', execution }
  const artifact = listed.value.find(item => item.artifactId === artifactId)
  if (!artifact) return { ok: false, code: 'BROKER_STORE_FAILED', message: 'Completed external MCP output artifact is unavailable.', execution }
  return { ok: true, value: { execution, artifact, modelProjection: buildExternalMcpModelProjection(artifact), humanProjection: buildExternalMcpHumanProjection(artifact) } }
}
function priorResult(input: ExternalMcpBrokerInput, execution: ExternalMcpBrokerExecutionRecord): ExternalMcpBrokerResult | undefined {
  if (!execution.terminalStatus) return undefined
  if (execution.terminalStatus === 'EXTERNAL_MCP_COMPLETED') return completed(input, execution)
  return { ok: false, code: terminalCode(execution.terminalStatus), message: execution.terminalReason ?? 'External MCP execution already reached a terminal state.', execution }
}
function responseValidationTarget(input: ExternalMcpBrokerInput) {
  const { authorization } = input
  return { manifest: authorization.manifest, manifestId: authorization.policy.manifestId, serverIdentity: authorization.policy.serverIdentity, entryId: authorization.policy.entryId, approvalId: authorization.policy.approvalId }
}
async function completeResponse(input: ExternalMcpBrokerInput, execution: ExternalMcpBrokerExecutionRecord, response: ExternalMcpTransportResponse, recovered: boolean): Promise<ExternalMcpBrokerResult> {
  const bytes = transportResponseBytes(response)
  if (bytes === undefined) return finish(input, execution, 'EXTERNAL_MCP_FAILED', 'The external MCP response exceeded the bounded response contract.', 'RESPONSE_RECEIVED')
  const received = withLifecycle(input, execution, 'RESPONSE_RECEIVED', { dispatch: { ...execution.dispatch, responseTransportIdentity: response.responseTransportIdentity }, response: undefined })
  if (!received) return { ok: false, code: 'BROKER_STORE_FAILED', message: 'External MCP response receipt could not be persisted.', execution }
  const result = validateExternalMcpResult({ ...responseValidationTarget(input), payload: response.payload, contentType: response.contentType, advertisedSchema: response.advertisedSchema as never }, input.authorization.intakeOptions)
  if (!result.ok || result.outcome !== 'RESULT_VALID' || !result.resultDigest || !result.schemaDigest || !result.evidence) {
    return finish(input, received, 'EXTERNAL_MCP_FAILED', `External MCP result validation failed: ${result.outcome}.`, 'RESPONSE_RECEIVED')
  }
  const resultValidated = withLifecycle(input, received, 'RESULT_VALIDATED', {
    response: { responseTransportIdentity: response.responseTransportIdentity, responseBytes: bytes, resultSchemaDigest: result.schemaDigest, resultDigest: result.resultDigest, validationEvidenceId: result.evidence.evidenceId },
    request: { ...received.request, requestDigest: result.requestDigest ?? received.request.requestDigest },
    audit: { ...received.audit, requestValidationEvidenceId: received.request.validationEvidenceId, resultValidationEvidenceId: result.evidence.evidenceId }
  })
  if (!resultValidated) return { ok: false, code: 'BROKER_STORE_FAILED', message: 'External MCP result validation could not be persisted.', execution: received }
  const isolated = isolateExternalMcpResult({ result, target: responseValidationTarget(input), contentKind: input.contentKind, runtimeIdentity: EXTERNAL_MCP_BROKER_VERSION }, input.authorization.intakeOptions)
  if (!isolated.ok) return finish(input, resultValidated, 'EXTERNAL_MCP_FAILED', `External MCP output isolation failed: ${isolated.outcome}.`, 'RESULT_VALIDATED')
  const outputIsolated = withLifecycle(input, resultValidated, 'OUTPUT_ISOLATED', {
    output: { artifactId: isolated.artifact.artifactId, isolationIdentity: isolated.artifact.semanticIdentity, trustClass: isolated.artifact.trustClass },
    audit: { ...resultValidated.audit, outputIsolationIdentity: isolated.artifact.semanticIdentity },
    recovery: recovered ? { state: 'RECONCILED', restartCount: resultValidated.recovery.restartCount, lastAction: 'response_reconciled_without_dispatch' } : resultValidated.recovery
  })
  if (!outputIsolated) return { ok: false, code: 'BROKER_STORE_FAILED', message: 'External MCP output isolation could not be persisted.', execution: resultValidated }
  const final = withLifecycle(input, outputIsolated, 'COMPLETED', { terminalStatus: 'EXTERNAL_MCP_COMPLETED', terminalStage: 'COMPLETED', terminalReason: 'External MCP response validated, isolated, and completed exactly once.', terminalAt: (input.authorization.now ?? (() => new Date()))().toISOString(), recovery: recovered ? { state: 'RECONCILED', restartCount: outputIsolated.recovery.restartCount, lastAction: 'response_reconciled_without_dispatch' } : outputIsolated.recovery })
  return final ? completed(input, final) : { ok: false, code: 'BROKER_STORE_FAILED', message: 'External MCP terminal completion could not be persisted.', execution: outputIsolated }
}
function mapPolicyFailure(input: ExternalMcpBrokerInput, execution: ExternalMcpBrokerExecutionRecord, result: Exclude<ReturnType<typeof authorizeExternalMcpRequest>, { ok: true }>): ExternalMcpBrokerFailure {
  const code = result.code === 'phase16_confirmation_required' || result.code === 'confirmation_required' ? 'CONFIRMATION_REQUIRED' : result.code === 'POLICY_INVALID' ? 'POLICY_DENIED' : result.code
  const status: ExternalMcpBrokerTerminalStatus = 'EXTERNAL_MCP_DENIED'
  const stage: ExternalMcpBrokerLifecycle = code === 'CONFIRMATION_REQUIRED' ? 'CONFIRMATION_REQUIRED' : 'POLICY_AUTHORIZED'
  return finish(input, execution, status, result.message, stage)
}
async function dispatchOnce(input: ExternalMcpBrokerInput, execution: ExternalMcpBrokerExecutionRecord): Promise<ExternalMcpBrokerResult> {
  const entry = input.authorization.manifest.entries.find(item => item.entryId === input.authorization.policy.entryId)
  if (!entry) return finish(input, execution, 'EXTERNAL_MCP_DENIED', 'The approved external MCP entry is unavailable.', 'INTAKE_VERIFIED')
  const reservation = withLifecycle(input, execution, 'DISPATCH_RESERVATION_PERSISTED', { dispatch: { ...execution.dispatch, dispatchId: `mcp-dispatch-${execution.semanticExecutionId.slice('mcp-execution-'.length)}`, transportRequestId: `mcp-dispatch-${execution.semanticExecutionId.slice('mcp-execution-'.length)}` } })
  if (!reservation) return { ok: false, code: 'BROKER_STORE_FAILED', message: 'External MCP dispatch reservation could not be persisted.', execution }
  const dispatchId = reservation.dispatch.dispatchId!
  const dispatched = withLifecycle(input, reservation, 'DISPATCHED', { dispatch: { ...reservation.dispatch, dispatchCount: 1 } })
  if (!dispatched) return { ok: false, code: 'BROKER_STORE_FAILED', message: 'External MCP dispatch identity could not be persisted.', execution: reservation }
  const controller = new AbortController()
  let timedOut = false
  let cancelled = false
  const abort = () => { cancelled = true; controller.abort() }
  const timeout = setTimeout(() => { timedOut = true; controller.abort() }, input.authorization.policy.timeoutMs)
  input.signal?.addEventListener('abort', abort, { once: true })
  if (input.signal?.aborted) abort()
  const abortPromise = new Promise<ExternalMcpTransportFailure>(resolve => {
    const aborted = () => resolve({ status: 'failed', code: timedOut ? 'timeout' : 'cancelled', dispatched: true })
    if (controller.signal.aborted) aborted()
    else controller.signal.addEventListener('abort', aborted, { once: true })
  })
  const resultPromise = input.transport.dispatch({ entry, request: input.authorization.request, dispatchId, signal: controller.signal, timeoutMs: input.authorization.policy.timeoutMs })
  let response: ExternalMcpTransportResponse | ExternalMcpTransportFailure
  try { response = await Promise.race([resultPromise, abortPromise]) } catch { response = { status: 'failed', code: 'transport_failure', dispatched: true } } finally { clearTimeout(timeout); input.signal?.removeEventListener('abort', abort) }
  if (cancelled && !timedOut) return finish(input, dispatched, 'EXTERNAL_MCP_CANCELLED', 'External MCP execution was cancelled before a response completed.', 'DISPATCHED')
  if (timedOut) return finish(input, dispatched, 'EXTERNAL_MCP_TIMEOUT', 'External MCP execution exceeded its finite timeout.', 'DISPATCHED')
  if (response.status !== 'response') {
    if (response.status === 'outcome_unknown' || response.dispatched === true && response.code === 'unknown') return finish(input, dispatched, 'EXTERNAL_MCP_OUTCOME_UNKNOWN', 'External MCP dispatch outcome is unknown; reconciliation is required and no replay is permitted.', 'DISPATCHED')
    return finish(input, dispatched, 'EXTERNAL_MCP_FAILED', 'External MCP transport failed without a bounded response.', 'DISPATCHED')
  }
  return completeResponse(input, dispatched, response, false)
}

export async function executeExternalMcpBroker(input: ExternalMcpBrokerInput): Promise<ExternalMcpBrokerResult> {
  const authorization = input?.authorization
  if (!authorization || !input.transport || input.transport.transport !== authorization.policy.transport || !authorization.intakeOptions || !bounded(authorization.request.requestId) || !IDENTIFIER.test(authorization.request.runId)) return { ok: false, code: 'BROKER_INPUT_INVALID', message: 'External MCP broker input is malformed or transport identity does not match the approved policy.' }
  const entry = authorization.manifest.entries.find(item => item.entryId === authorization.policy.entryId)
  const requestSchemaDigest = entry?.declaredRequestSchemaDigest
  const semantic = semanticIdentity(input, requestSchemaDigest)
  const listed = listExternalMcpBrokerExecutions(authorization.intakeOptions)
  if (!listed.ok) return { ok: false, code: 'BROKER_STORE_FAILED', message: 'External MCP broker state could not be read safely.' }
  const prior = listed.value.find(item => item.semanticExecutionId === `mcp-execution-${semantic}`)
  if (prior) {
    const existing = priorResult(input, prior)
    if (existing) return existing
    return recoverExternalMcpExecution(input)
  }
  const request = validateExternalMcpRequest({ manifest: authorization.manifest, manifestId: authorization.policy.manifestId, serverIdentity: authorization.policy.serverIdentity, entryId: authorization.policy.entryId, approvalId: authorization.policy.approvalId, payload: authorization.request.arguments, contentType: 'application/json' }, authorization.intakeOptions)
  const credential = input.credential
    ? evaluateExternalMcpCredentialEligibility({ policy: input.credential.policy, expectedGeneration: input.credential.expectedGeneration, requestedAudience: input.credential.requestedAudience, requestedScopes: input.credential.requestedScopes, now: (authorization.now ?? (() => new Date()))().toISOString() } satisfies ExternalMcpCredentialEligibilityInput, authorization.intakeOptions)
    : undefined
  const policy = authorizeExternalMcpRequest(authorization)
  const policyEvidenceId = policy.ok ? policy.value.evidence.evidenceId : policy.evidence?.evidenceId ?? `mcp-policy-evidence-${authorization.policy.policyDigest}`
  let execution = currentExecution(input, request.schemaDigest ?? requestSchemaDigest, policyEvidenceId)
  execution = { ...execution, lifecycle: 'INTAKE_VERIFIED', request: { ...execution.request, ...(request.schemaDigest ? { requestSchemaDigest: request.schemaDigest } : {}) }, audit: { ...execution.audit, policyEvidenceId } }
  if (!save(input, execution)) return { ok: false, code: 'BROKER_STORE_FAILED', message: 'External MCP execution could not be initialized.' }
  const requestEvidenceId = request.evidence?.evidenceId
  execution = withLifecycle(input, execution, request.ok && request.outcome === 'REQUEST_VALID' ? 'REQUEST_VALIDATED' : 'REQUEST_VALIDATED', { request: { ...execution.request, ...(request.requestDigest ? { requestDigest: request.requestDigest } : {}), ...(request.schemaDigest ? { requestSchemaDigest: request.schemaDigest } : {}), ...(requestEvidenceId ? { validationEvidenceId: requestEvidenceId } : {}) }, audit: { ...execution.audit, requestValidationEvidenceId: requestEvidenceId } }) ?? execution
  if (!request.ok || request.outcome !== 'REQUEST_VALID') return finish(input, execution, 'EXTERNAL_MCP_DENIED', `External MCP request validation failed: ${request.outcome}.`, 'REQUEST_VALIDATED')
  if (credential && !credential.ok) return finish(input, execution, 'EXTERNAL_MCP_DENIED', credential.message, 'REQUEST_VALIDATED')
  if (credential?.ok) {
    execution = withLifecycle(input, execution, 'CREDENTIAL_ELIGIBLE', { credential: { ...execution.credential, credentialReferenceId: credential.credentialReferenceId, generation: credential.generation, evidenceId: credential.evidence.evidenceId }, audit: { ...execution.audit, credentialEvidenceId: credential.evidence.evidenceId } }) ?? execution
  }
  if (!policy.ok) return mapPolicyFailure(input, execution, policy)
  execution = withLifecycle(input, execution, 'POLICY_AUTHORIZED', { policy: { ...execution.policy, evidenceId: policy.value.evidence.evidenceId, confirmationIdentity: confirmationIdentity(authorization, request.requestDigest ?? request.payloadDigest ?? '') }, audit: { ...execution.audit, policyEvidenceId: policy.value.evidence.evidenceId } }) ?? execution
  execution = withLifecycle(input, execution, 'READY_TO_DISPATCH') ?? execution
  return dispatchOnce(input, execution)
}

export async function recoverExternalMcpExecution(input: ExternalMcpBrokerInput): Promise<ExternalMcpBrokerResult> {
  const authorization = input.authorization
  const requestSchemaDigest = authorization.manifest.entries.find(item => item.entryId === authorization.policy.entryId)?.declaredRequestSchemaDigest
  const semantic = `mcp-execution-${semanticIdentity(input, requestSchemaDigest)}`
  const listed = listExternalMcpBrokerExecutions(authorization.intakeOptions)
  if (!listed.ok) return { ok: false, code: 'BROKER_STORE_FAILED', message: 'External MCP broker state could not be read safely.' }
  const execution = listed.value.find(item => item.semanticExecutionId === semantic)
  if (!execution) return { ok: false, code: 'BROKER_STORE_FAILED', message: 'External MCP execution was not found for recovery.' }
  const prior = priorResult(input, execution)
  if (prior) return prior
  const at = (authorization.now ?? (() => new Date()))().toISOString()
  const recovered = save(input, { ...execution, recovery: { state: 'RECONCILIATION_REQUIRED', restartCount: execution.recovery.restartCount + 1, lastAction: 'restart_observed_without_replay' }, updatedAt: at })
  if (!recovered) return { ok: false, code: 'BROKER_STORE_FAILED', message: 'External MCP recovery state could not be persisted.', execution }
  if (execution.lifecycle === 'DISPATCHED' || execution.lifecycle === 'RESPONSE_RECEIVED' || execution.lifecycle === 'RESULT_VALIDATED') {
    const controller = new AbortController()
    const response = await input.transport.reconcile?.({ execution: recovered, signal: controller.signal })
    if (response) return completeResponse(input, recovered, response, true)
  }
  return finish(input, recovered, 'EXTERNAL_MCP_RECONCILIATION_REQUIRED', 'External MCP outcome cannot be proven after restart; no remote replay is permitted.', execution.lifecycle)
}

export type ExternalMcpBrokerLineageResult = Readonly<{
  complete: boolean
  missing: readonly string[]
  conflicts: readonly string[]
  duplicateDispatch: boolean
}>

export type ExternalMcpBrokerLineageInput = Readonly<{
  execution: ExternalMcpBrokerExecutionRecord
  requestEvidence?: readonly ExternalMcpValidationEvidence[]
  resultEvidence?: readonly ExternalMcpValidationEvidence[]
  policyEvidence?: readonly ExternalMcpPolicyEvidence[]
  credentialEvidence?: readonly ExternalMcpCredentialEvidence[]
  artifact?: ExternalMcpOutputArtifact
  executions?: readonly ExternalMcpBrokerExecutionRecord[]
}>

/**
 * Check the persisted, owner-local lineage without consulting external metadata.
 * This is intentionally diagnostic: it never authorizes, dispatches, or repairs.
 */
export function verifyExternalMcpBrokerLineage(input: ExternalMcpBrokerLineageInput): ExternalMcpBrokerLineageResult {
  const { execution } = input
  const missing: string[] = []
  const conflicts: string[] = []
  const requireValue = (condition: unknown, label: string) => { if (!condition) missing.push(label) }
  const policyEvidence = input.policyEvidence?.find(item => item.evidenceId === execution.policy.evidenceId)
  const requestEvidence = execution.audit.requestValidationEvidenceId
    ? input.requestEvidence?.find(item => item.evidenceId === execution.audit.requestValidationEvidenceId)
    : undefined
  const resultEvidence = execution.audit.resultValidationEvidenceId
    ? input.resultEvidence?.find(item => item.evidenceId === execution.audit.resultValidationEvidenceId)
    : undefined
  const credentialEvidence = execution.audit.credentialEvidenceId
    ? input.credentialEvidence?.find(item => item.evidenceId === execution.audit.credentialEvidenceId)
    : undefined

  requireValue(execution.executionId === execution.semanticExecutionId, 'execution identity')
  requireValue(execution.ownerId && execution.profile && execution.serverIdentity, 'owner/profile/server identity')
  requireValue(execution.manifestId && execution.entryId && execution.approvalId, 'manifest/entry/approval identity')
  requireValue(execution.request.requestId, 'request identity')
  requireValue(execution.request.requestSchemaDigest, 'request schema digest')
  requireValue(execution.audit.policyEvidenceId === execution.policy.evidenceId, 'policy audit reference')
  requireValue(policyEvidence, 'policy evidence')
  if (policyEvidence) {
    if (policyEvidence.ownerId !== execution.ownerId || policyEvidence.manifestId !== execution.manifestId || policyEvidence.entryId !== execution.entryId || policyEvidence.approvalId !== execution.approvalId || policyEvidence.policyDigest !== execution.policy.policyDigest) conflicts.push('policy evidence identity')
  }
  requireValue(execution.audit.requestValidationEvidenceId, 'request validation audit reference')
  requireValue(requestEvidence, 'request validation evidence')
  if (requestEvidence) {
    if (requestEvidence.manifestId !== execution.manifestId || requestEvidence.serverIdentity !== execution.serverIdentity || requestEvidence.entryId !== execution.entryId || requestEvidence.approvalId !== execution.approvalId) conflicts.push('request evidence identity')
  }
  if (execution.credential.required) {
    requireValue(execution.credential.evidenceId && execution.audit.credentialEvidenceId === execution.credential.evidenceId, 'credential audit reference')
    requireValue(credentialEvidence, 'credential evidence')
    if (credentialEvidence && (credentialEvidence.ownerId !== execution.ownerId || credentialEvidence.manifestId !== execution.manifestId || credentialEvidence.entryId !== execution.entryId || credentialEvidence.approvalId !== execution.approvalId || credentialEvidence.generation !== execution.credential.generation)) conflicts.push('credential evidence identity')
  }

  const isCompleted = execution.terminalStatus === 'EXTERNAL_MCP_COMPLETED'
  if (isCompleted) {
    requireValue(execution.lifecycle === 'COMPLETED' && execution.terminalStage === 'COMPLETED', 'completed lifecycle')
    requireValue(execution.request.requestDigest, 'request digest')
    requireValue(execution.dispatch.reservationId && execution.dispatch.dispatchId && execution.dispatch.transportRequestId, 'dispatch reservation identity')
    requireValue(execution.dispatch.dispatchCount === 1, 'exactly-once dispatch count')
    requireValue(execution.dispatch.responseTransportIdentity, 'response transport identity')
    requireValue(execution.response, 'response lineage')
    requireValue(execution.audit.resultValidationEvidenceId, 'result validation audit reference')
    requireValue(resultEvidence, 'result validation evidence')
    requireValue(execution.output?.artifactId && execution.output.trustClass === 'EXTERNAL_UNTRUSTED_DATA', 'isolated output lineage')
    requireValue(execution.audit.outputIsolationIdentity === execution.output?.isolationIdentity, 'output isolation audit reference')
    requireValue(input.artifact && input.artifact.artifactId === execution.output?.artifactId && input.artifact.trustClass === 'EXTERNAL_UNTRUSTED_DATA', 'isolated output artifact')
    requireValue(execution.followUp.executed === false, 'no follow-up')
    if (execution.response && resultEvidence) {
      if (execution.response.resultSchemaDigest !== resultEvidence.schemaDigest) conflicts.push('result schema evidence')
    }
    if (input.artifact && execution.output) {
      if (input.artifact.semanticIdentity !== execution.output.isolationIdentity || input.artifact.provenance.serverIdentity !== execution.serverIdentity || input.artifact.provenance.manifestId !== execution.manifestId || input.artifact.provenance.entryId !== execution.entryId || input.artifact.provenance.approvalId !== execution.approvalId) conflicts.push('output artifact identity')
      if (execution.response && input.artifact.provenance.resultDigest !== execution.response.resultDigest) conflicts.push('output result digest')
    }
  } else {
    requireValue(execution.terminalStatus, 'terminal status')
    requireValue(execution.terminalStage, 'terminal stage')
    requireValue(execution.terminalReason, 'terminal reason')
    if (execution.terminalStatus === 'EXTERNAL_MCP_DENIED') {
      requireValue(execution.dispatch.dispatchCount === 0, 'denied dispatch count')
      requireValue(!execution.dispatch.dispatchId && !execution.dispatch.transportRequestId, 'denied dispatch absence')
    }
  }

  const executions = input.executions ?? []
  const sameSemantic = executions.filter(item => item.semanticExecutionId === execution.semanticExecutionId)
  const duplicateDispatch = execution.dispatch.dispatchCount > 1 || sameSemantic.some(item => item.executionId !== execution.executionId && item.dispatch.dispatchCount > 0)
  if (duplicateDispatch) conflicts.push('duplicate dispatch')
  if (sameSemantic.some(item => item.executionId !== execution.executionId && (item.manifestId !== execution.manifestId || item.entryId !== execution.entryId || item.policy.policyDigest !== execution.policy.policyDigest))) conflicts.push('conflicting semantic identity')
  return { complete: missing.length === 0 && conflicts.length === 0 && !duplicateDispatch, missing, conflicts, duplicateDispatch }
}

export function listExternalMcpBrokerExecutionRecords(options: ExternalMcpIntakeOptions & { ownerId: string }): ReturnType<typeof listExternalMcpBrokerExecutions> { return listExternalMcpBrokerExecutions(options) }
