import { spawn, type ChildProcessByStdio } from 'node:child_process'
import fs from 'node:fs'
import type { Readable } from 'node:stream'
import {
  validateCliCapabilityManifest,
  type CapabilityManifestValidationIssue,
  type CliCapabilityArgumentTemplate,
  type CliCapabilityManifest
} from '@workbench/shared'
import { redactCapabilityText, type CapabilityAuthorizedExecutionContext } from './capability-runtime-enforcement.js'
import type { CapabilityJobHandler, CapabilityJobHandlerContext, CapabilityJobHandlerResult } from './capability-execution-coordinator.js'

/**
 * R18.2: the first executable capability mode. This module is intentionally
 * narrower than the declaration subtype: only fixed, read-only local tools
 * may cross the process boundary, and every argument is materialized from a
 * validated manifest plus the already-authorized runtime context.
 */

export const READ_ONLY_CLI_EXECUTABLES = ['rg'] as const
export type ReadOnlyCliExecutable = typeof READ_ONLY_CLI_EXECUTABLES[number]
export const READ_ONLY_CLI_MAX_ARGUMENT_BYTES = 8 * 1024
export const READ_ONLY_CLI_MAX_CAPTURE_BYTES = 256 * 1024
export const READ_ONLY_CLI_MAX_EVIDENCE_BYTES = 32 * 1024

export type ReadOnlyCliManifestValidationResult =
  | Readonly<{ ok: true; value: CliCapabilityManifest }>
  | Readonly<{ ok: false; issues: readonly CapabilityManifestValidationIssue[]; message: string }>

export type ReadOnlyCliProcessResult = Readonly<{
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  stdoutBytes: number
  stderrBytes: number
  truncated: boolean
  durationMs: number
}>

type RecordValue = Record<string, unknown>

