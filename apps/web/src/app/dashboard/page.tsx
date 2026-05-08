'use client'

import { useState, useEffect, useRef } from 'react'
import type { FormEvent } from 'react'
import type { KnowledgeSource, WriteMode, ActiveSourcesMode, DiscoveredRepository } from '@buildflow/shared'
import { DashboardTopBar } from './components/DashboardTopBar'
import { DashboardShell } from './components/DashboardShell'
import { DashboardOverview } from './components/DashboardOverview'
import { PlanPlaceholderPanel } from './components/PlanPlaceholderPanel'
import { ExecutionFlowPreview } from './components/ExecutionFlowPreview'
import { ExecutionHandoffPanel } from './components/ExecutionHandoffPanel'
import { KnowledgeSourcesPanel } from './components/KnowledgeSourcesPanel'
import { ActiveContextPanel } from './components/ActiveContextPanel'
import { InfoPanels } from './components/InfoPanels'
import { InsightPanel } from './components/InsightPanel'
import { DashboardRail } from './components/DashboardRail'
import { DashboardActivityFeed } from './components/DashboardActivityFeed'
import { SetupChecklistPanel } from './components/SetupChecklistPanel'
import { DashboardButton } from './components/ui/DashboardButton'
import { DashboardPanel } from './components/ui/DashboardPanel'
import { DashboardCodeText } from './components/ui/DashboardCodeText'
import { buildClaudeHandoffPrompt, buildCodexHandoffPrompt } from './handoffPrompts'
import type { DashboardActivityEvent, DashboardLocalPlan, DashboardPlanTaskStatus, DashboardSection, DashboardSourceSnapshot } from './types'

const TERMINAL_INDEX_STATUSES = new Set(['ready', 'failed', 'disabled'])

const DASHBOARD_SOURCE_CACHE_KEY = 'buildflow-dashboard-source-snapshot'
const DASHBOARD_LOCAL_PLAN_CACHE_KEY = 'buildflow-dashboard-local-plan'
type FetchSourcesOptions = {
  blocking?: boolean
}

const SECTION_LABELS: Record<DashboardSection, string> = {
  overview: 'Overview',
  sources: 'Sources',
  activity: 'Activity',
  plan: 'Plans',
  handoff: 'Handoff',
  settings: 'Settings'
}

const summarizeMode = (mode: ActiveSourcesMode) => {
  switch (mode) {
    case 'single':
      return 'Single source'
    case 'multi':
      return 'Multi-source'
    case 'all':
      return 'All enabled'
  }
}

const summarizeWriteMode = (mode: WriteMode) => {
  switch (mode) {
    case 'readOnly':
      return 'Read only'
    case 'artifactsOnly':
      return 'Artifacts only'
    case 'safeWrites':
      return 'Safe writes'
  }
}

const sleep = (ms: number) => new Promise(resolve => globalThis.setTimeout(resolve, ms))

const getAgentErrorMessage = (data: Record<string, unknown> | null | undefined, fallback: string) => {
  const error = typeof data?.error === 'string' ? data.error : fallback
  const detail = typeof data?.details === 'string' ? data.details : typeof data?.detail === 'string' ? data.detail : ''
  return `${error}${detail ? ` ${detail}` : ''}`.trim()
}

