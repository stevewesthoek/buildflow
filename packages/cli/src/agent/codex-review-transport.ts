import { spawn, type ChildProcessByStdio } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { redactCapabilityText } from '../../../mcp/dist/capability-runtime-enforcement.js'
import {
  appendWorkbenchEvidence,
  type WorkbenchEvidenceStoreOptions
} from './workbench-evidence-store'
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
  type CodexReviewTerminalState,
  completeCodexReviewExecutionRecord,
  createCodexReviewExecutionRecord,
  getCodexReviewExecutionRecord,
  isCodexReviewExecutionStorePathSafe,
  isCodexReviewExecutionBudget
} from './codex-review-budget'
import {
  measureCodexReviewSandboxInput,
  type CodexReviewSandboxInputFacts,
  type CodexReviewSandboxLifecycle,
  type CodexReviewSandboxOutput
} from './codex-review-sandbox'

/**
 * R20.5 trusted transport. This is deliberately separate from R20.2: the
 * untrusted review projection keeps network and credentials denied, while
 * this broker invokes the owner-local Codex client with only the native auth
 * file available to the provider process. The caller cannot supply an
 * executable, argv, endpoint, environment, cwd, or credential.
 */
export const CODEX_REVIEW_TRANSPORT_CONTRACT_VERSION = 'r20.5' as const
export const CODEX_REVIEW_TRANSPORT_SANDBOX_EXECUTABLE = '/usr/bin/sandbox-exec' as const
export const CODEX_REVIEW_TRANSPORT_CODEX_EXECUTABLES = Object.freeze([
  '/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex'
] as const)
const CODEX_REVIEW_TRANSPORT_CODEX_SHELL_SNAPSHOT_HELPERS = Object.freeze([
  '/usr/bin/wc',
  '/usr/bin/tr',
  '/usr/bin/sed',
  '/usr/bin/awk'
] as const)
const CODEX_REVIEW_TRANSPORT_CODEX_RUNTIME_EXECUTABLES = Object.freeze([
  '/bin/zsh',
  ...CODEX_REVIEW_TRANSPORT_CODEX_SHELL_SNAPSHOT_HELPERS,
  ...CODEX_REVIEW_TRANSPORT_CODEX_EXECUTABLES
] as const)
export const CODEX_REVIEW_TRANSPORT_MAX_CAPTURE_BYTES = 32 * 1024
export const CODEX_REVIEW_TRANSPORT_DEFAULT_TIMEOUT_MS = 2_000
export const CODEX_REVIEW_TRANSPORT_REVIEW_PROMPT = 'Identify concrete correctness or security defects within only the supplied files. Return only the canonical structured findings envelope.' as const

export type CodexReviewTransportRequest = Readonly<{
  admission: CodexReviewAdmissionInput
  budget: CodexReviewExecutionBudget
  executionId: string
  /** Broker-built bounded task text; omitted requests retain the R20 findings prompt. */
  prompt?: string
  /** Broker-built strict response schema; omitted requests retain the R20 findings schema. */
  outputSchema?: RecordValue
  signal?: AbortSignal
  storeOptions?: CodexReviewExecutionStoreOptions
  evidenceOptions?: WorkbenchEvidenceStoreOptions
}>

export type CodexReviewTransportMetadata = Readonly<{
  contractVersion: typeof CODEX_REVIEW_TRANSPORT_CONTRACT_VERSION
  executable: string
  invocationMode: 'codex-exec-stdin-schema' | 'codex-exec-native-permission-profile-stdin-schema'
  invocationArgs: readonly string[]
  projectionRoot: string
  workingDirectory: string
  sourceRootAccessible: false
  gitAccessible: false
  projectMcpConfigVisible: false
  arbitraryArgvPossible: false
  arbitraryEndpointPossible: false
  network: 'trusted-provider-outbound' | 'denied-fixture'
  networkRestriction: 'host-outbound-not-domain-constrained' | 'native-command-network-denied' | 'denied-fixture'
  providerAuthentication: 'existing-owner-local-native-login' | 'none'
  credentialForwarded: false
  providerUsageTelemetry: 'unavailable'
  requestSchemaSha256?: string
  requestPromptSha256?: string
  requestPromptBytes?: number
}>

export type CodexReviewTransportSuccess = Readonly<{
  ok: true
  execution: CodexReviewExecutionRecord
  budget: CodexReviewExecutionBudget
  budgetSnapshot: CodexReviewBudgetTrackerSnapshot
  lifecycle: CodexReviewSandboxLifecycle
  output: CodexReviewSandboxOutput
  transport: CodexReviewTransportMetadata
}>

export type CodexReviewTransportFailure = Readonly<{
  ok: false
  code: CodexReviewTerminalState | 'ADMISSION_DENIED' | 'SANDBOX_REQUEST_INVALID'
  message: string
  launched: boolean
  execution?: CodexReviewExecutionRecord
  budget?: CodexReviewExecutionBudget
  budgetSnapshot?: CodexReviewBudgetTrackerSnapshot
  lifecycle?: CodexReviewSandboxLifecycle
  output?: CodexReviewSandboxOutput
  transport?: Partial<CodexReviewTransportMetadata>
  transportFailure?: 'CODEX_EXECUTABLE_UNAVAILABLE' | 'CODEX_AUTH_UNAVAILABLE' | 'CODEX_AUTH_FORWARDING_REQUIRED' | 'CODEX_PROVIDER_NETWORK_UNAVAILABLE' | 'CODEX_OUTPUT_INVALID'
}>

export type CodexReviewTransportResult = CodexReviewTransportSuccess | CodexReviewTransportFailure

type SandboxChild = ChildProcessByStdio<Writable, Readable, Readable>
type RecordValue = Record<string, unknown>
type BrokerWorkspace = Readonly<{
  root: string
  projection: string
  schema: string
  home: string
  temp: string
  sourceRoot: string
  sourceFiles: readonly { relative: string; absolute: string }[]
  cleanup: () => void
}>
type ProcessResult = Readonly<{
  output: CodexReviewSandboxOutput
  exitCode: number | null
  signal: NodeJS.Signals | null
  processGroupId?: number
  timedOut: boolean
  cancelled: boolean
  startedAt: string
  terminalAt: string
  budgetSnapshot: CodexReviewBudgetTrackerSnapshot
}>

