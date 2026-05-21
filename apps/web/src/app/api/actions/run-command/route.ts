import { NextRequest, NextResponse } from 'next/server'
import { checkActionAuth } from '@/lib/actionAuth'
import { dispatchBuildFlowCommand, unwrapActionError } from '@/lib/actions/gpt'
import { buildActionErrorEnvelope, stripBloat } from '@/lib/actions/action-response'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function POST(request: NextRequest) {
  const auth = checkActionAuth(request)
  if (!auth.valid) return auth.error

  try {
    const body = await request.json()
    const data = await dispatchBuildFlowCommand(body, auth.bearerToken)
    const clean = stripBloat(data) as Record<string, unknown>
    return NextResponse.json({
      ok: clean.exitCode === 0,
      stdout: clean.stdout,
      stderr: clean.stderr,
      exitCode: clean.exitCode
    })
  } catch (err) {
    const { error, status } = unwrapActionError(err, 'run-command error')
    return NextResponse.json(error && typeof error === 'object' ? error : buildActionErrorEnvelope({
      code: 'BUILDFLOW_COMMAND_ERROR',
      message: String(error)
    }), { status })
  }
}
