import crypto from 'crypto'

export type AgentJobStatus = 'queued' | 'running' | 'needs_confirmation' | 'blocked' | 'completed' | 'failed'
export type AgentJobMode = 'repo_agent'

export type AgentAutonomyLevel = 'supervised' | 'hands_off_safe'

export type AgentJobStep = {
  id: string
  title: string
  status: 'pending' | 'running' | 'completed' | 'blocked'
  action: 'inspect' | 'document_goal' | 'plan' | 'execute_task' | 'review_task' | 'update_docs' | 'validate' | 'repair' | 'git_status' | 'final_report'
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
}

const jobs = new Map<string, AgentJob>()
const MAX_GOAL_LENGTH = 4000
const MAX_ITERATIONS = 20
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

function buildSteps(): AgentJobStep[] {
  return [
    { id: 'inspect', title: 'Inspect repository', status: 'pending', action: 'inspect', description: 'Read source status, active context, file tree, package metadata, and relevant implementation surfaces.' },
    { id: 'document_goal', title: 'Document goal', status: 'pending', action: 'document_goal', description: 'Create or update an implementation note with the goal, assumptions, constraints, task list, and validation plan.' },
    { id: 'plan', title: 'Plan next tasks', status: 'pending', action: 'plan', description: 'Break the goal into small executable tasks with expected files, risks, and validation commands.' },
    { id: 'execute_task', title: 'Execute next task', status: 'pending', action: 'execute_task', description: 'Apply verified repo-local changes only inside allowed roots and stop for no-access or confirmation-required paths.' },
    { id: 'review_task', title: 'Review task output', status: 'pending', action: 'review_task', description: 'Inspect changed files, command output, failures, and policy results before proceeding.' },
    { id: 'update_docs', title: 'Update progress documentation', status: 'pending', action: 'update_docs', description: 'Record completed work, open issues, validation evidence, and the next task before continuing.' },
    { id: 'validate', title: 'Run validation', status: 'pending', action: 'validate', description: 'Use allowlisted package, JSON, security, type-check, test, and git commands.' },
    { id: 'repair', title: 'Repair and repeat', status: 'pending', action: 'repair', description: 'Inspect validation failures, patch again, update documentation, and repeat until clean or blocked.' },
    { id: 'git_status', title: 'Review git state', status: 'pending', action: 'git_status', description: 'Report changed files, staged files, and remaining validation status. Commit/push only if explicitly configured and confirmed.' },
    { id: 'final_report', title: 'Final report', status: 'pending', action: 'final_report', description: 'Summarize what changed, validations, remaining risks, schema/instruction refresh needs, and git state.' }
  ]
}

export function startAgentJob(params: { sourceId: string; goal: string; maxIterations?: number; autonomyLevel?: AgentAutonomyLevel; documentationPath?: string; reviewEveryStep?: boolean; autoCommit?: boolean; autoPush?: boolean }): AgentJob {
  const sourceId = String(params.sourceId || '').trim()
  if (!sourceId) throw new Error('sourceId is required')
  const goal = sanitizeGoal(params.goal)
  const autonomyLevel: AgentAutonomyLevel = params.autonomyLevel === 'supervised' ? 'supervised' : 'hands_off_safe'
  const documentationPath = String(params.documentationPath || 'docs/product/agent-mode-progress.md').replace(/\\/g, '/').replace(/^\/+/, '').trim() || 'docs/product/agent-mode-progress.md'
  const now = new Date().toISOString()
  const job: AgentJob = {
    id: `agent-${crypto.randomUUID()}`,
    sourceId,
    goal,
    mode: 'repo_agent',
    status: 'running',
    createdAt: now,
    updatedAt: now,
    maxIterations: Math.min(MAX_ITERATIONS, Math.max(1, params.maxIterations || 12)),
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
      'Call listBuildFlowSources and confirm source is writable/searchable.',
      `Create or update ${documentationPath} with the goal, task list, progress, validation evidence, and next task.`,
      'Execute one task, review changed files and validation output, update documentation, then continue to the next task.',
      'Do not ask the user unless BuildFlow returns needs_confirmation or blocked for protected/no-access paths.'
    ],
    summary: 'Agentic Goal Mode job started. Continue hands-off through document, plan, execute, review, document, validate, repair, and final report.'
  }
  jobs.set(job.id, job)
  return job
}

export function getAgentJob(jobId: string): AgentJob | undefined {
  return jobs.get(jobId)
}

export function updateAgentJob(jobId: string, patch: Partial<Pick<AgentJob, 'status' | 'currentIteration' | 'blockedReason' | 'requiresConfirmation' | 'confirmationReason' | 'nextActions' | 'summary'>>): AgentJob {
  const job = jobs.get(jobId)
  if (!job) throw new Error(`Agent job not found: ${jobId}`)
  const updated: AgentJob = {
    ...job,
    ...patch,
    updatedAt: new Date().toISOString()
  }
  jobs.set(jobId, updated)
  return updated
}

export function listAgentJobs(): AgentJob[] {
  return Array.from(jobs.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
