import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateExecutorDescriptor,
  createExecutorBrokerState,
  registerExecutor,
  removeExecutor,
  selectCheapestCapableExecutor,
  submitToExecutor,
  recordExecutorResult,
  WORKBENCH_EXECUTOR_KIND,
  WORKBENCH_EXECUTOR_CONTRACT_VERSION,
  type WorkbenchExecutorCapabilityDescriptor,
  type WorkbenchExecutorSubmission,
  type WorkbenchExecutorResult
} from '../executor-broker.js'
import {
  validateDelegation,
  createDelegationStore,
  createDelegation,
  transitionDelegation,
  cancelDelegation,
  listActiveDelegations,
  checkEligibility,
  WORKBENCH_DELEGATION_KIND,
  type WorkbenchDelegation
} from '../automatic-delegation.js'

function makeDescriptor(overrides: Partial<WorkbenchExecutorCapabilityDescriptor> = {}): WorkbenchExecutorCapabilityDescriptor {
  return {
    kind: WORKBENCH_EXECUTOR_KIND,
    contractVersion: WORKBENCH_EXECUTOR_CONTRACT_VERSION,
    executorId: 'executor-1',
    executorType: 'codex_cli',
    displayName: 'Codex CLI',
    state: 'available',
    capabilities: {
      modelAliases: ['model-alias'],
      reasoningEfforts: ['medium'],
      supportsIsolation: true,
      supportsWorktree: true,
      supportsCancellation: true,
      supportsWorkbenchMcp: false,
      supportsStreaming: false,
      supportsBackground: false
    },
    limits: {
      maxPromptTokens: 100000,
      maxGoalLength: 10000,
      maxConcurrentRuns: 3,
      timeoutMs: 300000
    },
    controlSurface: {
      submitMethod: 'cli',
      statusMethod: 'polling',
      mcpServerInjection: false
    },
    registeredAt: '2026-08-21T00:00:00Z',
    ...overrides
  }
}

function makeSubmission(overrides: Partial<WorkbenchExecutorSubmission> = {}): WorkbenchExecutorSubmission {
  return {
    submissionId: 'sub-1',
    executorId: 'executor-1',
    packetId: 'pkt-1',
    runId: 'run-1',
    workspaceId: 'ws-1',
    prompt: 'do something useful',
    reasoningEffort: 'medium',
    isolation: 'none',
    grantId: 'grant-1',
    submittedAt: '2026-08-21T00:00:00Z',
    ...overrides
  }
}

function makeDelegation(overrides: Partial<WorkbenchDelegation> = {}): WorkbenchDelegation {
  return {
    kind: WORKBENCH_DELEGATION_KIND,
    contractVersion: '1',
    delegationId: 'del-1',
    runId: 'run-1',
    packetId: 'pkt-1',
    workspaceId: 'ws-1',
    executorId: 'executor-1',
    state: 'pending',
    isolation: 'worktree',
    grantId: 'grant-1',
    createdAt: '2026-08-21T00:00:00Z',
    ...overrides
  }
}

describe('executor-broker', () => {
  describe('validateExecutorDescriptor', () => {
    it('accepts a valid descriptor', () => {
      const result = validateExecutorDescriptor(makeDescriptor())
      assert.equal(result.valid, true)
    })

    it('rejects missing required fields', () => {
      const result = validateExecutorDescriptor({ kind: WORKBENCH_EXECUTOR_KIND })
      assert.equal(result.valid, false)
    })

    it('rejects invalid executor type', () => {
      const result = validateExecutorDescriptor(makeDescriptor({ executorType: 'unknown_type' as never }))
      assert.equal(result.valid, false)
    })
  })

  describe('executor registry', () => {
    it('registers and removes executor', () => {
      const state = createExecutorBrokerState()
      const descriptor = makeDescriptor()
      assert.equal(registerExecutor(state, descriptor).registered, true)
      assert.equal(state.executors.size, 1)
      assert.equal(removeExecutor(state, 'executor-1').removed, true)
      assert.equal(state.executors.size, 0)
    })

    it('returns error removing nonexistent executor', () => {
      const state = createExecutorBrokerState()
      const result = removeExecutor(state, 'missing')
      assert.equal(result.removed, false)
    })
  })

  describe('selectCheapestCapableExecutor', () => {
    it('selects cheapest available executor', () => {
      const state = createExecutorBrokerState()
      registerExecutor(state, makeDescriptor({ executorId: 'expensive', capabilities: { ...makeDescriptor().capabilities, reasoningEfforts: ['high', 'max'] } }))
      registerExecutor(state, makeDescriptor({ executorId: 'cheap', capabilities: { ...makeDescriptor().capabilities, reasoningEfforts: ['instant', 'low'] } }))
      const selected = selectCheapestCapableExecutor(state, 'low', false, false)
      assert.equal(selected?.executorId, 'cheap')
    })

    it('skips unavailable executors', () => {
      const state = createExecutorBrokerState()
      registerExecutor(state, makeDescriptor({ executorId: 'busy-1', state: 'busy' }))
      const selected = selectCheapestCapableExecutor(state, 'medium', false, false)
      assert.equal(selected, null)
    })

    it('filters on isolation requirement', () => {
      const state = createExecutorBrokerState()
      registerExecutor(state, makeDescriptor({ executorId: 'no-iso', capabilities: { ...makeDescriptor().capabilities, supportsIsolation: false } }))
      registerExecutor(state, makeDescriptor({ executorId: 'has-iso', capabilities: { ...makeDescriptor().capabilities, supportsIsolation: true } }))
      const selected = selectCheapestCapableExecutor(state, 'medium', true, false)
      assert.equal(selected?.executorId, 'has-iso')
    })
  })

  describe('submitToExecutor', () => {
    it('submits when executor is available', () => {
      const state = createExecutorBrokerState()
      registerExecutor(state, makeDescriptor())
      const result = submitToExecutor(state, makeSubmission())
      assert.equal(result.submitted, true)
    })

    it('rejects when executor not registered', () => {
      const state = createExecutorBrokerState()
      const result = submitToExecutor(state, makeSubmission({ executorId: 'missing' }))
      assert.equal(result.submitted, false)
    })

    it('rejects prompt exceeding limit', () => {
      const state = createExecutorBrokerState()
      registerExecutor(state, makeDescriptor({ limits: { ...makeDescriptor().limits, maxGoalLength: 10 } }))
      const result = submitToExecutor(state, makeSubmission({ prompt: 'x'.repeat(100) }))
      assert.equal(result.submitted, false)
    })
  })

  describe('recordExecutorResult', () => {
    it('records result for known submission', () => {
      const state = createExecutorBrokerState()
      registerExecutor(state, makeDescriptor())
      submitToExecutor(state, makeSubmission())
      const result = recordExecutorResult(state, {
        submissionId: 'sub-1',
        executorId: 'executor-1',
        state: 'completed',
        completedAt: '2026-08-21T01:00:00Z',
        durationMs: 5000
      })
      assert.equal(result.recorded, true)
    })
  })
})

