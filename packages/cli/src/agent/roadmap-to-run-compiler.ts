import { execFileSync } from 'node:child_process'
import {
  getAgentJob,
  updateAgentJob,
  type AgentJob,
  type AgentJobUpdate
} from './agent-jobs'
import { getWorkbenchSession } from './workbench-session-store'
import { preflightWorkbenchPacket, type WorkbenchPacket } from './workbench-packets'
import { reserveWorkbenchPacket, type WorkbenchPacketRecord } from './workbench-packet-store'
import {
  lookupRoadmapEffectApproval,
  prepareRoadmapEffectApprovalIntent,
  type RoadmapEffectAuthority
} from './roadmap-effect-policy'
import type { AutonomyDecisionStoreOptions } from './autonomy-decision-store'
import {
  compileRoadmapToRunPlan,
  type CompiledRunPlan,
  type RoadmapAuthority,
  type RoadmapPolicyGrantState,
  type RoadmapSourceAuthority,
  type RoadmapToRunCompileFailure,
  type RoadmapToRunCompilerInput
} from './roadmap-to-run-plan'

export type RoadmapToRunPersistenceOptions = {
  sourceRoot?: string
  materializePacket?: boolean
  now?: () => Date
  approvalStoreOptions?: AutonomyDecisionStoreOptions
}

export type RoadmapToRunPersistFailure = RoadmapToRunCompileFailure | {
  ok: false
  code: 'RUN_NOT_FOUND' | 'SESSION_NOT_FOUND' | 'PACKET_RESERVATION_FAILED' | 'PACKET_PREFLIGHT_FAILED' | 'RUN_PERSIST_FAILED' | 'EFFECT_APPROVAL_FAILED'
  message: string
  details?: unknown
}

export type RoadmapToRunPersistResult =
  | { ok: true; plan: CompiledRunPlan; run: AgentJob; packet?: { record: WorkbenchPacketRecord; created: boolean } }
  | RoadmapToRunPersistFailure

