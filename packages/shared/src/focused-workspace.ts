import type { KnowledgeSource } from './types'

export type FocusedWorkspaceRecord = {
  version: 1
  sourceId: string
  sourcePath: string
  repoGroupId?: string
  repoRoot?: string
  branchName?: string
  isGitWorktree?: boolean
  updatedAt: string
}

export type ResumeWorkspaceCandidate = {
  id: string
  label: string
  sourceIds: string[]
  worktreeCount: number
  worktrees?: Array<{ sourceId: string; label: string; branchName?: string }>
}

export type ResumeActiveRun = {
  sourceId: string
  status: string
  [key: string]: unknown
}

export type ResumeNavigationProjection =
  | { status: 'ACTIVE_RUN'; workspace: ResumeWorkspace; activeRun: ResumeActiveRun; nextAction: string }
  | { status: 'BLOCKED_RUN'; workspace: ResumeWorkspace; activeRun: ResumeActiveRun; nextAction: string }
  | { status: 'IDLE_READY'; workspace: ResumeWorkspace; activeRun: null; nextAction: string }
  | { status: 'FOCUS_STALE'; focusedWorkspace: FocusedWorkspaceRecord; activeRun: null; nextAction: string }
  | { status: 'SOURCE_SELECTION_REQUIRED'; reason: 'no_focus' | 'multiple_sources' | 'multiple_active_runs' | 'active_run_source_unavailable' | 'no_enabled_sources'; candidates: ResumeWorkspaceCandidate[]; activeRun: null; nextAction: string }

export type ResumeWorkspace = {
  sourceId: string
  label: string
  repositoryId: string
  repoRoot?: string
  branchName?: string
  isGitWorktree?: boolean
  worktree?: { sourceId: string; label: string; branchName?: string }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function repositoryMembers(source: KnowledgeSource, sources: readonly KnowledgeSource[]): KnowledgeSource[] {
  const repositoryId = source.repoGroupId || `source:${source.id}`
  return sources.filter(item => item.enabled && (item.repoGroupId || `source:${item.id}`) === repositoryId)
}

function workspaceFor(source: KnowledgeSource, sources: readonly KnowledgeSource[]): ResumeWorkspace {
  const members = repositoryMembers(source, sources)
  const primary = members.find(item => item.isGitWorktree !== true || item.path === item.repoRoot) || source
  return {
    sourceId: source.id,
    label: primary.label,
    repositoryId: source.repoGroupId || `source:${source.id}`,
    ...(primary.repoRoot ? { repoRoot: primary.repoRoot } : source.repoRoot ? { repoRoot: source.repoRoot } : {}),
    ...(source.branchName ? { branchName: source.branchName } : {}),
    ...(source.isGitWorktree !== undefined ? { isGitWorktree: source.isGitWorktree } : {}),
    ...(source.isGitWorktree === true ? {
      worktree: {
        sourceId: source.id,
        label: source.label,
        ...(source.branchName ? { branchName: source.branchName } : {})
      }
    } : {})
  }
}

function sameOptional(left: string | boolean | undefined, right: string | boolean | undefined): boolean {
  return left === undefined || left === right
}

function matchesFocus(focus: FocusedWorkspaceRecord, source: KnowledgeSource): boolean {
  return focus.sourceId === source.id
    && focus.sourcePath === source.path
    && sameOptional(focus.repoGroupId, source.repoGroupId)
    && sameOptional(focus.repoRoot, source.repoRoot)
    && sameOptional(focus.branchName, source.branchName)
    && sameOptional(focus.isGitWorktree, source.isGitWorktree)
}

function primarySource(members: KnowledgeSource[]): KnowledgeSource | undefined {
  const ordered = [...members].sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id))
  return ordered.find(source => source.isGitWorktree !== true || source.path === source.repoRoot) || ordered[0]
}

