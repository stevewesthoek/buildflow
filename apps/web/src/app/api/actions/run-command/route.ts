import { NextRequest, NextResponse } from 'next/server'
import { sessionAwareRunWorkbenchCommandRequestSchema } from '@workbench/shared'
import { checkActionAuth } from '@/lib/actionAuth'
import { dispatchWorkbenchCommand } from '@/lib/actions/portable-operation-adapters'
import { sourceSelectionRequired, unwrapActionError } from '@/lib/actions/gpt'
import { buildActionErrorEnvelope, stripBloat } from '@/lib/actions/action-response'
import { GPT_ACTION_DEADLINES_MS, withGptActionDeadline } from '@/lib/actions/deadline'
import {
  buildRunCommandRouteTelemetryInput,
  recordRunCommandTelemetry,
  type RunCommandTelemetryInput
} from '@/lib/actions/run-command-telemetry'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const FAST_COMMAND_KINDS = new Set([
  'git_status_short',
  'git_diff_stat',
  'git_diff_name_only',
  'git_log_latest',
  'git_branch_current',
  'git_diff_cached_stat',
  'git_diff_cached_name_only',
  'validate_json_files',
  'security_scan_paths'
])

function commandTimeoutMs(commandKind: string, requested: unknown): number {
  const requestedMs = typeof requested === 'number' && Number.isFinite(requested) ? Math.floor(requested) : undefined
  const defaultMs = FAST_COMMAND_KINDS.has(commandKind) ? 5_000 : 8_000
  const ceilingMs = FAST_COMMAND_KINDS.has(commandKind) ? 8_000 : 11_000
  return Math.max(1_000, Math.min(requestedMs ?? defaultMs, ceilingMs))
}

function suggestedNextAction(commandKind: string): string {
  if (commandKind === 'type_check_web' || commandKind === 'type_check_cli') return 'Run the type check in a separate prompt after narrowing the change.'
  if (commandKind === 'run_package_test' || commandKind === 'run_package_script') return 'Run the slow package command in a separate prompt or use a narrower marker.'
  return 'Use a narrower command or inspect the partial stdout/stderr.'
}

function jsonWithRunCommandTelemetry(
  payload: unknown,
  init: ResponseInit | undefined,
  telemetry: Omit<RunCommandTelemetryInput, 'responseBytes' | 'renderedBytes' | 'actionRoundTrips' | 'retries' | 'interruptions'>
) {
  recordRunCommandTelemetry(buildRunCommandRouteTelemetryInput(payload, telemetry))
  return NextResponse.json(payload, init)
}

