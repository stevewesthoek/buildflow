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
    const { query, limit = 2, sourceId, sourceIds, maxBytesPerFile } = body

    if (!query) {
      return NextResponse.json(
        buildActionErrorEnvelope({
          code: 'BUILDFLOW_STATUS_ERROR',
          message: 'Missing query parameter'
        }),
        { status: 400 }
      )
    }

    // Cap limit at 3 for safety
    const cappedLimit = Math.min(Math.max(limit, 1), 3)

    // Search first
    const searchPayload: Record<string, unknown> = { query, limit: cappedLimit }
    if (sourceId) searchPayload.sourceId = sourceId
    if (sourceIds) searchPayload.sourceIds = sourceIds
    const searchData = await executeAction('/api/search', searchPayload, auth.bearerToken)
    const searchResults = (searchData as Record<string, unknown>).results as unknown[] || []

    // Read each result (up to capped limit)
    const results = []
    let successCount = 0
    for (const result of searchResults.slice(0, cappedLimit)) {
      const resultObj = result as Record<string, unknown>
      try {
        const readPayload: Record<string, unknown> = { path: resultObj.path }
        if (resultObj.sourceId) {
          readPayload.sourceId = resultObj.sourceId
        }
        if (maxBytesPerFile) {
          readPayload.maxBytes = maxBytesPerFile
        }

        const readData = await executeAction('/api/read', readPayload, auth.bearerToken)
        const readDataObj = readData as Record<string, unknown>
        results.push({
          sourceId: resultObj.sourceId,
          path: resultObj.path,
          title: resultObj.title || '',
          snippet: resultObj.snippet || '',
          content: readDataObj.content || '',
          modifiedAt: resultObj.modifiedAt || ''
        })
        successCount++
      } catch (err) {
        // Preserve the published response shape for mixed-result reads:
        // failed items stay in-band so the overall action still returns usable results.
        results.push({
          sourceId: resultObj.sourceId,
          path: resultObj.path,
          title: resultObj.title || '',
          snippet: resultObj.snippet || '',
          content: '',
          modifiedAt: resultObj.modifiedAt || ''
        })
      }
    }

    return NextResponse.json(withActivity({ results }, makeActivity({
      operationId: 'searchAndReadBuildFlowContext',
      phase: 'completed',
      actionLabel: 'Searched and read files',
      userMessage: `Searched for "${query}", found ${searchResults.length} results, read ${successCount} files successfully.`,
      riskLevel: 'low',
      requiresConfirmation: false,
      verified: true,
      whatHappened: [`Searched for: "${query}"`, `Found ${searchResults.length} matches`, `Read ${successCount} of ${results.length} files`],
      readPaths: results.map(r => (r as Record<string, unknown>).path as string),
      provenFacts: [`Search-and-read completed`, `Total results: ${results.length}`, `Files with content: ${successCount}`],
      nextActions: successCount > 0 ? ['Analyze the content', 'Search with refined query'] : ['Try a different search', 'Check source configuration']
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
        message: 'Search-and-read error',
        details: err instanceof Error ? err.message : String(err)
      }),
      { status: 500 }
    )
  }
}
