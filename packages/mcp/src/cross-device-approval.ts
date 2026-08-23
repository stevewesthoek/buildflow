import { Ajv, type ValidateFunction } from 'ajv'

export const WORKBENCH_APPROVAL_CONTRACT_VERSION = '1' as const
export const WORKBENCH_APPROVAL_REQUEST_KIND = 'workbench.approval.request' as const
export const WORKBENCH_APPROVAL_DECISION_KIND = 'workbench.approval.decision' as const

export const WORKBENCH_APPROVAL_STATE_VALUES = ['pending', 'approved', 'denied', 'expired', 'withdrawn'] as const
export type WorkbenchApprovalState = typeof WORKBENCH_APPROVAL_STATE_VALUES[number]

export const WORKBENCH_APPROVAL_SCOPE_VALUES = ['run', 'mutation', 'release', 'configuration', 'device_join'] as const
export type WorkbenchApprovalScope = typeof WORKBENCH_APPROVAL_SCOPE_VALUES[number]

export type WorkbenchApprovalRequest = {
  kind: typeof WORKBENCH_APPROVAL_REQUEST_KIND
  contractVersion: typeof WORKBENCH_APPROVAL_CONTRACT_VERSION
  requestId: string
  originDeviceId: string
  targetDeviceId: string
  userId: string
  scope: WorkbenchApprovalScope
  description: string
  packetId?: string
  runId?: string
  requiredLevel: number
  state: WorkbenchApprovalState
  requestedAt: string
  expiresAt: string
}

export type WorkbenchApprovalDecision = {
  kind: typeof WORKBENCH_APPROVAL_DECISION_KIND
  contractVersion: typeof WORKBENCH_APPROVAL_CONTRACT_VERSION
  requestId: string
  decidedBy: string
  decidedOnDeviceId: string
  state: 'approved' | 'denied'
  reason: string
  conditions?: string[]
  decidedAt: string
}

type JsonSchema = Record<string, unknown>
const boundedString = (maxLength: number): JsonSchema => ({ type: 'string', minLength: 1, maxLength })

export const WORKBENCH_APPROVAL_REQUEST_SCHEMA: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Workbench Approval Request',
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'contractVersion', 'requestId', 'originDeviceId', 'targetDeviceId', 'userId', 'scope', 'description', 'requiredLevel', 'state', 'requestedAt', 'expiresAt'],
  properties: {
    kind: { const: WORKBENCH_APPROVAL_REQUEST_KIND },
    contractVersion: { const: WORKBENCH_APPROVAL_CONTRACT_VERSION },
    requestId: boundedString(128),
    originDeviceId: boundedString(128),
    targetDeviceId: boundedString(128),
    userId: boundedString(128),
    scope: { enum: [...WORKBENCH_APPROVAL_SCOPE_VALUES] },
    description: boundedString(1024),
    packetId: boundedString(128),
    runId: boundedString(128),
    requiredLevel: { type: 'integer', minimum: 0, maximum: 6 },
    state: { enum: [...WORKBENCH_APPROVAL_STATE_VALUES] },
    requestedAt: boundedString(64),
    expiresAt: boundedString(64)
  }
}

export const WORKBENCH_APPROVAL_DECISION_SCHEMA: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Workbench Approval Decision',
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'contractVersion', 'requestId', 'decidedBy', 'decidedOnDeviceId', 'state', 'reason', 'decidedAt'],
  properties: {
    kind: { const: WORKBENCH_APPROVAL_DECISION_KIND },
    contractVersion: { const: WORKBENCH_APPROVAL_CONTRACT_VERSION },
    requestId: boundedString(128),
    decidedBy: boundedString(128),
    decidedOnDeviceId: boundedString(128),
    state: { enum: ['approved', 'denied'] },
    reason: boundedString(512),
    conditions: { type: 'array', items: { type: 'string', maxLength: 256 } },
    decidedAt: boundedString(64)
  }
}

let approvalRequestValidator: ValidateFunction | undefined
let approvalDecisionValidator: ValidateFunction | undefined

function getApprovalRequestValidator(): ValidateFunction {
  if (!approvalRequestValidator) {
    const ajv = new Ajv({ strict: false, allErrors: true })
    approvalRequestValidator = ajv.compile(WORKBENCH_APPROVAL_REQUEST_SCHEMA)
  }
  return approvalRequestValidator
}

function getApprovalDecisionValidator(): ValidateFunction {
  if (!approvalDecisionValidator) {
    const ajv = new Ajv({ strict: false, allErrors: true })
    approvalDecisionValidator = ajv.compile(WORKBENCH_APPROVAL_DECISION_SCHEMA)
  }
  return approvalDecisionValidator
}

export function validateApprovalRequest(
  input: unknown
): { valid: true; request: WorkbenchApprovalRequest } | { valid: false; errors: string[] } {
  const validate = getApprovalRequestValidator()
  if (validate(input)) return { valid: true, request: input as WorkbenchApprovalRequest }
  return { valid: false, errors: (validate.errors ?? []).map(e => `${e.instancePath} ${e.message ?? ''}`.trim()) }
}

