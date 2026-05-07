import { NextRequest, NextResponse } from 'next/server'
import { checkActionAuth } from '@/lib/actionAuth'
import { executeAction, ActionTransportError } from '@/lib/actions/transport'
import { buildActionErrorEnvelope } from '@/lib/actions/action-response'
import { makeActivity, withActivity } from '@/lib/actions/gpt'

export async function POST(request: NextRequest) {
  const auth = checkActionAuth(request)
  if (!auth.valid) return auth.error

  try {
    const body = await request.json()
    const { query, limit = 10, sourceId, sourceIds, glob } = body

    if (!query) {
      return NextResponse.json(
        buildActionErrorEnvelope({
          code: 'BUILDFLOW_STATUS_ERROR',
          message: 'Missing query parameter'
        }),
        { status: 400 }
      )
    }

    const payload: Record<string, unknown> = { query, limit }
    if (sourceId) payload.sourceId = sourceId
    if (sourceIds) payload.sourceIds = sourceIds
    if (glob) payload.glob = glob
    const data = await executeAction('/api/search', payload, auth.bearerToken)

    const results = Array.isArray((data as { results?: unknown }).results) ? (data as { results: unknown[] }).results : []
    const resultCount = results.length

    return NextResponse.json(withActivity(data as Record<string, unknown>, makeActivity({
      operationId: 'searchBuildFlowContext',
      phase: 'completed',
      actionLabel: 'Searched files',
      userMessage: `Searched for "${query}" and found ${resultCount} ${resultCount === 1 ? 'result' : 'results'}.`,
      riskLevel: 'low',
      requiresConfirmation: false,
      verified: true,
      whatHappened: [`Searched for query: "${query}"`, `Found ${resultCount} matching documents`],
      provenFacts: [`Search completed successfully`, `Limit: ${limit}`, resultCount > 0 ? `Results returned: ${resultCount}` : 'No matching documents found'],
      nextActions: resultCount > 0 ? ['Read specific results', 'Refine search query'] : ['Try a different search query', 'Check source availability']
    })))
  } catch (err) {
    if (err instanceof ActionTransportError) {
      return NextResponse.json(
        buildActionErrorEnvelope({
          code: 'ACTION_TRANSPORT_ERROR',
          message: err.message,
          details: `Status ${err.statusCode}`
        }),
        { status: err.statusCode }
      )
    }
    return NextResponse.json(
      buildActionErrorEnvelope({
        code: 'BUILDFLOW_STATUS_ERROR',
        message: 'Search error',
        details: err instanceof Error ? err.message : String(err)
      }),
      { status: 500 }
    )
  }
}
