import fs from 'fs'
import { execFileSync, spawn } from 'child_process'
import path from 'path'
import { normalizeRepoRelativePath, validateWriteTarget } from './safe-access'

const MAX_OUTPUT_BYTES = 60_000
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 300_000
const TEXT_SCAN_MAX_BYTES = 1_000_000

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
  | 'git_diff_cached_stat'
  | 'git_diff_cached_name_only'
  | 'git_add_paths'
  | 'git_commit'
  | 'git_push'
  | 'validate_json_files'
  | 'run_package_script'
  | 'run_package_test'
  | 'run_package_test_marker'
  | 'security_scan_paths'
  | 'diagnose_performance'
  | 'local_cli_github_auth_status'
  | 'local_cli_github_repo_view'

export type LocalCliCapabilityProfile = {
  name: 'github'
  executable: 'gh'
  allowedCommands: string[][]
  requireConfirmationFor: string[][]
}

export const LOCAL_CLI_CAPABILITY_PROFILES: Record<'github', LocalCliCapabilityProfile> = {
  github: {
    name: 'github',
    executable: 'gh',
    allowedCommands: [
      ['auth', 'status'],
      ['repo', 'view', '--json', 'nameWithOwner,url,defaultBranchRef']
    ],
    requireConfirmationFor: []
  }
}

export type SecurityPatternSet =
  | 'forbidden_runtime_execution'
  | 'forbidden_secret_material'
  | 'forbidden_upload_network'
  | 'forbidden_all_high_risk'

export type SafeCommandRequest = {
  commandKind: SafeCommandKind
  sourceId: string
  sourceRoot: string
  timeoutMs?: number
  paths?: string[]
  packageDir?: string
  scriptName?: string
  marker?: string
  message?: string
  body?: string
  remote?: string
  branch?: string
  patternSet?: SecurityPatternSet
  confirmedByUser?: boolean
  confirmationToken?: string
}

