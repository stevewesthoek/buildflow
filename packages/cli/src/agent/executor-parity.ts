import type { AgentJob } from './agent-jobs'
import type { PromptPacketTransportContract } from './prompt-packet-compiler'
import type { WorkbenchPacket } from './workbench-packets'

export const EXECUTOR_PARITY_SCHEMA_VERSION = 1 as const

export type ParityClassification = 'presentation_only' | 'executor_capability_difference' | 'parity_failure'

export type ParityReasonCode =
  | 'source_mismatch'
  | 'run_mismatch'
  | 'task_mismatch'
  | 'packet_mismatch'
  | 'head_mismatch'
  | 'path_scope_mismatch'
  | 'validation_mismatch'
  | 'budget_mismatch'
  | 'stop_condition_mismatch'
  | 'git_restriction_mismatch'
  | 'confirmation_mismatch'
  | 'idempotency_mismatch'
  | 'retry_mismatch'
  | 'cancellation_mismatch'
  | 'outcome_mismatch'
  | 'presentation_difference'
  | 'executor_capability_difference'

export type ExecutionOutcome = 'success' | 'rejected' | 'failure' | 'timeout' | 'interrupted' | 'cancelled' | 'paused'

export type ExecutionAuthorityProjection = {
  schemaVersion: typeof EXECUTOR_PARITY_SCHEMA_VERSION
  sourceId: string
  runId: string
  taskId: string
  packetId: string
  expectedHead: string
  exactPaths: string[]
  validation: string[]
  confirmationRequired: boolean
  budget: {
    maxPacketCycles: number
    maxElapsedMs: number
    advisoryRoadmapProgressTarget: number
    maxRepairAttempts: number
    stopConditions: string[]
    consumedPacketCycles: number
    consumedRepairAttempts: number
  }
  restrictions: {
    commitEnabled: boolean
    commitMessage?: string
    pushAllowed: boolean
    publishAllowed: boolean
    deployAllowed: boolean
  }
  retry: { maximumRepairs: number }
  cancellation: { pauseSupported: boolean; cancelSupported: boolean }
  idempotencyKey: string
  outcome: ExecutionOutcome
}

export type ExecutorParityDifference = {
  classification: ParityClassification
  reasonCode: ParityReasonCode
  field: string
  direct: string
  compiled: string
}

export type ExecutorParityReport = {
  schemaVersion: typeof EXECUTOR_PARITY_SCHEMA_VERSION
  parity: boolean
  differences: ExecutorParityDifference[]
  headline: string
  compactText: string
}

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort()
}

export function projectDirectExecutionAuthority(params: {
  run: AgentJob
  packet: WorkbenchPacket
  outcome: ExecutionOutcome
}): ExecutionAuthorityProjection {
  const { run, packet } = params
  return {
    schemaVersion: EXECUTOR_PARITY_SCHEMA_VERSION,
    sourceId: packet.sourceId,
    runId: packet.runId,
    taskId: packet.taskId,
    packetId: packet.packetId,
    expectedHead: packet.expectedHead,
    exactPaths: sortedUnique(packet.steps.flatMap(step => [step.path, step.to].filter((value): value is string => Boolean(value)))),
    validation: (packet.validation || []).map(item => item.commandKind),
    confirmationRequired: run.requiresConfirmation === true,
    budget: {
      maxPacketCycles: run.executionBudget.maxPacketCycles,
      maxElapsedMs: run.executionBudget.maxElapsedMs,
      advisoryRoadmapProgressTarget: run.executionBudget.advisoryRoadmapProgressTarget,
      maxRepairAttempts: run.executionBudget.maxRepairAttempts,
      stopConditions: [...run.executionBudget.stopConditions],
      consumedPacketCycles: run.executionBudget.consumedPacketCycles,
      consumedRepairAttempts: run.executionBudget.consumedRepairAttempts
    },
    restrictions: {
      commitEnabled: packet.commit?.enabled === true,
      ...(packet.commit?.message ? { commitMessage: packet.commit.message } : {}),
      pushAllowed: false,
      publishAllowed: false,
      deployAllowed: false
    },
    retry: { maximumRepairs: run.executionBudget.maxRepairAttempts },
    cancellation: { pauseSupported: true, cancelSupported: true },
    idempotencyKey: packet.idempotencyKey,
    outcome: params.outcome
  }
}

