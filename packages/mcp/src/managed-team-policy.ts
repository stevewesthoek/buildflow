import { Ajv, type ValidateFunction } from 'ajv'

export const WORKBENCH_TEAM_POLICY_CONTRACT_VERSION = '1' as const
export const WORKBENCH_TEAM_POLICY_KIND = 'workbench.team.policy' as const
export const WORKBENCH_POLICY_BINDING_KIND = 'workbench.policy.binding' as const

export const WORKBENCH_POLICY_ENFORCEMENT_VALUES = ['advisory', 'enforced'] as const
export type WorkbenchPolicyEnforcement = typeof WORKBENCH_POLICY_ENFORCEMENT_VALUES[number]

export const WORKBENCH_POLICY_SCOPE_VALUES = ['device', 'user', 'team', 'organization'] as const
export type WorkbenchPolicyScope = typeof WORKBENCH_POLICY_SCOPE_VALUES[number]

export type WorkbenchTeamPolicyRule = {
  ruleId: string
  description: string
  enforcement: WorkbenchPolicyEnforcement
  scope: WorkbenchPolicyScope
  maxAutonomyLevel: number
  requireApprovalForScopes: string[]
  deniedCapabilities: string[]
  requiredEvidence: string[]
}

export type WorkbenchTeamPolicy = {
  kind: typeof WORKBENCH_TEAM_POLICY_KIND
  contractVersion: typeof WORKBENCH_TEAM_POLICY_CONTRACT_VERSION
  policyId: string
  teamId: string
  version: number
  optInRequired: boolean
  rules: WorkbenchTeamPolicyRule[]
  createdAt: string
  updatedAt: string
}

export type WorkbenchPolicyBinding = {
  kind: typeof WORKBENCH_POLICY_BINDING_KIND
  contractVersion: typeof WORKBENCH_TEAM_POLICY_CONTRACT_VERSION
  bindingId: string
  policyId: string
  deviceId: string
  userId: string
  optedInAt: string
  active: boolean
}

export type WorkbenchPolicyEvaluation = {
  permitted: boolean
  enforcement: WorkbenchPolicyEnforcement
  violations: string[]
  advisories: string[]
}

type JsonSchema = Record<string, unknown>
const boundedString = (maxLength: number): JsonSchema => ({ type: 'string', minLength: 1, maxLength })

export const WORKBENCH_TEAM_POLICY_SCHEMA: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Workbench Team Policy',
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'contractVersion', 'policyId', 'teamId', 'version', 'optInRequired', 'rules', 'createdAt', 'updatedAt'],
  properties: {
    kind: { const: WORKBENCH_TEAM_POLICY_KIND },
    contractVersion: { const: WORKBENCH_TEAM_POLICY_CONTRACT_VERSION },
    policyId: boundedString(128),
    teamId: boundedString(128),
    version: { type: 'integer', minimum: 1 },
    optInRequired: { type: 'boolean' },
    rules: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ruleId', 'description', 'enforcement', 'scope', 'maxAutonomyLevel', 'requireApprovalForScopes', 'deniedCapabilities', 'requiredEvidence'],
        properties: {
          ruleId: boundedString(128),
          description: boundedString(512),
          enforcement: { enum: [...WORKBENCH_POLICY_ENFORCEMENT_VALUES] },
          scope: { enum: [...WORKBENCH_POLICY_SCOPE_VALUES] },
          maxAutonomyLevel: { type: 'integer', minimum: 0, maximum: 6 },
          requireApprovalForScopes: { type: 'array', items: { type: 'string', maxLength: 64 } },
          deniedCapabilities: { type: 'array', items: { type: 'string', maxLength: 128 } },
          requiredEvidence: { type: 'array', items: { type: 'string', maxLength: 128 } }
        }
      }
    },
    createdAt: boundedString(64),
    updatedAt: boundedString(64)
  }
}

export const WORKBENCH_POLICY_BINDING_SCHEMA: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Workbench Policy Binding',
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'contractVersion', 'bindingId', 'policyId', 'deviceId', 'userId', 'optedInAt', 'active'],
  properties: {
    kind: { const: WORKBENCH_POLICY_BINDING_KIND },
    contractVersion: { const: WORKBENCH_TEAM_POLICY_CONTRACT_VERSION },
    bindingId: boundedString(128),
    policyId: boundedString(128),
    deviceId: boundedString(128),
    userId: boundedString(128),
    optedInAt: boundedString(64),
    active: { type: 'boolean' }
  }
}

let policyValidator: ValidateFunction | undefined
let bindingValidator: ValidateFunction | undefined

function getPolicyValidator(): ValidateFunction {
  if (!policyValidator) {
    const ajv = new Ajv({ strict: false, allErrors: true })
    policyValidator = ajv.compile(WORKBENCH_TEAM_POLICY_SCHEMA)
  }
  return policyValidator
}

function getBindingValidator(): ValidateFunction {
  if (!bindingValidator) {
    const ajv = new Ajv({ strict: false, allErrors: true })
    bindingValidator = ajv.compile(WORKBENCH_POLICY_BINDING_SCHEMA)
  }
  return bindingValidator
}