export type SafeCommandResult = {
  status: 'completed' | 'failed' | 'timed_out' | 'needs_confirmation'
  commandKind: SafeCommandKind
  command: string[]
  cwd: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  outputTruncated: boolean
  durationMs: number
  confirmationToken?: string
  requiresConfirmation?: boolean
  reason?: string
  details?: unknown
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
  git_diff_cached_stat: ['git', 'diff', '--cached', '--stat'],
  git_diff_cached_name_only: ['git', 'diff', '--cached', '--name-only']
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
const SAFE_SCRIPT_NAME = /^[A-Za-z0-9:_-]+$/
const SAFE_MARKER = /^[A-Za-z0-9 _:\-()|]+$/
const SAFE_REMOTE = /^[A-Za-z0-9._-]+$/
const SAFE_BRANCH = /^[A-Za-z0-9._/-]+$/
const BLOCKED_PATH_PARTS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', 'generated', 'runtime', 'logs', '.cache', '.turbo', '.vercel', '.npm', '.yarn', '.pnpm-store'])
const ENV_TEMPLATE_FILES = new Set(['.env.example', '.env.sample', '.env.template', '.env.local.example', '.env.development.example', '.env.production.example'])
const BLOCKED_FILENAMES = new Set(['.env'])
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tar', '.tgz', '.mp4', '.mov', '.avi', '.woff', '.woff2', '.ttf', '.otf'])

const SECURITY_PATTERNS: Record<Exclude<SecurityPatternSet, 'forbidden_all_high_risk'>, Array<{ name: string; pattern: RegExp }>> = {
  forbidden_runtime_execution: [
    { name: 'shell_exec', pattern: /\b(exec|spawn|execSync|spawnSync)\s*\(/i },
    { name: 'dynamic_eval', pattern: /\b(eval|Function)\s*\(/i },
    { name: 'dangerous_child_process', pattern: /child_process/i }
  ],
  forbidden_secret_material: [
    { name: 'private_key', pattern: /BEGIN (RSA|OPENSSH|EC) PRIVATE KEY/i },
    { name: 'token_prefix', pattern: /(g' \+ 'hp_|github_' \+ 'pat_|s' \+ 'k_live_|r' \+ 'k_live_|xox' \+ 'b-|A' \+ 'KIA|A' \+ 'Iza)/i },
    { name: 'secret_assignment', pattern: /\b(secret|token|password|credential|api[_-]?key)\b\s*[:=]/i }
  ],
  forbidden_upload_network: [
    { name: 'network_fetch', pattern: /\b(fetch|axios|XMLHttpRequest)\b/i },
    { name: 'curl_or_wget', pattern: /\b(curl|wget)\b/i },
    { name: 'upload_keyword', pattern: /\b(upload|multipart|formData)\b/i }
  ]
}

function redactOutput(value: string): string {
  return SECRET_PATTERNS.reduce((current, pattern) => current.replace(pattern, '[REDACTED]'), value)
}

function normalizeRepoPath(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/').trim()
}

function assertSafeRepoPath(input: string, label: string): string {
  if (typeof input !== 'string') throw new Error(`${label} must be a string`)
  if (path.isAbsolute(input) || input.startsWith('/')) throw new Error(`${label} must be source-relative`)
  const normalized = normalizeRepoPath(input)
  if (!normalized || normalized === '.' || normalized === '-A' || normalized === '--all') throw new Error(`${label} must be an explicit source-relative path`)
  if (normalized.startsWith('-')) throw new Error(`${label} must not be an option`)
  if (normalized.split('/').includes('..')) throw new Error(`${label} must not contain path traversal`)
  const basename = path.basename(normalized)
  if (!ENV_TEMPLATE_FILES.has(basename) && (BLOCKED_FILENAMES.has(basename) || /^\.env\./.test(basename))) throw new Error(`${label} points to a blocked env path`)
  if (normalized.split('/').some(part => BLOCKED_PATH_PARTS.has(part))) throw new Error(`${label} points to a blocked runtime/generated path`)
  return normalized
}

function resolveSafePath(sourceRoot: string, relativePath: string): string {
  const fullPath = path.resolve(path.join(sourceRoot, relativePath))
  if (!fullPath.startsWith(path.resolve(sourceRoot))) throw new Error('Path escaped the source root')
  return fullPath
}

function assertTextFilePath(relativePath: string): void {
  if (BINARY_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) throw new Error(`Binary path is blocked: ${relativePath}`)
}

function assertWriteAllowed(sourceId: string, sourceRoot: string, relativePath: string, changeType: 'patch' | 'delete_file' = 'patch', confirmedByUser?: boolean, confirmationToken?: string): { needsConfirmation: boolean; reason?: string } {
  const validation = validateWriteTarget({ sourceId, requestedPath: relativePath, changeType, sourceRoot, confirmedByUser, confirmationToken })
  if (validation.ok === true) return { needsConfirmation: false }
  const blocked = validation as Extract<typeof validation, { ok: false }>
  if (blocked.error.code === 'REQUIRES_EXPLICIT_CONFIRMATION') return { needsConfirmation: true, reason: blocked.error.reason }
  throw new Error(`${relativePath} is blocked by write policy: ${blocked.error.code}`)
}

function isTrackedDeletionInWorktree(sourceRoot: string, relativePath: string): boolean {
  try {
    const output = execFileSync('git', ['ls-files', '--deleted', '--', relativePath], { cwd: sourceRoot, encoding: 'utf8' }).trim()
    return output.split('\n').map(item => normalizeRepoRelativePath(item)).includes(relativePath)
  } catch {
    return false
  }
}

function getStagedPathStatuses(sourceRoot: string): Array<{ status: string; path: string }> {
  const output = fs.existsSync(path.join(sourceRoot, '.git'))
    ? execFileSync('git', ['diff', '--cached', '--name-status'], { cwd: sourceRoot, encoding: 'utf8' })
    : ''
  return output.split('\n').map(item => item.trim()).filter(Boolean).map(line => {
    const parts = line.split(/\t+/)
    const status = parts[0] || ''
    const relPath = parts.length > 2 ? parts[2] : parts[1]
    return { status, path: normalizeRepoRelativePath(relPath || '') }
  }).filter(item => item.path)
}

function assertStagePathAllowed(request: SafeCommandRequest, sourceRoot: string, relativePath: string): void {
  if (isTrackedDeletionInWorktree(sourceRoot, relativePath)) {
    assertWriteAllowed(request.sourceId, sourceRoot, relativePath, 'delete_file', request.confirmedByUser, request.confirmationToken)
    return
  }
  if (BINARY_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) {
    throw new Error(`Binary path is blocked: ${relativePath}`)
  }
  assertWriteAllowed(request.sourceId, sourceRoot, relativePath, 'patch', request.confirmedByUser, request.confirmationToken)
}

function assertCommitPathAllowed(request: SafeCommandRequest, sourceRoot: string, item: { status: string; path: string }): void {
  if (item.status.startsWith('D')) {
    assertWriteAllowed(request.sourceId, sourceRoot, item.path, 'delete_file', request.confirmedByUser, request.confirmationToken)
    return
  }
  if (BINARY_EXTENSIONS.has(path.extname(item.path).toLowerCase())) {
    throw new Error(`Binary path is blocked: ${item.path}`)
  }
  assertWriteAllowed(request.sourceId, sourceRoot, item.path, 'patch', request.confirmedByUser, request.confirmationToken)
}

function commandConfirmationToken(request: SafeCommandRequest, reason: string): string {
  const parts = [request.sourceId, request.commandKind, reason, ...(request.paths || []), request.message || '', request.remote || '', request.branch || '']
  return `confirm-command:${Buffer.from(parts.join('|')).toString('base64url')}`
}

function hasCommandConfirmation(request: SafeCommandRequest, reason: string): boolean {
  return request.confirmedByUser === true || request.confirmationToken === commandConfirmationToken(request, reason)
}

function needsConfirmationResult(request: SafeCommandRequest, reason: string): SafeCommandResult {
  return {
    status: 'needs_confirmation',
    commandKind: request.commandKind,
    command: ['buildflow', request.commandKind],
    cwd: path.resolve(request.sourceRoot),
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    outputTruncated: false,
    durationMs: 0,
    requiresConfirmation: true,
    confirmationToken: commandConfirmationToken(request, reason),
    reason
  }
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

async function runProcess(request: SafeCommandRequest, command: string[], cwd: string): Promise<SafeCommandResult> {
  const sourceRoot = path.resolve(request.sourceRoot)
  const resolvedCwd = path.resolve(cwd)
  if (!resolvedCwd.startsWith(sourceRoot)) throw new Error('Command cwd escaped the source root')
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1_000, request.timeoutMs || DEFAULT_TIMEOUT_MS))
  const startedAt = Date.now()
  const outputState = { bytes: 0, truncated: false }

  return await new Promise<SafeCommandResult>((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: resolvedCwd,
      shell: false,
      detached: process.platform !== 'win32',
      env: {
        PATH: process.env.PATH || '',
        HOME: process.env.HOME || '',
        CI: '1',
        NO_COLOR: '1',
        GH_PROMPT_DISABLED: '1',
        GIT_TERMINAL_PROMPT: '0'
      }
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let killTimer: NodeJS.Timeout | undefined
    const signalProcess = (signal: NodeJS.Signals) => {
      if (child.pid && process.platform !== 'win32') {
        try {
          process.kill(-child.pid, signal)
          return
        } catch {
          // Fall back to direct child signaling below.
        }
      }
      child.kill(signal)
    }
    const timer = setTimeout(() => {
      timedOut = true
      signalProcess('SIGTERM')
      killTimer = setTimeout(() => {
        if (!child.killed || child.exitCode === null) {
          signalProcess('SIGKILL')
        }
      }, 500)
    }, timeoutMs)

    const clearTimers = () => {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
    }

    child.stdout.on('data', chunk => {
      stdout = appendLimited(stdout, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)), outputState)
    })
    child.stderr.on('data', chunk => {
      stderr = appendLimited(stderr, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)), outputState)
    })
    child.on('error', err => {
      clearTimers()
      reject(err)
    })
    child.on('close', (exitCode, signal) => {
      clearTimers()
      resolve({
        status: timedOut ? 'timed_out' : exitCode === 0 ? 'completed' : 'failed',
        commandKind: request.commandKind,
        command,
        cwd: resolvedCwd,
        exitCode,
        signal,
        stdout,
        stderr,
        outputTruncated: outputState.truncated,
        durationMs: Date.now() - startedAt
      })
    })
  })
}

