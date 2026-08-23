import { Ajv, type ValidateFunction } from 'ajv'

export const WORKBENCH_DELEGATION_CONTRACT_VERSION = '1' as const
export const WORKBENCH_DELEGATION_KIND = 'workbench.delegation.automatic' as const

export const WORKBENCH_DELEGATION_STATE_VALUES = [
  'pending', 'submitted', 'running', 'completed', 'failed', 'cancelled', 'reconciling', 'reconciled'
] as const
export type WorkbenchDelegationState = typeof WORKBENCH_DELEGATION_STATE_VALUES[number]

export const WORKBENCH_DELEGATION_ISOLATION_VALUES = [
  'worktree', 'sandbox', 'none'
] as const
export type WorkbenchDelegationIsolation = typeof WORKBENCH_DELEGATION_ISOLATION_VALUES[number]

export type WorkbenchDelegation = {
  kind: typeof WORKBENCH_DELEGATION_KIND
  contractVersion: typeof WORKBENCH_DELEGATION_CONTRACT_VERSION
  delegationId: string
  runId: string
  packetId: string
  workspaceId: string
  executorId: string
  state: WorkbenchDelegationState
  isolation: WorkbenchDelegationIsolation
  worktreePath?: string
  branchName?: string
  expectedHead?: string
  grantId: string
  submittedAt?: string
  startedAt?: string
  completedAt?: string
  createdAt: string
}

export type WorkbenchDelegationEligibility =
  | { eligible: true; reason: string }
  | { eligible: false; reason: string }

export type WorkbenchReconciliationResult = {
  delegationId: string
  filesReconciled: string[]
  validationPassed: boolean
  commitHash?: string
  conflictsDetected: string[]
  reconciledAt: string
}

type JsonSchema = Record<string, unknown>

const boundedString = (maxLength: number): JsonSchema => ({
  type: 'string',
  minLength: 1,
  maxLength
})

export const WORKBENCH_DELEGATION_JSON_SCHEMA: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Workbench Automatic Delegation',
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'contractVersion', 'delegationId', 'runId', 'packetId', 'workspaceId', 'executorId', 'state', 'isolation', 'grantId', 'createdAt'],
  properties: {
    kind: { const: WORKBENCH_DELEGATION_KIND },
    contractVersion: { const: WORKBENCH_DELEGATION_CONTRACT_VERSION },
    delegationId: boundedString(128),
    runId: boundedString(128),
    packetId: boundedString(128),
    workspaceId: boundedString(128),
    executorId: boundedString(128),
    state: { enum: [...WORKBENCH_DELEGATION_STATE_VALUES] },
    isolation: { enum: [...WORKBENCH_DELEGATION_ISOLATION_VALUES] },
    worktreePath: boundedString(1024),
    branchName: boundedString(256),
    expectedHead: boundedString(64),
    grantId: boundedString(128),
    submittedAt: boundedString(64),
    startedAt: boundedString(64),
    completedAt: boundedString(64),
    createdAt: boundedString(64)
  }
}

let delegationValidator: ValidateFunction | undefined

function getDelegationValidator(): ValidateFunction {
  if (!delegationValidator) {
    const ajv = new Ajv({ strict: false, allErrors: true })
    delegationValidator = ajv.compile(WORKBENCH_DELEGATION_JSON_SCHEMA)
  }
  return delegationValidator
}

export function validateDelegation(input: unknown): { valid: true; delegation: WorkbenchDelegation } | { valid: false; errors: string[] } {
  const validate = getDelegationValidator()
  if (validate(input)) return { valid: true, delegation: input as WorkbenchDelegation }
  return { valid: false, errors: (validate.errors ?? []).map(e => `${e.instancePath} ${e.message ?? ''}`.trim()) }
}

export function checkEligibility(
  packetDeterministic: boolean,
  executorAvailable: boolean,
  grantActive: boolean,
  sameWorktreeWriterActive: boolean
): WorkbenchDelegationEligibility {
  if (!packetDeterministic) return { eligible: false, reason: 'packet is not deterministic' }
  if (!executorAvailable) return { eligible: false, reason: 'no executor available' }
  if (!grantActive) return { eligible: false, reason: 'no active grant for workspace' }
  if (sameWorktreeWriterActive) return { eligible: false, reason: 'another writer is active in the same worktree' }
  return { eligible: true, reason: 'all eligibility checks passed' }
}

