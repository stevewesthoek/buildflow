import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { getConfigDir } from '../utils/paths'

export const WORKBENCH_RUN_SCHEMA_VERSION = 1 as const

export type AgentJobStatus = 'queued' | 'running' | 'paused' | 'cancelled' | 'needs_confirmation' | 'blocked' | 'completed' | 'failed'
export type AgentJobMode = 'repo_agent'
export type AgentAutonomyLevel = 'supervised' | 'hands_off_safe'

export type WorkbenchRunResumeState = {
  nextTaskId?: string
  nextFiles: string[]
  nextSymbols: string[]
  instructions: string[]
}

export type WorkbenchRunMetrics = {
  completedPackets: number
  failedPackets: number
  repairAttempts: number
  userSupervisionEvents: number
}

export type AgentJobAction =
  | 'select_source'
  | 'requirements'
  | 'roadmap'
  | 'implementation_plan'
  | 'phase_plan'
  | 'execute_task'
  | 'review_task'
  | 'hardening'
  | 'update_docs'
  | 'validate'
  | 'repair'
  | 'cleanup'
  | 'git_status'
  | 'commit_review'
  | 'final_handoff'

export type AgentJobStep = {
  id: string
  title: string
  status: 'pending' | 'running' | 'completed' | 'blocked'
  action: AgentJobAction
  description: string
}

export type AgentTaskStatus = 'pending' | 'running' | 'completed' | 'blocked' | 'failed' | 'skipped'

export type AgentJobTask = {
  id: string
  title: string
  status: AgentTaskStatus
  description: string
  acceptanceCriteria: string[]
  validation: string[]
  completedAt?: string
  blockedReason?: string
}

export type AgentJobPhase = {
  id: string
  title: string
  status: AgentTaskStatus
  tasks: AgentJobTask[]
}

export type AgentJob = {
  runVersion: typeof WORKBENCH_RUN_SCHEMA_VERSION
  id: string
  sourceId: string
  goal: string
  mode: AgentJobMode
  planVersion: number
  startingCommit?: string
  currentCommit?: string
  activePacketId?: string
  completedPacketIds: string[]
  resumeState: WorkbenchRunResumeState
  metrics: WorkbenchRunMetrics
  status: AgentJobStatus
  createdAt: string
  updatedAt: string
  maxIterations: number
  currentIteration: number
  autonomyLevel: AgentAutonomyLevel
  documentationPath: string
  reviewEveryStep: boolean
  autoCommit: boolean
  autoPush: boolean
  requiresConfirmation: boolean
  confirmationReason?: string
  blockedReason?: string
  steps: AgentJobStep[]
  roadmapPhases: AgentJobPhase[]
  activeTaskId?: string
  completedTaskCount: number
  nextActions: string[]
  summary: string
  handoffPath: string
  resumeInstructions: string[]
  fallbackPrompt?: string
  lastKnownGitStatus?: string
}

export type CompactAgentJob = Pick<
  AgentJob,
  | 'id'
  | 'sourceId'
  | 'status'
  | 'currentIteration'
  | 'maxIterations'
  | 'activeTaskId'
  | 'activePacketId'
  | 'completedTaskCount'
  | 'nextActions'
  | 'summary'
  | 'handoffPath'
  | 'autoCommit'
  | 'autoPush'
  | 'requiresConfirmation'
  | 'confirmationReason'
  | 'blockedReason'
  | 'lastKnownGitStatus'
> & {
  totalTaskCount: number
  activeTask?: {
    id: string
    title: string
    phaseTitle: string
    status: AgentTaskStatus
    acceptanceCriteria: string[]
    validation: string[]
  }
  roadmapSummary: Array<{
    id: string
    title: string
    status: AgentTaskStatus
    completedTasks: number
    totalTasks: number
  }>
}

const jobs = new Map<string, AgentJob>()
const MAX_GOAL_LENGTH = 3000
const MAX_ITERATIONS = 40
const JOB_STORE_PATH = path.join(getConfigDir(), 'agent-jobs.json')
// Compact job payloads are returned to GPT Actions repeatedly; keep summaries short.
const COMPACT_TEXT_LIMIT = 420
const COMPACT_LIST_ITEM_LIMIT = 160
const SECRET_LIKE_PATTERNS = [
  'BEGIN RSA' + ' PRIVATE KEY',
  'BEGIN OPENSSH' + ' PRIVATE KEY',
  'BEGIN EC' + ' PRIVATE KEY',
  'g' + 'hp_',
  'github_' + 'pat_',
  's' + 'k_live_',
  'r' + 'k_live_',
  'xox' + 'b-',
  'A' + 'KIA',
  'A' + 'Iza'
]

function sanitizeGoal(goal: string): string {
  const cleaned = String(goal || '').trim()
  if (!cleaned) throw new Error('goal is required')
  if (cleaned.length > MAX_GOAL_LENGTH) throw new Error(`goal is too long; maximum ${MAX_GOAL_LENGTH} characters`)
  if (SECRET_LIKE_PATTERNS.some(pattern => cleaned.includes(pattern))) throw new Error('goal contains secret-looking content')
  return cleaned
}

