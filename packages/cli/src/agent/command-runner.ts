import { execFileSync, spawn } from 'child_process'
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
  | 'vo_json_tool'
  | 'probot_typecheck'
  | 'probot_test'
  | 'probot_test_grep_marker'
  | 'vo_security_scan_changed'
  | 'git_add_files'
  | 'git_commit'
  | 'git_push_origin_main'
  | 'git_diff_cached_name_only'
  | 'git_diff_cached_stat'

export type SafeCommandRequest = {
  commandKind: SafeCommandKind
  sourceId: string
  sourceRoot: string
  timeoutMs?: number
  targetPath?: string
  marker?: string
  paths?: string[]
  message?: string
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

const STATIC_COMMANDS: Partial<Record<SafeCommandKind, string[]>> = {
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
  verify_source_reindex_resilience: ['./packages/cli/node_modules/.bin/tsx', 'scripts/verify-source-reindex-resilience.ts'],
  probot_typecheck: ['npm', 'run', 'typecheck'],
  probot_test: ['npm', 'test'],
  git_push_origin_main: ['git', 'push', 'origin', 'main'],
  git_diff_cached_name_only: ['git', 'diff', '--cached', '--name-only'],
  git_diff_cached_stat: ['git', 'diff', '--cached', '--stat']
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
const VO_JSON_PREFIX = 'operations/specs/video-orchestrator/'
const PROBOT_SRC_PREFIX = 'projects/probot/src/'

function redactOutput(value: string): string {
  return SECRET_PATTERNS.reduce((current, pattern) => current.replace(pattern, '[REDACTED]'), value)
}

function normalizeRepoPath(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/').trim()
}

function assertSafeRepoPath(input: string, label: string): string {
  const normalized = normalizeRepoPath(input)
  if (!normalized || normalized.startsWith('..') || normalized.includes('/../')) throw new Error(`${label} must be a safe repo-relative path`)
  return normalized
}

function assertVoJsonPath(input?: string): string {
  if (!input) throw new Error('targetPath is required')
  const normalized = assertSafeRepoPath(input, 'targetPath')
  if (!normalized.startsWith(VO_JSON_PREFIX) || !normalized.endsWith('.json')) {
    throw new Error('targetPath must be operations/specs/video-orchestrator/**/*.json')
  }
  return normalized
}

function assertExplicitGitPaths(paths?: string[]): string[] {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('paths must be a non-empty explicit file list')
  return paths.map(item => assertSafeRepoPath(item, 'git add path'))
}

function isVoOrProbotPath(pathName: string): boolean {
  return pathName.startsWith(VO_JSON_PREFIX) || pathName.startsWith('operations/runbooks/') || pathName.startsWith(PROBOT_SRC_PREFIX)
}

function getStagedPaths(sourceRoot: string): string[] {
  const output = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: sourceRoot, encoding: 'utf8' })
  return output.split('\n').map(item => item.trim()).filter(Boolean)
}

function assertSafeStagedPathsForCommit(sourceRoot: string): void {
  const staged = getStagedPaths(sourceRoot)
  if (staged.length === 0) throw new Error('git_commit requires staged files')
  const blocked = staged.filter(item => !isVoOrProbotPath(normalizeRepoPath(item)))
  if (blocked.length > 0) throw new Error(`git_commit is limited to VO/probot staged files; blocked: ${blocked.slice(0, 5).join(', ')}`)
}

function buildCommand(request: SafeCommandRequest): { command: string[]; cwd: string } {
  const sourceRoot = path.resolve(request.sourceRoot)
  if (request.commandKind === 'vo_json_tool') {
    return { command: ['python3', '-m', 'json.tool', assertVoJsonPath(request.targetPath)], cwd: sourceRoot }
  }
  if (request.commandKind === 'probot_typecheck' || request.commandKind === 'probot_test') {
    const command = STATIC_COMMANDS[request.commandKind]
    if (!command) throw new Error(`Command kind is not allowlisted: ${request.commandKind}`)
    return { command, cwd: path.join(sourceRoot, 'projects/probot') }
  }
  if (request.commandKind === 'probot_test_grep_marker') {
    const marker = typeof request.marker === 'string' ? request.marker : ''
    if (!marker || marker.length > 120 || /[\r\n]/.test(marker)) throw new Error('marker must be a short single-line string')
    return { command: ['sh', '-c', 'npm test 2>&1 | grep -- "$1" | cat', 'probot-test-grep-marker', marker], cwd: path.join(sourceRoot, 'projects/probot') }
  }
  if (request.commandKind === 'vo_security_scan_changed') {
    return { command: ['sh', '-c', 'files=$(git diff --name-only -- operations/specs/video-orchestrator operations/runbooks | tr "\\n" " "); [ -z "$files" ] && exit 0; grep -RInE "secret|token|password|credential|private key|api[_-]?key" $files || true'], cwd: sourceRoot }
  }
  if (request.commandKind === 'git_add_files') {
    const paths = assertExplicitGitPaths(request.paths)
    if (!paths.every(isVoOrProbotPath)) throw new Error('git_add_files is limited to operations/runbooks/**, operations/specs/video-orchestrator/**, and projects/probot/src/**')
    return { command: ['git', 'add', '--', ...paths], cwd: sourceRoot }
  }
  if (request.commandKind === 'git_commit') {
    const message = typeof request.message === 'string' ? request.message.trim() : ''
    if (!message || message.length > 200 || /[\r\n]/.test(message)) throw new Error('message must be a short single-line commit message')
    assertSafeStagedPathsForCommit(sourceRoot)
    return { command: ['git', 'commit', '-m', message], cwd: sourceRoot }
  }
  const command = STATIC_COMMANDS[request.commandKind]
  if (!command) throw new Error(`Command kind is not allowlisted: ${request.commandKind}`)
  return { command, cwd: sourceRoot }
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
  return [
    'git_status_short',
    'git_diff_stat',
    'git_diff_name_only',
    'git_diff',
    'git_log_latest',
    'git_branch_current',
    'verify_public_scope',
    'type_check_web',
    'type_check_cli',
    'verify_write_policy',
    'verify_source_reindex_resilience',
    'vo_json_tool',
    'probot_typecheck',
    'probot_test',
    'probot_test_grep_marker',
    'vo_security_scan_changed',
    'git_add_files',
    'git_commit',
    'git_push_origin_main',
    'git_diff_cached_name_only',
    'git_diff_cached_stat'
  ]
}

export async function runSafeCommand(request: SafeCommandRequest): Promise<SafeCommandResult> {
  const { command, cwd } = buildCommand(request)
  const sourceRoot = path.resolve(request.sourceRoot)
  if (!cwd.startsWith(sourceRoot)) throw new Error('Command cwd escaped the source root')
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
