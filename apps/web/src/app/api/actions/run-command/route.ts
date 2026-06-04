import { NextRequest, NextResponse } from 'next/server'
import { checkActionAuth } from '@/lib/actionAuth'
import { dispatchBuildFlowCommand, unwrapActionError } from '@/lib/actions/gpt'
import { buildActionErrorEnvelope, stripBloat } from '@/lib/actions/action-response'
import { GPT_ACTION_DEADLINES_MS, withGptActionDeadline } from '@/lib/actions/deadline'

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

export async function POST(request: NextRequest) {
  const auth = checkActionAuth(request)
  if (!auth.valid) return auth.error

  return withGptActionDeadline({
    operationId: 'runBuildFlowCommand',
    route: '/api/actions/run-command',
    deadlineMs: GPT_ACTION_DEADLINES_MS.runCommand,
    suggestedNextAction: 'Run slow validation in a separate prompt.'
  }, async (deadline) => {
    deadline.setPhase('parse_body')
    const body = await request.json()
    const commandKind = typeof body.commandKind === 'string' ? body.commandKind : ''
    const timeoutMs = Math.min(commandTimeoutMs(commandKind, body.timeoutMs), deadline.transportTimeoutMs(11_500))
    deadline.addDiagnostics({
      sourceId: typeof body.sourceId === 'string' ? body.sourceId : undefined,
      commandKind,
      paths: Array.isArray(body.paths) ? body.paths.filter((item: unknown): item is string => typeof item === 'string').slice(0, 10) : undefined
    })
    deadline.setPhase('run_command')
    const data = await dispatchBuildFlowCommand({ ...body, timeoutMs }, auth.bearerToken, {
      signal: deadline.signal,
      timeoutMs: deadline.transportTimeoutMs(11_750),
      diagnostics: deadline.diagnostics({
        phase: 'run_command',
        commandKind,
        sourceId: typeof body.sourceId === 'string' ? body.sourceId : undefined
      })
    })
    const clean = stripBloat(data) as Record<string, unknown>

    if (clean.status === 'timed_out') {
      return NextResponse.json({
        ok: false,
        connected: true,
        status: 'timeout',
        error: {
          code: 'BUILDFLOW_COMMAND_TIMEOUT',
          message: 'BuildFlow stopped this command before the GPT action deadline.',
          details: `${commandKind} exceeded ${timeoutMs}ms.`,
          recovery: [
            suggestedNextAction(commandKind),
            'Use a smaller validation command.',
            'Inspect partial stdout/stderr before retrying.'
          ]
        },
        commandKind,
        elapsedMs: clean.durationMs,
        timeoutMs,
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
      }, { headers: { 'Cache-Control': 'no-store' } })
    }

    return NextResponse.json({
      ok: clean.exitCode === 0 && clean.status !== 'failed',
      status: clean.status,
      commandKind,
      stdout: clean.stdout,
      stderr: clean.stderr,
      exitCode: clean.exitCode,
      durationMs: clean.durationMs,
      outputTruncated: clean.outputTruncated,
      activity: clean.activity
    })
  }).catch((err) => {
    const { error, status } = unwrapActionError(err, 'run-command error')
    return NextResponse.json(error && typeof error === 'object' ? error : buildActionErrorEnvelope({
      code: 'BUILDFLOW_COMMAND_ERROR',
      message: String(error)
    }), { status })
  })
}