function isRecord(value: unknown): value is RecordValue {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function safeRelative(value: string): boolean {
  return value.length > 0 && value.length <= 500 && !path.isAbsolute(value) && !value.startsWith('~') && !value.includes('\0') && value.split(/[\\/]+/).every(item => item.length > 0 && item !== '.' && item !== '..')
}

function safePath(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value)
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

function sbpl(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function transportFailure(code: CodexReviewTransportFailure['code'], message: string, budget?: CodexReviewExecutionBudget, transportFailureCode?: CodexReviewTransportFailure['transportFailure']): CodexReviewTransportFailure {
  return { ok: false, code, message: redactCapabilityText(message).slice(0, 1_000), launched: false, ...(budget ? { budget } : {}), ...(transportFailureCode ? { transportFailure: transportFailureCode } : {}) }
}

function emptyConsumption(): CodexReviewBudgetTrackerSnapshot['consumed'] {
  return { modelRequests: 0, promptBytes: 0, inputFiles: 0, inputBytes: 0, maxInputFileBytes: 0, contextBytes: 0, stdoutBytes: 0, stderrBytes: 0, responseBytes: 0, artifactBytes: 0, wallClockMs: 0, usageUnits: 0 }
}

function budgetEvidence(output?: CodexReviewSandboxOutput): CodexReviewExecutionRecord['evidence'] {
  return { stdoutBytes: output?.stdoutBytes || 0, stderrBytes: output?.stderrBytes || 0, responseBytes: 0, artifactBytes: 0, truncated: output?.truncated === true }
}

function terminalMessage(state: CodexReviewTerminalState): string {
  const messages: Record<CodexReviewTerminalState, string> = {
    SUCCESS: 'The trusted Codex transport completed within its finite review budget.',
    REQUEST_BUDGET_EXCEEDED: 'The trusted Codex transport exceeded its finite request budget.',
    PROMPT_BUDGET_EXCEEDED: 'The bounded Codex review request exceeded its prompt budget.',
    INPUT_BUDGET_EXCEEDED: 'The exact admitted Codex review input exceeded its input budget.',
    OUTPUT_BUDGET_EXCEEDED: 'Codex output exceeded its bounded capture budget and was terminated.',
    TIMEOUT: 'The trusted Codex transport exceeded its finite wall-clock budget and was terminated.',
    CANCELLED: 'The trusted Codex transport was cancelled and its process group was terminated.',
    COST_BUDGET_EXCEEDED: 'Authoritative Codex usage exceeded its finite cost budget.',
    REVIEW_RUNTIME_UNAVAILABLE: 'The trusted Codex runtime or native authentication was unavailable.',
    EXECUTION_FAILED: 'The trusted Codex transport failed before an acceptable terminal result.'
  }
  return messages[state]
}

function resolveCodexExecutable(): string | undefined {
  for (const candidate of CODEX_REVIEW_TRANSPORT_CODEX_EXECUTABLES) {
    try {
      const stat = fs.lstatSync(candidate)
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) continue
      if (fs.realpathSync(candidate) !== candidate) continue
      return candidate
    } catch { /* try the next fixed allowlisted path */ }
  }
  return undefined
}

function ownerCodexHome(): string {
  const expected = path.join(os.homedir(), '.codex')
  const configured = process.env.CODEX_HOME
  if (configured && path.resolve(configured) !== path.resolve(expected)) throw new Error('CODEX_HOME is not the owner-local native Codex home.')
  return expected
}

function validateOwnerAuth(codexHome: string): string | undefined {
  const authFile = path.join(codexHome, 'auth.json')
  try {
    const stat = fs.lstatSync(authFile)
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) return undefined
    return authFile
  } catch {
    return undefined
  }
}

function validateOwnerCodexTmp(codexHome: string): string | undefined {
  const codexTmp = path.join(codexHome, 'tmp')
  try {
    const stat = fs.lstatSync(codexTmp)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) return undefined
    if (fs.realpathSync(codexTmp) !== codexTmp) return undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined
  }
  return codexTmp
}

function validateOwnerCodexShellSnapshots(codexHome: string): string | undefined {
  const shellSnapshots = path.join(codexHome, 'shell_snapshots')
  try {
    const stat = fs.lstatSync(shellSnapshots)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) return undefined
    if (fs.realpathSync(shellSnapshots) !== shellSnapshots) return undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined
  }
  return shellSnapshots
}

function validateCodexShellSnapshotHelpers(): boolean {
  return CODEX_REVIEW_TRANSPORT_CODEX_SHELL_SNAPSHOT_HELPERS.every(helper => {
    try {
      const stat = fs.lstatSync(helper)
      return stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o111) !== 0 && fs.realpathSync(helper) === helper
    } catch {
      return false
    }
  })
}

function canonicalSourceFiles(admission: CodexReviewAdmissionResult, admittedSourceRoot: string): { sourceRoot: string; files: Array<{ relative: string; absolute: string }> } | CodexReviewTransportFailure {
  let sourceRoot: string
  try {
    sourceRoot = fs.realpathSync(admittedSourceRoot)
    if (!fs.statSync(sourceRoot).isDirectory() || !safePath(sourceRoot)) return transportFailure('SANDBOX_REQUEST_INVALID', 'The admitted source root is not a safe directory.')
  } catch {
    return transportFailure('SANDBOX_REQUEST_INVALID', 'The admitted source root is unavailable.')
  }
  const files: Array<{ relative: string; absolute: string }> = []
  for (const relative of admission.request.scope.paths) {
    if (!safeRelative(relative)) return transportFailure('SANDBOX_REQUEST_INVALID', `The admitted path is not a safe exact relative path: ${relative}`)
    const candidate = path.resolve(sourceRoot, relative)
    if (!contained(sourceRoot, candidate)) return transportFailure('SANDBOX_REQUEST_INVALID', `The admitted path escapes its source root: ${relative}`)
    try {
      const stat = fs.lstatSync(candidate)
      const real = fs.realpathSync(candidate)
      if (stat.isSymbolicLink() || !stat.isFile() || !contained(sourceRoot, real) || path.relative(sourceRoot, real).split(path.sep).join('/') !== relative) return transportFailure('SANDBOX_REQUEST_INVALID', `The admitted path is not a regular exact file: ${relative}`)
      files.push({ relative, absolute: real })
    } catch {
      return transportFailure('SANDBOX_REQUEST_INVALID', `The admitted path is unavailable: ${relative}`)
    }
  }
  return { sourceRoot, files }
}

