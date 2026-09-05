import {
  AUTONOMY_PERMISSION_CATEGORIES,
  AUTONOMY_POLICIES,
  decideAutonomyGrant,
  getAutonomyPolicy,
  type AutonomyPermissionCategory,
  type AutonomyPolicy
} from './autonomy-policy'
import {
  AUTONOMY_DECISION_POLICY_VERSION,
  createAutonomyPolicyBinding,
  type AutonomyPolicyBinding,
  type PersistedAutonomyDecisionValue
} from './autonomy-decision'

export const AUTONOMY_DECISIONS = ['allowed', 'denied', 'requires_confirmation'] as const
export type AutonomyDecision = typeof AUTONOMY_DECISIONS[number]
export type AutonomyPolicyLayerName = 'source' | 'run' | 'session' | 'capability'
export type AutonomyReasonCode =
  | 'SOURCE_DENIED' | 'RUN_RESTRICTED' | 'SESSION_RESTRICTED'
  | 'CAPABILITY_NOT_GRANTED' | 'CONFIRMATION_REQUIRED'
  | 'CONFIRMATION_DENIED' | 'PROTECTED_PATH' | 'NETWORK_NOT_GRANTED'
  | 'RELEASE_NOT_GRANTED' | 'UNKNOWN_OPERATION' | 'MALFORMED_POLICY'
  | 'SCOPE_EMPTY' | 'LEVEL_NOT_GRANTED' | 'POLICY_ALLOWED'
  | 'PERSISTED_APPROVAL_REUSED' | 'PERSISTED_DENIAL' | 'PERSISTED_POLICY_CHANGED'

export type AutonomyScope = Readonly<{
  path?: string
  command?: string
  networkTarget?: string
  capabilityId?: string
  gitOperation?: string
  releaseTarget?: string
}>

export type AutonomyPolicyGrant = Readonly<{
  allowed: readonly string[]
  confirmationRequired?: readonly string[]
  denied?: readonly string[]
  allowedPaths?: readonly string[]
  allowedCommands?: readonly string[]
  allowedNetworkTargets?: readonly string[]
  allowedCapabilities?: readonly string[]
  allowedGitOperations?: readonly string[]
  allowedReleaseTargets?: readonly string[]
}>

export type AutonomyPolicyLayer = Readonly<{
  name: AutonomyPolicyLayerName
  grants: Readonly<Partial<Record<AutonomyPermissionCategory, AutonomyPolicyGrant>>>
}>

export type AutonomyConfirmationPolicy = Readonly<{
  state: 'not_required' | 'confirmed' | 'missing' | 'denied'
  operations?: readonly string[]
  persistedDecision?: PersistedAutonomyDecisionValue
}>

export type AutonomyPolicyEvaluationInput = Readonly<{
  level: unknown
  category: unknown
  operation: unknown
  source: unknown
  run: unknown
  session: unknown
  capability: unknown
  confirmation: unknown
  scope?: AutonomyScope
}>

export type AutonomyPolicyTraceEntry = Readonly<{
  layer: string
  decision: AutonomyDecision
  reasonCode: AutonomyReasonCode
}>

export type AutonomyPolicyEvaluation = Readonly<{
  decision: AutonomyDecision
  category: AutonomyPermissionCategory | null
  operation: string | null
  restrictingScope: string | null
  reasonCode: AutonomyReasonCode
  confirmationRequired: boolean
  trace: readonly AutonomyPolicyTraceEntry[]
  effectiveScope: Readonly<{
    paths: readonly string[]
    commands: readonly string[]
    networkTargets: readonly string[]
    capabilities: readonly string[]
    gitOperations: readonly string[]
    releaseTargets: readonly string[]
  }>
}>