function readHead(sourceRoot: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: sourceRoot,
    encoding: 'utf8',
    timeout: 3_000,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function firstGateMessage(plan: CompiledRunPlan): string | undefined {
  return plan.gates[0]?.message
}

function failureFromPlan(result: Exclude<ReturnType<typeof compileRoadmapToRunPlan>, { ok: true }>): RoadmapToRunPersistFailure {
  return result
}

function planInput(params: {
  run: AgentJob
  sessionId: string
  source: RoadmapSourceAuthority
  roadmap: RoadmapAuthority
  taskId: string
  currentHead: string
  policy: RoadmapPolicyGrantState
}): RoadmapToRunCompilerInput {
  return {
    source: params.source,
    roadmap: params.roadmap,
    taskId: params.taskId,
    run: {
      runId: params.run.id,
      sessionId: params.sessionId,
      sourceId: params.run.sourceId,
      status: params.run.status,
      activeTaskId: params.run.activeTaskId,
      activePacketId: params.run.activePacketId,
      completedPacketIds: params.run.completedPacketIds,
      expectedHead: params.run.currentCommit,
      autoCommit: params.run.autoCommit
    },
    session: {
      sessionId: params.sessionId,
      status: 'active',
      lockedSourceIds: [params.run.sourceId]
    },
    repo: { currentHead: params.currentHead },
    policy: params.policy
  }
}

function effectPacketPaths(task: { packet: { steps: { path: string; to?: string }[] } }): string[] {
  return [...new Set(task.packet.steps.flatMap(step => [step.path, ...(step.to ? [step.to] : [])]))].sort()
}

function policyWithPersistedEffectApprovals(params: {
  run: AgentJob
  sessionId: string
  source: RoadmapSourceAuthority
  roadmap: RoadmapAuthority
  taskId: string
  policy: RoadmapPolicyGrantState
}, options: RoadmapToRunPersistenceOptions): RoadmapPolicyGrantState {
  const task = params.roadmap.phases.flatMap(phase => phase.tasks).find(item => item.id === params.taskId)
  if (!task?.effects || task.effects.length === 0) return params.policy
  const effectApprovals = task.effects.map((effect: RoadmapEffectAuthority) => {
    try {
      return lookupRoadmapEffectApproval({
        sourceId: params.source.sourceId,
        runId: params.run.id,
        sessionId: params.sessionId,
        actorId: params.policy.actorId || 'workbench-operator',
        policyIdentity: params.policy.identity,
        autonomyLevel: params.policy.autonomyLevel,
        phase16Intersection: params.policy.phase16Intersection,
        effect,
        taskPaths: task.paths,
        packetPaths: effectPacketPaths(task),
        capabilities: task.capabilities
      }, options.approvalStoreOptions)
    } catch {
      return undefined
    }
  }).filter((item): item is NonNullable<typeof item> => Boolean(item))
  return { ...params.policy, effectApprovals }
}

function prepareEffectApprovalIntents(params: {
  run: AgentJob
  sessionId: string
  source: RoadmapSourceAuthority
  roadmap: RoadmapAuthority
  taskId: string
  policy: RoadmapPolicyGrantState
  plan: CompiledRunPlan
}, options: RoadmapToRunPersistenceOptions): RoadmapToRunPersistFailure | undefined {
  const task = params.roadmap.phases.flatMap(phase => phase.tasks).find(item => item.id === params.taskId)
  if (!task?.effects || task.effects.length === 0) return undefined
  for (const effect of task.effects) {
    const gate = params.plan.gates.find(item => item.effectType === effect.kind && item.decision === 'requires_confirmation')
    if (!gate) continue
    const prepared = prepareRoadmapEffectApprovalIntent({
      sourceId: params.source.sourceId,
      runId: params.run.id,
      sessionId: params.sessionId,
      actorId: params.policy.actorId || 'workbench-operator',
      policyIdentity: params.policy.identity,
      autonomyLevel: params.policy.autonomyLevel,
      phase16Intersection: params.policy.phase16Intersection,
      effect,
      taskPaths: task.paths,
      packetPaths: effectPacketPaths(task),
      capabilities: task.capabilities,
      requestId: params.plan.planId,
      now: (options.now?.() || new Date()).toISOString(),
      storeOptions: options.approvalStoreOptions
    })
    if (prepared.ok === false) return { ok: false, code: 'EFFECT_APPROVAL_FAILED', message: prepared.message, details: prepared }
  }
  return undefined
}

function packetForPlan(plan: CompiledRunPlan, roadmap: RoadmapAuthority, now: string): WorkbenchPacket | undefined {
  if (!plan.currentPacketId) return undefined
  const compiled = plan.packets.find(packet => packet.packetId === plan.currentPacketId)
  const task = roadmap.phases.flatMap(phase => phase.tasks).find(item => item.id === plan.currentTaskId)
  if (!compiled || !task || !compiled.schedulerReady) return undefined
  return {
    version: 1,
    runId: plan.run.runId,
    packetId: compiled.packetId,
    idempotencyKey: `${plan.run.runId}:${compiled.packetId}`,
    sourceId: plan.source.sourceId,
    taskId: compiled.taskId,
    planId: plan.planId,
    planDigest: plan.planDigest,
    goalSummary: task.title,
    expectedHead: plan.startHead,
    capabilities: compiled.capabilities,
    steps: compiled.steps,
    ...(compiled.localServer ? { localServer: compiled.localServer } : {}),
    ...(compiled.review ? { review: compiled.review } : {}),
    ...(compiled.validation.length > 0 ? { validation: compiled.validation } : {}),
    validationSelection: compiled.validationSelection,
    ...(compiled.commit ? { commit: compiled.commit } : {}),
    createdAt: now
  }
}

function persistPlan(run: AgentJob, plan: CompiledRunPlan, statusPatch: AgentJobUpdate): AgentJob | RoadmapToRunPersistFailure {
  try {
    return updateAgentJob(run.id, {
      ...statusPatch,
      compiledPlan: plan
    })
  } catch (error) {
    return {
      ok: false,
      code: 'RUN_PERSIST_FAILED',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * Compile an explicit roadmap authority into the existing run authority. The
 * compiler is deterministic; this adapter supplies the real persisted run and
 * session and optionally queues the selected Workbench packet in the existing
 * packet store without scheduling or executing it.
 */
export function compileAndPersistRoadmapToRun(params: {
  runId: string
  sessionId: string
  source: RoadmapSourceAuthority
  roadmap: RoadmapAuthority
  taskId: string
  currentHead?: string
  policy: RoadmapPolicyGrantState
}, options: RoadmapToRunPersistenceOptions = {}): RoadmapToRunPersistResult {
  const run = getAgentJob(params.runId)
  if (!run) return { ok: false, code: 'RUN_NOT_FOUND', message: `Workbench run not found: ${params.runId}` }
  const session = getWorkbenchSession(params.sessionId)
  if (!session || 'ok' in session) return { ok: false, code: 'SESSION_NOT_FOUND', message: `Workbench session not found: ${params.sessionId}` }
  if (session.status !== 'active' || session.activeRunId !== run.id || session.lockedSourceIds.length !== 1 || session.lockedSourceIds[0] !== run.sourceId) return { ok: false, code: 'SESSION_LOCK_MISMATCH', message: 'Session is not active and bound to the selected run and source.' }

  let currentHead = String(params.currentHead || '').trim().toLowerCase()
  if (options.sourceRoot) {
    try {
      const observedHead = readHead(options.sourceRoot).toLowerCase()
      if (currentHead && currentHead !== observedHead) return { ok: false, code: 'STALE_HEAD', message: `Supplied HEAD ${currentHead} does not match the repository HEAD ${observedHead}.` }
      currentHead = observedHead
    } catch {
      return { ok: false, code: 'STALE_HEAD', message: 'Unable to resolve the current repository HEAD.' }
    }
  }
  const effectivePolicy = policyWithPersistedEffectApprovals({
    run,
    sessionId: params.sessionId,
    source: params.source,
    roadmap: params.roadmap,
    taskId: params.taskId,
    policy: params.policy
  }, options)
  const result = compileRoadmapToRunPlan(planInput({
    run,
    sessionId: params.sessionId,
    source: params.source,
    roadmap: params.roadmap,
    taskId: params.taskId,
    currentHead,
    policy: effectivePolicy
  }))
  if (result.ok === false) return failureFromPlan(result)

  const approvalFailure = prepareEffectApprovalIntents({
    run,
    sessionId: params.sessionId,
    source: params.source,
    roadmap: params.roadmap,
    taskId: params.taskId,
    policy: effectivePolicy,
    plan: result.plan
  }, options)
  if (approvalFailure) return approvalFailure

  const patch: AgentJobUpdate = result.plan.status === 'ready'
    ? {
        status: 'running',
        startingCommit: run.startingCommit || result.plan.startHead,
        currentCommit: result.plan.startHead,
        activePacketId: result.plan.currentPacketId,
        requiresConfirmation: false,
        confirmationReason: undefined,
        blockedReason: undefined
      }
    : result.plan.status === 'awaiting_gate'
      ? {
          status: 'needs_confirmation',
          activePacketId: undefined,
          requiresConfirmation: true,
          confirmationReason: firstGateMessage(result.plan),
          blockedReason: undefined
        }
      : {
          status: 'blocked',
          activePacketId: undefined,
          requiresConfirmation: false,
          confirmationReason: undefined,
          blockedReason: firstGateMessage(result.plan) || 'Compiled plan is blocked by the Phase 16 policy intersection.'
        }
  const persisted = persistPlan(run, result.plan, patch)
  if ('ok' in persisted) return persisted

  let packet: { record: WorkbenchPacketRecord; created: boolean } | undefined
  if (options.materializePacket !== false && options.sourceRoot && result.plan.status === 'ready') {
    const taskPacket = packetForPlan(result.plan, params.roadmap, (options.now?.() || new Date()).toISOString())
    if (!taskPacket) return { ok: false, code: 'PACKET_PREFLIGHT_FAILED', message: 'A scheduler-ready plan did not contain a materializable current packet.' }
    const preflight = preflightWorkbenchPacket({ packet: taskPacket, sourceRoot: options.sourceRoot })
    if (!preflight.accepted) return { ok: false, code: 'PACKET_PREFLIGHT_FAILED', message: 'Compiled packet failed existing Workbench packet preflight.', details: preflight }
    const reservation = reserveWorkbenchPacket({ packet: taskPacket, exactPaths: preflight.exactPaths || [] })
    if (reservation.ok === false) return { ok: false, code: 'PACKET_RESERVATION_FAILED', message: reservation.message, details: reservation }
    packet = { record: reservation.record, created: reservation.created }
  }
  return { ok: true, plan: result.plan, run: persisted, ...(packet ? { packet } : {}) }
}

export function getPersistedRoadmapToRunPlan(runId: string): CompiledRunPlan | undefined {
  return getAgentJob(runId)?.compiledPlan
}