export function validateApprovalDecision(
  input: unknown
): { valid: true; decision: WorkbenchApprovalDecision } | { valid: false; errors: string[] } {
  const validate = getApprovalDecisionValidator()
  if (validate(input)) return { valid: true, decision: input as WorkbenchApprovalDecision }
  return { valid: false, errors: (validate.errors ?? []).map(e => `${e.instancePath} ${e.message ?? ''}`.trim()) }
}

export type WorkbenchApprovalStore = {
  requests: Map<string, WorkbenchApprovalRequest>
  decisions: Map<string, WorkbenchApprovalDecision>
}

export function createApprovalStore(): WorkbenchApprovalStore {
  return { requests: new Map(), decisions: new Map() }
}

export function submitApprovalRequest(
  store: WorkbenchApprovalStore,
  request: WorkbenchApprovalRequest
): { submitted: true } | { submitted: false; reason: string } {
  const validation = validateApprovalRequest(request)
  if (!validation.valid) return { submitted: false, reason: `invalid_request: ${validation.errors.join(', ')}` }
  if (request.state !== 'pending') return { submitted: false, reason: 'initial_state_must_be_pending' }
  if (request.originDeviceId === request.targetDeviceId) return { submitted: false, reason: 'cannot_approve_own_device' }
  const requestedAt = new Date(request.requestedAt).getTime()
  const expiresAt = new Date(request.expiresAt).getTime()
  if (isNaN(requestedAt) || isNaN(expiresAt) || expiresAt <= requestedAt) return { submitted: false, reason: 'invalid_request_expiry' }
  if (store.requests.has(request.requestId)) return { submitted: false, reason: 'request_already_exists' }
  store.requests.set(request.requestId, request)
  return { submitted: true }
}

export function resolveApproval(
  store: WorkbenchApprovalStore,
  decision: WorkbenchApprovalDecision,
  nowIso: string
): { resolved: true } | { resolved: false; reason: string } {
  const validation = validateApprovalDecision(decision)
  if (!validation.valid) return { resolved: false, reason: `invalid_decision: ${validation.errors.join(', ')}` }
  const request = store.requests.get(decision.requestId)
  if (!request) return { resolved: false, reason: 'request_not_found' }
  if (request.state !== 'pending') return { resolved: false, reason: `request_not_pending: ${request.state}` }
  if (decision.decidedOnDeviceId !== request.targetDeviceId) return { resolved: false, reason: 'decision_not_target_device' }
  if (decision.decidedOnDeviceId === request.originDeviceId) return { resolved: false, reason: 'cannot_self_approve' }
  const now = new Date(nowIso).getTime()
  const expiresAt = new Date(request.expiresAt).getTime()
  const decidedAt = new Date(decision.decidedAt).getTime()
  if (isNaN(now) || isNaN(expiresAt) || isNaN(decidedAt)) return { resolved: false, reason: 'invalid_timestamp' }
  if (now >= expiresAt || decidedAt >= expiresAt) {
    store.requests.set(request.requestId, { ...request, state: 'expired' })
    return { resolved: false, reason: 'request_expired' }
  }
  store.requests.set(request.requestId, { ...request, state: decision.state })
  store.decisions.set(decision.requestId, decision)
  return { resolved: true }
}

export function withdrawApproval(
  store: WorkbenchApprovalStore,
  requestId: string,
  originDeviceId: string
): { withdrawn: true } | { withdrawn: false; reason: string } {
  const request = store.requests.get(requestId)
  if (!request) return { withdrawn: false, reason: 'request_not_found' }
  if (request.originDeviceId !== originDeviceId) return { withdrawn: false, reason: 'not_request_originator' }
  if (request.state !== 'pending') return { withdrawn: false, reason: `cannot_withdraw_${request.state}_request` }
  store.requests.set(requestId, { ...request, state: 'withdrawn' })
  return { withdrawn: true }
}

export function checkApprovalExpiry(
  store: WorkbenchApprovalStore,
  nowIso: string
): { expiredCount: number } {
  const now = new Date(nowIso).getTime()
  if (isNaN(now)) return { expiredCount: 0 }
  let expiredCount = 0
  for (const [id, request] of store.requests) {
    if (request.state !== 'pending') continue
    const expiresAt = new Date(request.expiresAt).getTime()
    if (!isNaN(expiresAt) && now >= expiresAt) {
      store.requests.set(id, { ...request, state: 'expired' })
      expiredCount++
    }
  }
  return { expiredCount }
}

export function listPendingApprovals(
  store: WorkbenchApprovalStore,
  targetDeviceId: string
): WorkbenchApprovalRequest[] {
  return [...store.requests.values()].filter(r => r.state === 'pending' && r.targetDeviceId === targetDeviceId)
}