function normalizeDocumentationPath(value?: string): string {
  const normalized = String(value || 'docs/product/agent-mode-progress.md')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .trim()
  if (!normalized || normalized.includes('..') || normalized.startsWith('/')) return 'docs/product/agent-mode-progress.md'
  return normalized
}

function buildSteps(): AgentJobStep[] {
  return [
    { id: 'select_source', title: 'Lock source scope', status: 'pending', action: 'select_source', description: 'Confirm the sourceId and use it explicitly for every inspect, read, write, command, and sequential job call.' },
    { id: 'requirements', title: 'Capture requirements', status: 'pending', action: 'requirements', description: 'Extract goals, constraints, acceptance criteria, risks, assumptions, and no-access boundaries from the prompt and repo evidence.' },
    { id: 'roadmap', title: 'Create roadmap', status: 'pending', action: 'roadmap', description: 'Turn requirements into phases with value, dependencies, validation strategy, and stopping conditions.' },
    { id: 'implementation_plan', title: 'Write implementation plan', status: 'pending', action: 'implementation_plan', description: 'Create or update the handoff document with tasks, files, validation commands, rollback notes, and current status.' },
    { id: 'phase_plan', title: 'Plan current phase', status: 'pending', action: 'phase_plan', description: 'Choose the next small task from the roadmap, inspect needed files, and define expected changes before editing.' },
    { id: 'execute_task', title: 'Execute task', status: 'pending', action: 'execute_task', description: 'Apply verified repo-local changes inside allowed roots. Backup or document rollback before risky refactors.' },
    { id: 'review_task', title: 'Review task', status: 'pending', action: 'review_task', description: 'Inspect changed files, command output, errors, security scan results, and acceptance criteria before continuing.' },
    { id: 'update_docs', title: 'Update handoff', status: 'pending', action: 'update_docs', description: 'Persist progress, completed tasks, next task, validation evidence, blockers, and resume instructions after each meaningful chunk.' },
    { id: 'validate', title: 'Validate', status: 'pending', action: 'validate', description: 'Run allowlisted typecheck, tests, JSON validation, package tests, security scans, and git status as applicable.' },
    { id: 'repair', title: 'Repair loop', status: 'pending', action: 'repair', description: 'Investigate failures, patch, update handoff, and repeat until validation is clean or policy blocks progress.' },
    { id: 'hardening', title: 'Harden implementation', status: 'pending', action: 'hardening', description: 'Add edge-case handling, tests, cleanup, docs, security checks, and maintainability improvements.' },
    { id: 'cleanup', title: 'Clean up', status: 'pending', action: 'cleanup', description: 'Remove temporary files inside allowed paths, simplify code, ensure docs are accurate, and preserve useful rollback notes.' },
    { id: 'git_status', title: 'Review git state', status: 'pending', action: 'git_status', description: 'Report changed and staged files. Stage explicit files only. Commit after review when enabled.' },
    { id: 'commit_review', title: 'Commit review', status: 'pending', action: 'commit_review', description: 'Prepare commit message and verify staged file list, cached diff, and validation evidence before committing.' },
    { id: 'final_handoff', title: 'Final handoff', status: 'pending', action: 'final_handoff', description: 'Summarize delivered value, validation results, changed files, risks, follow-ups, and exact resume point if unfinished.' }
  ]
}

function buildDefaultRoadmap(goal: string): AgentJobPhase[] {
  const goalSummary = goal.length > 180 ? `${goal.slice(0, 177)}...` : goal
  return [
    {
      id: 'phase-1-discovery',
      title: 'Discovery and implementation plan',
      status: 'pending',
      tasks: [
        {
          id: 'task-1-requirements-roadmap',
          title: 'Capture requirements and roadmap',
          status: 'pending',
          description: `Inspect the repo and turn the goal into a concrete implementation roadmap: ${goalSummary}`,
          acceptanceCriteria: ['Requirements, risks, phases, and validation strategy are written to the handoff.'],
          validation: ['Read relevant files', 'Create or update the handoff document']
        }
      ]
    },
    {
      id: 'phase-2-implementation',
      title: 'Implementation loop',
      status: 'pending',
      tasks: [
        {
          id: 'task-2-implement-next-slice',
          title: 'Implement the next roadmap slice',
          status: 'pending',
          description: 'Choose the next unchecked roadmap item, make a small verified change, review it, and update the handoff.',
          acceptanceCriteria: ['One meaningful roadmap slice is implemented or explicitly blocked.', 'Changed files are reviewed.'],
          validation: ['Run targeted checks for the changed area']
        },
        {
          id: 'task-3-repair-and-continue',
          title: 'Repair validation failures and continue',
          status: 'pending',
          description: 'If validation fails, repair the issue and continue with the next roadmap item without asking unless blocked by policy or confirmation.',
          acceptanceCriteria: ['Validation failures are repaired or documented as blockers.'],
          validation: ['Rerun failed validation commands']
        }
      ]
    },
    {
      id: 'phase-3-hardening-handoff',
      title: 'Hardening, cleanup, and final handoff',
      status: 'pending',
      tasks: [
        {
          id: 'task-4-final-validation',
          title: 'Run final validation and cleanup',
          status: 'pending',
          description: 'Run appropriate final validation, clean up temporary work, review git state, and prepare final handoff.',
          acceptanceCriteria: ['Validation evidence is recorded.', 'Git status and changed files are summarized.', 'Final handoff says what is complete and what remains.'],
          validation: ['Run applicable type checks/tests', 'Run git_status_short']
        }
      ]
    }
  ]
}