function copyProjection(root: string, files: readonly { relative: string; absolute: string }[]): string | CodexReviewTransportFailure {
  const projection = path.join(root, 'projection')
  try {
    fs.mkdirSync(projection, { recursive: true, mode: 0o700 })
    for (const file of files) {
      const destination = path.resolve(projection, file.relative)
      if (!contained(projection, destination)) return transportFailure('SANDBOX_REQUEST_INVALID', `The projection path escapes the broker root: ${file.relative}`)
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
      fs.copyFileSync(file.absolute, destination, fs.constants.COPYFILE_EXCL)
      fs.chmodSync(destination, 0o444)
    }
    const directories: string[] = []
    const visit = (current: string): void => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const absolute = path.join(current, entry.name)
        if (entry.isDirectory()) { directories.push(absolute); visit(absolute) }
      }
    }
    visit(projection)
    for (const directory of directories.sort((left, right) => right.length - left.length)) fs.chmodSync(directory, 0o555)
    fs.chmodSync(projection, 0o555)
    return projection
  } catch (error) {
    return transportFailure('SANDBOX_REQUEST_INVALID', `The exact read-only projection could not be created: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
}

function createWorkspace(admission: CodexReviewAdmissionResult, admittedSourceRoot: string): BrokerWorkspace | CodexReviewTransportFailure {
  const source = canonicalSourceFiles(admission, admittedSourceRoot)
  if (!('files' in source)) return source
  let root: string
  try {
    const tempParent = fs.realpathSync(os.tmpdir())
    root = fs.realpathSync(fs.mkdtempSync(path.join(tempParent, 'workbench-codex-review-r20-5-')))
    if (path.dirname(root) !== tempParent) return transportFailure('SANDBOX_REQUEST_INVALID', 'The broker workspace escaped the system temporary directory.')
    fs.chmodSync(root, 0o700)
  } catch {
    return transportFailure('SANDBOX_REQUEST_INVALID', 'The broker workspace could not be created safely.')
  }
  const cleanup = (): void => { try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* cleanup is defense in depth */ } }
  try {
    const projection = copyProjection(root, source.files)
    if (typeof projection !== 'string') { cleanup(); return projection }
    const schema = path.join(root, 'findings-schema.json')
    const home = path.join(root, 'home')
    const temp = path.join(root, 'tmp')
    fs.mkdirSync(home, { recursive: true, mode: 0o700 })
    fs.mkdirSync(temp, { recursive: true, mode: 0o700 })
    return { root, projection, schema, home, temp, sourceRoot: source.sourceRoot, sourceFiles: source.files, cleanup }
  } catch (error) {
    cleanup()
    return transportFailure('SANDBOX_REQUEST_INVALID', `The broker workspace could not be prepared: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
}

export function buildCodexReviewOutputSchema(admission: CodexReviewAdmissionResult, executionId: string): RecordValue {
  const exactString = (value: string): RecordValue => ({ type: 'string', enum: [value] })
  const locationProperties: RecordValue = {
    sourceId: exactString(admission.request.source.sourceId),
    sourceRevision: exactString(admission.request.source.revision),
    path: { type: 'string', enum: [...admission.request.scope.paths] },
    startLine: { type: 'integer', minimum: 1, maximum: 1_000_000 },
    endLine: { type: 'integer', minimum: 1, maximum: 1_000_000 },
    startColumn: { type: ['integer', 'null'], minimum: 1, maximum: 10_000 },
    endColumn: { type: ['integer', 'null'], minimum: 1, maximum: 10_000 }
  }
  const finding = {
    type: 'object',
    additionalProperties: false,
    required: ['findingId', 'severity', 'category', 'location', 'evidenceRefs', 'explanation', 'confidence', 'status'],
    properties: {
      findingId: { type: 'string', pattern: '^finding-[a-f0-9]{32}$' },
      severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'informational'] },
      category: { type: 'string', enum: ['security', 'correctness', 'reliability', 'performance', 'maintainability', 'configuration', 'privacy', 'other'] },
      location: { type: 'object', additionalProperties: false, required: ['sourceId', 'sourceRevision', 'path', 'startLine', 'endLine', 'startColumn', 'endColumn'], properties: locationProperties },
      evidenceRefs: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', minLength: 5, maxLength: 164, pattern: '^evd-[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$' } },
      explanation: { type: 'string', minLength: 1, maxLength: 2_048 },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      status: { type: 'string', enum: ['open', 'acknowledged', 'dismissed', 'resolved'] }
    }
  }
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'sourceId', 'sourceRevision', 'reviewId', 'executionId', 'findings'],
    properties: {
      schemaVersion: { type: 'integer', enum: [1] },
      sourceId: exactString(admission.request.source.sourceId),
      sourceRevision: exactString(admission.request.source.revision),
      reviewId: exactString(admission.request.reviewId),
      executionId: exactString(executionId),
      findings: { type: 'array', maxItems: 32, items: finding }
    }
  }
}

export function serializeCodexReviewOutputSchema(schema: RecordValue): string {
  return `${JSON.stringify(schema, null, 2)}\n`
}

function sourceEvidenceId(executionId: string, relative: string): string {
  return `evd-r20-5-source-${sha256(`${executionId}\0${relative}`).slice(0, 32)}`
}

function seedSourceEvidence(admission: CodexReviewAdmissionResult, executionId: string, workspace: BrokerWorkspace, options: WorkbenchEvidenceStoreOptions): string[] | CodexReviewTransportFailure {
  const ids: string[] = []
  for (const file of workspace.sourceFiles) {
    try {
      const content = fs.readFileSync(path.join(workspace.projection, file.relative), 'utf8')
      const evidenceId = sourceEvidenceId(executionId, file.relative)
      const payload = JSON.stringify({ schemaVersion: 1, kind: 'codex_review_source_excerpt', sourceId: admission.request.source.sourceId, sourceRevision: admission.request.source.revision, reviewId: admission.request.reviewId, executionId, path: file.relative, startLine: 1, endLine: content.split('\n').length, content, contentSha256: sha256(content), redactionState: 'not_required' })
      const stored = appendWorkbenchEvidence({ kind: 'capability_result', owner: { sourceId: admission.request.source.sourceId, sessionId: admission.request.run.sessionId, runId: admission.request.run.runId, requestId: admission.request.reviewId, operationId: executionId }, content: payload, retentionClass: 'active_run', evidenceId }, options)
      if (stored.ok === false) return transportFailure('EXECUTION_FAILED', `The broker could not persist exact source evidence: ${stored.message}`)
      ids.push(evidenceId)
    } catch {
      return transportFailure('EXECUTION_FAILED', `The broker could not read the exact projected source file: ${file.relative}`)
    }
  }
  return ids
}

