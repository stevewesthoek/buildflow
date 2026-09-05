import { spawn, type ChildProcessByStdio } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { redactCapabilityText } from '../../../mcp/dist/capability-runtime-enforcement.js'
import {
  admitCodexReadOnlyReview,
  CODEX_REVIEW_NO_MUTATION_AUTHORITY,
  type CodexReviewAdmissionInput,
  type CodexReviewAdmissionResult
} from './codex-review-contract'
import {
  CodexReviewBudgetTracker,
  type CodexReviewBudgetTrackerSnapshot,
  type CodexReviewExecutionBudget,
  type CodexReviewExecutionRecord,
  type CodexReviewExecutionStoreOptions,
  type CodexReviewExecutionStoreResult,
  type CodexReviewTerminalState,
  createCodexReviewExecutionRecord,
  completeCodexReviewExecutionRecord,
  isCodexReviewExecutionStorePathSafe,
  isCodexReviewExecutionBudget,
  reconcileCodexReviewExecutionRecord
} from './codex-review-budget'

/**
 * R20.2 is a process boundary, not a prompt instruction. The child sees a
 * broker-created projection of the exact R20.1 files and a broker-created
 * scratch directory. The real source root is never its cwd, argv, or env.
 *
 *   R20.1 admission ──> exact-file projection ──> sandbox-exec ──> fixed node fixture
 *          │                    │                     │                 │
 *          └─ source/HEAD       └─ read-only mode      └─ no network      └─ bounded output
 */

export const CODEX_REVIEW_SANDBOX_CONTRACT_VERSION = 'r20.2' as const
export const CODEX_REVIEW_SANDBOX_RUNTIME_ID = 'codex-review-process-sandbox' as const
export const CODEX_REVIEW_SANDBOX_EXECUTABLE = '/usr/bin/sandbox-exec' as const
export const CODEX_REVIEW_SANDBOX_MAX_CAPTURE_BYTES = 32 * 1024
export const CODEX_REVIEW_SANDBOX_DEFAULT_TIMEOUT_MS = 2_000
export const CODEX_REVIEW_SANDBOX_ALLOWED_ENVIRONMENT = Object.freeze([
  'CI',
  'HOME',
  'LANG',
  'LC_ALL',
  'NO_COLOR',
  'PATH',
  'TMPDIR',
  '__CF_USER_TEXT_ENCODING'
] as const)

export const CODEX_REVIEW_SANDBOX_FIXTURES = Object.freeze([
  'read',
  'outside-path',
  'traversal',
  'symlink-escape',
  'create-source-file',
  'overwrite-source-file',
  'append-source-file',
  'delete-source-file',
  'rename-source-file',
  'chmod-source-file',
  'lockfile-mutation',
  'git-index-mutation',
  'scratch-output',
  'environment',
  'credentials',
  'owner-home',
  'network',
  'arbitrary-executable',
  'shell',
  'sleep'
] as const)
export type CodexReviewSandboxFixture = typeof CODEX_REVIEW_SANDBOX_FIXTURES[number]

export const CODEX_REVIEW_BUDGET_FIXTURES = Object.freeze([
  'prompt-within',
  'output-bounded',
  'output-overflow',
  'usage-within',
  'usage-overflow',
  'time-within',
  'timeout',
  'cancel',
  'runtime-unavailable',
  'findings-valid'
] as const)
export type CodexReviewBudgetFixture = typeof CODEX_REVIEW_BUDGET_FIXTURES[number]

export type CodexReviewSandboxRequest = Readonly<{
  admission: CodexReviewAdmissionInput
  fixture: CodexReviewSandboxFixture
  signal?: AbortSignal
  timeoutMs?: number
}>

export type CodexReviewSandboxLifecycle = Readonly<{
  sandboxId: string
  executionId: string
  reviewId: string
  sourceId: string
  runId: string
  processGroupId?: number
  startedAt: string
  terminalAt: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  cancelled: boolean
}>

export type CodexReviewSandboxOutput = Readonly<{
  stdout: string
  stderr: string
  stdoutBytes: number
  stderrBytes: number
  truncated: boolean
}>

export type CodexReviewSandboxSuccess = Readonly<{
  ok: true
  lifecycle: CodexReviewSandboxLifecycle
  output: CodexReviewSandboxOutput
  projection: Readonly<{
    source: string
    files: readonly string[]
    writableArea: string
    cwd: string
  }>
  policy: Readonly<{
    writes: 'denied'
    sourceTreeOutput: 'denied'
    network: 'denied'
    credentials: 'not-forwarded'
    ownerHome: 'unavailable'
    executable: 'fixed-node-fixture'
    shell: 'denied'
  }>
  budgetSnapshot?: CodexReviewBudgetTrackerSnapshot
}>

export type CodexReviewSandboxFailure = Readonly<{
  ok: false
  code: string
  message: string
  launched: boolean
  lifecycle?: CodexReviewSandboxLifecycle
  output?: CodexReviewSandboxOutput
  budgetSnapshot?: CodexReviewBudgetTrackerSnapshot
}>

