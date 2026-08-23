import { Ajv, type ValidateFunction } from 'ajv'

export const WORKBENCH_DISPATCH_CONTRACT_VERSION = '1' as const
export const WORKBENCH_DISPATCH_REQUEST_KIND = 'workbench.dispatch.request' as const
export const WORKBENCH_DISPATCH_DECISION_KIND = 'workbench.dispatch.decision' as const
export const WORKBENCH_RUN_AFFINITY_KIND = 'workbench.run.affinity' as const

export const WORKBENCH_ROUTING_MODE_VALUES = ['automatic', 'preferred_device', 'pinned'] as const
export type WorkbenchRoutingMode = typeof WORKBENCH_ROUTING_MODE_VALUES[number]

export const WORKBENCH_DISPATCH_OUTCOME_VALUES = ['admitted', 'rejected', 'deferred'] as const
export type WorkbenchDispatchOutcome = typeof WORKBENCH_DISPATCH_OUTCOME_VALUES[number]

export type WorkbenchSourceIdentityProof = {
  sourceId: string
  deviceId: string
  expectedHead: string
  sourceFingerprint: string
  provenAt: string
}

export type WorkbenchDispatchRequest = {
  kind: typeof WORKBENCH_DISPATCH_REQUEST_KIND
  contractVersion: typeof WORKBENCH_DISPATCH_CONTRACT_VERSION
  requestId: string
  packetId: string
  runId: string
  sourceId: string
  routingMode: WorkbenchRoutingMode
  mutation: boolean
  requiredCapabilities: string[]
  preferredDeviceId?: string
  pinnedDeviceId?: string
  requestedAt: string
}

export type WorkbenchRoutingDecision = {
  kind: typeof WORKBENCH_DISPATCH_DECISION_KIND
  contractVersion: typeof WORKBENCH_DISPATCH_CONTRACT_VERSION
  requestId: string
  outcome: WorkbenchDispatchOutcome
  selectedDeviceId?: string
  reason: string
  affinityKey?: string
  decidedAt: string
}

export type WorkbenchRunAffinity = {
  kind: typeof WORKBENCH_RUN_AFFINITY_KIND
  contractVersion: typeof WORKBENCH_DISPATCH_CONTRACT_VERSION
  runId: string
  deviceId: string
  sourceId: string
  routingMode: WorkbenchRoutingMode
  assignedAt: string
  stickyUntil?: string
}

type JsonSchema = Record<string, unknown>
const boundedString = (maxLength: number): JsonSchema => ({ type: 'string', minLength: 1, maxLength })

export const WORKBENCH_DISPATCH_REQUEST_SCHEMA: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Workbench Dispatch Request',
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'contractVersion', 'requestId', 'packetId', 'runId', 'sourceId', 'routingMode', 'mutation', 'requiredCapabilities', 'requestedAt'],
  properties: {
    kind: { const: WORKBENCH_DISPATCH_REQUEST_KIND },
    contractVersion: { const: WORKBENCH_DISPATCH_CONTRACT_VERSION },
    requestId: boundedString(128),
    packetId: boundedString(128),
    runId: boundedString(128),
    sourceId: boundedString(128),
    routingMode: { enum: [...WORKBENCH_ROUTING_MODE_VALUES] },
    mutation: { type: 'boolean' },
    requiredCapabilities: { type: 'array', items: { type: 'string', maxLength: 128 } },
    preferredDeviceId: boundedString(128),
    pinnedDeviceId: boundedString(128),
    requestedAt: boundedString(64)
  }
}

export const WORKBENCH_ROUTING_DECISION_SCHEMA: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Workbench Routing Decision',
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'contractVersion', 'requestId', 'outcome', 'reason', 'decidedAt'],
  properties: {
    kind: { const: WORKBENCH_DISPATCH_DECISION_KIND },
    contractVersion: { const: WORKBENCH_DISPATCH_CONTRACT_VERSION },
    requestId: boundedString(128),
    outcome: { enum: [...WORKBENCH_DISPATCH_OUTCOME_VALUES] },
    selectedDeviceId: boundedString(128),
    reason: boundedString(512),
    affinityKey: boundedString(256),
    decidedAt: boundedString(64)
  }
}

let dispatchRequestValidator: ValidateFunction | undefined
let routingDecisionValidator: ValidateFunction | undefined

