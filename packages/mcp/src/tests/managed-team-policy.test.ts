import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateTeamPolicy,
  validatePolicyBinding,
  createPolicyState,
  registerTeamPolicy,
  bindDevice,
  unbindDevice,
  evaluatePolicy,
  getEffectivePolicies,
  WORKBENCH_TEAM_POLICY_KIND,
  WORKBENCH_POLICY_BINDING_KIND,
  WORKBENCH_TEAM_POLICY_CONTRACT_VERSION,
  type WorkbenchTeamPolicy,
  type WorkbenchPolicyBinding
} from '../managed-team-policy.js'

function makePolicy(overrides: Partial<WorkbenchTeamPolicy> = {}): WorkbenchTeamPolicy {
  return {
    kind: WORKBENCH_TEAM_POLICY_KIND,
    contractVersion: WORKBENCH_TEAM_POLICY_CONTRACT_VERSION,
    policyId: 'pol-001',
    teamId: 'team-alpha',
    version: 1,
    optInRequired: true,
    rules: [{
      ruleId: 'rule-001',
      description: 'Limit autonomy on production operations',
      enforcement: 'enforced',
      scope: 'team',
      maxAutonomyLevel: 3,
      requireApprovalForScopes: ['release', 'configuration'],
      deniedCapabilities: ['delete_device'],
      requiredEvidence: ['run_evidence']
    }],
    createdAt: '2026-08-22T10:00:00Z',
    updatedAt: '2026-08-22T10:00:00Z',
    ...overrides
  }
}

function makeBinding(overrides: Partial<WorkbenchPolicyBinding> = {}): WorkbenchPolicyBinding {
  return {
    kind: WORKBENCH_POLICY_BINDING_KIND,
    contractVersion: WORKBENCH_TEAM_POLICY_CONTRACT_VERSION,
    bindingId: 'bind-001',
    policyId: 'pol-001',
    deviceId: 'device-a',
    userId: 'user-001',
    optedInAt: '2026-08-22T10:05:00Z',
    active: true,
    ...overrides
  }
}

