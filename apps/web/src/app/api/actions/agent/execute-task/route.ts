import { NextRequest, NextResponse } from 'next/server'
import { checkActionAuth } from '@/lib/actionAuth'
import { executeAction, ActionTransportError } from '@/lib/actions/transport'
import { buildActionErrorEnvelope, stripBloat } from '@/lib/actions/action-response'

export async function POST(request: NextRequest) {
  const auth = checkActionAuth(request)
  if (!auth.valid) return auth.error

  try {
    const body = await request.json()
    const data = await executeAction('/api/agent-jobs/execute-task', body, auth.bearerToken)
    const record = stripBloat(data) as Record<string, unknown>
    return NextResponse.json({
      ok: record.status === 'completed',
      status: record.status,
      completedPhase: record.completedPhase,
      failedAt: record.failedAt
    })
  } catch (err) {
    if (err instanceof ActionTransportError) {
      return NextResponse.json(buildActionErrorEnvelope({ code: 'ACTION_TRANSPORT_ERROR', message: err.message }), { status: err.statusCode })
    }
    return NextResponse.json(buildActionErrorEnvelope({ code: 'EXECUTE_TASK_ERROR', message: err instanceof Error ? err.message : String(err) }), { status: 500 })
  }
}
