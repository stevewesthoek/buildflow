import { Ajv, type ValidateFunction } from 'ajv'

export const WORKBENCH_EXECUTOR_CONTRACT_VERSION = '1' as const
export const WORKBENCH_EXECUTOR_KIND = 'workbench.executor.broker' as const

export const WORKBENCH_EXECUTOR_TYPE_VALUES = [
  'codex_cli', 'claude_code', 'local_cli', 'custom'
] as const
export type WorkbenchExecutorType = typeof WORKBENCH_EXECUTOR_TYPE_VALUES[number]

export const WORKBENCH_EXECUTOR_STATE_VALUES = [
  'available', 'busy', 'unavailable', 'degraded'
] as const
export type WorkbenchExecutorState = typeof WORKBENCH_EXECUTOR_STATE_VALUES[number]

export const WORKBENCH_REASONING_EFFORT_VALUES = [
  'instant', 'low', 'medium', 'high', 'max'
] as const
export type WorkbenchReasoningEffort = typeof WORKBENCH_REASONING_EFFORT_VALUES[number]

export type WorkbenchExecutorCapabilityDescriptor = {
  kind: typeof WORKBENCH_EXECUTOR_KIND
  contractVersion: typeof WORKBENCH_EXECUTOR_CONTRACT_VERSION
  executorId: string
  executorType: WorkbenchExecutorType
  displayName: string
  state: WorkbenchExecutorState
  capabilities: WorkbenchExecutorCapabilities
  limits: WorkbenchExecutorLimits
  controlSurface: WorkbenchExecutorControlSurface
  registeredAt: string
}

export type WorkbenchExecutorCapabilities = {
  modelAliases: string[]
  reasoningEfforts: WorkbenchReasoningEffort[]
  supportsIsolation: boolean
  supportsWorktree: boolean
  supportsCancellation: boolean
  supportsWorkbenchMcp: boolean
  supportsStreaming: boolean
  supportsBackground: boolean
}

export type WorkbenchExecutorLimits = {
  maxPromptTokens: number
  maxGoalLength: number
  maxConcurrentRuns: number
  timeoutMs: number
}

export type WorkbenchExecutorControlSurface = {
  submitMethod: 'cli' | 'api' | 'mcp_client'
  statusMethod: 'polling' | 'streaming' | 'callback'
  cancellationMethod?: 'signal' | 'api' | 'none'
  mcpServerInjection: boolean
}

export type WorkbenchExecutorSubmission = {
  submissionId: string
  executorId: string
  packetId: string
  runId: string
  workspaceId: string
  prompt: string
  reasoningEffort: WorkbenchReasoningEffort
  isolation: 'worktree' | 'sandbox' | 'none'
  grantId: string
  submittedAt: string
}

export type WorkbenchExecutorResult = {
  submissionId: string
  executorId: string
  state: 'completed' | 'failed' | 'cancelled' | 'timeout'
  evidence?: WorkbenchExecutorEvidence
  completedAt: string
  durationMs: number
}

export type WorkbenchExecutorEvidence = {
  filesChanged: string[]
  validationPassed: boolean
  commitHash?: string
  outputSummary: string
  telemetry?: WorkbenchExecutorTelemetry
}

export type WorkbenchExecutorTelemetry = {
  modelUsed?: string
  tokensIn?: number
  tokensOut?: number
  costEstimate?: number
}

type JsonSchema = Record<string, unknown>

const boundedString = (maxLength: number): JsonSchema => ({
  type: 'string',
  minLength: 1,
  maxLength
})

export const WORKBENCH_EXECUTOR_DESCRIPTOR_JSON_SCHEMA: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Workbench Executor Capability Descriptor',
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'contractVersion', 'executorId', 'executorType', 'displayName', 'state', 'capabilities', 'limits', 'controlSurface', 'registeredAt'],
  properties: {
    kind: { const: WORKBENCH_EXECUTOR_KIND },
    contractVersion: { const: WORKBENCH_EXECUTOR_CONTRACT_VERSION },
    executorId: boundedString(128),
    executorType: { enum: [...WORKBENCH_EXECUTOR_TYPE_VALUES] },
    displayName: boundedString(256),
    state: { enum: [...WORKBENCH_EXECUTOR_STATE_VALUES] },
    capabilities: {
      type: 'object',
      additionalProperties: false,
      required: ['modelAliases', 'reasoningEfforts', 'supportsIsolation', 'supportsWorktree', 'supportsCancellation', 'supportsWorkbenchMcp', 'supportsStreaming', 'supportsBackground'],
      properties: {
        modelAliases: { type: 'array', items: boundedString(128), maxItems: 20 },
        reasoningEfforts: { type: 'array', items: { enum: [...WORKBENCH_REASONING_EFFORT_VALUES] }, minItems: 1, maxItems: 5 },
        supportsIsolation: { type: 'boolean' },
        supportsWorktree: { type: 'boolean' },
        supportsCancellation: { type: 'boolean' },
        supportsWorkbenchMcp: { type: 'boolean' },
        supportsStreaming: { type: 'boolean' },
        supportsBackground: { type: 'boolean' }
      }
    },
    limits: {
      type: 'object',
      additionalProperties: false,
      required: ['maxPromptTokens', 'maxGoalLength', 'maxConcurrentRuns', 'timeoutMs'],
      properties: {
        maxPromptTokens: { type: 'integer', minimum: 1000, maximum: 2000000 },
        maxGoalLength: { type: 'integer', minimum: 100, maximum: 100000 },
        maxConcurrentRuns: { type: 'integer', minimum: 1, maximum: 100 },
        timeoutMs: { type: 'integer', minimum: 5000, maximum: 3600000 }
      }
    },
    controlSurface: {
      type: 'object',
      additionalProperties: false,
      required: ['submitMethod', 'statusMethod', 'mcpServerInjection'],
      properties: {
        submitMethod: { enum: ['cli', 'api', 'mcp_client'] },
        statusMethod: { enum: ['polling', 'streaming', 'callback'] },
        cancellationMethod: { enum: ['signal', 'api', 'none'] },
        mcpServerInjection: { type: 'boolean' }
      }
    },
    registeredAt: boundedString(64)
  }
}

