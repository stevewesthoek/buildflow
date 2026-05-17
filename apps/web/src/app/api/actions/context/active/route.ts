import { NextRequest, NextResponse } from 'next/server'
import { checkActionAuth } from '@/lib/actionAuth'
import { getBuildFlowActiveContext, setBuildFlowActiveContext, unwrapActionError, withActionRouteDiagnostics } from '@/lib/actions/gpt'

export async function GET(request: NextRequest) {
  const startedAt = Date.now()
  const auth = checkActionAuth(request)
  if (!auth.valid) return auth.error
  try {
    const data = await getBuildFlowActiveContext(auth.bearerToken)
    return NextResponse.json(withActionRouteDiagnostics(data as Record<string, unknown>, { route: '/api/actions/context/active', startedAt }))
  } catch (err) {
    const { error, status } = unwrapActionError(err, 'context active error')
    return NextResponse.json(error && typeof error === 'object' ? error : { error }, { status })
  }
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now()
  const auth = checkActionAuth(request)
  if (!auth.valid) return auth.error
  try {
    const body = await request.json()
    const requestBytes = Buffer.byteLength(JSON.stringify(body ?? {}), 'utf8')
    const data = await setBuildFlowActiveContext(body, auth.bearerToken)
    return NextResponse.json(withActionRouteDiagnostics(data as Record<string, unknown>, { route: '/api/actions/context/active', startedAt, requestBytes }))
  } catch (err) {
    const { error, status } = unwrapActionError(err, 'context active error')
    return NextResponse.json(error && typeof error === 'object' ? error : { error }, { status })
  }
}
