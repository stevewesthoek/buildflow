import { NextRequest, NextResponse } from 'next/server'
import { checkActionAuth } from '@/lib/actionAuth'
import { dispatchBuildFlowFileChange, unwrapActionError } from '@/lib/actions/gpt'
import { buildActionErrorEnvelope, stripBloat } from '@/lib/actions/action-response'
import { getSafeActionHttpStatus } from '@/lib/actions/http-status'
import { GPT_ACTION_DEADLINES_MS, withGptActionDeadline } from '@/lib/actions/deadline'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function POST(request: NextRequest) {
  const auth = checkActionAuth(request)
  if (!auth.valid) return auth.error

  return withGptActionDeadline({
    operationId: 'applyBuildFlowFileChange',
    route: '/api/actions/apply-file-change',
    deadlineMs: GPT_ACTION_DEADLINES_MS.applyFileChange,
    suggestedNextAction: 'Split the write into a smaller patch or dry-run first.'
  }, async (deadline) => {
    deadline.setPhase('parse_body')
    const body = await request.json()
    deadline.addDiagnostics({
      sourceId: typeof body.sourceId === 'string' ? body.sourceId : undefined,
      path: typeof body.path === 'string' ? body.path : undefined,
      mode: typeof body.changeType === 'string' ? body.changeType : undefined
    })
    const isDryRun = body.dryRun === true || body.preflight === true
    deadline.setPhase(isDryRun ? 'preflight_write' : 'apply_file_change')
    const data = await dispatchBuildFlowFileChange(body, auth.bearerToken, {
      signal: deadline.signal,
      timeoutMs: deadline.transportTimeoutMs(7500),
      diagnostics: deadline.diagnostics({
        phase: isDryRun ? 'preflight_write' : 'apply_file_change',
        sourceId: typeof body.sourceId === 'string' ? body.sourceId : undefined,
        path: typeof body.path === 'string' ? body.path : undefined,
        mode: typeof body.changeType === 'string' ? body.changeType : undefined
      })
    })

    if ('error' in (data as Record<string, unknown>)) {
      const payload = data as { error: unknown }
      const status = getSafeActionHttpStatus(payload.error)
      if (isDryRun) {
        return NextResponse.json(stripBloat(data))
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
    return NextResponse.json(stripBloat(data))
  }).catch((err) => {
    const { error, status } = unwrapActionError(err, 'apply-file-change error')
    if (error && typeof error === 'object') {
      return NextResponse.json(error, { status })
    }
    return NextResponse.json(buildActionErrorEnvelope({
      code: 'BUILDFLOW_STATUS_ERROR',
      message: String(error)
    }), { status })
  })
}
