import { NextRequest, NextResponse } from 'next/server'
import { checkActionAuth } from '@/lib/actionAuth'
import { executeAction, ActionTransportError } from '@/lib/actions/transport'
import { buildActionErrorEnvelope } from '@/lib/actions/action-response'
import { makeActivity, withActivity } from '@/lib/actions/gpt'

export async function POST(request: NextRequest) {
  const auth = checkActionAuth(request)
  if (!auth.valid) return auth.error

  try {
    const body = await request.json()
    const data = await executeAction('/api/agent-jobs/execute-task', body, auth.bearerToken)
    const record = data as Record<string, unknown>
    const stepResults = Array.isArray(record.stepResults) ? record.stepResults : []
    const failedAt = record.failedAt as { phase?: string; error?: string } | undefined
    return NextResponse.json(withActivity(record, makeActivity({
      operationId: 'executeBuildFlowTask',
      phase: record.status === 'completed' ? 'completed' : 'failed',
      actionLabel: record.status === 'completed' ? 'Task executed' : 'Task failed',
      userMessage: record.status === 'completed'
        ? `Task completed through ${record.completedPhase} phase in ${record.durationMs}ms.`
        : `Task failed at ${failedAt?.phase || 'unknown'}: ${failedAt?.error || 'unknown'}`,
      riskLevel: 'medium',
      requiresConfirmation: false,
      verified: record.status === 'completed',
      whatHappened: [`Executed ${stepResults.length} steps`, `Completed phase: ${record.completedPhase}`],
      provenFacts: [record.status === 'completed' ? 'All phases passed' : `Failed at: ${failedAt?.error || 'unknown'}`],
      nextActions: record.status === 'completed' ? ['Continue to next task', 'Update job status'] : ['Fix the failure', 'Retry the task']
    })))
  } catch (err) {
    if (err instanceof ActionTransportError) {
      return NextResponse.json(buildActionErrorEnvelope({ code: 'ACTION_TRANSPORT_ERROR', message: err.message }), { status: err.statusCode })
    }
    return NextResponse.json(buildActionErrorEnvelope({ code: 'EXECUTE_TASK_ERROR', message: err instanceof Error ? err.message : String(err) }), { status: 500 })
  }
}
