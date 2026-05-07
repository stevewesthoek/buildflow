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
    const { path, sourceId, sourceIds, maxBytes } = body

    if (!path) {
      return NextResponse.json(
        buildActionErrorEnvelope({
          code: 'BUILDFLOW_STATUS_ERROR',
          message: 'Missing path parameter'
        }),
        { status: 400 }
      )
    }

    const payload: Record<string, unknown> = { path }
    if (sourceId) {
      payload.sourceId = sourceId
    }
    if (sourceIds) {
      payload.sourceIds = sourceIds
    }
    if (maxBytes) {
      payload.maxBytes = maxBytes
    }

    const data = await executeAction('/api/read', payload, auth.bearerToken)
    const dataObj = data as Record<string, unknown>
    const bytesRead = typeof dataObj.sizeBytes === 'number' ? (dataObj.sizeBytes as number) : 0
    return NextResponse.json(withActivity(dataObj, makeActivity({
      operationId: 'readBuildFlowContext',
      phase: 'completed',
      actionLabel: 'Read file',
      userMessage: `Read file: ${path}${bytesRead > 0 ? ` (${bytesRead} bytes)` : ''}`,
      riskLevel: 'low',
      requiresConfirmation: false,
      verified: true,
      readPaths: [path as string],
      whatHappened: [`Read file: ${path}`],
      provenFacts: [`File exists and was readable`, `File size: ${bytesRead} bytes`],
      nextActions: ['Analyze file content', 'Read another file']
    })))
  } catch (err) {
    if (err instanceof ActionTransportError) {
      return NextResponse.json(
        err.payload && typeof err.payload === 'object' ? err.payload : buildActionErrorEnvelope({
          code: 'ACTION_TRANSPORT_ERROR',
          message: err.message,
          details: `Status ${err.statusCode}`,
          status: err.statusCode === 504 ? 'unavailable' : 'error'
        }),
        { status: err.statusCode }
      )
    }
    return NextResponse.json(
      buildActionErrorEnvelope({
        code: 'BUILDFLOW_STATUS_ERROR',
        message: 'Read error',
        details: err instanceof Error ? err.message : String(err)
      }),
      { status: 500 }
    )
  }
}
