import { NextRequest, NextResponse } from 'next/server'
import { checkActionAuth } from '@/lib/actionAuth'
import { dispatchBuildFlowCommand, unwrapActionError, withActionRouteDiagnostics } from '@/lib/actions/gpt'
import { buildActionErrorEnvelope } from '@/lib/actions/action-response'

export async function POST(request: NextRequest) {
  const startedAt = Date.now()
  const auth = checkActionAuth(request)
  if (!auth.valid) return auth.error

  try {
    const body = await request.json()
    const requestBytes = Buffer.byteLength(JSON.stringify(body ?? {}), 'utf8')
    const data = await dispatchBuildFlowCommand(body, auth.bearerToken)
    return NextResponse.json(withActionRouteDiagnostics(data as Record<string, unknown>, { route: '/api/actions/run-command', startedAt, requestBytes }))
  } catch (err) {
    const { error, status } = unwrapActionError(err, 'run-command error')
    return NextResponse.json(error && typeof error === 'object' ? error : buildActionErrorEnvelope({
      code: 'BUILDFLOW_COMMAND_ERROR',
      message: String(error)
    }), { status })
  }
}