async function runAndAppendGitLog(request: SafeCommandRequest, command: string[], cwd: string): Promise<SafeCommandResult> {
  const result = await runProcess(request, command, cwd)
  if (result.status !== 'completed') return result
  const log = await runProcess({ ...request, commandKind: 'git_log_latest' }, ['git', 'log', '-1', '--oneline'], cwd)
  return { ...result, stdout: `${result.stdout}${result.stdout ? '\n' : ''}${log.stdout}`.trim(), outputTruncated: result.outputTruncated || log.outputTruncated }
}

function assertExplicitPaths(paths?: string[], options: { allowBinaryPaths?: boolean } = {}): string[] {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('paths must be a non-empty explicit file list')
  if (paths.some(item => item === '.' || item === '-A' || item === '--all')) throw new Error('paths must not include git add shortcuts')
  return paths.map(item => {
    const normalized = assertSafeRepoPath(item, 'path')
    if (options.allowBinaryPaths !== true) assertTextFilePath(normalized)
    return normalized
  })
}

function getStagedPaths(sourceRoot: string): string[] {
  return getStagedPathStatuses(sourceRoot).map(item => item.path)
}

function assertNoSecretLikeText(text: string, label: string): void {
  if (SECRET_PATTERNS.some(pattern => pattern.test(text))) throw new Error(`${label} contains secret-looking content`)
}

