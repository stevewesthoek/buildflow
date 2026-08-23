import fs from 'fs'
import { createHash } from 'crypto'
import { spawn } from 'child_process'
import path from 'path'
import { normalizeRepoRelativePath } from './safe-access'
import type { SafeCommandRequest, SafeCommandResult } from './command-runner'

const N8N_EXPORT_WORKFLOW_ID = 'FwP5INe9qoo1OwGC'
const N8N_EXPORT_WRAPPER_PATH = 'tools/n8n-api.sh'
const N8N_EXPORT_ARTIFACT_PATH = 'operations/reports/artifacts/b1-0a-live-workflow-rollback.json'
const N8N_EXPORT_MAX_BYTES = 500_000

type Snapshot = Map<string, string>

export type N8nWorkflowExportDependencies = {
  hasCommandConfirmation: (request: SafeCommandRequest, reason: string) => boolean
  needsConfirmationResult: (request: SafeCommandRequest, reason: string) => SafeCommandResult
  resolveSafePath: (sourceRoot: string, relativePath: string) => string
  exactRealpathWithin: (sourceRoot: string, candidate: string, label: string) => string
  assertSafeRepoPath: (input: string, label: string) => string
  exactPathHash: (sourceRoot: string, relativePath: string) => string
  exactGitSnapshot: (sourceRoot: string) => Snapshot
  exactChangedPaths: (before: Snapshot, after: Snapshot) => string[]
  exactProtectedFilesystemSnapshot: (sourceRoot: string) => Snapshot
  exactProtectedChanges: (before: Snapshot, after: Snapshot) => string[]
}