const categories = new Set<string>(AUTONOMY_PERMISSION_CATEGORIES)
const layerNames: readonly AutonomyPolicyLayerName[] = ['source', 'run', 'session', 'capability']
const knownOperations = new Set(AUTONOMY_PERMISSION_CATEGORIES.flatMap(category => AUTONOMY_POLICIES.flatMap(policy => {
  const grant = policy.grants[category]
  return [...grant.allowed, ...grant.confirmationRequired, ...grant.denied].filter(operation => operation !== '*')
})))
const reasonForLayer: Record<AutonomyPolicyLayerName, AutonomyReasonCode> = {
  source: 'SOURCE_DENIED', run: 'RUN_RESTRICTED', session: 'SESSION_RESTRICTED', capability: 'CAPABILITY_NOT_GRANTED'
}
const emptyScope = (): AutonomyPolicyEvaluation['effectiveScope'] => ({ paths: [], commands: [], networkTargets: [], capabilities: [], gitOperations: [], releaseTargets: [] })
const malformed = (category: AutonomyPermissionCategory | null, operation: string | null): AutonomyPolicyEvaluation => ({
  decision: 'denied', category, operation, restrictingScope: null, reasonCode: 'MALFORMED_POLICY', confirmationRequired: false,
  trace: [{ layer: 'input', decision: 'denied', reasonCode: 'MALFORMED_POLICY' }], effectiveScope: emptyScope()
})

function isGrant(value: unknown): value is AutonomyPolicyGrant {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const grant = value as Partial<AutonomyPolicyGrant>
  return Array.isArray(grant.allowed)
    && (grant.confirmationRequired === undefined || Array.isArray(grant.confirmationRequired))
    && (grant.denied === undefined || Array.isArray(grant.denied))
    && ['allowedPaths', 'allowedCommands', 'allowedNetworkTargets', 'allowedCapabilities', 'allowedGitOperations', 'allowedReleaseTargets']
      .every(key => (grant as Record<string, unknown>)[key] === undefined || Array.isArray((grant as Record<string, unknown>)[key]))
}

function isLayer(value: unknown, expected: AutonomyPolicyLayerName): value is AutonomyPolicyLayer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const layer = value as Partial<AutonomyPolicyLayer>
  if (layer.name !== expected || !layer.grants || typeof layer.grants !== 'object' || Array.isArray(layer.grants)) return false
  return Object.entries(layer.grants).every(([category, grant]) => categories.has(category) && isGrant(grant))
}

function isConfirmation(value: unknown): value is AutonomyConfirmationPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const confirmation = value as Partial<AutonomyConfirmationPolicy>
  return ['not_required', 'confirmed', 'missing', 'denied'].includes(String(confirmation.state))
    && (confirmation.operations === undefined || Array.isArray(confirmation.operations))
    && (confirmation.persistedDecision === undefined || ['APPROVED', 'DENIED'].includes(confirmation.persistedDecision))
}

