import { NextRequest, NextResponse } from 'next/server'
import { checkActionAuth } from '@/lib/actionAuth'
import { dispatchBuildFlowRead, dispatchBuildFlowInspect, unwrapActionError } from '@/lib/actions/gpt'
import { GPT_ACTION_RESPONSE_BYTE_LIMIT } from '@/lib/actions/payload-budget'
import { executeAction } from '@/lib/actions/transport'
import { buildActionErrorEnvelope, stripBloat } from '@/lib/actions/action-response'
import { GPT_ACTION_DEADLINES_MS, withGptActionDeadline } from '@/lib/actions/deadline'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const READ_CONTEXT_RESPONSE_BUDGET_BYTES = GPT_ACTION_RESPONSE_BYTE_LIMIT

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

function validateResponseSize(data: unknown): { ok: boolean; bytes?: number; error?: string } {
  if (!data || typeof data !== 'object') return { ok: true }
  const responseBytes = Buffer.byteLength(JSON.stringify(data), 'utf8')
  if (responseBytes > READ_CONTEXT_RESPONSE_BUDGET_BYTES) {
    return { ok: false, bytes: responseBytes, error: `Response ${responseBytes} bytes exceeds budget ${READ_CONTEXT_RESPONSE_BUDGET_BYTES}` }
  }
  return { ok: true, bytes: responseBytes }
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(min, Math.min(max, Math.floor(numeric)))
}

function isBroadUnscopedQuery(query: unknown): boolean {
  if (typeof query !== 'string') return false
  const normalized = query.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!normalized || normalized.length < 3) return true
  return /^(all|everything|repo|repository|code|codebase|context|files|docs|documentation|read everything|whole repo|entire repo)$/.test(normalized)
}

function needsNarrowerScope(params: { sourceId?: string; mode: string; query?: unknown; paths?: unknown; path?: unknown }) {
  return buildActionErrorEnvelope({
    code: 'BUILDFLOW_NEEDS_NARROWER_SCOPE',
    message: 'BuildFlow needs a narrower read request before it can respond quickly.',
    details: 'Broad unscoped searches and large reads are refused at the GPT boundary to prevent action timeouts.',
    recovery: [
      'Use grep_context with a specific path and pattern.',
      'Use read_range with a path and line range.',
      'Use prepare_task_context with a concrete task goal.'
    ],
    status: 'needs_narrower_scope',
    connected: true,
    diagnostics: {
      operationId: 'readBuildFlowContext',
      route: '/api/actions/read-context',
      phase: 'scope_guard',
      sourceId: params.sourceId,
      mode: params.mode,
      path: typeof params.path === 'string' ? params.path : undefined,
      paths: Array.isArray(params.paths) ? params.paths.filter((item): item is string => typeof item === 'string').slice(0, 5) : undefined,
      suggestedNarrowerMode: params.mode === 'read_paths' ? 'read_range' : 'grep_context',
      suggestedNextAction: 'Retry with one exact file path plus grep_context, read_range, or read_symbol.'
    }
  })
}

