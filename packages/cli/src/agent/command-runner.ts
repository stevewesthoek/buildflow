import fs from 'fs'
import { createHash } from 'crypto'
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
  | 'run_exact_command'

export type ExactCommandExecutable = 'node' | 'pnpm'

export type ExactCommandPolicy = {
  denyDatabaseCommands?: boolean
  denyMigrationCommands?: boolean
  denyDeploymentCommands?: boolean
  denyNetworkCommands?: boolean
}

export type ExactCommandRuntimeEvidence = {
  requestedNodeVersion?: '20'
  nodeExecutable?: string
  nodeVersion?: string
  nodeMajorVersion?: number
  pnpmVersion?: string
}

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
  executable?: ExactCommandExecutable
  args?: string[]
  nodeVersion?: '20'
  policy?: ExactCommandPolicy
  protectedPaths?: string[]
  requiredBranch?: string
  networkAccess?: false
  persistedValidation?: boolean
  confirmedByUser?: boolean
  confirmationToken?: string
}

export type SafeCommandResult = {
  status: 'completed' | 'failed' | 'timed_out' | 'needs_confirmation' | 'blocked'
  commandKind: SafeCommandKind
  command: string[]
  cwd: string
  executable?: ExactCommandExecutable
  args?: string[]
  packageDir?: string
  requiredBranch?: string
  actualBranch?: string
  runtime?: ExactCommandRuntimeEvidence
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  outputTruncated: boolean
  durationMs: number
  changedPaths?: string[]
  protectedPathsChanged?: string[]
  riskLevel?: 'medium' | 'high'
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
const SECRET_ASSIGNMENT_PATTERN = /\b(DATABASE_URL|API_KEY|ACCESS_TOKEN|AUTH_TOKEN|BEARER_TOKEN|CLIENT_SECRET|PRIVATE_KEY|PASSWORD|PASSWD|SECRET|TOKEN)\s*[:=]\s*([^\s'\"`]+)/gi
const AUTHENTICATED_URL_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s\/@:]+):([^\s\/@]+)@/gi
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi
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
    ...secretPatternSources.map((source, index) => ({
      name: `secret_pattern_${index + 1}`,
      pattern: new RegExp(source, 'i')
    })),
    { name: 'secret_assignment', pattern: /\b(secret|token|password|credential|api[_-]?key)\b\s*[:=]/i }
  ],
  forbidden_upload_network: [
    { name: 'network_fetch', pattern: /\b(fetch|axios|XMLHttpRequest)\b/i },
    { name: 'curl_or_wget', pattern: /\b(curl|wget)\b/i },
    { name: 'upload_keyword', pattern: /\b(upload|multipart|formData)\b/i }
  ]
}

function registeredSecretValues(): string[] {
  const secretName = /(DATABASE_URL|API_KEY|ACCESS_TOKEN|AUTH_TOKEN|BEARER_TOKEN|CLIENT_SECRET|PRIVATE_KEY|PASSWORD|PASSWD|SECRET|TOKEN)/i
  return Object.entries(process.env)
    .filter(([key, value]) => secretName.test(key) && typeof value === 'string' && value.length >= 4)
    .map(([, value]) => value as string)
    .sort((a, b) => b.length - a.length)
}

function redactOutput(value: string): string {
  let current = SECRET_PATTERNS.reduce((redacted, pattern) => redacted.replace(pattern, '[REDACTED]'), value)
  current = current.replace(SECRET_ASSIGNMENT_PATTERN, (_match, name: string) => `${name}=[REDACTED]`)
  current = current.replace(AUTHENTICATED_URL_PATTERN, (_match, scheme: string) => `${scheme}[REDACTED]@`)
  current = current.replace(BEARER_PATTERN, 'Bearer [REDACTED]')
  for (const secret of registeredSecretValues()) current = current.split(secret).join('[REDACTED]')
  return current
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
    'local_cli_github_repo_view',
    'run_exact_command'
  ]
}

