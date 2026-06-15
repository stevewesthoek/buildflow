import { NextResponse } from 'next/server'
import { buildActionErrorEnvelope, type ActionDiagnostics } from './action-response'

export const GPT_ACTION_DEADLINES_MS = {
  status: 4_000,
  readContext: 8_000,
  applyFileChange: 8_000,
  commitChanges: 10_000,
  runCommand: 12_000
} as const

function generateRequestId(): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).slice(2, 8)
  return `wr_${timestamp}_${random}`
}

export type DeadlineContext = {
  operationId: string
  route: string
  requestId: string
  startedAt: number
  deadlineMs: number
  signal: AbortSignal
  setPhase: (phase: string) => void
  markStage: (stage: string, extra?: ActionDiagnostics) => void
  addDiagnostics: (diagnostics: ActionDiagnostics) => void
  diagnostics: (extra?: ActionDiagnostics) => ActionDiagnostics
  elapsedMs: () => number
  remainingMs: () => number
  transportTimeoutMs: (maxMs?: number) => number
}

type DeadlineParams = {
  operationId: string
  route: string
  deadlineMs: number
  suggestedNarrowerMode?: string
  suggestedNextAction?: string
}

const DEFAULT_RECOVERY = [
  'Use a narrower read mode such as grep_context or read_range.',
  'Split the task into a smaller request.',
  'Run validation in a separate prompt.'
]

function compactDiagnostics(input: ActionDiagnostics): ActionDiagnostics {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== null)) as ActionDiagnostics
}

function logActionEvent(event: string, diagnostics: ActionDiagnostics) {
  const payload = compactDiagnostics({
    tool: 'workbench_action_origin',
    event,
    ...diagnostics
  })
  console.info(JSON.stringify(payload))
}

function buildDeadlinePayload(context: DeadlineContext, params: DeadlineParams) {
  return buildActionErrorEnvelope({
    code: 'WORKBENCH_ACTION_DEADLINE_EXCEEDED',
    message: 'Workbench stopped this action before the hosting gateway timed out.',
    details: `${params.operationId} exceeded its ${params.deadlineMs}ms GPT-facing deadline.`,
    recovery: DEFAULT_RECOVERY,
    status: 'timeout',
    connected: true,
    requestId: context.requestId,
    diagnostics: context.diagnostics({
      requestId: context.requestId,
      elapsedMs: context.elapsedMs(),
      deadlineMs: params.deadlineMs,
      actionDeadlineMs: params.deadlineMs,
      suggestedNarrowerMode: params.suggestedNarrowerMode,
      suggestedNextAction: params.suggestedNextAction
    })
  })
}

