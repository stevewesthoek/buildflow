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
    if (sourceError) return sourceError
    const data = await executeAction('/api/write-file', body, auth.bearerToken)
    if ((data as { verified?: unknown }).verified !== true) {
      return NextResponse.json(buildActionErrorEnvelope({
        code: 'BUILDFLOW_STATUS_ERROR',
        message: 'Write was not verified'
      }), { status: 502 })
    }
    const dataObj = data as Record<string, unknown>
    const bytesWritten = typeof dataObj.bytesWritten === 'number' ? dataObj.bytesWritten : 0
    const created = typeof dataObj.created === 'boolean' ? dataObj.created : false
    return NextResponse.json(withActivity(dataObj, makeActivity({
      operationId: 'writeBuildFlowFileChange',
      phase: 'completed',
      actionLabel: created ? 'Created file' : 'Overwrote file',
      userMessage: `${created ? 'Created' : 'Overwrote'} file: ${body.path} (${bytesWritten} bytes)`,
      riskLevel: 'high',
      requiresConfirmation: false,
      verified: true,
      targetPaths: [body.path as string],
      changedPaths: [body.path as string],
      whatHappened: [created ? `Created file: ${body.path}` : `Overwrote file: ${body.path}`, `Verified: ${dataObj.verified}`],
      provenFacts: [created ? 'File created successfully' : 'File overwritten successfully', `Bytes written: ${bytesWritten}`],
      nextActions: ['Read the file', 'Write another file']
    })))
  } catch (err) {
    const { error, status } = unwrapActionError(err, 'Write file error')
    if (error && typeof error === 'object') {
      return NextResponse.json(error, { status })
    }
    return NextResponse.json(buildActionErrorEnvelope({
      code: 'BUILDFLOW_STATUS_ERROR',
      message: String(error)
    }), { status })
  }
}