function exactBlockedResult(request: SafeCommandRequest, reason: string, actualBranch?: string): SafeCommandResult {
  return {
    status: 'blocked',
    commandKind: request.commandKind,
    command: ['buildflow', 'run_exact_command'],
    cwd: path.resolve(request.sourceRoot),
    executable: request.executable,
    args: request.args,
    packageDir: request.packageDir || '.',
    requiredBranch: request.requiredBranch,
    actualBranch,
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    outputTruncated: false,
    durationMs: 0,
    changedPaths: [],
    protectedPathsChanged: [],
    riskLevel: 'medium',
    requiresConfirmation: false,
    reason
  }
}

function exactRealpathWithin(sourceRoot: string, candidate: string, label: string): string {
  const rootReal = fs.realpathSync(sourceRoot)
  const candidateReal = fs.realpathSync(candidate)
  if (candidateReal !== rootReal && !candidateReal.startsWith(`${rootReal}${path.sep}`)) throw new Error(`${label} escaped the source root through a symlink`)
  return candidateReal
}

function exactValidateArgs(sourceRoot: string, cwd: string, args: unknown): string[] {
  if (!Array.isArray(args)) throw new Error('args must be an array')
  return args.map((value, index) => {
    if (typeof value !== 'string') throw new Error(`args[${index}] must be a string`)
    if (/\0|[\r\n]|;|&&|\|\||\||>|<|`|\$\(/.test(value)) throw new Error(`args[${index}] contains prohibited shell syntax`)
    if (path.isAbsolute(value)) {
      const resolved = path.resolve(value)
      if (resolved !== sourceRoot && !resolved.startsWith(`${sourceRoot}${path.sep}`)) throw new Error(`args[${index}] contains an absolute path outside the source root`)
    } else if (value.includes('..')) {
      const resolved = path.resolve(cwd, value)
      if (resolved !== sourceRoot && !resolved.startsWith(`${sourceRoot}${path.sep}`)) throw new Error(`args[${index}] resolves outside the source root`)
    }
    return value
  })
}

function exactResolveNode20(): { nodeExecutable: string; binDir: string; nodeVersion: string; nodeMajorVersion: number } {
  const candidates: string[] = []
  const nvmDirs = Array.from(new Set([
    process.env.NVM_DIR,
    process.env.HOME ? path.join(process.env.HOME, '.nvm') : undefined
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)))
  for (const nvmDir of nvmDirs) {
    const versionsDir = path.join(nvmDir, 'versions', 'node')
    if (fs.existsSync(versionsDir)) {
      for (const entry of fs.readdirSync(versionsDir).filter(name => /^v20\./.test(name)).sort().reverse()) {
        candidates.push(path.join(versionsDir, entry, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'))
      }
    }
  }
  if (process.version.startsWith('v20.')) candidates.push(process.execPath)
  for (const nodeExecutable of candidates) {
    if (!fs.existsSync(nodeExecutable)) continue
    const nodeVersion = execFileSync(nodeExecutable, ['--version'], { encoding: 'utf8', timeout: 2_000 }).trim()
    const nodeMajorVersion = Number(nodeVersion.replace(/^v/, '').split('.')[0])
    if (nodeMajorVersion === 20) return { nodeExecutable, binDir: path.dirname(nodeExecutable), nodeVersion, nodeMajorVersion }
  }
  throw new Error('Node 20 is not installed or could not be resolved')
}

function exactMinimalEnv(binDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`, CI: '1', NO_COLOR: '1' }
  for (const key of ['HOME', 'USER', 'TMPDIR', 'TEMP', 'TMP', 'TERM', 'FORCE_COLOR', 'NVM_DIR', 'PNPM_HOME', 'COREPACK_HOME', 'XDG_CACHE_HOME']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return env
}

function exactPackageScript(cwd: string, executable: ExactCommandExecutable, args: string[]): { resolvedScriptName?: string; scriptCommand?: string } {
  if (executable !== 'pnpm' || args.length === 0 || args[0] === '--version') return {}
  let scriptName: string | undefined
  if (args[0] === 'run') scriptName = args[1]
  else if (args[0] !== 'exec') scriptName = args[0]
  if (!scriptName) return {}
  if (!SAFE_SCRIPT_NAME.test(scriptName)) throw new Error('package script name contains unsafe characters')
  const packageJson = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }
  const scriptCommand = packageJson.scripts?.[scriptName]
  if (typeof scriptCommand !== 'string') throw new Error(`Package script does not exist: ${scriptName}`)
  return { resolvedScriptName: scriptName, scriptCommand }
}

function exactAssertPolicy(scriptCommand: string | undefined, policy: ExactCommandPolicy | undefined): void {
  if (!scriptCommand) return
  const normalized = scriptCommand.toLowerCase()
  const checks: Array<[boolean | undefined, RegExp, string]> = [
    [policy?.denyDatabaseCommands, /\b(payload\s+migrate(?::status)?|prisma\s+(migrate|db)|seed|db:init|database:init|psql|mysql|sqlite3|mongosh|redis-cli)\b/i, 'database command'],
    [policy?.denyMigrationCommands, /\b(payload\s+migrate(?::status)?|prisma\s+migrate)\b/i, 'migration command'],
    [policy?.denyDeploymentCommands, /\b(docker\s+push|docker\s+compose\s+up|kubectl|deploy|production|latest)\b/i, 'deployment command'],
    [policy?.denyNetworkCommands, /\b(curl|wget|nc|netcat|ssh|scp|rsync)\b/i, 'network command']
  ]
  for (const [enabled, pattern, label] of checks) if (enabled && pattern.test(normalized)) throw new Error(`Package script is blocked by policy: ${label}`)
}

function exactGitSnapshot(sourceRoot: string): Map<string, string> {
  const output = execFileSync('git', ['status', '--porcelain=v1', '-uall'], { cwd: sourceRoot, encoding: 'utf8' })
  const result = new Map<string, string>()
  for (const line of output.split('\n').filter(Boolean)) result.set(normalizeRepoRelativePath(line.slice(3)), line.slice(0, 2))
  return result
}

function exactChangedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter(item => !path.isAbsolute(item) && !item.split('/').includes('..'))
    .filter(item => before.get(item) !== after.get(item))
    .sort()
}

const EXACT_PROTECTED_SCAN_LIMIT = 150_000
const EXACT_PROTECTED_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx'])
const EXACT_PROTECTED_SCAN_PRUNED_DIRS = new Set([
  'node_modules',
  '.next',
  '.turbo',
  'dist',
  'build',
  'coverage',
  'out'
])

function exactIsProtectedFile(relativePath: string): boolean {
  const normalized = normalizeRepoRelativePath(relativePath)
  const parts = normalized.split('/')
  const basename = path.basename(normalized)
  return parts.includes('.git') || basename === '.env' || /^\.env\./.test(basename) || EXACT_PROTECTED_EXTENSIONS.has(path.extname(basename).toLowerCase())
}

function exactProtectedFilesystemSnapshot(sourceRoot: string): Map<string, string> {
  const rootReal = fs.realpathSync(sourceRoot)
  const snapshot = new Map<string, string>()
  let visited = 0
  const visit = (absolutePath: string, relativePath: string) => {
    visited += 1
    if (visited > EXACT_PROTECTED_SCAN_LIMIT) throw new Error('Protected path scan exceeded its bounded entry limit')
    const stat = fs.lstatSync(absolutePath)
    const normalized = normalizeRepoRelativePath(relativePath)
    const protectedEntry = normalized ? exactIsProtectedFile(normalized) : false
    if (protectedEntry) {
      snapshot.set(normalized, `${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'dir' : 'file'}`)
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return
    if (normalized && EXACT_PROTECTED_SCAN_PRUNED_DIRS.has(path.basename(normalized))) return
    for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
      const childAbsolute = path.join(absolutePath, entry.name)
      const childRelative = normalized ? `${normalized}/${entry.name}` : entry.name
      const resolved = path.resolve(childAbsolute)
      if (resolved !== rootReal && !resolved.startsWith(`${rootReal}${path.sep}`)) throw new Error('Protected path scan escaped the source root')
      visit(childAbsolute, childRelative)
    }
  }
  visit(rootReal, '')
  return snapshot
}

function exactProtectedChanges(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter(item => before.get(item) !== after.get(item))
    .sort()
}

function exactPathHash(sourceRoot: string, relativePath: string): string {
  const fullPath = path.join(sourceRoot, relativePath)
  if (!fs.existsSync(fullPath)) return 'missing'
  const stat = fs.statSync(fullPath)
  if (stat.isDirectory()) {
    const entries = fs.readdirSync(fullPath, { recursive: true }).map(String).sort()
    const hash = createHash('sha256')
    for (const entry of entries) {
      const child = path.join(fullPath, entry)
      if (fs.statSync(child).isFile()) hash.update(entry).update(fs.readFileSync(child))
    }
    return hash.digest('hex')
  }
  return createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex')
}

async function runExactCommand(request: SafeCommandRequest): Promise<SafeCommandResult> {
  const sourceRoot = fs.realpathSync(path.resolve(request.sourceRoot))
  const cwd = request.packageDir === '.' || !request.packageDir ? sourceRoot : assertPackageDir(sourceRoot, request.packageDir)
  exactRealpathWithin(sourceRoot, cwd, 'packageDir')
  const actualBranch = currentBranch(sourceRoot)
  if (request.requiredBranch && actualBranch !== request.requiredBranch) return exactBlockedResult(request, 'branch_mismatch', actualBranch)
  if (request.executable !== 'node' && request.executable !== 'pnpm') throw new Error('executable must be node or pnpm')
  const args = exactValidateArgs(sourceRoot, cwd, request.args)
  const runtime = exactResolveNode20()
  if (request.nodeVersion === '20' && runtime.nodeMajorVersion !== 20) throw new Error('Resolved child runtime is not Node 20')
  const { resolvedScriptName, scriptCommand } = exactPackageScript(cwd, request.executable, args)
  exactAssertPolicy(scriptCommand, request.policy)
  const protectedPaths = (request.protectedPaths || []).map(item => assertSafeRepoPath(item, 'protectedPath'))
  const protectedBefore = new Map(protectedPaths.map(item => [item, exactPathHash(sourceRoot, item)]))
  const before = exactGitSnapshot(sourceRoot)
  const mandatoryProtectedBefore = exactProtectedFilesystemSnapshot(sourceRoot)
  const pnpmName = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const pnpmCandidates = [
    path.join(runtime.binDir, pnpmName),
    process.env.PNPM_HOME ? path.join(process.env.PNPM_HOME, pnpmName) : undefined,
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(entry => path.join(entry, pnpmName))
  ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0)
  const executablePath = request.executable === 'node'
    ? runtime.nodeExecutable
    : pnpmCandidates.find(candidate => fs.existsSync(candidate))
  if (!executablePath) throw new Error(`Unable to resolve ${request.executable} in the Node 20 environment`)
  const startedAt = Date.now()
  const outputState = { bytes: 0, truncated: false }
  const timeoutCeiling = request.persistedValidation ? MAX_TIMEOUT_MS : 12_000
  const timeoutMs = Math.min(timeoutCeiling, Math.max(1_000, request.timeoutMs || 8_000))
  const result = await new Promise<SafeCommandResult>((resolve, reject) => {
    const child = spawn(executablePath, args, { cwd, shell: false, detached: process.platform !== 'win32', env: exactMinimalEnv(runtime.binDir) })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let killTimer: NodeJS.Timeout | undefined
    const signalProcess = (signal: NodeJS.Signals) => {
      if (child.pid && process.platform !== 'win32') {
        try { process.kill(-child.pid, signal); return } catch { /* direct child fallback */ }
      }
      child.kill(signal)
    }
    const timer = setTimeout(() => {
      timedOut = true
      signalProcess('SIGTERM')
      killTimer = setTimeout(() => signalProcess('SIGKILL'), 500)
    }, timeoutMs)
    child.stdout.on('data', chunk => { stdout = appendLimited(stdout, Buffer.from(chunk), outputState) })
    child.stderr.on('data', chunk => { stderr = appendLimited(stderr, Buffer.from(chunk), outputState) })
    child.on('error', error => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); reject(error) })
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      resolve({
        status: timedOut ? 'timed_out' : exitCode === 0 ? 'completed' : 'failed', commandKind: request.commandKind,
        command: [request.executable!, ...args], cwd, executable: request.executable, args, packageDir: request.packageDir || '.',
        requiredBranch: request.requiredBranch, actualBranch, runtime: { requestedNodeVersion: request.nodeVersion, nodeExecutable: runtime.nodeExecutable, nodeVersion: runtime.nodeVersion, nodeMajorVersion: runtime.nodeMajorVersion },
        exitCode, signal, stdout, stderr, outputTruncated: outputState.truncated, durationMs: Date.now() - startedAt,
        changedPaths: [], protectedPathsChanged: [], riskLevel: 'medium', requiresConfirmation: false,
        details: resolvedScriptName ? { resolvedScriptName } : undefined
      })
    })
  })
  if (request.executable === 'pnpm') {
    try { result.runtime = { ...result.runtime, pnpmVersion: execFileSync(executablePath, ['--version'], { cwd, env: exactMinimalEnv(runtime.binDir), encoding: 'utf8', timeout: 2_000 }).trim() } } catch { /* retain command evidence */ }
  }
  const mandatoryProtectedAfter = exactProtectedFilesystemSnapshot(sourceRoot)
  result.changedPaths = exactChangedPaths(before, exactGitSnapshot(sourceRoot))
  const callerProtectedChanges = protectedPaths.filter(item => protectedBefore.get(item) !== exactPathHash(sourceRoot, item))
  const mandatoryProtectedChanges = exactProtectedChanges(mandatoryProtectedBefore, mandatoryProtectedAfter)
  result.protectedPathsChanged = [...new Set([...callerProtectedChanges, ...mandatoryProtectedChanges])].sort()
  if (result.protectedPathsChanged.length > 0) {
    result.status = 'blocked'
    result.reason = mandatoryProtectedChanges.length > 0 ? 'mandatory_protected_path_changed' : 'protected_path_changed'
  }
  return result
}