export async function withGptActionDeadline(
  params: DeadlineParams,
  handler: (context: DeadlineContext) => Promise<NextResponse>
): Promise<NextResponse> {
  const startedAt = Date.now()
  const requestId = generateRequestId()
  const controller = new AbortController()
  const stages: Array<ActionDiagnostics> = []
  const mutableDiagnostics: ActionDiagnostics = {
    requestId,
    operationId: params.operationId,
    route: params.route,
    actionDeadlineMs: params.deadlineMs,
    phase: 'starting'
  }

  const recordStage = (stage: string, extra?: ActionDiagnostics) => {
    const entry = compactDiagnostics({
      stage,
      phase: stage,
      elapsedMs: Date.now() - startedAt,
      remainingMs: Math.max(0, params.deadlineMs - (Date.now() - startedAt)),
      ...(extra || {})
    })
    stages.push(entry)
    if (stages.length > 24) stages.shift()
    mutableDiagnostics.phase = stage
    mutableDiagnostics.stages = stages
  }

  const context: DeadlineContext = {
    operationId: params.operationId,
    route: params.route,
    requestId,
    startedAt,
    deadlineMs: params.deadlineMs,
    signal: controller.signal,
    setPhase: (phase: string) => {
      recordStage(phase)
    },
    markStage: (stage: string, extra?: ActionDiagnostics) => {
      recordStage(stage, extra)
    },
    addDiagnostics: (diagnostics: ActionDiagnostics) => {
      Object.assign(mutableDiagnostics, compactDiagnostics(diagnostics))
    },
    diagnostics: (extra?: ActionDiagnostics) => compactDiagnostics({
      ...mutableDiagnostics,
      ...(extra || {}),
      elapsedMs: extra?.elapsedMs ?? Date.now() - startedAt
    }),
    elapsedMs: () => Date.now() - startedAt,
    remainingMs: () => Math.max(0, params.deadlineMs - (Date.now() - startedAt)),
    transportTimeoutMs: (maxMs = params.deadlineMs) => Math.max(1, Math.min(maxMs, Math.max(1, params.deadlineMs - (Date.now() - startedAt) - 250)))
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  recordStage('route_start')
  logActionEvent('start', context.diagnostics({ phase: 'route_start' }))
  const timeoutResponse = new Promise<NextResponse>((resolve) => {
    timer = setTimeout(() => {
      context.setPhase(`${String(mutableDiagnostics.phase || 'running')}:deadline_exceeded`)
      controller.abort()
      logActionEvent('deadline_exceeded', context.diagnostics({ phase: String(mutableDiagnostics.phase || 'deadline_exceeded') }))
      const payload = buildDeadlinePayload(context, params)
      resolve(NextResponse.json(payload, {
        status: 200,
        headers: {
          'Cache-Control': 'no-store',
          'X-Workbench-Request-Id': requestId,
          'X-Workbench-Deadline-Phase': String(mutableDiagnostics.phase || 'deadline_exceeded')
        }
      }))
    }, params.deadlineMs)
  })

  try {
    const actionResponse = handler(context)
    const response = await Promise.race([actionResponse, timeoutResponse])
    context.markStage('response_ready', { statusCode: response.status })
    response.headers.set('X-Workbench-Request-Id', requestId)
    response.headers.set('X-Workbench-Deadline-Phase', String(mutableDiagnostics.phase || 'response_ready'))
    logActionEvent('finish', context.diagnostics({
      phase: String(mutableDiagnostics.phase || 'response_ready'),
      statusCode: response.status,
      elapsedMs: context.elapsedMs(),
      remainingMs: context.remainingMs()
    }))
    return response
  } catch (err) {
    context.markStage('unhandled_error', {
      errorName: err instanceof Error ? err.name : undefined,
      errorMessage: err instanceof Error ? err.message : String(err)
    })
    logActionEvent('error', context.diagnostics({ phase: 'unhandled_error' }))
    const transportPayload = err && typeof err === 'object' && 'payload' in err
      ? (err as { payload?: unknown }).payload
      : undefined
    let statusCode = err && typeof err === 'object' && 'statusCode' in err && typeof (err as { statusCode?: unknown }).statusCode === 'number'
      ? (err as { statusCode: number }).statusCode
      : 500

    if (transportPayload && typeof transportPayload === 'object' && 'error' in transportPayload) {
      const errorCode = (transportPayload as { error?: { code?: unknown } }).error?.code
      if (typeof errorCode === 'string' && errorCode) {
        const gatewayStatuses = [502, 503, 504, 507]
        if (gatewayStatuses.includes(statusCode)) {
          statusCode = 200
        }
      }
    }

    const payload = transportPayload && typeof transportPayload === 'object' && !Array.isArray(transportPayload)
      ? {
          ...(transportPayload as Record<string, unknown>),
          requestId,
          diagnostics: compactDiagnostics({
            ...(((transportPayload as Record<string, unknown>).diagnostics && typeof (transportPayload as Record<string, unknown>).diagnostics === 'object')
              ? (transportPayload as Record<string, unknown>).diagnostics as Record<string, unknown>
              : {}),
            ...context.diagnostics({ phase: 'unhandled_error' })
          })
        }
      : buildActionErrorEnvelope({
          code: 'WORKBENCH_ACTION_ERROR',
          message: 'Workbench action failed before response completion.',
          details: err instanceof Error ? err.message : String(err),
          status: controller.signal.aborted ? 'timeout' : 'error',
          requestId,
          diagnostics: context.diagnostics({ phase: 'unhandled_error' })
        })
    const response = NextResponse.json(payload, {
      status: statusCode,
      headers: {
        'Cache-Control': 'no-store',
        'X-Workbench-Request-Id': requestId
      }
    })
    response.headers.set('X-Workbench-Deadline-Phase', String(mutableDiagnostics.phase || 'unhandled_error'))
    return response
  } finally {
    if (timer) clearTimeout(timer)
  }
}
