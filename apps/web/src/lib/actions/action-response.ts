import { NextResponse } from 'next/server'

export function stripBloat(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data
  const obj = { ...(data as Record<string, unknown>) }
  // Keep compact `activity` feedback so the Custom GPT can summarize what happened after each action.
  // Drop only noisy timing/debug payloads that increase latency and token use.
  delete obj._diagnostics
  delete obj.timings
  return obj
}

export type ActionErrorCode =
  | 'LOCAL_STACK_UNAVAILABLE'
  | 'LOCAL_STACK_TIMEOUT'
  | 'EMPTY_RELAY_RESPONSE'
  | 'INVALID_RELAY_RESPONSE'
  | 'BUILDFLOW_ACTION_DEADLINE_EXCEEDED'
  | 'BUILDFLOW_NEEDS_NARROWER_SCOPE'
  | 'BUILDFLOW_STATUS_ERROR'
  | 'ACTION_TRANSPORT_ERROR'
  | string

export type ActionStatus = 'unavailable' | 'error' | 'timeout' | 'needs_narrower_scope'

export type ActionDiagnostics = {
  operationId?: string
  route?: string
  actionDeadlineMs?: number
  elapsedMs?: number
  deadlineMs?: number
  phase?: string
  sourceId?: string
  path?: string
  paths?: string[]
  mode?: string
  commandKind?: string
  responseBytes?: number
  suggestedNarrowerMode?: string
  suggestedNextAction?: string
  [key: string]: unknown
}

export type ActionErrorEnvelope = {
  ok: false
  connected: boolean
  status: ActionStatus
  error: {
    code: ActionErrorCode
    message: string
    details?: string
    recovery?: string[]
  }
  diagnostics?: ActionDiagnostics
}

export function buildActionErrorEnvelope(params: {
  code: ActionErrorCode
  message: string
  details?: string
  recovery?: string[]
  status?: ActionStatus
  connected?: boolean
  diagnostics?: ActionDiagnostics
}): ActionErrorEnvelope {
  return {
    ok: false,
    connected: params.connected ?? false,
    status: params.status || 'error',
    error: {
      code: params.code,
      message: params.message,
      ...(params.details ? { details: params.details } : {}),
      ...(params.recovery && params.recovery.length > 0 ? { recovery: params.recovery } : {})
    },
    ...(params.diagnostics ? { diagnostics: params.diagnostics } : {})
  }
}

export function buildActionErrorResponse(params: {
  code: ActionErrorCode
  message: string
  details?: string
  recovery?: string[]
  statusCode?: number
  status?: ActionStatus
  connected?: boolean
  diagnostics?: ActionDiagnostics
}) {
  return NextResponse.json(
    buildActionErrorEnvelope(params),
    {
      status: params.statusCode ?? 503,
      headers: {
        'Cache-Control': 'no-store'
      }
    }
  )
}