export async function runSafeCommand(request: SafeCommandRequest): Promise<SafeCommandResult> {
  const sourceRoot = path.resolve(request.sourceRoot)

  if (request.commandKind === 'run_exact_command') return runExactCommand(request)

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

  if (request.commandKind === 'git_diff' || request.commandKind === 'git_diff_stat' || request.commandKind === 'git_diff_name_only') {
    const pathspecs = (request.paths || []).map(item => {
      if (typeof item !== 'string' || !item.trim()) throw new Error('paths must contain non-empty repository-relative strings')
      const normalized = normalizeRepoRelativePath(item)
      if (!normalized || normalized === '.' || normalized.startsWith('-')) throw new Error(`Unsafe git pathspec: ${item}`)
      const resolved = path.resolve(sourceRoot, normalized)
      const relative = path.relative(sourceRoot, resolved)
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Git pathspec escaped the source root: ${item}`)
      return normalized
    })
    const result = await runProcess(request, pathspecs.length > 0 ? [...command, '--', ...pathspecs] : command, sourceRoot)
    if (pathspecs.length === 0) return result

    const status = await runProcess(
      request,
      ['git', 'status', '--short', '--untracked-files=all', '--', ...pathspecs],
      sourceRoot
    )
    const untracked = status.stdout
      .split('\n')
      .map(line => line.trimEnd())
      .filter(line => line.startsWith('?? '))
    if (untracked.length > 0) {
      const outputState = {
        bytes: Buffer.byteLength(result.stdout, 'utf8'),
        truncated: result.outputTruncated
      }
      result.stdout = appendLimited(
        result.stdout,
        Buffer.from(`${result.stdout.endsWith('\n') || result.stdout.length === 0 ? '' : '\n'}\nUntracked path evidence:\n${untracked.join('\n')}\n`),
        outputState
      )
      result.outputTruncated = outputState.truncated
    }
    return result
  }

  return runProcess(request, command, sourceRoot)
}
