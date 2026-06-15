import { NextRequest, NextResponse } from 'next/server'
import { checkActionAuth } from '@/lib/actionAuth'
import { dispatchWorkbenchInspect, unwrapActionError, withActionRouteDiagnostics } from '@/lib/actions/gpt'
import { buildActionErrorEnvelope } from '@/lib/actions/action-response'

export async function POST(request: NextRequest) {
  const startedAt = Date.now()
  const auth = checkActionAuth(request)
  if (!auth.valid) return auth.error

  try {
    const body = await request.json()
    const requestBytes = Buffer.byteLength(JSON.stringify(body ?? {}), 'utf8')
    const data = await dispatchWorkbenchInspect(body, auth.bearerToken)
    return NextResponse.json(withActionRouteDiagnostics(data as Record<string, unknown>, { route: '/api/actions/inspect', startedAt, requestBytes }))
  } catch (err) {
    const { error, status } = unwrapActionError(err, 'inspect error')
    return NextResponse.json(error && typeof error === 'object' ? error : buildActionErrorEnvelope({
      code: 'BUILDFLOW_STATUS_ERROR',
      message: String(error)
    }), { status })
  }
}
