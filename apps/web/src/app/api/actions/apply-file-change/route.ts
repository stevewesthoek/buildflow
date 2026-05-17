import { NextRequest, NextResponse } from 'next/server'
import { checkActionAuth } from '@/lib/actionAuth'
import { dispatchBuildFlowFileChange, unwrapActionError } from '@/lib/actions/gpt'
import { buildActionErrorEnvelope } from '@/lib/actions/action-response'
import { getSafeActionHttpStatus } from '@/lib/actions/http-status'

export async function POST(request: NextRequest) {
  const auth = checkActionAuth(request)
  if (!auth.valid) return auth.error

  try {
    const body = await request.json()
    const isDryRun = body.dryRun === true || body.preflight === true
    const data = await dispatchBuildFlowFileChange(body, auth.bearerToken)

    if ('error' in (data as Record<string, unknown>)) {
      const payload = data as { error: unknown }
      const status = getSafeActionHttpStatus(payload.error)
      if (isDryRun) {
        return NextResponse.json(data, { status: 200 })
      }
      if (payload.error && typeof payload.error === 'object') {
        return NextResponse.json(payload.error, { status })
      }
      return NextResponse.json(buildActionErrorEnvelope({
        code: 'BUILDFLOW_STATUS_ERROR',
        message: String(payload.error)
      }), { status })
    }

    if (!isDryRun && (data as { verified?: unknown }).verified !== true) {
      return NextResponse.json(buildActionErrorEnvelope({
        code: 'BUILDFLOW_STATUS_ERROR',
        message: 'Write was not verified'
      }), { status: 502 })
    }
    return NextResponse.json(data)
  } catch (err) {
    const { error, status } = unwrapActionError(err, 'apply-file-change error')
    if (error && typeof error === 'object') {
      return NextResponse.json(error, { status })
    }
    return NextResponse.json(buildActionErrorEnvelope({
      code: 'BUILDFLOW_STATUS_ERROR',
      message: String(error)
    }), { status })
  }
}
