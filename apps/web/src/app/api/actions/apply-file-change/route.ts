import { NextRequest, NextResponse } from 'next/server'
import { checkActionAuth } from '@/lib/actionAuth'
import { dispatchWorkbenchFileChange } from '@/lib/actions/portable-operation-adapters'
import { unwrapActionError } from '@/lib/actions/gpt'
import { buildActionErrorEnvelope, stripBloat } from '@/lib/actions/action-response'
import { getSafeActionHttpStatus } from '@/lib/actions/http-status'
import { GPT_ACTION_DEADLINES_MS, withGptActionDeadline } from '@/lib/actions/deadline'
import { requiresVerifiedFileWrite } from '@/lib/actions/file-change-verification'
import {
  buildRolledBackPacketTelemetryInput,
  buildRunCommandRouteTelemetryInput,
  recordRunCommandTelemetry,
  type RunCommandTelemetryDisposition,
  type RunCommandTelemetryReason
} from '@/lib/actions/run-command-telemetry'

export const dynamic = 'force-dynamic'
export const revalidate = 0

function jsonWithApplyFileChangeTelemetry(
  payload: unknown,
  init: ResponseInit | undefined,
  input: {
    requestId: string
    requestDurationMs: number
    disposition: RunCommandTelemetryDisposition
    reasonCode: RunCommandTelemetryReason
    sourceId?: string
  }
) {
  recordRunCommandTelemetry(buildRunCommandRouteTelemetryInput(payload, {
    ...input,
    operationId: 'applyWorkbenchFileChange'
  }))
  return NextResponse.json(payload, init)
}

export async function POST(request: NextRequest) {
  return withGptActionDeadline({
    operationId: 'applyBuildFlowFileChange',
    route: '/api/actions/apply-file-change',
    deadlineMs: GPT_ACTION_DEADLINES_MS.applyFileChange,
    suggestedNextAction: 'Split the write into a smaller patch or dry-run first.'
  }, async (deadline) => {
    deadline.setPhase('authenticate')
    const auth = checkActionAuth(request)
    deadline.markStage('authentication_complete', { authValid: auth.valid })
    if (!auth.valid) return auth.error!

    deadline.setPhase('parse_body')
    const body = await request.json()
    deadline.addDiagnostics({
      sourceId: typeof body.sourceId === 'string' ? body.sourceId : undefined,
      path: typeof body.path === 'string' ? body.path : undefined,
      mode: typeof body.changeType === 'string' ? body.changeType : undefined
    })
    const isDryRun = body.dryRun === true || body.preflight === true
    deadline.setPhase(isDryRun ? 'preflight_write' : 'apply_file_change')
    let data: unknown
    try {
      data = await dispatchWorkbenchFileChange(body, auth.bearerToken, {
        signal: deadline.signal,
        timeoutMs: deadline.transportTimeoutMs(7500),
        requestId: deadline.requestId,
        diagnostics: deadline.diagnostics({
          phase: isDryRun ? 'preflight_write' : 'apply_file_change',
          sourceId: typeof body.sourceId === 'string' ? body.sourceId : undefined,
          path: typeof body.path === 'string' ? body.path : undefined,
          mode: typeof body.changeType === 'string' ? body.changeType : undefined
        })
      })
    } catch (err) {
      if (body.changeType === 'packet_preflight') {
        deadline.markStage('unhandled_error', {
          errorName: err instanceof Error ? err.name : undefined,
          errorMessage: err instanceof Error ? err.message : String(err)
        })
        const { error, status } = unwrapActionError(err, 'apply-file-change preflight error')
        if (!error || typeof error !== 'object' || Array.isArray(error)) throw err
        const existingDiagnostics = 'diagnostics' in error && error.diagnostics && typeof error.diagnostics === 'object'
          ? error.diagnostics as Record<string, unknown>
          : {}
        const payload = {
          ...error as Record<string, unknown>,
          requestId: deadline.requestId,
          diagnostics: {
            ...existingDiagnostics,
            ...deadline.diagnostics({ phase: 'unhandled_error' })
          }
        }
        recordRunCommandTelemetry(buildRunCommandRouteTelemetryInput(payload, {
          requestId: deadline.requestId,
          requestDurationMs: deadline.elapsedMs(),
          operationId: 'applyWorkbenchFileChange',
          disposition: 'rejected',
          reasonCode: 'command_rejected',
          sourceId: typeof body.sourceId === 'string' ? body.sourceId : undefined
        }))
        return NextResponse.json(payload, {
          status,
          headers: { 'Cache-Control': 'no-store' }
        })
      }
      if (body.changeType !== 'packet_execute') throw err
      deadline.markStage('unhandled_error', {
        errorName: err instanceof Error ? err.name : undefined,
        errorMessage: err instanceof Error ? err.message : String(err)
      })
      const { error, status } = unwrapActionError(err, 'apply-file-change error')
      if (!error || typeof error !== 'object' || Array.isArray(error)) throw err
      const existingDiagnostics = 'diagnostics' in error && error.diagnostics && typeof error.diagnostics === 'object'
        ? error.diagnostics as Record<string, unknown>
        : {}
      const payload = {
        ...error as Record<string, unknown>,
        requestId: deadline.requestId,
        diagnostics: {
          ...existingDiagnostics,
          ...deadline.diagnostics({ phase: 'unhandled_error' })
        }
      }
      const telemetry = buildRolledBackPacketTelemetryInput(payload, {
        requestId: deadline.requestId,
        requestDurationMs: deadline.elapsedMs(),
        sourceId: typeof body.sourceId === 'string' ? body.sourceId : undefined
      })
      recordRunCommandTelemetry(telemetry)
      return NextResponse.json(payload, {
        status,
        headers: { 'Cache-Control': 'no-store' }
      })
    }

    if ('error' in (data as Record<string, unknown>)) {
      const payload = data as { error: unknown }
      const status = getSafeActionHttpStatus(payload.error)
      if (isDryRun) {
        return NextResponse.json(stripBloat(data), { status: 200 })
      }
      if (payload.error && typeof payload.error === 'object') {
        return NextResponse.json(payload.error, { status, headers: { 'Cache-Control': 'no-store' } })
      }
      return NextResponse.json(buildActionErrorEnvelope({
        code: 'BUILDFLOW_STATUS_ERROR',
        message: String(payload.error),
        status: 'error'
      }), { status, headers: { 'Cache-Control': 'no-store' } })
    }

    if (requiresVerifiedFileWrite(body.changeType, isDryRun) && (data as { verified?: unknown }).verified !== true) {
      return NextResponse.json(buildActionErrorEnvelope({
        code: 'BUILDFLOW_STATUS_ERROR',
        message: 'Write was not verified'
      }), { status: 502 })
    }
    return jsonWithApplyFileChangeTelemetry(stripBloat(data), undefined, {
      requestId: deadline.requestId,
      requestDurationMs: deadline.elapsedMs(),
      disposition: 'success',
      reasonCode: 'command_completed',
      sourceId: typeof body.sourceId === 'string' ? body.sourceId : undefined
    })
  }).catch((err) => {
    const { error, status } = unwrapActionError(err, 'apply-file-change error')
    const finalStatus = getSafeActionHttpStatus(error)
    if (error && typeof error === 'object') {
      return NextResponse.json(error, { status: finalStatus, headers: { 'Cache-Control': 'no-store' } })
    }
    return NextResponse.json(buildActionErrorEnvelope({
      code: 'BUILDFLOW_STATUS_ERROR',
      message: String(error),
      status: 'error'
    }), { status: finalStatus, headers: { 'Cache-Control': 'no-store' } })
  })
}
