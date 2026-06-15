import { NextRequest, NextResponse } from 'next/server'
import { checkActionAuth } from '@/lib/actionAuth'
import { dispatchWorkbenchArtifact, unwrapActionError } from '@/lib/actions/gpt'
import { buildActionErrorEnvelope } from '@/lib/actions/action-response'
import { getSafeActionHttpStatus } from '@/lib/actions/http-status'

export async function POST(request: NextRequest) {
  const auth = checkActionAuth(request)
  if (!auth.valid) return auth.error

  try {
    const body = await request.json()
    if (body.dryRun !== true && body.preflight !== true) {
      const preflight = await dispatchWorkbenchArtifact({ ...body, dryRun: true }, auth.bearerToken)
      if ('error' in (preflight as Record<string, unknown>)) {
        const payload = preflight as { error: unknown }
        const status = getSafeActionHttpStatus(payload.error)
        if (payload.error && typeof payload.error === 'object') {
          return NextResponse.json(payload.error, { status })
        }
        return NextResponse.json(buildActionErrorEnvelope({
          code: 'BUILDFLOW_STATUS_ERROR',
          message: String(payload.error)
        }), { status })
      }
      if ((preflight as { requiresConfirmation?: unknown }).requiresConfirmation === true) {
        return NextResponse.json(preflight)
      }
      if ((preflight as { allowed?: unknown }).allowed === false) {
        return NextResponse.json(preflight)
      }
    }
    const data = await dispatchWorkbenchArtifact(body, auth.bearerToken)
    if (body.dryRun === true || body.preflight === true) {
      return NextResponse.json(data)
    }
    if ('error' in (data as Record<string, unknown>)) {
      const payload = data as { error: unknown }
      const status = getSafeActionHttpStatus(payload.error)
      if (payload.error && typeof payload.error === 'object') {
        return NextResponse.json(payload.error, { status })
      }
      return NextResponse.json(buildActionErrorEnvelope({
        code: 'BUILDFLOW_STATUS_ERROR',
        message: String(payload.error)
      }), { status })
    }
    if ((data as { verified?: unknown }).verified !== true) {
      return NextResponse.json(buildActionErrorEnvelope({
        code: 'BUILDFLOW_STATUS_ERROR',
        message: 'Write was not verified'
      }), { status: 502 })
    }
    return NextResponse.json(data)
  } catch (err) {
    const { error, status } = unwrapActionError(err, 'write-artifact error')
    return NextResponse.json(error && typeof error === 'object' ? error : buildActionErrorEnvelope({
      code: 'BUILDFLOW_STATUS_ERROR',
      message: String(error)
    }), { status })
  }
}
