import { NextRequest, NextResponse } from 'next/server'
import { checkActionAuth } from '@/lib/actionAuth'
import { dispatchBuildFlowRead, dispatchBuildFlowInspect, unwrapActionError } from '@/lib/actions/gpt'
import { executeAction } from '@/lib/actions/transport'
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

    if (mode === 'grep_context' || mode === 'read_range' || mode === 'read_symbol') {
      const data = await executeAction('/api/focused-read', body, auth.bearerToken)
      return NextResponse.json(stripBloat(data))
    }

    if (mode === 'search_and_read' && Array.isArray(body.paths) && body.paths.length === 1 && typeof body.query === 'string') {
      const data = await executeAction('/api/focused-read', {
        mode: 'grep_context',
        sourceId: body.sourceId,
        path: body.paths[0],
        pattern: body.query.replace(/^(content|full):/i, ''),
        before: typeof body.before === 'number' ? body.before : 20,
        after: typeof body.after === 'number' ? body.after : 40,
        maxMatches: typeof body.maxMatches === 'number' ? body.maxMatches : 5
      }, auth.bearerToken)
      return NextResponse.json(stripBloat({ ...(data as Record<string, unknown>), degradedFrom: 'search_and_read', suggestedNextMode: 'read_range' }))
    }

    const data = await dispatchBuildFlowRead(body, auth.bearerToken)
    return NextResponse.json(stripBloat(data))
  } catch (err) {
    const { error, status } = unwrapActionError(err, 'read-context error')
    return NextResponse.json(error && typeof error === 'object' ? error : { error }, { status })
  }
}
