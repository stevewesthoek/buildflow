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
    const data = await executeAction('/api/patch-file', body, auth.bearerToken)
    if ((data as { verified?: unknown }).verified !== true) {
      return NextResponse.json(buildActionErrorEnvelope({
        code: 'BUILDFLOW_STATUS_ERROR',
        message: 'Write was not verified'
      }), { status: 502 })
    }
    const dataObj = data as Record<string, unknown>
    const replacements = typeof dataObj.replacements === 'number' ? dataObj.replacements : 0
    return NextResponse.json(withActivity(dataObj, makeActivity({
      operationId: 'patchBuildFlowFileChange',
      phase: 'completed',
      actionLabel: 'Patched file',
      userMessage: `Patched file: ${body.path} with ${replacements} replacements`,
      riskLevel: 'medium',
      requiresConfirmation: false,
      verified: true,
      targetPaths: [body.path as string],
      changedPaths: [body.path as string],
      whatHappened: [`Patched ${body.path}`, `Made ${replacements} text replacements`, `Verified: ${dataObj.verified}`],
      provenFacts: [`Patch applied successfully`, `Replacements: ${replacements}`],
      nextActions: ['Read the updated file', 'Apply another patch']
    })))
  } catch (err) {
    const { error, status } = unwrapActionError(err, 'Patch file error')
    if (error && typeof error === 'object') {
      return NextResponse.json(error, { status })
    }
    return NextResponse.json(buildActionErrorEnvelope({
      code: 'BUILDFLOW_STATUS_ERROR',
      message: String(error)
    }), { status })
  }
}