function reviewPrompt(admission: CodexReviewAdmissionResult, workspace: BrokerWorkspace, evidenceIds: readonly string[]): string | CodexReviewTransportFailure {
  try {
    const sections = workspace.sourceFiles.map((file, index) => {
      const content = fs.readFileSync(path.join(workspace.projection, file.relative), 'utf8')
      const evidenceId = evidenceIds[index]
      return `FILE ${file.relative}\nEVIDENCE_REF ${evidenceId}\nRANGE 1-${content.split('\n').length}\nBEGIN_FILE\n${content}\nEND_FILE`
    })
    return [
      CODEX_REVIEW_TRANSPORT_REVIEW_PROMPT,
      'This is one read-only review. Do not execute commands, use network, inspect a repository, or access any file beyond the supplied content.',
      'If there is no concrete defect in the supplied content, return findings as an empty array.',
      'If you report a finding, its location must use the complete file range shown for that file and its evidenceRefs must contain only that file’s supplied EVIDENCE_REF.',
      'Return exactly one JSON object matching the supplied output schema. Do not return Markdown, prose, tool traces, or additional fields.',
      `Source identity: ${admission.request.source.sourceId}`,
      `Source revision: ${admission.request.source.revision}`,
      `Review identity: ${admission.request.reviewId}`,
      `Review objective: ${admission.request.objective.summary}`,
      sections.join('\n\n')
    ].join('\n\n')
  } catch {
    return transportFailure('EXECUTION_FAILED', 'The bounded Codex review prompt could not be built from the projection.')
  }
}

function minimalTransportEnvironment(workspace: BrokerWorkspace, codexHome: string): NodeJS.ProcessEnv {
  return Object.freeze({
    // The fixed npm wrapper has a `/usr/bin/env node` shebang, so retain the
    // fixed Homebrew bin directory for executable lookup. Arg0 aliases are
    // scoped to CODEX_HOME/tmp by the profile; that directory is not writable.
    PATH: '/usr/bin:/bin:/opt/homebrew/bin',
    HOME: workspace.home,
    CODEX_HOME: codexHome,
    TMPDIR: workspace.temp,
    LANG: 'C',
    LC_ALL: 'C',
    CI: '1',
    NO_COLOR: '1',
    __CF_USER_TEXT_ENCODING: '0x1F5:0:0'
  })
}

function buildTransportProfile(input: Readonly<{ root: string; tempParent: string; sourceRoot: string; writableWorktree?: string; trustedGitMetadataPaths?: readonly string[]; ownerHome: string; projection: string; schema: string; home: string; temp: string; executable: string; executableDirectory: string; fixture?: string; authFile?: string; ownerCodexTmp?: string; ownerCodexShellSnapshots?: string; additionalExecutables?: readonly string[]; allowNetwork: boolean }>): string {
  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow ipc-posix-shm)',
    '(allow ipc-posix-sem)',
    // Node's native runtime consults several system locations (including
    // dyld, locale, and device metadata) that are not stable across macOS
    // versions. Allow system reads first, then deny the exact sensitive
    // roots and re-open only the broker projection/schema/temp paths.
    '(allow file-read*)',
    `(deny file-read* (subpath ${sbpl(input.home)}))`,
    `(deny file-read* (subpath ${sbpl(input.ownerHome)}))`,
    `(deny file-read* (subpath ${sbpl(input.sourceRoot)}))`,
    `(deny file-read* (subpath ${sbpl(input.tempParent)}))`,
    `(deny file-read* (subpath ${sbpl(input.root)}))`,
    `(allow file-read-metadata (subpath ${sbpl(input.tempParent)}))`,
    `(allow file-read-metadata (subpath ${sbpl(input.root)}))`,
    // Canonicalizing CODEX_HOME traverses the owner-home directory. Permit
    // metadata for that single directory only; owner-home data stays denied.
    `(allow file-read-metadata (literal ${sbpl(input.ownerHome)}))`,
    // The client receives an empty broker-owned HOME for ordinary state. Its
    // fixed native arg0 helper aliases are created below in the separately
    // reopened owner-local CODEX_HOME/tmp subtree.
    `(allow file-read* (subpath ${sbpl(input.home)}))`,
    `(allow file-write* (subpath ${sbpl(input.home)}))`,
    `(allow file-read* (subpath ${sbpl(input.executableDirectory)}))`,
    `(allow file-read* (subpath ${sbpl(input.projection)}))`,
    `(allow file-read* (literal ${sbpl(input.schema)}))`,
    `(allow file-read* (subpath ${sbpl(input.temp)}))`,
    `(allow file-write* (subpath ${sbpl(input.temp)}))`,
    `(allow file-write* (literal "/dev/null"))`,
    `(deny process-exec)`,
    `(allow process-exec (literal ${sbpl(input.executable)}))`
  ]
  if (input.writableWorktree) {
    lines.push(`(allow file-read* (subpath ${sbpl(input.writableWorktree)}))`)
    lines.push(`(allow file-write* (subpath ${sbpl(input.writableWorktree)}))`)
  }
  const trustedGitRoot = path.resolve(input.sourceRoot, '.git')
  const trustedMetadataPaths = (input.trustedGitMetadataPaths || []).filter(metadataPath => contained(trustedGitRoot, path.resolve(metadataPath)))
  if (trustedMetadataPaths.length > 0) {
    lines.push(`(allow file-read-metadata (literal ${sbpl(input.sourceRoot)}))`)
    for (const metadataPath of trustedMetadataPaths) {
      lines.push(`(allow file-read-metadata (literal ${sbpl(metadataPath)}))`)
      lines.push(`(allow file-read* (subpath ${sbpl(metadataPath)}))`)
    }
  }
  if (input.fixture) lines.push(`(allow file-read* (literal ${sbpl(input.fixture)}))`)
  if (input.authFile) {
    // The provider must resolve exactly one existing native auth file. Parent
    // metadata is narrowly reopened for path traversal; the owner home and
    // all sibling config/state remain denied. The installed client also needs
    // its non-secret arg0 helper directory under CODEX_HOME/tmp; reopen only
    // that fixed subtree, never the owner CODEX_HOME generally.
    const ownerCodexTmp = input.ownerCodexTmp || path.join(path.dirname(input.authFile), 'tmp')
    const ownerCodexArg0 = path.join(ownerCodexTmp, 'arg0')
    lines.push(`(allow file-read* (literal ${sbpl(ownerCodexTmp)}))`)
    lines.push(`(allow file-write* (literal ${sbpl(ownerCodexTmp)}))`)
    lines.push(`(allow file-read* (subpath ${sbpl(ownerCodexTmp)}))`)
    lines.push(`(allow file-write* (subpath ${sbpl(ownerCodexTmp)}))`)
    lines.push(`(allow process-exec (subpath ${sbpl(ownerCodexArg0)}))`)
    const ownerCodexShellSnapshots = input.ownerCodexShellSnapshots || path.join(path.dirname(input.authFile), 'shell_snapshots')
    lines.push(`(allow file-read* (literal ${sbpl(ownerCodexShellSnapshots)}))`)
    lines.push(`(allow file-write* (literal ${sbpl(ownerCodexShellSnapshots)}))`)
    lines.push(`(allow file-read* (subpath ${sbpl(ownerCodexShellSnapshots)}))`)
    lines.push(`(allow file-write* (subpath ${sbpl(ownerCodexShellSnapshots)}))`)
    lines.push(`(allow file-read-metadata (subpath ${sbpl(path.dirname(input.authFile))}))`)
    lines.push(`(allow file-read* (literal ${sbpl(input.authFile)}))`)
  }
  for (const executable of input.additionalExecutables || []) lines.push(`(allow process-exec (literal ${sbpl(executable)}))`)
  lines.push(input.allowNetwork ? '(allow network-outbound)' : '(deny network*)')
  return lines.join('\n')
}