function candidatesFor(sources: KnowledgeSource[]): ResumeWorkspaceCandidate[] {
  const buckets = new Map<string, KnowledgeSource[]>()
  for (const source of sources.filter(item => item.enabled && nonEmpty(item.id))) {
    const id = source.repoGroupId || `source:${source.id}`
    buckets.set(id, [...(buckets.get(id) || []), source])
  }
  return Array.from(buckets.entries())
    .sort(([, left], [, right]) => (primarySource(left)?.label || '').localeCompare(primarySource(right)?.label || ''))
    .map(([id, members]) => {
      const ordered = [...members].sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id))
      const primary = primarySource(ordered)
      const repositoryMembers = primary ? [primary, ...ordered.filter(source => source.id !== primary.id)] : ordered
      const worktrees = repositoryMembers.filter(source => source.isGitWorktree === true).map(source => ({
        sourceId: source.id,
        label: source.label,
        ...(source.branchName ? { branchName: source.branchName } : {})
      }))
      return {
        id,
        label: primary?.label || id,
        sourceIds: repositoryMembers.map(source => source.id),
        worktreeCount: worktrees.length,
        ...(worktrees.length > 0 ? { worktrees: worktrees.slice(0, 8) } : {})
      }
    }).slice(0, 20)
}

function isActiveRun(run: ResumeActiveRun): boolean {
  return ['queued', 'running', 'needs_confirmation', 'blocked'].includes(run.status)
}

export function resolveResumeNavigation(params: {
  sources: readonly KnowledgeSource[]
  focusedWorkspace?: FocusedWorkspaceRecord
  activeRuns?: readonly ResumeActiveRun[]
}): ResumeNavigationProjection {
  const sources = params.sources.filter(source => nonEmpty(source.id))
  const enabledSources = sources.filter(source => source.enabled)
  const activeRuns = (params.activeRuns || []).filter(isActiveRun)
  if (activeRuns.length > 1) {
    return {
      status: 'SOURCE_SELECTION_REQUIRED',
      reason: 'multiple_active_runs',
      candidates: candidatesFor(enabledSources),
      activeRun: null,
      nextAction: 'Choose the named repository run to inspect; never choose by source ID or array order.'
    }
  }
  if (activeRuns.length === 1) {
    const activeRun = activeRuns[0]
    const source = sources.find(item => item.id === activeRun.sourceId && item.enabled)
    if (source) {
      const workspace = workspaceFor(source, sources)
      return {
        status: activeRun.status === 'blocked' ? 'BLOCKED_RUN' : 'ACTIVE_RUN',
        workspace,
        activeRun,
        nextAction: activeRun.status === 'blocked' ? 'Review the blocked run and its next action.' : 'Inspect the active run; do not create a new run.'
      }
    }
    return {
      status: 'SOURCE_SELECTION_REQUIRED',
      reason: 'active_run_source_unavailable',
      candidates: candidatesFor(enabledSources),
      activeRun: null,
      nextAction: 'The active run source is unavailable; restore or enable that named repository before continuing.'
    }
  }

  if (params.focusedWorkspace) {
    const source = sources.find(item => item.id === params.focusedWorkspace?.sourceId)
    if (!source || !source.enabled || !matchesFocus(params.focusedWorkspace, source)) {
      return {
        status: 'FOCUS_STALE',
        focusedWorkspace: params.focusedWorkspace,
        activeRun: null,
        nextAction: 'Re-select the named repository in the native sidebar before resuming.'
      }
    }
    return {
      status: 'IDLE_READY',
      workspace: workspaceFor(source, sources),
      activeRun: null,
      nextAction: 'Continue in the focused repository; no active run is currently running.'
    }
  }

  if (enabledSources.length === 1) {
    return {
      status: 'IDLE_READY',
      workspace: workspaceFor(enabledSources[0], sources),
      activeRun: null,
      nextAction: 'Continue in the only enabled repository; no active run is currently running.'
    }
  }
  return {
    status: 'SOURCE_SELECTION_REQUIRED',
    reason: enabledSources.length === 0 ? 'no_enabled_sources' : 'no_focus',
    candidates: candidatesFor(enabledSources),
    activeRun: null,
    nextAction: enabledSources.length === 0 ? 'Enable or add one repository before resuming.' : 'Choose a named repository before resuming; never guess.'
  }
}
