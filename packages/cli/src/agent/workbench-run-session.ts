import {
  createWorkbenchSession,
  getWorkbenchSession,
  updateWorkbenchSession,
  type WorkbenchSessionRecord,
  type WorkbenchSessionStoreFailure,
  type WorkbenchSessionStoreOptions
} from './workbench-session-store'

export type WorkbenchRunSessionInput = {
  id: string
  sourceId: string
  status: string
  activeTaskId?: string
}

export type WorkbenchRunSessionResult =
  | { ok: true; sessionId: string; session?: WorkbenchSessionRecord }
  | WorkbenchSessionStoreFailure

export function workbenchSessionIdForRun(runId: string): string {
  return `session-${runId}`
}

function desiredSessionStatus(status: string): WorkbenchSessionRecord['status'] {
  switch (status) {
    case 'queued':
    case 'running':
    case 'needs_confirmation':
      return 'active'
    case 'paused':
      return 'paused'
    case 'blocked':
    case 'failed':
      return 'recovery_required'
    case 'completed':
    case 'cancelled':
      return 'completed'
    default:
      return 'recovery_required'
  }
}

function isSessionFailure(
  value: WorkbenchSessionRecord | WorkbenchSessionStoreFailure | undefined
): value is WorkbenchSessionStoreFailure {
  return value !== undefined && 'ok' in value && value.ok === false
}

export function synchronizeWorkbenchRunSession(
  run: WorkbenchRunSessionInput,
  options?: WorkbenchSessionStoreOptions
): WorkbenchRunSessionResult {
  const sessionId = workbenchSessionIdForRun(run.id)
  const status = desiredSessionStatus(run.status)
  const existing = getWorkbenchSession(sessionId, options)
  if (isSessionFailure(existing)) return existing

  if (!existing) {
    if (status === 'completed') return { ok: true, sessionId }
    const created = createWorkbenchSession({
      sessionId,
      lockedSourceIds: [run.sourceId],
      activeRunId: run.id,
      activeTaskId: run.activeTaskId
    }, options)
    return created.ok === false
      ? created
      : { ok: true, sessionId, session: created.session }
  }

  if (existing.lockedSourceIds.length !== 1 || existing.lockedSourceIds[0] !== run.sourceId) {
    return { ok: false, code: 'SESSION_SOURCE_DRIFT', message: 'Run-bound session source ownership cannot change.' }
  }
  if (existing.activeRunId !== undefined && existing.activeRunId !== run.id) {
    return { ok: false, code: 'SESSION_DUPLICATE_CONFLICT', message: 'Run-bound session identity belongs to different active work.' }
  }

  const terminal = status === 'completed'
  const activeRunId = terminal ? undefined : run.id
  const activeTaskId = terminal ? undefined : run.activeTaskId
  if (existing.status === status
    && existing.activeRunId === activeRunId
    && existing.activeTaskId === activeTaskId) {
    return { ok: true, sessionId, session: existing }
  }

  const updated = updateWorkbenchSession(sessionId, {
    expectedRevision: existing.revision,
    status,
    activeRunId: terminal ? null : run.id,
    activeTaskId: terminal || !run.activeTaskId ? null : run.activeTaskId,
    now: (options?.now?.() || new Date()).toISOString()
  }, options)
  return updated.ok === false
    ? updated
    : { ok: true, sessionId, session: updated.session }
}
