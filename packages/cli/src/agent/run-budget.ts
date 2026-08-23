export const RUN_EXECUTION_BUDGET_SCHEMA_VERSION = 1 as const

export type RunBudgetReasonCode =
  | 'packet_cycles_exhausted'
  | 'repair_attempts_exhausted'
  | 'elapsed_window_exhausted'
  | 'roadmap_target_reached'

export type RunBudgetStopCondition =
  | 'confirmation_required'
  | 'prerequisite_blocked'
  | 'policy_blocked'
  | 'stale_head'
  | 'validation_failed'
  | 'packet_cycles_exhausted'
  | 'repair_attempts_exhausted'
  | 'elapsed_window_exhausted'

export type RunExecutionBudget = {
  schemaVersion: typeof RUN_EXECUTION_BUDGET_SCHEMA_VERSION
  maxPacketCycles: number
  maxElapsedMs: number
  advisoryRoadmapProgressTarget: number
  maxRepairAttempts: number
  stopConditions: RunBudgetStopCondition[]
  consumedPacketCycles: number
  consumedRepairAttempts: number
  consumedPacketIds: string[]
  executionWindowStartedAt: string
  exhausted: boolean
  reasonCode?: RunBudgetReasonCode
}

export type RunExecutionBudgetLimits = Partial<Pick<
  RunExecutionBudget,
  'maxPacketCycles' | 'maxElapsedMs' | 'advisoryRoadmapProgressTarget' | 'maxRepairAttempts' | 'stopConditions'
>>

export const DEFAULT_RUN_EXECUTION_BUDGET: Readonly<Pick<
  RunExecutionBudget,
  'maxPacketCycles' | 'maxElapsedMs' | 'advisoryRoadmapProgressTarget' | 'maxRepairAttempts' | 'stopConditions'
>> = {
  maxPacketCycles: 3,
  maxElapsedMs: 45 * 60 * 1000,
  advisoryRoadmapProgressTarget: 8,
  maxRepairAttempts: 1,
  stopConditions: [
    'confirmation_required',
    'prerequisite_blocked',
    'policy_blocked',
    'stale_head',
    'validation_failed',
    'packet_cycles_exhausted',
    'repair_attempts_exhausted',
    'elapsed_window_exhausted'
  ]
}

const MAX_PACKET_CYCLES = 40
const MAX_ELAPSED_MS = 4 * 60 * 60 * 1000
const MAX_REPAIR_ATTEMPTS = 3
const MAX_PACKET_IDS = 100
const STOP_CONDITIONS = new Set<RunBudgetStopCondition>(DEFAULT_RUN_EXECUTION_BUDGET.stopConditions)

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.floor(numeric)))
}

function normalizeIso(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback
}

function normalizeStopConditions(value: unknown): RunBudgetStopCondition[] {
  const requested = Array.isArray(value)
    ? value.filter((item): item is RunBudgetStopCondition => typeof item === 'string' && STOP_CONDITIONS.has(item as RunBudgetStopCondition))
    : []
  return Array.from(new Set([...DEFAULT_RUN_EXECUTION_BUDGET.stopConditions, ...requested]))
}

function normalizePacketIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim().slice(0, 160)))).slice(-MAX_PACKET_IDS)
}

export function createRunExecutionBudget(limits: RunExecutionBudgetLimits = {}, now = new Date().toISOString()): RunExecutionBudget {
  return normalizeRunExecutionBudget({ ...limits, executionWindowStartedAt: now }, now)
}

export function normalizeRunExecutionBudget(value: unknown, now = new Date().toISOString()): RunExecutionBudget {
  const item = value && typeof value === 'object' ? value as Partial<RunExecutionBudget> : {}
  const consumedPacketIds = normalizePacketIds(item.consumedPacketIds)
  const consumedPacketCycles = Math.max(consumedPacketIds.length, boundedInteger(item.consumedPacketCycles, 0, 0, MAX_PACKET_CYCLES))
  const consumedRepairAttempts = boundedInteger(item.consumedRepairAttempts, 0, 0, MAX_REPAIR_ATTEMPTS)
  const budget: RunExecutionBudget = {
    schemaVersion: RUN_EXECUTION_BUDGET_SCHEMA_VERSION,
    maxPacketCycles: boundedInteger(item.maxPacketCycles, DEFAULT_RUN_EXECUTION_BUDGET.maxPacketCycles, 1, MAX_PACKET_CYCLES),
    maxElapsedMs: boundedInteger(item.maxElapsedMs, DEFAULT_RUN_EXECUTION_BUDGET.maxElapsedMs, 1, MAX_ELAPSED_MS),
    advisoryRoadmapProgressTarget: boundedInteger(item.advisoryRoadmapProgressTarget, DEFAULT_RUN_EXECUTION_BUDGET.advisoryRoadmapProgressTarget, 0, 100),
    maxRepairAttempts: boundedInteger(item.maxRepairAttempts, DEFAULT_RUN_EXECUTION_BUDGET.maxRepairAttempts, 0, MAX_REPAIR_ATTEMPTS),
    stopConditions: normalizeStopConditions(item.stopConditions),
    consumedPacketCycles,
    consumedRepairAttempts,
    consumedPacketIds,
    executionWindowStartedAt: normalizeIso(item.executionWindowStartedAt, normalizeIso(now, new Date(0).toISOString())),
    exhausted: item.exhausted === true,
    reasonCode: typeof item.reasonCode === 'string' ? item.reasonCode as RunBudgetReasonCode : undefined
  }
  return evaluateRunExecutionBudget(budget, { now }).budget
}