function assertPackageDir(sourceRoot: string, packageDir: string | undefined): string {
  if (!packageDir) throw new Error('packageDir is required')
  const raw = String(packageDir).trim()
  const cwd = raw === '.' ? path.resolve(sourceRoot) : resolveSafePath(sourceRoot, assertSafeRepoPath(raw, 'packageDir'))
  if (!fs.existsSync(path.join(cwd, 'package.json'))) throw new Error('packageDir must contain package.json')
  return cwd
}

function structuredLocalResult(request: SafeCommandRequest, status: SafeCommandResult['status'], command: string[], stdout: unknown, stderr = '', exitCode: number | null = 0): SafeCommandResult {
  return {
    status,
    commandKind: request.commandKind,
    command,
    cwd: path.resolve(request.sourceRoot),
    exitCode,
    signal: null,
    stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout, null, 2),
    stderr,
    outputTruncated: false,
    durationMs: 0,
    details: typeof stdout === 'string' ? undefined : stdout
  }
}

async function runRepoLocalTsxScript(request: SafeCommandRequest, scriptPath: string): Promise<SafeCommandResult> {
  const sourceRoot = path.resolve(request.sourceRoot)
  const normalizedScript = assertSafeRepoPath(scriptPath, 'scriptPath')
  const fullScriptPath = resolveSafePath(sourceRoot, normalizedScript)
  if (!fs.existsSync(fullScriptPath)) {
    return structuredLocalResult(request, 'completed', ['buildflow', request.commandKind, 'skipped'], {
      skipped: true,
      reason: 'script_not_found_in_selected_source',
      scriptPath: normalizedScript,
      message: `${request.commandKind} is only run when the selected source contains ${normalizedScript}.`
    })
  }
  if (!fs.existsSync(path.join(sourceRoot, 'package.json'))) {
    return structuredLocalResult(request, 'failed', ['buildflow', request.commandKind], {
      skipped: false,
      reason: 'package_json_missing',
      scriptPath: normalizedScript,
      message: `${request.commandKind} requires package.json in the selected source root.`
    }, '', 1)
  }
  return runProcess(request, ['pnpm', 'exec', 'tsx', normalizedScript], sourceRoot)
}

function currentBranch(sourceRoot: string): string {
  const output = execFileSync('git', ['branch', '--show-current'], { cwd: sourceRoot, encoding: 'utf8' }).trim()
  return output || 'main'
}

function getGitOutput(sourceRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: sourceRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GH_PROMPT_DISABLED: '1'
    }
  }).trim()
}

function getGithubRepoSlug(sourceRoot: string, remote: string): string {
  try {
    const output = execFileSync('gh', ['repo', 'view', remote, '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], {
      cwd: sourceRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: '1'
      }
    }).trim()
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(output)) return output
  } catch {
    // Fall back to parsing the configured remote URL.
  }

  const remoteUrl = getGitOutput(sourceRoot, ['remote', 'get-url', remote])
  const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/)
  if (sshMatch) return sshMatch[1]
  const httpsMatch = remoteUrl.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/)
  if (httpsMatch) return httpsMatch[1]
  throw new Error(`git_push only supports GitHub remotes; ${remote} points to ${remoteUrl}`)
}

