import { NextRequest, NextResponse } from 'next/server'
import { checkActionAuth } from '@/lib/actionAuth'
import { executeActionGET, ActionTransportError } from '@/lib/actions/transport'
import { buildActionErrorEnvelope } from '@/lib/actions/action-response'
import { makeActivity, withActivity, withActionRouteDiagnostics } from '@/lib/actions/gpt'

export const dynamic = 'force-dynamic'
export const revalidate = 0

function buildStatusActivity(sourceCount: number) {
  return makeActivity({
    operationId: 'getBuildFlowStatus',
    phase: 'completed',
    actionLabel: 'Checked BuildFlow connection',
    userMessage: `BuildFlow is connected and can see ${sourceCount} ${sourceCount === 1 ? 'source' : 'sources'}.`,
    riskLevel: 'low',
    requiresConfirmation: false,
    verified: true,
    nextStep: sourceCount > 0 ? 'Select a source and continue.' : 'Connect a source and try again.'
  })
}

export async function GET(request: NextRequest) {
  const startedAt = Date.now()
  const auth = checkActionAuth(request)
  if (!auth.valid) return auth.error

  try {
    const result = await executeActionGET('/api/status', auth.bearerToken)
    const sourceCount = typeof result.data === 'object' && result.data !== null && typeof (result.data as { sourceCount?: unknown }).sourceCount === 'number'
      ? (result.data as { sourceCount: number }).sourceCount
      : 0
    const payload = withActionRouteDiagnostics(withActivity({
      ok: true,
      connected: true,
      status: 'available',
      version: typeof result.data === 'object' && result.data !== null && typeof (result.data as { version?: unknown }).version === 'string'
        ? (result.data as { version: string }).version
        : 'unknown',
      serverTime: new Date().toISOString(),
      sourcesReady: sourceCount > 0,
      message: 'BuildFlow is available',
      sourceCount,
      ...(result.data && typeof result.data === 'object' ? result.data as Record<string, unknown> : {})
    }, buildStatusActivity(sourceCount)), { route: '/api/actions/status', startedAt })
    return NextResponse.json(payload, {
      status: result.status,
      headers: {
        'Cache-Control': 'no-store'
      }
    })
  } catch (err) {
    if (err instanceof ActionTransportError) {
      const payload = err.payload && typeof err.payload === 'object'
        ? (() => {
            const raw = err.payload as { error?: { code?: string } }
            if (raw.error?.code === 'ACTION_TRANSPORT_ERROR') {
              return buildActionErrorEnvelope({
                code: 'BUILDFLOW_STATUS_ERROR',
                message: 'BuildFlow status check failed.',
                details: err.message,
                recovery: ['Open OrbStack', 'Run pnpm local:restart', 'Run scripts/buildflow-local-stack.sh status'],
                status: 'error'
              })
            }
            return err.payload
          })()
        : buildActionErrorEnvelope({
          code: err.statusCode === 504 ? 'LOCAL_STACK_TIMEOUT' : 'LOCAL_STACK_UNAVAILABLE',
          message: err.message,
          details: 'The local BuildFlow stack was not reachable.',
          recovery: ['Open OrbStack', 'Run pnpm local:restart', 'Run scripts/buildflow-local-stack.sh status'],
          status: 'unavailable'
        })
      return NextResponse.json(payload, {
        status: err.statusCode,
        headers: {
          'Cache-Control': 'no-store'
        }
      })
    }
    const payload = buildActionErrorEnvelope({
      code: 'BUILDFLOW_STATUS_ERROR',
      message: 'BuildFlow status check failed.',
      details: err instanceof Error ? err.message : String(err),
      recovery: ['Open OrbStack', 'Run pnpm local:restart', 'Run scripts/buildflow-local-stack.sh status'],
      status: 'error'
    })
    return NextResponse.json(payload, {
      status: 503,
      headers: {
        'Cache-Control': 'no-store'
      }
    })
  }
}
