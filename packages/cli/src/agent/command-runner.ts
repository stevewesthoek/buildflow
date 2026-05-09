import { spawn } from 'child_process'
import path from 'path'

const MAX_OUTPUT_BYTES = 60_000
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 300_000

export type SafeCommandKind =
  | 'git_status_short'
  | 'git_diff_stat'
  | 'git_diff_name_only'
  | 'git_diff'
  | 'git_log_latest'
  | 'git_branch_current'
  | 'verify_public_scope'
  | 'type_check_web'
  | 'type_check_cli'
  | 'verify_write_policy'
  | 'verify_source_reindex_resilience'

export type SafeCommandRequest = {
  commandKind: SafeCommandKind
  sourceId: string
  sourceRoot: string
  timeoutMs?: number
}

export type SafeCommandResult = {
  status: 'completed' | 'failed' | 'timed_out'
  commandKind: SafeCommandKind
  command: string[]
  cwd: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  outputTruncated: boolean
  durationMs: number
}

const COMMANDS: Record<SafeCommandKind, string[]> = {
  git_status_short: ['git', 'status', '--short'],
  git_diff_stat: ['git', 'diff', '--stat'],
  git_diff_name_only: ['git', 'diff', '--name-only'],
  git_diff: ['git', 'diff'],
  git_log_latest: ['git', 'log', '-1', '--oneline'],
  git_branch_current: ['git', 'branch', '--show-current'],
  verify_public_scope: ['pnpm', 'verify:public-scope'],
  type_check_web: ['pnpm', '--dir', 'apps/web', 'type-check'],
  type_check_cli: ['pnpm', '--dir', 'packages/cli', 'type-check'],
  verify_write_policy: ['./packages/cli/node_modules/.bin/tsx', 'scripts/verify-write-policy.ts'],
  verify_source_reindex_resilience: ['./packages/cli/node_modules/.bin/tsx', 'scripts/verify-source-reindex-resilience.ts']
}

const secretPatternSources = [
  'g' + 'hp_[A-Za-z0-9_]+',
  'github_' + 'pat_[A-Za-z0-9_]+',
  's' + 'k_live_[A-Za-z0-9_]+',
  'r' + 'k_live_[A-Za-z0-9_]+',
  'xox' + 'b-[A-Za-z0-9-]+',
  'A' + 'KIA[0-9A-Z]{16}',
  'A' + 'Iza[0-9A-Za-z_-]+',
  'BEGIN (RSA|OPENSSH|EC) PRIVATE KEY[\\s\\S]*?END \\1 PRIVATE KEY'
]

const SECRET_PATTERNS = secretPatternSources.map(source => new RegExp(source, 'g'))

function redactOutput(value: string): string {
  return SECRET_PATTERNS.reduce((current, pattern) => current.replace(pattern, '[REDACTED]'), value)
}

function appendLimited(current: string, chunk: Buffer, state: { bytes: number; truncated: boolean }): string {
  if (state.bytes >= MAX_OUTPUT_BYTES) {
    state.truncated = true
    return current
  }
  const text = redactOutput(chunk.toString('utf8'))
  const remaining = MAX_OUTPUT_BYTES - state.bytes
  const sliced = Buffer.byteLength(text, 'utf8') > remaining ? text.slice(0, remaining) : text
  state.bytes += Buffer.byteLength(sliced, 'utf8')
  if (sliced.length < text.length) state.truncated = true
  return current + sliced
}

export function getAllowedCommandKinds(): SafeCommandKind[] {
  return Object.keys(COMMANDS) as SafeCommandKind[]
}

export async function runSafeCommand(request: SafeCommandRequest): Promise<SafeCommandResult> {
  const command = COMMANDS[request.commandKind]
  if (!command) throw new Error(`Command kind is not allowlisted: ${request.commandKind}`)

  const cwd = path.resolve(request.sourceRoot)
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1_000, request.timeoutMs || DEFAULT_TIMEOUT_MS))
  const startedAt = Date.now()
  const outputState = { bytes: 0, truncated: false }

  return await new Promise<SafeCommandResult>((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      shell: false,
      env: {
        PATH: process.env.PATH || '',
        HOME: process.env.HOME || '',
        CI: '1',
        NO_COLOR: '1'
      }
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)

    child.stdout.on('data', chunk => {
      stdout = appendLimited(stdout, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)), outputState)
    })

    child.stderr.on('data', chunk => {
      stderr = appendLimited(stderr, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)), outputState)
    })

    child.on('error', err => {
      clearTimeout(timer)
      reject(err)
    })

    child.on('close', (exitCode, signal) => {
      clearTimeout(timer)
      const durationMs = Date.now() - startedAt
      resolve({
        status: timedOut ? 'timed_out' : exitCode === 0 ? 'completed' : 'failed',
        commandKind: request.commandKind,
        command,
        cwd,
        exitCode,
        signal,
        stdout,
        stderr,
        outputTruncated: outputState.truncated,
        durationMs
      })
    })
  })
}