function nativePermissionProfileArgs(projection: string): string[] {
  const filesystem = `{":root"="deny",":minimal"="read",${JSON.stringify(projection)}="read"}`
  const disabledFeatures = [
    'shell_tool', 'shell_snapshot', 'code_mode', 'code_mode_host', 'apps',
    'plugins', 'browser_use', 'browser_use_external',
    'browser_use_full_cdp_access', 'computer_use', 'image_generation',
    'view_image', 'multi_agent', 'workspace_dependencies', 'skill_search',
    'tool_suggest'
  ]
  return [
    '-c', 'default_permissions="exact-capsule"',
    '-c', `permissions.exact-capsule.filesystem=${filesystem}`,
    '-c', 'permissions.exact-capsule.network={enabled=false}',
    '-c', 'web_search="disabled"',
    ...disabledFeatures.flatMap(feature => ['-c', `features.${feature}=false`])
  ]
}

function boundedAppend(parts: Buffer[], chunk: Buffer, state: { bytes: number; truncated: boolean }, maxBytes: number): void {
  const remaining = maxBytes - state.bytes
  if (remaining <= 0) { state.truncated = chunk.byteLength > 0; return }
  const bounded = chunk.subarray(0, remaining)
  parts.push(bounded)
  state.bytes += bounded.byteLength
  if (bounded.byteLength < chunk.byteLength) state.truncated = true
}

function stopChild(child: SandboxChild, graceMs: number): void {
  const signal = (name: NodeJS.Signals): void => {
    if (child.pid) {
      try { process.kill(-child.pid, name); return } catch { /* fall through to direct child */ }
    }
    try { child.kill(name) } catch { /* child already exited */ }
  }
  signal('SIGTERM')
  const killTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signal('SIGKILL')
  }, graceMs)
  killTimer.unref?.()
}

function runProcess(input: Readonly<{ root: string; workingDirectory: string; tempParent: string; sourceRoot: string; writableWorktree?: string; trustedGitMetadataPaths?: readonly string[]; ownerHome: string; projection: string; schema: string; home: string; temp: string; executable: string; args: readonly string[]; fixture?: string; authFile?: string; ownerCodexTmp?: string; ownerCodexShellSnapshots?: string; additionalExecutables?: readonly string[]; environment: NodeJS.ProcessEnv; prompt: string; signal: AbortSignal; timeoutMs: number; tracker: CodexReviewBudgetTracker; stdoutLimit: number; stderrLimit: number; cancellationGraceMs: number; allowNetwork: boolean; nativePermissionProfile?: boolean }>): Promise<ProcessResult> {
  return new Promise(resolve => {
    const startedAt = new Date().toISOString()
    const profile = input.nativePermissionProfile ? undefined : buildTransportProfile({ root: input.root, tempParent: input.tempParent, sourceRoot: input.sourceRoot, ...(input.writableWorktree ? { writableWorktree: input.writableWorktree } : {}), ...(input.trustedGitMetadataPaths ? { trustedGitMetadataPaths: input.trustedGitMetadataPaths } : {}), ownerHome: input.ownerHome, projection: input.projection, schema: input.schema, home: input.home, temp: input.temp, executable: input.executable, executableDirectory: path.dirname(input.executable), ...(input.fixture ? { fixture: input.fixture } : {}), ...(input.authFile ? { authFile: input.authFile } : {}), ...(input.ownerCodexTmp ? { ownerCodexTmp: input.ownerCodexTmp } : {}), ...(input.ownerCodexShellSnapshots ? { ownerCodexShellSnapshots: input.ownerCodexShellSnapshots } : {}), ...(input.additionalExecutables ? { additionalExecutables: input.additionalExecutables } : {}), allowNetwork: input.allowNetwork })
    const command = profile ? [CODEX_REVIEW_TRANSPORT_SANDBOX_EXECUTABLE, '-p', profile, input.executable, ...input.args] : [input.executable, ...input.args]
    const child = spawn(command[0], command.slice(1), { cwd: input.workingDirectory, env: input.environment, detached: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }) as SandboxChild
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const stdoutState = { bytes: 0, truncated: false }
    const stderrState = { bytes: 0, truncated: false }
    let timedOut = false
    let cancelled = input.signal.aborted
    let settled = false
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      if (!input.tracker.snapshot().terminalState) {
        if (exitCode === 0 && signal === null && !stdoutState.truncated && !stderrState.truncated) input.tracker.succeed()
        else input.tracker.fail()
      }
      clearTimeout(timer)
      input.signal.removeEventListener('abort', onAbort)
      resolve({
        output: { stdout: redactCapabilityText(Buffer.concat(stdout).toString('utf8')), stderr: redactCapabilityText(Buffer.concat(stderr).toString('utf8')), stdoutBytes: stdoutState.bytes, stderrBytes: stderrState.bytes, truncated: stdoutState.truncated || stderrState.truncated },
        exitCode,
        signal,
        ...(child.pid ? { processGroupId: child.pid } : {}),
        timedOut,
        cancelled,
        startedAt,
        terminalAt: new Date().toISOString(),
        budgetSnapshot: input.tracker.snapshot()
      })
    }
    const onAbort = (): void => { cancelled = true; input.tracker.cancel(); stopChild(child, input.cancellationGraceMs) }
    const timer = setTimeout(() => { timedOut = true; input.tracker.timeout(); stopChild(child, input.cancellationGraceMs) }, input.timeoutMs)
    timer.unref?.()
    child.stdout.on('data', chunk => {
      const buffer = Buffer.from(chunk)
      boundedAppend(stdout, buffer, stdoutState, input.stdoutLimit)
      if (!input.tracker.recordStdout(buffer.byteLength)) stopChild(child, input.cancellationGraceMs)
    })
    child.stderr.on('data', chunk => {
      const buffer = Buffer.from(chunk)
      boundedAppend(stderr, buffer, stderrState, input.stderrLimit)
      if (!input.tracker.recordStderr(buffer.byteLength)) stopChild(child, input.cancellationGraceMs)
    })
    child.once('error', () => { input.tracker.fail(); finish(null, null) })
    child.once('close', (exitCode, signal) => finish(exitCode, signal))
    if (input.signal.aborted) onAbort()
    else input.signal.addEventListener('abort', onAbort, { once: true })
    child.stdin.write(input.prompt)
    child.stdin.end()
  })
}