export async function POST(request: NextRequest) {
  const requestStartedAt = Date.now()
  let telemetrySourceId: string | undefined
  let telemetryCommandKind: string | undefined
  let telemetryRequestId: string | undefined

  return withGptActionDeadline({
    operationId: 'runBuildFlowCommand',
    route: '/api/actions/run-command',
    deadlineMs: GPT_ACTION_DEADLINES_MS.runCommand,
    suggestedNextAction: 'Run slow validation in a separate prompt.'
  }, async (deadline) => {
    telemetryRequestId = deadline.requestId
    deadline.setPhase('authenticate')
    const auth = checkActionAuth(request)
    deadline.markStage('authentication_complete', { authValid: auth.valid })
    if (!auth.valid) return auth.error!

    deadline.setPhase('parse_body')
    const rawBody = await request.json()
    const parsed = sessionAwareRunWorkbenchCommandRequestSchema.safeParse(rawBody)
    if (!parsed.success) {
      const payload = {
        ok: false,
        connected: true,
        status: 'blocked',
        error: {
          code: 'INVALID_WORKBENCH_COMMAND_REQUEST',
          message: 'The session-aware runWorkbenchCommand request failed strict validation.',
          issues: parsed.error.issues.slice(0, 10).map(issue => ({
            path: issue.path.join('.') || 'request',
            message: issue.message
          }))
        },
        diagnostics: deadline.diagnostics({ phase: 'invalid_command_request' })
      }
      return jsonWithRunCommandTelemetry(payload, { status: 400, headers: { 'Cache-Control': 'no-store' } }, {
        requestId: deadline.requestId,
        disposition: 'rejected',
        reasonCode: 'invalid_request',
        requestDurationMs: Date.now() - requestStartedAt
      })
    }
    const sessionId = parsed.data.sessionId
    const body = parsed.data.command
    const sourceSelection = sourceSelectionRequired(body.sourceId)
    if (sourceSelection) {
      const payload = {
        ok: false,
        connected: true,
        status: 'blocked',
        error: sourceSelection,
        sourceId: body.sourceId,
        diagnostics: deadline.diagnostics({ phase: 'source_selection_required' })
      }
      return jsonWithRunCommandTelemetry(payload, { status: 400 }, {
        requestId: deadline.requestId,
        disposition: 'rejected',
        reasonCode: 'source_selection_required',
        requestDurationMs: Date.now() - requestStartedAt
      })
    }
    telemetrySourceId = body.sourceId
    telemetryCommandKind = body.commandKind
    const commandKind = body.commandKind
    const validationJobOperation = 'validationJobOperation' in body ? body.validationJobOperation : undefined
    const requestedTimeoutMs = 'timeoutMs' in body ? body.timeoutMs : undefined
    const timeoutMs = Math.min(commandTimeoutMs(commandKind, requestedTimeoutMs), deadline.transportTimeoutMs(11_500))
    deadline.addDiagnostics({
      sourceId: body.sourceId,
      commandKind,
      paths: 'paths' in body && Array.isArray(body.paths) ? body.paths.slice(0, 10) : undefined
    })
    deadline.setPhase('run_command')
    const command = commandKind === 'n8n_workflow_migration' ? body : { ...body, timeoutMs }
    const data = await dispatchWorkbenchCommand({ version: 2, sessionId, command }, auth.bearerToken, {
      signal: deadline.signal,
      timeoutMs: deadline.transportTimeoutMs(11_750),
      diagnostics: deadline.diagnostics({
        phase: 'run_command',
        commandKind,
        sourceId: body.sourceId
      })
    })
    const clean = stripBloat(data) as Record<string, unknown>

    if (clean.status === 'timed_out' && validationJobOperation === undefined) {
      const payload = {
        ok: false,
        connected: true,
        status: 'timeout',
        error: {
          code: 'WORKBENCH_COMMAND_TIMEOUT',
          message: 'BuildFlow stopped this command before the GPT action deadline.',
          details: `${commandKind} exceeded ${timeoutMs}ms.`,
          recovery: [
            suggestedNextAction(commandKind),
            'Use a smaller validation command.',
            'Inspect partial stdout/stderr before retrying.'
          ]
        },
        sourceId: typeof body.sourceId === 'string' ? body.sourceId : undefined,
        commandKind,
        executable: clean.executable,
        args: clean.args,
        shell: clean.shell,
        matchStatus: clean.matchStatus,
        resolvedRepositoryRoot: clean.resolvedRepositoryRoot,
        filesChanged: clean.filesChanged,
        artifactPath: clean.artifactPath,
        artifactSha256: clean.artifactSha256,
        workflowId: clean.workflowId,
        workflowVersion: clean.workflowVersion,
        workflowUpdatedAt: clean.workflowUpdatedAt,
        networkWriteRequested: clean.networkWriteRequested,
        packageDir: clean.packageDir,
        requiredBranch: clean.requiredBranch,
        actualBranch: clean.actualBranch,
        runtime: clean.runtime,
        changedPaths: clean.changedPaths,
        protectedPathsChanged: clean.protectedPathsChanged,
        riskLevel: clean.riskLevel,
        requiresConfirmation: clean.requiresConfirmation,
        signal: clean.signal,
        durationMs: clean.durationMs,
        elapsedMs: clean.durationMs,
        timeoutMs,
        outputTruncated: clean.outputTruncated,
        stdout: clean.stdout,
        stderr: clean.stderr,
        exitCode: clean.exitCode,
        diagnostics: deadline.diagnostics({
          phase: 'command_timed_out',
          commandKind,
          deadlineMs: timeoutMs,
          elapsedMs: typeof clean.durationMs === 'number' ? clean.durationMs : deadline.elapsedMs(),
          suggestedNextAction: suggestedNextAction(commandKind)
        }),
        activity: clean.activity
      }
      return jsonWithRunCommandTelemetry(payload, { headers: { 'Cache-Control': 'no-store' } }, {
        requestId: deadline.requestId,
        disposition: 'timed_out',
        reasonCode: 'command_timed_out',
        requestDurationMs: Date.now() - requestStartedAt,
        sourceId: telemetrySourceId,
        commandKind: telemetryCommandKind,
        commandDurationMs: typeof clean.durationMs === 'number' ? clean.durationMs : undefined
      })
    }

    const job = clean.job && typeof clean.job === 'object' ? clean.job as Record<string, unknown> : undefined
    const resolvedExitCode = typeof clean.exitCode === 'number'
      ? clean.exitCode
      : typeof job?.exitCode === 'number' ? job.exitCode : null
    const resolvedStdout = typeof clean.stdout === 'string'
      ? clean.stdout
      : typeof job?.stdout === 'string'
        ? job.stdout
        : typeof job?.stdoutTail === 'string' ? job.stdoutTail : undefined
    const resolvedStderr = typeof clean.stderr === 'string'
      ? clean.stderr
      : typeof job?.stderr === 'string'
        ? job.stderr
        : typeof job?.stderrTail === 'string' ? job.stderrTail : ''
    const resolvedOutputTruncated = typeof clean.outputTruncated === 'boolean'
      ? clean.outputTruncated
      : typeof job?.outputTruncated === 'boolean' ? job.outputTruncated : undefined

    const terminalSucceeded = clean.status === 'completed' && resolvedExitCode === 0
    const terminalRejected = clean.requiresConfirmation === true || clean.status === 'blocked'
    const terminalDisposition = terminalRejected ? 'rejected' as const : terminalSucceeded ? 'success' as const : 'failure' as const
    const terminalReason = terminalRejected ? 'command_rejected' as const : terminalSucceeded ? 'command_completed' as const : 'command_failed' as const
    const payload = {
      ok: terminalSucceeded,
      status: clean.status,
      requestId: deadline.requestId,
      sourceId: typeof body.sourceId === 'string' ? body.sourceId : undefined,
      commandKind,
      validationJobOperation,
      validationJobId: typeof job?.jobId === 'string' ? job.jobId : undefined,
      createdAt: job?.createdAt,
      updatedAt: job?.updatedAt,
      startedAt: job?.startedAt,
      completedAt: job?.completedAt,
      executable: clean.executable ?? job?.executable,
      args: clean.args ?? job?.args,
      shell: clean.shell ?? job?.shell,
      matchStatus: clean.matchStatus ?? job?.matchStatus,
      resolvedRepositoryRoot: clean.resolvedRepositoryRoot ?? job?.resolvedRepositoryRoot,
      filesChanged: clean.filesChanged ?? job?.filesChanged,
      artifactPath: clean.artifactPath ?? job?.artifactPath,
      artifactSha256: clean.artifactSha256 ?? job?.artifactSha256,
      workflowId: clean.workflowId ?? job?.workflowId,
      workflowVersion: clean.workflowVersion ?? job?.workflowVersion,
      workflowUpdatedAt: clean.workflowUpdatedAt ?? job?.workflowUpdatedAt,
      networkWriteRequested: clean.networkWriteRequested ?? job?.networkWriteRequested,
      stdout: resolvedStdout,
      stderr: resolvedStderr,
      exitCode: resolvedExitCode,
      signal: clean.signal ?? job?.signal ?? null,
      durationMs: clean.durationMs ?? job?.durationMs,
      outputTruncated: resolvedOutputTruncated,
      changedPaths: clean.changedPaths ?? job?.changedPaths,
      runtime: clean.runtime ?? job?.runtime,
      requiredBranch: clean.requiredBranch ?? job?.requiredBranch,
      actualBranch: clean.actualBranch ?? job?.actualBranch,
      protectedPathsChanged: clean.protectedPathsChanged ?? job?.protectedPathsChanged,
      requiresConfirmation: clean.requiresConfirmation,
      confirmationToken: clean.confirmationToken,
      migrationMode: clean.migrationMode,
      migrationPhase: clean.migrationPhase,
      operation: clean.operation,
      reason: clean.reason,
      terminatedByInfrastructure: clean.terminatedByInfrastructure ?? job?.terminatedByInfrastructure,
      terminationReason: clean.terminationReason ?? job?.terminationReason ?? null,
      activity: clean.activity
    }
    const commandDurationMs = typeof clean.durationMs === 'number'
      ? clean.durationMs
      : typeof job?.durationMs === 'number' ? job.durationMs : undefined
    return jsonWithRunCommandTelemetry(payload, { headers: { 'Cache-Control': 'no-store' } }, {
      requestId: deadline.requestId,
      disposition: terminalDisposition,
      reasonCode: terminalReason,
      requestDurationMs: Date.now() - requestStartedAt,
      sourceId: telemetrySourceId,
      commandKind: telemetryCommandKind,
      commandDurationMs
    })
  }).catch((err) => {
    const { error, status } = unwrapActionError(err, 'run-command error')
    const payload = error && typeof error === 'object' ? error : buildActionErrorEnvelope({
      code: 'BUILDFLOW_COMMAND_ERROR',
      message: String(error),
      status: 'error'
    })
    if (!telemetryRequestId) return NextResponse.json(payload, { status, headers: { 'Cache-Control': 'no-store' } })
    return jsonWithRunCommandTelemetry(payload, { status, headers: { 'Cache-Control': 'no-store' } }, {
      requestId: telemetryRequestId,
      disposition: 'failure',
      reasonCode: 'transport_error',
      requestDurationMs: Date.now() - requestStartedAt,
      sourceId: telemetrySourceId,
      commandKind: telemetryCommandKind
    })
  })
}
