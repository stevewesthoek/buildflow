import fs from 'fs'
import path from 'path'
import { runSafeCommand, type SafeCommandKind } from './command-runner'
import { updateAgentJob } from './agent-jobs'

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

export function startLocalAgentPreflight(options: LocalAgentRuntimeOptions): void {
  const { jobId, sourceId, sourceRoot } = options
  if (runningJobs.has(jobId)) return
  runningJobs.add(jobId)

  void (async () => {
    const evidence: string[] = []
    try {
      updateAgentJob(jobId, {
        status: 'running',
        summary: 'Local Agent Mode preflight is running server-side. Custom GPT stays the reasoning/coding engine and can poll compact job status instead of orchestrating deterministic checks.',
        nextActions: ['Poll getBuildFlowAgentJob for compact progress.', 'Wait for local deterministic preflight before targeted reasoning or edits.']
      })

      const commands = buildPreflightCommands(sourceRoot)
      for (let index = 0; index < commands.length; index += 1) {
        const command = commands[index]
        updateAgentJob(jobId, {
          currentIteration: index + 1,
          summary: `Local Agent Mode preflight running ${command.kind}.`,
          nextActions: ['Poll compact job status.', 'Local BuildFlow is handling deterministic validation server-side.']
        })
        const result = await runSafeCommand({
          sourceId,
          sourceRoot,
          commandKind: command.kind,
          timeoutMs: command.timeoutMs,
          paths: command.paths
        })
        evidence.push(summarizeEvidence(command, result.status, result.exitCode))
        if (result.status !== 'completed') {
          updateAgentJob(jobId, {
            status: 'blocked',
            blockedReason: `Local preflight stopped at ${command.kind}: ${result.status}`,
            summary: evidence.join('; '),
            lastKnownGitStatus: result.stdout || result.stderr || result.reason || 'No command output.',
            nextActions: ['Review the compact failed local preflight result.', 'Ask Custom GPT for targeted reasoning/coding with the failure summary.']
          })
          return
        }
      }

      updateAgentJob(jobId, {
        status: 'completed',
        summary: `Local Agent Mode preflight completed server-side: ${evidence.join('; ')}.`,
        nextActions: ['Use compact job status as validation evidence.', 'Ask Custom GPT for targeted implementation only if additional requirements remain.'],
        lastKnownGitStatus: evidence.join('\n')
      })
    } catch (err) {
      updateAgentJob(jobId, {
        status: 'failed',
        blockedReason: err instanceof Error ? err.message : String(err),
        summary: evidence.length > 0 ? evidence.join('; ') : 'Local Agent Mode preflight failed before producing validation evidence.',
        nextActions: ['Inspect the local runtime error and retry after repair.']
      })
    } finally {
      runningJobs.delete(jobId)
    }
  })()
}
