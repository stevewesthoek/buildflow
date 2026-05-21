import { NextRequest, NextResponse } from 'next/server'
import { checkActionAuth } from '@/lib/actionAuth'
import { dispatchBuildFlowCommand, unwrapActionError } from '@/lib/actions/gpt'
import { buildActionErrorEnvelope } from '@/lib/actions/action-response'

export const dynamic = 'force-dynamic'
export const revalidate = 0

// Compound action: git_diff_stat → git_add_paths → git_commit in one call.
// Cuts 3 Custom GPT round-trips to 1 per task, reducing ChatGPT reasoning overhead.
export async function POST(request: NextRequest) {
  const auth = checkActionAuth(request)
  if (!auth.valid) return auth.error

  try {
    const body = await request.json()
    const sourceId = typeof body.sourceId === 'string' ? body.sourceId : ''
    const paths = Array.isArray(body.paths) ? body.paths as string[] : []
    const message = typeof body.message === 'string' ? body.message : ''

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
    const diff = await dispatchBuildFlowCommand({ sourceId, commandKind: 'git_diff_stat', timeoutMs: 8000 }, auth.bearerToken) as Record<string, unknown>
    if ((diff as { exitCode?: number }).exitCode !== 0) {
      return NextResponse.json({ ok: false, step: 'diff', diff })
    }

    // Step 2: stage specific paths
    const add = await dispatchBuildFlowCommand({ sourceId, commandKind: 'git_add_paths', paths, timeoutMs: 8000 }, auth.bearerToken) as Record<string, unknown>
    if ((add as { exitCode?: number }).exitCode !== 0) {
      return NextResponse.json({ ok: false, step: 'add', add })
    }

    // Step 3: commit with provided message
    const commit = await dispatchBuildFlowCommand({ sourceId, commandKind: 'git_commit', message, timeoutMs: 12000 }, auth.bearerToken) as Record<string, unknown>
    const committed = (commit as { exitCode?: number }).exitCode === 0

    return NextResponse.json({
      ok: committed,
      diffStat: (diff as { stdout?: string }).stdout,
      commitMessage: message,
      committed,
      stdout: (commit as { stdout?: string }).stdout,
      stderr: committed ? undefined : (commit as { stderr?: string }).stderr
    })
  } catch (err) {
    const { error, status } = unwrapActionError(err, 'commit-changes error')
    return NextResponse.json(
      error && typeof error === 'object' ? error : buildActionErrorEnvelope({ code: 'COMMIT_CHANGES_ERROR', message: String(error) }),
      { status }
    )
  }
}