describe('automatic-delegation', () => {
  describe('checkEligibility', () => {
    it('eligible when all conditions pass', () => {
      const result = checkEligibility(true, true, true, false)
      assert.equal(result.eligible, true)
    })

    it('ineligible when non-deterministic', () => {
      const result = checkEligibility(false, true, true, false)
      assert.equal(result.eligible, false)
    })

    it('ineligible when same worktree writer active', () => {
      const result = checkEligibility(true, true, true, true)
      assert.equal(result.eligible, false)
    })

    it('ineligible when no grant active', () => {
      const result = checkEligibility(true, true, false, false)
      assert.equal(result.eligible, false)
    })
  })

  describe('delegation store', () => {
    it('creates and transitions delegation', () => {
      const store = createDelegationStore()
      const delegation = makeDelegation()
      assert.equal(createDelegation(store, delegation).created, true)
      assert.equal(transitionDelegation(store, 'del-1', 'submitted', '2026-08-21T00:01:00Z').transitioned, true)
      assert.equal(store.delegations.get('del-1')?.state, 'submitted')
    })

    it('rejects invalid state transition', () => {
      const store = createDelegationStore()
      createDelegation(store, makeDelegation())
      const result = transitionDelegation(store, 'del-1', 'completed', '2026-08-21T00:01:00Z')
      assert.equal(result.transitioned, false)
    })

    it('rejects duplicate delegation ids instead of overwriting state', () => {
      const store = createDelegationStore()
      const delegation = makeDelegation()
      assert.equal(createDelegation(store, delegation).created, true)
      const result = createDelegation(store, { ...delegation, state: 'submitted' })
      assert.equal(result.created, false)
      assert.equal(store.delegations.get('del-1')?.state, 'pending')
    })

    it('cancels an active delegation', () => {
      const store = createDelegationStore()
      createDelegation(store, makeDelegation())
      assert.equal(cancelDelegation(store, 'del-1', '2026-08-21T00:01:00Z').cancelled, true)
      assert.equal(store.delegations.get('del-1')?.state, 'cancelled')
    })

    it('cannot cancel terminal delegation', () => {
      const store = createDelegationStore()
      createDelegation(store, makeDelegation({ state: 'completed' }))
      const result = cancelDelegation(store, 'del-1', '2026-08-21T00:01:00Z')
      assert.equal(result.cancelled, false)
    })

    it('lists only active delegations', () => {
      const store = createDelegationStore()
      createDelegation(store, makeDelegation({ delegationId: 'del-active', state: 'pending' }))
      createDelegation(store, makeDelegation({ delegationId: 'del-done', state: 'completed' }))
      const active = listActiveDelegations(store)
      assert.equal(active.length, 1)
      assert.equal(active[0].delegationId, 'del-active')
    })

    it('prevents same-worktree non-isolated collision', () => {
      const store = createDelegationStore()
      createDelegation(store, makeDelegation({ delegationId: 'del-1', isolation: 'none', state: 'submitted', workspaceId: 'ws-1' }))
      const result = createDelegation(store, makeDelegation({ delegationId: 'del-2', isolation: 'none', workspaceId: 'ws-1' }))
      assert.equal(result.created, false)
    })
  })

  describe('validateDelegation', () => {
    it('accepts a valid delegation', () => {
      const result = validateDelegation(makeDelegation())
      assert.equal(result.valid, true)
    })

    it('rejects missing required fields', () => {
      const result = validateDelegation({ kind: WORKBENCH_DELEGATION_KIND })
      assert.equal(result.valid, false)
    })
  })
})
