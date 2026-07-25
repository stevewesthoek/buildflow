import crypto from 'crypto'
import type { AgentJob, AgentJobStatus, AgentAutonomyLevel } from './agent-jobs'
import type { WorkbenchPacketRecord, WorkbenchPacketStatus } from './workbench-packet-store'

export const RESUME_PROJECTION_SCHEMA_VERSION = 1 as const

export type ResumeValidationState = 'pending' | 'passed' | 'failed' | 'unknown'

export type ResumeProjection = {
  schemaVersion: typeof RESUME_PROJECTION_SCHEMA_VERSION
  sourceId: string
  repository: string
  runId: string
  runStatus: AgentJobStatus
  phase?: { id: string; title: string }
  task?: { id: string; title: string; status: string }
  packet?: {
    id: string
    status: WorkbenchPacketStatus
    taskId: string
    expectedHead: string
  }
  currentHead?: string
  confirmation: {
    required: boolean
    reason?: string
  }
  blocker?: string
  validation: {
    state: ResumeValidationState
    requiredCount: number
  }
  execution: {
    engine: 'direct'
    autonomy: AgentAutonomyLevel
  }
  budget: {
    schemaVersion: number
    packetCycles: { consumed: number; maximum: number }
    repairAttempts: { consumed: number; maximum: number }
    maxElapsedMs: number
    advisoryRoadmapProgressTarget: number
    exhausted: boolean
    reasonCode?: string
  }
  currentPosition: string
  nextAction?: string
  freshness: {
    runVersion: number
    planVersion: number
    sourceId: string
    expectedHead?: string
    currentHead?: string
    policyIdentity: string
    confirmationIdentity: string
    taskIdentity?: string
    packetIdentity?: string
  }
  contentHash: string
}

export type ResumeProjectionInput = {
  run: AgentJob
  packet?: Pick<WorkbenchPacketRecord, 'status' | 'packet'>
  policyIdentity?: string
  repository?: string
}

const MAX_ID = 160
const MAX_TITLE = 180
const MAX_REASON = 240
const MAX_ACTION = 240
const DEFAULT_POLICY_IDENTITY = 'default-policy'

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) return undefined
  return normalized.slice(0, max)
}

function safeId(value: unknown): string {
  return boundedText(value, MAX_ID) || 'unknown'
}

function activePhaseAndTask(run: AgentJob) {
  for (const phase of Array.isArray(run.roadmapPhases) ? run.roadmapPhases : []) {
    const task = phase.tasks.find(item => item.id === run.activeTaskId)
      || phase.tasks.find(item => item.status === 'running' || item.status === 'blocked' || item.status === 'failed')
    if (task) return { phase, task }
  }
  return { phase: undefined, task: undefined }
}

