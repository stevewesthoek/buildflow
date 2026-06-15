import { NextRequest, NextResponse } from 'next/server'
import { checkActionAuth } from '@/lib/actionAuth'
import { dispatchWorkbenchContext, unwrapActionError } from '@/lib/actions/gpt'
import { buildActionErrorEnvelope } from '@/lib/actions/action-response'

export async function GET(request: NextRequest) {
  const auth = checkActionAuth(request)
  if (!auth.valid) return auth.error

  try {
    const data = await dispatchWorkbenchContext({ action: 'get_active' }, auth.bearerToken)
    return NextResponse.json(data)
  } catch (err) {
    const { error, status } = unwrapActionError(err, 'context error')
    return NextResponse.json(error && typeof error === 'object' ? error : { error }, { status })
  }
}

export async function POST(request: NextRequest) {
  const auth = checkActionAuth(request)
  if (!auth.valid) return auth.error

  try {
    const body = await request.json()
    const action = body.action
    if (!action) {
      return NextResponse.json(buildActionErrorEnvelope({
        code: 'BUILDFLOW_STATUS_ERROR',
        message: 'Missing action parameter'
      }), { status: 400 })
    }
    const data = await dispatchWorkbenchContext(body, auth.bearerToken)
    return NextResponse.json(data)
  } catch (err) {
    const { error, status } = unwrapActionError(err, 'context error')
    return NextResponse.json(error && typeof error === 'object' ? error : { error }, { status })
  }
}
