export const WORKBENCH_STALE_RUN_AFTER_MS = 15 * 60 * 1000
export const WORKBENCH_STALE_RUN_REASON = 'stale_run_no_recent_activity'

export type RunLivenessInput = {
  status: string
  updatedAt: string
  lastEventAt?: string
  now?: string
  staleAfterMs?: number
}

export type RunLivenessAssessment = {
  stale: boolean
  lastSignalAt: string
  ageMs: number
  reason?: typeof WORKBENCH_STALE_RUN_REASON
}

function timestamp(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function assessWorkbenchRunLiveness(input: RunLivenessInput): RunLivenessAssessment {
  const nowMs = timestamp(input.now) ?? Date.now()
  const updatedMs = timestamp(input.updatedAt) ?? nowMs
  const eventMs = timestamp(input.lastEventAt)
  const lastMs = Math.max(updatedMs, eventMs ?? Number.NEGATIVE_INFINITY)
  const lastSignalAt = new Date(lastMs === Number.NEGATIVE_INFINITY ? nowMs : lastMs).toISOString()
  const ageMs = Math.max(0, nowMs - (lastMs === Number.NEGATIVE_INFINITY ? nowMs : lastMs))
  const stale = (input.status === 'running' || input.status === 'queued')
    && ageMs > Math.max(1_000, input.staleAfterMs ?? WORKBENCH_STALE_RUN_AFTER_MS)

  return {
    stale,
    lastSignalAt,
    ageMs,
    ...(stale ? { reason: WORKBENCH_STALE_RUN_REASON } : {})
  }
}

export function isReconciledStaleWorkbenchRun(run: { status: string; blockedReason?: string }): boolean {
  return run.status === 'paused' && run.blockedReason?.startsWith(`${WORKBENCH_STALE_RUN_REASON}:`) === true
}