function isTerminalTaskStatus(status: AgentTaskStatus): boolean {
  return status === 'completed' || status === 'blocked' || status === 'failed' || status === 'skipped'
}

function clearsContinuationState(status: AgentJobStatus): boolean {
  return status === 'completed' || status === 'cancelled'
}

function normalizeTask(raw: unknown, fallbackId: string): AgentJobTask {
  const item = raw && typeof raw === 'object' ? raw as Partial<AgentJobTask> : {}
  const status: AgentTaskStatus = ['pending', 'running', 'completed', 'blocked', 'failed', 'skipped'].includes(String(item.status)) ? item.status as AgentTaskStatus : 'pending'
  return {
    id: String(item.id || fallbackId),
    title: String(item.title || fallbackId),
    status,
    description: String(item.description || ''),
    acceptanceCriteria: Array.isArray(item.acceptanceCriteria) ? item.acceptanceCriteria.filter(value => typeof value === 'string') : [],
    validation: Array.isArray(item.validation) ? item.validation.filter(value => typeof value === 'string') : [],
    completedAt: typeof item.completedAt === 'string' ? item.completedAt : undefined,
    blockedReason: typeof item.blockedReason === 'string' ? item.blockedReason : undefined
  }
}

function normalizeRoadmapPhases(raw: unknown, goal: string): AgentJobPhase[] {
  if (!Array.isArray(raw) || raw.length === 0) return buildDefaultRoadmap(goal)
  return raw.map((phase, phaseIndex) => {
    const item = phase && typeof phase === 'object' ? phase as Partial<AgentJobPhase> : {}
    const tasks = Array.isArray(item.tasks) && item.tasks.length > 0
      ? item.tasks.map((task, taskIndex) => normalizeTask(task, `task-${phaseIndex + 1}-${taskIndex + 1}`))
      : [normalizeTask({}, `task-${phaseIndex + 1}-1`)]
    const allTerminal = tasks.every(task => isTerminalTaskStatus(task.status))
    const anyBlocked = tasks.some(task => task.status === 'blocked' || task.status === 'failed')
    const status: AgentTaskStatus = anyBlocked ? 'blocked' : allTerminal ? 'completed' : item.status === 'running' ? 'running' : 'pending'
    return {
      id: String(item.id || `phase-${phaseIndex + 1}`),
      title: String(item.title || `Phase ${phaseIndex + 1}`),
      status,
      tasks
    }
  })
}

function findActiveTaskId(phases: AgentJobPhase[], requested?: string): string | undefined {
  if (requested) {
    const existing = phases.flatMap(phase => phase.tasks).find(task => task.id === requested && !isTerminalTaskStatus(task.status))
    if (existing) return existing.id
  }
  return phases.flatMap(phase => phase.tasks).find(task => !isTerminalTaskStatus(task.status))?.id
}

function countCompletedTasks(phases: AgentJobPhase[]): number {
  return phases.flatMap(phase => phase.tasks).filter(task => task.status === 'completed' || task.status === 'skipped').length
}

function describeActiveTask(phases: AgentJobPhase[], activeTaskId?: string): string | undefined {
  if (!activeTaskId) return undefined
  for (const phase of phases) {
    const task = phase.tasks.find(item => item.id === activeTaskId)
    if (task) return `${phase.title} → ${task.title}`
  }
  return undefined
}

function buildLoopNextActions(documentationPath: string, phases: AgentJobPhase[], activeTaskId?: string): string[] {
  const activeTask = describeActiveTask(phases, activeTaskId)
  if (!activeTask) {
    return [
      'All roadmap tasks are terminal. Run final validation, update the handoff, review git status, and mark the job completed.',
      `Update ${documentationPath} with final validation evidence and remaining follow-ups.`
    ]
  }
  return [
    `Continue active roadmap task: ${activeTask}.`,
    'Inspect only the files needed for this task, make the smallest verified change, then review the diff.',
    `Update ${documentationPath} after the task with completed work, validation evidence, blockers, rollback notes, and the next active task.`,
    'Continue to the next pending task until the roadmap is complete, blocked, failed, or confirmation is required.'
  ]
}

function ensureJobStoreDir(): void {
  fs.mkdirSync(path.dirname(JOB_STORE_PATH), { recursive: true })
}

