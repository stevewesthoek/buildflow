import { execFileSync } from 'child_process'
import { getAgentJob } from './agent-jobs'
import { normalizeRepoRelativePath, validateWriteTarget, type WriteChangeType } from './safe-access'
import { normalizeLocalServerDeclaration, type LocalServerDeclaration } from './local-server-lifecycle'
import { parseValidationSelectionV1, type ValidationSelectionV1 } from '@workbench/shared'
import { validateCodexReviewRequirement, type CodexReviewRequirement } from './codex-review-contract'

export const WORKBENCH_PACKET_SCHEMA_VERSION = 1 as const

export type WorkbenchPacketStep = {
  type: Extract<WriteChangeType, 'create' | 'overwrite' | 'patch' | 'append' | 'delete_file' | 'move'>
  path: string
  to?: string
  content?: string
  find?: string
  replace?: string
}

export type WorkbenchPacketValidation = {
  commandKind: 'git_diff_check' | 'type_check_web' | 'type_check_cli' | 'validate_json_files' | 'security_scan_paths' | 'run_package_script' | 'run_package_test' | 'run_package_test_marker'
  timeoutMs?: number
  paths?: string[]
  packageDir?: string
  scriptName?: string
  marker?: string
  patternSet?: 'forbidden_runtime_execution' | 'forbidden_secret_material' | 'forbidden_upload_network' | 'forbidden_all_high_risk'
}

export type WorkbenchPacketCommitPolicy = {
  enabled: boolean
  message?: string
  body?: string
}

export type WorkbenchPacket = {
  version: typeof WORKBENCH_PACKET_SCHEMA_VERSION
  runId: string
  packetId: string
  idempotencyKey: string
  sourceId: string
  taskId: string
  planId?: string
  planDigest?: string
  goalSummary: string
  expectedHead: string
  steps: WorkbenchPacketStep[]
  capabilities?: string[]
  localServer?: LocalServerDeclaration
  validation?: WorkbenchPacketValidation[]
  validationSelection?: ValidationSelectionV1
  review?: CodexReviewRequirement
  commit?: WorkbenchPacketCommitPolicy
  createdAt: string
}

export type WorkbenchPacketPreflightResult = {
  status: 'accepted' | 'rejected'
  accepted: boolean
  packetId?: string
  runId?: string
  sourceId?: string
  currentHead?: string
  exactPaths?: string[]
  errors: Array<{ code: string; message: string; path?: string }>
}

const MAX_PACKET_STEPS = 5
const MAX_PACKET_VALIDATIONS = 3
const MAX_VALIDATION_TIMEOUT_MS = 300_000
const SAFE_ID = /^[A-Za-z0-9._:-]{8,160}$/
const SAFE_HEAD = /^[0-9a-f]{7,64}$/i

function getCurrentHead(sourceRoot: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: sourceRoot,
    encoding: 'utf8',
    timeout: 3000,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function reject(errors: WorkbenchPacketPreflightResult['errors'], packet?: Partial<WorkbenchPacket>, currentHead?: string, exactPaths?: string[]): WorkbenchPacketPreflightResult {
  return {
    status: 'rejected',
    accepted: false,
    packetId: packet?.packetId,
    runId: packet?.runId,
    sourceId: packet?.sourceId,
    currentHead,
    exactPaths,
    errors
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, stableValue(child)]))
}

