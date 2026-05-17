import { NextRequest, NextResponse } from 'next/server'
import { checkActionAuth } from '@/lib/actionAuth'
import { executeAction } from '@/lib/actions/transport'
import { requireExplicitSourceId, unwrapActionError, makeActivity, withActivity } from '@/lib/actions/gpt'
import { buildActionErrorEnvelope } from '@/lib/actions/action-response'

export async function POST(request: NextRequest) {
  const auth = checkActionAuth(request)
  if (!auth.valid) return auth.error
  try {
    const body = await request.json()
    const sourceError = await requireExplicitSourceId(body)
    if (sourceError) {
      return NextResponse.json(sourceError, { status: sourceError.status })
    }
    const data = await executeAction('/api/append-file', body, auth.bearerToken)
    if ((data as { verified?: unknown }).verified !== true) {
      return NextResponse.json(buildActionErrorEnvelope({
        code: 'BUILDFLOW_STATUS_ERROR',
        message: 'Write was not verified'
      }), { status: 502 })
    }
    const dataObj = data as Record<string, unknown>
    const bytesAppended = typeof dataObj.bytesAppended === 'number' ? dataObj.bytesAppended : 0
    return NextResponse.json(withActivity(dataObj, makeActivity({
      operationId: 'appendBuildFlowFileChange',
      phase: 'completed',
      actionLabel: 'Appended to file',
      userMessage: `Appended ${bytesAppended} bytes to file: ${body.path}`,
      riskLevel: 'medium',
      requiresConfirmation: false,
      verified: true,
      targetPaths: [body.path as string],
      changedPaths: [body.path as string],
      whatHappened: [`Appended content to ${body.path}`, `Verified write: ${dataObj.verified}`],
      provenFacts: [`File was updated successfully`, `Bytes appended: ${bytesAppended}`],
      nextActions: ['Read the updated file', 'Append more content']
    })))
  } catch (err) {
    const { error, status } = unwrapActionError(err, 'append-file error')
    if (error && typeof error === 'object') {
      return NextResponse.json(error, { status })
    }
    return NextResponse.json(buildActionErrorEnvelope({
      code: 'BUILDFLOW_STATUS_ERROR',
      message: String(error)
    }), { status })
  }
}
