import crypto from 'node:crypto'
import { containsProtectedRepositoryContent, evaluateConnectedRepositoryPath, normalizeRepositoryRelativePath } from '@workbench/shared'
import {
  evaluateRoadmapEffectPolicy,
  normalizeRoadmapEffects,
  roadmapEffectBundleDigest,
  type RoadmapEffectApprovalState,
  type RoadmapEffectAuthority,
  type RoadmapEffectDecision,
  type RoadmapEffectPolicyResult
} from './roadmap-effect-policy'
import { normalizeLocalServerDeclaration, type LocalServerDeclaration } from './local-server-lifecycle'
import { selectSmallestMeaningfulValidation, selectionCommandToPacketValidation, type ValidationSelectionPacketValidation } from './workbench-validation-selector'
import { validationSelectionV1Schema, type ValidationSelectionV1 } from '@workbench/shared'
import {
  compileCodexReviewRequirement,
  normalizeCodexReviewDeclaration,
  type CodexReviewDeclaration,
  type CodexReviewRequirement
} from './codex-review-contract'

export const ROADMAP_TO_RUN_PLAN_SCHEMA_VERSION = 1 as const
export const ROADMAP_TO_RUN_COMPILER_VERSION = 'phase-19-slice-4' as const

const MAX_PHASES = 16
const MAX_TASKS = 64
const MAX_TASK_TEXT = 800
const MAX_PACKET_STEPS = 5
const MAX_PACKET_VALIDATIONS = 3
const MAX_PACKET_CONTENT = 12_000
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/
const SAFE_DIGEST = /^[0-9a-f]{64}$/i
const SAFE_HEAD = /^[0-9a-f]{7,64}$/i
const SAFE_CAPABILITY = /^[a-z0-9][a-z0-9._:-]{0,79}$/
const KNOWN_CAPABILITIES = new Set([
  'read_source_metadata', 'read_evidence_metadata',
  'create_file', 'patch_file', 'append_file', 'overwrite_file', 'move_file', 'delete_file',
  'git_diff_check', 'type_check_web', 'type_check_cli', 'validate_json_files', 'security_scan_paths',
  'run_package_script', 'run_package_test', 'run_package_test_marker',
  'git_status_short', 'git_diff', 'git_add_paths', 'git_commit',
  'install', 'lockfile_change', 'network_request', 'external_service', 'deployment',
  'server_start', 'server_lifecycle', 'protected_mutation'
])
const KNOWN_VALIDATIONS = new Set([
  'git_diff_check', 'type_check_web', 'type_check_cli', 'validate_json_files', 'security_scan_paths',
  'run_package_script', 'run_package_test', 'run_package_test_marker'
])

export type RoadmapTaskStatus = 'pending' | 'running' | 'completed' | 'blocked' | 'failed' | 'skipped'

export type RoadmapPacketStep = {
  type: 'create' | 'overwrite' | 'patch' | 'append' | 'delete_file' | 'move'
  path: string
  to?: string
  content?: string
  find?: string
  replace?: string
}

export type RoadmapPacketValidation = {
  commandKind: 'git_diff_check' | 'type_check_web' | 'type_check_cli' | 'validate_json_files' | 'security_scan_paths' | 'run_package_script' | 'run_package_test' | 'run_package_test_marker'
  timeoutMs?: number
  paths?: string[]
  packageDir?: string
  scriptName?: string
  marker?: string
  patternSet?: 'forbidden_runtime_execution' | 'forbidden_secret_material' | 'forbidden_upload_network' | 'forbidden_all_high_risk'
}

export type RoadmapPacketCommit = {
  enabled: boolean
  message?: string
  body?: string
}

export type RoadmapTaskPacketAuthority = {
  steps: RoadmapPacketStep[]
  validation?: RoadmapPacketValidation[]
  commit?: RoadmapPacketCommit
  localServer?: LocalServerDeclaration
  review?: CodexReviewDeclaration
}

export type RoadmapTaskAuthority = {
  id: string
  title: string
  status: RoadmapTaskStatus
  description: string
  acceptanceCriteria: string[]
  validation: string[]
  dependsOn?: string[]
  paths: string[]
  capabilities: string[]
  effects?: RoadmapEffectAuthority[]
  packet: RoadmapTaskPacketAuthority
}

export type RoadmapPhaseAuthority = {
  id: string
  title: string
  status: RoadmapTaskStatus
  tasks: RoadmapTaskAuthority[]
}

export type RoadmapAuthority = {
  sourceId: string
  revision: string
  digest: string
  phases: RoadmapPhaseAuthority[]
}

export type RoadmapRunAuthority = {
  runId: string
  sessionId: string
  sourceId: string
  status: 'queued' | 'running' | 'paused' | 'needs_confirmation' | 'blocked' | 'completed' | 'failed' | 'cancelled'
  activeTaskId?: string
  activePacketId?: string
  completedTaskIds?: string[]
  completedPacketIds?: string[]
  expectedHead?: string
  autoCommit?: boolean
}

export type RoadmapSessionAuthority = {
  sessionId: string
  status: 'active' | 'paused' | 'completed' | 'recovery_required'
  lockedSourceIds: string[]
}

export type RoadmapSourceAuthority = {
  sourceId: string
  enabled: boolean
  rootFingerprint?: string
}

export type Phase16IntersectionState = {
  allowedCapabilities: string[]
  deniedCapabilities?: string[]
  confirmationRequiredCapabilities?: string[]
  allowedPaths?: string[]
}

export type RoadmapPolicyGrantState = {
  identity: string
  autonomyLevel: number
  actorId?: string
  phase16Intersection: Phase16IntersectionState
  confirmation: {
    status: 'not_required' | 'satisfied' | 'required' | 'denied'
    capabilityIds?: string[]
    grantId?: string
  }
  effectApprovals?: RoadmapEffectApprovalState[]
}

export type RoadmapToRunCompilerInput = {
  source: RoadmapSourceAuthority
  roadmap: RoadmapAuthority
  taskId: string
  run: RoadmapRunAuthority
  session: RoadmapSessionAuthority
  repo: {
    currentHead: string
  }
  policy: RoadmapPolicyGrantState
}

export type CompiledRunGate = {
  kind: 'confirmation' | 'policy' | 'install' | 'external_service' | 'deployment' | 'generated_output' | 'server_lifecycle' | 'protected_mutation' | 'packet_definition'
  status: 'open' | 'denied'
  capability?: string
  effectType?: RoadmapEffectAuthority['kind']
  effectIdentity?: string
  decision?: RoadmapEffectDecision
  approvalBundleDigest?: string
  approvalReusable?: boolean
  humanExplanation?: string
  reasonCode: string
  message: string
}

export type CompiledRunEffect = Readonly<{
  effectType: RoadmapEffectAuthority['kind']
  effectIdentity: string
  decision: RoadmapEffectDecision
  approvalBundleDigest: string
  approvalReusable: boolean
  humanExplanation: string
}>

export type CompiledRunStop = 'stale_head' | 'ambiguous_authority' | 'failed_repair' | 'install' | 'external_service' | 'deployment' | 'generated_output' | 'confirmation' | 'protected_mutation'

export type CompiledRunTask = {
  phaseId: string
  taskId: string
  title: string
  status: RoadmapTaskStatus
  dependencies: string[]
  exactPaths: string[]
  capabilities: string[]
  acceptanceCriteria: string[]
  validation: string[]
  effects: CompiledRunEffect[]
  review?: CodexReviewRequirement
  localServer?: LocalServerDeclaration
  packetId?: string
  readiness: 'completed' | 'current' | 'queued' | 'awaiting_gate' | 'blocked'
  gates: CompiledRunGate[]
}

