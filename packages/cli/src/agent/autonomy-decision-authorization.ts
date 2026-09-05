import {
  evaluateAutonomyPolicy,
  fingerprintAutonomyPolicyInput,
  type AutonomyPermissionCategory,
  type AutonomyPolicyEvaluation,
  type AutonomyPolicyEvaluationInput,
  type AutonomyPolicyLayer
} from '@workbench/shared'
import { createAutonomyDecisionRequest, type AutonomyDecisionRequest } from '@workbench/shared'
import { lookupAutonomyDecision, type AutonomyDecisionLookup, type AutonomyDecisionStoreOptions } from './autonomy-decision-store'

export type AutonomyDecisionAuthorizationInput = {
  operation: string
  category: AutonomyPermissionCategory
  sourceId: string
  runId: string
  sessionId: string
  actorId?: string
  capabilityId?: string
  paths?: readonly string[]
  arguments?: unknown
  storeOptions?: AutonomyDecisionStoreOptions
}

export type AutonomyDecisionAuthorization = {
  status: 'allowed' | 'denied' | 'requires_confirmation' | 'unavailable'
  request?: AutonomyDecisionRequest
  evaluation?: AutonomyPolicyEvaluation
  lookup?: AutonomyDecisionLookup
  reasonCode?: string
  message?: string
}

/** Bind local decisions to the existing OS owner identity; no new account or
 * credential system is introduced. Callers with a stronger existing actor ID
 * should pass it explicitly. */
export function resolveWorkbenchActorId(explicit?: string): string | undefined {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim()
  if (typeof process.getuid === 'function') {
    const uid = process.getuid()
    if (Number.isInteger(uid) && uid >= 0) return `os-user:${uid}`
  }
  return undefined
}

function layer(name: AutonomyPolicyLayer['name'], category: AutonomyPermissionCategory, operation: string, paths: readonly string[]): AutonomyPolicyLayer {
  return {
    name,
    grants: {
      [category]: {
        allowed: [],
        confirmationRequired: [operation],
        denied: [],
        ...(paths.length > 0 ? { allowedPaths: [...paths] } : {})
      }
    }
  }
}

function buildPolicyInput(input: AutonomyDecisionAuthorizationInput): AutonomyPolicyEvaluationInput {
  const paths = input.paths || []
  return {
    // Runtime mutation guards remain authoritative. Level 6 here represents
    // the existing release/operator row while the four child layers narrow it
    // to this exact operation and path set.
    level: 6,
    category: input.category,
    operation: input.operation,
    source: layer('source', input.category, input.operation, paths),
    run: layer('run', input.category, input.operation, paths),
    session: layer('session', input.category, input.operation, paths),
    capability: layer('capability', input.category, input.operation, paths),
    scope: paths.length === 1 ? { path: paths[0] } : undefined,
    confirmation: { state: 'missing' }
  }
}

/**
 * R18.4 adapters must hand the same policy context to the MCP runtime that
 * produced the persisted R16.3 decision. Keep this builder canonical instead
 * of allowing each write-capable caller to invent a policy shape.
 */
export function buildAutonomyDecisionPolicyInput(input: AutonomyDecisionAuthorizationInput): AutonomyPolicyEvaluationInput {
  return buildPolicyInput(input)
}

export function prepareAutonomyDecisionAuthorization(input: AutonomyDecisionAuthorizationInput): AutonomyDecisionAuthorization {
  const actorId = resolveWorkbenchActorId(input.actorId)
  const capabilityId = input.capabilityId || 'workbench-core'
  if (!actorId) return { status: 'unavailable', reasonCode: 'ACTOR_ID_UNAVAILABLE', message: 'An existing actor identity is required for persisted autonomy decisions.' }

  let policyInput: AutonomyPolicyEvaluationInput
  let request: AutonomyDecisionRequest
  try {
    policyInput = buildPolicyInput(input)
    const policy = fingerprintAutonomyPolicyInput(policyInput)
    request = createAutonomyDecisionRequest({
      operation: input.operation,
      category: input.category,
      sourceId: input.sourceId,
      runId: input.runId,
      sessionId: input.sessionId,
      actorId,
      capabilityId,
      paths: input.paths,
      arguments: input.arguments,
      policy
    })
  } catch (error) {
    return { status: 'unavailable', reasonCode: 'REQUEST_INVALID', message: error instanceof Error ? error.message : 'Autonomy decision request is invalid.' }
  }

  const baseline = evaluateAutonomyPolicy(policyInput)
  if (baseline.decision === 'denied') return { status: 'denied', request, evaluation: baseline, reasonCode: baseline.reasonCode, message: 'The current autonomy policy denies this exact operation.' }
  if (!baseline.confirmationRequired) return { status: 'allowed', request, evaluation: baseline, reasonCode: baseline.reasonCode }

  const lookup = lookupAutonomyDecision(request, input.storeOptions)
  if (lookup.ok === false) return { status: 'unavailable', request, evaluation: baseline, lookup, reasonCode: lookup.code, message: lookup.message }
  if (lookup.state === 'policy_changed') {
    const changed: AutonomyPolicyEvaluation = {
      ...baseline,
      decision: 'denied',
      restrictingScope: 'confirmation',
      reasonCode: 'PERSISTED_POLICY_CHANGED',
      trace: [...baseline.trace, { layer: 'confirmation', decision: 'denied', reasonCode: 'PERSISTED_POLICY_CHANGED' }]
    }
    return { status: 'denied', request, evaluation: changed, lookup, reasonCode: changed.reasonCode, message: 'A persisted decision was created under a different policy context.' }
  }
  if (!lookup.decision || lookup.state === 'expired') {
    return { status: 'requires_confirmation', request, evaluation: baseline, lookup, reasonCode: 'CONFIRMATION_REQUIRED', message: lookup.state === 'expired' ? 'The exact persisted decision expired and requires fresh confirmation.' : 'This exact operation requires confirmation.' }
  }

  const decision = evaluateAutonomyPolicy({
    ...policyInput,
    confirmation: { state: 'missing', persistedDecision: lookup.decision.decision }
  })
  return {
    status: decision.decision === 'allowed' ? 'allowed' : 'denied',
    request,
    evaluation: decision,
    lookup,
    reasonCode: decision.reasonCode,
    message: decision.decision === 'allowed' ? 'The exact persisted approval was reused.' : 'The exact persisted denial applies.'
  }
}