export function narrowRunExecutionBudget(current: RunExecutionBudget, requested: RunExecutionBudgetLimits, now = current.executionWindowStartedAt): RunExecutionBudget {
  const next = normalizeRunExecutionBudget({ ...current, ...requested }, now)
  if (next.maxPacketCycles > current.maxPacketCycles) throw new Error('Run budget cannot broaden maxPacketCycles')
  if (next.maxElapsedMs > current.maxElapsedMs) throw new Error('Run budget cannot broaden maxElapsedMs')
  if (next.advisoryRoadmapProgressTarget > current.advisoryRoadmapProgressTarget) throw new Error('Run budget cannot broaden advisoryRoadmapProgressTarget')
  if (next.maxRepairAttempts > current.maxRepairAttempts) throw new Error('Run budget cannot broaden maxRepairAttempts')
  if (next.stopConditions.some(condition => !current.stopConditions.includes(condition))) throw new Error('Run budget cannot broaden stopConditions')
  return evaluateRunExecutionBudget({
    ...current,
    maxPacketCycles: next.maxPacketCycles,
    maxElapsedMs: next.maxElapsedMs,
    advisoryRoadmapProgressTarget: next.advisoryRoadmapProgressTarget,
    maxRepairAttempts: next.maxRepairAttempts,
    stopConditions: next.stopConditions
  }, { now }).budget
}

export function consumeRunPacketCycle(budget: RunExecutionBudget, packetId: string, now: string): RunExecutionBudget {
  const normalizedId = String(packetId || '').trim().slice(0, 160)
  if (!normalizedId || budget.consumedPacketIds.includes(normalizedId)) return evaluateRunExecutionBudget(budget, { now }).budget
  const consumedPacketIds = [...budget.consumedPacketIds, normalizedId].slice(-MAX_PACKET_IDS)
  return evaluateRunExecutionBudget({
    ...budget,
    consumedPacketIds,
    consumedPacketCycles: Math.max(budget.consumedPacketCycles + 1, consumedPacketIds.length)
  }, { now }).budget
}

export function synchronizeRunRepairAttempts(budget: RunExecutionBudget, attempts: number, now: string): RunExecutionBudget {
  return evaluateRunExecutionBudget({
    ...budget,
    consumedRepairAttempts: Math.max(budget.consumedRepairAttempts, boundedInteger(attempts, budget.consumedRepairAttempts, 0, MAX_REPAIR_ATTEMPTS))
  }, { now, operation: 'continue' }).budget
}

export function consumeRunRepairAttempt(budget: RunExecutionBudget, now: string): RunExecutionBudget {
  return evaluateRunExecutionBudget({
    ...budget,
    consumedRepairAttempts: Math.min(MAX_REPAIR_ATTEMPTS, budget.consumedRepairAttempts + 1)
  }, { now, operation: 'continue' }).budget
}

/**
 * Freeze the wall-clock budget while a run is paused. The remaining active
 * execution allowance is narrowed; time spent paused is never counted.
 */
export function pauseRunExecutionBudget(budget: RunExecutionBudget, now: string): RunExecutionBudget {
  const evaluated = evaluateRunExecutionBudget(budget, { now, operation: 'continue' }).budget
  if (evaluated.exhausted) return evaluated
  const nowMs = Date.parse(now)
  const startedMs = Date.parse(budget.executionWindowStartedAt)
  const elapsedMs = Number.isFinite(nowMs) && Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : 0
  return {
    ...evaluated,
    maxElapsedMs: Math.max(1, evaluated.maxElapsedMs - elapsedMs),
    executionWindowStartedAt: normalizeIso(now, evaluated.executionWindowStartedAt),
    exhausted: false,
    reasonCode: undefined
  }
}

/** Rebase a non-exhausted paused run onto a new active execution window. */
export function resumeRunExecutionBudget(budget: RunExecutionBudget, now: string): RunExecutionBudget {
  if (budget.exhausted) return budget
  return evaluateRunExecutionBudget({
    ...budget,
    executionWindowStartedAt: normalizeIso(now, budget.executionWindowStartedAt),
    exhausted: false,
    reasonCode: undefined
  }, { now, operation: 'continue' }).budget
}

export function evaluateRunExecutionBudget(
  budgetInput: RunExecutionBudget,
  params: { now: string; roadmapProgressDelta?: number; operation?: 'continue' | 'repair' }
): { budget: RunExecutionBudget; exhausted: boolean; reasonCode?: RunBudgetReasonCode; advisoryTargetReached: boolean } {
  const nowMs = Date.parse(params.now)
  const startedMs = Date.parse(budgetInput.executionWindowStartedAt)
  const elapsedMs = Number.isFinite(nowMs) && Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : 0
  let reasonCode: RunBudgetReasonCode | undefined
  if (budgetInput.stopConditions.includes('packet_cycles_exhausted') && budgetInput.consumedPacketCycles >= budgetInput.maxPacketCycles) reasonCode = 'packet_cycles_exhausted'
  else if (params.operation === 'repair' && budgetInput.stopConditions.includes('repair_attempts_exhausted') && budgetInput.consumedRepairAttempts >= budgetInput.maxRepairAttempts) reasonCode = 'repair_attempts_exhausted'
  else if (budgetInput.stopConditions.includes('elapsed_window_exhausted') && elapsedMs >= budgetInput.maxElapsedMs) reasonCode = 'elapsed_window_exhausted'
  const advisoryTargetReached = Math.max(0, Number(params.roadmapProgressDelta || 0)) >= budgetInput.advisoryRoadmapProgressTarget
  const exhausted = Boolean(reasonCode)
  const budget: RunExecutionBudget = { ...budgetInput, exhausted, reasonCode }
  return { budget, exhausted, reasonCode, advisoryTargetReached }
}