const readSourceSnapshot = (): DashboardSourceSnapshot | null => {
  try {
    const raw = window.localStorage.getItem(DASHBOARD_SOURCE_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<DashboardSourceSnapshot>
    if (!Array.isArray(parsed.sources)) return null
    return {
      sources: parsed.sources,
      activeMode: parsed.activeMode || 'all',
      activeSourceIds: Array.isArray(parsed.activeSourceIds) ? parsed.activeSourceIds : [],
      writeMode: parsed.writeMode || 'safeWrites',
      savedAt: parsed.savedAt || new Date(0).toISOString()
    }
  } catch {
    return null
  }
}

const saveSourceSnapshot = (snapshot: DashboardSourceSnapshot) => {
  try {
    window.localStorage.setItem(DASHBOARD_SOURCE_CACHE_KEY, JSON.stringify(snapshot))
  } catch {
    // Local storage is a convenience cache only. Ignore quota/private-mode failures.
  }
}

const readLocalPlan = (): DashboardLocalPlan | null => {
  try {
    const raw = window.localStorage.getItem(DASHBOARD_LOCAL_PLAN_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<DashboardLocalPlan>
    if (!parsed.id || !parsed.title || !Array.isArray(parsed.tasks)) return null
    return {
      id: parsed.id,
      title: parsed.title,
      summary: parsed.summary || 'Local dashboard plan',
      sourceId: parsed.sourceId || null,
      createdAt: parsed.createdAt || new Date().toISOString(),
      updatedAt: parsed.updatedAt || new Date().toISOString(),
      tasks: parsed.tasks.map((task, index) => ({
        id: task.id || `task-${index + 1}`,
        title: task.title || `Task ${index + 1}`,
        detail: task.detail || 'Review and complete this local task.',
        status: task.status || 'pending'
      }))
    }
  } catch {
    return null
  }
}

const saveLocalPlan = (plan: DashboardLocalPlan | null) => {
  try {
    if (!plan) {
      window.localStorage.removeItem(DASHBOARD_LOCAL_PLAN_CACHE_KEY)
      return
    }
    window.localStorage.setItem(DASHBOARD_LOCAL_PLAN_CACHE_KEY, JSON.stringify(plan))
  } catch {
    // Local plan persistence is convenience-only. Ignore storage failures.
  }
}

const normalizeImportedPlan = (value: unknown): DashboardLocalPlan | null => {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<DashboardLocalPlan>
  if (typeof candidate.title !== 'string' || !Array.isArray(candidate.tasks)) return null
  const now = new Date().toISOString()
  const tasks: DashboardLocalPlan['tasks'] = candidate.tasks
    .filter(task => task && typeof task === 'object')
    .map((task, index) => {
      const item = task as Partial<DashboardLocalPlan['tasks'][number]>
      const status: DashboardPlanTaskStatus =
        item.status === 'active' || item.status === 'done' || item.status === 'blocked' ? item.status : 'pending'
      return {
        id: typeof item.id === 'string' && item.id.trim() ? item.id : `imported-task-${index + 1}`,
        title: typeof item.title === 'string' && item.title.trim() ? item.title : `Imported task ${index + 1}`,
        detail: typeof item.detail === 'string' && item.detail.trim() ? item.detail : 'Review and complete this imported local task.',
        status
      }
    })
  if (tasks.length === 0) return null
  return {
    id: typeof candidate.id === 'string' && candidate.id.trim() ? candidate.id : `imported-plan-${Date.now()}`,
    title: candidate.title.trim(),
    summary: typeof candidate.summary === 'string' && candidate.summary.trim() ? candidate.summary : 'Imported local dashboard plan',
    sourceId: typeof candidate.sourceId === 'string' && candidate.sourceId.trim() ? candidate.sourceId : null,
    createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : now,
    updatedAt: now,
    tasks
  }
}

const createDashboardPlan = (args: {
  sources: KnowledgeSource[]
  selectedSource: KnowledgeSource | null
  agentConnected: boolean
}): DashboardLocalPlan => {
  const now = new Date().toISOString()
  const scope = args.selectedSource || args.sources.find(source => source.enabled && source.indexStatus === 'ready') || args.sources[0] || null
  const scopeLabel = scope?.label || 'workspace'
  const readyCount = args.sources.filter(source => source.enabled && source.indexStatus === 'ready').length
  const tasks = [
    {
      id: 'review-context',
      title: `Review ${scopeLabel} context`,
      detail: scope ? `Inspect ${scope.path} and confirm the next implementation target.` : 'Add or select a local source before implementation work.',
      status: 'active' as const
    },
    {
      id: 'draft-implementation',
      title: 'Draft the next scoped implementation step',
      detail: 'Use the current source state and recent activity to define one narrow BuildFlow Local task.',
      status: 'pending' as const
    },
    {
      id: 'prepare-handoff',
      title: 'Prepare execution handoff',
      detail: 'Copy the dynamic Codex or Claude prompt from the Handoff view with the current plan context.',
      status: 'pending' as const
    },
    {
      id: 'validate-result',
      title: 'Validate and record outcome',
      detail: 'Run type-checks, public-scope audit, and relevant dashboard/source validation before committing.',
      status: 'pending' as const
    }
  ]

  return {
    id: `local-plan-${Date.now()}`,
    title: scope ? `BuildFlow Local plan · ${scope.label}` : 'BuildFlow Local workspace plan',
    summary: `${readyCount} ready sources · ${args.agentConnected ? 'agent connected' : 'agent offline'} · local-only workflow`,
    sourceId: scope?.id || null,
    createdAt: now,
    updatedAt: now,
    tasks
  }
}

const buildActivityEntries = (args: {
  loading: boolean
  error: string | null
  mutationError: string | null
  mutationNotice: string | null
  sources: KnowledgeSource[]
  agentConnected: boolean
  activeMode: ActiveSourcesMode
  writeMode: WriteMode
}): DashboardActivityEvent[] => {
  const readyCount = args.sources.filter(source => source.enabled && source.indexStatus === 'ready').length
  const indexingCount = args.sources.filter(source => source.enabled && source.indexStatus === 'indexing').length
  const failedCount = args.sources.filter(source => source.enabled && source.indexStatus === 'failed').length
  const now = new Date().toISOString()
  const entries: DashboardActivityEvent[] = []
  const makeEvent = (type: string, title: string, detail: string, tone: DashboardActivityEvent['tone']) => ({
    id: `${type}-${detail}-${now}`,
    type,
    title,
    detail,
    timestamp: now,
    tone
  })

  if (args.loading) {
    entries.push(makeEvent('refresh-start', 'Loading workspace', 'BuildFlow is fetching the latest source, context, and write-mode state.', 'neutral'))
  } else if (args.agentConnected) {
    entries.push(makeEvent('agent-connected', 'Agent connected', 'The local agent is available and the dashboard can refresh source state.', 'good'))
  } else {
    entries.push(makeEvent('agent-unavailable', 'Agent unavailable', 'BuildFlow could not reach the local agent right now.', 'warn'))
  }

  const sourceSummary =
    indexingCount > 0
      ? 'Some sources are still indexing.'
      : failedCount > 0
        ? 'Some sources need attention.'
        : readyCount > 0
          ? 'Sources are ready.'
          : 'No sources are connected yet.'
  entries.push(makeEvent('source-summary', 'Source summary', sourceSummary, readyCount > 0 ? 'good' : indexingCount > 0 ? 'warn' : 'neutral'))
  entries.push(makeEvent('context-mode', 'Context mode', `Active context is set to ${args.activeMode}.`, 'neutral'))
  entries.push(makeEvent('write-mode', 'Write mode', `Current write mode: ${args.writeMode}.`, 'neutral'))

  if (args.mutationNotice) {
    entries.unshift(makeEvent('notice', 'Dashboard notice', args.mutationNotice, 'good'))
  }

  if (args.mutationError) {
    entries.unshift(makeEvent('mutation-error', 'Source action error', args.mutationError, 'bad'))
  }

  if (args.error) {
    entries.unshift(makeEvent('refresh-failed', 'Source refresh issue', args.error, 'warn'))
  }

  return entries.slice(0, 8)
}

const fetchJsonWithRetry = async (url: string, attempts = 3): Promise<{ response: Response; data: Record<string, unknown> }> => {
  let lastError: unknown

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { cache: 'no-store' })
      const data = await response.json().catch(() => ({})) as Record<string, unknown>
      if ([502, 503, 504].includes(response.status) && attempt < attempts) {
        await sleep(350 * attempt)
        continue
      }
      return { response, data }
    } catch (err) {
      lastError = err
      if (attempt < attempts) {
        await sleep(350 * attempt)
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

const getMutationErrorMessage = (data: any, err: unknown, fallback: string) => {
  const fromData = typeof data?.userMessage === 'string'
    ? data.userMessage
    : typeof data?.message === 'string'
      ? data.message
      : typeof data?.error === 'string'
        ? data.error
        : ''
  if (fromData) return fromData
  if (err instanceof Error && err.message) return err.message
  if (typeof err === 'string' && err) return err
  return fallback
}

export default function Dashboard() {
  const [sources, setSources] = useState<KnowledgeSource[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [theme, setTheme] = useState<'light' | 'dark'>('dark')
  const [agentConnected, setAgentConnected] = useState(false)
  const [sourcePath, setSourcePath] = useState('')
  const [sourceLabel, setSourceLabel] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [discoveryRootPath, setDiscoveryRootPath] = useState('')
  const [discoveryIntervalMinutes, setDiscoveryIntervalMinutes] = useState(30)
  const [discoveredRepos, setDiscoveredRepos] = useState<DiscoveredRepository[]>([])
  const [selectedDiscoveredRepoPath, setSelectedDiscoveredRepoPath] = useState('')
  const [discoveryLoading, setDiscoveryLoading] = useState(false)
  const [discoveryError, setDiscoveryError] = useState<string | null>(null)
  const [mutationLoading, setMutationLoading] = useState(false)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [mutationNotice, setMutationNotice] = useState<string | null>(null)
  const [loadErrorDetail, setLoadErrorDetail] = useState<string | null>(null)
  const [activeMode, setActiveMode] = useState<ActiveSourcesMode>('all')
  const [activeSourceIds, setActiveSourceIds] = useState<string[]>([])
  const [writeMode, setWriteMode] = useState<WriteMode>('safeWrites')
  const [handoffCopyStatus, setHandoffCopyStatus] = useState<'idle' | 'codex-copied' | 'claude-copied' | 'error'>('idle')
  const [activeDashboardSection, setActiveDashboardSection] = useState<DashboardSection>('overview')
  const [showAddSourceForm, setShowAddSourceForm] = useState(false)
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)
  const [activityEvents, setActivityEvents] = useState<DashboardActivityEvent[]>([])
  const [localPlan, setLocalPlan] = useState<DashboardLocalPlan | null>(null)
  const [localPlanImportError, setLocalPlanImportError] = useState<string | null>(null)
  const [setupCopyStatus, setSetupCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle')

  const addSourceFormRef = useRef<HTMLFormElement>(null)
  const snapshotRef = useRef<DashboardSourceSnapshot | null>(null)
  const themeInitializedRef = useRef(false)
  const snapshotHydratedRef = useRef(false)
  const activityEventSeqRef = useRef(0)
  const currentSectionLabel = SECTION_LABELS[activeDashboardSection]
  const openApiUrl = typeof window === 'undefined' ? '/api/openapi' : `${window.location.origin}/api/openapi`

  const copySetupOpenApiUrl = async () => {
    try {
      await navigator.clipboard.writeText(openApiUrl)
      setSetupCopyStatus('copied')
      recordActivity('setup-openapi-copied', 'OpenAPI URL copied', openApiUrl, 'good')
      setTimeout(() => setSetupCopyStatus('idle'), 2000)
    } catch {
      setSetupCopyStatus('error')
      recordActivity('setup-openapi-copy-failed', 'OpenAPI copy failed', 'Could not copy the OpenAPI URL from the dashboard.', 'bad')
      setTimeout(() => setSetupCopyStatus('idle'), 2000)
    }
  }

  const copyToClipboard = async (
    text: string,
    status: 'codex-copied' | 'claude-copied',
    activityType: 'handoff-codex-copied' | 'handoff-claude-copied',
    title: string
  ) => {
    try {
      await navigator.clipboard.writeText(text)
      setHandoffCopyStatus(status)
      recordActivity(activityType, title, `${currentSectionLabel} prompt copied to clipboard.`, 'good')
      setTimeout(() => setHandoffCopyStatus('idle'), 2000)
    } catch {
      setHandoffCopyStatus('error')
      setTimeout(() => setHandoffCopyStatus('idle'), 2000)
    }
  }

  const pushActivityEvent = (event: Omit<DashboardActivityEvent, 'id' | 'timestamp'> & { timestamp?: string }) => {
    activityEventSeqRef.current += 1
    const nextEvent: DashboardActivityEvent = {
      id: `${event.type}-${activityEventSeqRef.current}`,
      timestamp: event.timestamp || new Date().toISOString(),
      ...event
    }
    setActivityEvents(current => [nextEvent, ...current].slice(0, 40))
  }

  const recordActivity = (type: string, title: string, detail: string, tone: DashboardActivityEvent['tone'] = 'neutral') => {
    pushActivityEvent({ type, title, detail, tone })
  }

  const activityFeedEntries = activityEvents.length > 0
    ? activityEvents
    : buildActivityEntries({
        loading,
        error,
        mutationError,
        mutationNotice,
        sources,
        agentConnected,
        activeMode,
        writeMode
      })
  const activeSourceCount = activeSourceIds.length
  const readySourceCount = sources.filter(source => source.enabled && source.indexStatus === 'ready').length
  const selectedSource = selectedSourceId ? sources.find(source => source.id === selectedSourceId) ?? null : null
  const codexPrompt = buildCodexHandoffPrompt({
    sources,
    selectedSource,
    activeMode,
    activeSourceIds,
    writeMode,
    agentConnected,
    activityFeedEntries,
    localPlan,
    currentSection: currentSectionLabel
  })
  const claudeCodePrompt = buildClaudeHandoffPrompt({
    sources,
    selectedSource,
    activeMode,
    activeSourceIds,
    writeMode,
    agentConnected,
    activityFeedEntries,
    localPlan,
    currentSection: currentSectionLabel
  })
  const handoffSelectedSourceLabel = selectedSource ? `${selectedSource.label} · ${selectedSource.id}` : null
  const handoffSourceSummary = `${sources.length} sources · ${readySourceCount} ready · ${activeSourceCount} active`

  const handleCreateLocalPlan = () => {
    const nextPlan = createDashboardPlan({ sources, selectedSource, agentConnected })
    setLocalPlan(nextPlan)
    recordActivity('local-plan-created', 'Local plan created', `${nextPlan.title} · ${nextPlan.tasks.length} tasks`, 'good')
  }

  const handleUpdatePlanTaskStatus = (taskId: string, status: DashboardPlanTaskStatus) => {
    const task = localPlan?.tasks.find(item => item.id === taskId)
    setLocalPlan(current => {
      if (!current) return current
      return {
        ...current,
        updatedAt: new Date().toISOString(),
        tasks: current.tasks.map(item => item.id === taskId ? { ...item, status } : item)
      }
    })
    if (task) {
      recordActivity('local-plan-task-updated', 'Plan task updated', `${task.title} · ${status}`, status === 'done' ? 'good' : status === 'blocked' ? 'warn' : 'neutral')
    }
  }

  const handleClearLocalPlan = () => {
    setLocalPlanImportError(null)
    setLocalPlan(null)
    recordActivity('local-plan-cleared', 'Local plan cleared', 'The in-browser dashboard plan was cleared.', 'warn')
  }

  const handleExportLocalPlan = () => {
    if (!localPlan) {
      setLocalPlanImportError('Create or import a plan before exporting.')
      return
    }
    setLocalPlanImportError(null)
    const blob = new Blob([JSON.stringify(localPlan, null, 2)], { type: 'application/json' })
    const url = window.URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${localPlan.id || 'buildflow-local-plan'}.json`
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.URL.revokeObjectURL(url)
    recordActivity('local-plan-exported', 'Local plan exported', `${localPlan.title} was downloaded as JSON.`, 'good')
  }

  const handleImportLocalPlan = async (file: File) => {
    try {
      const text = await file.text()
      const parsed = JSON.parse(text)
      const nextPlan = normalizeImportedPlan(parsed)
      if (!nextPlan) {
        throw new Error('This file is not a valid BuildFlow Local plan JSON file.')
      }
      setLocalPlanImportError(null)
      setLocalPlan(nextPlan)
      recordActivity('local-plan-imported', 'Local plan imported', `${nextPlan.title} · ${nextPlan.tasks.length} tasks`, 'good')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not import this local plan.'
      setLocalPlanImportError(message)
      recordActivity('local-plan-import-failed', 'Local plan import failed', message, 'bad')
    }
  }

  const handleOpenHandoff = () => {
    setActiveDashboardSection('handoff')
    recordActivity('handoff-opened', 'Handoff opened', 'Dynamic handoff prompts are ready for the current workspace.', 'neutral')
  }

  const fetchSources = async (options: FetchSourcesOptions = {}) => {
    const snapshot = snapshotRef.current
    const blocking = options.blocking ?? (!snapshot && sources.length === 0)
    let fetchedSources: KnowledgeSource[] = snapshot?.sources ?? sources
    let fetchedActiveMode: ActiveSourcesMode = snapshot?.activeMode ?? activeMode
    let fetchedActiveIds: string[] = snapshot?.activeSourceIds ?? activeSourceIds
    let fetchedWriteMode: WriteMode = snapshot?.writeMode ?? writeMode
    try {
      setError(null)
      setLoadErrorDetail(null)
      const { response, data } = await fetchJsonWithRetry('/api/agent/sources')
      if (!response.ok) {
        throw new Error(getAgentErrorMessage(data, `Failed to fetch sources: ${response.status}`))
      }

      fetchedSources = Array.isArray(data.sources) ? data.sources as KnowledgeSource[] : []
      setSources(fetchedSources)
      setAgentConnected(true)
      const { response: activeResponse, data: activeData } = await fetchJsonWithRetry('/api/agent/active-sources')
      if (!activeResponse.ok) {
        setMutationNotice(getAgentErrorMessage(activeData, `Active source state was not refreshed: ${activeResponse.status}`))
      } else {
        fetchedActiveMode = (activeData.mode as ActiveSourcesMode) || 'all'
        fetchedActiveIds = Array.isArray(activeData.activeSourceIds) ? activeData.activeSourceIds as string[] : []
        setActiveMode(fetchedActiveMode)
        setActiveSourceIds(fetchedActiveIds)
      }
      const { response: writeResponse, data: writeData } = await fetchJsonWithRetry('/api/agent/write-mode')
      if (!writeResponse.ok) {
        setMutationNotice(getAgentErrorMessage(writeData, `Write mode was not refreshed: ${writeResponse.status}`))
      } else {
        fetchedWriteMode = (writeData.writeMode as WriteMode) || 'safeWrites'
        setWriteMode(fetchedWriteMode)
      }
      const nextSnapshot: DashboardSourceSnapshot = {
        sources: fetchedSources,
        activeMode: fetchedActiveMode,
        activeSourceIds: fetchedActiveIds,
        writeMode: fetchedWriteMode,
        savedAt: new Date().toISOString()
      }
      snapshotRef.current = nextSnapshot
      saveSourceSnapshot(nextSnapshot)
      setAgentConnected(true)
      recordActivity(
        'refresh-completed',
        'Refresh completed',
        `${fetchedSources.length} sources synced, ${fetchedActiveIds.length} active, write mode ${fetchedWriteMode}.`,
        'good'
      )
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setLoadErrorDetail(message)
      if (blocking && !snapshotRef.current) {
        setError('Unable to load sources')
      } else {
        setError(null)
        setMutationNotice(
          `BuildFlow agent was briefly unavailable while refreshing source state. Retry refresh if this does not update. ${message}`
        )
      }
      recordActivity('refresh-failed', 'Refresh failed', message, 'warn')
      if (fetchedSources.length > 0) {
        setSources(fetchedSources)
      }
      setActiveMode(fetchedActiveMode)
      setActiveSourceIds(fetchedActiveIds)
      setWriteMode(fetchedWriteMode)
      setAgentConnected(false)
      return false
    } finally {
      setLoading(false)
    }
  }

  const fetchRepositoryDiscovery = async (settings?: { rootPath?: string; intervalMinutes?: number }) => {
    setDiscoveryLoading(true)
    setDiscoveryError(null)
    try {
      const response = await fetch('/api/agent/sources/discovery', {
        cache: 'no-store',
        method: settings ? 'POST' : 'GET',
        headers: settings ? { 'Content-Type': 'application/json' } : undefined,
        body: settings ? JSON.stringify(settings) : undefined
      })
      const data = await response.json().catch(() => ({})) as Record<string, unknown>
      if (!response.ok) throw new Error(getMutationErrorMessage(data, null, `Repository discovery failed: ${response.status}`))
      const discoverySettings = data.settings as { rootPath?: string; intervalMinutes?: number; lastScannedAt?: string } | undefined
      const repositories = Array.isArray(data.repositories) ? data.repositories as DiscoveredRepository[] : []
      setDiscoveryRootPath(discoverySettings?.rootPath || settings?.rootPath || '')
      setDiscoveryIntervalMinutes(discoverySettings?.intervalMinutes || settings?.intervalMinutes || 30)
      setDiscoveredRepos(repositories)
      setSelectedDiscoveredRepoPath(current => current && repositories.some(repo => repo.path === current && !repo.alreadyAdded) ? current : repositories.find(repo => !repo.alreadyAdded)?.path || '')
      recordActivity('repository-discovery-scanned', 'Repository discovery updated', `${repositories.length} repositories found.`, 'good')
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setDiscoveryError(message)
      recordActivity('repository-discovery-failed', 'Repository discovery failed', message, 'warn')
      return false
    } finally {
      setDiscoveryLoading(false)
    }
  }

  const handleSelectSource = (sourceId: string) => {
    if (selectedSourceId === sourceId) return
    setSelectedSourceId(sourceId)
    const source = sources.find(item => item.id === sourceId)
    recordActivity('source-selected', 'Source selected', source ? `${source.label} · ${source.path}` : sourceId, 'neutral')
  }

  const handleToggleActiveSource = async (sourceId: string) => {
    const source = sources.find(item => item.id === sourceId)
    const isDeactivating = activeSourceIds.includes(sourceId)
    const next = activeSourceIds.includes(sourceId)
      ? activeSourceIds.filter(id => id !== sourceId)
      : [...activeSourceIds, sourceId]
    const success = await mutateSources('/api/agent/active-sources', { mode: next.length > 1 ? 'multi' : 'single', activeSourceIds: next })
    if (success) {
      recordActivity(
        isDeactivating ? 'source-deactivated' : 'source-activated',
        isDeactivating ? 'Source deactivated' : 'Source activated',
        source ? `${source.label} · ${next.length > 0 ? 'context updated' : 'no active sources'}` : `Source ${sourceId} updated`,
        'good'
      )
    }
  }

  useEffect(() => {
    if (snapshotHydratedRef.current) return
    snapshotHydratedRef.current = true

    const snapshot = readSourceSnapshot()
    snapshotRef.current = snapshot
    if (snapshot) {
      setSources(snapshot.sources)
      setActiveMode(snapshot.activeMode)
      setActiveSourceIds(snapshot.activeSourceIds)
      setWriteMode(snapshot.writeMode)
      setAgentConnected(true)
      setError(null)
      setLoadErrorDetail(null)
      setLoading(false)
    }

    void fetchSources({ blocking: !snapshot })
  }, [])

  useEffect(() => {
    if (!selectedSourceId) return
    if (sources.some(source => source.id === selectedSourceId)) return
    setSelectedSourceId(sources[0]?.id ?? null)
  }, [sources, selectedSourceId])

  useEffect(() => {
    setLocalPlan(readLocalPlan())
  }, [])

  useEffect(() => {
    void fetchRepositoryDiscovery()
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => {
      void fetchRepositoryDiscovery()
    }, Math.max(10, Math.min(60, discoveryIntervalMinutes)) * 60_000)
    return () => window.clearInterval(timer)
  }, [discoveryIntervalMinutes])

  useEffect(() => {
    saveLocalPlan(localPlan)
  }, [localPlan])

  useEffect(() => {
    const storedTheme = window.localStorage.getItem('buildflow-dashboard-theme')
    const preferredTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    setTheme(storedTheme === 'light' || storedTheme === 'dark' ? storedTheme : preferredTheme)
    themeInitializedRef.current = true
  }, [])

  useEffect(() => {
    if (!themeInitializedRef.current) return
    window.localStorage.setItem('buildflow-dashboard-theme', theme)
  }, [theme])

  const handleToggleTheme = () => {
    setTheme(current => (current === 'dark' ? 'light' : 'dark'))
  }

  const mutateSources = async (url: string, payload: Record<string, unknown>) => {
    setMutationLoading(true)
    setMutationError(null)
    setMutationNotice(null)

    try {
      const response = await fetch(url, {
        cache: 'no-store',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })

      const data = await response.json().catch(() => null)

      if (!response.ok) {
        throw new Error(getMutationErrorMessage(data, null, `Request failed: ${response.status}`))
      }

      const refreshed = await fetchSources({ blocking: false })
      if (refreshed) {
        setMutationNotice('Source changes were applied and the dashboard refreshed.')
      }
      return true
    } catch (err) {
      setMutationError(getMutationErrorMessage(null, err, 'Source action failed'))
      if (url === '/api/agent/sources/toggle' || url === '/api/agent/sources/reindex' || url === '/api/agent/sources/auto-index' || url === '/api/agent/sources/add' || url === '/api/agent/sources/remove' || url === '/api/agent/active-sources' || url === '/api/agent/write-mode') {
        void fetchSources({ blocking: false }).catch(() => {})
      }
      return false
    } finally {
      setMutationLoading(false)
    }
  }

  const waitForTerminalIndexStatus = async (sourceId: string, timeoutMs = 300000) => {
    const startedAt = Date.now()

    while (Date.now() - startedAt < timeoutMs) {
      let response: Response
      let data: Record<string, unknown>
      try {
        ({ response, data } = await fetchJsonWithRetry('/api/agent/sources'))
      } catch (err) {
        const remaining = timeoutMs - (Date.now() - startedAt)
        if (remaining <= 0) break
        setMutationNotice('Indexing is still running. Refresh source state in a moment.')
        await sleep(Math.min(1500, remaining))
        continue
      }

      if (!response.ok) {
        if ([502, 503, 504].includes(response.status)) {
          const remaining = timeoutMs - (Date.now() - startedAt)
          if (remaining <= 0) break
          setMutationNotice('Indexing is still running. Refresh source state in a moment.')
          await sleep(Math.min(1500, remaining))
          continue
        }
        throw new Error(getMutationErrorMessage(data, null, `Failed to refresh sources: ${response.status}`))
      }

      const nextSources = Array.isArray(data.sources) ? (data.sources as KnowledgeSource[]) : []
      setSources(nextSources)

      const current = nextSources.find(source => source.id === sourceId)
      if (!current) {
        throw new Error(`Source not found after reindex: ${sourceId}`)
      }

      if (TERMINAL_INDEX_STATUSES.has(current.indexStatus || 'unknown')) {
        if (typeof data.activeMode === 'string') {
          setActiveMode(data.activeMode as ActiveSourcesMode)
        }
        if (Array.isArray(data.activeSourceIds)) {
          setActiveSourceIds(data.activeSourceIds)
        }
        return current
      }

      setMutationNotice(`Reindexing ${current.label || sourceId}... (${current.indexStatus || 'unknown'})`)
      await sleep(1500)
    }

    throw new Error(`Indexing is still running. Refresh source state in a moment.`)
  }

  const handleReindexSource = async (source: KnowledgeSource) => {
    setMutationError(null)
    setMutationNotice(null)

    const success = await mutateSources('/api/agent/sources/reindex', { sourceId: source.id })
    if (!success) return

    try {
      await waitForTerminalIndexStatus(source.id)
      setMutationNotice(`Reindex complete for ${source.label}`)
      recordActivity('source-reindexed', 'Source reindexed', `${source.label} · ${source.indexedFileCount ?? 0} files`, 'good')
    } catch (err) {
      setMutationError(null)
      setMutationNotice(String(err))
      recordActivity('source-reindex-failed', 'Source reindex failed', `${source.label} · ${String(err)}`, 'bad')
    }
  }

  const handleToggleEnabled = async (source: KnowledgeSource, nextEnabled: boolean) => {
    const success = await mutateSources('/api/agent/sources/toggle', { sourceId: source.id, enabled: nextEnabled })
    if (success) {
      recordActivity(
        nextEnabled ? 'source-enabled' : 'source-disabled',
        nextEnabled ? 'Source enabled' : 'Source disabled',
        `${source.label} · ${source.path}`,
        nextEnabled ? 'good' : 'warn'
      )
    }
  }

  const handleSetAutoIndex = async (source: KnowledgeSource, settings: { enabled?: boolean; intervalMinutes?: number }) => {
    const success = await mutateSources('/api/agent/sources/auto-index', {
      sourceId: source.id,
      autoIndexEnabled: settings.enabled,
      autoIndexIntervalMinutes: settings.intervalMinutes
    })
    if (success) {
      const detail = settings.intervalMinutes
        ? `${source.label} will auto-index every ${settings.intervalMinutes} minutes.`
        : `${source.label} auto-index ${settings.enabled === false ? 'disabled' : 'enabled'}.`
      recordActivity('source-auto-index-updated', 'Auto-index updated', detail, settings.enabled === false ? 'warn' : 'good')
    }
  }

  const handleRemoveSource = async (source: KnowledgeSource) => {
    if (!window.confirm(`Remove knowledge source "${source.label}"?`)) {
      return
    }

    const selectedWasRemoved = selectedSourceId === source.id
    const success = await mutateSources('/api/agent/sources/remove', { sourceId: source.id })
    if (!success) return

    const nextSelection = sources.find(item => item.id !== source.id)?.id ?? null
    setSelectedSourceId(selectedWasRemoved ? nextSelection : selectedSourceId)
    recordActivity('source-removed', 'Source removed', `${source.label} · ${source.path}`, 'warn')
  }

  const handleDiscoverySettingsSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!discoveryRootPath.trim()) {
      setDiscoveryError('Repository root folder is required')
      return
    }
    await fetchRepositoryDiscovery({ rootPath: discoveryRootPath.trim(), intervalMinutes: discoveryIntervalMinutes })
  }

  const handleDiscoveredRepoChange = (repoPath: string) => {
    setSelectedDiscoveredRepoPath(repoPath)
    const repo = discoveredRepos.find(item => item.path === repoPath)
    if (!repo) return
    setSourcePath(repo.path)
    setSourceLabel(repo.label)
    setSourceId(repo.id)
  }

  const handleAddSource = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const selectedRepo = discoveredRepos.find(repo => repo.path === selectedDiscoveredRepoPath)
    const resolvedPath = selectedRepo?.path || sourcePath.trim()
    if (!resolvedPath) {
      setMutationError('Select a discovered repo or enter a knowledge source path')
      return
    }

    const nextPath = resolvedPath
    const nextLabel = (selectedRepo?.label || sourceLabel).trim()
    const nextId = (selectedRepo?.id || sourceId).trim()
    const success = await mutateSources('/api/agent/sources/add', {
      path: nextPath,
      label: nextLabel || undefined,
      id: nextId || undefined
    })

    if (success) {
      recordActivity('source-added', 'Source added', `${nextLabel || nextId || nextPath} · ${nextPath}`, 'good')
      setSourcePath('')
      setSourceLabel('')
      setSourceId('')
      setSelectedDiscoveredRepoPath('')
      void fetchRepositoryDiscovery()
      setShowAddSourceForm(false)
    }
  }

  const handleSetMode = async (mode: ActiveSourcesMode) => {
    const enabledCount = sources.filter(source => source.enabled).length
    if ((mode === 'single' || mode === 'multi') && enabledCount === 0) {
      setMutationError(`Cannot set ${mode} mode while no sources are enabled`)
      return
    }
    const nextIds = mode === 'all' ? [] : activeSourceIds.slice(0, mode === 'single' ? 1 : Math.max(activeSourceIds.length, 1))
    const success = await mutateSources('/api/agent/active-sources', { mode, activeSourceIds: nextIds })
    if (success) {
      recordActivity('active-context-changed', 'Active context updated', `Context mode set to ${mode}.`, 'neutral')
    }
  }

  const handleWriteMode = async (nextMode: WriteMode) => {
    const success = await mutateSources('/api/agent/write-mode', { writeMode: nextMode })
    if (success) {
      recordActivity('write-mode-changed', 'Write mode updated', `Write mode set to ${nextMode}.`, 'neutral')
    }
  }

  const topBarStatusText = mutationError || mutationNotice || error

  return (
    <div className={theme === 'dark' ? 'dark' : ''}>
      <div className="h-screen overflow-hidden flex flex-col bg-bf-bg dark:bg-slate-950">
        <DashboardTopBar
          currentSectionLabel={currentSectionLabel}
          agentConnected={agentConnected}
          statusText={topBarStatusText}
          theme={theme}
          onToggleTheme={handleToggleTheme}
          onRefresh={() => fetchSources({ blocking: false })}
        />
        <DashboardShell
          leftRail={<DashboardRail activeSection={activeDashboardSection} sources={sources} selectedSourceId={selectedSourceId} onSelectSection={setActiveDashboardSection} onSelectSource={handleSelectSource} />}
          mainContent={
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-bf-bg dark:bg-slate-950">
              {error && (
                <div className="px-5 pt-4 lg:px-6">
                  <DashboardPanel className="border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900/40 dark:bg-red-950/20 dark:text-red-200">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-semibold">Unable to load sources</div>
                        <p className="mt-1 text-xs text-red-700 dark:text-red-200">{error}</p>
                        {loadErrorDetail && <p className="mt-1 text-[11px] text-red-600 dark:text-red-300"><DashboardCodeText className="break-words text-[11px] text-red-600 dark:text-red-300">{loadErrorDetail}</DashboardCodeText></p>}
                      </div>
                      <div className="flex items-center gap-2">
                        <DashboardButton type="button" onClick={() => fetchSources()} disabled={mutationLoading} variant="secondary" className="border-red-200 bg-white text-red-700 hover:bg-red-50 dark:border-red-900/40 dark:bg-slate-900 dark:text-red-200 dark:hover:bg-slate-800">
                          Retry load
                        </DashboardButton>
                      </div>
                    </div>
                  </DashboardPanel>
                </div>
              )}

              <div className="min-h-0 flex-1 overflow-hidden p-3 lg:p-4">
                {activeDashboardSection === 'overview' && (
                  <div className="h-full min-h-0 overflow-y-auto pb-4">
                    <div className="space-y-4">
                      <DashboardOverview
                        loading={loading}
                        agentConnected={agentConnected}
                        sources={sources}
                        writeMode={writeMode}
                        localPlan={localPlan}
                        activityEntries={activityFeedEntries}
                        onManageSources={() => setActiveDashboardSection('sources')}
                        onOpenHandoff={() => setActiveDashboardSection('handoff')}
                        onOpenPlan={() => setActiveDashboardSection('plan')}
                      />
                      <SetupChecklistPanel
                        sources={sources}
                        agentConnected={agentConnected}
                        activeMode={activeMode}
                        activeSourceIds={activeSourceIds}
                        writeMode={writeMode}
                        localPlan={localPlan}
                        openApiUrl={openApiUrl}
                        copyStatus={setupCopyStatus}
                        onOpenSources={() => setActiveDashboardSection('sources')}
                        onOpenSettings={() => setActiveDashboardSection('settings')}
                        onOpenPlan={() => setActiveDashboardSection('plan')}
                        onOpenHandoff={() => setActiveDashboardSection('handoff')}
                        onCopyOpenApi={copySetupOpenApiUrl}
                        variant="compact"
                      />
                    </div>
                  </div>
                )}

                {activeDashboardSection === 'sources' && (
                  <div className="h-full min-h-0 overflow-y-auto pb-4">
                    <KnowledgeSourcesPanel
                      sources={sources}
                      loading={loading}
                      mutationLoading={mutationLoading}
                      mutationError={mutationError}
                      mutationNotice={mutationNotice}
                      showAddSourceForm={showAddSourceForm}
                      sourcePath={sourcePath}
                      discoveryRootPath={discoveryRootPath}
                      discoveryIntervalMinutes={discoveryIntervalMinutes}
                      discoveredRepos={discoveredRepos}
                      selectedDiscoveredRepoPath={selectedDiscoveredRepoPath}
                      discoveryLoading={discoveryLoading}
                      discoveryError={discoveryError}
                      activeSourceIds={activeSourceIds}
                      onAddSourceSubmit={handleAddSource}
                      onDiscoveryRootPathChange={setDiscoveryRootPath}
                      onDiscoveryIntervalChange={setDiscoveryIntervalMinutes}
                      onDiscoverySettingsSubmit={handleDiscoverySettingsSubmit}
                      onRefreshDiscovery={() => fetchRepositoryDiscovery()}
                      onDiscoveredRepoChange={handleDiscoveredRepoChange}
                      selectedSourceId={selectedSourceId}
                      onSelectSource={handleSelectSource}
                      onToggleActiveSource={handleToggleActiveSource}
                      onToggleEnabled={handleToggleEnabled}
                      onSetAutoIndex={handleSetAutoIndex}
                      onReindexSource={handleReindexSource}
                      onRemoveSource={handleRemoveSource}
                      onToggleAddSourceForm={() => setShowAddSourceForm(prev => !prev)}
                      addSourceFormRef={addSourceFormRef}
                    />
                  </div>
                )}

                {activeDashboardSection === 'activity' && (
                  <div className="h-full min-h-0 overflow-y-auto pb-4">
                    <DashboardActivityFeed
                      entries={activityFeedEntries}
                      emptyMessage="BuildFlow activity will appear here."
                    />
                  </div>
                )}

                {activeDashboardSection === 'plan' && (
                  <div className="h-full min-h-0 overflow-y-auto pb-4">
                    <div className="space-y-4">
                      <PlanPlaceholderPanel
                        sources={sources}
                        agentConnected={agentConnected}
                        selectedSource={selectedSource}
                        plan={localPlan}
                        importError={localPlanImportError}
                        onCreatePlan={handleCreateLocalPlan}
                        onUpdateTaskStatus={handleUpdatePlanTaskStatus}
                        onClearPlan={handleClearLocalPlan}
                        onOpenHandoff={handleOpenHandoff}
                        onExportPlan={handleExportLocalPlan}
                        onImportPlan={handleImportLocalPlan}
                      />
                      <ExecutionFlowPreview />
                    </div>
                  </div>
                )}

                {activeDashboardSection === 'handoff' && (
                  <div className="h-full min-h-0 overflow-y-auto pb-4">
                    <ExecutionHandoffPanel
                      codexPrompt={codexPrompt}
                      claudeCodePrompt={claudeCodePrompt}
                      handoffCopyStatus={handoffCopyStatus}
                      currentSectionLabel={currentSectionLabel}
                      selectedSourceLabel={handoffSelectedSourceLabel}
                      activeModeLabel={summarizeMode(activeMode)}
                      writeModeLabel={summarizeWriteMode(writeMode)}
                      sourceSummaryLabel={handoffSourceSummary}
                      onCopyCodex={() => copyToClipboard(codexPrompt, 'codex-copied', 'handoff-codex-copied', 'Codex handoff copied')}
                      onCopyClaude={() => copyToClipboard(claudeCodePrompt, 'claude-copied', 'handoff-claude-copied', 'Claude handoff copied')}
                    />
                  </div>
                )}

                {activeDashboardSection === 'settings' && (
                  <div className="h-full min-h-0 overflow-y-auto pr-1 pb-4">
                    <div className="space-y-4">
                      <SetupChecklistPanel
                        sources={sources}
                        agentConnected={agentConnected}
                        activeMode={activeMode}
                        activeSourceIds={activeSourceIds}
                        writeMode={writeMode}
                        localPlan={localPlan}
                        openApiUrl={openApiUrl}
                        copyStatus={setupCopyStatus}
                        onOpenSources={() => setActiveDashboardSection('sources')}
                        onOpenSettings={() => setActiveDashboardSection('settings')}
                        onOpenPlan={() => setActiveDashboardSection('plan')}
                        onOpenHandoff={() => setActiveDashboardSection('handoff')}
                        onCopyOpenApi={copySetupOpenApiUrl}
                      />
                      <ActiveContextPanel activeMode={activeMode} writeMode={writeMode} activeSourceIds={activeSourceIds} onSetMode={handleSetMode} onSetWriteMode={handleWriteMode} />
                      <InfoPanels />
                    </div>
                  </div>
                )}
                </div>
            </div>
          }
          rightPanel={
            <InsightPanel
              loading={loading}
              error={error}
              section={activeDashboardSection}
              activeMode={activeMode}
              writeMode={writeMode}
              agentConnected={agentConnected}
              activityEntries={activityFeedEntries}
              localPlan={localPlan}
              sources={sources}
              selectedSource={selectedSource}
              activeSourceIds={activeSourceIds}
              onSelectSource={handleSelectSource}
              onToggleActiveSource={handleToggleActiveSource}
              onToggleEnabled={handleToggleEnabled}
              onReindexSource={handleReindexSource}
              onRemoveSource={handleRemoveSource}
            />
          }
        />
      </div>
    </div>
  )
}
