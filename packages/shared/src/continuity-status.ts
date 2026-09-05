type RecordLike = Record<string, unknown>

function record(value: unknown): RecordLike | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordLike : undefined
}

function bounded(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized ? normalized.slice(0, limit) : undefined
}

function boundedObject(value: unknown, fields: string[]): RecordLike | undefined {
  const source = record(value)
  if (!source) return undefined
  const result: RecordLike = {}
  for (const field of fields) {
    const item = bounded(source[field], field === 'id' ? 160 : 180)
    if (item) result[field] = item
  }
  return Object.keys(result).length > 0 ? result : undefined
}

export type ActiveRunContinuity = {
  workspace: string
  sourceId: string
  runId: string
  status: string
  phase?: RecordLike
  task?: RecordLike
  lastAcceptedTransition?: string
  currentPosition: string
  blocker?: string
  nextAction?: string
  recommendedReasoning: 'HIGH' | 'MEDIUM' | 'INSTANT'
  recommendedExecutor: 'Workbench' | 'Codex MCP'
}

/** Project only the authoritative bounded resume capsule; never include raw activity or packet data. */
export function projectActiveRunContinuity(value: unknown): ActiveRunContinuity | undefined {
  const payload = record(value)
  const activeRun = record(payload?.activeRun) || payload
  const projection = record(activeRun?.resumeProjection)
  if (!projection) return undefined

  const workspace = bounded(projection.repository, 180)
  const sourceId = bounded(projection.sourceId, 160)
  const runId = bounded(projection.runId, 160)
  const status = bounded(projection.runStatus, 40)
  const currentPosition = bounded(projection.currentPosition, 240)
  if (!workspace || !sourceId || !runId || !status || !currentPosition) return undefined

  const confirmation = record(projection.confirmation)
  const budget = record(projection.budget)
  const handoff = record(activeRun?.handoffProjection)
  const requiredConfirmation = confirmation?.required === true || status === 'needs_confirmation'
  const blocked = typeof projection.blocker === 'string' || status === 'blocked'
  const recommendedReasoning = requiredConfirmation || blocked
    ? 'HIGH'
    : projection.packet && typeof projection.packet === 'object'
      ? 'INSTANT'
      : 'MEDIUM'
  const recommendedExecutor = record(projection.execution)?.engine === 'codex' ? 'Codex MCP' : 'Workbench'
  const phase = boundedObject(projection.phase, ['id', 'title'])
  const task = boundedObject(projection.task, ['id', 'title', 'status'])
  const transition = bounded(handoff?.transition, 60)
  const budgetReason = bounded(budget?.reasonCode, 80)
  const blocker = budget?.exhausted === true && budgetReason
    ? `Budget exhausted: ${budgetReason}`
    : bounded(projection.blocker, 240)
  const nextAction = bounded(projection.nextAction, 240)

  return {
    workspace,
    sourceId,
    runId,
    status,
    ...(phase ? { phase } : {}),
    ...(task ? { task } : {}),
    ...(transition ? { lastAcceptedTransition: transition } : {}),
    currentPosition,
    ...(blocker ? { blocker } : {}),
    ...(nextAction ? { nextAction } : {}),
    recommendedReasoning,
    recommendedExecutor
  }
}
