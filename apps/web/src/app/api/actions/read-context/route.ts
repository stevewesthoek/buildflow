import { NextRequest, NextResponse } from 'next/server'
import { checkActionAuth } from '@/lib/actionAuth'
import { dispatchBuildFlowRead, dispatchBuildFlowInspect, unwrapActionError } from '@/lib/actions/gpt'
import { stripBloat } from '@/lib/actions/action-response'

export const dynamic = 'force-dynamic'
export const revalidate = 0

function trimEntries(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data
  const obj = data as Record<string, unknown>
  if (Array.isArray(obj.entries)) {
    obj.entries = (obj.entries as Record<string, unknown>[]).map(e => ({
      path: e.path,
      type: e.type
    }))
  }
  return obj
}

export async function POST(request: NextRequest) {
  const auth = checkActionAuth(request)
  if (!auth.valid) return auth.error

  try {
    const body = await request.json()
    const mode = typeof body.mode === 'string' ? body.mode : ''

    if (mode === 'list_files' || mode === 'search') {
      const data = await dispatchBuildFlowInspect({ ...body, mode }, auth.bearerToken)
      return NextResponse.json(stripBloat(trimEntries(data)))
    }

    const data = await dispatchBuildFlowRead(body, auth.bearerToken)
    return NextResponse.json(stripBloat(data))
  } catch (err) {
    const { error, status } = unwrapActionError(err, 'read-context error')
    return NextResponse.json(error && typeof error === 'object' ? error : { error }, { status })
  }
}
