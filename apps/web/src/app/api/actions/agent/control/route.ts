import { NextRequest, NextResponse } from 'next/server'
import { checkActionAuth } from '@/lib/actionAuth'
import { controlWorkbenchAgentRun, makeActivity, unwrapActionError } from '@/lib/actions/gpt'
import { buildActionErrorEnvelope } from '@/lib/actions/action-response'

export async function POST(request: NextRequest) {
  const auth = checkActionAuth(request)
  if (!auth.valid) return auth.error

  try {
    const body = await request.json().catch(() => ({}))
    const data = await controlWorkbenchAgentRun(body, auth.bearerToken) as Record<string, unknown>
    const action = typeof body.action === 'string' ? body.action : 'events'
    return NextResponse.json({
      ...data,
      activity: makeActivity({
        operationId: 'controlWorkbenchAgentRun',
        phase: 'completed',
        actionLabel: 'Controlled Agent Runtime run',
        userMessage: action === 'events' ? 'Fetched compact Agent Runtime events.' : `Applied Agent Runtime control action: ${action}.`,
        sourceId: typeof body.sourceId === 'string' ? body.sourceId : undefined,
        riskLevel: action === 'cancel' ? 'medium' : 'low',
        requiresConfirmation: false,
        verified: true,
        nextStep: 'Use compact job status/events as progress evidence.'
      })
    })
  } catch (err) {
    const { error, status } = unwrapActionError(err, 'agent-control error')
    return NextResponse.json(error && typeof error === 'object' ? error : buildActionErrorEnvelope({
      code: 'BUILDFLOW_AGENT_CONTROL_ERROR',
      message: String(error)
    }), { status })
  }
}