export function preflightWorkbenchPacket(params: {
  packet: WorkbenchPacket
  sourceRoot: string
}): WorkbenchPacketPreflightResult {
  const { packet, sourceRoot } = params
  const errors: WorkbenchPacketPreflightResult['errors'] = []
  let parsedSelection: ValidationSelectionV1 | undefined

  if (!packet || typeof packet !== 'object') return reject([{ code: 'PACKET_REQUIRED', message: 'packet is required' }])
  if (packet.version !== WORKBENCH_PACKET_SCHEMA_VERSION) errors.push({ code: 'PACKET_VERSION_UNSUPPORTED', message: `packet version must be ${WORKBENCH_PACKET_SCHEMA_VERSION}` })
  if (!SAFE_ID.test(String(packet.packetId || ''))) errors.push({ code: 'PACKET_ID_INVALID', message: 'packetId must be 8-160 safe characters' })
  if (!SAFE_ID.test(String(packet.idempotencyKey || ''))) errors.push({ code: 'IDEMPOTENCY_KEY_INVALID', message: 'idempotencyKey must be 8-160 safe characters' })
  if (packet.idempotencyKey !== `${packet.runId}:${packet.packetId}`) errors.push({ code: 'IDEMPOTENCY_KEY_MISMATCH', message: 'idempotencyKey must equal runId:packetId' })
  if (packet.planId !== undefined && !SAFE_ID.test(String(packet.planId || ''))) errors.push({ code: 'PLAN_ID_INVALID', message: 'planId must be a bounded compiled-plan identity' })
  if (packet.planDigest !== undefined && !/^[0-9a-f]{64}$/i.test(String(packet.planDigest || ''))) errors.push({ code: 'PLAN_DIGEST_INVALID', message: 'planDigest must be a SHA-256 digest' })
  if (!SAFE_HEAD.test(String(packet.expectedHead || ''))) errors.push({ code: 'EXPECTED_HEAD_INVALID', message: 'expectedHead must be a Git commit hash' })
  if (!Array.isArray(packet.steps) || packet.steps.length < 1 || packet.steps.length > MAX_PACKET_STEPS) {
    errors.push({ code: 'PACKET_STEP_COUNT_INVALID', message: `packet must contain 1-${MAX_PACKET_STEPS} steps` })
  }
  if (packet.validation && (!Array.isArray(packet.validation) || packet.validation.length > MAX_PACKET_VALIDATIONS)) {
    errors.push({ code: 'PACKET_VALIDATION_COUNT_INVALID', message: `packet may contain at most ${MAX_PACKET_VALIDATIONS} validation commands` })
  }
  if (packet.validationSelection !== undefined) {
    try {
      const selection = parseValidationSelectionV1(packet.validationSelection)
      parsedSelection = selection
      if (selection.sourceId !== packet.sourceId || selection.runId !== packet.runId || selection.packetId !== packet.packetId || selection.taskId !== packet.taskId || selection.expectedHead !== packet.expectedHead) {
        errors.push({ code: 'PACKET_VALIDATION_SELECTION_IDENTITY_MISMATCH', message: 'validation selection must match packet source, run, packet, task, and expected HEAD' })
      }
      if (!packet.validation || packet.validation.length !== selection.selected.length) {
        errors.push({ code: 'PACKET_VALIDATION_SELECTION_COMMAND_MISMATCH', message: 'packet validation commands must equal the selected validation count' })
      }
    } catch (error) {
      errors.push({ code: 'PACKET_VALIDATION_SELECTION_INVALID', message: error instanceof Error ? error.message : 'validation selection is invalid' })
    }
  }
  if (packet.localServer !== undefined) {
    try {
      const declaration = normalizeLocalServerDeclaration(packet.localServer)
      if (declaration.networkScope !== 'loopback') errors.push({ code: 'PACKET_LOCAL_SERVER_NETWORK_SCOPE', message: 'Only loopback local-server declarations can execute in a packet.' })
      if (!packet.capabilities?.includes?.('server_start') && !packet.capabilities?.includes?.('server_lifecycle')) errors.push({ code: 'PACKET_LOCAL_SERVER_CAPABILITY_MISSING', message: 'A local-server declaration requires server_start or server_lifecycle capability.' })
    } catch (error) {
      errors.push({ code: 'PACKET_LOCAL_SERVER_INVALID', message: error instanceof Error ? error.message : 'local-server declaration is invalid' })
    }
  }
  for (const validation of Array.isArray(packet.validation) ? packet.validation : []) {
    if (validation.timeoutMs !== undefined && (!Number.isFinite(validation.timeoutMs) || validation.timeoutMs < 1_000 || validation.timeoutMs > MAX_VALIDATION_TIMEOUT_MS)) {
      errors.push({ code: 'PACKET_VALIDATION_TIMEOUT_INVALID', message: `validation timeout must be 1000-${MAX_VALIDATION_TIMEOUT_MS}ms` })
    }
    for (const validationPath of validation.paths || []) {
      if (!normalizeRepoRelativePath(validationPath)) errors.push({ code: 'PACKET_VALIDATION_PATH_INVALID', message: 'validation paths must be repo-relative', path: validationPath })
    }
  }
  if (packet.commit?.enabled) {
    const message = String(packet.commit.message || '').trim()
    if (!message || message.length > 200 || /[\r\n]/.test(message)) errors.push({ code: 'PACKET_COMMIT_MESSAGE_INVALID', message: 'commit message must be a short single-line string' })
    if (packet.commit.body && packet.commit.body.length > 2000) errors.push({ code: 'PACKET_COMMIT_BODY_INVALID', message: 'commit body must be at most 2000 characters' })
  }

  const run = getAgentJob(packet.runId)
  if (!run) errors.push({ code: 'RUN_NOT_FOUND', message: `Workbench run not found: ${packet.runId}` })
  if (run && run.sourceId !== packet.sourceId) errors.push({ code: 'RUN_SOURCE_MISMATCH', message: 'packet sourceId does not match its run' })
  if (run && ['completed', 'failed', 'cancelled'].includes(run.status)) errors.push({ code: 'RUN_TERMINAL', message: `run cannot accept packets while ${run.status}` })
  if (run && (run.status === 'blocked' || run.status === 'needs_confirmation' || run.status === 'paused')) errors.push({ code: 'RUN_NOT_EXECUTABLE', message: `run must be running before packet preflight; current status is ${run.status}` })
  if (run && run.completedPacketIds.includes(packet.packetId)) errors.push({ code: 'PACKET_ALREADY_COMPLETED', message: 'packetId was already completed' })
  if (run && run.activeTaskId && packet.taskId !== run.activeTaskId) errors.push({ code: 'TASK_MISMATCH', message: `packet taskId must match active task ${run.activeTaskId}` })
  if (run && packet.planId && packet.planId !== run.compiledPlan?.planId) errors.push({ code: 'PLAN_MISMATCH', message: 'packet planId does not match the run compiled plan' })
  if (run && packet.planDigest && packet.planDigest !== run.compiledPlan?.planDigest) errors.push({ code: 'PLAN_MISMATCH', message: 'packet planDigest does not match the run compiled plan' })
  if (run && packet.commit?.enabled && !run.autoCommit) errors.push({ code: 'PACKET_COMMIT_NOT_AUTHORIZED', message: 'packet commit requires the parent run autoCommit policy' })
  if (packet.review !== undefined) {
    if (!validateCodexReviewRequirement(packet.review)) errors.push({ code: 'PACKET_REVIEW_INVALID', message: 'Codex review requirement is invalid or has been altered.' })
    else if (packet.review.request.source.sourceId !== packet.sourceId || packet.review.request.run.runId !== packet.runId || (run?.compiledPlan?.run.sessionId !== undefined && packet.review.request.run.sessionId !== run.compiledPlan.run.sessionId) || packet.review.taskId !== packet.taskId || packet.review.packetId !== packet.packetId) {
      errors.push({ code: 'PACKET_REVIEW_IDENTITY_MISMATCH', message: 'Codex review requirement must match the packet source, run, session, task, and packet.' })
    }
  }

  let currentHead: string | undefined
  try {
    currentHead = getCurrentHead(sourceRoot)
    if (packet.expectedHead && currentHead !== packet.expectedHead) errors.push({ code: 'STALE_EXPECTED_HEAD', message: `expected HEAD ${packet.expectedHead} but repository is ${currentHead}` })
  } catch {
    errors.push({ code: 'GIT_HEAD_UNAVAILABLE', message: 'unable to resolve repository HEAD' })
  }

  const exactPaths: string[] = []
  const seenPaths = new Set<string>()
  for (const step of Array.isArray(packet.steps) ? packet.steps : []) {
    const normalizedPath = normalizeRepoRelativePath(step.path)
    if (!normalizedPath) {
      errors.push({ code: 'STEP_PATH_INVALID', message: 'step path must be repo-relative', path: step.path })
      continue
    }
    if (seenPaths.has(normalizedPath)) errors.push({ code: 'DUPLICATE_STEP_PATH', message: 'packet may reference each primary path only once', path: normalizedPath })
    seenPaths.add(normalizedPath)
    exactPaths.push(normalizedPath)

    if (step.type === 'patch' && (!step.find || typeof step.replace !== 'string')) {
      errors.push({ code: 'PATCH_FIELDS_REQUIRED', message: 'patch steps require find and replace', path: normalizedPath })
    }
    if (step.type === 'move' && !step.to) errors.push({ code: 'MOVE_TARGET_REQUIRED', message: 'move steps require to', path: normalizedPath })

    const validation = validateWriteTarget({
      sourceId: packet.sourceId,
      sourceRoot,
      requestedPath: normalizedPath,
      changeType: step.type,
      content: step.content ?? step.replace,
      toPath: step.to
    })
    if (validation.ok === false) {
      errors.push({ code: validation.error.code, message: validation.error.message, path: normalizedPath })
    }

    if (step.to) {
      const normalizedTarget = normalizeRepoRelativePath(step.to)
      if (!normalizedTarget) errors.push({ code: 'MOVE_TARGET_INVALID', message: 'move target must be repo-relative', path: step.to })
      else exactPaths.push(normalizedTarget)
    }
  }

  if (parsedSelection) {
    if (JSON.stringify([...parsedSelection.changedPaths].sort()) !== JSON.stringify([...new Set(exactPaths)].sort())) {
      errors.push({ code: 'PACKET_VALIDATION_SELECTION_PATH_MISMATCH', message: 'validation selection changedPaths must equal the packet exact path set' })
    }
    const selectedCommands = parsedSelection.selected.map(node => ({ ...node.command, timeoutMs: node.timeoutMs }))
    const packetCommands = Array.isArray(packet.validation) ? packet.validation : []
    if (JSON.stringify(stableValue(selectedCommands)) !== JSON.stringify(stableValue(packetCommands))) {
      errors.push({ code: 'PACKET_VALIDATION_SELECTION_COMMAND_MISMATCH', message: 'packet validation commands must match the typed selected validation nodes' })
    }
  }

  if (errors.length > 0) return reject(errors, packet, currentHead, Array.from(new Set(exactPaths)))

  return {
    status: 'accepted',
    accepted: true,
    packetId: packet.packetId,
    runId: packet.runId,
    sourceId: packet.sourceId,
    currentHead,
    exactPaths: Array.from(new Set(exactPaths)),
    errors: []
  }
}