export type CompiledRunPacket = {
  packetId: string
  taskId: string
  sequence: number
  status: 'completed' | 'current' | 'queued' | 'awaiting_gate' | 'blocked'
  exactPaths: string[]
  capabilities: string[]
  validation: ValidationSelectionPacketValidation[]
  validationSelection: ValidationSelectionV1
  steps: RoadmapPacketStep[]
  localServer?: LocalServerDeclaration
  commit?: RoadmapPacketCommit
  effects: CompiledRunEffect[]
  review?: CodexReviewRequirement
  schedulerReady: boolean
  schedulerReason?: 'current_task' | 'not_current_task' | 'gate_open' | 'packet_definition_missing' | 'dependency_not_complete'
  gates: CompiledRunGate[]
}

export type CompiledRunPlan = {
  schemaVersion: typeof ROADMAP_TO_RUN_PLAN_SCHEMA_VERSION
  compilerVersion: typeof ROADMAP_TO_RUN_COMPILER_VERSION
  planId: string
  planDigest: string
  status: 'ready' | 'awaiting_gate' | 'blocked'
  source: {
    sourceId: string
    rootFingerprint?: string
  }
  authority: {
    roadmapRevision: string
    roadmapDigest: string
    selectedTaskId: string
  }
  run: {
    runId: string
    sessionId: string
  }
  startHead: string
  autonomy: {
    level: number
    policyIdentity: string
    grantDigest: string
  }
  tasks: CompiledRunTask[]
  packets: CompiledRunPacket[]
  order: string[]
  currentTaskId?: string
  currentPacketId?: string
  completedPacketIds: string[]
  remainingPacketIds: string[]
  gates: CompiledRunGate[]
  stops: CompiledRunStop[]
  evidence: {
    sourceId: string
    taskId: string
    roadmapRevision: string
    roadmapDigest: string
    compilerVersion: typeof ROADMAP_TO_RUN_COMPILER_VERSION
    planDigest: string
    packetCount: number
    schedulerReadyPacketCount: number
    gateKinds: string[]
    stopKinds: CompiledRunStop[]
  }
  humanProjection: {
    text: string
    bytes: number
  }
}

export type RoadmapToRunCompileFailureCode =
  | 'SOURCE_LOCK_MISMATCH'
  | 'SOURCE_DISABLED'
  | 'ROADMAP_INVALID'
  | 'ROADMAP_DIGEST_MISMATCH'
  | 'TASK_NOT_FOUND'
  | 'AMBIGUOUS_TASK'
  | 'TASK_ALREADY_TERMINAL'
  | 'TASK_ORDER_INVALID'
  | 'TASK_DEPENDENCY_UNSATISFIED'
  | 'RUN_NOT_EXECUTABLE'
  | 'SESSION_LOCK_MISMATCH'
  | 'STALE_HEAD'
  | 'ACTIVE_PACKET_CONFLICT'
  | 'POLICY_INVALID'
  | 'POLICY_DENIED'
  | 'EFFECT_INVALID'
  | 'PACKET_INVALID'
  | 'VALIDATION_SELECTION_INVALID'
  | 'VALIDATION_SELECTION_TOO_BROAD'
  | 'PROTECTED_CONTENT'

export type RoadmapToRunCompileResult =
  | { ok: true; plan: CompiledRunPlan }
  | { ok: false; code: RoadmapToRunCompileFailureCode; message: string; field?: string }

export type RoadmapToRunCompileFailure = Extract<RoadmapToRunCompileResult, { ok: false }>

type FlattenedTask = { phase: RoadmapPhaseAuthority; task: RoadmapTaskAuthority; index: number }

function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return 'null'
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalize(value)).digest('hex')
}

function semanticPlanFields(plan: Pick<CompiledRunPlan, 'schemaVersion' | 'compilerVersion' | 'status' | 'source' | 'authority' | 'run' | 'startHead' | 'autonomy' | 'tasks' | 'packets' | 'order' | 'currentTaskId' | 'currentPacketId' | 'completedPacketIds' | 'remainingPacketIds' | 'gates' | 'stops'>) {
  return {
    schemaVersion: plan.schemaVersion,
    compilerVersion: plan.compilerVersion,
    status: plan.status,
    source: plan.source,
    authority: plan.authority,
    run: plan.run,
    startHead: plan.startHead,
    autonomy: plan.autonomy,
    tasks: plan.tasks,
    packets: plan.packets,
    order: plan.order,
    currentTaskId: plan.currentTaskId,
    currentPacketId: plan.currentPacketId,
    completedPacketIds: plan.completedPacketIds,
    remainingPacketIds: plan.remainingPacketIds,
    gates: plan.gates,
    stops: plan.stops
  }
}

function text(value: unknown, limit = MAX_TASK_TEXT): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim()
  return normalized.length > limit ? `${normalized.slice(0, limit - 3)}...` : normalized
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right))
}

function invalid(message: string, field?: string): RoadmapToRunCompileResult {
  return { ok: false, code: 'ROADMAP_INVALID', message, ...(field ? { field } : {}) }
}

function normalizePath(value: string): string | undefined {
  if (evaluateConnectedRepositoryPath(value)) return undefined
  const normalized = normalizeRepositoryRelativePath(value)
  if (!normalized || normalized.includes('..')) return undefined
  return normalized
}