function coerceJob(raw: unknown): AgentJob | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Partial<AgentJob>
  if (!item.id || !item.sourceId || !item.goal || !item.createdAt) return null
  const documentationPath = normalizeDocumentationPath(item.documentationPath)
  const roadmapPhases = normalizeRoadmapPhases(item.roadmapPhases, String(item.goal))
  const status = item.status || 'running'
  const continuationCleared = clearsContinuationState(status)
  const activeTaskId = continuationCleared ? undefined : findActiveTaskId(roadmapPhases, item.activeTaskId)
  const completedTaskCount = countCompletedTasks(roadmapPhases)
  return {
    runVersion: WORKBENCH_RUN_SCHEMA_VERSION,
    id: String(item.id),
    sourceId: String(item.sourceId),
    goal: String(item.goal),
    mode: 'repo_agent',
    planVersion: Math.max(1, Number(item.planVersion || 1)),
    startingCommit: typeof item.startingCommit === 'string' ? item.startingCommit : undefined,
    currentCommit: typeof item.currentCommit === 'string' ? item.currentCommit : undefined,
    completedPacketIds: Array.isArray(item.completedPacketIds) ? item.completedPacketIds.filter(value => typeof value === 'string') : [],
    resumeState: {
      nextTaskId: continuationCleared ? undefined : typeof item.resumeState?.nextTaskId === 'string' ? item.resumeState.nextTaskId : activeTaskId,
      nextFiles: continuationCleared ? [] : Array.isArray(item.resumeState?.nextFiles) ? item.resumeState.nextFiles.filter(value => typeof value === 'string') : [],
      nextSymbols: continuationCleared ? [] : Array.isArray(item.resumeState?.nextSymbols) ? item.resumeState.nextSymbols.filter(value => typeof value === 'string') : [],
      instructions: continuationCleared ? [] : Array.isArray(item.resumeState?.instructions) ? item.resumeState.instructions.filter(value => typeof value === 'string') : buildResumeInstructions(documentationPath)
    },
    metrics: {
      completedPackets: Math.max(0, Number(item.metrics?.completedPackets || 0)),
      failedPackets: Math.max(0, Number(item.metrics?.failedPackets || 0)),
      repairAttempts: Math.max(0, Number(item.metrics?.repairAttempts || 0)),
      userSupervisionEvents: Math.max(0, Number(item.metrics?.userSupervisionEvents || 0))
    },
    status,
    createdAt: String(item.createdAt),
    updatedAt: String(item.updatedAt || item.createdAt),
    maxIterations: Math.min(MAX_ITERATIONS, Math.max(1, Number(item.maxIterations || 12))),
    currentIteration: Math.max(0, Number(item.currentIteration || 0)),
    autonomyLevel: item.autonomyLevel === 'supervised' ? 'supervised' : 'hands_off_safe',
    documentationPath,
    reviewEveryStep: item.reviewEveryStep !== false,
    autoCommit: item.autoCommit !== false,
    autoPush: item.autoPush === true,
    requiresConfirmation: item.status === 'needs_confirmation' || item.requiresConfirmation === true,
    confirmationReason: item.status === 'needs_confirmation' || item.requiresConfirmation === true ? item.confirmationReason : undefined,
    blockedReason: item.blockedReason,
    steps: Array.isArray(item.steps) && item.steps.length > 0 ? item.steps : buildSteps(),
    roadmapPhases,
    activeTaskId,
    completedTaskCount,
    nextActions: continuationCleared
      ? []
      : Array.isArray(item.nextActions)
        ? item.nextActions
        : buildLoopNextActions(documentationPath, roadmapPhases, activeTaskId),
    summary: item.summary || 'Sequential job loaded from persistent roadmap state. Continue the active task, update the handoff, validate, repair, commit, and advance until the bounded batch is complete or blocked.',
    handoffPath: item.handoffPath || documentationPath,
    resumeInstructions: continuationCleared
      ? []
      : Array.isArray(item.resumeInstructions)
        ? item.resumeInstructions
        : buildResumeInstructions(documentationPath),
    fallbackPrompt: item.fallbackPrompt,
    lastKnownGitStatus: item.lastKnownGitStatus
  }
}

function loadJobsFromDisk(): void {
  try {
    if (!fs.existsSync(JOB_STORE_PATH)) return
    const parsed = JSON.parse(fs.readFileSync(JOB_STORE_PATH, 'utf8')) as { jobs?: unknown[] }
    for (const raw of parsed.jobs || []) {
      const job = coerceJob(raw)
      if (job) jobs.set(job.id, job)
    }
  } catch {
    // Ignore corrupted job state; repo-local handoff docs remain the recovery source of truth.
  }
}

