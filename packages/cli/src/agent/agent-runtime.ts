import fs from 'fs'
import path from 'path'
import { runSafeCommand, type SafeCommandKind } from './command-runner'
import { getAgentJob, updateAgentJob } from './agent-jobs'
import { appendAgentEvent } from './agent-events'

export type LocalAgentRuntimeOptions = {
  jobId: string
  sourceId: string
  sourceRoot: string
}

type RuntimeCommand = {
  kind: SafeCommandKind
  paths?: string[]
  timeoutMs?: number
}

const runningJobs = new Set<string>()

function buildPreflightCommands(sourceRoot: string): RuntimeCommand[] {
  const commands: RuntimeCommand[] = [{ kind: 'git_status_short', timeoutMs: 30_000 }]
  if (fs.existsSync(path.join(sourceRoot, 'packages/cli/package.json'))) commands.push({ kind: 'type_check_cli', timeoutMs: 120_000 })
  if (fs.existsSync(path.join(sourceRoot, 'apps/web/package.json'))) commands.push({ kind: 'type_check_web', timeoutMs: 120_000 })
  if (fs.existsSync(path.join(sourceRoot, 'docs/openapi.chatgpt.json'))) commands.push({ kind: 'validate_json_files', paths: ['docs/openapi.chatgpt.json'], timeoutMs: 30_000 })
  return commands
}

function summarizeEvidence(command: RuntimeCommand, status: string, exitCode: number | null): string {
  return `${command.kind}: ${status}${exitCode !== null ? ` (${exitCode})` : ''}`
}

function emit(jobId: string, sourceId: string, type: Parameters<typeof appendAgentEvent>[0]['type'], message: string, extra: { commandKind?: string; status?: string } = {}) {
  appendAgentEvent({ jobId, sourceId, type, message, ...extra })
}

function shouldStopForControl(jobId: string, sourceId: string): boolean {
  const job = getAgentJob(jobId)
  if (!job) return true
  if (job.status === 'cancelled') {
    emit(jobId, sourceId, 'job_cancelled', 'Local Agent Runtime stopped because the run was cancelled.', { status: 'cancelled' })
    return true
  }
  if (job.status === 'paused') {
    emit(jobId, sourceId, 'job_paused', 'Local Agent Runtime paused. Resume the run to restart deterministic preflight.', { status: 'paused' })
    return true
  }
  return false
}

export function startLocalAgentPreflight(options: LocalAgentRuntimeOptions): void {
  const { jobId, sourceId, sourceRoot } = options
  if (runningJobs.has(jobId)) return
  runningJobs.add(jobId)

  void (async () => {
    const evidence: string[] = []
    try {
      emit(jobId, sourceId, 'preflight_started', 'Local deterministic preflight started. Custom GPT remains the reasoning and coding engine.', { status: 'running' })
      updateAgentJob(jobId, {
        status: 'running',
        summary: 'Local Agent Mode preflight is running server-side. Custom GPT stays the reasoning/coding engine and can poll compact job status instead of orchestrating deterministic checks.',
        nextActions: ['Poll getBuildFlowAgentJob or controlBuildFlowAgentRun for compact progress.', 'Wait for local deterministic preflight before targeted reasoning or edits.']
      })

      const commands = buildPreflightCommands(sourceRoot)
      for (let index = 0; index < commands.length; index += 1) {
        if (shouldStopForControl(jobId, sourceId)) return
        const command = commands[index]
        emit(jobId, sourceId, 'command_started', `Running ${command.kind}.`, { commandKind: command.kind, status: 'running' })
        updateAgentJob(jobId, {
          currentIteration: index + 1,
          summary: `Local Agent Mode preflight running ${command.kind}.`,
          nextActions: ['Poll compact job status/events.', 'Local BuildFlow is handling deterministic validation server-side.']
        })
        const result = await runSafeCommand({
          sourceId,
          sourceRoot,
          commandKind: command.kind,
          timeoutMs: command.timeoutMs,
          paths: command.paths
        })
        const summary = summarizeEvidence(command, result.status, result.exitCode)
        evidence.push(summary)
        emit(jobId, sourceId, result.status === 'completed' ? 'command_completed' : 'command_failed', summary, { commandKind: command.kind, status: result.status })
        if (result.status !== 'completed') {
          updateAgentJob(jobId, {
            status: 'blocked',
            blockedReason: `Local preflight stopped at ${command.kind}: ${result.status}`,
            summary: evidence.join('; '),
            lastKnownGitStatus: result.stdout || result.stderr || result.reason || 'No command output.',
            nextActions: ['Review the compact failed local preflight result.', 'Ask Custom GPT for targeted reasoning/coding with the failure summary.']
          })
          emit(jobId, sourceId, 'job_blocked', `Local preflight blocked at ${command.kind}: ${result.status}.`, { commandKind: command.kind, status: result.status })
          return
        }
      }

      updateAgentJob(jobId, {
        status: 'completed',
        summary: `Local Agent Mode preflight completed server-side: ${evidence.join('; ')}.`,
        nextActions: ['Use compact job status/events as validation evidence.', 'Ask Custom GPT for targeted implementation only if additional requirements remain.'],
        lastKnownGitStatus: evidence.join('\n')
      })
      emit(jobId, sourceId, 'job_completed', `Local preflight completed: ${evidence.join('; ')}.`, { status: 'completed' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      updateAgentJob(jobId, {
        status: 'failed',
        blockedReason: message,
        summary: evidence.length > 0 ? evidence.join('; ') : 'Local Agent Mode preflight failed before producing validation evidence.',
        nextActions: ['Inspect the local runtime error and retry after repair.']
      })
      emit(jobId, sourceId, 'job_failed', message, { status: 'failed' })
    } finally {
      runningJobs.delete(jobId)
    }
  })()
}
