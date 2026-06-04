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

function withReadActivity(data: unknown, params: { mode: string; sourceId?: string; path?: string; paths?: string[] }) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data
  const obj = data as Record<string, unknown>
  const target = params.path || (params.paths && params.paths.length > 0 ? params.paths.slice(0, 3).join(', ') : undefined)
  return {
    ...obj,
    activity: {
      version: '1.2.13-beta',
      operationId: 'readBuildFlowContext',
      phase: 'completed',
      actionLabel: 'Read focused repo context',
      userMessage: target
        ? `BuildFlow completed ${params.mode} for ${target}.`
        : `BuildFlow completed ${params.mode}.`,
      sourceId: params.sourceId,
      readPaths: params.paths || (params.path ? [params.path] : undefined),
      riskLevel: 'low',
      requiresConfirmation: false,
      verified: true,
      nextStep: params.mode === 'grep_context' ? 'Use read_range around a matching line before patching.' : 'Use the returned evidence to answer or make the next small change.'
    }
  }
}

export async function POST(request: NextRequest) {
  const auth = checkActionAuth(request)
  if (!auth.valid) return auth.error

  try {
    const body = await request.json()
    const mode = typeof body.mode === 'string' ? body.mode : ''

    if (mode === 'list_files' || mode === 'search') {
      const data = await dispatchBuildFlowInspect({ ...body, mode }, auth.bearerToken)
      return NextResponse.json(stripBloat(withReadActivity(trimEntries(data), { mode, sourceId: body.sourceId, path: body.path })))
    }

    if (mode === 'grep_context' || mode === 'read_range' || mode === 'read_symbol') {
      const data = await executeAction('/api/focused-read', body, auth.bearerToken)
      return NextResponse.json(stripBloat(withReadActivity(data, { mode, sourceId: body.sourceId, path: body.path })))
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
      return NextResponse.json(stripBloat(withReadActivity({ ...(data as Record<string, unknown>), degradedFrom: 'search_and_read', suggestedNextMode: 'read_range' }, { mode: 'grep_context', sourceId: body.sourceId, path: body.paths[0] })))
    }

    const data = await dispatchBuildFlowRead(body, auth.bearerToken)
    return NextResponse.json(stripBloat(withReadActivity(data, { mode, sourceId: body.sourceId, paths: body.paths })))
  } catch (err) {
    const { error, status } = unwrapActionError(err, 'read-context error')
    return NextResponse.json(error && typeof error === 'object' ? error : { error }, { status })
  }
}