function persistJobs(): void {
  ensureJobStoreDir()
  const payload = {
    version: 2,
    runSchemaVersion: WORKBENCH_RUN_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    jobs: Array.from(jobs.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
  const temporaryPath = `${JOB_STORE_PATH}.tmp`
  fs.writeFileSync(temporaryPath, JSON.stringify(payload), 'utf8')
  fs.renameSync(temporaryPath, JOB_STORE_PATH)
}

function buildResumeInstructions(documentationPath: string): string[] {
  return [
    `Read ${documentationPath} first; treat it as the resume handoff and current source of truth.`,
    'Verify the locked sourceId before inspecting, writing, or running commands.',
    'Run git_status_short and inspect changed files before continuing.',
    'Continue with the next unchecked task, then update the handoff after each meaningful chunk.',
    'After validation passes, stage explicit changed files and commit with a clear message.',
    'Push only if the user explicitly asks for a push.',
    'Stop only for blocked/no-access paths, failed validation that needs user choice, or protected destructive operations.'
  ]
}

function buildFallbackPrompt(job: Pick<AgentJob, 'sourceId' | 'goal' | 'documentationPath' | 'handoffPath' | 'summary' | 'blockedReason' | 'confirmationReason' | 'lastKnownGitStatus' | 'roadmapPhases' | 'activeTaskId' | 'completedTaskCount'>): string {
  const activeTask = describeActiveTask(job.roadmapPhases, job.activeTaskId) || 'none'
  const totalTasks = job.roadmapPhases.flatMap(phase => phase.tasks).length
  return [
    'You are continuing a BuildFlow sequential job directly inside the local repo.',
    '',
    `Source ID: ${job.sourceId}`,
    `Goal: ${job.goal}`,
    `Handoff path: ${job.handoffPath || job.documentationPath}`,
    `Current summary: ${job.summary || 'No summary recorded.'}`,
    `Roadmap progress: ${job.completedTaskCount}/${totalTasks} tasks completed.`,
    `Active task: ${activeTask}`,
    job.blockedReason ? `Blocked reason: ${job.blockedReason}` : undefined,
    job.confirmationReason ? `Confirmation reason: ${job.confirmationReason}` : undefined,
    job.lastKnownGitStatus ? `Last known git status:\n${job.lastKnownGitStatus}` : undefined,
    '',
    'Instructions:',
      '1. Read the handoff path first and treat it as the resume state.',
      '2. Verify the current repo, branch, and git status before editing.',
      '3. Continue with the next unfinished task from the handoff.',
      '4. Keep all changes source-relative and do not expose secrets.',
      '5. Update the handoff after each meaningful chunk with completed work, validation evidence, next task, blockers, and resume notes.',
      '6. Run the relevant tests/validation, repair failures, and continue until the goal is complete or a hard no-access boundary is reached.',
      '7. If the work is correct and validated, stage explicit files only and write a clear commit message.',
      '8. Push only if the user explicitly asks for a push.',
      '9. Do not force-push.'
  ].filter(Boolean).join('\n')
}

loadJobsFromDisk()

export function startAgentJob(params: { sourceId: string; goal: string; maxIterations?: number; autonomyLevel?: AgentAutonomyLevel; documentationPath?: string; reviewEveryStep?: boolean; autoCommit?: boolean; autoPush?: boolean }): AgentJob {
  const sourceId = String(params.sourceId || '').trim()
  if (!sourceId) throw new Error('sourceId is required')
  const goal = sanitizeGoal(params.goal)
  const autonomyLevel: AgentAutonomyLevel = params.autonomyLevel === 'supervised' ? 'supervised' : 'hands_off_safe'
  const documentationPath = normalizeDocumentationPath(params.documentationPath)
  const now = new Date().toISOString()
  const resumeInstructions = buildResumeInstructions(documentationPath)
  const roadmapPhases = buildDefaultRoadmap(goal)
  const activeTaskId = findActiveTaskId(roadmapPhases)
  const completedTaskCount = countCompletedTasks(roadmapPhases)
  const job: AgentJob = {
    runVersion: WORKBENCH_RUN_SCHEMA_VERSION,
    id: `agent-${crypto.randomUUID()}`,
    sourceId,
    goal,
    mode: 'repo_agent',
    planVersion: 1,
    startingCommit: undefined,
    currentCommit: undefined,
    completedPacketIds: [],
    resumeState: {
      nextTaskId: activeTaskId,
      nextFiles: [],
      nextSymbols: [],
      instructions: resumeInstructions
    },
    metrics: {
      completedPackets: 0,
      failedPackets: 0,
      repairAttempts: 0,
      userSupervisionEvents: 0
    },
    status: 'running',
    createdAt: now,
    updatedAt: now,
    maxIterations: Math.min(MAX_ITERATIONS, Math.max(1, params.maxIterations || 20)),
    currentIteration: 0,
    autonomyLevel,
    documentationPath,
    reviewEveryStep: params.reviewEveryStep !== false,
    autoCommit: params.autoCommit !== false,
    autoPush: params.autoPush === true,
    requiresConfirmation: false,
    confirmationReason: undefined,
    steps: buildSteps(),
    roadmapPhases,
    activeTaskId,
    completedTaskCount,
    nextActions: buildLoopNextActions(documentationPath, roadmapPhases, activeTaskId),
    summary: 'Sequential job started with persistent roadmap state. Continue the active task, update the handoff, validate, repair, and commit task-by-task until the bounded batch is complete or a hard blocker is reached.',
    handoffPath: documentationPath,
    resumeInstructions
  }
  jobs.set(job.id, job)
  persistJobs()
  return job
}

export function getAgentJob(jobId: string): AgentJob | undefined {
  if (jobs.size === 0) loadJobsFromDisk()
  return jobs.get(jobId)
}

export type AgentJobUpdate = Partial<Pick<AgentJob,
  | 'status'
  | 'currentIteration'
  | 'blockedReason'
  | 'requiresConfirmation'
  | 'confirmationReason'
  | 'nextActions'
  | 'summary'
  | 'lastKnownGitStatus'
  | 'roadmapPhases'
  | 'activeTaskId'
  | 'completedTaskCount'
  | 'planVersion'
  | 'startingCommit'
  | 'currentCommit'
  | 'activePacketId'
  | 'completedPacketIds'
  | 'resumeState'
  | 'metrics'
>>

export function updateAgentJob(jobId: string, patch: AgentJobUpdate): AgentJob {
  const job = getAgentJob(jobId)
  if (!job) throw new Error(`Agent job not found: ${jobId}`)
  const roadmapPhases = normalizeRoadmapPhases(patch.roadmapPhases || job.roadmapPhases, job.goal)
  const status = patch.status || job.status
  const continuationCleared = clearsContinuationState(status)
  const requestedActiveTaskId = Object.prototype.hasOwnProperty.call(patch, 'activeTaskId') ? patch.activeTaskId : job.activeTaskId
  const activeTaskId = continuationCleared ? undefined : findActiveTaskId(roadmapPhases, requestedActiveTaskId)
  const completedTaskCount = countCompletedTasks(roadmapPhases)
  const resumeInstructions = continuationCleared
    ? []
    : job.resumeInstructions && job.resumeInstructions.length > 0
      ? job.resumeInstructions
      : buildResumeInstructions(job.documentationPath)
  const completedPacketIds = Array.from(new Set((patch.completedPacketIds || job.completedPacketIds).filter(Boolean)))
  const resumeState: WorkbenchRunResumeState = continuationCleared
    ? { nextTaskId: undefined, nextFiles: [], nextSymbols: [], instructions: [] }
    : {
        nextTaskId: patch.resumeState?.nextTaskId || activeTaskId,
        nextFiles: Array.from(new Set(patch.resumeState?.nextFiles || job.resumeState.nextFiles)),
        nextSymbols: Array.from(new Set(patch.resumeState?.nextSymbols || job.resumeState.nextSymbols)),
        instructions: patch.resumeState?.instructions?.length
          ? patch.resumeState.instructions
          : job.resumeState.instructions.length > 0
            ? job.resumeState.instructions
            : resumeInstructions
      }
  const metrics: WorkbenchRunMetrics = {
    completedPackets: Math.max(0, Number(patch.metrics?.completedPackets ?? completedPacketIds.length ?? job.metrics.completedPackets)),
    failedPackets: Math.max(0, Number(patch.metrics?.failedPackets ?? job.metrics.failedPackets)),
    repairAttempts: Math.max(0, Number(patch.metrics?.repairAttempts ?? job.metrics.repairAttempts)),
    userSupervisionEvents: Math.max(0, Number(patch.metrics?.userSupervisionEvents ?? job.metrics.userSupervisionEvents))
  }
  const base: AgentJob = {
    ...job,
    ...patch,
    runVersion: WORKBENCH_RUN_SCHEMA_VERSION,
    planVersion: Math.max(job.planVersion, Number(patch.planVersion || job.planVersion)),
    completedPacketIds,
    resumeState,
    metrics,
    roadmapPhases,
    activeTaskId,
    completedTaskCount,
    nextActions: Array.isArray(patch.nextActions)
      ? patch.nextActions
      : continuationCleared
        ? []
        : buildLoopNextActions(job.documentationPath, roadmapPhases, activeTaskId),
    updatedAt: new Date().toISOString(),
    resumeInstructions,
    handoffPath: job.handoffPath || job.documentationPath
  }
  const shouldRefreshFallback = base.status === 'blocked' || base.status === 'failed' || base.status === 'needs_confirmation' || Boolean(base.blockedReason || base.confirmationReason)
  const updated: AgentJob = {
    ...base,
    fallbackPrompt: shouldRefreshFallback ? buildFallbackPrompt(base) : base.fallbackPrompt
  }
  jobs.set(jobId, updated)
  persistJobs()
  return updated
}

export function advanceWorkbenchRunAfterPacket(params: {
  runId: string
  taskId: string
  packetId: string
  commitHash?: string
}): AgentJob {
  const job = getAgentJob(params.runId)
  if (!job) throw new Error(`Agent job not found: ${params.runId}`)

  const completedAt = new Date().toISOString()
  let matchedTask = false
  const roadmapPhases = job.roadmapPhases.map(phase => ({
    ...phase,
    tasks: phase.tasks.map(task => {
      if (task.id !== params.taskId) return task
      matchedTask = true
      return {
        ...task,
        status: 'completed' as const,
        completedAt,
        blockedReason: undefined
      }
    })
  }))
  if (!matchedTask) throw new Error(`Run task not found: ${params.taskId}`)

  const initiallyNormalized = normalizeRoadmapPhases(roadmapPhases, job.goal)
  const nextTaskId = findActiveTaskId(initiallyNormalized)
  const normalized = normalizeRoadmapPhases(initiallyNormalized.map(phase => ({
    ...phase,
    tasks: phase.tasks.map(task => task.id === nextTaskId && task.status === 'pending'
      ? { ...task, status: 'running' as const }
      : task)
  })), job.goal)
  const allTasks = normalized.flatMap(phase => phase.tasks)
  const hasFailedTask = allTasks.some(task => task.status === 'failed')
  const hasBlockedTask = allTasks.some(task => task.status === 'blocked')
  const allComplete = allTasks.every(task => task.status === 'completed' || task.status === 'skipped')
  const status: AgentJobStatus = hasFailedTask ? 'failed' : hasBlockedTask ? 'blocked' : allComplete ? 'completed' : 'running'
  const nextActions = status === 'completed'
    ? ['Run final handoff review and inspect repository status.']
    : nextTaskId
      ? [`Continue roadmap task ${nextTaskId}.`]
      : []

  return updateAgentJob(params.runId, {
    roadmapPhases: normalized,
    activeTaskId: nextTaskId,
    currentIteration: Math.min(job.maxIterations, job.currentIteration + 1),
    completedPacketIds: Array.from(new Set([...job.completedPacketIds, params.packetId])),
    currentCommit: params.commitHash || job.currentCommit,
    status,
    blockedReason: hasBlockedTask ? 'One or more roadmap tasks are blocked.' : undefined,
    nextActions,
    resumeState: {
      nextTaskId,
      nextFiles: [],
      nextSymbols: [],
      instructions: status === 'completed'
        ? ['Review final validation evidence, update the handoff, and inspect git status.']
        : nextTaskId
          ? [`Resume with roadmap task ${nextTaskId}.`]
          : []
    },
    metrics: {
      ...job.metrics,
      completedPackets: Array.from(new Set([...job.completedPacketIds, params.packetId])).length
    },
    summary: status === 'completed'
      ? `Packet ${params.packetId} completed task ${params.taskId}; all roadmap tasks are complete.`
      : `Packet ${params.packetId} completed task ${params.taskId}; next task is ${nextTaskId}.`
  })
}

export function listAgentJobs(): AgentJob[] {
  if (jobs.size === 0) loadJobsFromDisk()
  return Array.from(jobs.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

function compactText(value: string | undefined, limit = COMPACT_TEXT_LIMIT): string | undefined {
  if (!value) return undefined
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value
}

function compactList(values: string[], limit = 4): string[] {
  return values.slice(0, limit).map(value => compactText(value, COMPACT_LIST_ITEM_LIMIT) || '')
}

export function compactAgentJob(job: AgentJob): CompactAgentJob {
  const tasks = job.roadmapPhases.flatMap(phase => phase.tasks.map(task => ({ phase, task })))
  const active = tasks.find(item => item.task.id === job.activeTaskId)

  return {
    id: job.id,
    sourceId: job.sourceId,
    status: job.status,
    currentIteration: job.currentIteration,
    maxIterations: job.maxIterations,
    activeTaskId: job.activeTaskId,
    activePacketId: job.activePacketId,
    completedTaskCount: job.completedTaskCount,
    totalTaskCount: tasks.length,
    nextActions: compactList(job.nextActions, 3),
    summary: compactText(job.summary) || '',
    handoffPath: job.handoffPath,
    autoCommit: job.autoCommit,
    autoPush: job.autoPush,
    requiresConfirmation: job.requiresConfirmation,
    confirmationReason: compactText(job.confirmationReason, 300),
    blockedReason: compactText(job.blockedReason, 300),
    lastKnownGitStatus: compactText(job.lastKnownGitStatus, 700),
    activeTask: active ? {
      id: active.task.id,
      title: active.task.title,
      phaseTitle: active.phase.title,
      status: active.task.status,
      acceptanceCriteria: compactList(active.task.acceptanceCriteria, 3),
      validation: compactList(active.task.validation, 3)
    } : undefined,
    roadmapSummary: job.roadmapPhases.map(phase => ({
      id: phase.id,
      title: phase.title,
      status: phase.status,
      completedTasks: phase.tasks.filter(task => task.status === 'completed' || task.status === 'skipped').length,
      totalTasks: phase.tasks.length
    }))
  }
}


export type AgentJobControlAction = 'pause' | 'resume' | 'cancel'

export function controlAgentJob(jobId: string, action: AgentJobControlAction, reason?: string): AgentJob {
  const job = getAgentJob(jobId)
  if (!job) throw new Error(`Agent job not found: ${jobId}`)
  const safeReason = reason ? String(reason).slice(0, COMPACT_TEXT_LIMIT) : undefined
  if (action === 'pause') {
    if (job.status !== 'running' && job.status !== 'queued') throw new Error(`Cannot pause job in ${job.status} state`)
    return updateAgentJob(jobId, {
      status: 'paused',
      summary: safeReason ? `Sequential run paused: ${safeReason}` : 'Sequential run paused.',
      nextActions: ['Resume, cancel, or ask Custom GPT for targeted reasoning/coding before continuing.']
    })
  }
  if (action === 'resume') {
    if (job.status !== 'paused') throw new Error(`Cannot resume job in ${job.status} state`)
    return updateAgentJob(jobId, {
      status: 'running',
      summary: safeReason ? `Sequential run resumed: ${safeReason}` : 'Sequential run resumed.',
      nextActions: ['Local deterministic runtime can continue. Poll compact status/events for progress.']
    })
  }
  if (action === 'cancel') {
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') throw new Error(`Cannot cancel job in ${job.status} state`)
    return updateAgentJob(jobId, {
      status: 'cancelled',
      summary: safeReason ? `Sequential run cancelled: ${safeReason}` : 'Sequential run cancelled.',
      nextActions: ['Start a new bounded sequential job when ready.'],
      blockedReason: undefined,
      requiresConfirmation: false,
      confirmationReason: undefined
    })
  }
  throw new Error(`Unsupported agent control action: ${action}`)
}




export function getActiveWorkbenchRun(sourceId: string): Record<string, unknown> | undefined {
  const normalizedSourceId = String(sourceId || '').trim()
  if (!normalizedSourceId) return undefined
  const active = listAgentJobs().find(job =>
    job.sourceId === normalizedSourceId && !['completed', 'failed', 'cancelled'].includes(job.status)
  )
  if (!active) return undefined
  const compact = compactAgentJob(active)
  return {
    runVersion: active.runVersion,
    id: active.id,
    sourceId: active.sourceId,
    goal: compactText(active.goal, 500),
    status: active.status,
    planVersion: active.planVersion,
    startingCommit: active.startingCommit,
    currentCommit: active.currentCommit,
    completedPacketIds: active.completedPacketIds.slice(-20),
    resumeState: {
      nextTaskId: active.resumeState.nextTaskId,
      nextFiles: active.resumeState.nextFiles.slice(0, 5),
      nextSymbols: active.resumeState.nextSymbols.slice(0, 5),
      instructions: compactList(active.resumeState.instructions, 4)
    },
    metrics: active.metrics,
    activeTask: compact.activeTask,
    roadmapSummary: compact.roadmapSummary,
    completedTaskCount: compact.completedTaskCount,
    totalTaskCount: compact.totalTaskCount,
    summary: compact.summary,
    nextActions: compact.nextActions,
    handoffPath: compact.handoffPath,
    requiresConfirmation: compact.requiresConfirmation,
    confirmationReason: compact.confirmationReason,
    blockedReason: compact.blockedReason,
    updatedAt: active.updatedAt
  }
}




export function createWorkbenchRun(params: Parameters<typeof startAgentJob>[0]): { run: AgentJob; created: boolean } {
  const sourceId = String(params.sourceId || '').trim()
  if (!sourceId) throw new Error('sourceId is required')
  const existing = listAgentJobs().find(job =>
    job.sourceId === sourceId && !['completed', 'failed', 'cancelled'].includes(job.status)
  )
  if (existing) {
    if (existing.goal.trim() === String(params.goal || '').trim()) return { run: existing, created: false }
    throw new Error(`Source already has an active Workbench run: ${existing.id}`)
  }
  return { run: startAgentJob(params), created: true }
}

export function resumeWorkbenchRun(params: { sourceId: string; runId?: string }): AgentJob {
  const sourceId = String(params.sourceId || '').trim()
  if (!sourceId) throw new Error('sourceId is required')
  const run = params.runId
    ? getAgentJob(params.runId)
    : listAgentJobs().find(job => job.sourceId === sourceId && !['completed', 'failed', 'cancelled'].includes(job.status))
  if (!run || run.sourceId !== sourceId) throw new Error('Active Workbench run not found for source')
  if (['completed', 'failed', 'cancelled'].includes(run.status)) throw new Error(`Workbench run cannot resume from ${run.status}`)
  if (run.status === 'blocked' || run.status === 'needs_confirmation') {
    throw new Error(`Workbench run requires resolution before resume: ${run.status}`)
  }
  if (run.status === 'running') return run
  return updateAgentJob(run.id, {
    status: 'running',
    metrics: {
      ...run.metrics,
      userSupervisionEvents: run.metrics.userSupervisionEvents + 1
    },
    summary: `Workbench run resumed. Continue task ${run.resumeState.nextTaskId || run.activeTaskId || 'from the persisted handoff'}.`
  })
}

export function closeWorkbenchRun(params: { sourceId: string; runId: string; summary: string }): AgentJob {
  const sourceId = String(params.sourceId || '').trim()
  const runId = String(params.runId || '').trim()
  const summary = String(params.summary || '').trim()
  if (!sourceId) throw new Error('sourceId is required')
  if (!runId) throw new Error('runId is required')
  if (!summary) throw new Error('summary is required')
  const run = getAgentJob(runId)
  if (!run || run.sourceId !== sourceId) throw new Error('Workbench run not found for source')
  if (['completed', 'failed', 'cancelled'].includes(run.status)) throw new Error(`Workbench run is already terminal: ${run.status}`)
  return updateAgentJob(run.id, {
    status: 'completed',
    activeTaskId: undefined,
    summary,
    resumeState: {
      nextTaskId: undefined,
      nextFiles: [],
      nextSymbols: [],
      instructions: []
    }
  })
}
