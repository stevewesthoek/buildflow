import { NextRequest, NextResponse } from 'next/server'
import { checkActionAuth } from '@/lib/actionAuth'
import { executeActionGET } from '@/lib/actions/transport'
import { listBuildFlowSources, getBuildFlowActiveContext, setBuildFlowActiveContext, unwrapActionError } from '@/lib/actions/gpt'
import { GPT_ACTION_DEADLINES_MS, withGptActionDeadline } from '@/lib/actions/deadline'

export const dynamic = 'force-dynamic'
export const revalidate = 0

let activeRequests = 0

export async function GET(request: NextRequest) {
  activeRequests++
  try {
    const auth = checkActionAuth(request)
    if (!auth.valid) return auth.error

    const include = request.nextUrl.searchParams.get('include') || ''

    return withGptActionDeadline({
      operationId: 'getBuildFlowStatus',
      route: '/api/actions/status',
      deadlineMs: GPT_ACTION_DEADLINES_MS.status,
      suggestedNextAction: 'Retry status after checking the local BuildFlow stack.'
    }, async (deadline) => {
      deadline.setPhase('check_status')
      deadline.addDiagnostics({ mode: include || 'status' })
      const payload: Record<string, unknown> = {
        ok: true,
        connected: true
      }

    if (include !== 'sources' && include !== 'active' && include !== 'all') {
      await executeActionGET('/api/status', auth.bearerToken, {
        signal: deadline.signal,
        timeoutMs: deadline.transportTimeoutMs(3500),
        diagnostics: deadline.diagnostics({ phase: 'status_probe' })
      })
    }

    if (include === 'sources' || include === 'all') {
      try {
        deadline.setPhase('list_sources')
        const sourcesData = await listBuildFlowSources(auth.bearerToken, {
          signal: deadline.signal,
          timeoutMs: deadline.transportTimeoutMs(2500),
          diagnostics: deadline.diagnostics({ phase: 'list_sources' })
        })
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
        deadline.setPhase('get_active_context')
        const activeData = await getBuildFlowActiveContext(auth.bearerToken, {
          signal: deadline.signal,
          timeoutMs: deadline.transportTimeoutMs(1500),
          diagnostics: deadline.diagnostics({ phase: 'get_active_context' })
        }) as Record<string, unknown>
        payload.activeSourceIds = activeData.activeSourceIds
        payload.contextMode = activeData.contextMode
      } catch {}
    }

    const mem = process.memoryUsage()
    payload.runtime = {
      activeRequests,
      heapUsedMb: Math.round(mem.heapUsed / 1_048_576),
      rssMb: Math.round(mem.rss / 1_048_576)
    }

    payload.activity = {
      version: '1.2.13-beta',
      operationId: 'getBuildFlowStatus',
      phase: 'completed',
      actionLabel: 'Checked BuildFlow status',
      userMessage: include ? `BuildFlow status returned ${include}.` : 'BuildFlow is connected.',
      riskLevel: 'low',
      requiresConfirmation: false,
      verified: true,
      nextStep: 'Lock one sourceId and use small focused actions.'
    }

    return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } })
    }).catch((err) => {
      const { error, status } = unwrapActionError(err, 'status error')
      return NextResponse.json(error && typeof error === 'object' ? error : { error }, { status, headers: { 'Cache-Control': 'no-store' } })
    })
  } finally {
    activeRequests--
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