async function runGithubCliBackedPush(request: SafeCommandRequest, remote: string, branch: string, sourceRoot: string): Promise<SafeCommandResult> {
  const auth = await runProcess(request, ['gh', 'auth', 'status'], sourceRoot)
  if (auth.status !== 'completed') {
    return {
      ...auth,
      commandKind: 'git_push',
      command: ['gh', 'auth', 'status'],
      stderr: `${auth.stderr}${auth.stderr ? '\n' : ''}GitHub CLI authentication is required before BuildFlow can push. Run: gh auth login`
    }
  }

  const repoSlug = getGithubRepoSlug(sourceRoot, remote)
  const httpsUrl = `https://github.com/${repoSlug}.git`
  const currentUrl = getGitOutput(sourceRoot, ['remote', 'get-url', remote])
  if (currentUrl !== httpsUrl) {
    const setUrl = await runProcess(request, ['git', 'remote', 'set-url', remote, httpsUrl], sourceRoot)
    if (setUrl.status !== 'completed') return setUrl
  }

  const setup = await runProcess(request, ['gh', 'auth', 'setup-git'], sourceRoot)
  if (setup.status !== 'completed') return setup

  const push = await runProcess(request, ['git', 'push', remote, branch], sourceRoot)
  return {
    ...push,
    command: ['gh', 'auth', 'setup-git', '&&', 'git', 'push', remote, branch],
    stdout: [
      currentUrl !== httpsUrl ? `remote ${remote} normalized to ${httpsUrl}` : `remote ${remote} already uses HTTPS`,
      setup.stdout.trim(),
      push.stdout.trim()
    ].filter(Boolean).join('\n'),
    stderr: push.stderr
  }
}

function patternList(patternSet: SecurityPatternSet): Array<{ name: string; pattern: RegExp }> {
  if (patternSet === 'forbidden_all_high_risk') return Object.values(SECURITY_PATTERNS).flat()
  const selected = SECURITY_PATTERNS[patternSet]
  if (!selected) throw new Error('patternSet must be one of the named security scan sets')
  return selected
}

function scanSecurityPaths(request: SafeCommandRequest): SafeCommandResult {
  const paths = assertExplicitPaths(request.paths)
  const patternSet = request.patternSet || 'forbidden_all_high_risk'
  const patterns = patternList(patternSet)
  const findings: Array<{ path: string; line: number; pattern: string; snippet: string }> = []

  for (const relPath of paths) {
    const fullPath = resolveSafePath(path.resolve(request.sourceRoot), relPath)
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) throw new Error(`scan path not found: ${relPath}`)
    const size = fs.statSync(fullPath).size
    if (size > TEXT_SCAN_MAX_BYTES) throw new Error(`scan file too large: ${relPath}`)
    const content = fs.readFileSync(fullPath, 'utf8')
    const lines = content.split(/\r?\n/)
    lines.forEach((line, index) => {
      for (const entry of patterns) {
        if (entry.pattern.test(line)) {
          findings.push({ path: relPath, line: index + 1, pattern: entry.name, snippet: redactOutput(line).slice(0, 240) })
        }
      }
    })
  }

  return {
    status: findings.length === 0 ? 'completed' : 'failed',
    commandKind: request.commandKind,
    command: ['buildflow', 'security_scan_paths', patternSet],
    cwd: path.resolve(request.sourceRoot),
    exitCode: findings.length === 0 ? 0 : 1,
    signal: null,
    stdout: JSON.stringify({ findings }, null, 2),
    stderr: '',
    outputTruncated: false,
    durationMs: 0,
    details: { findings }
  }
}

async function validateJsonFiles(request: SafeCommandRequest): Promise<SafeCommandResult> {
  const paths = assertExplicitPaths(request.paths)
  const results: Array<{ path: string; ok: boolean; error?: string }> = []
  for (const relPath of paths) {
    if (!relPath.endsWith('.json')) throw new Error('validate_json_files only accepts .json paths')
    const result = await runProcess(request, ['python3', '-m', 'json.tool', relPath], path.resolve(request.sourceRoot))
    results.push({ path: relPath, ok: result.status === 'completed', error: result.status === 'completed' ? undefined : redactOutput(result.stderr || result.stdout).slice(0, 400) })
  }
  const failed = results.filter(item => !item.ok)
  return {
    status: failed.length === 0 ? 'completed' : 'failed',
    commandKind: request.commandKind,
    command: ['python3', '-m', 'json.tool', '<paths>'],
    cwd: path.resolve(request.sourceRoot),
    exitCode: failed.length === 0 ? 0 : 1,
    signal: null,
    stdout: JSON.stringify({ results }, null, 2),
    stderr: '',
    outputTruncated: false,
    durationMs: 0,
    details: { results }
  }
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
    'git_diff_cached_stat',
    'git_diff_cached_name_only',
    'git_add_paths',
    'git_commit',
    'git_push',
    'validate_json_files',
    'run_package_script',
    'run_package_test',
    'run_package_test_marker',
    'security_scan_paths',
    'diagnose_performance',
    'local_cli_github_auth_status',
    'local_cli_github_repo_view'
  ]
}