function executionLifecycle(processResult: ProcessResult, admission: CodexReviewAdmissionResult, executionId: string): CodexReviewSandboxLifecycle {
  return {
    sandboxId: `codex-transport-sandbox-${crypto.randomUUID()}`,
    executionId,
    reviewId: admission.request.reviewId,
    sourceId: admission.request.source.sourceId,
    runId: admission.request.run.runId,
    ...(processResult.processGroupId ? { processGroupId: processResult.processGroupId } : {}),
    startedAt: processResult.startedAt,
    terminalAt: processResult.terminalAt,
    exitCode: processResult.exitCode,
    signal: processResult.signal,
    timedOut: processResult.timedOut,
    cancelled: processResult.cancelled
  }
}

/** Shared bounded process runner for trusted adapters with a broker-owned writable area. */
export type CodexBoundedProcessRequest = Parameters<typeof runProcess>[0]
export type CodexBoundedProcessResult = ProcessResult
export function runCodexBoundedProcess(input: CodexBoundedProcessRequest): Promise<CodexBoundedProcessResult> {
  return runProcess(input)
}

function requestIsValid(value: unknown): value is CodexReviewTransportRequest {
  if (!isRecord(value) || !Object.keys(value).every(key => ['admission', 'budget', 'executionId', 'prompt', 'outputSchema', 'signal', 'storeOptions', 'evidenceOptions'].includes(key)) || !isRecord(value.admission) || !isRecord(value.budget) || !isCodexReviewExecutionBudget(value.budget) || typeof value.executionId !== 'string' || value.executionId.length === 0 || value.executionId !== value.executionId.trim()) return false
  if (value.prompt !== undefined && (typeof value.prompt !== 'string' || value.prompt.length === 0 || Buffer.byteLength(value.prompt, 'utf8') > value.budget.effective.maxPromptBytes)) return false
  if (value.outputSchema !== undefined && (!isRecord(value.outputSchema) || Buffer.byteLength(JSON.stringify(value.outputSchema), 'utf8') > value.budget.effective.maxArtifactBytes)) return false
  if (value.signal !== undefined && (!isRecord(value.signal) || typeof value.signal.aborted !== 'boolean' || typeof value.signal.addEventListener !== 'function' || typeof value.signal.removeEventListener !== 'function')) return false
  return true
}

