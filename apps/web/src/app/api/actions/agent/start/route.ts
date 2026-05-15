import { NextRequest, NextResponse } from 'next/server'
import { checkActionAuth } from '@/lib/actionAuth'
import { startBuildFlowAgentJob, unwrapActionError } from '@/lib/actions/gpt'
import { buildActionErrorEnvelope } from '@/lib/actions/action-response'

export async function POST(request: NextRequest) {
  const auth = checkActionAuth(request)
  if (!auth.valid) return auth.error

  try {
    const body = await request.json()
    const data = await startBuildFlowAgentJob(body, auth.bearerToken)
    return NextResponse.json(data)
  } catch (err) {
    const { error, status } = unwrapActionError(err, 'agent-start error')
    return NextResponse.json(error && typeof error === 'object' ? error : buildActionErrorEnvelope({
      code: 'BUILDFLOW_AGENT_START_ERROR',
      message: String(error)
    }), { status })
  }
}