export type WorkbenchDelegationStore = {
  delegations: Map<string, WorkbenchDelegation>
  reconciliations: Map<string, WorkbenchReconciliationResult>
}

export function createDelegationStore(): WorkbenchDelegationStore {
  return { delegations: new Map(), reconciliations: new Map() }
}

export function createDelegation(
  store: WorkbenchDelegationStore,
  delegation: WorkbenchDelegation
): { created: true } | { created: false; reason: string } {
  const validation = validateDelegation(delegation)
  if (!validation.valid) return { created: false, reason: `invalid delegation: ${validation.errors.join(', ')}` }

  if (store.delegations.has(delegation.delegationId)) {
    return { created: false, reason: 'delegation id already exists' }
  }

  const existingActive = [...store.delegations.values()].find(
    d => d.workspaceId === delegation.workspaceId &&
         d.isolation === 'none' &&
         ['submitted', 'running'].includes(d.state)
  )
  if (existingActive && delegation.isolation === 'none') {
    return { created: false, reason: 'another active delegation exists for this workspace without isolation' }
  }

  store.delegations.set(delegation.delegationId, delegation)
  return { created: true }
}

export function transitionDelegation(
  store: WorkbenchDelegationStore,
  delegationId: string,
  newState: WorkbenchDelegationState,
  timestamp: string
): { transitioned: true } | { transitioned: false; reason: string } {
  const existing = store.delegations.get(delegationId)
  if (!existing) return { transitioned: false, reason: 'delegation not found' }

  const validTransitions: Record<WorkbenchDelegationState, WorkbenchDelegationState[]> = {
    pending: ['submitted', 'cancelled'],
    submitted: ['running', 'failed', 'cancelled'],
    running: ['completed', 'failed', 'cancelled'],
    completed: ['reconciling'],
    failed: [],
    cancelled: [],
    reconciling: ['reconciled', 'failed'],
    reconciled: []
  }

  if (!validTransitions[existing.state].includes(newState)) {
    return { transitioned: false, reason: `cannot transition from ${existing.state} to ${newState}` }
  }

  const updated: WorkbenchDelegation = { ...existing, state: newState }
  if (newState === 'submitted') updated.submittedAt = timestamp
  if (newState === 'running') updated.startedAt = timestamp
  if (['completed', 'failed', 'cancelled', 'reconciled'].includes(newState)) updated.completedAt = timestamp

  store.delegations.set(delegationId, updated)
  return { transitioned: true }
}

export function cancelDelegation(
  store: WorkbenchDelegationStore,
  delegationId: string,
  timestamp: string
): { cancelled: true } | { cancelled: false; reason: string } {
  const existing = store.delegations.get(delegationId)
  if (!existing) return { cancelled: false, reason: 'delegation not found' }
  if (['completed', 'failed', 'cancelled', 'reconciled'].includes(existing.state)) {
    return { cancelled: false, reason: `delegation already terminal: ${existing.state}` }
  }
  const result = transitionDelegation(store, delegationId, 'cancelled', timestamp)
  if (result.transitioned) return { cancelled: true }
  return { cancelled: false, reason: result.reason }
}

export function recordReconciliation(
  store: WorkbenchDelegationStore,
  result: WorkbenchReconciliationResult
): { recorded: true } | { recorded: false; reason: string } {
  const delegation = store.delegations.get(result.delegationId)
  if (!delegation) return { recorded: false, reason: 'delegation not found' }
  if (delegation.state !== 'reconciling') {
    return { recorded: false, reason: `delegation must be reconciling, is ${delegation.state}` }
  }
  store.reconciliations.set(result.delegationId, result)
  return { recorded: true }
}

export function listActiveDelegations(store: WorkbenchDelegationStore, workspaceId?: string): WorkbenchDelegation[] {
  return [...store.delegations.values()].filter(d => {
    if (workspaceId && d.workspaceId !== workspaceId) return false
    return ['pending', 'submitted', 'running', 'reconciling'].includes(d.state)
  })
}