function validationState(run: AgentJob, packet?: ResumeProjectionInput['packet']): ResumeValidationState {
  if (packet?.status === 'failed' || run.status === 'failed') return 'failed'
  if (packet?.status === 'completed' || run.status === 'completed') return 'passed'
  if (run.status === 'queued' || run.status === 'running' || run.status === 'paused' || run.status === 'blocked' || run.status === 'needs_confirmation') return 'pending'
  return 'unknown'
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`
}

function hashProjection(value: Omit<ResumeProjection, 'contentHash'>): string {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex')
}

export function buildResumeProjection(input: ResumeProjectionInput): ResumeProjection {
  const run = input.run
  const { phase, task } = activePhaseAndTask(run)
  const packet = input.packet
  const expectedHead = boundedText(packet?.packet.expectedHead, 64)
  const currentHead = boundedText(run.currentCommit, 64)
  const blocker = boundedText(run.blockedReason || run.confirmationReason, MAX_REASON)
  const confirmationReason = boundedText(run.confirmationReason, MAX_REASON)
  const nextAction = boundedText(run.nextActions?.[0] || run.resumeState?.instructions?.[0], MAX_ACTION)
  const repository = boundedText(input.repository || run.sourceId, MAX_TITLE) || 'unknown'
  const policyIdentity = safeId(input.policyIdentity || DEFAULT_POLICY_IDENTITY)
  const confirmationIdentity = `${run.requiresConfirmation === true ? 'required' : 'clear'}:${confirmationReason || 'none'}`.slice(0, MAX_REASON)
  const taskIdentity = task ? `${safeId(phase?.id)}:${safeId(task.id)}:${task.status}` : undefined
  const packetIdentity = packet
    ? `${safeId(packet.packet.packetId)}:${packet.status}:${safeId(packet.packet.taskId)}:${expectedHead || 'unknown'}`
    : run.activePacketId
      ? `${safeId(run.activePacketId)}:unknown`
      : undefined
  const requiredCount = Math.min(20, Array.isArray(task?.validation) ? task.validation.length : 0)
  const currentPosition = boundedText(
    phase && task ? `${phase.title} → ${task.title}` : run.summary || run.goal,
    MAX_ACTION
  ) || 'No active task'

  const withoutHash: Omit<ResumeProjection, 'contentHash'> = {
    schemaVersion: RESUME_PROJECTION_SCHEMA_VERSION,
    sourceId: safeId(run.sourceId),
    repository,
    runId: safeId(run.id),
    runStatus: run.status,
    ...(phase ? { phase: { id: safeId(phase.id), title: boundedText(phase.title, MAX_TITLE) || 'Untitled phase' } } : {}),
    ...(task ? { task: { id: safeId(task.id), title: boundedText(task.title, MAX_TITLE) || 'Untitled task', status: task.status } } : {}),
    ...(packet ? {
      packet: {
        id: safeId(packet.packet.packetId),
        status: packet.status,
        taskId: safeId(packet.packet.taskId),
        expectedHead: expectedHead || 'unknown'
      }
    } : {}),
    ...(currentHead ? { currentHead } : {}),
    confirmation: {
      required: run.requiresConfirmation === true || run.status === 'needs_confirmation',
      ...(confirmationReason ? { reason: confirmationReason } : {})
    },
    ...(blocker ? { blocker } : {}),
    validation: {
      state: validationState(run, packet),
      requiredCount
    },
    execution: {
      engine: 'direct',
      autonomy: run.autonomyLevel || 'supervised'
    },
    budget: {
      schemaVersion: run.executionBudget.schemaVersion,
      packetCycles: {
        consumed: run.executionBudget.consumedPacketCycles,
        maximum: run.executionBudget.maxPacketCycles
      },
      repairAttempts: {
        consumed: run.executionBudget.consumedRepairAttempts,
        maximum: run.executionBudget.maxRepairAttempts
      },
      maxElapsedMs: run.executionBudget.maxElapsedMs,
      advisoryRoadmapProgressTarget: run.executionBudget.advisoryRoadmapProgressTarget,
      exhausted: run.executionBudget.exhausted,
      ...(run.executionBudget.reasonCode ? { reasonCode: run.executionBudget.reasonCode } : {})
    },
    currentPosition,
    ...(nextAction ? { nextAction } : {}),
    freshness: {
      runVersion: Number.isFinite(run.runVersion) ? run.runVersion : 1,
      planVersion: Number.isFinite(run.planVersion) ? Math.max(1, Math.floor(run.planVersion)) : 1,
      sourceId: safeId(run.sourceId),
      ...(expectedHead ? { expectedHead } : {}),
      ...(currentHead ? { currentHead } : {}),
      policyIdentity,
      confirmationIdentity,
      ...(taskIdentity ? { taskIdentity } : {}),
      ...(packetIdentity ? { packetIdentity } : {})
    }
  }

  return { ...withoutHash, contentHash: hashProjection(withoutHash) }
}

export function isResumeProjectionFresh(projection: ResumeProjection, input: ResumeProjectionInput): boolean {
  return projection.contentHash === buildResumeProjection(input).contentHash
}