export function projectCompiledExecutionAuthority(params: {
  contract: PromptPacketTransportContract
  confirmationRequired: boolean
  outcome: ExecutionOutcome
}): ExecutionAuthorityProjection {
  const contract = params.contract
  return {
    schemaVersion: EXECUTOR_PARITY_SCHEMA_VERSION,
    sourceId: contract.sourceId,
    runId: contract.runId,
    taskId: contract.taskId,
    packetId: contract.packetId,
    expectedHead: contract.expectedHead,
    exactPaths: sortedUnique(contract.exactPaths),
    validation: contract.validation.map(item => item.commandKind),
    confirmationRequired: params.confirmationRequired,
    budget: {
      maxPacketCycles: contract.budget.maxPacketCycles,
      maxElapsedMs: contract.budget.maxElapsedMs,
      advisoryRoadmapProgressTarget: contract.budget.advisoryRoadmapProgressTarget,
      maxRepairAttempts: contract.budget.maxRepairAttempts,
      stopConditions: [...contract.budget.stopConditions],
      consumedPacketCycles: contract.budget.consumedPacketCycles,
      consumedRepairAttempts: contract.budget.consumedRepairAttempts
    },
    restrictions: { ...contract.restrictions },
    retry: { maximumRepairs: contract.budget.maxRepairAttempts },
    cancellation: { pauseSupported: true, cancelSupported: true },
    idempotencyKey: contract.idempotencyKey.split(':').slice(0, -1).join(':'),
    outcome: params.outcome
  }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify([...value].sort())
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return JSON.stringify(Object.fromEntries(Object.keys(object).sort().map(key => [key, object[key]])))
  }
  return JSON.stringify(value)
}

export function compareExecutionParity(params: {
  direct: ExecutionAuthorityProjection
  compiled: ExecutionAuthorityProjection
  presentationDifferent?: boolean
  executorCapabilityDifferent?: boolean
}): ExecutorParityReport {
  const differences: ExecutorParityDifference[] = []
  const compare = (field: keyof ExecutionAuthorityProjection, reasonCode: ParityReasonCode) => {
    const direct = stable(params.direct[field])
    const compiled = stable(params.compiled[field])
    if (direct !== compiled) differences.push({ classification: 'parity_failure', reasonCode, field, direct, compiled })
  }
  compare('sourceId', 'source_mismatch')
  compare('runId', 'run_mismatch')
  compare('taskId', 'task_mismatch')
  compare('packetId', 'packet_mismatch')
  compare('expectedHead', 'head_mismatch')
  compare('exactPaths', 'path_scope_mismatch')
  compare('validation', 'validation_mismatch')
  compare('budget', 'budget_mismatch')
  compare('restrictions', 'git_restriction_mismatch')
  compare('confirmationRequired', 'confirmation_mismatch')
  compare('idempotencyKey', 'idempotency_mismatch')
  compare('retry', 'retry_mismatch')
  compare('cancellation', 'cancellation_mismatch')
  compare('outcome', 'outcome_mismatch')
  if (params.presentationDifferent) differences.push({ classification: 'presentation_only', reasonCode: 'presentation_difference', field: 'presentation', direct: 'native', compiled: 'rendered' })
  if (params.executorCapabilityDifferent) differences.push({ classification: 'executor_capability_difference', reasonCode: 'executor_capability_difference', field: 'executor', direct: 'workbench', compiled: 'external_preview' })
  const failures = differences.filter(item => item.classification === 'parity_failure')
  const headline = failures.length === 0 ? 'Executor parity passed' : `Executor parity failed: ${failures.length} mismatch${failures.length === 1 ? '' : 'es'}`
  const compactText = `${headline}. Presentation ${differences.some(item => item.classification === 'presentation_only') ? 'differs' : 'matches'}; capability ${differences.some(item => item.classification === 'executor_capability_difference') ? 'differs' : 'matches'}.`.slice(0, 320)
  return { schemaVersion: EXECUTOR_PARITY_SCHEMA_VERSION, parity: failures.length === 0, differences, headline, compactText }
}
