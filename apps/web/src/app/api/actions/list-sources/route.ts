import { NextRequest, NextResponse } from 'next/server'
import { checkActionAuth } from '@/lib/actionAuth'
import { executeActionGET, ActionTransportError } from '@/lib/actions/transport'
import { buildActionErrorEnvelope } from '@/lib/actions/action-response'
import { makeActivity, withActivity } from '@/lib/actions/gpt'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET(request: NextRequest) {
  const auth = checkActionAuth(request)
  if (!auth.valid) return auth.error

  try {
    const result = await executeActionGET('/api/sources/list', auth.bearerToken)
    const sources = Array.isArray((result.data as Record<string, unknown>).sources) ? (result.data as Record<string, unknown>).sources : []
    const sourceCount = (sources as unknown[]).length
    return NextResponse.json(withActivity(result.data as Record<string, unknown>, makeActivity({
      operationId: 'listWorkbenchSources',
      phase: 'completed',
      actionLabel: 'Listed sources',
      userMessage: `Found ${sourceCount} ${sourceCount === 1 ? 'source' : 'sources'}.`,
      riskLevel: 'low',
      requiresConfirmation: false,
      verified: true,
      whatHappened: [`Listed all available sources`, `Found ${sourceCount} sources`],
      provenFacts: [`All sources retrieved successfully`, `Total sources: ${sourceCount}`],
      nextActions: sourceCount > 0 ? ['Select a source', 'Set active sources'] : ['Add a new source', 'Check configuration']
    })), {
      status: result.status,
      headers: {
        'Cache-Control': 'no-store'
      }
    })
  } catch (err) {
    if (err instanceof ActionTransportError) {
      return NextResponse.json(
        err.payload && typeof err.payload === 'object' ? err.payload : buildActionErrorEnvelope({
          code: 'ACTION_TRANSPORT_ERROR',
          message: err.message,
          details: `Status ${err.statusCode}`,
          status: err.statusCode === 504 ? 'unavailable' : 'error'
        }),
        {
          status: err.statusCode,
          headers: {
            'Cache-Control': 'no-store'
          }
        }
      )
    }
    return NextResponse.json(buildActionErrorEnvelope({
      code: 'BUILDFLOW_STATUS_ERROR',
      message: 'Backend service unavailable',
      details: err instanceof Error ? err.message : String(err),
      status: 'error'
    }), {
      status: 503,
      headers: {
        'Cache-Control': 'no-store'
      }
    })
  }
}