function normalizeTaskPacket(packet: RoadmapTaskPacketAuthority, taskPaths: string[], taskId: string): RoadmapTaskPacketAuthority | RoadmapToRunCompileResult {
  if (!packet || !Array.isArray(packet.steps) || packet.steps.length < 1 || packet.steps.length > MAX_PACKET_STEPS) return { ok: false, code: 'PACKET_INVALID', message: `Task ${taskId} packet must contain 1-${MAX_PACKET_STEPS} steps.`, field: `${taskId}.packet.steps` }
  if (!Array.isArray(packet.validation) || packet.validation.length < 1 || packet.validation.length > MAX_PACKET_VALIDATIONS) return { ok: false, code: 'PACKET_INVALID', message: `Task ${taskId} packet must declare 1-${MAX_PACKET_VALIDATIONS} validations.`, field: `${taskId}.packet.validation` }

  const allowedPaths = new Set(taskPaths)
  const steps = packet.steps.map((step, index) => {
    if (!['create', 'overwrite', 'patch', 'append', 'delete_file', 'move'].includes(step.type)) throw new Error(`unsupported packet step type at ${index}`)
    const normalizedPath = normalizePath(step.path)
    if (!normalizedPath) throw new Error(`invalid step path at ${index}`)
    if (!allowedPaths.has(normalizedPath)) throw new Error(`step path is outside task scope at ${index}`)
    if (step.type === 'move') {
      const normalizedTarget = normalizePath(String(step.to || ''))
      if (!normalizedTarget || !allowedPaths.has(normalizedTarget)) throw new Error(`move target is outside task scope at ${index}`)
    }
    const content = step.content ?? step.replace
    if (content !== undefined && (String(content).length > MAX_PACKET_CONTENT || containsProtectedRepositoryContent(String(content)))) throw new Error(`protected or oversized packet content at ${index}`)
    if (step.type === 'patch' && (!step.find || typeof step.replace !== 'string')) throw new Error(`patch fields are incomplete at ${index}`)
    return {
      type: step.type,
      path: normalizedPath,
      ...(step.to ? { to: normalizePath(step.to) } : {}),
      ...(step.content !== undefined ? { content: String(step.content) } : {}),
      ...(step.find !== undefined ? { find: String(step.find) } : {}),
      ...(step.replace !== undefined ? { replace: String(step.replace) } : {})
    }
  })

  const validation = (packet.validation || []).map((item, index) => {
    if (!item || typeof item.commandKind !== 'string') throw new Error(`validation ${index} is invalid`)
    if (!KNOWN_VALIDATIONS.has(item.commandKind)) throw new Error(`unsupported validation command at ${index}`)
    if (item.paths?.some(itemPath => !normalizePath(itemPath))) throw new Error(`validation ${index} contains an invalid path`)
    if (item.timeoutMs !== undefined && (!Number.isSafeInteger(item.timeoutMs) || item.timeoutMs < 1_000 || item.timeoutMs > 300_000)) throw new Error(`validation ${index} timeout is outside the bounded range`)
    return {
      commandKind: item.commandKind,
      ...(item.timeoutMs !== undefined ? { timeoutMs: item.timeoutMs } : {}),
      ...(item.paths ? { paths: uniqueSorted(item.paths.map(itemPath => normalizePath(itemPath)!)) } : {}),
      ...(item.packageDir ? { packageDir: text(item.packageDir, 160) } : {}),
      ...(item.scriptName ? { scriptName: text(item.scriptName, 160) } : {}),
      ...(item.marker ? { marker: text(item.marker, 160) } : {}),
      ...(item.patternSet ? { patternSet: item.patternSet } : {})
    }
  })

  if (packet.commit?.enabled) {
    const message = text(packet.commit.message, 200)
    if (!message || /[\r\n]/.test(message)) throw new Error('commit message is invalid')
    if (packet.commit.body && String(packet.commit.body).length > 2_000) throw new Error('commit body is too large')
  }

  const localServer = packet.localServer === undefined ? undefined : normalizeLocalServerDeclaration(packet.localServer)
  const review = packet.review === undefined ? undefined : normalizeCodexReviewDeclaration(packet.review, taskPaths)

  return {
    steps,
    ...(validation.length > 0 ? { validation } : {}),
    ...(localServer ? { localServer } : {}),
    ...(review ? { review } : {}),
    ...(packet.commit ? {
      commit: {
        enabled: packet.commit.enabled === true,
        ...(packet.commit.message ? { message: text(packet.commit.message, 200) } : {}),
        ...(packet.commit.body ? { body: text(packet.commit.body, 2_000) } : {})
      }
    } : {})
  }
}

function normalizeRoadmap(roadmap: RoadmapAuthority): { roadmap?: RoadmapAuthority; flattened?: FlattenedTask[]; failure?: RoadmapToRunCompileResult } {
  if (!roadmap || typeof roadmap !== 'object' || !SAFE_ID.test(String(roadmap.sourceId || '')) || !text(roadmap.revision, 160) || !SAFE_DIGEST.test(String(roadmap.digest || '')) || !Array.isArray(roadmap.phases) || roadmap.phases.length < 1 || roadmap.phases.length > MAX_PHASES) return { failure: invalid('Roadmap authority is missing a bounded source, revision, digest, or phase list.') }
  const flattened: FlattenedTask[] = []
  const phaseIds = new Set<string>()
  const taskIds = new Set<string>()
  const phases: RoadmapPhaseAuthority[] = []
  for (const phase of roadmap.phases) {
    if (!phase || !SAFE_ID.test(String(phase.id || '')) || phaseIds.has(phase.id) || !text(phase.title, 200) || !['pending', 'running', 'completed', 'blocked', 'failed', 'skipped'].includes(phase.status) || !Array.isArray(phase.tasks) || phase.tasks.length < 1) return { failure: invalid('Roadmap phase identity, status, or task list is invalid.') }
    phaseIds.add(phase.id)
    const tasks: RoadmapTaskAuthority[] = []
    for (const rawTask of phase.tasks) {
      if (!rawTask || !SAFE_ID.test(String(rawTask.id || ''))) return { failure: invalid('Roadmap task identity is invalid.') }
      if (taskIds.has(rawTask.id)) return { failure: { ok: false, code: 'AMBIGUOUS_TASK', message: `Roadmap task ${rawTask.id} is declared more than once.`, field: rawTask.id } }
      taskIds.add(rawTask.id)
      if (!['pending', 'running', 'completed', 'blocked', 'failed', 'skipped'].includes(rawTask.status)) return { failure: invalid(`Roadmap task ${rawTask.id} has an unsupported status.`, `${rawTask.id}.status`) }
      if (!Array.isArray(rawTask.paths) || !Array.isArray(rawTask.capabilities) || !Array.isArray(rawTask.acceptanceCriteria) || !Array.isArray(rawTask.validation) || rawTask.paths.some(value => typeof value !== 'string') || rawTask.capabilities.some(value => typeof value !== 'string') || (rawTask.dependsOn !== undefined && !Array.isArray(rawTask.dependsOn))) return { failure: invalid(`Roadmap task ${rawTask.id} must declare bounded paths, capabilities, acceptance criteria, validation, and dependencies.`, rawTask.id) }
      const paths = rawTask.paths.map(normalizePath)
      if (paths.some(value => !value)) return { failure: { ok: false, code: 'PACKET_INVALID', message: `Roadmap task ${rawTask.id} contains an unsafe or protected path.`, field: `${rawTask.id}.paths` } }
      const capabilities = rawTask.capabilities.map(value => String(value || '').trim())
      if (capabilities.length < 1 || capabilities.length > 8 || capabilities.some(value => !SAFE_CAPABILITY.test(value) || !KNOWN_CAPABILITIES.has(value))) return { failure: invalid(`Roadmap task ${rawTask.id} must declare 1-8 known safe capabilities.`, `${rawTask.id}.capabilities`) }
      try {
        const packet = normalizeTaskPacket(rawTask.packet, uniqueSorted(paths as string[]), rawTask.id)
        if ('ok' in packet && packet.ok === false) return { failure: packet }
        const effects = normalizeRoadmapEffects(rawTask.effects, uniqueSorted(paths as string[]))
        const task: RoadmapTaskAuthority = {
          id: rawTask.id,
          title: text(rawTask.title, 200),
          status: rawTask.status,
          description: text(rawTask.description),
          acceptanceCriteria: rawTask.acceptanceCriteria.map(value => text(value)).filter(Boolean).slice(0, 8),
          validation: rawTask.validation.map(value => text(value)).filter(Boolean).slice(0, 8),
          dependsOn: uniqueSorted((rawTask.dependsOn || []).map(value => String(value || '').trim()).filter(Boolean)),
          paths: uniqueSorted(paths as string[]),
          capabilities: uniqueSorted(capabilities),
          ...(effects.length > 0 ? { effects } : {}),
          packet: packet as RoadmapTaskPacketAuthority
        }
        if (task.packet.localServer && !task.capabilities.some(capability => ['server_start', 'server_lifecycle'].includes(capability))) throw new Error('localServer requires server_start or server_lifecycle capability')
        if (task.packet.localServer?.command.executable === 'node' && !task.paths.includes(task.packet.localServer.command.args[0]!)) throw new Error('node localServer entrypoint must be one of the exact task paths')
        tasks.push(task)
        flattened.push({ phase: { ...phase, tasks: [] }, task, index: flattened.length })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const code = message.includes('effect') || message.includes('package_install') || message.includes('generated output') ? 'EFFECT_INVALID' : message.includes('protected') ? 'PROTECTED_CONTENT' : message.includes('path') ? 'PACKET_INVALID' : 'PACKET_INVALID'
        return { failure: { ok: false, code, message: `Roadmap task ${rawTask.id} packet is invalid: ${message}`, field: rawTask.id } }
      }
    }
    phases.push({ id: phase.id, title: text(phase.title, 200), status: phase.status, tasks })
  }
  if (flattened.length > MAX_TASKS) return { failure: invalid(`Roadmap exceeds the ${MAX_TASKS}-task bound.`) }
  const normalized = { sourceId: roadmap.sourceId, revision: text(roadmap.revision, 160), digest: roadmap.digest.toLowerCase(), phases }
  return { roadmap: normalized, flattened }
}

