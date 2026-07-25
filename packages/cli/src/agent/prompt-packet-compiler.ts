import crypto from 'crypto'
import type { AgentJob } from './agent-jobs'
import type { ExecutionSelectionEngine, ExecutionSelectionProfile, ExecutionSelectionResult } from './execution-selection'
import type { ResumeProjection } from './resume-projection'
import { isResumeProjectionFresh } from './resume-projection'
import type { WorkbenchPacket } from './workbench-packets'

export const PROMPT_PACKET_COMPILER_SCHEMA_VERSION = 1 as const

export type PromptPacketCompilerReason =
  | 'direct_continuation'
  | 'external_packet_required'
  | 'no_active_packet'
  | 'stale_resume_projection'
  | 'source_mismatch'
  | 'run_mismatch'
  | 'task_mismatch'
  | 'head_mismatch'
  | 'confirmation_required'
  | 'budget_exhausted'
  | 'unknown_executor'
  | 'output_budget_exceeded'

export type PromptPacketTransportContract = {
  schemaVersion: typeof PROMPT_PACKET_COMPILER_SCHEMA_VERSION
  sourceId: string
  runId: string
  taskId: string
  packetId: string
  expectedHead: string
  resumeProjectionHash: string
  compilerIdentity: {
    runVersion: number
    planVersion: number
    projectionSchemaVersion: number
    packetSchemaVersion: number
    budgetSchemaVersion: number
    policyIdentity: string
    confirmationIdentity: string
    executionEngine: ExecutionSelectionEngine
    executionProfile: ExecutionSelectionProfile
  }
  goalSummary: string
  exactPaths: string[]
  exactSymbols: string[]
  steps: Array<{
    type: string
    path: string
    to?: string
  }>
  validation: Array<{
    commandKind: string
    timeoutMs?: number
    paths?: string[]
    packageDir?: string
    scriptName?: string
    marker?: string
    patternSet?: string
  }>
  restrictions: {
    commitEnabled: boolean
    commitMessage?: string
    pushAllowed: false
    publishAllowed: false
    deployAllowed: false
  }
  budget: {
    maxPacketCycles: number
    maxElapsedMs: number
    advisoryRoadmapProgressTarget: number
    maxRepairAttempts: number
    stopConditions: string[]
    consumedPacketCycles: number
    consumedRepairAttempts: number
  }
  contentHash: string
  idempotencyKey: string
}

export type PromptPacketCompilation = {
  status: 'direct' | 'external' | 'rejected'
  reasonCode: PromptPacketCompilerReason
  nextAction: string
  contract?: PromptPacketTransportContract
  renderings?: {
    human: string
    codexManual: string
    futureAdapter: string
  }
}

export type PromptPacketCompilerInput = {
  run: AgentJob
  projection: ResumeProjection
  packet?: WorkbenchPacket
  execution: Pick<ExecutionSelectionResult, 'engine' | 'profile' | 'outcome'>
  policyIdentity?: string
  exactSymbols?: string[]
  maxRenderingBytes?: number
}

const MAX_RENDERING_BYTES = 8_000
const MAX_TEXT = 500
const KNOWN_ENGINES = new Set<ExecutionSelectionEngine>(['direct', 'codex', 'future_adapter', 'human'])

function boundedText(value: unknown, max = MAX_TEXT): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const item = value as Record<string, unknown>
  return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical(item[key])}`).join(',')}}`
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function uniqueBounded(values: unknown, limit = 20): string[] {
  if (!Array.isArray(values)) return []
  return Array.from(new Set(values.filter((value): value is string => typeof value === 'string').map(value => boundedText(value, 240)).filter(Boolean))).slice(0, limit)
}

function renderHuman(contract: PromptPacketTransportContract): string {
  return [
    `Source: ${contract.sourceId}`,
    `Run: ${contract.runId}`,
    `Task: ${contract.taskId}`,
    `Packet: ${contract.packetId}`,
    `Goal: ${contract.goalSummary}`,
    `Expected HEAD: ${contract.expectedHead}`,
    `Paths: ${contract.exactPaths.join(', ') || 'none'}`,
    `Validation: ${contract.validation.map(item => item.commandKind).join(', ') || 'none'}`,
    `Commit: ${contract.restrictions.commitEnabled ? 'allowed by packet' : 'disabled'}`,
    'Push: disabled',
    'Publish: disabled',
    'Deploy: disabled'
  ].join('\n')
}

function renderCodex(contract: PromptPacketTransportContract): string {
  return [
    `Repository source: ${contract.sourceId}`,
    `Resume run ${contract.runId}.`,
    `Execute packet ${contract.packetId} for task ${contract.taskId}.`,
    `Goal: ${contract.goalSummary}`,
    `Expected HEAD: ${contract.expectedHead}`,
    `Modify only: ${contract.exactPaths.join(', ') || 'no paths'}.`,
    `Run validations: ${contract.validation.map(item => item.commandKind).join(', ') || 'none'}.`,
    contract.restrictions.commitEnabled ? `Commit only after validation with: ${contract.restrictions.commitMessage || 'the packet-approved message'}.` : 'Do not commit.',
    'Do not push, publish, or deploy.',
    `Contract hash: ${contract.contentHash}`,
    `Idempotency key: ${contract.idempotencyKey}`
  ].join('\n')
}

function renderAdapter(contract: PromptPacketTransportContract): string {
  return JSON.stringify(contract)
}

function withinBudget(value: string, maxBytes: number): boolean {
  return Buffer.byteLength(value, 'utf8') <= maxBytes
}

function rejection(reasonCode: PromptPacketCompilerReason, nextAction: string): PromptPacketCompilation {
  return { status: 'rejected', reasonCode, nextAction }
}

