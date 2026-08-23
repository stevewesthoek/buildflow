import {
  getAgentJob,
  updateAgentJob,
  type AgentJob,
} from './agent-jobs'
import { controlWorkbenchPacketsForRun } from './workbench-packet-store'
import { appendAgentEvent } from './agent-events'

export function closeWorkbenchRun(params: {
  sourceId: string
  runId: string
  summary: string
}): AgentJob {
  const sourceId = String(params.sourceId || '').trim()
  const runId = String(params.runId || '').trim()
  const summary = String(params.summary || '').trim()

  if (!sourceId) throw new Error('sourceId is required')
  if (!runId) throw new Error('runId is required')
  if (!summary) throw new Error('summary is required')

  const run = getAgentJob(runId)
  if (!run || run.sourceId !== sourceId) {
    throw new Error('Workbench run not found for source')
  }
  if (['completed', 'failed', 'cancelled'].includes(run.status)) {
    throw new Error(`Workbench run is already terminal: ${run.status}`)
  }

  controlWorkbenchPacketsForRun({
    runId: run.id,
    action: 'cancel',
    reason: `Run closed: ${summary}`
  })

  const closed = updateAgentJob(run.id, {
    status: 'completed',
    summary,
    nextActions: [],
  })
  appendAgentEvent({
    jobId: closed.id,
    sourceId: closed.sourceId,
    type: 'job_completed',
    activityKind: 'run_completed',
    message: summary,
    status: closed.status
  })
  return closed
}