function prefixOrEqual(parent: string, child: string): boolean { return parent === child || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`) }
function intersectLists(lists: readonly (readonly string[] | undefined)[]): string[] {
  const present = lists.filter((list): list is readonly string[] => Array.isArray(list))
  if (present.length === 0) return []
  let result = [...present[0]]
  for (const next of present.slice(1)) {
    result = result.flatMap(left => next.flatMap(right => left === right ? [left] : prefixOrEqual(left, right) ? [right] : prefixOrEqual(right, left) ? [left] : []))
  }
  return [...new Set(result)].sort()
}

function scopeValues(grants: readonly AutonomyPolicyGrant[], field: keyof AutonomyPolicyGrant): string[] {
  return intersectLists(grants.map(grant => grant[field] as readonly string[] | undefined))
}

function policyLayerFromLevel(policy: AutonomyPolicy): AutonomyPolicyLayer {
  return { name: 'source', grants: policy.grants }
}

export function evaluateAutonomyPolicy(input: AutonomyPolicyEvaluationInput): AutonomyPolicyEvaluation {
  const category = typeof input.category === 'string' && categories.has(input.category) ? input.category as AutonomyPermissionCategory : null
  const operation = typeof input.operation === 'string' && input.operation.length > 0 ? input.operation : null
  if (!category || !operation || !isConfirmation(input.confirmation)) return malformed(category, operation)
  if (!knownOperations.has(operation)) return { ...malformed(category, operation), reasonCode: 'UNKNOWN_OPERATION', trace: [{ layer: 'operation', decision: 'denied', reasonCode: 'UNKNOWN_OPERATION' }] }
  const levelPolicy = getAutonomyPolicy(input.level)
  if (!levelPolicy) return { ...malformed(category, operation), reasonCode: 'LEVEL_NOT_GRANTED', trace: [{ layer: 'level', decision: 'denied', reasonCode: 'LEVEL_NOT_GRANTED' }] }
  const layers: AutonomyPolicyLayer[] = [policyLayerFromLevel(levelPolicy)]
  for (const name of layerNames) {
    if (!isLayer(input[name], name)) return { ...malformed(category, operation), reasonCode: 'MALFORMED_POLICY', trace: [{ layer: name, decision: 'denied', reasonCode: 'MALFORMED_POLICY' }] }
    layers.push(input[name] as AutonomyPolicyLayer)
  }

  const trace: AutonomyPolicyTraceEntry[] = []
  const grants: AutonomyPolicyGrant[] = []
  for (const layer of layers) {
    const grant = layer.grants[category]
    if (!grant) {
      const reasonCode = layer.name === 'source' && layer === layers[0] ? 'LEVEL_NOT_GRANTED' : reasonForLayer[layer.name]
      const traceEntry = { layer: layer.name === 'source' && layer === layers[0] ? 'level' : layer.name, decision: 'denied' as const, reasonCode }
      trace.push(traceEntry)
      return { decision: 'denied', category, operation, restrictingScope: traceEntry.layer, reasonCode, confirmationRequired: false, trace, effectiveScope: emptyScope() }
    }
    // An explicit denial is always restrictive; R16.1's '*' marker only
    // supplies default denial for operations absent from allowed lists.
    if (grant.denied?.includes(operation)) {
      const reasonCode = layer.name === 'source' && layer === layers[0] ? 'LEVEL_NOT_GRANTED' : reasonForLayer[layer.name]
      trace.push({ layer: layer.name === 'source' && layer === layers[0] ? 'level' : layer.name, decision: 'denied', reasonCode })
      return { decision: 'denied', category, operation, restrictingScope: layer.name, reasonCode, confirmationRequired: false, trace, effectiveScope: emptyScope() }
    }
    const decision = decideAutonomyGrant({ grants: { [category]: grant } }, category, operation)
    if (decision === 'denied') {
      const reasonCode = layer.name === 'source' && layer === layers[0] ? 'LEVEL_NOT_GRANTED' : reasonForLayer[layer.name]
      trace.push({ layer: layer.name === 'source' && layer === layers[0] ? 'level' : layer.name, decision: 'denied', reasonCode })
      return { decision: 'denied', category, operation, restrictingScope: layer.name, reasonCode, confirmationRequired: false, trace, effectiveScope: emptyScope() }
    }
    grants.push(grant)
    trace.push({ layer: layer.name === 'source' && layer === layers[0] ? 'level' : layer.name, decision: 'allowed', reasonCode: 'POLICY_ALLOWED' })
  }

  const fields: Array<[keyof AutonomyPolicyGrant, keyof ReturnType<typeof emptyScope>, keyof AutonomyScope]> = [
    ['allowedPaths', 'paths', 'path'], ['allowedCommands', 'commands', 'command'], ['allowedNetworkTargets', 'networkTargets', 'networkTarget'],
    ['allowedCapabilities', 'capabilities', 'capabilityId'], ['allowedGitOperations', 'gitOperations', 'gitOperation'], ['allowedReleaseTargets', 'releaseTargets', 'releaseTarget']
  ]
  const effectiveScope = { paths: [] as string[], commands: [] as string[], networkTargets: [] as string[], capabilities: [] as string[], gitOperations: [] as string[], releaseTargets: [] as string[] }
  for (const [grantField, outputField, requestField] of fields) {
    const values = scopeValues(grants, grantField)
    effectiveScope[outputField] = values
    const requested = input.scope?.[requestField]
    if (requested && values.length > 0 && !values.some(value => prefixOrEqual(value, requested))) {
      const reasonCode = category === 'network' ? 'NETWORK_NOT_GRANTED' : category === 'release' ? 'RELEASE_NOT_GRANTED' : 'SCOPE_EMPTY'
      trace.push({ layer: 'scope', decision: 'denied', reasonCode })
      return { decision: 'denied', category, operation, restrictingScope: 'scope', reasonCode, confirmationRequired: false, trace, effectiveScope }
    }
  }

  const confirmationRequired = grants.some(grant => grant.confirmationRequired?.includes(operation))
  if (confirmationRequired) {
    if (input.confirmation.persistedDecision === 'DENIED') {
      trace.push({ layer: 'confirmation', decision: 'denied', reasonCode: 'PERSISTED_DENIAL' })
      return { decision: 'denied', category, operation, restrictingScope: 'confirmation', reasonCode: 'PERSISTED_DENIAL', confirmationRequired: true, trace, effectiveScope }
    }
    if (input.confirmation.state === 'denied') {
      trace.push({ layer: 'confirmation', decision: 'denied', reasonCode: 'CONFIRMATION_DENIED' })
      return { decision: 'denied', category, operation, restrictingScope: 'confirmation', reasonCode: 'CONFIRMATION_DENIED', confirmationRequired: true, trace, effectiveScope }
    }
    if (input.confirmation.persistedDecision === 'APPROVED') {
      if (input.confirmation.operations && !input.confirmation.operations.includes(operation)) {
        trace.push({ layer: 'confirmation', decision: 'denied', reasonCode: 'CONFIRMATION_DENIED' })
        return { decision: 'denied', category, operation, restrictingScope: 'confirmation', reasonCode: 'CONFIRMATION_DENIED', confirmationRequired: true, trace, effectiveScope }
      }
      trace.push({ layer: 'confirmation', decision: 'allowed', reasonCode: 'PERSISTED_APPROVAL_REUSED' })
      return { decision: 'allowed', category, operation, restrictingScope: null, reasonCode: 'PERSISTED_APPROVAL_REUSED', confirmationRequired: true, trace, effectiveScope }
    }
    if (input.confirmation.state !== 'confirmed') {
      trace.push({ layer: 'confirmation', decision: 'requires_confirmation', reasonCode: 'CONFIRMATION_REQUIRED' })
      return { decision: 'requires_confirmation', category, operation, restrictingScope: 'confirmation', reasonCode: 'CONFIRMATION_REQUIRED', confirmationRequired: true, trace, effectiveScope }
    }
    if (input.confirmation.operations && !input.confirmation.operations.includes(operation)) {
      trace.push({ layer: 'confirmation', decision: 'denied', reasonCode: 'CONFIRMATION_DENIED' })
      return { decision: 'denied', category, operation, restrictingScope: 'confirmation', reasonCode: 'CONFIRMATION_DENIED', confirmationRequired: true, trace, effectiveScope }
    }
  }
  trace.push({ layer: 'confirmation', decision: 'allowed', reasonCode: 'POLICY_ALLOWED' })
  return { decision: 'allowed', category, operation, restrictingScope: null, reasonCode: 'POLICY_ALLOWED', confirmationRequired, trace, effectiveScope }
}

/**
 * Fingerprint the current R16.2 policy input without confirmation state. A
 * persisted decision is therefore reusable only while the complete policy
 * context remains byte-for-byte equivalent.
 */
export function fingerprintAutonomyPolicyInput(input: AutonomyPolicyEvaluationInput): AutonomyPolicyBinding {
  return createAutonomyPolicyBinding(AUTONOMY_DECISION_POLICY_VERSION, {
    level: input.level,
    category: input.category,
    operation: input.operation,
    source: input.source,
    run: input.run,
    session: input.session,
    capability: input.capability,
    scope: input.scope || null
  })
}
