import { NextRequest, NextResponse } from 'next/server'
import { checkActionAuth } from '@/lib/actionAuth'
import { executeActionGET, ActionTransportError } from '@/lib/actions/transport'
import { buildActionErrorEnvelope } from '@/lib/actions/action-response'
import { listBuildFlowSources, getBuildFlowActiveContext, setBuildFlowActiveContext, unwrapActionError } from '@/lib/actions/gpt'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET(request: NextRequest) {
  const auth = checkActionAuth(request)
  if (!auth.valid) return auth.error

  const include = request.nextUrl.searchParams.get('include') || ''

  try {
    const payload: Record<string, unknown> = {
      ok: true,
      connected: true
    }

    if (include !== 'sources' && include !== 'active' && include !== 'all') {
      await executeActionGET('/api/status', auth.bearerToken)
    }

    if (include === 'sources' || include === 'all') {
      try {
        const sourcesData = await listBuildFlowSources(auth.bearerToken)
        const rawSources = (sourcesData as Record<string, unknown>).sources
        if (Array.isArray(rawSources)) {
          payload.sources = rawSources
            .filter((s: Record<string, unknown>) => s.enabled)
            .map((s: Record<string, unknown>) => ({
              id: s.id,
              label: s.label,
              active: s.active
            }))
        }
      } catch {}
    }

    if (include === 'active' || include === 'all') {
      try {
        const activeData = await getBuildFlowActiveContext(auth.bearerToken) as Record<string, unknown>
        payload.activeSourceIds = activeData.activeSourceIds
        payload.contextMode = activeData.contextMode
      } catch {}
    }

    return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    if (err instanceof ActionTransportError) {
      return NextResponse.json(
        buildActionErrorEnvelope({
          code: 'LOCAL_STACK_UNAVAILABLE',
          message: err.message,
          status: 'unavailable'
        }),
        { status: err.statusCode, headers: { 'Cache-Control': 'no-store' } }
      )
    }
    return NextResponse.json(
      buildActionErrorEnvelope({
        code: 'BUILDFLOW_STATUS_ERROR',
        message: err instanceof Error ? err.message : String(err),
        status: 'error'
      }),
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    )
  }
}

export async function POST(request: NextRequest) {
  const auth = checkActionAuth(request)
  if (!auth.valid) return auth.error

  try {
    const body = await request.json().catch(() => ({}))
    const data = await setBuildFlowActiveContext(body, auth.bearerToken) as Record<string, unknown>
    return NextResponse.json({
      ok: true,
      contextMode: data.contextMode,
      activeSourceIds: data.activeSourceIds
    })
  } catch (err) {
    const { error, status } = unwrapActionError(err, 'set-context error')
    return NextResponse.json(error && typeof error === 'object' ? error : { error }, { status })
  }
}
