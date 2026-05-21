import { NextRequest, NextResponse } from 'next/server'
import { checkActionAuth } from '@/lib/actionAuth'
import { listBuildFlowSources, unwrapActionError, withActionRouteDiagnostics } from '@/lib/actions/gpt'

export async function GET(request: NextRequest) {
  const startedAt = Date.now()
  const auth = checkActionAuth(request)
  if (!auth.valid) return auth.error
  try {
    const data = await listBuildFlowSources(auth.bearerToken)
    return NextResponse.json(withActionRouteDiagnostics(data as Record<string, unknown>, { route: '/api/actions/sources', startedAt }), {
      headers: { 'Cache-Control': 'public, max-age=30' }
    })
  } catch (err) {
    const { error, status } = unwrapActionError(err, 'sources error')
    return NextResponse.json(error && typeof error === 'object' ? error : { error }, { status })
  }
}