function roadmapDigestInput(input: Omit<RoadmapAuthority, 'digest'>) {
  return {
    sourceId: text(input.sourceId, 160),
    revision: text(input.revision, 160),
    phases: input.phases.map(phase => ({
      id: String(phase.id || '').trim(),
      title: text(phase.title, 200),
      status: phase.status,
      tasks: phase.tasks.map(task => {
        const paths = Array.isArray(task.paths)
          ? uniqueSorted(task.paths.map(item => normalizePath(String(item))).filter((item): item is string => Boolean(item)))
          : []
        let packet: unknown = task.packet
        try {
          const normalizedPacket = normalizeTaskPacket(task.packet, paths, String(task.id || ''))
          packet = 'ok' in normalizedPacket && normalizedPacket.ok === false ? task.packet : normalizedPacket
        } catch {
          packet = task.packet
        }
        let effects: unknown = task.effects
        try {
          effects = normalizeRoadmapEffects(task.effects, paths)
        } catch {
          effects = task.effects
        }
        return {
          id: String(task.id || '').trim(),
          title: text(task.title, 200),
          status: task.status,
          description: text(task.description),
          acceptanceCriteria: Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria.map(value => text(value)).filter(Boolean).slice(0, 8) : [],
          validation: Array.isArray(task.validation) ? task.validation.map(value => text(value)).filter(Boolean).slice(0, 8) : [],
          dependsOn: uniqueSorted((task.dependsOn || []).map(value => String(value || '').trim()).filter(Boolean)),
          paths,
          capabilities: uniqueSorted((task.capabilities || []).map(value => String(value || '').trim())),
          ...(effects !== undefined ? { effects } : {}),
          packet
        }
      })
    }))
  }
}

export function roadmapAuthorityDigest(input: Omit<RoadmapAuthority, 'digest'>): string {
  return digest(roadmapDigestInput(input))
}

function effectHandledCapabilities(task: RoadmapTaskAuthority): Set<string> {
  const handled = new Set<string>()
  for (const effect of task.effects || []) {
    if (effect.kind === 'package_install') ['install', 'lockfile_change', 'network_request'].forEach(item => handled.add(item))
    if (effect.kind === 'external_service') ['external_service', 'network_request'].forEach(item => handled.add(item))
    if (effect.kind === 'deployment') handled.add('deployment')
    if (effect.kind === 'generated_output' && effect.destination === 'repository_source') {
      task.capabilities.filter(item => ['create_file', 'patch_file', 'append_file', 'overwrite_file', 'move_file'].includes(item)).forEach(item => handled.add(item))
    }
  }
  if (task.packet.localServer) ['server_start', 'server_lifecycle'].forEach(item => {
    if (task.capabilities.includes(item)) handled.add(item)
  })
  return handled
}

function packetPaths(task: RoadmapTaskAuthority): string[] {
  return uniqueSorted(task.packet.steps.flatMap(step => [step.path, ...(step.to ? [step.to] : [])]))
}

function effectPolicyInput(input: RoadmapToRunCompilerInput, task: RoadmapTaskAuthority, effect: RoadmapEffectAuthority): Parameters<typeof evaluateRoadmapEffectPolicy>[0] {
  const bundleInput = {
    sourceId: input.source.sourceId,
    runId: input.run.runId,
    sessionId: input.session.sessionId,
    actorId: input.policy.actorId || 'workbench-operator',
    policyIdentity: input.policy.identity,
    autonomyLevel: input.policy.autonomyLevel,
    phase16Intersection: input.policy.phase16Intersection,
    effect,
    taskPaths: task.paths,
    packetPaths: packetPaths(task),
    capabilities: task.capabilities
  }
  const approval = input.policy.effectApprovals?.find(item => item.bundleDigest === roadmapEffectBundleDigest(bundleInput))
  return approval ? { ...bundleInput, approval } : bundleInput
}

function compiledEffect(evaluation: RoadmapEffectPolicyResult): CompiledRunEffect {
  return {
    effectType: evaluation.effectType,
    effectIdentity: evaluation.effectIdentity,
    decision: evaluation.decision,
    approvalBundleDigest: evaluation.approvalBundleDigest,
    approvalReusable: evaluation.approvalReusable,
    humanExplanation: evaluation.humanExplanation
  }
}

function effectGate(evaluation: RoadmapEffectPolicyResult): CompiledRunGate | undefined {
  if (evaluation.decision === 'allow') return undefined
  const kind = evaluation.effectType === 'package_install' ? 'install'
    : evaluation.effectType === 'external_service' ? 'external_service'
      : evaluation.effectType === 'deployment' ? 'deployment' : 'generated_output'
  return {
    kind,
    status: evaluation.decision === 'requires_confirmation' ? 'open' : 'denied',
    effectType: evaluation.effectType,
    effectIdentity: evaluation.effectIdentity,
    decision: evaluation.decision,
    approvalBundleDigest: evaluation.approvalBundleDigest,
    approvalReusable: evaluation.approvalReusable,
    humanExplanation: evaluation.humanExplanation,
    reasonCode: evaluation.reasonCode,
    message: evaluation.humanExplanation
  }
}

function hiddenDeploymentGate(task: RoadmapTaskAuthority): CompiledRunGate | undefined {
  if (task.effects?.some(effect => effect.kind === 'deployment')) return undefined
  const hidden = task.packet.validation?.some(item => item.commandKind === 'run_package_script' && /(?:deploy|publish|release)/i.test(item.scriptName || ''))
  return hidden
    ? { kind: 'deployment', status: 'denied', capability: 'deployment', reasonCode: 'hidden_deployment', message: 'A deployment-like package script is not a deployment authority. Declare a separate deployment effect; deployment remains a hard stop.' }
    : undefined
}