function getDispatchRequestValidator(): ValidateFunction {
  if (!dispatchRequestValidator) {
    const ajv = new Ajv({ strict: false, allErrors: true })
    dispatchRequestValidator = ajv.compile(WORKBENCH_DISPATCH_REQUEST_SCHEMA)
  }
  return dispatchRequestValidator
}

function getRoutingDecisionValidator(): ValidateFunction {
  if (!routingDecisionValidator) {
    const ajv = new Ajv({ strict: false, allErrors: true })
    routingDecisionValidator = ajv.compile(WORKBENCH_ROUTING_DECISION_SCHEMA)
  }
  return routingDecisionValidator
}

export function validateDispatchRequest(
  input: unknown
): { valid: true; request: WorkbenchDispatchRequest } | { valid: false; errors: string[] } {
  const validate = getDispatchRequestValidator()
  if (validate(input)) return { valid: true, request: input as WorkbenchDispatchRequest }
  return { valid: false, errors: (validate.errors ?? []).map(e => `${e.instancePath} ${e.message ?? ''}`.trim()) }
}

export function validateRoutingDecision(
  input: unknown
): { valid: true; decision: WorkbenchRoutingDecision } | { valid: false; errors: string[] } {
  const validate = getRoutingDecisionValidator()
  if (validate(input)) return { valid: true, decision: input as WorkbenchRoutingDecision }
  return { valid: false, errors: (validate.errors ?? []).map(e => `${e.instancePath} ${e.message ?? ''}`.trim()) }
}

export type WorkbenchDispatchState = {
  requests: Map<string, WorkbenchDispatchRequest>
  decisions: Map<string, WorkbenchRoutingDecision>
  affinities: Map<string, WorkbenchRunAffinity>
}

export function createDispatchState(): WorkbenchDispatchState {
  return { requests: new Map(), decisions: new Map(), affinities: new Map() }
}

export type WorkbenchDeviceInfo = {
  deviceId: string
  state: string
  capacity: { availableSlots: number; queueDepth: number; cpuPressure: string }
  enabledSourceFingerprints: string[]
  capabilities: string[]
}