function record(value: unknown): value is RecordValue {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function issue(pathValue: string, code: string, message: string): CapabilityManifestValidationIssue {
  return { path: pathValue, code, message }
}

function readOnlyMessage(issues: readonly CapabilityManifestValidationIssue[]): string {
  return `Read-only CLI capability manifest invalid: ${issues.slice(0, 12).map(item => `${item.path} ${item.message}`).join(' ')}`
}

function pathTemplates(argv: readonly CliCapabilityArgumentTemplate[]): Extract<CliCapabilityArgumentTemplate, { kind: 'path' }>[] {
  return argv.filter((item): item is Extract<CliCapabilityArgumentTemplate, { kind: 'path' }> => item.kind === 'path')
}

function inputTemplates(argv: readonly CliCapabilityArgumentTemplate[]): Extract<CliCapabilityArgumentTemplate, { kind: 'input' }>[] {
  return argv.filter((item): item is Extract<CliCapabilityArgumentTemplate, { kind: 'input' }> => item.kind === 'input')
}

export function validateReadOnlyCliCapabilityManifest(value: unknown): ReadOnlyCliManifestValidationResult {
  const base = validateCliCapabilityManifest(value)
  if (!base.ok) return { ok: false, issues: base.issues, message: base.message }

  const manifest = base.value
  const issues: CapabilityManifestValidationIssue[] = []
  if (manifest.writePolicy.mode !== 'none') issues.push(issue('writePolicy.mode', 'writes_not_allowed', 'must be none for the read-only CLI mode.'))
  if (manifest.networkPolicy.mode !== 'denied') issues.push(issue('networkPolicy.mode', 'network_not_allowed', 'must be denied for the read-only CLI mode.'))
  if (manifest.cli.shell !== false) issues.push(issue('cli.shell', 'shell_not_allowed', 'must be false for the read-only CLI mode.'))
  if (manifest.cli.environment.mode !== 'minimal' || manifest.cli.environment.inheritedKeys.length !== 0) issues.push(issue('cli.environment', 'ambient_environment', 'must use minimal environment with no inherited keys.'))
  if (!(READ_ONLY_CLI_EXECUTABLES as readonly string[]).includes(manifest.cli.executable.name)) issues.push(issue('cli.executable.name', 'executable_not_read_only', `must be one of: ${READ_ONLY_CLI_EXECUTABLES.join(', ')}.`))
  if (manifest.cwdPolicy.mode !== 'source-root') issues.push(issue('cwdPolicy.mode', 'cwd_not_read_only', 'must be source-root for the read-only CLI mode.'))

  const paths = pathTemplates(manifest.cli.argv)
  const inputs = inputTemplates(manifest.cli.argv)
  if (manifest.cli.executable.name === 'rg') {
    if (manifest.pathPolicy.mode !== 'source-relative' || manifest.pathPolicy.allowedRoots.length === 0 || manifest.pathPolicy.maxPaths !== 1) {
      issues.push(issue('pathPolicy', 'source_scope_required', 'rg read-only execution must declare exactly one bounded source-relative path scope.'))
    }
    if (paths.length !== 1) issues.push(issue('cli.argv', 'path_binding_required', 'rg read-only execution must bind exactly one declared source-relative path.'))
    if (inputs.length !== 1 || inputs[0]?.valueType !== 'string') issues.push(issue('cli.argv', 'pattern_binding_required', 'rg read-only execution must bind exactly one string pattern input.'))
  }
  return issues.length > 0 ? { ok: false, issues, message: readOnlyMessage(issues) } : { ok: true, value: manifest }
}

function inputValue(input: unknown, name: string): unknown {
  return record(input) ? input[name] : undefined
}

function boundedArgument(value: string, label: string): string {
  if (value.length === 0 || value.length > READ_ONLY_CLI_MAX_ARGUMENT_BYTES || value.includes('\0') || value.includes('\r') || value.includes('\n')) throw new Error(`${label} is empty, oversized, or contains control characters.`)
  return value
}

function materializeArgument(template: CliCapabilityArgumentTemplate, input: unknown, authorized: CapabilityAuthorizedExecutionContext, usedPaths: Set<string>): string {
  if (template.kind === 'literal') return boundedArgument(template.value, 'Declared CLI literal')
  const value = inputValue(input, template.input)
  if (template.kind === 'path') {
    if (typeof value !== 'string') throw new Error(`Declared path input '${template.input}' is unavailable.`)
    const binding = authorized.paths.find(item => item.requested === value && !usedPaths.has(item.relative))
    if (!binding) throw new Error(`Declared path input '${template.input}' was not authorized by the runtime path guard.`)
    usedPaths.add(binding.relative)
    return boundedArgument(binding.relative || '.', 'Authorized CLI path')
  }
  if (template.valueType === 'string') {
    if (typeof value !== 'string') throw new Error(`Declared string input '${template.input}' is unavailable.`)
    // The first R18.2 command is rg. Keep its user value in an argument
    // position that cannot become an option; future modes must add their own
    // command-specific validation before accepting other input types.
    if (value.startsWith('-')) throw new Error(`Declared input '${template.input}' may not begin with '-' in the read-only CLI mode.`)
    return boundedArgument(value, `Declared input '${template.input}'`)
  }
  if (template.valueType === 'number' || template.valueType === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Declared numeric input '${template.input}' is unavailable.`)
    return boundedArgument(String(value), `Declared input '${template.input}'`)
  }
  if (typeof value !== 'boolean') throw new Error(`Declared boolean input '${template.input}' is unavailable.`)
  return value ? 'true' : 'false'
}

function executableCandidates(name: ReadOnlyCliExecutable): readonly string[] {
  return ['/opt/homebrew/bin/rg', '/usr/local/bin/rg', '/usr/bin/rg']
}

function resolveExecutable(name: ReadOnlyCliExecutable): string {
  for (const candidate of executableCandidates(name)) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch { /* try the next fixed system location */ }
  }
  throw new Error(`The allowlisted read-only executable '${name}' is not installed in a supported system location.`)
}

const MINIMAL_CLI_ENV: NodeJS.ProcessEnv = Object.freeze({
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin',
  HOME: '/var/empty',
  CI: '1',
  NO_COLOR: '1',
  GH_PROMPT_DISABLED: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_LITERAL_PATHSPECS: '1',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null'
})

function appendBounded(parts: Buffer[], value: Buffer, state: { bytes: number; truncated: boolean }): void {
  if (state.bytes >= READ_ONLY_CLI_MAX_CAPTURE_BYTES) {
    state.truncated = true
    return
  }
  const remaining = READ_ONLY_CLI_MAX_CAPTURE_BYTES - state.bytes
  const chunk = value.subarray(0, remaining)
  parts.push(chunk)
  state.bytes += chunk.byteLength
  if (chunk.byteLength < value.byteLength) state.truncated = true
}

type ReadOnlyChild = ChildProcessByStdio<null, Readable, Readable>

function terminate(child: ReadOnlyChild): void {
  const signalProcess = (signal: NodeJS.Signals): void => {
    if (child.pid && process.platform !== 'win32') {
      try { process.kill(-child.pid, signal); return } catch { /* fall back to the direct child */ }
    }
    try { child.kill(signal) } catch { /* process already exited */ }
  }
  signalProcess('SIGTERM')
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signalProcess('SIGKILL')
  }, 100).unref?.()
}

function runReadOnlyProcess(executable: string, args: readonly string[], cwd: string, signal: AbortSignal): Promise<ReadOnlyCliProcessResult> {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now()
    let child: ReadOnlyChild
    try {
      child = spawn(executable, [...args], { cwd, shell: false, env: MINIMAL_CLI_ENV, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      reject(error)
      return
    }
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const stdoutState = { bytes: 0, truncated: false }
    const stderrState = { bytes: 0, truncated: false }
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = (): void => terminate(child)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', chunk => appendBounded(stdout, Buffer.from(chunk), stdoutState))
    child.stderr.on('data', chunk => appendBounded(stderr, Buffer.from(chunk), stderrState))
    child.once('error', error => finish(() => reject(error)))
    child.once('close', (exitCode, signalName) => finish(() => resolve({
      exitCode,
      signal: signalName,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      stdoutBytes: stdoutState.bytes,
      stderrBytes: stderrState.bytes,
      truncated: stdoutState.truncated || stderrState.truncated,
      durationMs: Math.max(0, performance.now() - startedAt)
    })))
  })
}

function materialize(manifest: CliCapabilityManifest, input: unknown, authorized: CapabilityAuthorizedExecutionContext): { executable: string; args: string[]; display: string } {
  const usedPaths = new Set<string>()
  const args = manifest.cli.argv.map(template => materializeArgument(template, input, authorized, usedPaths))
  const executable = resolveExecutable(manifest.cli.executable.name as ReadOnlyCliExecutable)
  return { executable, args, display: [manifest.cli.executable.name, ...args].join(' ') }
}

function failure(context: CapabilityJobHandlerContext, code: string, message: string, retryable = false): CapabilityJobHandlerResult {
  return {
    status: 'failed',
    resultRef: `workbench://capability-jobs/${context.job.jobId}/result`,
    evidenceRef: context.job.evidenceRef,
    failure: { code, message: redactCapabilityText(message).slice(0, 1_000), retryable }
  }
}

export function createReadOnlyCliCapabilityHandler(manifest: CliCapabilityManifest): CapabilityJobHandler {
  const validation = validateReadOnlyCliCapabilityManifest(manifest)
  if (!validation.ok) throw new Error(validation.message)
  return async context => {
    if (context.signal.aborted) return { status: 'cancelled', failure: { code: 'cancelled', message: 'Read-only CLI job was cancelled before process start.', retryable: false } }
    const cwd = context.authorized.cwd
    if (!cwd) return failure(context, 'runtime_context_missing', 'Read-only CLI execution requires an authorized source-root cwd.')
    let command: { executable: string; args: string[]; display: string }
    try { command = materialize(manifest, context.input, context.authorized) } catch (error) {
      return failure(context, 'cli_argument_rejected', error instanceof Error ? `Read-only CLI arguments were rejected: ${error.message}` : 'Read-only CLI arguments were rejected.')
    }
    context.reportStep(`running ${manifest.cli.executable.name}`)
    let result: ReadOnlyCliProcessResult
    try { result = await runReadOnlyProcess(command.executable, command.args, cwd, context.signal) } catch (error) {
      return failure(context, 'cli_process_failed', `Read-only CLI process could not start: ${error instanceof Error ? error.message : 'unknown process error'}.`, true)
    }
    if (context.signal.aborted) return { status: 'cancelled', failure: { code: 'cancelled', message: 'Read-only CLI job was cancelled.', retryable: false } }
    if (result.truncated) {
      return {
        status: 'succeeded',
        output: {
          stdout: redactCapabilityText(result.stdout.slice(0, READ_ONLY_CLI_MAX_EVIDENCE_BYTES)),
          exitCode: result.exitCode ?? 1,
          truncated: true,
          evidenceRef: context.job.evidenceRef,
          evidenceBytes: Math.min(result.stdoutBytes + result.stderrBytes, READ_ONLY_CLI_MAX_CAPTURE_BYTES),
          command: manifest.cli.executable.name,
          durationMs: Math.round(result.durationMs),
        },
        evidence: {
          content: redactCapabilityText(result.stdout.slice(0, READ_ONLY_CLI_MAX_EVIDENCE_BYTES)),
          byteLength: result.stdoutBytes + result.stderrBytes,
          truncated: result.stdoutBytes > READ_ONLY_CLI_MAX_EVIDENCE_BYTES || result.stderrBytes > 0,
          redactionState: 'redacted'
        }
      }
    }
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() ? ` ${redactCapabilityText(result.stderr).slice(0, 400)}` : ''
      return failure(context, 'cli_exit_nonzero', `Read-only CLI '${command.display}' exited with code ${String(result.exitCode)}.${detail}`)
    }
    const redactedStdout = redactCapabilityText(result.stdout)
    const evidence = Buffer.byteLength(redactedStdout, 'utf8') > manifest.outputLimits.maxInlineBytes
      ? {
        content: redactedStdout.slice(0, READ_ONLY_CLI_MAX_EVIDENCE_BYTES),
        byteLength: result.stdoutBytes + result.stderrBytes,
        truncated: result.stdoutBytes > READ_ONLY_CLI_MAX_EVIDENCE_BYTES || result.stderrBytes > 0,
        redactionState: 'redacted' as const
      }
      : undefined
    return {
      status: 'succeeded',
      output: {
        stdout: redactedStdout,
        exitCode: result.exitCode,
        ...(result.stderr ? { stderr: redactCapabilityText(result.stderr) } : {}),
        command: manifest.cli.executable.name,
        durationMs: Math.round(result.durationMs)
      },
      ...(evidence ? { evidence } : {})
    }
  }
}

export const readOnlyCliRuntimeContract = Object.freeze({
  executables: [...READ_ONLY_CLI_EXECUTABLES],
  shell: false,
  inheritedEnvironment: false,
  network: 'denied',
  writes: false,
  sourceScope: 'authorized-declared-paths',
  overflow: 'broker-evidence-reference'
})
