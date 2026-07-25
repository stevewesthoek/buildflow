import type { AgentJob } from './agent-jobs'
import type { WorkbenchPacketRecord } from './workbench-packet-store'
import { buildResumeProjection, isResumeProjectionFresh, type ResumeProjection } from './resume-projection'
import { evaluateRunExecutionBudget } from './run-budget'

export type ResumeStopReason =
  | 'no_active_run'
  | 'source_mismatch'
  | 'terminal_run'
  | 'confirmation_required'
  | 'blocked_run'
  | 'budget_exhausted'
  | 'stale_projection'

export type ResumeWorkflowDecision = {
  eligible: boolean
  reason?: ResumeStopReason
  nextAction: string
  projection?: ResumeProjection
  rebuiltProjection: boolean
}

export type ResumeWorkflowInput = {
  lockedSourceId: string
  run?: AgentJob
  packet?: Pick<WorkbenchPacketRecord, 'status' | 'packet'>
  projection?: ResumeProjection
  policyIdentity?: string
  repository?: string
  now: string
}

export function evaluateResumeWorkflow(input: ResumeWorkflowInput): ResumeWorkflowDecision {
  const sourceId = String(input.lockedSourceId || '').trim()
  const run = input.run
  if (!run) return { eligible: false, reason: 'no_active_run', nextAction: 'Create a bounded Workbench run.', rebuiltProjection: false }
  if (!sourceId || run.sourceId !== sourceId) return { eligible: false, reason: 'source_mismatch', nextAction: 'Lock the correct source before resuming.', rebuiltProjection: false }

  const terminal = ['completed', 'failed', 'cancelled'].includes(run.status)
  if (terminal) return { eligible: false, reason: 'terminal_run', nextAction: 'Start a new bounded run or use an explicit recovery contract.', rebuiltProjection: false }

  const projectionInput = {
    run,
    packet: input.packet,
    policyIdentity: input.policyIdentity,
    repository: input.repository
  }
  const projectionFresh = input.projection ? isResumeProjectionFresh(input.projection, projectionInput) : false
  const projection = projectionFresh ? input.projection! : buildResumeProjection(projectionInput)
  const rebuiltProjection = !projectionFresh

  if (run.status === 'needs_confirmation' || run.requiresConfirmation) {
    return { eligible: false, reason: 'confirmation_required', nextAction: 'Resolve the explicit confirmation requirement.', projection, rebuiltProjection }
  }
  if (run.status === 'blocked') {
    return { eligible: false, reason: 'blocked_run', nextAction: projection.nextAction || 'Resolve the persisted blocker.', projection, rebuiltProjection }
  }

  const budget = evaluateRunExecutionBudget(run.executionBudget, { now: input.now, operation: 'continue' })
  if (budget.exhausted) {
    return { eligible: false, reason: 'budget_exhausted', nextAction: `Run budget exhausted: ${budget.reasonCode}`, projection, rebuiltProjection }
  }

  return {
    eligible: true,
    nextAction: projection.nextAction || 'Continue the active packet or task.',
    projection,
    rebuiltProjection
  }
}