export async function POST(request: NextRequest) {
  return withGptActionDeadline({
    operationId: 'readBuildFlowContext',
    route: '/api/actions/read-context',
    deadlineMs: GPT_ACTION_DEADLINES_MS.readContext,
    suggestedNarrowerMode: 'grep_context',
    suggestedNextAction: 'Split the read into grep_context, read_range, or read_symbol.'
  }, async (deadline) => {
    deadline.setPhase('authenticate')
    const auth = checkActionAuth(request)
    deadline.markStage('authentication_complete', { authValid: auth.valid })
    if (!auth.valid) return auth.error!

    deadline.setPhase('parse_body')
    const body = await request.json()
    const mode = typeof body.mode === 'string' ? body.mode : ''
    const sourceId = typeof body.sourceId === 'string' ? body.sourceId : undefined
    const paths = Array.isArray(body.paths) ? body.paths.filter((item: unknown): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, 5) : undefined
    const maxBytesPerFile = boundedInt(body.maxBytesPerFile, 3000, 1000, 4000)
    const baseBody = {
      ...body,
      ...(paths ? { paths } : {}),
      ...(mode === 'read_paths' || mode === 'search_and_read' || mode === 'prepare_task_context' ? { maxBytesPerFile } : {}),
      ...(mode === 'list_files' || mode === 'search' || mode === 'search_and_read' || mode === 'prepare_task_context' ? { limit: boundedInt(body.limit, 5, 1, 5) } : {})
    }
    deadline.addDiagnostics({
      sourceId,
      mode,
      path: typeof body.path === 'string' ? body.path : undefined,
      paths
    })

    if ((mode === 'search' || mode === 'search_and_read') && !Array.isArray(body.paths) && !body.path && isBroadUnscopedQuery(body.query)) {
      return NextResponse.json(stripBloat(withReadActivity(needsNarrowerScope({ sourceId, mode, query: body.query }), { mode, sourceId, paths })))
    }

    if (Array.isArray(body.paths) && body.paths.length > 5 && (mode === 'read_paths' || mode === 'search_and_read')) {
      return NextResponse.json(stripBloat(withReadActivity({
        ...needsNarrowerScope({ sourceId, mode, paths: body.paths }),
        refusedPathCount: body.paths.length - 5,
        acceptedPaths: paths
      }, { mode, sourceId, paths })))
    }

    const transport = (phase: string) => ({
      signal: deadline.signal,
      timeoutMs: deadline.transportTimeoutMs(7500),
      diagnostics: deadline.diagnostics({ phase, sourceId, mode, path: typeof body.path === 'string' ? body.path : undefined, paths })
    })

    if (mode === 'list_files' || mode === 'search') {
      deadline.setPhase(mode)
      const data = await dispatchBuildFlowInspect({ ...baseBody, mode }, auth.bearerToken, transport(mode))
      const response = stripBloat(withReadActivity(trimEntries(data), { mode, sourceId: body.sourceId, path: body.path }))
      const sizeCheck = validateResponseSize(response)
      if (!sizeCheck.ok) {
        return NextResponse.json(buildActionErrorEnvelope({
          code: 'BUILDFLOW_RESPONSE_SIZE_EXCEEDED',
          message: 'BuildFlow response exceeded action size budget.',
          details: `Response was ${sizeCheck.bytes} bytes, limit is ${READ_CONTEXT_RESPONSE_BUDGET_BYTES} bytes.`,
          recovery: ['Use grep_context with a more specific pattern', 'Use read_range on a specific file', 'Reduce the limit parameter'],
          status: 'needs_narrower_scope',
          diagnostics: { phase: 'response_size_check', responseBytes: sizeCheck.bytes, budgetBytes: READ_CONTEXT_RESPONSE_BUDGET_BYTES }
        }))
      }
      return NextResponse.json(response)
    }

    if (mode === 'graph_context') {
      deadline.setPhase('graph_context')
      const data = await executeAction('/api/graph-context', {
        sourceId: body.sourceId,
        query: typeof body.query === 'string' ? body.query : undefined,
        limit: boundedInt(body.limit, 8, 1, 10)
      }, auth.bearerToken, transport('graph_context'))
      const response = stripBloat(withReadActivity(data, { mode, sourceId: body.sourceId }))
      const sizeCheck = validateResponseSize(response)
      if (!sizeCheck.ok) {
        return NextResponse.json(buildActionErrorEnvelope({
          code: 'BUILDFLOW_RESPONSE_SIZE_EXCEEDED',
          message: 'BuildFlow graph response exceeded action size budget.',
          details: `Response was ${sizeCheck.bytes} bytes.`,
          recovery: ['Use a narrower query', 'Reduce the limit', 'Use grep_context instead'],
          status: 'needs_narrower_scope'
        }))
      }
      return NextResponse.json(response)
    }

    if (mode === 'grep_context' || mode === 'read_range' || mode === 'read_symbol') {
      deadline.setPhase(mode)
      const data = await executeAction('/api/focused-read', {
        ...body,
        before: boundedInt(body.before, 8, 0, 40),
        after: boundedInt(body.after, 12, 0, 60),
        maxMatches: boundedInt(body.maxMatches, 5, 1, 10)
      }, auth.bearerToken, transport(mode))
      const response = stripBloat(withReadActivity(data, { mode, sourceId: body.sourceId, path: body.path }))
      const sizeCheck = validateResponseSize(response)
      if (!sizeCheck.ok) {
        return NextResponse.json(buildActionErrorEnvelope({
          code: 'BUILDFLOW_RESPONSE_SIZE_EXCEEDED',
          message: 'BuildFlow focused read response exceeded action size budget.',
          details: `Response was ${sizeCheck.bytes} bytes.`,
          recovery: [`Reduce the line context (before/after)`, `Reduce maxMatches`, 'Use read_range with a smaller line range'],
          status: 'needs_narrower_scope'
        }))
      }
      return NextResponse.json(response)
    }

    if (mode === 'search_and_read' && Array.isArray(body.paths) && body.paths.length === 1 && typeof body.query === 'string') {
      deadline.setPhase('search_and_read_single_path_grep')
      const data = await executeAction('/api/focused-read', {
        mode: 'grep_context',
        sourceId: body.sourceId,
        path: body.paths[0],
        pattern: body.query.replace(/^(content|full):/i, ''),
        before: boundedInt(body.before, 8, 0, 40),
        after: boundedInt(body.after, 12, 0, 60),
        maxMatches: boundedInt(body.maxMatches, 5, 1, 10)
      }, auth.bearerToken, transport('search_and_read_single_path_grep'))
      const response = stripBloat(withReadActivity({ ...(data as Record<string, unknown>), degradedFrom: 'search_and_read', suggestedNextMode: 'read_range' }, { mode: 'grep_context', sourceId: body.sourceId, path: body.paths[0] }))
      const sizeCheck = validateResponseSize(response)
      if (!sizeCheck.ok) {
        return NextResponse.json(buildActionErrorEnvelope({
          code: 'BUILDFLOW_RESPONSE_SIZE_EXCEEDED',
          message: 'BuildFlow search_and_read response exceeded action size budget.',
          details: `Response was ${sizeCheck.bytes} bytes.`,
          recovery: ['Use grep_context with a more specific pattern', 'Check if the file is too large for exact reading'],
          status: 'needs_narrower_scope'
        }))
      }
      return NextResponse.json(response)
    }

    deadline.setPhase(mode || 'read_context')
    const data = await dispatchBuildFlowRead(baseBody, auth.bearerToken, transport(mode || 'read_context'))
    const response = stripBloat(withReadActivity(data, { mode, sourceId: body.sourceId, paths: body.paths }))
    const sizeCheck = validateResponseSize(response)
    if (!sizeCheck.ok) {
      return NextResponse.json(buildActionErrorEnvelope({
        code: 'BUILDFLOW_RESPONSE_SIZE_EXCEEDED',
        message: 'BuildFlow read response exceeded action size budget.',
        details: `Response was ${sizeCheck.bytes} bytes, limit is ${READ_CONTEXT_RESPONSE_BUDGET_BYTES} bytes.`,
        recovery: ['Use a narrower read mode', 'Reduce the number of paths', 'Use grep_context instead'],
        status: 'needs_narrower_scope'
      }))
    }
    return NextResponse.json(response)
  }).catch((err) => {
    const { error, status } = unwrapActionError(err, 'read-context error')
    return NextResponse.json(error && typeof error === 'object' ? error : { error }, { status, headers: { 'Cache-Control': 'no-store' } })
  })
}