function capabilityGate(capability: string, policy: RoadmapPolicyGrantState, handledCapabilities: ReadonlySet<string>): CompiledRunGate | undefined {
  if (handledCapabilities.has(capability)) return undefined
  const intersection = policy.phase16Intersection
  if (intersection.deniedCapabilities?.includes(capability) || !intersection.allowedCapabilities.includes(capability)) {
    return { kind: 'policy', status: 'denied', capability, reasonCode: 'phase16_intersection_denied', message: `Capability ${capability} is not granted by the Phase 16 policy intersection.` }
  }
  if (['install', 'lockfile_change'].includes(capability)) return { kind: 'install', status: 'open', capability, reasonCode: 'install_slice_not_implemented', message: 'Package installation or lockfile mutation is an explicit Phase 19 gate.' }
  if (['network_request', 'external_service'].includes(capability)) return { kind: 'external_service', status: 'open', capability, reasonCode: 'external_service_gate', message: 'Network or external-service work stops for the later Phase 19 policy slice.' }
  if (['deployment'].includes(capability)) return { kind: 'deployment', status: 'open', capability, reasonCode: 'deployment_gate', message: 'Deployment is an explicit Phase 19 stop condition.' }
  if (['server_start', 'server_lifecycle'].includes(capability)) return { kind: 'server_lifecycle', status: 'open', capability, reasonCode: 'server_lifecycle_declaration_required', message: 'Local server lifecycle requires the packet to carry its typed server declaration.' }
  if (['protected_mutation'].includes(capability)) return { kind: 'protected_mutation', status: 'open', capability, reasonCode: 'protected_mutation_gate', message: 'Protected mutation requires a separate guarded operation and confirmation.' }
  if (intersection.confirmationRequiredCapabilities?.includes(capability)) {
    const confirmed = policy.confirmation.status === 'satisfied' && (!policy.confirmation.capabilityIds || policy.confirmation.capabilityIds.includes(capability))
    if (!confirmed) return { kind: 'confirmation', status: policy.confirmation.status === 'denied' ? 'denied' : 'open', capability, reasonCode: policy.confirmation.status === 'denied' ? 'confirmation_denied' : 'confirmation_required', message: `Capability ${capability} requires the current scoped confirmation.` }
  }
  return undefined
}

function pathPolicyGate(paths: string[], policy: RoadmapPolicyGrantState): CompiledRunGate | undefined {
  const allowed = policy.phase16Intersection.allowedPaths
  if (!allowed || allowed.length === 0) return undefined
  const normalizedAllowed = allowed.map(normalizePath).filter((value): value is string => Boolean(value))
  const inScope = (candidate: string) => normalizedAllowed.some(prefix => candidate === prefix || candidate.startsWith(`${prefix}/`))
  const outside = paths.find(candidate => !inScope(candidate))
  if (!outside) return undefined
  return { kind: 'policy', status: 'denied', reasonCode: 'phase16_path_intersection_denied', message: `Path ${outside} is outside the Phase 16 allowed path intersection.` }
}

function packetPolicyGate(task: RoadmapTaskAuthority, run: RoadmapRunAuthority): CompiledRunGate | undefined {
  if (!task.packet.commit?.enabled) return undefined
  if (!task.capabilities.includes('git_commit')) return { kind: 'policy', status: 'denied', capability: 'git_commit', reasonCode: 'commit_capability_missing', message: 'The packet requests a commit but does not declare the git_commit capability.' }
  if (run.autoCommit === true) return undefined
  return { kind: 'policy', status: 'denied', reasonCode: 'run_commit_disabled', capability: 'git_commit', message: 'The packet requests a commit but the parent run does not authorize auto-commit.' }
}

function localServerNetworkGate(task: RoadmapTaskAuthority): CompiledRunGate | undefined {
  if (!task.packet.localServer || task.packet.localServer.networkScope === 'loopback') return undefined
  return {
    kind: 'external_service',
    status: 'open',
    capability: 'external_service',
    reasonCode: 'server_external_network_gate',
    message: 'A local-server declaration with external network scope is an R19.2 external-service effect and requires its existing gate.'
  }
}

function packetId(input: RoadmapToRunCompilerInput, taskId: string): string {
  return `packet-${digest({ sourceId: input.source.sourceId, runId: input.run.runId, sessionId: input.session.sessionId, head: input.repo.currentHead, roadmapDigest: input.roadmap.digest, policyGrantDigest: roadmapPolicyGrantDigest(input.policy), taskId }).slice(0, 32)}`
}

export function roadmapPolicyGrantDigest(policy: RoadmapPolicyGrantState): string {
  return digest({
    identity: policy.identity,
    autonomyLevel: policy.autonomyLevel,
    actorId: policy.actorId || 'workbench-operator',
    phase16Intersection: policy.phase16Intersection,
    confirmation: policy.confirmation,
    effectApprovals: policy.effectApprovals || []
  })
}

function boundedHumanProjection(plan: Omit<CompiledRunPlan, 'humanProjection' | 'planDigest' | 'planId' | 'evidence'>, currentTitle?: string): { text: string; bytes: number } {
  const current = plan.currentPacketId ? `Next packet: ${plan.currentPacketId}` : 'Next packet: none'
  const gateText = plan.gates.length > 0 ? `Gates: ${uniqueSorted(plan.gates.map(gate => gate.kind)).join(', ')}` : 'Gates: none'
  const stopText = `Stops: ${plan.stops.join(', ')}`
  const currentPacket = plan.packets.find(packet => packet.packetId === plan.currentPacketId)
  const validationText = currentPacket
    ? `Validation: selected ${currentPacket.validationSelection.selected.map(node => node.command.commandKind).join(', ')}; skipped ${currentPacket.validationSelection.skipped.length}`
    : 'Validation: none'
  const reviewText = currentPacket?.review
    ? `Review: Codex read-only approval required · scope ${currentPacket.review.request.scope.paths.join(', ')}`
    : 'Review: none'
  const textValue = [
    `${plan.source.sourceId} · ${plan.run.runId} · ${plan.status}`,
    `Task: ${currentTitle || plan.currentTaskId || 'none'} · ${plan.tasks.length} tasks · ${plan.packets.length} packets`,
    current,
    `Scheduler-ready packets: ${plan.packets.filter(packet => packet.schedulerReady).length}`,
    validationText,
    reviewText,
    'Validation planning decisions: 0',
    gateText,
    stopText
  ].join('\n')
  const bounded = textValue.length > 1_200 ? `${textValue.slice(0, 1_197)}...` : textValue
  return { text: bounded, bytes: Buffer.byteLength(bounded, 'utf8') }
}