export type CodexReviewSandboxResult = CodexReviewSandboxSuccess | CodexReviewSandboxFailure

export type CodexReviewSandboxInputFacts = Readonly<{
  sourceRoot: string
  files: readonly string[]
  inputFiles: number
  inputBytes: number
  maxInputFileBytes: number
  contextBytes: number
}>

export type CodexReviewBudgetedSandboxRequest = Readonly<{
  admission: CodexReviewAdmissionInput
  budget: CodexReviewExecutionBudget
  executionId: string
  fixture: CodexReviewBudgetFixture
  prompt: string
  signal?: AbortSignal
  storeOptions?: CodexReviewExecutionStoreOptions
}>

export type CodexReviewBudgetedSandboxSuccess = Readonly<{
  ok: true
  execution: CodexReviewExecutionRecord
  budget: CodexReviewExecutionBudget
  budgetSnapshot: CodexReviewBudgetTrackerSnapshot
  lifecycle: CodexReviewSandboxLifecycle
  output: CodexReviewSandboxOutput
}>

export type CodexReviewBudgetedSandboxFailure = Readonly<{
  ok: false
  code: CodexReviewTerminalState | 'ADMISSION_DENIED' | 'SANDBOX_REQUEST_INVALID'
  message: string
  launched: boolean
  execution?: CodexReviewExecutionRecord
  budget?: CodexReviewExecutionBudget
  budgetSnapshot?: CodexReviewBudgetTrackerSnapshot
  lifecycle?: CodexReviewSandboxLifecycle
  output?: CodexReviewSandboxOutput
}>

export type CodexReviewBudgetedSandboxResult = CodexReviewBudgetedSandboxSuccess | CodexReviewBudgetedSandboxFailure

type SandboxChild = ChildProcessByStdio<Writable, Readable, Readable>
type RecordValue = Record<string, unknown>

function isRecord(value: unknown): value is RecordValue {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function onlyKeys(value: RecordValue, allowed: readonly string[]): boolean {
  const keys = new Set(allowed)
  return Object.keys(value).every(key => keys.has(key))
}

function failure(code: string, message: string, launched = false): CodexReviewSandboxFailure {
  return { ok: false, code, message: redactCapabilityText(message).slice(0, 1_000), launched }
}

function isFixture(value: unknown): value is CodexReviewSandboxFixture {
  return typeof value === 'string' && (CODEX_REVIEW_SANDBOX_FIXTURES as readonly string[]).includes(value)
}

function canonicalDirectory(value: string): string | undefined {
  try {
    const resolved = fs.realpathSync(value)
    return fs.statSync(resolved).isDirectory() ? resolved : undefined
  } catch {
    return undefined
  }
}

function safeProfilePath(value: string): boolean {
  return typeof value === 'string' && !/[\u0000-\u001f\u007f]/.test(value)
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function safeRelative(value: string): boolean {
  return value.length > 0 && value.length <= 500 && !path.isAbsolute(value) && !value.startsWith('~') && !value.includes('\0') && value.split(/[\\/]+/).every(item => item.length > 0 && item !== '.' && item !== '..')
}

function canonicalSourceFiles(admission: CodexReviewAdmissionResult, sourceRootInput: string): { sourceRoot: string; files: Array<{ relative: string; absolute: string }> } | CodexReviewSandboxFailure {
  const sourceRoot = canonicalDirectory(sourceRootInput)
  if (!sourceRoot) return failure('SOURCE_ROOT_UNAVAILABLE', 'The admitted source root is unavailable for sandbox preparation.')
  if (!safeProfilePath(sourceRoot)) return failure('SOURCE_ROOT_INVALID', 'The admitted source root contains unsupported control characters.')
  const files: Array<{ relative: string; absolute: string }> = []
  for (const relative of admission.request.scope.paths) {
    if (!safeRelative(relative)) return failure('PATH_SCOPE_INVALID', `The admitted path is not a safe exact relative path: ${relative}`)
    const absolute = path.resolve(sourceRoot, relative)
    if (!contained(sourceRoot, absolute)) return failure('PATH_SCOPE_ESCAPE', `The admitted path escapes the source root: ${relative}`)
    let stat: fs.Stats
    let real: string
    try {
      stat = fs.lstatSync(absolute)
      real = fs.realpathSync(absolute)
    } catch {
      return failure('PATH_NOT_FOUND', `The admitted path is unavailable: ${relative}`)
    }
    if (stat.isSymbolicLink()) return failure('SYMLINK_ESCAPE', `The admitted path is a symbolic link: ${relative}`)
    if (!stat.isFile() || !contained(sourceRoot, real)) return failure('PATH_NOT_REGULAR_FILE', `Only admitted regular files may enter the R20.2 projection: ${relative}`)
    files.push({ relative, absolute: real })
  }
  return { sourceRoot, files }
}

/** Measure the exact R20.1-approved projection without reading file contents. */
export function measureCodexReviewSandboxInput(admission: CodexReviewAdmissionResult, sourceRootInput: string): CodexReviewSandboxInputFacts | CodexReviewSandboxFailure {
  const sourceResult = canonicalSourceFiles(admission, sourceRootInput)
  if (!('files' in sourceResult)) return sourceResult
  let inputBytes = 0
  let maxInputFileBytes = 0
  for (const file of sourceResult.files) {
    try {
      const bytes = fs.statSync(file.absolute).size
      if (!Number.isSafeInteger(bytes) || bytes < 0 || inputBytes > Number.MAX_SAFE_INTEGER - bytes) return failure('INPUT_MEASUREMENT_FAILED', 'The exact approved input size could not be measured safely.')
      inputBytes += bytes
      maxInputFileBytes = Math.max(maxInputFileBytes, bytes)
    } catch {
      return failure('INPUT_MEASUREMENT_FAILED', 'The exact approved input size could not be measured safely.')
    }
  }
  return {
    sourceRoot: sourceResult.sourceRoot,
    files: sourceResult.files.map(file => file.relative),
    inputFiles: sourceResult.files.length,
    inputBytes,
    maxInputFileBytes,
    // R20.2 does not materialize context/evidence content; R20.1 references
    // remain metadata-only until a later slice defines bounded retrieval.
    contextBytes: 0
  }
}

function createRoot(): string | CodexReviewSandboxFailure {
  const tempRoot = canonicalDirectory(os.tmpdir()) || path.resolve(os.tmpdir())
  try {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(tempRoot, 'workbench-codex-review-r20-2-')))
    if (path.dirname(root) !== tempRoot) return failure('TEMP_ROOT_INVALID', 'The broker-owned sandbox root is not contained by the system temporary directory.')
    fs.chmodSync(root, 0o700)
    return root
  } catch {
    return failure('TEMP_ROOT_UNAVAILABLE', 'The broker-owned sandbox root could not be created.')
  }
}

