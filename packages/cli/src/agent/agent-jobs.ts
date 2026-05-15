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
  nextActions: string[]
  summary: string
  handoffPath: string
  resumeInstructions: string[]
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

function ensureJobStoreDir(): void {
  fs.mkdirSync(path.dirname(JOB_STORE_PATH), { recursive: true })
}

function coerceJob(raw: unknown): AgentJob | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Partial<AgentJob>
  if (!item.id || !item.sourceId || !item.goal || !item.createdAt) return null
  const documentationPath = normalizeDocumentationPath(item.documentationPath)
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
    nextActions: Array.isArray(item.nextActions) ? item.nextActions : [],
    summary: item.summary || 'Agent Mode job loaded from persistent handoff state.',
    handoffPath: item.handoffPath || documentationPath,
    resumeInstructions: Array.isArray(item.resumeInstructions) ? item.resumeInstructions : buildResumeInstructions(documentationPath),
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
    'Stop only for blocked/no-access paths, failed validation that needs user choice, or confirmation-gated commit/push/destructive operations.'
  ]
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
    nextActions: [
      'Lock this conversation to sourceId and pass sourceId explicitly on every action.',
      `Create or update ${documentationPath} with requirements, roadmap, phases, tasks, progress, validation evidence, rollback notes, and next resume step.`,
      'Execute one meaningful chunk, review it, validate it, update the handoff, then continue until done or blocked.',
      'Give compact progress summaries; do not ask the user unless policy requires confirmation, source scope is ambiguous, or validation needs a human choice.'
    ],
    summary: 'Agent Mode started with persistent handoff. Continue requirements → roadmap → plan → execute → review → docs → validate → repair → harden → cleanup → git review → final handoff.',
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

export function updateAgentJob(jobId: string, patch: Partial<Pick<AgentJob, 'status' | 'currentIteration' | 'blockedReason' | 'requiresConfirmation' | 'confirmationReason' | 'nextActions' | 'summary' | 'lastKnownGitStatus'>>): AgentJob {
  const job = getAgentJob(jobId)
  if (!job) throw new Error(`Agent job not found: ${jobId}`)
  const updated: AgentJob = {
    ...job,
    ...patch,
    updatedAt: new Date().toISOString(),
    resumeInstructions: job.resumeInstructions && job.resumeInstructions.length > 0 ? job.resumeInstructions : buildResumeInstructions(job.documentationPath),
    handoffPath: job.handoffPath || job.documentationPath
  }
  jobs.set(jobId, updated)
  persistJobs()
  return updated
}

export function listAgentJobs(): AgentJob[] {
  if (jobs.size === 0) loadJobsFromDisk()
  return Array.from(jobs.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}
