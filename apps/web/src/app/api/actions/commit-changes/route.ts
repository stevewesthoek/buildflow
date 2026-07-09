import { NextRequest, NextResponse } from 'next/server'
import { checkActionAuth } from '@/lib/actionAuth'
import { dispatchWorkbenchCommand, unwrapActionError } from '@/lib/actions/gpt'
import { buildActionErrorEnvelope } from '@/lib/actions/action-response'
import { GPT_ACTION_DEADLINES_MS, withGptActionDeadline } from '@/lib/actions/deadline'
import { dispatchAfterExactStaging, type StagedSetGuardInput } from '@/lib/actions/staged-set-guard'

export const dynamic = 'force-dynamic'
export const revalidate = 0

// Compound action: git_diff_stat → git_add_paths → git_commit in one call.
// Cuts 3 Custom GPT round-trips to 1 per task, reducing ChatGPT reasoning overhead.
export async function POST(request: NextRequest) {
  return withGptActionDeadline({
    operationId: 'commitBuildFlowChanges',
    route: '/api/actions/commit-changes',
    deadlineMs: GPT_ACTION_DEADLINES_MS.commitChanges,
    suggestedNextAction: 'Commit fewer explicit paths or retry after checking git status.'
  }, async (deadline) => {
    deadline.setPhase('authenticate')
    const auth = checkActionAuth(request)
    deadline.markStage('authentication_complete', { authValid: auth.valid })
    if (!auth.valid) return auth.error!

    deadline.setPhase('parse_body')
    const body = await request.json()
    const sourceId = typeof body.sourceId === 'string' ? body.sourceId : ''
    const paths = Array.isArray(body.paths) ? body.paths as string[] : []
    const message = typeof body.message === 'string' ? body.message : ''
    const confirmedByUser = body.confirmedByUser === true
    const confirmationToken = typeof body.confirmationToken === 'string' ? body.confirmationToken : undefined
    deadline.addDiagnostics({ sourceId, paths: paths.slice(0, 10), phase: 'validate_input' })

    if (!sourceId) {
      return NextResponse.json(buildActionErrorEnvelope({ code: 'MISSING_PARAM', message: 'sourceId is required' }), { status: 400 })
    }
    if (paths.length === 0) {
      return NextResponse.json(buildActionErrorEnvelope({ code: 'MISSING_PARAM', message: 'paths is required and must not be empty' }), { status: 400 })
    }
    if (!message.trim()) {
      return NextResponse.json(buildActionErrorEnvelope({ code: 'MISSING_PARAM', message: 'message is required' }), { status: 400 })
    }

    // Step 1: diff to get proof of what changed
    deadline.setPhase('git_diff_stat')
    const diff = await dispatchWorkbenchCommand({ sourceId, commandKind: 'git_diff_stat', timeoutMs: 2000 }, auth.bearerToken, {
      signal: deadline.signal,
      timeoutMs: deadline.transportTimeoutMs(2500),
      diagnostics: deadline.diagnostics({ phase: 'git_diff_stat', sourceId, paths })
    }) as Record<string, unknown>
    if ((diff as { exitCode?: number }).exitCode !== 0) {
      return NextResponse.json({ ok: false, step: 'diff', diff, diagnostics: deadline.diagnostics({ phase: 'git_diff_stat_failed', sourceId, paths }) })
    }

    // Step 2: stage specific paths
    deadline.setPhase('git_add_paths')
    const add = await dispatchWorkbenchCommand({ sourceId, commandKind: 'git_add_paths', paths, confirmedByUser, confirmationToken, timeoutMs: 2500 }, auth.bearerToken, {
      signal: deadline.signal,
      timeoutMs: deadline.transportTimeoutMs(3000),
      diagnostics: deadline.diagnostics({ phase: 'git_add_paths', sourceId, paths })
    }) as Record<string, unknown>
    if ((add as { exitCode?: number }).exitCode !== 0) {
      return NextResponse.json({ ok: false, step: 'add', add, diagnostics: deadline.diagnostics({ phase: 'git_add_paths_failed', sourceId, paths }) })
    }
    const guardedCommit = await dispatchAfterExactStaging(add as StagedSetGuardInput, async () => {
      // Step 3: commit with provided message
      deadline.setPhase('git_commit')
      return await dispatchWorkbenchCommand({ sourceId, commandKind: 'git_commit', paths, message, confirmedByUser, confirmationToken, timeoutMs: 4500 }, auth.bearerToken, {
        signal: deadline.signal,
        timeoutMs: deadline.transportTimeoutMs(5000),
        diagnostics: deadline.diagnostics({ phase: 'git_commit', sourceId, paths })
      }) as Record<string, unknown>
    })
    if (!guardedCommit.pass) {
      return NextResponse.json({
        ok: false,
        step: 'add',
        reason: guardedCommit.reason,
        add,
        diagnostics: deadline.diagnostics({ phase: 'staged_path_set_mismatch', sourceId, paths })
      })
    }
    const commit = guardedCommit.result
    const committed = (commit as { exitCode?: number }).exitCode === 0

    return NextResponse.json({
      ok: committed,
      diffStat: (diff as { stdout?: string }).stdout,
      commitMessage: message,
      committed,
      staging: (add as { details?: unknown }).details,
      stdout: (commit as { stdout?: string }).stdout,
      stderr: committed ? undefined : (commit as { stderr?: string }).stderr,
      activity: {
        version: '1.2.13-beta',
        operationId: 'commitBuildFlowChanges',
        phase: committed ? 'completed' : 'failed',
        actionLabel: 'Committed explicit repo paths',
        userMessage: committed ? `BuildFlow committed ${paths.length} explicit path(s).` : 'BuildFlow could not commit the staged paths.',
        sourceId,
        changedPaths: paths.slice(0, 5),
        riskLevel: 'medium',
        requiresConfirmation: false,
        verified: committed,
        nextStep: committed ? 'Report the commit hash from stdout.' : 'Inspect stdout/stderr and retry a smaller commit.'
      },
      diagnostics: deadline.diagnostics({ phase: committed ? 'completed' : 'git_commit_failed', sourceId, paths })
    })
  }).catch((err) => {
    const { error, status } = unwrapActionError(err, 'commit-changes error')
    return NextResponse.json(
      error && typeof error === 'object' ? error : buildActionErrorEnvelope({ code: 'COMMIT_CHANGES_ERROR', message: String(error), status: 'error' }),
      { status, headers: { 'Cache-Control': 'no-store' } }
    )
  })
}
