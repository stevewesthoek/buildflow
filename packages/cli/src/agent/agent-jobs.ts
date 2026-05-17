import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { getConfigDir } from '../utils/paths'

export type AgentJobStatus = 'queued' | 'running' | 'needs_confirmation' | 'blocked' | 'completed' | 'failed'
export type AgentJobMode = 'repo_agent'
export type AgentAutonomyLevel = 'supervised' | 'hands_off_safe'

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
  id: string
  sourceId: string
  goal: string
  mode: AgentJobMode
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

const jobs = new Map<string, AgentJob>()
const MAX_GOAL_LENGTH = 4000
const MAX_ITERATIONS = 40
const JOB_STORE_PATH = path.join(getConfigDir(), 'agent-jobs.json')
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
    { id: 'select_source', title: 'Lock source scope', status: 'pending', action: 'select_source', description: 'Confirm the sourceId and use it explicitly for every inspect, read, write, command, and Agent Mode call.' },
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
    { id: 'git_status', title: 'Review git state', status: 'pending', action: 'git_status', description: 'Report changed and staged files. Stage explicit files only. Commit/push only when configured and confirmed.' },
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
  const activeTaskId = findActiveTaskId(roadmapPhases, item.activeTaskId)
  const completedTaskCount = countCompletedTasks(roadmapPhases)
  return {
    id: String(item.id),
    sourceId: String(item.sourceId),
    goal: String(item.goal),
    mode: 'repo_agent',
    status: item.status || 'running',
    createdAt: String(item.createdAt),
    updatedAt: String(item.updatedAt || item.createdAt),
    maxIterations: Math.min(MAX_ITERATIONS, Math.max(1, Number(item.maxIterations || 12))),
    currentIteration: Math.max(0, Number(item.currentIteration || 0)),
    autonomyLevel: item.autonomyLevel === 'supervised' ? 'supervised' : 'hands_off_safe',
    documentationPath,
    reviewEveryStep: item.reviewEveryStep !== false,
    autoCommit: item.autoCommit === true,
    autoPush: item.autoPush === true,
    requiresConfirmation: item.requiresConfirmation === true,
    confirmationReason: item.confirmationReason,
    blockedReason: item.blockedReason,
    steps: Array.isArray(item.steps) && item.steps.length > 0 ? item.steps : buildSteps(),
    roadmapPhases,
    activeTaskId,
    completedTaskCount,
    nextActions: Array.isArray(item.nextActions) && item.nextActions.length > 0 ? item.nextActions : buildLoopNextActions(documentationPath, roadmapPhases, activeTaskId),
    summary: item.summary || 'Agent Mode job loaded from persistent roadmap state. Continue the active task, update the handoff, validate, repair, and advance until all roadmap tasks are complete or blocked.',
    handoffPath: item.handoffPath || documentationPath,
    resumeInstructions: Array.isArray(item.resumeInstructions) ? item.resumeInstructions : buildResumeInstructions(documentationPath),
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
    version: 1,
    updatedAt: new Date().toISOString(),
    jobs: Array.from(jobs.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
  fs.writeFileSync(JOB_STORE_PATH, JSON.stringify(payload), 'utf8')
}

function buildResumeInstructions(documentationPath: string): string[] {
  return [
    `Read ${documentationPath} first; treat it as the resume handoff and current source of truth.`,
    'Verify the locked sourceId before inspecting, writing, or running commands.',
    'Run git_status_short and inspect changed files before continuing.',
    'Continue with the next unchecked task, then update the handoff after each meaningful chunk.',
    'Stop only for blocked/no-access paths, failed validation that needs user choice, or confirmation-gated push/destructive operations.'
  ]
}

function buildFallbackPrompt(job: Pick<AgentJob, 'sourceId' | 'goal' | 'documentationPath' | 'handoffPath' | 'summary' | 'blockedReason' | 'confirmationReason' | 'lastKnownGitStatus' | 'roadmapPhases' | 'activeTaskId' | 'completedTaskCount'>): string {
  const activeTask = describeActiveTask(job.roadmapPhases, job.activeTaskId) || 'none'
  const totalTasks = job.roadmapPhases.flatMap(phase => phase.tasks).length
  return [
    'You are continuing a BuildFlow Agent Mode job directly inside the local repo.',
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
    '7. If committing, stage explicit files only and write a clear commit message. Do not force-push.'
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
    id: `agent-${crypto.randomUUID()}`,
    sourceId,
    goal,
    mode: 'repo_agent',
    status: 'running',
    createdAt: now,
    updatedAt: now,
    maxIterations: Math.min(MAX_ITERATIONS, Math.max(1, params.maxIterations || 20)),
    currentIteration: 0,
    autonomyLevel,
    documentationPath,
    reviewEveryStep: params.reviewEveryStep !== false,
    autoCommit: params.autoCommit === true,
    autoPush: params.autoPush === true,
    requiresConfirmation: params.autoCommit === true || params.autoPush === true,
    confirmationReason: params.autoCommit || params.autoPush ? 'git_commit_or_push_requires_confirmation' : undefined,
    steps: buildSteps(),
    roadmapPhases,
    activeTaskId,
    completedTaskCount,
    nextActions: buildLoopNextActions(documentationPath, roadmapPhases, activeTaskId),
    summary: 'Agent Mode started with persistent roadmap state. Continue the active task, update the handoff, validate, repair, and advance task-by-task until all roadmap phases are complete, blocked, failed, or confirmation is required.',
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

export function updateAgentJob(jobId: string, patch: Partial<Pick<AgentJob, 'status' | 'currentIteration' | 'blockedReason' | 'requiresConfirmation' | 'confirmationReason' | 'nextActions' | 'summary' | 'lastKnownGitStatus' | 'roadmapPhases' | 'activeTaskId' | 'completedTaskCount'>>): AgentJob {
  const job = getAgentJob(jobId)
  if (!job) throw new Error(`Agent job not found: ${jobId}`)
  const roadmapPhases = normalizeRoadmapPhases(patch.roadmapPhases || job.roadmapPhases, job.goal)
  const activeTaskId = findActiveTaskId(roadmapPhases, patch.activeTaskId || job.activeTaskId)
  const completedTaskCount = countCompletedTasks(roadmapPhases)
  const base: AgentJob = {
    ...job,
    ...patch,
    roadmapPhases,
    activeTaskId,
    completedTaskCount,
    nextActions: Array.isArray(patch.nextActions) && patch.nextActions.length > 0
      ? patch.nextActions
      : buildLoopNextActions(job.documentationPath, roadmapPhases, activeTaskId),
    updatedAt: new Date().toISOString(),
    resumeInstructions: job.resumeInstructions && job.resumeInstructions.length > 0 ? job.resumeInstructions : buildResumeInstructions(job.documentationPath),
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

export function listAgentJobs(): AgentJob[] {
  if (jobs.size === 0) loadJobsFromDisk()
  return Array.from(jobs.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}