function copyProjection(root: string, files: readonly { relative: string; absolute: string }[]): string | CodexReviewSandboxFailure {
  const projection = path.join(root, 'source')
  try {
    fs.mkdirSync(projection, { recursive: true, mode: 0o700 })
    for (const file of files) {
      const destination = path.resolve(projection, file.relative)
      if (!contained(projection, destination)) return failure('PROJECTION_ESCAPE', `The projection path escapes its broker root: ${file.relative}`)
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
      fs.copyFileSync(file.absolute, destination, fs.constants.COPYFILE_EXCL)
      fs.chmodSync(destination, 0o444)
    }
    const directories: string[] = []
    const visit = (current: string): void => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const absolute = path.join(current, entry.name)
        if (entry.isDirectory()) visit(absolute)
        if (entry.isDirectory()) directories.push(absolute)
      }
    }
    visit(projection)
    for (const directory of directories.sort((left, right) => right.length - left.length)) fs.chmodSync(directory, 0o555)
    fs.chmodSync(projection, 0o555)
    return projection
  } catch (error) {
    return failure('PROJECTION_FAILED', `The read-only source projection could not be created: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
}

function sbpl(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function buildSandboxProfile(input: Readonly<{ root: string; tempParent: string; sourceRoot: string; ownerHome: string; projection: string; output: string; home: string; temp: string; fixture: string; runtime: string }>): string {
  const runtimeDirectory = path.dirname(input.runtime)
  return [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow file-read*)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow ipc-posix-shm)',
    '(allow ipc-posix-sem)',
    '(deny process-exec)',
    `(allow process-exec (literal ${sbpl(input.runtime)}))`,
    `(deny file-read* (subpath ${sbpl(input.home)}))`,
    `(deny file-read* (subpath ${sbpl(input.ownerHome)}))`,
    `(deny file-read* (subpath ${sbpl(input.sourceRoot)}))`,
    `(deny file-read* (subpath ${sbpl(input.tempParent)}))`,
    `(deny file-read* (subpath ${sbpl(input.root)}))`,
    `(allow file-read-metadata (subpath ${sbpl(input.tempParent)}))`,
    `(allow file-read-metadata (subpath ${sbpl(input.root)}))`,
    `(allow file-read* (subpath ${sbpl(runtimeDirectory)}))`,
    `(allow file-read* (subpath ${sbpl(input.projection)}))`,
    `(allow file-read* (subpath ${sbpl(input.fixture)}))`,
    `(allow file-write* (subpath ${sbpl(input.output)}))`,
    `(allow file-write* (subpath ${sbpl(input.temp)}))`,
    '(allow file-write* (literal "/dev/null"))',
    '(deny network*)'
  ].join('\n')
}

function minimalEnvironment(root: string): NodeJS.ProcessEnv {
  return Object.freeze({
    PATH: '/usr/bin:/bin',
    HOME: path.join(root, 'home'),
    TMPDIR: path.join(root, 'tmp'),
    LANG: 'C',
    LC_ALL: 'C',
    CI: '1',
    NO_COLOR: '1',
    __CF_USER_TEXT_ENCODING: '0x1F5:0:0'
  })
}

function boundedAppend(parts: Buffer[], chunk: Buffer, state: { bytes: number; truncated: boolean }, maxBytes: number): boolean {
  const remaining = maxBytes - state.bytes
  if (remaining <= 0) {
    state.truncated = true
    return chunk.byteLength > 0
  }
  const bounded = chunk.subarray(0, remaining)
  parts.push(bounded)
  state.bytes += bounded.byteLength
  const overflowed = bounded.byteLength < chunk.byteLength
  if (overflowed) state.truncated = true
  return overflowed
}

function stopChild(child: SandboxChild, graceMs = 100): void {
  const signal = (name: NodeJS.Signals): void => {
    if (child.pid) {
      try {
        process.kill(-child.pid, name)
        return
      } catch { /* fall through to the direct child */ }
    }
    try { child.kill(name) } catch { /* child already exited */ }
  }
  signal('SIGTERM')
  const killTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signal('SIGKILL')
  }, graceMs)
  killTimer.unref?.()
}

function runChild(input: Readonly<{ root: string; tempParent: string; sourceRoot: string; ownerHome: string; projection: string; output: string; home: string; temp: string; fixture: string; runtime: string; payload: RecordValue; signal: AbortSignal; timeoutMs: number; tracker?: CodexReviewBudgetTracker; stdoutLimit?: number; stderrLimit?: number; cancellationGraceMs?: number }>): Promise<Readonly<{ result: CodexReviewSandboxOutput; exitCode: number | null; signal: NodeJS.Signals | null; processGroupId?: number; timedOut: boolean; cancelled: boolean; startedAt: string; terminalAt: string; budgetSnapshot?: CodexReviewBudgetTrackerSnapshot }>> {
  return new Promise(resolve => {
    const startedAt = new Date().toISOString()
    const profile = buildSandboxProfile(input)
    const child = spawn(CODEX_REVIEW_SANDBOX_EXECUTABLE, ['-p', profile, input.runtime, input.fixture, String(input.payload.operation)], {
      cwd: input.projection,
      env: minimalEnvironment(input.root),
      detached: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    }) as SandboxChild
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const stdoutState = { bytes: 0, truncated: false }
    const stderrState = { bytes: 0, truncated: false }
    let timedOut = false
    let cancelled = input.signal.aborted
    let settled = false
    let usageLineBuffer = ''
    const observeUsage = (chunk: Buffer): void => {
      if (!input.tracker) return
      usageLineBuffer += chunk.toString('utf8')
      const lines = usageLineBuffer.split('\n')
      usageLineBuffer = lines.pop() || ''
      for (const line of lines) {
        const match = /^__WORKBENCH_USAGE_UNITS__=(\d+)$/.exec(line.trim())
        if (!match) continue
        const units = Number(match[1])
        if (!Number.isSafeInteger(units) || units < 0 || !input.tracker.recordUsage(units)) stopChild(child, input.cancellationGraceMs)
      }
    }
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      if (input.tracker && !input.tracker.snapshot().terminalState) {
        if (exitCode === 0 && signal === null) input.tracker.succeed()
        else input.tracker.fail()
      }
      clearTimeout(timer)
      input.signal.removeEventListener('abort', onAbort)
      const budgetSnapshot = input.tracker?.snapshot()
      resolve({
        result: {
          stdout: redactCapabilityText(Buffer.concat(stdout).toString('utf8')),
          stderr: redactCapabilityText(Buffer.concat(stderr).toString('utf8')),
          stdoutBytes: stdoutState.bytes,
          stderrBytes: stderrState.bytes,
          truncated: stdoutState.truncated || stderrState.truncated
        },
        exitCode,
        signal,
        ...(child.pid ? { processGroupId: child.pid } : {}),
        timedOut,
        cancelled,
        startedAt,
        terminalAt: new Date().toISOString(),
        ...(budgetSnapshot ? { budgetSnapshot } : {})
      })
    }
    const onAbort = (): void => { cancelled = true; input.tracker?.cancel(); stopChild(child, input.cancellationGraceMs) }
    const timer = setTimeout(() => { timedOut = true; input.tracker?.timeout(); stopChild(child, input.cancellationGraceMs) }, input.timeoutMs)
    timer.unref?.()
    child.stdout.on('data', chunk => {
      const buffer = Buffer.from(chunk)
      observeUsage(buffer)
      const overflowed = boundedAppend(stdout, buffer, stdoutState, input.stdoutLimit ?? CODEX_REVIEW_SANDBOX_MAX_CAPTURE_BYTES)
      if (input.tracker && !input.tracker.recordStdout(buffer.byteLength)) stopChild(child, input.cancellationGraceMs)
      if (!input.tracker && overflowed) stopChild(child, input.cancellationGraceMs)
    })
    child.stderr.on('data', chunk => {
      const buffer = Buffer.from(chunk)
      const overflowed = boundedAppend(stderr, buffer, stderrState, input.stderrLimit ?? CODEX_REVIEW_SANDBOX_MAX_CAPTURE_BYTES)
      if (input.tracker && !input.tracker.recordStderr(buffer.byteLength)) stopChild(child, input.cancellationGraceMs)
      if (!input.tracker && overflowed) stopChild(child, input.cancellationGraceMs)
    })
    child.once('error', () => { input.tracker?.fail(); finish(null, null) })
    child.once('close', (exitCode, signal) => finish(exitCode, signal))
    if (input.signal.aborted) onAbort()
    else input.signal.addEventListener('abort', onAbort, { once: true })
    child.stdin.write(JSON.stringify(input.payload))
    child.stdin.end()
  })
}

function fixturePayload(fixture: CodexReviewSandboxFixture, root: string, projection: string, output: string, admission: CodexReviewAdmissionResult): RecordValue {
  const approvedPath = admission.request.scope.paths[0]
  const payload: RecordValue = {
    operation: fixture,
    approvedPath,
    ownerHome: os.homedir(),
    scratchPath: path.join(output, 'result.txt'),
    sourceProjection: projection,
    outputRoot: output,
    ownerCredentialCandidates: [path.join(os.homedir(), '.ssh'), path.join(os.homedir(), '.gitconfig'), path.join(os.homedir(), '.codex')]
  }
  if (fixture === 'symlink-escape') {
    const outside = path.join(root, 'outside')
    fs.mkdirSync(outside, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(outside, 'outside-secret.txt'), 'outside-fixture-content\n', { encoding: 'utf8', mode: 0o600 })
    fs.symlinkSync(path.join(outside, 'outside-secret.txt'), path.join(projection, 'escape-link'))
    payload.escapePath = path.join(projection, 'escape-link')
  }
  return payload
}

function requestShape(value: unknown): value is CodexReviewSandboxRequest {
  if (!isRecord(value) || !onlyKeys(value, ['admission', 'fixture', 'signal', 'timeoutMs']) || !isFixture(value.fixture) || !isRecord(value.admission)) return false
  if (value.signal !== undefined && (!isRecord(value.signal) || typeof value.signal.aborted !== 'boolean' || typeof value.signal.addEventListener !== 'function' || typeof value.signal.removeEventListener !== 'function')) return false
  if (value.timeoutMs !== undefined && (!Number.isInteger(value.timeoutMs) || Number(value.timeoutMs) < 1 || Number(value.timeoutMs) > 30_000)) return false
  return true
}

function validateAuthority(admission: CodexReviewAdmissionResult): CodexReviewSandboxFailure | undefined {
  if (admission.decision !== 'ALLOW' || admission.stopCondition !== 'structured_findings_required') return failure('ADMISSION_NOT_APPROVED', 'R20.1 must admit and approve the exact review before a child process may start.')
  if (JSON.stringify(admission.authority) !== JSON.stringify(CODEX_REVIEW_NO_MUTATION_AUTHORITY)) return failure('AUTHORITY_INVALID', 'R20.1 admission did not return the immutable no-mutation authority.')
  return undefined
}

async function runCodexReviewSandboxInternal(request: CodexReviewSandboxRequest, operation: string = request.fixture, tracker?: CodexReviewBudgetTracker, outputLimits?: Readonly<{ stdout: number; stderr: number; cancellationGraceMs?: number }>, payloadExtras?: Readonly<RecordValue>): Promise<CodexReviewSandboxResult> {
  if (!requestShape(request)) return failure('SANDBOX_REQUEST_INVALID', 'R20.2 accepts only an admitted R20.1 request, a fixed fixture identity, an optional signal, and a bounded timeout.')
  const admission = admitCodexReadOnlyReview(request.admission)
  if (!admission.ok) return failure('ADMISSION_DENIED', admission.message)
  const authorityFailure = validateAuthority(admission)
  if (authorityFailure) return authorityFailure
  try { fs.accessSync(CODEX_REVIEW_SANDBOX_EXECUTABLE, fs.constants.X_OK) } catch { return failure('SANDBOX_UNAVAILABLE', 'The supported macOS sandbox-exec boundary is unavailable; R20.2 fails closed.') }
  if (!process.versions.node.startsWith('20.')) return failure('RUNTIME_UNSUPPORTED', 'R20.2 requires the supported Node 20 Workbench runtime; it will not launch under another Node major.')
  let runtime: string
  try { runtime = fs.realpathSync(process.execPath) } catch { return failure('RUNTIME_UNAVAILABLE', 'The supported Workbench Node runtime is unavailable; R20.2 fails closed.') }
  const fixtureSource = path.resolve(__dirname, '../../../../scripts/r20.2-review-sandbox-fixture.mjs')
  const rootResult = createRoot()
  if (typeof rootResult !== 'string') return rootResult
  const root = rootResult
  const cleanup = (): void => { try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* cleanup is defense in depth */ } }
  try {
    const sourceResult = canonicalSourceFiles(admission, request.admission.source.sourceRoot)
    if (!('files' in sourceResult)) return sourceResult
    const projectionResult = copyProjection(root, sourceResult.files)
    if (typeof projectionResult !== 'string') return projectionResult
    const projection = projectionResult
    const output = path.join(root, 'output')
    const home = path.join(root, 'home')
    const temp = path.join(root, 'tmp')
    for (const directory of [output, home, temp]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (!fs.existsSync(fixtureSource) || fs.lstatSync(fixtureSource).isSymbolicLink()) return failure('FIXTURE_UNAVAILABLE', 'The fixed R20.2 deterministic fixture is unavailable or is a symbolic link.')
    const fixture = path.join(root, 'fixture.mjs')
    fs.copyFileSync(fixtureSource, fixture, fs.constants.COPYFILE_EXCL)
    fs.chmodSync(fixture, 0o555)
    if (request.fixture === 'symlink-escape') fs.chmodSync(projection, 0o700)
    const payload = { ...fixturePayload(request.fixture, root, projection, output, admission), ...(payloadExtras || {}) }
    payload.operation = operation
    if (request.fixture === 'symlink-escape') fs.chmodSync(projection, 0o555)
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    request.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const childResult = await runChild({ root, tempParent: path.dirname(root), sourceRoot: sourceResult.sourceRoot, ownerHome: os.homedir(), projection, output, home, temp, fixture, runtime, payload, signal: controller.signal, timeoutMs: request.timeoutMs ?? CODEX_REVIEW_SANDBOX_DEFAULT_TIMEOUT_MS, tracker, ...(outputLimits ? { stdoutLimit: outputLimits.stdout, stderrLimit: outputLimits.stderr, cancellationGraceMs: outputLimits.cancellationGraceMs } : {}) })
      const lifecycle: CodexReviewSandboxLifecycle = {
        sandboxId: `codex-sandbox-${crypto.randomUUID()}`,
        executionId: `codex-review-execution-${crypto.randomUUID()}`,
        reviewId: admission.request.reviewId,
        sourceId: admission.request.source.sourceId,
        runId: admission.request.run.runId,
        ...(childResult.processGroupId ? { processGroupId: childResult.processGroupId } : {}),
        startedAt: childResult.startedAt,
        terminalAt: childResult.terminalAt,
        exitCode: childResult.exitCode,
        signal: childResult.signal,
        timedOut: childResult.timedOut,
        cancelled: childResult.cancelled
      }
      if (tracker) {
        const budgetSnapshot = childResult.budgetSnapshot || tracker.snapshot()
        if (budgetSnapshot.terminalState !== 'SUCCESS') return { ok: false, code: budgetSnapshot.terminalState || 'EXECUTION_FAILED', message: `The bounded R20.3 review execution ended with ${budgetSnapshot.terminalState || 'EXECUTION_FAILED'}.`, launched: true, lifecycle, output: childResult.result, budgetSnapshot }
      }
      if (childResult.timedOut) return { ok: false, code: 'SANDBOX_TIMEOUT', message: 'The bounded R20.2 fixture exceeded its deterministic safety timeout.', launched: true, lifecycle }
      if (childResult.cancelled) return { ok: false, code: 'SANDBOX_CANCELLED', message: 'The R20.2 fixture was cancelled and its process group was terminated.', launched: true, lifecycle }
      return {
        ok: true,
        lifecycle,
        output: childResult.result,
        ...(childResult.budgetSnapshot ? { budgetSnapshot: childResult.budgetSnapshot } : {}),
        projection: { source: admission.request.source.sourceId, files: admission.request.scope.paths, writableArea: 'broker-owned-temporary-output', cwd: 'broker-owned-read-only-projection' },
        policy: { writes: 'denied', sourceTreeOutput: 'denied', network: 'denied', credentials: 'not-forwarded', ownerHome: 'unavailable', executable: 'fixed-node-fixture', shell: 'denied' }
      }
    } finally {
      request.signal?.removeEventListener('abort', onAbort)
    }
  } catch (error) {
    return failure('SANDBOX_START_FAILED', `R20.2 sandbox execution failed closed: ${error instanceof Error ? error.message : 'unknown error'}`, false)
  } finally {
    cleanup()
  }
}

export async function runCodexReviewSandbox(request: CodexReviewSandboxRequest): Promise<CodexReviewSandboxResult> {
  return runCodexReviewSandboxInternal(request)
}

function emptyBudgetConsumption(): CodexReviewBudgetTrackerSnapshot['consumed'] {
  return { modelRequests: 0, promptBytes: 0, inputFiles: 0, inputBytes: 0, maxInputFileBytes: 0, contextBytes: 0, stdoutBytes: 0, stderrBytes: 0, responseBytes: 0, artifactBytes: 0, wallClockMs: 0, usageUnits: 0 }
}

function budgetedRequestShape(value: unknown): value is CodexReviewBudgetedSandboxRequest {
  if (!isRecord(value) || !onlyKeys(value, ['admission', 'budget', 'executionId', 'fixture', 'prompt', 'signal', 'storeOptions']) || !isRecord(value.admission) || !isCodexReviewExecutionBudget(value.budget) || typeof value.executionId !== 'string' || !CODEX_REVIEW_BUDGET_FIXTURES.includes(value.fixture as CodexReviewBudgetFixture) || typeof value.prompt !== 'string') return false
  if (value.signal !== undefined && (!isRecord(value.signal) || typeof value.signal.aborted !== 'boolean' || typeof value.signal.addEventListener !== 'function' || typeof value.signal.removeEventListener !== 'function')) return false
  return value.storeOptions === undefined || isRecord(value.storeOptions)
}

function budgetEvidence(output?: CodexReviewSandboxOutput): CodexReviewExecutionRecord['evidence'] {
  return { stdoutBytes: output?.stdoutBytes || 0, stderrBytes: output?.stderrBytes || 0, responseBytes: 0, artifactBytes: 0, truncated: output?.truncated === true }
}

function budgetTerminalMessage(state: CodexReviewTerminalState): string {
  const messages: Record<CodexReviewTerminalState, string> = {
    SUCCESS: 'Codex review fixture completed within its finite execution budget.',
    REQUEST_BUDGET_EXCEEDED: 'The reviewer request count exceeded its finite budget.',
    PROMPT_BUDGET_EXCEEDED: 'The compiled reviewer prompt exceeded its finite byte budget.',
    INPUT_BUDGET_EXCEEDED: 'The exact admitted reviewer input exceeded its finite byte budget.',
    OUTPUT_BUDGET_EXCEEDED: 'Reviewer output exceeded its finite capture budget and was terminated.',
    TIMEOUT: 'The reviewer exceeded its finite wall-clock budget and was terminated.',
    CANCELLED: 'The reviewer was cancelled and its owned process group was terminated.',
    COST_BUDGET_EXCEEDED: 'Reviewer usage exceeded its finite canonical usage budget.',
    REVIEW_RUNTIME_UNAVAILABLE: 'The configured reviewer runtime was unavailable; no fallback was attempted.',
    EXECUTION_FAILED: 'The bounded reviewer execution failed before a successful terminal result.'
  }
  return messages[state]
}

export async function runCodexReviewSandboxWithBudget(request: CodexReviewBudgetedSandboxRequest): Promise<CodexReviewBudgetedSandboxResult> {
  if (!budgetedRequestShape(request)) return { ok: false, code: 'SANDBOX_REQUEST_INVALID', message: 'R20.3 accepts only a canonical finite budget, exact R20.1 admission, fixed fixture, prompt, execution identity, and optional cancellation signal.', launched: false }
  const budget = request.budget
  const admission = admitCodexReadOnlyReview(request.admission)
  if (!admission.ok) return { ok: false, code: 'ADMISSION_DENIED', message: admission.message, launched: false, budget, budgetSnapshot: { consumed: emptyBudgetConsumption(), terminalCount: 0 } }
  const authorityFailure = validateAuthority(admission)
  if (authorityFailure) return { ok: false, code: 'ADMISSION_DENIED', message: authorityFailure.message, launched: false, budget, budgetSnapshot: { consumed: emptyBudgetConsumption(), terminalCount: 0 } }
  const storeOptions = request.storeOptions || {}
  if (!isCodexReviewExecutionStorePathSafe(request.admission.source.sourceRoot, storeOptions)) return { ok: false, code: 'SANDBOX_REQUEST_INVALID', message: 'The R20.3 execution store must resolve outside the admitted source tree.', launched: false, budget, budgetSnapshot: { consumed: emptyBudgetConsumption(), terminalCount: 0 } }

  const tracker = new CodexReviewBudgetTracker(budget)
  const persistTerminal = (launched: boolean, output?: CodexReviewSandboxOutput, errorCode?: string): CodexReviewExecutionRecord | undefined => {
    const snapshot = tracker.snapshot()
    const created = createCodexReviewExecutionRecord({ executionId: request.executionId, reviewId: admission.request.reviewId, sourceId: admission.request.source.sourceId, runId: admission.request.run.runId, budget, launched, consumed: snapshot.consumed, evidence: budgetEvidence(output) }, storeOptions)
    if (!created.ok) return undefined
    const terminal = completeCodexReviewExecutionRecord(request.executionId, { terminalState: snapshot.terminalState || 'EXECUTION_FAILED', consumed: snapshot.consumed, evidence: budgetEvidence(output), ...(errorCode ? { errorCode } : {}) }, storeOptions)
    return terminal.ok ? terminal.record : undefined
  }
  const failBeforeLaunch = (state: CodexReviewTerminalState, errorCode?: string): CodexReviewBudgetedSandboxFailure => {
    tracker.tryTerminal(state)
    const snapshot = tracker.snapshot()
    const execution = persistTerminal(false, undefined, errorCode)
    return { ok: false, code: state, message: budgetTerminalMessage(state), launched: false, ...(execution ? { execution } : {}), budget, budgetSnapshot: snapshot }
  }

  if (request.signal?.aborted) return failBeforeLaunch('CANCELLED')
  if (!tracker.recordPrompt(Buffer.byteLength(request.prompt, 'utf8'))) return failBeforeLaunch(tracker.snapshot().terminalState || 'PROMPT_BUDGET_EXCEEDED')
  const inputFacts = measureCodexReviewSandboxInput(admission, request.admission.source.sourceRoot)
  if (!('inputFiles' in inputFacts)) return failBeforeLaunch('EXECUTION_FAILED', inputFacts.code)
  if (!tracker.recordInput(inputFacts)) return failBeforeLaunch(tracker.snapshot().terminalState || 'INPUT_BUDGET_EXCEEDED')
  if (request.fixture === 'runtime-unavailable') return failBeforeLaunch('REVIEW_RUNTIME_UNAVAILABLE')
  if (!tracker.reserveModelRequest()) return failBeforeLaunch(tracker.snapshot().terminalState || 'REQUEST_BUDGET_EXCEEDED')

  const created = createCodexReviewExecutionRecord({ executionId: request.executionId, reviewId: admission.request.reviewId, sourceId: admission.request.source.sourceId, runId: admission.request.run.runId, budget, launched: true, consumed: tracker.snapshot().consumed }, storeOptions)
  if (!created.ok) {
    tracker.fail()
    return { ok: false, code: 'EXECUTION_FAILED', message: 'The bounded review execution could not be persisted before launch.', launched: false, budget, budgetSnapshot: tracker.snapshot() }
  }
  const internalFixture: CodexReviewSandboxFixture = 'read'
  const result = await runCodexReviewSandboxInternal({ admission: request.admission, fixture: internalFixture, signal: request.signal, timeoutMs: budget.effective.maxWallClockMs }, request.fixture, tracker, { stdout: budget.effective.maxStdoutBytes, stderr: budget.effective.maxStderrBytes, cancellationGraceMs: budget.effective.cancellationGraceMs }, {
    sourceId: admission.request.source.sourceId,
    sourceRevision: admission.request.source.revision,
    reviewId: admission.request.reviewId,
    executionId: request.executionId
  })
  const snapshot = ('budgetSnapshot' in result && result.budgetSnapshot) || tracker.snapshot()
  let terminalState: CodexReviewTerminalState
  if (snapshot.terminalState) terminalState = snapshot.terminalState
  else if (result.ok) terminalState = 'SUCCESS'
  else {
    const resultCode = 'code' in result ? result.code : undefined
    terminalState = resultCode === 'RUNTIME_UNSUPPORTED' || resultCode === 'RUNTIME_UNAVAILABLE' ? 'REVIEW_RUNTIME_UNAVAILABLE' : 'EXECUTION_FAILED'
  }
  if (!snapshot.terminalState) tracker.tryTerminal(terminalState)
  const finalSnapshot = tracker.snapshot()
  const output = 'output' in result ? result.output : undefined
  const execution = completeCodexReviewExecutionRecord(request.executionId, { terminalState: finalSnapshot.terminalState || 'EXECUTION_FAILED', consumed: finalSnapshot.consumed, evidence: budgetEvidence(output), ...(terminalState !== 'SUCCESS' ? { errorCode: terminalState } : {}) }, storeOptions)
  if (!execution.ok) return { ok: false, code: 'EXECUTION_FAILED', message: 'The bounded review terminal outcome could not be persisted.', launched: true, budget, budgetSnapshot: finalSnapshot, lifecycle: 'lifecycle' in result ? result.lifecycle : undefined, ...(output ? { output } : {}) }
  if (finalSnapshot.terminalState !== 'SUCCESS' || !result.ok) return { ok: false, code: finalSnapshot.terminalState || 'EXECUTION_FAILED', message: budgetTerminalMessage(finalSnapshot.terminalState || 'EXECUTION_FAILED'), launched: true, execution: execution.record, budget, budgetSnapshot: finalSnapshot, lifecycle: 'lifecycle' in result ? result.lifecycle : undefined, ...(output ? { output } : {}) }
  return { ok: true, execution: execution.record, budget, budgetSnapshot: finalSnapshot, lifecycle: result.lifecycle, output: result.output }
}

export function reconcileCodexReviewExecution(executionId: string, options: CodexReviewExecutionStoreOptions = {}): CodexReviewExecutionStoreResult<CodexReviewExecutionRecord | undefined> {
  return reconcileCodexReviewExecutionRecord(executionId, options)
}

export function formatCodexReviewSandboxStatus(result: CodexReviewSandboxResult): string {
  if ('message' in result) return `Codex review sandbox:\nBLOCKED\nReason: ${result.message}`
  return [
    'Codex review sandbox:',
    'READY',
    `Source: ${result.projection.source}`,
    `Scope: ${result.projection.files.length} files`,
    'Writes: DENIED',
    'Network: DENIED',
    'Credentials: NOT FORWARDED',
    'Repository output: DENIED'
  ].join('\n')
}