function n8nCredentialValues(): string[] {
  const values = new Set<string>()
  for (const value of [process.env.N8N_API_KEY]) {
    if (typeof value === 'string' && value.length >= 8) values.add(value)
  }
  const home = process.env.HOME || ''
  const configPath = process.env.N8N_CONFIG_FILE || (home ? path.join(home, '.config/n8n/.env') : '')
  if (configPath && fs.existsSync(configPath) && fs.statSync(configPath).isFile()) {
    try {
      const config = fs.readFileSync(configPath, 'utf8')
      for (const line of config.split(/\r?\n/)) {
        const match = line.match(/^\s*(?:export\s+)?N8N_API_KEY\s*=\s*(.*)\s*$/)
        if (!match) continue
        const value = match[1].replace(/^['"]|['"]$/g, '')
        if (value.length >= 8) values.add(value)
      }
    } catch {
      // Credential sources remain private; execution failures are reported generically.
    }
  }
  return [...values]
}

function assertSafeN8nWorkflowPayload(raw: string): Record<string, unknown> {
  if (Buffer.byteLength(raw, 'utf8') > N8N_EXPORT_MAX_BYTES) throw new Error('n8n workflow export exceeds the bounded artifact size limit')
  for (const configuredValue of n8nCredentialValues()) {
    if (raw.includes(configuredValue)) throw new Error('n8n workflow export contained a configured credential value')
  }
  if (/\b(?:authorization|x-n8n-api-key)\b\s*[:=]/i.test(raw) || /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/i.test(raw)) {
    throw new Error('n8n workflow export contained authorization material')
  }
  if (/"(?:apiKey|accessToken|refreshToken|password|clientSecret|secret)"\s*:\s*"[^"\r\n]{4,}"/i.test(raw)) {
    throw new Error('n8n workflow export contained credential-like values')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('n8n workflow export returned malformed JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('n8n workflow export must be a JSON object')
  const workflow = parsed as Record<string, unknown>
  if (workflow.id !== N8N_EXPORT_WORKFLOW_ID) throw new Error('n8n workflow export returned the wrong workflow ID')
  return workflow
}

export async function runN8nWorkflowExportCapability(
  request: SafeCommandRequest,
  dependencies: N8nWorkflowExportDependencies
): Promise<SafeCommandResult> {
  const untrustedOverrides = request as SafeCommandRequest & {
    argv?: unknown
    shell?: unknown
    env?: unknown
    environment?: unknown
  }
  const reason = 'confirmation_required_for_brain_n8n_workflow_export'
  if (request.sourceId !== 'brain') throw new Error('n8n_workflow_export is limited to sourceId brain')
  if (request.workflowId !== N8N_EXPORT_WORKFLOW_ID) throw new Error('n8n_workflow_export only permits the approved workflow ID')
  if (request.outputPath !== N8N_EXPORT_ARTIFACT_PATH) throw new Error('n8n_workflow_export only permits the approved rollback artifact path')
  if (request.networkAccess !== true) throw new Error('n8n_workflow_export requires explicit networkAccess: true')
  if (request.executable !== undefined || request.args !== undefined || untrustedOverrides.argv !== undefined || untrustedOverrides.shell !== undefined || untrustedOverrides.env !== undefined || untrustedOverrides.environment !== undefined || request.packageDir !== undefined || request.scriptName !== undefined || request.marker !== undefined || request.message !== undefined || request.body !== undefined || request.remote !== undefined || request.branch !== undefined || request.paths !== undefined || request.nodeVersion !== undefined || request.policy !== undefined) {
    throw new Error('n8n_workflow_export does not accept executable, argv, shell, script, path, or environment overrides')
  }
  if (!dependencies.hasCommandConfirmation(request, reason)) return dependencies.needsConfirmationResult(request, reason)

  const sourceRoot = fs.realpathSync(path.resolve(request.sourceRoot))
  const wrapperPath = dependencies.resolveSafePath(sourceRoot, N8N_EXPORT_WRAPPER_PATH)
  if (!fs.existsSync(wrapperPath) || !fs.statSync(wrapperPath).isFile()) throw new Error('approved n8n wrapper was not found')
  dependencies.exactRealpathWithin(sourceRoot, wrapperPath, 'n8n wrapper')
  if ((fs.statSync(wrapperPath).mode & 0o111) === 0) throw new Error('approved n8n wrapper is not executable')
  const artifactPath = dependencies.resolveSafePath(sourceRoot, N8N_EXPORT_ARTIFACT_PATH)
  const timeoutMs = Math.min(30_000, Math.max(1_000, request.timeoutMs || 12_000))
  const protectedPaths = (request.protectedPaths || []).map(item => dependencies.assertSafeRepoPath(item, 'protectedPath'))
  const protectedBefore = new Map(protectedPaths.map(item => [item, dependencies.exactPathHash(sourceRoot, item)]))
  const before = dependencies.exactGitSnapshot(sourceRoot)
  const mandatoryProtectedBefore = dependencies.exactProtectedFilesystemSnapshot(sourceRoot)
  const startedAt = Date.now()
  const childEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || '',
    CI: '1',
    NO_COLOR: '1'
  }
  for (const key of ['N8N_CONFIG_FILE', 'N8N_API_URL', 'N8N_API_KEY'] as const) {
    if (process.env[key]) childEnv[key] = process.env[key]
  }

  const execution = await new Promise<{
    exitCode: number | null
    signal: NodeJS.Signals | null
    stdout: string
    stderr: string
    truncated: boolean
    timedOut: boolean
  }>((resolve, reject) => {
    const child = spawn(wrapperPath, ['get-workflow', N8N_EXPORT_WORKFLOW_ID], {
      cwd: sourceRoot,
      shell: false,
      detached: process.platform !== 'win32',
      env: childEnv
    })
    let stdout = ''
    let stderr = ''
    let bytes = 0
    let truncated = false
    let timedOut = false
    let killTimer: NodeJS.Timeout | undefined
    const signalChild = (signal: NodeJS.Signals) => {
      if (child.pid && process.platform !== 'win32') {
        try {
          process.kill(-child.pid, signal)
          return
        } catch {
          // Fall through to the direct child.
        }
      }
      child.kill(signal)
    }
    const timer = setTimeout(() => {
      timedOut = true
      signalChild('SIGTERM')
      killTimer = setTimeout(() => signalChild('SIGKILL'), 500)
    }, timeoutMs)
    const append = (current: string, chunk: Buffer) => {
      if (bytes >= N8N_EXPORT_MAX_BYTES) return current
      const remaining = N8N_EXPORT_MAX_BYTES - bytes
      const raw = chunk.toString('utf8')
      const value = Buffer.byteLength(raw, 'utf8') > remaining ? raw.slice(0, remaining) : raw
      bytes += Buffer.byteLength(value, 'utf8')
      if (value.length < raw.length) {
        truncated = true
        signalChild('SIGTERM')
      }
      return current + value
    }
    child.stdout.on('data', chunk => { stdout = append(stdout, Buffer.from(chunk)) })
    child.stderr.on('data', chunk => { stderr = append(stderr, Buffer.from(chunk)) })
    child.on('error', error => {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      reject(error)
    })
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      resolve({ exitCode, signal, stdout, stderr, truncated, timedOut })
    })
  })

  const durationMs = Date.now() - startedAt
  if (execution.timedOut) throw new Error('n8n workflow export timed out')
  if (execution.truncated) throw new Error('n8n workflow export exceeded the bounded output limit')
  if (execution.exitCode !== 0) throw new Error('n8n workflow export wrapper failed without exposing credential output')
  const workflow = assertSafeN8nWorkflowPayload(execution.stdout)
  const serialized = `${JSON.stringify(workflow, null, 2)}\n`
  if (Buffer.byteLength(serialized, 'utf8') > N8N_EXPORT_MAX_BYTES) throw new Error('validated n8n workflow artifact exceeds the bounded size limit')
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true })
  const priorArtifact = fs.existsSync(artifactPath) && fs.statSync(artifactPath).isFile()
    ? { content: fs.readFileSync(artifactPath), mode: fs.statSync(artifactPath).mode & 0o777 }
    : undefined
  const tempPath = `${artifactPath}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tempPath, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  fs.renameSync(tempPath, artifactPath)
  const artifactSha256 = createHash('sha256').update(serialized).digest('hex')

  const mandatoryProtectedAfter = dependencies.exactProtectedFilesystemSnapshot(sourceRoot)
  const changedPaths = dependencies.exactChangedPaths(before, dependencies.exactGitSnapshot(sourceRoot))
  const callerProtectedChanges = protectedPaths.filter(item => protectedBefore.get(item) !== dependencies.exactPathHash(sourceRoot, item))
  const mandatoryProtectedChanges = dependencies.exactProtectedChanges(mandatoryProtectedBefore, mandatoryProtectedAfter)
  const protectedPathsChanged = [...new Set([...callerProtectedChanges, ...mandatoryProtectedChanges])].sort()
  const unexpectedChanges = changedPaths.filter(item => normalizeRepoRelativePath(item) !== N8N_EXPORT_ARTIFACT_PATH)
  if (protectedPathsChanged.length > 0 || unexpectedChanges.length > 0) {
    try {
      if (priorArtifact) fs.writeFileSync(artifactPath, priorArtifact.content, { mode: priorArtifact.mode })
      else fs.rmSync(artifactPath, { force: true })
    } catch {
      // Best-effort rollback preserves the legacy behavior.
    }
    throw new Error(protectedPathsChanged.length > 0 ? 'protected path changed during n8n workflow export' : 'unexpected repository path changed during n8n workflow export')
  }

  const workflowVersion = typeof workflow.versionId === 'string' || typeof workflow.versionId === 'number'
    ? workflow.versionId
    : typeof workflow.version === 'string' || typeof workflow.version === 'number' ? workflow.version : undefined
  const workflowUpdatedAt = typeof workflow.updatedAt === 'string' ? workflow.updatedAt : undefined
  const metadata = {
    artifactPath: N8N_EXPORT_ARTIFACT_PATH,
    artifactSha256,
    workflowId: N8N_EXPORT_WORKFLOW_ID,
    workflowVersion,
    workflowUpdatedAt,
    exitCode: execution.exitCode,
    durationMs,
    networkWriteRequested: false,
    executable: N8N_EXPORT_WRAPPER_PATH,
    args: ['get-workflow', N8N_EXPORT_WORKFLOW_ID],
    shell: false
  }
  return {
    status: 'completed',
    commandKind: request.commandKind,
    command: [N8N_EXPORT_WRAPPER_PATH, 'get-workflow', N8N_EXPORT_WORKFLOW_ID],
    cwd: sourceRoot,
    executable: N8N_EXPORT_WRAPPER_PATH,
    args: ['get-workflow', N8N_EXPORT_WORKFLOW_ID],
    shell: false,
    resolvedRepositoryRoot: sourceRoot,
    filesChanged: changedPaths.length > 0,
    artifactPath: N8N_EXPORT_ARTIFACT_PATH,
    artifactSha256,
    workflowId: N8N_EXPORT_WORKFLOW_ID,
    workflowVersion,
    workflowUpdatedAt,
    networkWriteRequested: false,
    reason,
    exitCode: execution.exitCode,
    signal: execution.signal,
    stdout: JSON.stringify(metadata),
    stderr: '',
    outputTruncated: false,
    durationMs,
    changedPaths,
    protectedPathsChanged,
    riskLevel: 'high',
    requiresConfirmation: false,
    details: metadata
  }
}