export function compileRoadmapToRunPlan(input: RoadmapToRunCompilerInput): RoadmapToRunCompileResult {
  if (!input || typeof input !== 'object' || !input.source || typeof input.source !== 'object' || !input.roadmap || typeof input.roadmap !== 'object' || !input.run || typeof input.run !== 'object' || !input.session || typeof input.session !== 'object' || !input.repo || typeof input.repo !== 'object') {
    return invalid('Compiler input must contain bounded source, roadmap, run, session, and repository authority.')
  }
  const sourceId = String(input?.source?.sourceId || '').trim()
  const roadmapSourceId = String(input?.roadmap?.sourceId || '').trim()
  const runSourceId = String(input?.run?.sourceId || '').trim()
  if (!sourceId || sourceId !== roadmapSourceId || sourceId !== runSourceId) return { ok: false, code: 'SOURCE_LOCK_MISMATCH', message: 'Source authority, roadmap authority, and run authority must name the same source.' }
  if (input.source.enabled !== true) return { ok: false, code: 'SOURCE_DISABLED', message: `Source ${sourceId} is disabled or unavailable.` }
  if (!input.run.runId || !SAFE_ID.test(input.run.runId) || !input.session.sessionId || !SAFE_ID.test(input.session.sessionId) || input.run.sessionId !== input.session.sessionId || !Array.isArray(input.session.lockedSourceIds)) return { ok: false, code: 'SESSION_LOCK_MISMATCH', message: 'Run and session identity must be explicit and equal.' }
  if (input.session.status !== 'active' || !input.session.lockedSourceIds.includes(sourceId)) return { ok: false, code: 'SESSION_LOCK_MISMATCH', message: 'An active session locked to the selected source is required.' }
  if ((input.run.completedTaskIds !== undefined && (!Array.isArray(input.run.completedTaskIds) || input.run.completedTaskIds.some(value => typeof value !== 'string'))) || (input.run.completedPacketIds !== undefined && (!Array.isArray(input.run.completedPacketIds) || input.run.completedPacketIds.some(value => typeof value !== 'string')))) return { ok: false, code: 'RUN_NOT_EXECUTABLE', message: 'Run completion state must be bounded string IDs.' }
  if (!['queued', 'running', 'needs_confirmation'].includes(input.run.status)) return { ok: false, code: 'RUN_NOT_EXECUTABLE', message: `Run is ${input.run.status}; only queued, running, or confirmation re-compilation is allowed.` }
  const currentHead = String(input.repo?.currentHead || '').trim().toLowerCase()
  if (!SAFE_HEAD.test(currentHead)) return { ok: false, code: 'STALE_HEAD', message: 'Current repository HEAD is missing or invalid.' }
  if (input.run.expectedHead && input.run.expectedHead.toLowerCase() !== currentHead) return { ok: false, code: 'STALE_HEAD', message: `Run expected HEAD ${input.run.expectedHead}, but repository HEAD is ${currentHead}.` }
  if (!input.policy || !text(input.policy.identity, 200) || !Number.isInteger(input.policy.autonomyLevel) || input.policy.autonomyLevel < 0 || input.policy.autonomyLevel > 5) return { ok: false, code: 'POLICY_INVALID', message: 'Compiler supports only the bounded autonomy levels 0-5 and requires a policy identity.' }
  if (input.policy.actorId !== undefined && !SAFE_ID.test(input.policy.actorId)) return { ok: false, code: 'POLICY_INVALID', message: 'Policy actor identity must be a bounded stable identifier.' }
  const intersection = input.policy.phase16Intersection
  if (!intersection || !Array.isArray(intersection.allowedCapabilities) || (intersection.deniedCapabilities !== undefined && !Array.isArray(intersection.deniedCapabilities)) || (intersection.confirmationRequiredCapabilities !== undefined && !Array.isArray(intersection.confirmationRequiredCapabilities)) || (intersection.allowedPaths !== undefined && !Array.isArray(intersection.allowedPaths)) || intersection.allowedCapabilities.some(value => !SAFE_CAPABILITY.test(String(value || ''))) || (intersection.deniedCapabilities || []).some(value => !SAFE_CAPABILITY.test(String(value || ''))) || (intersection.confirmationRequiredCapabilities || []).some(value => !SAFE_CAPABILITY.test(String(value || '')))) return { ok: false, code: 'POLICY_INVALID', message: 'Phase 16 capability intersection is required and must contain bounded capability IDs.' }
  if (!input.policy.confirmation || !['not_required', 'satisfied', 'required', 'denied'].includes(input.policy.confirmation.status) || (input.policy.confirmation.capabilityIds !== undefined && (!Array.isArray(input.policy.confirmation.capabilityIds) || input.policy.confirmation.capabilityIds.some(value => typeof value !== 'string')))) return { ok: false, code: 'POLICY_INVALID', message: 'Policy confirmation state must be explicit and bounded.' }
  if (input.policy.effectApprovals !== undefined && (!Array.isArray(input.policy.effectApprovals) || input.policy.effectApprovals.length > 32 || input.policy.effectApprovals.some(item => !item || !SAFE_DIGEST.test(item.bundleDigest) || !SAFE_DIGEST.test(item.requestFingerprint) || !['none', 'matched', 'expired', 'policy_changed', 'unavailable'].includes(item.state) || (item.decision !== undefined && !['APPROVED', 'DENIED'].includes(item.decision))))) return { ok: false, code: 'POLICY_INVALID', message: 'Persisted effect approvals must be bounded, hashed, and explicit.' }
  if (intersection.allowedPaths?.some(value => !normalizePath(String(value || '')))) return { ok: false, code: 'POLICY_INVALID', message: 'Phase 16 allowed paths must be safe repository-relative paths.' }

  const normalized = normalizeRoadmap(input.roadmap)
  if (normalized.failure) return normalized.failure
  const roadmap = normalized.roadmap!
  const flattened = normalized.flattened!
  if (roadmapAuthorityDigest({ sourceId: roadmap.sourceId, revision: roadmap.revision, phases: roadmap.phases }) !== roadmap.digest) return { ok: false, code: 'ROADMAP_DIGEST_MISMATCH', message: 'Roadmap digest does not match the supplied roadmap authority.' }
  const matching = flattened.filter(item => item.task.id === input.taskId)
  if (matching.length === 0) return { ok: false, code: 'TASK_NOT_FOUND', message: `Selected roadmap task ${input.taskId} was not found.` }
  if (matching.length > 1) return { ok: false, code: 'AMBIGUOUS_TASK', message: `Selected roadmap task ${input.taskId} is ambiguous.` }
  const selected = matching[0]
  if (['completed', 'blocked', 'failed', 'skipped'].includes(selected.task.status)) return { ok: false, code: 'TASK_ALREADY_TERMINAL', message: `Selected roadmap task ${input.taskId} is already ${selected.task.status}.` }
  if (input.run.activeTaskId && input.run.activeTaskId !== input.taskId) return { ok: false, code: 'TASK_ORDER_INVALID', message: `Run active task ${input.run.activeTaskId} does not match selected task ${input.taskId}.` }

  const taskById = new Map(flattened.map(item => [item.task.id, item.task]))
  for (const item of flattened) {
    for (const dependency of item.task.dependsOn || []) {
      const prerequisite = taskById.get(dependency)
      if (!prerequisite) return { ok: false, code: 'ROADMAP_INVALID', message: `Task ${item.task.id} depends on unknown task ${dependency}.` }
      if (flattened.findIndex(candidate => candidate.task.id === dependency) >= item.index) return { ok: false, code: 'ROADMAP_INVALID', message: `Task ${item.task.id} depends on a later task ${dependency}.` }
    }
  }
  const completedTaskIds = new Set([...(input.run.completedTaskIds || []), ...flattened.filter(item => ['completed', 'skipped'].includes(item.task.status)).map(item => item.task.id)])
  const firstRunnable = flattened.find(item => !['completed', 'blocked', 'failed', 'skipped'].includes(item.task.status) && (item.task.dependsOn || []).every(dependency => completedTaskIds.has(dependency)))
  if (!firstRunnable || firstRunnable.task.id !== input.taskId) return { ok: false, code: firstRunnable ? 'TASK_ORDER_INVALID' : 'TASK_DEPENDENCY_UNSATISFIED', message: firstRunnable ? `Selected task ${input.taskId} is not the deterministic next runnable task.` : `Selected task ${input.taskId} has an unsatisfied dependency.` }

  const completedPacketIds = uniqueSorted(input.run.completedPacketIds || [])
  const tasks: CompiledRunTask[] = []
  const packets: CompiledRunPacket[] = []
  const nonTerminal = flattened.filter(item => !['completed', 'blocked', 'failed', 'skipped'].includes(item.task.status))
  for (const item of flattened) {
    const task = item.task
    const terminal = ['completed', 'blocked', 'failed', 'skipped'].includes(task.status)
    const id = terminal ? undefined : packetId(input, task.id)
    const validationSelectionResult = id ? selectSmallestMeaningfulValidation({
      sourceId,
      runId: input.run.runId,
      packetId: id,
      taskId: task.id,
      expectedHead: currentHead,
      exactPaths: task.paths,
      capabilities: task.capabilities,
      declaredValidation: task.packet.validation || []
    }) : undefined
    if (validationSelectionResult?.ok === false) return validationSelectionResult
    const validationSelection = validationSelectionResult?.selection
    let review: CodexReviewRequirement | undefined
    if (id && task.packet.review) {
      try {
        review = compileCodexReviewRequirement({
          taskId: task.id,
          packetId: id,
          sourceId,
          sourceRevision: roadmap.revision,
          sourceHead: currentHead,
          runId: input.run.runId,
          sessionId: input.session.sessionId,
          declaration: task.packet.review,
          policy: {
            identity: input.policy.identity,
            autonomyLevel: input.policy.autonomyLevel,
            actorId: input.policy.actorId || 'workbench-operator'
          }
        })
      } catch (error) {
        return { ok: false, code: 'PACKET_INVALID', message: `Task ${task.id} Codex review declaration could not be compiled: ${error instanceof Error ? error.message : String(error)}` }
      }
    }
    const effectEvaluations = terminal ? [] : (task.effects || []).map(effect => evaluateRoadmapEffectPolicy(effectPolicyInput(input, task, effect)))
    const compiledEffects = effectEvaluations.map(compiledEffect)
    const reviewGate: CompiledRunGate | undefined = review
      ? {
          kind: 'confirmation',
          status: 'open',
          capability: review.request.adapter.capabilityId,
          reasonCode: 'codex_review_approval_required',
          message: `Codex read-only review approval is required for ${review.request.scope.paths.join(', ')}; writes, Git mutation, network, and credentials are prohibited.`
        }
      : undefined
    const gates = terminal ? [] : [
      ...task.capabilities.map(capability => capabilityGate(capability, input.policy, effectHandledCapabilities(task))).filter((gate): gate is CompiledRunGate => Boolean(gate)),
      pathPolicyGate(task.paths, input.policy),
      packetPolicyGate(task, input.run),
      localServerNetworkGate(task),
      ...effectEvaluations.map(effectGate),
      hiddenDeploymentGate(task),
      reviewGate
    ].filter((gate): gate is CompiledRunGate => Boolean(gate))
    const taskHasDeniedGate = gates.some(gate => gate.status === 'denied')
    const taskIsCurrent = task.id === input.taskId
    const dependenciesReady = (task.dependsOn || []).every(dependency => completedTaskIds.has(dependency))
    const completed = Boolean(id && completedPacketIds.includes(id)) || terminal
    const readiness: CompiledRunTask['readiness'] = completed
      ? 'completed'
      : taskHasDeniedGate || !dependenciesReady ? 'blocked'
        : taskIsCurrent && gates.length > 0 ? 'awaiting_gate'
          : taskIsCurrent ? 'current' : 'queued'
    tasks.push({
      phaseId: item.phase.id,
      taskId: task.id,
      title: task.title,
      status: task.status,
      dependencies: [...(task.dependsOn || [])],
      exactPaths: task.paths,
      capabilities: task.capabilities,
      acceptanceCriteria: task.acceptanceCriteria,
      validation: task.validation,
      effects: compiledEffects,
      ...(review ? { review } : {}),
      ...(task.packet.localServer ? { localServer: task.packet.localServer } : {}),
      ...(id ? { packetId: id } : {}),
      readiness,
      gates
    })
    if (!id) continue
    if (completed) continue
    const schedulerReady = taskIsCurrent && readiness === 'current'
    const packetStatus: CompiledRunPacket['status'] = readiness === 'blocked' ? 'blocked' : readiness === 'awaiting_gate' ? 'awaiting_gate' : taskIsCurrent ? 'current' : 'queued'
    const packet: CompiledRunPacket = {
      packetId: id,
      taskId: task.id,
      sequence: nonTerminal.findIndex(candidate => candidate.task.id === task.id) + 1,
      status: packetStatus,
      exactPaths: task.paths,
      capabilities: task.capabilities,
      validation: validationSelection?.selected.map(selectionCommandToPacketValidation) || [],
      validationSelection: validationSelection as ValidationSelectionV1,
      steps: task.packet.steps,
      ...(task.packet.localServer ? { localServer: task.packet.localServer } : {}),
      ...(task.packet.commit ? { commit: task.packet.commit } : {}),
      effects: compiledEffects,
      ...(review ? { review } : {}),
      schedulerReady,
      ...(schedulerReady ? { schedulerReason: 'current_task' as const } : { schedulerReason: readiness === 'blocked' ? 'dependency_not_complete' as const : readiness === 'awaiting_gate' ? 'gate_open' as const : 'not_current_task' as const }),
      gates
    }
    packets.push(packet)
  }
  if (input.run.activePacketId && !completedPacketIds.includes(input.run.activePacketId) && input.run.activePacketId !== packetId(input, input.taskId)) return { ok: false, code: 'ACTIVE_PACKET_CONFLICT', message: `Run already has active packet ${input.run.activePacketId}; reconcile it before compiling a replacement.` }

  const selectedPacket = packets.find(packet => packet.taskId === input.taskId)
  const selectedGates = tasks.find(task => task.taskId === input.taskId)?.gates || []
  const policyDenied = selectedGates.some(gate => gate.status === 'denied')
  const gates = selectedGates.filter((gate, index, list) => list.findIndex(candidate => canonicalize(candidate) === canonicalize(gate)) === index)
  const stops = uniqueSorted([
    'stale_head',
    'ambiguous_authority',
    'failed_repair',
    ...gates.filter(gate => gate.kind === 'install').map(() => 'install' as const),
    ...gates.filter(gate => gate.kind === 'external_service').map(() => 'external_service' as const),
    ...gates.filter(gate => gate.kind === 'deployment').map(() => 'deployment' as const),
    ...gates.filter(gate => gate.kind === 'generated_output').map(() => 'generated_output' as const),
    ...gates.filter(gate => gate.kind === 'confirmation').map(() => 'confirmation' as const),
    ...gates.filter(gate => gate.kind === 'protected_mutation').map(() => 'protected_mutation' as const)
  ]) as CompiledRunStop[]
  const status: CompiledRunPlan['status'] = policyDenied ? 'blocked' : gates.length > 0 ? 'awaiting_gate' : 'ready'
  const semantic = {
    schemaVersion: ROADMAP_TO_RUN_PLAN_SCHEMA_VERSION,
    compilerVersion: ROADMAP_TO_RUN_COMPILER_VERSION,
    status,
    source: { sourceId, rootFingerprint: input.source.rootFingerprint },
    authority: { roadmapRevision: roadmap.revision, roadmapDigest: roadmap.digest, selectedTaskId: input.taskId },
    run: { runId: input.run.runId, sessionId: input.session.sessionId },
    startHead: currentHead,
    autonomy: { level: input.policy.autonomyLevel, policyIdentity: input.policy.identity, grantDigest: roadmapPolicyGrantDigest(input.policy) },
    tasks,
    packets,
    order: flattened.map(item => item.task.id),
    currentTaskId: input.taskId,
    currentPacketId: selectedPacket?.packetId,
    completedPacketIds,
    remainingPacketIds: packets.filter(packet => !completedPacketIds.includes(packet.packetId)).map(packet => packet.packetId),
    gates,
    stops
  }
  const planDigest = digest(semantic)
  const planWithoutPresentation = semantic as Omit<CompiledRunPlan, 'humanProjection' | 'planDigest' | 'planId' | 'evidence'>
  const currentTitle = selected.task.title
  const humanProjection = boundedHumanProjection(planWithoutPresentation, currentTitle)
  const plan: CompiledRunPlan = {
    ...semantic,
    planId: `run-plan-${planDigest.slice(0, 32)}`,
    planDigest,
    evidence: {
      sourceId,
      taskId: input.taskId,
      roadmapRevision: roadmap.revision,
      roadmapDigest: roadmap.digest,
      compilerVersion: ROADMAP_TO_RUN_COMPILER_VERSION,
      planDigest,
      packetCount: packets.length,
      schedulerReadyPacketCount: packets.filter(packet => packet.schedulerReady).length,
      gateKinds: uniqueSorted(gates.map(gate => gate.kind)),
      stopKinds: stops
    },
    humanProjection
  }
  return { ok: true, plan }
}

