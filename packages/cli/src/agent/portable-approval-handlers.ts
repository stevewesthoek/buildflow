import type { PortableOperationHandlers } from '../../../../apps/web/src/lib/actions/portable-operation-dispatcher'
import { PortableOperationError } from '../../../../apps/web/src/lib/actions/portable-operation-errors'
import { decidePendingApprovalIntent, getPendingApprovalIntent, type WorkbenchApprovalIntentRecord } from './workbench-approval-intents'
import { getWorkbenchSession, type WorkbenchSessionRecord, type WorkbenchSessionStoreFailure } from './workbench-session-store'
import { workbenchSessionIdForRun } from './workbench-run-session'

type Payload = Record<string, unknown>

function isSessionFailure(value: WorkbenchSessionRecord | WorkbenchSessionStoreFailure | undefined): value is WorkbenchSessionStoreFailure {
  return value !== undefined && 'ok' in value && value.ok === false
}

type NativeApprovalIntentProjection = {
  approvalId: string
  sourceId: string
  runId: string
  operationKind: string
  paths: string[]
  reason: string
  status: WorkbenchApprovalIntentRecord['status']
  expiresAt: string
  decidedAt?: string
  consumedAt?: string
}

function requireString(payload: Payload, key: string): string {
  const value = payload[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new PortableOperationError('invalid_request', `${key} is required`)
  }
  return value.trim()
}

function project(record: WorkbenchApprovalIntentRecord): NativeApprovalIntentProjection {
  return {
    approvalId: record.approvalId,
    sourceId: record.sourceId,
    runId: record.runId,
    operationKind: record.operationKind,
    paths: [...record.paths],
    reason: record.reason,
    status: record.status,
    expiresAt: record.expiresAt,
    ...(record.decidedAt ? { decidedAt: record.decidedAt } : {}),
    ...(record.consumedAt ? { consumedAt: record.consumedAt } : {})
  }
}

function loadBoundIntent(approvalId: string, sourceId: string, runId: string): { record: WorkbenchApprovalIntentRecord; sessionId?: string } {
  const loaded = getPendingApprovalIntent(approvalId)
  if (!loaded) throw new PortableOperationError('invalid_request', 'Approval intent was not found.')
  if ('ok' in loaded && loaded.ok === false) throw new PortableOperationError('dependency_unavailable', loaded.message)
  const record = loaded as WorkbenchApprovalIntentRecord
  if (record.sourceId !== sourceId || record.runId !== runId) {
    throw new PortableOperationError('source_mismatch', 'Approval intent source/run binding does not match.')
  }
  if (!record.sessionId) return { record }

  const sessionId = workbenchSessionIdForRun(runId)
  if (record.sessionId !== sessionId) {
    throw new PortableOperationError('source_mismatch', 'Approval intent session binding does not match the canonical run session.')
  }
  const session = getWorkbenchSession(sessionId)
  if (!session || isSessionFailure(session)) {
    throw new PortableOperationError('dependency_unavailable', 'Canonical run session is unavailable.')
  }
  if (!session.lockedSourceIds.includes(sourceId) || session.activeRunId !== runId) {
    throw new PortableOperationError('source_mismatch', 'Canonical run session is not active for this approval intent.')
  }
  return { record, sessionId }
}

export function createPortableApprovalHandlers(): PortableOperationHandlers {
  return {
    manageWorkbenchApprovalIntent: (payload, context) => {
      const p = payload as Payload
      const allowedKeys = new Set(['approvalId', 'runId', 'action'])
      const unexpectedKeys = Object.keys(p).filter(key => !allowedKeys.has(key))
      if (unexpectedKeys.length > 0) {
        throw new PortableOperationError('invalid_request', `Unsupported approval payload field: ${unexpectedKeys.sort()[0]}`)
      }
      const approvalId = requireString(p, 'approvalId')
      const runId = requireString(p, 'runId')
      const action = requireString(p, 'action')
      if (!['status', 'approve', 'deny'].includes(action)) {
        throw new PortableOperationError('invalid_request', 'action must be status, approve, or deny')
      }
      const sourceId = context.sourceId
      if (!sourceId) throw new PortableOperationError('source_mismatch', 'Canonical sourceId is required by the native envelope.')
      const bound = loadBoundIntent(approvalId, sourceId, runId)
      if (action === 'status') return { status: 'ok', intent: project(bound.record) }

      const decided = decidePendingApprovalIntent({
        approvalId,
        sourceId,
        runId,
        sessionId: bound.sessionId,
        decision: action === 'approve' ? 'approve' : 'deny'
      })
      if (decided.ok === false) {
        const code = decided.code === 'APPROVAL_INTENT_BINDING_MISMATCH' ? 'source_mismatch'
          : decided.code === 'APPROVAL_INTENT_STORE_BUSY' || decided.code === 'APPROVAL_INTENT_STORE_CORRUPT' ? 'dependency_unavailable'
          : 'invalid_request'
        throw new PortableOperationError(code, decided.message)
      }
      return { status: 'ok', changed: decided.changed, intent: project(decided.record) }
    }
  }
}
