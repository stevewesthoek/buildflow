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

function buildDeadlinePayload(context: DeadlineContext, params: DeadlineParams) {
  return buildActionErrorEnvelope({
    code: 'BUILDFLOW_ACTION_DEADLINE_EXCEEDED',
    message: 'BuildFlow stopped this action before the hosting gateway timed out.',
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
  const mutableDiagnostics: ActionDiagnostics = {
    requestId,
    operationId: params.operationId,
    route: params.route,
    actionDeadlineMs: params.deadlineMs,
    phase: 'starting'
  }

  const context: DeadlineContext = {
    operationId: params.operationId,
    route: params.route,
    requestId,
    startedAt,
    deadlineMs: params.deadlineMs,
    signal: controller.signal,
    setPhase: (phase: string) => {
      mutableDiagnostics.phase = phase
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
  const timeoutResponse = new Promise<NextResponse>((resolve) => {
    timer = setTimeout(() => {
      context.setPhase(`${String(mutableDiagnostics.phase || 'running')}:deadline_exceeded`)
      controller.abort()
      resolve(NextResponse.json(buildDeadlinePayload(context, params), {
        status: 200,
        headers: {
          'Cache-Control': 'no-store',
          'X-Workbench-Request-Id': requestId
        }
      }))
    }, params.deadlineMs)
  })

  try {
    const actionResponse = handler(context)
    const response = await Promise.race([actionResponse, timeoutResponse])
    response.headers.set('X-Workbench-Request-Id', requestId)
    return response
  } finally {
    if (timer) clearTimeout(timer)
  }
}