export function validateCompiledRunPlanIdentity(input: {
  plan: CompiledRunPlan
  sourceId: string
  sourceRootFingerprint?: string
  sessionId: string
  runId: string
  currentHead: string
  roadmapRevision: string
  roadmapDigest: string
  taskId: string
  policyIdentity: string
  policyGrantDigest?: string
}): { ok: true } | { ok: false; code: 'PLAN_NOT_FOUND' | 'PLAN_STALE_SOURCE' | 'PLAN_STALE_SESSION' | 'PLAN_STALE_RUN' | 'PLAN_STALE_HEAD' | 'PLAN_STALE_ROADMAP' | 'PLAN_STALE_TASK' | 'PLAN_STALE_POLICY'; message: string } {
  const plan = input.plan
  if (!plan || plan.schemaVersion !== ROADMAP_TO_RUN_PLAN_SCHEMA_VERSION || plan.compilerVersion !== ROADMAP_TO_RUN_COMPILER_VERSION) return { ok: false, code: 'PLAN_NOT_FOUND', message: 'Compiled run plan is missing or unsupported.' }
  if (compiledRunPlanSemanticDigest(plan) !== plan.planDigest || plan.planId !== `run-plan-${plan.planDigest.slice(0, 32)}`) return { ok: false, code: 'PLAN_NOT_FOUND', message: 'Compiled run plan integrity check failed.' }
  if (plan.source.sourceId !== input.sourceId || (input.sourceRootFingerprint !== undefined && plan.source.rootFingerprint !== input.sourceRootFingerprint)) return { ok: false, code: 'PLAN_STALE_SOURCE', message: 'Compiled plan source lock no longer matches.' }
  if (plan.run.sessionId !== input.sessionId) return { ok: false, code: 'PLAN_STALE_SESSION', message: 'Compiled plan session identity no longer matches.' }
  if (plan.run.runId !== input.runId) return { ok: false, code: 'PLAN_STALE_RUN', message: 'Compiled plan run identity no longer matches.' }
  if (plan.startHead !== input.currentHead) return { ok: false, code: 'PLAN_STALE_HEAD', message: 'Compiled plan is stale because repository HEAD changed.' }
  if (plan.authority.roadmapRevision !== input.roadmapRevision || plan.authority.roadmapDigest !== input.roadmapDigest) return { ok: false, code: 'PLAN_STALE_ROADMAP', message: 'Compiled plan is stale because roadmap authority changed.' }
  if (plan.authority.selectedTaskId !== input.taskId) return { ok: false, code: 'PLAN_STALE_TASK', message: 'Compiled plan selected task no longer matches.' }
  if (plan.autonomy.policyIdentity !== input.policyIdentity || (input.policyGrantDigest && plan.autonomy.grantDigest !== input.policyGrantDigest)) return { ok: false, code: 'PLAN_STALE_POLICY', message: 'Compiled plan is stale because policy/grant identity changed.' }
  return { ok: true }
}

