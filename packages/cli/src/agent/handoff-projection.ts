import crypto from 'crypto'
import type { ResumeProjection } from './resume-projection'

export type HandoffTransition =
  | 'packet_completed'
  | 'validation_completed'
  | 'confirmation_changed'
  | 'paused'
  | 'blocked'
  | 'budget_exhausted'
  | 'commit_recorded'
  | 'recovered'
  | 'run_closed'

export type HandoffProjection = {
  version: 1
  transition: HandoffTransition
  sourceId: string
  runId: string
  status: string
  currentPosition: string
  blocker?: string
  nextAction?: string
  validationState: string
  budgetState: string
  commit?: string
  projectionHash: string
  contentHash: string
  markdown: string
}

export type HandoffWriteResult = {
  written: boolean
  unchanged: boolean
  failed: boolean
  contentHash: string
  errorCode?: 'handoff_write_failed'
}

const MAX_TEXT = 240

function bounded(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized ? normalized.slice(0, max) : undefined
}

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

export function classifyHandoffTransition(previous: ResumeProjection | undefined, current: ResumeProjection): HandoffTransition | undefined {
  if (!previous) return 'recovered'
  if (previous.runStatus !== current.runStatus) {
    if (current.runStatus === 'completed' || current.runStatus === 'failed' || current.runStatus === 'cancelled') return 'run_closed'
    if (current.runStatus === 'needs_confirmation' || previous.confirmation.required !== current.confirmation.required) return 'confirmation_changed'
    if (current.runStatus === 'paused') return current.budget.exhausted ? 'budget_exhausted' : 'paused'
    if (current.runStatus === 'blocked') return 'blocked'
  }
  if (previous.packet?.id !== current.packet?.id || previous.packet?.status !== current.packet?.status) {
    if (current.packet?.status === 'completed') return 'packet_completed'
  }
  if (previous.validation.state !== current.validation.state && current.validation.state !== 'pending') return 'validation_completed'
  if (previous.currentHead !== current.currentHead && current.currentHead) return 'commit_recorded'
  if (previous.budget.exhausted !== current.budget.exhausted && current.budget.exhausted) return 'budget_exhausted'
  return undefined
}

export function buildHandoffProjection(params: {
  transition: HandoffTransition
  projection: ResumeProjection
  commit?: string
}): HandoffProjection {
  const projection = params.projection
  const blocker = bounded(projection.blocker || projection.confirmation.reason)
  const nextAction = bounded(projection.nextAction)
  const commit = bounded(params.commit || projection.currentHead, 64)
  const budgetState = projection.budget.exhausted
    ? `exhausted:${projection.budget.reasonCode || 'unknown'}`
    : `${projection.budget.packetCycles.consumed}/${projection.budget.packetCycles.maximum} packets`
  const lines = [
    '# Workbench Resume Handoff',
    '',
    `- Source: ${projection.sourceId}`,
    `- Run: ${projection.runId}`,
    `- Status: ${projection.runStatus}`,
    `- Transition: ${params.transition}`,
    `- Current position: ${bounded(projection.currentPosition) || 'No active task'}`,
    `- Validation: ${projection.validation.state}`,
    `- Budget: ${budgetState}`,
    blocker ? `- Blocker: ${blocker}` : undefined,
    nextAction ? `- Next action: ${nextAction}` : undefined,
    commit ? `- Commit: ${commit}` : undefined,
    `- Resume projection: ${projection.contentHash}`,
    ''
  ].filter((line): line is string => typeof line === 'string')
  const markdown = `${lines.join('\n')}\n`
  return {
    version: 1,
    transition: params.transition,
    sourceId: projection.sourceId,
    runId: projection.runId,
    status: projection.runStatus,
    currentPosition: bounded(projection.currentPosition) || 'No active task',
    ...(blocker ? { blocker } : {}),
    ...(nextAction ? { nextAction } : {}),
    validationState: projection.validation.state,
    budgetState,
    ...(commit ? { commit } : {}),
    projectionHash: projection.contentHash,
    contentHash: hash(markdown),
    markdown
  }
}

export function writeHandoffProjection(params: {
  handoff: HandoffProjection
  readCurrent: () => string | undefined
  writeAtomic: (content: string) => void
}): HandoffWriteResult {
  try {
    const current = params.readCurrent()
    if (typeof current === 'string' && hash(current) === params.handoff.contentHash) {
      return { written: false, unchanged: true, failed: false, contentHash: params.handoff.contentHash }
    }
    params.writeAtomic(params.handoff.markdown)
    return { written: true, unchanged: false, failed: false, contentHash: params.handoff.contentHash }
  } catch {
    return { written: false, unchanged: false, failed: true, contentHash: params.handoff.contentHash, errorCode: 'handoff_write_failed' }
  }
}