async function runTransport(request: CodexReviewTransportRequest, mode: 'codex' | 'codex-preflight' | 'fixture'): Promise<CodexReviewTransportResult> {
  if (!requestIsValid(request)) return transportFailure('SANDBOX_REQUEST_INVALID', 'R20.5 accepts only exact R20.1 admission, finite budget, execution identity, cancellation, and canonical stores.')
  const budget = request.budget
  const admission = admitCodexReadOnlyReview(request.admission)
  if (!admission.ok) return { ...transportFailure('ADMISSION_DENIED', admission.message, budget), budgetSnapshot: { consumed: emptyConsumption(), terminalCount: 0 } }
  if (admission.decision !== 'ALLOW' || admission.stopCondition !== 'structured_findings_required' || JSON.stringify(admission.authority) !== JSON.stringify(CODEX_REVIEW_NO_MUTATION_AUTHORITY)) return { ...transportFailure('ADMISSION_DENIED', 'R20.1 admission did not provide the exact immutable read-only authority.', budget), budgetSnapshot: { consumed: emptyConsumption(), terminalCount: 0 } }
  if (!isCodexReviewExecutionStorePathSafe(request.admission.source.sourceRoot, request.storeOptions)) return { ...transportFailure('SANDBOX_REQUEST_INVALID', 'The execution store must resolve outside the admitted source tree.', budget), budgetSnapshot: { consumed: emptyConsumption(), terminalCount: 0 } }
  const tracker = new CodexReviewBudgetTracker(budget)
  const persistTerminal = (launched: boolean, output?: CodexReviewSandboxOutput, errorCode?: string): CodexReviewExecutionRecord | undefined => {
    const created = createCodexReviewExecutionRecord({ executionId: request.executionId, reviewId: admission.request.reviewId, sourceId: admission.request.source.sourceId, runId: admission.request.run.runId, budget, launched, consumed: tracker.snapshot().consumed, evidence: budgetEvidence(output) }, request.storeOptions)
    if (!created.ok) return undefined
    const terminal = completeCodexReviewExecutionRecord(request.executionId, { terminalState: tracker.snapshot().terminalState || 'EXECUTION_FAILED', consumed: tracker.snapshot().consumed, evidence: budgetEvidence(output), ...(errorCode ? { errorCode } : {}) }, request.storeOptions)
    return terminal.ok ? terminal.record : undefined
  }
  const failBeforeLaunch = (state: CodexReviewTerminalState, message = terminalMessage(state), transportFailureCode?: CodexReviewTransportFailure['transportFailure']): CodexReviewTransportFailure => {
    tracker.tryTerminal(state)
    const execution = persistTerminal(false, undefined, transportFailureCode)
    return { ok: false, code: state, message, launched: false, ...(execution ? { execution } : {}), budget, budgetSnapshot: tracker.snapshot(), ...(transportFailureCode ? { transportFailure: transportFailureCode } : {}) }
  }
  if (request.signal?.aborted) return failBeforeLaunch('CANCELLED')
  const workspaceResult = createWorkspace(admission, request.admission.source.sourceRoot)
  if (!('root' in workspaceResult)) return failBeforeLaunch('EXECUTION_FAILED', workspaceResult.message)
  const workspace = workspaceResult
  try {
    const inputFacts = measureCodexReviewSandboxInput(admission, request.admission.source.sourceRoot)
    if (!('inputFiles' in inputFacts)) return failBeforeLaunch('EXECUTION_FAILED', inputFacts.message)
    if (!tracker.recordInput(inputFacts as CodexReviewSandboxInputFacts)) return failBeforeLaunch(tracker.snapshot().terminalState || 'INPUT_BUDGET_EXCEEDED')
    let prompt: string
    let executable: string
    let args: readonly string[]
    let environment: NodeJS.ProcessEnv
    let authFile: string | undefined
    let ownerCodexTmp: string | undefined
    let ownerCodexShellSnapshots: string | undefined
    let fixture: string | undefined
    let transport: Partial<CodexReviewTransportMetadata>
    if (mode === 'codex' || mode === 'codex-preflight') {
      executable = resolveCodexExecutable() || ''
      if (!executable) return failBeforeLaunch('REVIEW_RUNTIME_UNAVAILABLE', 'The fixed allowlisted Codex executable is unavailable.', 'CODEX_EXECUTABLE_UNAVAILABLE')
      if (!validateCodexShellSnapshotHelpers()) return failBeforeLaunch('REVIEW_RUNTIME_UNAVAILABLE', 'The fixed shell-snapshot helper dependency closure is unavailable or unsafe.', 'CODEX_EXECUTABLE_UNAVAILABLE')
      let codexHome: string
      try { codexHome = ownerCodexHome() } catch (error) { return failBeforeLaunch('REVIEW_RUNTIME_UNAVAILABLE', error instanceof Error ? error.message : 'The owner-local Codex home is invalid.', 'CODEX_AUTH_FORWARDING_REQUIRED') }
      authFile = validateOwnerAuth(codexHome)
      if (!authFile) return failBeforeLaunch('REVIEW_RUNTIME_UNAVAILABLE', 'The existing owner-local Codex authentication file is unavailable or unsafe.', 'CODEX_AUTH_UNAVAILABLE')
      ownerCodexTmp = validateOwnerCodexTmp(codexHome)
      if (!ownerCodexTmp) return failBeforeLaunch('REVIEW_RUNTIME_UNAVAILABLE', 'The existing owner-local Codex temporary state path is unavailable or unsafe.', 'CODEX_AUTH_FORWARDING_REQUIRED')
      ownerCodexShellSnapshots = validateOwnerCodexShellSnapshots(codexHome)
      if (!ownerCodexShellSnapshots) return failBeforeLaunch('REVIEW_RUNTIME_UNAVAILABLE', 'The existing owner-local Codex shell snapshot state path is unavailable or unsafe.', 'CODEX_AUTH_FORWARDING_REQUIRED')
      const evidence = seedSourceEvidence(admission, request.executionId, workspace, request.evidenceOptions || {})
      if (!Array.isArray(evidence)) return failBeforeLaunch('EXECUTION_FAILED', evidence.message)
      const builtPrompt = request.prompt || reviewPrompt(admission, workspace, evidence)
      if (typeof builtPrompt !== 'string') return failBeforeLaunch('EXECUTION_FAILED', builtPrompt.message)
      prompt = builtPrompt
      const schema = request.outputSchema || buildCodexReviewOutputSchema(admission, request.executionId)
      const serializedSchema = serializeCodexReviewOutputSchema(schema)
      fs.writeFileSync(workspace.schema, serializedSchema, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      const native = mode === 'codex'
      const innerSandboxMode = 'danger-full-access'
      args = ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', ...(native ? nativePermissionProfileArgs(workspace.projection) : ['-s', innerSandboxMode]), '--cd', native ? workspace.projection : workspace.root, '--output-schema', workspace.schema, '-']
      environment = minimalTransportEnvironment(workspace, codexHome)
      transport = { contractVersion: CODEX_REVIEW_TRANSPORT_CONTRACT_VERSION, executable, invocationMode: native ? 'codex-exec-native-permission-profile-stdin-schema' : 'codex-exec-stdin-schema', invocationArgs: args, projectionRoot: workspace.projection, workingDirectory: native ? workspace.projection : workspace.root, sourceRootAccessible: false, gitAccessible: false, projectMcpConfigVisible: false, arbitraryArgvPossible: false, arbitraryEndpointPossible: false, network: mode === 'codex-preflight' ? 'denied-fixture' : 'trusted-provider-outbound', networkRestriction: mode === 'codex-preflight' ? 'denied-fixture' : native ? 'native-command-network-denied' : 'host-outbound-not-domain-constrained', providerAuthentication: 'existing-owner-local-native-login', credentialForwarded: false, providerUsageTelemetry: 'unavailable', requestSchemaSha256: sha256(serializedSchema), requestPromptSha256: sha256(prompt), requestPromptBytes: Buffer.byteLength(prompt, 'utf8') }
    } else {
      const fixtureSource = path.resolve(__dirname, '../../../../scripts/r20.5-review-transport-fixture.mjs')
      if (!fs.existsSync(fixtureSource) || fs.lstatSync(fixtureSource).isSymbolicLink()) return failBeforeLaunch('REVIEW_RUNTIME_UNAVAILABLE', 'The fixed R20.5 transport fixture is unavailable.')
      fixture = path.join(workspace.temp, 'transport-fixture.mjs')
      fs.copyFileSync(fixtureSource, fixture, fs.constants.COPYFILE_EXCL)
      fs.chmodSync(fixture, 0o444)
      executable = fs.realpathSync(process.execPath)
      const payload = JSON.stringify({ sourceRoot: request.admission.source.sourceRoot, ownerHome: os.homedir(), projection: workspace.projection, approvedPath: admission.request.scope.paths[0], sourceTreeOutputPath: path.join(request.admission.source.sourceRoot, '.r20-5-transport-output'), gitPath: path.join(request.admission.source.sourceRoot, '.git'), projectMcpConfig: path.join(request.admission.source.sourceRoot, '.codex', 'config.toml'), ownerCodexConfig: path.join(os.homedir(), '.codex', 'config.toml'), ownerAuth: path.join(os.homedir(), '.codex', 'auth.json'), scratchPath: path.join(workspace.temp, 'fixture-output.txt') })
      prompt = payload
      args = [fixture]
      environment = Object.freeze({ PATH: '/usr/bin:/bin', HOME: workspace.home, TMPDIR: workspace.temp, LANG: 'C', LC_ALL: 'C', CI: '1', NO_COLOR: '1' })
      transport = { contractVersion: CODEX_REVIEW_TRANSPORT_CONTRACT_VERSION, executable, invocationMode: 'codex-exec-stdin-schema', invocationArgs: args, projectionRoot: workspace.projection, workingDirectory: workspace.root, sourceRootAccessible: false, gitAccessible: false, projectMcpConfigVisible: false, arbitraryArgvPossible: false, arbitraryEndpointPossible: false, network: 'denied-fixture', networkRestriction: 'denied-fixture', providerAuthentication: 'none', credentialForwarded: false, providerUsageTelemetry: 'unavailable' }
    }
    if (!tracker.recordPrompt(Buffer.byteLength(prompt, 'utf8'))) return failBeforeLaunch(tracker.snapshot().terminalState || 'PROMPT_BUDGET_EXCEEDED')
    if (!tracker.reserveModelRequest()) return failBeforeLaunch(tracker.snapshot().terminalState || 'REQUEST_BUDGET_EXCEEDED')
    const created = createCodexReviewExecutionRecord({ executionId: request.executionId, reviewId: admission.request.reviewId, sourceId: admission.request.source.sourceId, runId: admission.request.run.runId, budget, launched: true, consumed: tracker.snapshot().consumed }, request.storeOptions)
    if (!created.ok) { tracker.fail(); return { ok: false, code: 'EXECUTION_FAILED', message: 'The trusted Codex execution could not be persisted before launch.', launched: false, budget, budgetSnapshot: tracker.snapshot(), transportFailure: 'CODEX_PROVIDER_NETWORK_UNAVAILABLE' } }
    const processResult = await runProcess({ root: workspace.root, workingDirectory: mode === 'codex' ? workspace.projection : workspace.root, tempParent: path.dirname(workspace.root), sourceRoot: workspace.sourceRoot, ownerHome: os.homedir(), projection: workspace.projection, schema: workspace.schema, home: workspace.home, temp: workspace.temp, executable, args, ...(fixture ? { fixture } : {}), ...(authFile ? { authFile } : {}), ...(ownerCodexTmp ? { ownerCodexTmp } : {}), ...(ownerCodexShellSnapshots ? { ownerCodexShellSnapshots } : {}), ...(mode !== 'fixture' ? { additionalExecutables: CODEX_REVIEW_TRANSPORT_CODEX_RUNTIME_EXECUTABLES } : {}), environment, prompt, signal: request.signal || new AbortController().signal, timeoutMs: budget.effective.maxWallClockMs, tracker, stdoutLimit: budget.effective.maxStdoutBytes, stderrLimit: budget.effective.maxStderrBytes, cancellationGraceMs: budget.effective.cancellationGraceMs, allowNetwork: mode === 'codex', nativePermissionProfile: mode === 'codex' })
    const lifecycle = executionLifecycle(processResult, admission, request.executionId)
    const snapshot = processResult.budgetSnapshot
    const terminalState = snapshot.terminalState || (processResult.exitCode === 0 && processResult.signal === null ? 'SUCCESS' : 'EXECUTION_FAILED')
    const execution = completeCodexReviewExecutionRecord(request.executionId, { terminalState, consumed: snapshot.consumed, evidence: budgetEvidence(processResult.output), ...(terminalState !== 'SUCCESS' ? { errorCode: terminalState } : {}) }, request.storeOptions)
    if (!execution.ok) return { ok: false, code: 'EXECUTION_FAILED', message: 'The trusted Codex terminal outcome could not be persisted.', launched: true, budget, budgetSnapshot: snapshot, lifecycle, output: processResult.output, transport, transportFailure: 'CODEX_PROVIDER_NETWORK_UNAVAILABLE' }
    if (terminalState !== 'SUCCESS' || processResult.exitCode !== 0 || processResult.signal !== null) {
      const transportFailureCode = processResult.output.stderr.match(/auth|login|credential|unauthori[sz]ed|token/i) ? 'CODEX_AUTH_UNAVAILABLE' : processResult.output.stderr.match(/network|connect|dns|socket|internet/i) ? 'CODEX_PROVIDER_NETWORK_UNAVAILABLE' : processResult.output.stdout.match(/^\s*\{[\s\S]*\}\s*$/) ? undefined : 'CODEX_OUTPUT_INVALID'
      return { ok: false, code: terminalState, message: terminalMessage(terminalState), launched: true, execution: execution.record, budget, budgetSnapshot: snapshot, lifecycle, output: processResult.output, transport, ...(transportFailureCode ? { transportFailure: transportFailureCode } : {}) }
    }
    return { ok: true, execution: execution.record, budget, budgetSnapshot: snapshot, lifecycle, output: processResult.output, transport: transport as CodexReviewTransportMetadata }
  } catch (error) {
    return { ok: false, code: 'EXECUTION_FAILED', message: redactCapabilityText(error instanceof Error ? error.message : 'The trusted Codex transport failed closed.').slice(0, 1_000), launched: false, budget, budgetSnapshot: tracker.snapshot(), transportFailure: 'CODEX_OUTPUT_INVALID' }
  } finally {
    workspace.cleanup()
  }
}

export async function runCodexReviewWithTrustedTransport(request: CodexReviewTransportRequest): Promise<CodexReviewTransportResult> {
  return runTransport(request, 'codex')
}

/**
 * Runs the fixed native Codex bootstrap with the same profile and argv as the
 * trusted transport, but with all network denied. This is diagnostic-only:
 * it cannot dispatch a provider request and does not accept caller-selected
 * executable, profile, path, environment, or network authority.
 */
export async function runCodexNativeStartupPreflight(request: CodexReviewTransportRequest): Promise<CodexReviewTransportResult> {
  return runTransport(request, 'codex-preflight')
}

export async function runCodexReviewTransportFixture(request: CodexReviewTransportRequest): Promise<CodexReviewTransportResult> {
  return runTransport(request, 'fixture')
}

export function getCodexReviewTransportExecution(executionId: string, options: CodexReviewExecutionStoreOptions = {}) {
  return getCodexReviewExecutionRecord(executionId, options)
}