export async function runSafeCommand(request: SafeCommandRequest): Promise<SafeCommandResult> {
  const sourceRoot = path.resolve(request.sourceRoot)

  if (request.commandKind === 'verify_write_policy') return runRepoLocalTsxScript(request, 'scripts/verify-write-policy.ts')
  if (request.commandKind === 'verify_source_reindex_resilience') return runRepoLocalTsxScript(request, 'scripts/verify-source-reindex-resilience.ts')
  if (request.commandKind === 'diagnose_performance') return runRepoLocalTsxScript(request, 'scripts/diagnose-performance.ts')
  if (request.commandKind === 'local_cli_github_auth_status') return runProcess(request, ['gh', 'auth', 'status'], sourceRoot)
  if (request.commandKind === 'local_cli_github_repo_view') return runProcess(request, ['gh', 'repo', 'view', '--json', 'nameWithOwner,url,defaultBranchRef'], sourceRoot)

  if (request.commandKind === 'validate_json_files') return validateJsonFiles(request)
  if (request.commandKind === 'security_scan_paths') return scanSecurityPaths(request)

  if (request.commandKind === 'git_add_paths') {
    const paths = assertExplicitPaths(request.paths, { allowBinaryPaths: true })
    for (const relPath of paths) assertStagePathAllowed(request, sourceRoot, relPath)
    return runProcess(request, ['git', 'add', '--', ...paths], sourceRoot)
  }

  if (request.commandKind === 'git_commit') {
    const stagedStatuses = getStagedPathStatuses(sourceRoot)
    const staged = stagedStatuses.map(item => item.path)
    if (staged.length === 0) throw new Error('git_commit requires staged changes')
    for (const item of stagedStatuses) assertCommitPathAllowed(request, sourceRoot, item)
    const message = typeof request.message === 'string' ? request.message.trim() : ''
    const body = typeof request.body === 'string' ? request.body.trim() : ''
    if (!message || /[\r\n]/.test(message) || message.length > 200) throw new Error('message must be a short single-line string')
    if (body && body.length > 2000) throw new Error('body is too long')
    assertNoSecretLikeText(message, 'message')
    if (body) assertNoSecretLikeText(body, 'body')
    return runAndAppendGitLog(request, ['git', 'commit', '-m', message, ...(body ? ['-m', body] : [])], sourceRoot)
  }

  if (request.commandKind === 'git_push') {
    const remote = typeof request.remote === 'string' && request.remote.trim() ? request.remote.trim() : 'origin'
    const branch = typeof request.branch === 'string' && request.branch.trim() ? request.branch.trim() : currentBranch(sourceRoot)
    if (!SAFE_REMOTE.test(remote)) throw new Error('remote must be a safe remote name')
    if (!SAFE_BRANCH.test(branch) || branch.startsWith('-') || branch.includes('..')) throw new Error('branch must be a safe branch name')
    return runGithubCliBackedPush(request, remote, branch, sourceRoot)
  }

  if (request.commandKind === 'run_package_script') {
    const cwd = assertPackageDir(sourceRoot, request.packageDir)
    const scriptName = typeof request.scriptName === 'string' ? request.scriptName : ''
    if (!SAFE_SCRIPT_NAME.test(scriptName)) throw new Error('scriptName contains unsafe characters')
    return runProcess(request, ['npm', 'run', scriptName], cwd)
  }

  if (request.commandKind === 'run_package_test') {
    return runProcess(request, ['npm', 'test'], assertPackageDir(sourceRoot, request.packageDir))
  }

  if (request.commandKind === 'run_package_test_marker') {
    const cwd = assertPackageDir(sourceRoot, request.packageDir)
    const marker = typeof request.marker === 'string' ? request.marker : ''
    if (!marker || marker.length > 160 || !SAFE_MARKER.test(marker)) throw new Error('marker contains unsafe characters')
    return runProcess(request, ['npm', 'test', '--', '--test-name-pattern', marker], cwd)
  }

  const command = STATIC_COMMANDS[request.commandKind]
  if (!command) throw new Error(`Command kind is not allowlisted: ${request.commandKind}`)
  return runProcess(request, command, sourceRoot)
}