let descriptorValidator: ValidateFunction | undefined

function getDescriptorValidator(): ValidateFunction {
  if (!descriptorValidator) {
    const ajv = new Ajv({ strict: false, allErrors: true })
    descriptorValidator = ajv.compile(WORKBENCH_EXECUTOR_DESCRIPTOR_JSON_SCHEMA)
  }
  return descriptorValidator
}

export function validateExecutorDescriptor(input: unknown): { valid: true; descriptor: WorkbenchExecutorCapabilityDescriptor } | { valid: false; errors: string[] } {
  const validate = getDescriptorValidator()
  if (validate(input)) return { valid: true, descriptor: input as WorkbenchExecutorCapabilityDescriptor }
  return { valid: false, errors: (validate.errors ?? []).map(e => `${e.instancePath} ${e.message ?? ''}`.trim()) }
}

export type WorkbenchExecutorBrokerState = {
  executors: Map<string, WorkbenchExecutorCapabilityDescriptor>
  submissions: Map<string, WorkbenchExecutorSubmission>
  results: Map<string, WorkbenchExecutorResult>
}

export function createExecutorBrokerState(): WorkbenchExecutorBrokerState {
  return { executors: new Map(), submissions: new Map(), results: new Map() }
}

export function registerExecutor(
  state: WorkbenchExecutorBrokerState,
  descriptor: WorkbenchExecutorCapabilityDescriptor
): { registered: true } | { registered: false; reason: string } {
  const validation = validateExecutorDescriptor(descriptor)
  if (!validation.valid) return { registered: false, reason: `invalid descriptor: ${validation.errors.join(', ')}` }
  state.executors.set(descriptor.executorId, descriptor)
  return { registered: true }
}

export function removeExecutor(state: WorkbenchExecutorBrokerState, executorId: string): { removed: true } | { removed: false; reason: string } {
  if (!state.executors.has(executorId)) return { removed: false, reason: 'executor not found' }
  state.executors.delete(executorId)
  return { removed: true }
}

export function selectCheapestCapableExecutor(
  state: WorkbenchExecutorBrokerState,
  requiredEffort: WorkbenchReasoningEffort,
  requiresIsolation: boolean,
  requiresMcp: boolean
): WorkbenchExecutorCapabilityDescriptor | null {
  const candidates: WorkbenchExecutorCapabilityDescriptor[] = []

  for (const executor of state.executors.values()) {
    if (executor.state !== 'available') continue
    if (!executor.capabilities.reasoningEfforts.includes(requiredEffort)) continue
    if (requiresIsolation && !executor.capabilities.supportsIsolation) continue
    if (requiresMcp && !executor.capabilities.supportsWorkbenchMcp) continue
    candidates.push(executor)
  }

  if (candidates.length === 0) return null

  candidates.sort((a, b) => {
    const effortOrder: Record<WorkbenchReasoningEffort, number> = { instant: 0, low: 1, medium: 2, high: 3, max: 4 }
    const aMin = Math.min(...a.capabilities.reasoningEfforts.map(e => effortOrder[e]))
    const bMin = Math.min(...b.capabilities.reasoningEfforts.map(e => effortOrder[e]))
    return aMin - bMin
  })

  return candidates[0]
}

export function submitToExecutor(
  state: WorkbenchExecutorBrokerState,
  submission: WorkbenchExecutorSubmission
): { submitted: true } | { submitted: false; reason: string } {
  const executor = state.executors.get(submission.executorId)
  if (!executor) return { submitted: false, reason: 'executor not registered' }
  if (executor.state !== 'available') return { submitted: false, reason: `executor state is ${executor.state}` }

  if (submission.prompt.length > executor.limits.maxGoalLength) {
    return { submitted: false, reason: `prompt exceeds limit (${submission.prompt.length} > ${executor.limits.maxGoalLength})` }
  }

  const activeSubmissions = [...state.submissions.values()].filter(
    s => s.executorId === submission.executorId && !state.results.has(s.submissionId)
  )
  if (activeSubmissions.length >= executor.limits.maxConcurrentRuns) {
    return { submitted: false, reason: `executor at concurrent run limit (${executor.limits.maxConcurrentRuns})` }
  }

  state.submissions.set(submission.submissionId, submission)
  return { submitted: true }
}

export function recordExecutorResult(
  state: WorkbenchExecutorBrokerState,
  result: WorkbenchExecutorResult
): { recorded: true } | { recorded: false; reason: string } {
  if (!state.submissions.has(result.submissionId)) {
    return { recorded: false, reason: 'no matching submission found' }
  }
  state.results.set(result.submissionId, result)
  return { recorded: true }
}