export function routeRequest(
  state: WorkbenchDispatchState,
  request: WorkbenchDispatchRequest,
  eligibleDevices: WorkbenchDeviceInfo[],
  sourceProofs: WorkbenchSourceIdentityProof[],
  timestamp: string
): WorkbenchRoutingDecision {
  const validation = validateDispatchRequest(request)
  if (!validation.valid) {
    const decision: WorkbenchRoutingDecision = {
      kind: WORKBENCH_DISPATCH_DECISION_KIND,
      contractVersion: WORKBENCH_DISPATCH_CONTRACT_VERSION,
      requestId: (request as { requestId?: string }).requestId ?? 'unknown',
      outcome: 'rejected',
      reason: `invalid_request: ${validation.errors.join(', ')}`,
      decidedAt: timestamp
    }
    state.decisions.set(decision.requestId, decision)
    return decision
  }

  if (request.routingMode === 'pinned' && !request.pinnedDeviceId) {
    const decision: WorkbenchRoutingDecision = {
      kind: WORKBENCH_DISPATCH_DECISION_KIND,
      contractVersion: WORKBENCH_DISPATCH_CONTRACT_VERSION,
      requestId: request.requestId,
      outcome: 'rejected',
      reason: 'pinned_device_required',
      decidedAt: timestamp
    }
    state.decisions.set(decision.requestId, decision)
    return decision
  }

  state.requests.set(request.requestId, request)

  const validProofs = sourceProofs.filter(proof => {
    if (proof.sourceId !== request.sourceId) return false
    if (!verifySourceIdentityProof(proof).verified) return false
    const device = eligibleDevices.find(candidate => candidate.deviceId === proof.deviceId)
    return device?.enabledSourceFingerprints.includes(proof.sourceFingerprint) ?? false
  })
  const provenSourceIds = new Set(validProofs.map(proof => proof.deviceId))

  const existingAffinity = state.affinities.get(request.runId)
  if (existingAffinity) {
    const stickyDevice = eligibleDevices.find(d => d.deviceId === existingAffinity.deviceId)
    const sourceMatches = existingAffinity.sourceId === request.sourceId
    const mutationProofMatches = !request.mutation || provenSourceIds.has(existingAffinity.deviceId)
    if (stickyDevice && sourceMatches && mutationProofMatches && stickyDevice.state !== 'revoked' && stickyDevice.state !== 'offline' && stickyDevice.capacity.availableSlots > 0) {
      const decision: WorkbenchRoutingDecision = {
        kind: WORKBENCH_DISPATCH_DECISION_KIND,
        contractVersion: WORKBENCH_DISPATCH_CONTRACT_VERSION,
        requestId: request.requestId,
        outcome: 'admitted',
        selectedDeviceId: existingAffinity.deviceId,
        reason: 'sticky_affinity',
        affinityKey: `${request.runId}:${existingAffinity.deviceId}`,
        decidedAt: timestamp
      }
      state.decisions.set(request.requestId, decision)
      return decision
    }
  }

  if (request.routingMode === 'pinned' && request.pinnedDeviceId) {
    const pinned = eligibleDevices.find(d => d.deviceId === request.pinnedDeviceId)
    if (!pinned || pinned.state === 'revoked' || pinned.state === 'offline') {
      const decision: WorkbenchRoutingDecision = {
        kind: WORKBENCH_DISPATCH_DECISION_KIND,
        contractVersion: WORKBENCH_DISPATCH_CONTRACT_VERSION,
        requestId: request.requestId,
        outcome: 'deferred',
        reason: 'pinned_device_unavailable',
        decidedAt: timestamp
      }
      state.decisions.set(request.requestId, decision)
      return decision
    }
  }

  const candidates = eligibleDevices.filter(d => {
    if (d.state === 'revoked' || d.state === 'offline') return false
    if (d.capacity.availableSlots <= 0) return false
    if (request.mutation && !provenSourceIds.has(d.deviceId)) return false
    for (const cap of request.requiredCapabilities) {
      if (!d.capabilities.includes(cap)) return false
    }
    if (request.routingMode === 'pinned' && request.pinnedDeviceId) {
      return d.deviceId === request.pinnedDeviceId
    }
    if (request.routingMode === 'preferred_device' && request.preferredDeviceId) {
      return d.deviceId === request.preferredDeviceId || d.capacity.availableSlots > 0
    }
    return true
  })

  if (candidates.length === 0) {
    const decision: WorkbenchRoutingDecision = {
      kind: WORKBENCH_DISPATCH_DECISION_KIND,
      contractVersion: WORKBENCH_DISPATCH_CONTRACT_VERSION,
      requestId: request.requestId,
      outcome: 'rejected',
      reason: request.mutation ? 'no_device_with_proven_source_identity' : 'no_eligible_device',
      decidedAt: timestamp
    }
    state.decisions.set(request.requestId, decision)
    return decision
  }

  const preferred = request.routingMode === 'preferred_device' && request.preferredDeviceId
    ? candidates.find(d => d.deviceId === request.preferredDeviceId) ?? candidates[0]
    : candidates.sort((a, b) => a.capacity.queueDepth - b.capacity.queueDepth)[0]

  const affinityKey = `${request.runId}:${preferred.deviceId}`
  state.affinities.set(request.runId, {
    kind: WORKBENCH_RUN_AFFINITY_KIND,
    contractVersion: WORKBENCH_DISPATCH_CONTRACT_VERSION,
    runId: request.runId,
    deviceId: preferred.deviceId,
    sourceId: request.sourceId,
    routingMode: request.routingMode,
    assignedAt: timestamp
  })

  const decision: WorkbenchRoutingDecision = {
    kind: WORKBENCH_DISPATCH_DECISION_KIND,
    contractVersion: WORKBENCH_DISPATCH_CONTRACT_VERSION,
    requestId: request.requestId,
    outcome: 'admitted',
    selectedDeviceId: preferred.deviceId,
    reason: 'selected_by_capacity',
    affinityKey,
    decidedAt: timestamp
  }
  state.decisions.set(request.requestId, decision)
  return decision
}

export function clearAffinity(
  state: WorkbenchDispatchState,
  runId: string
): { cleared: true } | { cleared: false; reason: string } {
  if (!state.affinities.has(runId)) return { cleared: false, reason: 'affinity_not_found' }
  state.affinities.delete(runId)
  return { cleared: true }
}

export function verifySourceIdentityProof(
  proof: WorkbenchSourceIdentityProof
): { verified: boolean; reason: string } {
  if (!proof.sourceId || !proof.deviceId) return { verified: false, reason: 'missing_required_fields' }
  if (!proof.expectedHead || proof.expectedHead.length < 7) return { verified: false, reason: 'invalid_head_reference' }
  if (!proof.sourceFingerprint) return { verified: false, reason: 'missing_source_fingerprint' }
  if (!proof.provenAt) return { verified: false, reason: 'missing_proven_at' }
  return { verified: true, reason: 'proof_accepted' }
}
