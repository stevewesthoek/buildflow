import fs from 'fs'
import { spawn } from 'child_process'
import path from 'path'
import { validateWriteTarget } from './safe-access'

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
  verify_write_policy: ['./packages/cli/node_modules/.bin/tsx', 'scripts/verify-write-policy.ts'],
  verify_source_reindex_resilience: ['./packages/cli/node_modules/.bin/tsx', 'scripts/verify-source-reindex-resilience.ts'],
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
  if (BLOCKED_FILENAMES.has(path.basename(normalized)) || /^\.env\./.test(path.basename(normalized))) throw new Error(`${label} points to a blocked env path`)
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

function assertWriteAllowed(sourceId: string, sourceRoot: string, relativePath: string, confirmedByUser?: boolean, confirmationToken?: string): { needsConfirmation: boolean; reason?: string } {
  const validation = validateWriteTarget({ sourceId, requestedPath: relativePath, changeType: 'patch', sourceRoot, confirmedByUser, confirmationToken })
  if (validation.ok === true) return { needsConfirmation: false }
  const blocked = validation as Extract<typeof validation, { ok: false }>
  if (blocked.error.code === 'REQUIRES_EXPLICIT_CONFIRMATION') return { needsConfirmation: true, reason: blocked.error.reason }
  throw new Error(`${relativePath} is blocked by write policy: ${blocked.error.code}`)
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

function assertExplicitPaths(paths?: string[]): string[] {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('paths must be a non-empty explicit file list')
  if (paths.some(item => item === '.' || item === '-A' || item === '--all')) throw new Error('paths must not include git add shortcuts')
  return paths.map(item => {
    const normalized = assertSafeRepoPath(item, 'path')
    assertTextFilePath(normalized)
    return normalized
  })
}

function getStagedPaths(sourceRoot: string): string[] {
  const output = fs.existsSync(path.join(sourceRoot, '.git'))
    ? require('child_process').execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: sourceRoot, encoding: 'utf8' })
    : ''
  return output.split('\n').map((item: string) => item.trim()).filter(Boolean)
}

function assertNoSecretLikeText(text: string, label: string): void {
  if (SECRET_PATTERNS.some(pattern => pattern.test(text))) throw new Error(`${label} contains secret-looking content`)
}

function assertPackageDir(sourceRoot: string, packageDir: string | undefined): string {
  if (!packageDir) throw new Error('packageDir is required')
  const normalized = assertSafeRepoPath(packageDir, 'packageDir')
  const cwd = resolveSafePath(sourceRoot, normalized)
  if (!fs.existsSync(path.join(cwd, 'package.json'))) throw new Error('packageDir must contain package.json')
  return cwd
}

function currentBranch(sourceRoot: string): string {
  const output = require('child_process').execFileSync('git', ['branch', '--show-current'], { cwd: sourceRoot, encoding: 'utf8' }).trim()
  return output || 'main'
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
    'security_scan_paths'
  ]
}

export async function runSafeCommand(request: SafeCommandRequest): Promise<SafeCommandResult> {
  const sourceRoot = path.resolve(request.sourceRoot)

  if (request.commandKind === 'validate_json_files') return validateJsonFiles(request)
  if (request.commandKind === 'security_scan_paths') return scanSecurityPaths(request)

  if (request.commandKind === 'git_add_paths') {
    const paths = assertExplicitPaths(request.paths)
    let needsConfirmation = false
    for (const relPath of paths) {
      const allowed = assertWriteAllowed(request.sourceId, sourceRoot, relPath, request.confirmedByUser, request.confirmationToken)
      if (allowed.needsConfirmation) needsConfirmation = true
    }
    if (needsConfirmation && !hasCommandConfirmation(request, 'git_add_paths_confirmation')) return needsConfirmationResult(request, 'git_add_paths_confirmation')
    return runProcess(request, ['git', 'add', '--', ...paths], sourceRoot)
  }

  if (request.commandKind === 'git_commit') {
    const staged = getStagedPaths(sourceRoot)
    if (staged.length === 0) throw new Error('git_commit requires staged changes')
    for (const relPath of staged) assertWriteAllowed(request.sourceId, sourceRoot, relPath, request.confirmedByUser, request.confirmationToken)
    const message = typeof request.message === 'string' ? request.message.trim() : ''
    const body = typeof request.body === 'string' ? request.body.trim() : ''
    if (!message || /[\r\n]/.test(message) || message.length > 200) throw new Error('message must be a short single-line string')
    if (body && body.length > 2000) throw new Error('body is too long')
    assertNoSecretLikeText(message, 'message')
    if (body) assertNoSecretLikeText(body, 'body')
    if (!hasCommandConfirmation(request, 'git_commit_confirmation')) return needsConfirmationResult(request, 'git_commit_confirmation')
    return runAndAppendGitLog(request, ['git', 'commit', '-m', message, ...(body ? ['-m', body] : [])], sourceRoot)
  }

  if (request.commandKind === 'git_push') {
    const remote = typeof request.remote === 'string' && request.remote.trim() ? request.remote.trim() : 'origin'
    const branch = typeof request.branch === 'string' && request.branch.trim() ? request.branch.trim() : currentBranch(sourceRoot)
    if (!SAFE_REMOTE.test(remote)) throw new Error('remote must be a safe remote name')
    if (!SAFE_BRANCH.test(branch) || branch.startsWith('-') || branch.includes('..')) throw new Error('branch must be a safe branch name')
    if (!hasCommandConfirmation(request, 'git_push_confirmation')) return needsConfirmationResult(request, 'git_push_confirmation')
    return runProcess(request, ['git', 'push', remote, branch], sourceRoot)
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