export function validateTeamPolicy(
  input: unknown
): { valid: true; policy: WorkbenchTeamPolicy } | { valid: false; errors: string[] } {
  const validate = getPolicyValidator()
  if (validate(input)) return { valid: true, policy: input as WorkbenchTeamPolicy }
  return { valid: false, errors: (validate.errors ?? []).map(e => `${e.instancePath} ${e.message ?? ''}`.trim()) }
}

export function validatePolicyBinding(
  input: unknown
): { valid: true; binding: WorkbenchPolicyBinding } | { valid: false; errors: string[] } {
  const validate = getBindingValidator()
  if (validate(input)) return { valid: true, binding: input as WorkbenchPolicyBinding }
  return { valid: false, errors: (validate.errors ?? []).map(e => `${e.instancePath} ${e.message ?? ''}`.trim()) }
}

export type WorkbenchPolicyState = {
  policies: Map<string, WorkbenchTeamPolicy>
  bindings: Map<string, WorkbenchPolicyBinding>
}

export function createPolicyState(): WorkbenchPolicyState {
  return { policies: new Map(), bindings: new Map() }
}

export function registerTeamPolicy(
  state: WorkbenchPolicyState,
  policy: WorkbenchTeamPolicy
): { registered: true } | { registered: false; reason: string } {
  const validation = validateTeamPolicy(policy)
  if (!validation.valid) return { registered: false, reason: `invalid_policy: ${validation.errors.join(', ')}` }
  if (policy.rules.length === 0) return { registered: false, reason: 'policy_has_no_rules' }
  if (!policy.optInRequired) return { registered: false, reason: 'opt_in_must_be_required' }
  if (state.policies.has(policy.policyId)) return { registered: false, reason: 'policy_id_already_exists' }
  state.policies.set(policy.policyId, policy)
  return { registered: true }
}

export function bindDevice(
  state: WorkbenchPolicyState,
  binding: WorkbenchPolicyBinding
): { bound: true } | { bound: false; reason: string } {
  const validation = validatePolicyBinding(binding)
  if (!validation.valid) return { bound: false, reason: `invalid_binding: ${validation.errors.join(', ')}` }
  const policy = state.policies.get(binding.policyId)
  if (!policy) return { bound: false, reason: 'policy_not_found' }
  if (!binding.active) return { bound: false, reason: 'binding_must_be_active' }
  if (state.bindings.has(binding.bindingId)) return { bound: false, reason: 'binding_id_already_exists' }
  state.bindings.set(binding.bindingId, binding)
  return { bound: true }
}

export function unbindDevice(
  state: WorkbenchPolicyState,
  bindingId: string
): { unbound: true } | { unbound: false; reason: string } {
  const existing = state.bindings.get(bindingId)
  if (!existing) return { unbound: false, reason: 'binding_not_found' }
  if (!existing.active) return { unbound: false, reason: 'binding_already_inactive' }
  state.bindings.set(bindingId, { ...existing, active: false })
  return { unbound: true }
}

export function evaluatePolicy(
  state: WorkbenchPolicyState,
  deviceId: string,
  requestedAutonomyLevel: number,
  requestedScope: string,
  requestedCapability: string | null
): WorkbenchPolicyEvaluation {
  if (!Number.isInteger(requestedAutonomyLevel) || requestedAutonomyLevel < 0 || requestedAutonomyLevel > 6 || !requestedScope) {
    return { permitted: false, enforcement: 'enforced', violations: ['invalid_policy_request'], advisories: [] }
  }
  const activeBindings = [...state.bindings.values()].filter(b => b.active && b.deviceId === deviceId)
  if (activeBindings.length === 0) {
    return { permitted: true, enforcement: 'advisory', violations: [], advisories: [] }
  }

  const violations: string[] = []
  const advisories: string[] = []
  let enforcement: WorkbenchPolicyEnforcement = 'advisory'

  for (const binding of activeBindings) {
    const policy = state.policies.get(binding.policyId)
    if (!policy) continue
    for (const rule of policy.rules) {
      if (rule.enforcement === 'enforced') enforcement = 'enforced'
      if (requestedAutonomyLevel > rule.maxAutonomyLevel) {
        const msg = `autonomy_level_${requestedAutonomyLevel}_exceeds_max_${rule.maxAutonomyLevel}`
        if (rule.enforcement === 'enforced') violations.push(msg)
        else advisories.push(msg)
      }
      if (rule.requireApprovalForScopes.includes(requestedScope)) {
        const msg = `scope_${requestedScope}_requires_approval`
        if (rule.enforcement === 'enforced') violations.push(msg)
        else advisories.push(msg)
      }
      if (requestedCapability && rule.deniedCapabilities.includes(requestedCapability)) {
        const msg = `capability_${requestedCapability}_denied`
        if (rule.enforcement === 'enforced') violations.push(msg)
        else advisories.push(msg)
      }
    }
  }

  return { permitted: violations.length === 0, enforcement, violations, advisories }
}

export function getEffectivePolicies(
  state: WorkbenchPolicyState,
  deviceId: string
): WorkbenchTeamPolicy[] {
  const activeBindings = [...state.bindings.values()].filter(b => b.active && b.deviceId === deviceId)
  return activeBindings
    .map(b => state.policies.get(b.policyId))
    .filter((p): p is WorkbenchTeamPolicy => p !== undefined)
}