export function compiledRunPlanSemanticDigest(plan: CompiledRunPlan): string {
  return digest(semanticPlanFields(plan))
}

export function normalizeCompiledRunPlan(raw: unknown): CompiledRunPlan | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  try {
    if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > 120_000) return undefined
  } catch {
    return undefined
  }
  const plan = raw as Partial<CompiledRunPlan>
  if (plan.schemaVersion !== ROADMAP_TO_RUN_PLAN_SCHEMA_VERSION || plan.compilerVersion !== ROADMAP_TO_RUN_COMPILER_VERSION || typeof plan.planId !== 'string' || typeof plan.planDigest !== 'string' || !SAFE_DIGEST.test(plan.planDigest) || plan.planId !== `run-plan-${plan.planDigest.slice(0, 32)}` || !['ready', 'awaiting_gate', 'blocked'].includes(plan.status) || !Array.isArray(plan.tasks) || !plan.tasks.every(task => Array.isArray(task.effects)) || !Array.isArray(plan.packets) || !plan.packets.every(packet => Array.isArray(packet.effects)) || !Array.isArray(plan.order) || !Array.isArray(plan.completedPacketIds) || !Array.isArray(plan.remainingPacketIds) || !Array.isArray(plan.gates) || !Array.isArray(plan.stops) || !plan.source || typeof plan.source.sourceId !== 'string' || !plan.authority || typeof plan.authority.roadmapRevision !== 'string' || typeof plan.authority.roadmapDigest !== 'string' || typeof plan.authority.selectedTaskId !== 'string' || !plan.run || typeof plan.run.runId !== 'string' || typeof plan.run.sessionId !== 'string' || typeof plan.startHead !== 'string' || !plan.autonomy || typeof plan.autonomy.policyIdentity !== 'string' || typeof plan.autonomy.grantDigest !== 'string' || !plan.evidence || typeof plan.evidence.packetCount !== 'number' || typeof plan.evidence.schedulerReadyPacketCount !== 'number' || !Array.isArray(plan.evidence.gateKinds) || !Array.isArray(plan.evidence.stopKinds) || !plan.humanProjection || typeof plan.humanProjection.text !== 'string' || typeof plan.humanProjection.bytes !== 'number') return undefined
  if (compiledRunPlanSemanticDigest(plan as CompiledRunPlan) !== plan.planDigest) return undefined
  if (!plan.packets.every(packet => validationSelectionV1Schema.safeParse(packet.validationSelection).success)) return undefined
  return plan as CompiledRunPlan
}

export function compiledRunPlanRecoveryProjection(plan: CompiledRunPlan, state: Pick<RoadmapRunAuthority, 'activeTaskId' | 'activePacketId' | 'completedTaskIds' | 'completedPacketIds'>) {
  const completedPackets = new Set(state.completedPacketIds || plan.completedPacketIds)
  const completedTasks = new Set(state.completedTaskIds || [])
  const currentTaskId = state.activeTaskId || plan.currentTaskId
  return {
    planId: plan.planId,
    planDigest: plan.planDigest,
    currentTaskId,
    currentPacketId: state.activePacketId || plan.packets.find(packet => packet.taskId === currentTaskId && !completedPackets.has(packet.packetId))?.packetId,
    completedPacketIds: plan.packets.filter(packet => completedPackets.has(packet.packetId)).map(packet => packet.packetId),
    remainingPacketIds: plan.packets.filter(packet => !completedPackets.has(packet.packetId)).map(packet => packet.packetId),
    completedTaskIds: plan.tasks.filter(task => completedTasks.has(task.taskId) || task.readiness === 'completed').map(task => task.taskId),
    activeGateKinds: uniqueSorted(plan.gates.filter(gate => gate.status === 'open').map(gate => gate.kind))
  }
}
