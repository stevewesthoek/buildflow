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
  | 'BUILDFLOW_STATUS_ERROR'
  | 'ACTION_TRANSPORT_ERROR'
  | string

export type ActionErrorEnvelope = {
  ok: false
  connected: false
  status: 'unavailable' | 'error'
  error: {
    code: ActionErrorCode
    message: string
    details?: string
    recovery?: string[]
  }
}

export function buildActionErrorEnvelope(params: {
  code: ActionErrorCode
  message: string
  details?: string
  recovery?: string[]
  status?: 'unavailable' | 'error'
}): ActionErrorEnvelope {
  return {
    ok: false,
    connected: false,
    status: params.status || 'error',
    error: {
      code: params.code,
      message: params.message,
      ...(params.details ? { details: params.details } : {}),
      ...(params.recovery && params.recovery.length > 0 ? { recovery: params.recovery } : {})
    }
  }
}

export function buildActionErrorResponse(params: {
  code: ActionErrorCode
  message: string
  details?: string
  recovery?: string[]
  statusCode?: number
  status?: 'unavailable' | 'error'
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