export function compilePromptPacket(input: PromptPacketCompilerInput): PromptPacketCompilation {
  const maxBytes = Math.min(MAX_RENDERING_BYTES, Math.max(512, Math.floor(input.maxRenderingBytes || MAX_RENDERING_BYTES)))
  if (!KNOWN_ENGINES.has(input.execution.engine)) return rejection('unknown_executor', 'Select a supported execution engine.')
  if (!input.packet) return rejection('no_active_packet', 'Create or reserve the active packet before compiling transport output.')
  if (input.run.sourceId !== input.packet.sourceId || input.projection.sourceId !== input.packet.sourceId) return rejection('source_mismatch', 'Use the packet for the locked source only.')
  if (input.run.id !== input.packet.runId || input.projection.runId !== input.packet.runId) return rejection('run_mismatch', 'Use the active packet for the authoritative run.')
  if (input.run.activeTaskId && input.run.activeTaskId !== input.packet.taskId) return rejection('task_mismatch', 'Compile only the active task packet.')
  if (input.projection.currentHead && input.projection.currentHead !== input.packet.expectedHead) return rejection('head_mismatch', 'Refresh the packet against the current HEAD.')
  if (input.run.requiresConfirmation || input.projection.confirmation.required) return rejection('confirmation_required', 'Resolve the explicit confirmation boundary first.')
  if (input.run.executionBudget.exhausted || input.projection.budget.exhausted) return rejection('budget_exhausted', `Run budget exhausted: ${input.run.executionBudget.reasonCode || input.projection.budget.reasonCode || 'unknown'}`)
  if (!isResumeProjectionFresh(input.projection, { run: input.run, packet: { status: 'queued', packet: input.packet }, policyIdentity: input.policyIdentity })) {
    return rejection('stale_resume_projection', 'Rebuild the Resume Projection from the authoritative run and packet.')
  }

  if (input.execution.engine === 'direct' && input.execution.outcome !== 'rejected') {
    return {
      status: 'direct',
      reasonCode: 'direct_continuation',
      nextAction: input.projection.nextAction || 'Continue directly through Workbench.'
    }
  }

  const exactPaths = uniqueBounded(input.packet.steps.flatMap(step => [step.path, step.to]).filter(Boolean))
  const exactSymbols = uniqueBounded(input.exactSymbols)
  const validation = (input.packet.validation || []).map(item => ({
    commandKind: item.commandKind,
    ...(item.timeoutMs ? { timeoutMs: item.timeoutMs } : {}),
    ...(item.paths ? { paths: uniqueBounded(item.paths) } : {}),
    ...(item.packageDir ? { packageDir: boundedText(item.packageDir, 240) } : {}),
    ...(item.scriptName ? { scriptName: boundedText(item.scriptName, 160) } : {}),
    ...(item.marker ? { marker: boundedText(item.marker, 160) } : {}),
    ...(item.patternSet ? { patternSet: item.patternSet } : {})
  }))
  const base = {
    schemaVersion: PROMPT_PACKET_COMPILER_SCHEMA_VERSION,
    sourceId: input.packet.sourceId,
    runId: input.packet.runId,
    taskId: input.packet.taskId,
    packetId: input.packet.packetId,
    expectedHead: input.packet.expectedHead,
    resumeProjectionHash: input.projection.contentHash,
    compilerIdentity: {
      runVersion: input.run.runVersion,
      planVersion: input.run.planVersion,
      projectionSchemaVersion: input.projection.schemaVersion,
      packetSchemaVersion: input.packet.version,
      budgetSchemaVersion: input.run.executionBudget.schemaVersion,
      policyIdentity: input.projection.freshness.policyIdentity,
      confirmationIdentity: input.projection.freshness.confirmationIdentity,
      executionEngine: input.execution.engine,
      executionProfile: input.execution.profile
    },
    goalSummary: boundedText(input.packet.goalSummary),
    exactPaths,
    exactSymbols,
    steps: input.packet.steps.map(step => ({ type: step.type, path: step.path, ...(step.to ? { to: step.to } : {}) })),
    validation,
    restrictions: {
      commitEnabled: input.packet.commit?.enabled === true,
      ...(input.packet.commit?.message ? { commitMessage: boundedText(input.packet.commit.message, 200) } : {}),
      pushAllowed: false as const,
      publishAllowed: false as const,
      deployAllowed: false as const
    },
    budget: {
      maxPacketCycles: input.run.executionBudget.maxPacketCycles,
      maxElapsedMs: input.run.executionBudget.maxElapsedMs,
      advisoryRoadmapProgressTarget: input.run.executionBudget.advisoryRoadmapProgressTarget,
      maxRepairAttempts: input.run.executionBudget.maxRepairAttempts,
      stopConditions: [...input.run.executionBudget.stopConditions],
      consumedPacketCycles: input.run.executionBudget.consumedPacketCycles,
      consumedRepairAttempts: input.run.executionBudget.consumedRepairAttempts
    }
  }
  const contentHash = sha256(canonical(base))
  const contract: PromptPacketTransportContract = {
    ...base,
    contentHash,
    idempotencyKey: `${input.packet.idempotencyKey}:${contentHash.slice(0, 16)}`
  }
  const renderings = {
    human: renderHuman(contract),
    codexManual: renderCodex(contract),
    futureAdapter: renderAdapter(contract)
  }
  if (Object.values(renderings).some(value => !withinBudget(value, maxBytes))) {
    return rejection('output_budget_exceeded', 'Reduce the active packet scope before rendering external transport output.')
  }
  return {
    status: 'external',
    reasonCode: 'external_packet_required',
    nextAction: 'Copy exactly one rendered packet to the selected external executor.',
    contract,
    renderings
  }
}
