import { NextRequest, NextResponse } from 'next/server'
import { checkActionAuth } from '@/lib/actionAuth'
import { startWorkbenchAgentJob, getWorkbenchAgentJob, controlWorkbenchAgentRun, unwrapActionError } from '@/lib/actions/gpt'
import { buildActionErrorEnvelope } from '@/lib/actions/action-response'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const activeStatuses = new Set(['queued', 'running', 'paused', 'needs_confirmation', 'blocked'])

function compactJob(job: Record<string, unknown>) {
  return {
    id: job.id,
    sourceId: job.sourceId,
    status: job.status,
    completedTaskCount: job.completedTaskCount,
    totalTaskCount: job.totalTaskCount,
    summary: job.summary,
    activeTask: job.activeTask ? { title: (job.activeTask as Record<string, unknown>).title, status: (job.activeTask as Record<string, unknown>).status } : undefined,
    nextActions: Array.isArray(job.nextActions) ? (job.nextActions as string[]).slice(0, 2) : undefined
  }
}

export async function POST(request: NextRequest) {
  const auth = checkActionAuth(request)
  if (!auth.valid) return auth.error

  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>
    const action = typeof body.action === 'string' ? body.action : ''

    if (action === 'start') {
      const data = await startWorkbenchAgentJob(body, auth.bearerToken)
      return NextResponse.json(data)
    }

    if (action === 'update') {
      if (body.jobId) {
        const data = await getWorkbenchAgentJob(body, auth.bearerToken)
        return NextResponse.json(data)
      }
      const data = await getWorkbenchAgentJob(body, auth.bearerToken) as Record<string, unknown>
      const jobs = Array.isArray(data.jobs) ? data.jobs as Record<string, unknown>[] : []
      const activeJobs = jobs.filter(j => activeStatuses.has(j.status as string))
      return NextResponse.json({
        status: 'ok',
        jobs: activeJobs.length > 0 ? activeJobs.map(compactJob) : jobs.slice(0, 3).map(compactJob)
      })
    }

    if (action === 'pause' || action === 'resume' || action === 'cancel' || action === 'events') {
      const controlBody = { ...body, action }
      const data = await controlWorkbenchAgentRun(controlBody, auth.bearerToken)
      return NextResponse.json(data)
    }

    return NextResponse.json(
      buildActionErrorEnvelope({ code: 'INVALID_ACTION', message: `Unknown action: ${action}. Use start, update, pause, resume, cancel, or events.` }),
      { status: 400 }
    )
  } catch (err) {
    const { error, status } = unwrapActionError(err, 'agent-manage error')
    return NextResponse.json(
      error && typeof error === 'object' ? error : buildActionErrorEnvelope({ code: 'BUILDFLOW_AGENT_ERROR', message: String(error) }),
      { status }
    )
  }
}
