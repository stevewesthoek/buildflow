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
    const data = await executeAction('/api/create-plan', body, auth.bearerToken)
    if ((data as { verified?: unknown }).verified !== true) {
      return NextResponse.json(buildActionErrorEnvelope({
        code: 'BUILDFLOW_STATUS_ERROR',
        message: 'Write was not verified'
      }), { status: 502 })
    }
    const dataObj = data as Record<string, unknown>
    const bytesWritten = typeof dataObj.bytesWritten === 'number' ? dataObj.bytesWritten : 0
    return NextResponse.json(withActivity(dataObj, makeActivity({
      operationId: 'createBuildFlowPlan',
      phase: 'completed',
      actionLabel: 'Created plan',
      userMessage: `Created plan: ${body.title} (${bytesWritten} bytes)`,
      riskLevel: 'low',
      requiresConfirmation: false,
      verified: true,
      targetPaths: [(dataObj.path as string) || body.title],
      changedPaths: [(dataObj.path as string) || body.title],
      whatHappened: [`Created plan: ${body.title}`, `Verified: ${dataObj.verified}`],
      provenFacts: [`Plan created successfully`, `Bytes written: ${bytesWritten}`],
      nextActions: ['Read the plan', 'Create another plan']
    })))
  } catch (err) {
    const { error, status } = unwrapActionError(err, 'Create plan error')
    return NextResponse.json(error && typeof error === 'object' ? error : buildActionErrorEnvelope({
      code: 'BUILDFLOW_STATUS_ERROR',
      message: String(error)
    }), { status })
  }
}