describe('managed-team-policy', () => {
  describe('validateTeamPolicy', () => {
    it('accepts a valid policy', () => {
      const result = validateTeamPolicy(makePolicy())
      assert.equal(result.valid, true)
    })

    it('rejects missing kind', () => {
      const { kind: _, ...rest } = makePolicy()
      const result = validateTeamPolicy(rest)
      assert.equal(result.valid, false)
    })

    it('rejects version < 1', () => {
      const result = validateTeamPolicy(makePolicy({ version: 0 }))
      assert.equal(result.valid, false)
    })

    it('rejects unknown enforcement in rules', () => {
      const result = validateTeamPolicy(makePolicy({
        rules: [{ ...makePolicy().rules[0], enforcement: 'mandatory' as never }]
      }))
      assert.equal(result.valid, false)
    })
  })

  describe('validatePolicyBinding', () => {
    it('accepts a valid binding', () => {
      const result = validatePolicyBinding(makeBinding())
      assert.equal(result.valid, true)
    })

    it('rejects missing policyId', () => {
      const { policyId: _, ...rest } = makeBinding()
      const result = validatePolicyBinding(rest)
      assert.equal(result.valid, false)
    })
  })

  describe('registerTeamPolicy', () => {
    it('registers a valid opt-in policy', () => {
      const state = createPolicyState()
      const result = registerTeamPolicy(state, makePolicy())
      assert.equal(result.registered, true)
      assert.equal(state.policies.size, 1)
    })

    it('rejects policy with no rules', () => {
      const state = createPolicyState()
      const result = registerTeamPolicy(state, makePolicy({ rules: [] }))
      assert.equal(result.registered, false)
      assert.ok('reason' in result && result.reason.includes('policy_has_no_rules'))
    })

    it('rejects policy without optInRequired', () => {
      const state = createPolicyState()
      const result = registerTeamPolicy(state, makePolicy({ optInRequired: false }))
      assert.equal(result.registered, false)
      assert.ok('reason' in result && result.reason.includes('opt_in_must_be_required'))
    })

    it('rejects invalid policy payload', () => {
      const state = createPolicyState()
      const result = registerTeamPolicy(state, { kind: 'wrong' } as never)
      assert.equal(result.registered, false)
    })

    it('rejects replacing an existing policy id', () => {
      const state = createPolicyState()
      registerTeamPolicy(state, makePolicy())
      const result = registerTeamPolicy(state, makePolicy({ version: 2 }))
      assert.equal(result.registered, false)
      assert.equal('reason' in result && result.reason, 'policy_id_already_exists')
    })
  })

  describe('bindDevice', () => {
    it('binds device to registered policy', () => {
      const state = createPolicyState()
      registerTeamPolicy(state, makePolicy())
      const result = bindDevice(state, makeBinding())
      assert.equal(result.bound, true)
      assert.equal(state.bindings.size, 1)
    })

    it('rejects binding to non-existent policy', () => {
      const state = createPolicyState()
      const result = bindDevice(state, makeBinding({ policyId: 'missing' }))
      assert.equal(result.bound, false)
      assert.ok('reason' in result && result.reason.includes('policy_not_found'))
    })

    it('rejects inactive binding', () => {
      const state = createPolicyState()
      registerTeamPolicy(state, makePolicy())
      const result = bindDevice(state, makeBinding({ active: false }))
      assert.equal(result.bound, false)
      assert.ok('reason' in result && result.reason.includes('binding_must_be_active'))
    })

    it('rejects replacing an existing binding id', () => {
      const state = createPolicyState()
      registerTeamPolicy(state, makePolicy())
      bindDevice(state, makeBinding())
      const result = bindDevice(state, makeBinding({ deviceId: 'device-b' }))
      assert.equal(result.bound, false)
      assert.equal('reason' in result && result.reason, 'binding_id_already_exists')
    })
  })

  describe('unbindDevice', () => {
    it('unbinds an active binding', () => {
      const state = createPolicyState()
      registerTeamPolicy(state, makePolicy())
      bindDevice(state, makeBinding())
      const result = unbindDevice(state, 'bind-001')
      assert.equal(result.unbound, true)
      assert.equal(state.bindings.get('bind-001')?.active, false)
    })

    it('rejects unbinding non-existent binding', () => {
      const state = createPolicyState()
      const result = unbindDevice(state, 'missing')
      assert.equal(result.unbound, false)
    })

    it('rejects unbinding already-inactive binding', () => {
      const state = createPolicyState()
      registerTeamPolicy(state, makePolicy())
      bindDevice(state, makeBinding())
      unbindDevice(state, 'bind-001')
      const result = unbindDevice(state, 'bind-001')
      assert.equal(result.unbound, false)
      assert.ok('reason' in result && result.reason.includes('binding_already_inactive'))
    })
  })

  describe('evaluatePolicy', () => {
    it('permits when no bindings exist', () => {
      const state = createPolicyState()
      const result = evaluatePolicy(state, 'device-a', 5, 'run', null)
      assert.equal(result.permitted, true)
      assert.equal(result.violations.length, 0)
    })

    it('fails closed for an invalid autonomy request', () => {
      const state = createPolicyState()
      const result = evaluatePolicy(state, 'device-a', 7, 'run', null)
      assert.equal(result.permitted, false)
      assert.deepEqual(result.violations, ['invalid_policy_request'])
    })

    it('blocks autonomy level exceeding max', () => {
      const state = createPolicyState()
      registerTeamPolicy(state, makePolicy())
      bindDevice(state, makeBinding())
      const result = evaluatePolicy(state, 'device-a', 5, 'run', null)
      assert.equal(result.permitted, false)
      assert.ok(result.violations.some(v => v.includes('autonomy_level')))
    })

    it('blocks scope requiring approval', () => {
      const state = createPolicyState()
      registerTeamPolicy(state, makePolicy())
      bindDevice(state, makeBinding())
      const result = evaluatePolicy(state, 'device-a', 2, 'release', null)
      assert.equal(result.permitted, false)
      assert.ok(result.violations.some(v => v.includes('requires_approval')))
    })

    it('blocks denied capability', () => {
      const state = createPolicyState()
      registerTeamPolicy(state, makePolicy())
      bindDevice(state, makeBinding())
      const result = evaluatePolicy(state, 'device-a', 2, 'run', 'delete_device')
      assert.equal(result.permitted, false)
      assert.ok(result.violations.some(v => v.includes('capability_delete_device_denied')))
    })

    it('permits compliant request', () => {
      const state = createPolicyState()
      registerTeamPolicy(state, makePolicy())
      bindDevice(state, makeBinding())
      const result = evaluatePolicy(state, 'device-a', 2, 'run', 'index')
      assert.equal(result.permitted, true)
      assert.equal(result.violations.length, 0)
    })

    it('reports advisory-only violations without blocking', () => {
      const state = createPolicyState()
      registerTeamPolicy(state, makePolicy({
        rules: [{ ...makePolicy().rules[0], enforcement: 'advisory' }]
      }))
      bindDevice(state, makeBinding())
      const result = evaluatePolicy(state, 'device-a', 5, 'release', 'delete_device')
      assert.equal(result.permitted, true)
      assert.equal(result.enforcement, 'advisory')
      assert.ok(result.advisories.length > 0)
    })
  })

  describe('getEffectivePolicies', () => {
    it('returns policies for active bindings', () => {
      const state = createPolicyState()
      registerTeamPolicy(state, makePolicy())
      bindDevice(state, makeBinding())
      const policies = getEffectivePolicies(state, 'device-a')
      assert.equal(policies.length, 1)
      assert.equal(policies[0].policyId, 'pol-001')
    })

    it('returns empty for unbound device', () => {
      const state = createPolicyState()
      registerTeamPolicy(state, makePolicy())
      const policies = getEffectivePolicies(state, 'device-a')
      assert.equal(policies.length, 0)
    })
  })
})
