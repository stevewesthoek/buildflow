'use client'

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import type { FormEvent } from 'react'
import type { ActiveSourcesMode, DiscoveredRepository, KnowledgeSource } from '@buildflow/shared'

const CACHE_KEY = 'buildflow-dashboard-source-snapshot'
const DEFAULT_REPO_ROOT = '~/Repos'
const THEME_KEY = 'buildflow-theme'

type SourceSnapshot = {
  sources: KnowledgeSource[]
  activeMode: ActiveSourcesMode
  activeSourceIds: string[]
  savedAt: string
}

type StatusTone = 'neutral' | 'good' | 'warn' | 'bad'

type ActivityLine = {
  id: string
  label: string
  detail: string
  tone: StatusTone
  timestamp?: string
}

type AgentDashboardJob = {
  id: string
  sourceId: string
  status: string
  currentIteration: number
  maxIterations: number
  completedTaskCount: number
  totalTaskCount: number
  updatedAt?: string
  summary?: string
  activeTask?: {
    title: string
    phaseTitle: string
    status: string
  }
  blockedReason?: string
  confirmationReason?: string
}

type AgentRuntimeEvent = {
  id: string
  jobId: string
  sourceId: string
  type: string
  message: string
  createdAt: string
  commandKind?: string
  status?: string
}

type Theme = 'light' | 'dark' | 'system'

const terminalStatuses = new Set(['ready', 'failed', 'disabled'])

const readSnapshot = (): SourceSnapshot | null => {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<SourceSnapshot>
    if (!Array.isArray(parsed.sources)) return null
    return {
      sources: parsed.sources,
      activeMode: parsed.activeMode || 'all',
      activeSourceIds: Array.isArray(parsed.activeSourceIds) ? parsed.activeSourceIds : [],
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : new Date(0).toISOString()
    }
  } catch {
    return null
  }
}

const saveSnapshot = (snapshot: SourceSnapshot) => {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(snapshot))
  } catch {}
}

const fetchJson = async (url: string, init?: RequestInit) => {
  const response = await fetch(url, { cache: 'no-store', ...init })
  const data = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) {
    const message = typeof data.userMessage === 'string'
      ? data.userMessage
      : typeof data.message === 'string'
        ? data.message
        : typeof data.error === 'string'
          ? data.error
          : `Request failed: ${response.status}`
    throw new Error(message)
  }
  return data
}

const statusTone = (source: KnowledgeSource): StatusTone => {
  if (!source.enabled) return 'neutral'
  if (source.indexStatus === 'failed') return 'bad'
  if (source.indexStatus === 'indexing') return 'warn'
  if (source.indexStatus === 'ready') return 'good'
  return 'neutral'
}

const statusLabel = (source: KnowledgeSource) => {
  if (!source.enabled) return 'disabled'
  return source.indexStatus || 'unknown'
}

const countLabel = (count: number, label: string) => `${count} ${label}${count === 1 ? '' : 's'}`

export default function Dashboard() {
  const [sources, setSources] = useState<KnowledgeSource[]>([])
  const [activeMode, setActiveMode] = useState<ActiveSourcesMode>('all')
  const [activeSourceIds, setActiveSourceIds] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [agentConnected, setAgentConnected] = useState(false)
  const [busySourceId, setBusySourceId] = useState<string | null>(null)
  const [showAddModal, setShowAddModal] = useState(false)
  const [sourcePath, setSourcePath] = useState('')
  const [sourceLabel, setSourceLabel] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [discoveryRootPath, setDiscoveryRootPath] = useState(DEFAULT_REPO_ROOT)
  const [discoveredRepos, setDiscoveredRepos] = useState<DiscoveredRepository[]>([])
  const [selectedDiscoveredRepoPath, setSelectedDiscoveredRepoPath] = useState('')
  const [discoveryLoading, setDiscoveryLoading] = useState(false)
  const [discoveryScanned, setDiscoveryScanned] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activity, setActivity] = useState<ActivityLine[]>([])
  const [agentJobs, setAgentJobs] = useState<AgentDashboardJob[]>([])
  const [busyJobId, setBusyJobId] = useState<string | null>(null)
  const [theme, setTheme] = useState<Theme>('system')
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const hydratedRef = useRef(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const readyCount = useMemo(() => sources.filter(s => s.enabled && s.indexStatus === 'ready').length, [sources])
  const indexingCount = useMemo(() => sources.filter(s => s.enabled && s.indexStatus === 'indexing').length, [sources])
  const activeSources = useMemo(() => sources.filter(s => activeSourceIds.includes(s.id)), [sources, activeSourceIds])
  const enabledSources = useMemo(() => sources.filter(s => s.enabled), [sources])
  const availableDiscoveredRepos = useMemo(() => discoveredRepos.filter(r => !r.alreadyAdded), [discoveredRepos])
  const selectedDiscoveredRepo = useMemo(
    () => discoveredRepos.find(r => r.path === selectedDiscoveredRepoPath) || null,
    [discoveredRepos, selectedDiscoveredRepoPath]
  )

  const applyTheme = useCallback((t: Theme) => {
    const root = document.documentElement
    if (t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      root.classList.add('dark')
    } else {
      root.classList.remove('dark')
    }
  }, [])

  useEffect(() => {
    const saved = localStorage.getItem(THEME_KEY) as Theme | null
    const initial = saved || 'system'
    setTheme(initial)
    applyTheme(initial)
  }, [applyTheme])

  const cycleTheme = () => {
    const next: Theme = theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light'
    setTheme(next)
    localStorage.setItem(THEME_KEY, next)
    applyTheme(next)
  }

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenuId(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const pushActivity = (label: string, detail: string, tone: StatusTone = 'neutral') => {
    setActivity(current => [{ id: `${Date.now()}-${label}`, label, detail, tone, timestamp: new Date().toISOString() }, ...current].slice(0, 5))
  }

  const refreshAgentJobs = async (silent = true) => {
    try {
      const data = await fetchJson('/api/agent/jobs')
      const jobs = Array.isArray(data.jobs) ? data.jobs as AgentDashboardJob[] : []
      const events = Array.isArray(data.events) ? data.events as AgentRuntimeEvent[] : []
      setAgentJobs(jobs)
      if (!silent && events.length > 0) {
        const event = events[0]
        pushActivity('Agent Runtime event', `${event.type}: ${event.message}`, event.type.includes('failed') || event.type.includes('blocked') ? 'bad' : event.type.includes('paused') ? 'warn' : 'good')
      } else if (!silent && jobs.length > 0) {
        const active = jobs.find(j => ['queued', 'running', 'needs_confirmation', 'paused'].includes(j.status)) || jobs[0]
        pushActivity('Sequential job sync', `${active.status}: ${active.activeTask?.title || active.summary || active.id}`, active.status === 'blocked' || active.status === 'failed' ? 'bad' : active.status === 'needs_confirmation' || active.status === 'paused' ? 'warn' : 'good')
      }
      return jobs
    } catch (err) {
      if (!silent) pushActivity('Agent jobs unavailable', err instanceof Error ? err.message : String(err), 'warn')
      return agentJobs
    }
  }

  const controlAgentJob = async (job: AgentDashboardJob, action: 'pause' | 'resume' | 'cancel') => {
    try {
      setBusyJobId(job.id)
      setError(null)
      const data = await fetchJson('/api/agent/jobs/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: job.id, action, reason: `Dashboard ${action}` })
      })
      const events = Array.isArray(data.events) ? data.events as AgentRuntimeEvent[] : []
      const latest = events[0]
      pushActivity(
        `Agent ${action}`,
        latest ? `${latest.type}: ${latest.message}` : `${job.id} ${action} requested.`,
        action === 'cancel' ? 'warn' : 'good'
      )
      await refreshAgentJobs(true)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      pushActivity(`Agent ${action} failed`, message, 'bad')
    } finally {
      setBusyJobId(null)
    }
  }

  const refreshSources = async (silent = false) => {
    try {
      if (!silent) setLoading(true)
      setError(null)
      const [sourcesData, activeData] = await Promise.all([
        fetchJson('/api/agent/sources'),
        fetchJson('/api/agent/active-sources'),
        refreshAgentJobs(true)
      ])
      const nextSources = Array.isArray(sourcesData.sources) ? sourcesData.sources as KnowledgeSource[] : []
      const nextActiveIds = Array.isArray(activeData.activeSourceIds) ? activeData.activeSourceIds as string[] : []
      const nextMode = (activeData.mode as ActiveSourcesMode) || (nextActiveIds.length > 1 ? 'multi' : 'single')
      const snapshot = {
        sources: nextSources,
        activeMode: nextMode,
        activeSourceIds: nextActiveIds,
        savedAt: new Date().toISOString()
      }
      setSources(nextSources)
      setActiveMode(nextMode)
      setActiveSourceIds(nextActiveIds)
      setAgentConnected(true)
      setNotice(null)
      saveSnapshot(snapshot)
      if (!silent) pushActivity('Synced', `${countLabel(nextSources.length, 'source')} · ${countLabel(nextActiveIds.length, 'active connection')}`, 'good')
      return nextSources
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setAgentConnected(false)
      setError(message)
      if (!silent) pushActivity('Refresh failed', message, 'warn')
      return sources
    } finally {
      setLoading(false)
    }
  }

  const scanRepositories = async (rootPath = discoveryRootPath, silent = false) => {
    try {
      setDiscoveryLoading(true)
      setError(null)
      const data = await fetchJson('/api/agent/sources/discovery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootPath: rootPath || DEFAULT_REPO_ROOT })
      })
      const repositories = Array.isArray(data.repositories) ? data.repositories as DiscoveredRepository[] : []
      const settings = data.settings as { rootPath?: string } | undefined
      setDiscoveryRootPath(settings?.rootPath || rootPath || DEFAULT_REPO_ROOT)
      setDiscoveredRepos(repositories)
      setDiscoveryScanned(true)
      setSelectedDiscoveredRepoPath(current => {
        if (current && repositories.some(r => r.path === current && !r.alreadyAdded)) return current
        return repositories.find(r => !r.alreadyAdded)?.path || ''
      })
      if (!silent) pushActivity('Repos scanned', `${countLabel(repositories.length, 'repo')} found under ${settings?.rootPath || rootPath}.`, 'good')
      return repositories
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      pushActivity('Repo scan failed', message, 'warn')
      return []
    } finally {
      setDiscoveryLoading(false)
    }
  }

  useEffect(() => {
    if (hydratedRef.current) return
    hydratedRef.current = true
    const snapshot = readSnapshot()
    if (snapshot) {
      setSources(snapshot.sources)
      setActiveMode(snapshot.activeMode)
      setActiveSourceIds(snapshot.activeSourceIds)
      setAgentConnected(true)
      setLoading(false)
    }
    void refreshSources(Boolean(snapshot))
    void refreshAgentJobs(true)
  }, [])

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refreshAgentJobs(true)
    }, agentJobs.some(j => ['queued', 'running', 'paused', 'needs_confirmation'].includes(j.status)) ? 2500 : 7000)
    return () => window.clearInterval(interval)
  }, [agentJobs])

  useEffect(() => {
    if (!showAddModal) return
    void scanRepositories(discoveryRootPath, true)
  }, [showAddModal])

  useEffect(() => {
    if (!selectedDiscoveredRepo) return
    setSourcePath(selectedDiscoveredRepo.path)
    setSourceLabel(selectedDiscoveredRepo.label)
    setSourceId(selectedDiscoveredRepo.id)
  }, [selectedDiscoveredRepo])

  const mutate = async (label: string, source: KnowledgeSource | null, url: string, payload: Record<string, unknown>, successDetail: string) => {
    try {
      setBusySourceId(source?.id || 'new-source')
      setError(null)
      setNotice(null)
      await fetchJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      setNotice(successDetail)
      pushActivity(label, successDetail, 'good')
      await refreshSources(true)
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      pushActivity(`${label} failed`, message, 'bad')
      return false
    } finally {
      setBusySourceId(null)
    }
  }

  const toggleActive = async (source: KnowledgeSource) => {
    const next = activeSourceIds.includes(source.id)
      ? activeSourceIds.filter(id => id !== source.id)
      : [...activeSourceIds, source.id]
    const mode: ActiveSourcesMode = next.length > 1 ? 'multi' : 'single'
    await mutate(
      next.includes(source.id) ? 'Activated' : 'Deactivated',
      source,
      '/api/agent/active-sources',
      { mode, activeSourceIds: next },
      `${source.label} ${next.includes(source.id) ? 'connected to this conversation' : 'disconnected'}.`
    )
  }

  const toggleEnabled = async (source: KnowledgeSource) => {
    await mutate(
      source.enabled ? 'Disabled' : 'Enabled',
      source,
      '/api/agent/sources/toggle',
      { sourceId: source.id, enabled: !source.enabled },
      `${source.label} ${source.enabled ? 'disabled' : 'enabled'}.`
    )
  }

  const reindexSource = async (source: KnowledgeSource) => {
    const started = await mutate('Re-index started', source, '/api/agent/sources/reindex', { sourceId: source.id }, `${source.label} is re-indexing.`)
    if (!started) return
    const startedAt = Date.now()
    while (Date.now() - startedAt < 60_000) {
      await new Promise(resolve => window.setTimeout(resolve, 1500))
      const nextSources = await refreshSources(true)
      const current = nextSources.find(item => item.id === source.id)
      if (current && terminalStatuses.has(current.indexStatus || 'unknown')) {
        pushActivity('Re-index complete', `${current.label} · ${current.indexStatus}`, current.indexStatus === 'failed' ? 'bad' : 'good')
        return
      }
    }
    setNotice(`${source.label} is still indexing. The dashboard will show the new state on refresh.`)
  }

  const removeSource = async (source: KnowledgeSource) => {
    const confirmed = window.confirm(`Remove ${source.label} from ProChat Workbench?`)
    if (!confirmed) return
    await mutate('Removed', source, '/api/agent/sources/remove', { sourceId: source.id }, `${source.label} removed.`)
  }

  const addSource = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const selectedRepo = selectedDiscoveredRepo || discoveredRepos.find(r => r.path === sourcePath)
    const path = (selectedRepo?.path || sourcePath).trim()
    if (!path) {
      setError('Select a discovered repository first.')
      return
    }
    const label = selectedRepo?.label || sourceLabel.trim()
    const id = selectedRepo?.id || sourceId.trim()
    const ok = await mutate('Added', null, '/api/agent/sources/add', {
      path,
      label: label || undefined,
      id: id || undefined
    }, `${label || id || path} added.`)
    if (ok) {
      setSourcePath('')
      setSourceLabel('')
      setSourceId('')
      setSelectedDiscoveredRepoPath('')
      setShowAddModal(false)
      void scanRepositories(discoveryRootPath, true)
    }
  }

  return (
    <main className="h-screen overflow-hidden bg-gray-50 text-gray-900 dark:bg-[#0a0a0f] dark:text-gray-100 font-[-apple-system,BlinkMacSystemFont,'Inter',sans-serif]">
      <div className="flex h-full flex-col">
        {/* Header */}
        <header className="flex shrink-0 items-center justify-between border-b border-gray-200 bg-white/80 px-5 py-3 backdrop-blur-sm dark:border-gray-800 dark:bg-[#0f0f17]/80">
          <div className="flex items-center gap-3">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gray-900 dark:bg-white">
              <svg className="h-4 w-4 text-white dark:text-gray-900" viewBox="0 0 16 16" fill="currentColor"><path d="M3 1h10l2 4v9a1 1 0 01-1 1H2a1 1 0 01-1-1V5l2-4zm1.2 1L3 4.5h10L11.8 2H4.2zM2 6v8h12V6H2z"/></svg>
            </div>
            <span className="text-sm font-semibold tracking-tight">ProChat Workbench</span>
            <span className={`ml-2 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${agentConnected ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400' : 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400'}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${agentConnected ? 'bg-emerald-500' : 'bg-amber-500'}`} />
              {agentConnected ? 'Connected' : 'Offline'}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <button type="button" onClick={cycleTheme} className="rounded-lg p-2 text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200" title={`Theme: ${theme}`}>
              {theme === 'dark' ? (
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/></svg>
              ) : theme === 'light' ? (
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"/></svg>
              ) : (
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
              )}
            </button>
            <button type="button" onClick={() => refreshSources(false)} disabled={loading || Boolean(busySourceId)} className="rounded-lg p-2 text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 disabled:opacity-40 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200" title="Refresh">
              <svg className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
            </button>
            <button type="button" onClick={() => setShowAddModal(true)} className="ml-1 inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-gray-700 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200">
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4"/></svg>
              Add repo
            </button>
          </div>
        </header>

        {/* Toast notifications */}
        {(notice || error) && (
          <div className="shrink-0 border-b border-gray-200 px-5 py-2 dark:border-gray-800">
            {notice && <p className="text-xs text-emerald-700 dark:text-emerald-400">{notice}</p>}
            {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
          </div>
        )}

        {/* Metrics bar */}
        <div className="flex shrink-0 items-center gap-6 border-b border-gray-200 bg-white/50 px-5 py-2.5 dark:border-gray-800 dark:bg-[#0f0f17]/50">
          <MetricInline label="Sources" value={sources.length} sub={`${enabledSources.length} enabled`} />
          <MetricInline label="Ready" value={readyCount} sub="searchable" tone={readyCount > 0 ? 'good' : 'neutral'} />
          <MetricInline label="Indexing" value={indexingCount} sub="running" tone={indexingCount > 0 ? 'warn' : 'neutral'} />
          <MetricInline label="Active" value={activeSourceIds.length} sub={activeMode} tone={activeSourceIds.length > 0 ? 'good' : 'neutral'} />
        </div>

        {/* Main content */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* Source list */}
          <section className="flex min-h-0 flex-1 flex-col overflow-hidden border-r border-gray-200 dark:border-gray-800">
            <div className="flex shrink-0 items-center border-b border-gray-100 px-5 py-2 dark:border-gray-800/60">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">Repositories</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {loading && sources.length === 0 ? (
                <div className="flex h-full items-center justify-center text-sm text-gray-400">Loading sources...</div>
              ) : sources.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 p-8">
                  <p className="text-sm font-medium text-gray-600 dark:text-gray-300">No repos connected</p>
                  <p className="text-xs text-gray-400">Add a repository to get started.</p>
                </div>
              ) : (
                <div className="divide-y divide-gray-100 dark:divide-gray-800/60">
                  {sources.map(source => {
                    const active = activeSourceIds.includes(source.id)
                    const busy = busySourceId === source.id
                    const menuOpen = openMenuId === source.id
                    return (
                      <div key={source.id} className={`group relative flex items-center gap-3 px-5 py-2.5 transition ${active ? 'bg-emerald-50/50 dark:bg-emerald-950/10' : 'hover:bg-gray-50 dark:hover:bg-gray-900/40'}`}>
                        <span className={`h-2 w-2 shrink-0 rounded-full ${source.enabled && source.indexStatus === 'ready' ? 'bg-emerald-500' : source.indexStatus === 'failed' ? 'bg-red-500' : source.indexStatus === 'indexing' ? 'bg-amber-500 animate-pulse' : 'bg-gray-300 dark:bg-gray-600'}`} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium">{source.label}</span>
                            <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-500 dark:bg-gray-800 dark:text-gray-400">{source.id}</span>
                          </div>
                          <p className="mt-0.5 truncate font-mono text-[11px] text-gray-400 dark:text-gray-500">{source.path}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <StatusPill tone={statusTone(source)}>{statusLabel(source)}</StatusPill>
                          {active && <StatusPill tone="good">live</StatusPill>}
                          <div className="relative" ref={menuOpen ? menuRef : undefined}>
                            <button
                              type="button"
                              onClick={() => setOpenMenuId(menuOpen ? null : source.id)}
                              disabled={busy}
                              className="rounded-md p-1 text-gray-400 transition hover:bg-gray-200 hover:text-gray-600 disabled:opacity-40 dark:hover:bg-gray-700 dark:hover:text-gray-300"
                            >
                              <svg className="h-4 w-4" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="3" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="8" cy="13" r="1.5"/></svg>
                            </button>
                            {menuOpen && (
                              <div className="absolute right-0 top-full z-30 mt-1 w-40 rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-900">
                                <DropdownItem onClick={() => { setOpenMenuId(null); void toggleActive(source) }} disabled={!source.enabled && !active}>
                                  {active ? 'Deactivate' : 'Activate'}
                                </DropdownItem>
                                <DropdownItem onClick={() => { setOpenMenuId(null); void reindexSource(source) }} disabled={!source.enabled || source.indexStatus === 'indexing'}>
                                  Re-index
                                </DropdownItem>
                                <DropdownItem onClick={() => { setOpenMenuId(null); void toggleEnabled(source) }}>
                                  {source.enabled ? 'Disable' : 'Enable'}
                                </DropdownItem>
                                <div className="my-1 border-t border-gray-100 dark:border-gray-800" />
                                <DropdownItem onClick={() => { setOpenMenuId(null); void removeSource(source) }} danger>
                                  Remove
                                </DropdownItem>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </section>

          {/* Right sidebar */}
          <aside className="hidden w-80 shrink-0 flex-col overflow-hidden lg:flex">
            {/* Live conversation */}
            <div className="shrink-0 border-b border-gray-200 p-4 dark:border-gray-800">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">Live conversation</p>
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                Connected to {activeSources.length > 0 ? countLabel(activeSources.length, 'source') : 'no sources'}.
              </p>
              <div className="mt-2 space-y-1.5">
                {activeSources.length > 0 ? activeSources.map(s => (
                  <div key={s.id} className="rounded-md bg-gray-100 px-2.5 py-1.5 dark:bg-gray-800">
                    <span className="text-xs font-medium">{s.label}</span>
                    <span className="ml-2 font-mono text-[10px] text-gray-400">{s.id}</span>
                  </div>
                )) : (
                  <p className="rounded-md bg-gray-100 px-2.5 py-1.5 text-xs text-gray-400 dark:bg-gray-800">Activate a source to connect.</p>
                )}
              </div>
            </div>

            {/* Agent activity — scrollable */}
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4">
              <p className="shrink-0 text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">Agent activity</p>
              <div className="mt-2 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
                {agentJobs.map(job => (
                  <AgentJobCard key={job.id} job={job} busyJobId={busyJobId} onControl={controlAgentJob} />
                ))}
                {activity.map(item => (
                  <div key={item.id} className={`rounded-lg px-2.5 py-2 text-xs ${toneBg(item.tone)}`}>
                    <span className="font-medium">{item.label}</span>
                    <p className="mt-0.5 opacity-75">{item.detail}</p>
                  </div>
                ))}
                {agentJobs.length === 0 && activity.length === 0 && (
                  <p className="rounded-md bg-gray-100 px-2.5 py-2 text-xs text-gray-400 dark:bg-gray-800">No activity yet.</p>
                )}
              </div>
            </div>
          </aside>
        </div>
      </div>

      {/* Add repo modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={(e) => { if (e.target === e.currentTarget) setShowAddModal(false) }}>
          <div className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-6 shadow-2xl dark:border-gray-700 dark:bg-gray-900">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Add repository</h2>
              <button type="button" onClick={() => setShowAddModal(false)} className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
              </button>
            </div>
            <form onSubmit={addSource} className="mt-4 space-y-3">
              <div>
                <label className="mb-1 block text-[11px] font-medium text-gray-500 dark:text-gray-400">Repository</label>
                <select
                  value={selectedDiscoveredRepoPath}
                  onClick={() => { if (discoveredRepos.length === 0 && !discoveryLoading) scanRepositories(discoveryRootPath, true) }}
                  onChange={e => setSelectedDiscoveredRepoPath(e.target.value)}
                  disabled={busySourceId === 'new-source'}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-gray-500 focus:ring-2 focus:ring-gray-200 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:focus:ring-gray-700"
                >
                  <option value="">{discoveryLoading ? 'Scanning...' : discoveryScanned ? 'Select a repository' : 'Click to scan'}</option>
                  {discoveredRepos.map(repo => (
                    <option key={repo.path} value={repo.path} disabled={repo.alreadyAdded}>
                      {repo.account} / {repo.label}{repo.alreadyAdded ? ' (added)' : ''}
                    </option>
                  ))}
                </select>
                <div className="mt-1.5 flex items-center gap-2 text-[11px] text-gray-400">
                  <span className="truncate font-mono">{sourcePath || discoveryRootPath}</span>
                  <span>{availableDiscoveredRepos.length} available</span>
                  <button type="button" onClick={() => scanRepositories(discoveryRootPath, false)} disabled={discoveryLoading} className="font-medium text-gray-600 hover:underline disabled:opacity-50 dark:text-gray-300">
                    Rescan
                  </button>
                </div>
              </div>
              {selectedDiscoveredRepo && (
                <div className="rounded-lg bg-gray-50 px-3 py-2 text-xs dark:bg-gray-800">
                  <span className="font-medium">{selectedDiscoveredRepo.label}</span>
                  <span className="ml-2 font-mono text-gray-400">{selectedDiscoveredRepo.id}</span>
                </div>
              )}
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={() => setShowAddModal(false)} className="rounded-lg px-3 py-1.5 text-xs font-medium text-gray-600 transition hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800">
                  Cancel
                </button>
                <button type="submit" disabled={busySourceId === 'new-source' || !sourcePath || Boolean(selectedDiscoveredRepo?.alreadyAdded)} className="rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-gray-700 disabled:opacity-40 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200">
                  {busySourceId === 'new-source' ? 'Adding...' : 'Add repository'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </main>
  )
}

function MetricInline({ label, value, sub, tone = 'neutral' }: { label: string; value: number; sub: string; tone?: StatusTone }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-400 dark:text-gray-500">{label}</span>
      <span className={`text-sm font-semibold ${tone === 'good' ? 'text-emerald-600 dark:text-emerald-400' : tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : tone === 'bad' ? 'text-red-600 dark:text-red-400' : ''}`}>{value}</span>
      <span className="text-[11px] text-gray-400 dark:text-gray-500">{sub}</span>
    </div>
  )
}

function StatusPill({ children, tone }: { children: string; tone: StatusTone }) {
  const colors: Record<StatusTone, string> = {
    neutral: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
    good: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400',
    warn: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400',
    bad: 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-400'
  }
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${colors[tone]}`}>{children}</span>
}

function DropdownItem({ children, onClick, disabled, danger }: { children: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`w-full px-3 py-1.5 text-left text-xs transition disabled:opacity-40 ${danger ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30' : 'text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800'}`}
    >
      {children}
    </button>
  )
}

function AgentJobCard({ job, busyJobId, onControl }: { job: AgentDashboardJob; busyJobId: string | null; onControl: (job: AgentDashboardJob, action: 'pause' | 'resume' | 'cancel') => void }) {
  const progress = job.totalTaskCount > 0 ? Math.round((job.completedTaskCount / job.totalTaskCount) * 100) : 0
  const tone: StatusTone = job.status === 'failed' || job.status === 'blocked' ? 'bad' : job.status === 'needs_confirmation' || job.status === 'paused' ? 'warn' : job.status === 'completed' ? 'good' : 'neutral'
  return (
    <div className={`rounded-lg px-2.5 py-2 text-xs ${toneBg(tone)}`}>
      <div className="flex items-center justify-between gap-1">
        <span className="font-medium">Agent: {job.status}</span>
        <span className="font-mono text-[10px] opacity-60">{job.completedTaskCount}/{job.totalTaskCount}</span>
      </div>
      <p className="mt-0.5 truncate opacity-75">{job.activeTask ? `${job.activeTask.phaseTitle}: ${job.activeTask.title}` : job.summary || job.id}</p>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
        <div className="h-full rounded-full bg-current opacity-50" style={{ width: `${progress}%` }} />
      </div>
      {(job.blockedReason || job.confirmationReason) && (
        <p className="mt-1 opacity-75">{job.blockedReason || job.confirmationReason}</p>
      )}
      <div className="mt-1.5 flex gap-1">
        <MiniButton onClick={() => onControl(job, 'pause')} disabled={busyJobId === job.id || !['queued', 'running'].includes(job.status)}>Pause</MiniButton>
        <MiniButton onClick={() => onControl(job, 'resume')} disabled={busyJobId === job.id || job.status !== 'paused'}>Resume</MiniButton>
        <MiniButton onClick={() => onControl(job, 'cancel')} disabled={busyJobId === job.id || ['completed', 'failed', 'cancelled'].includes(job.status)} danger>Cancel</MiniButton>
      </div>
    </div>
  )
}

function MiniButton({ children, onClick, disabled, danger }: { children: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition disabled:opacity-30 ${danger ? 'text-red-600 hover:bg-red-100 dark:text-red-400 dark:hover:bg-red-950/30' : 'text-gray-600 hover:bg-gray-200 dark:text-gray-400 dark:hover:bg-gray-700'}`}
    >
      {children}
    </button>
  )
}

function toneBg(tone: StatusTone): string {
  const map: Record<StatusTone, string> = {
    neutral: 'bg-gray-50 text-gray-700 dark:bg-gray-800/60 dark:text-gray-300',
    good: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300',
    warn: 'bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300',
    bad: 'bg-red-50 text-red-800 dark:bg-red-950/30 dark:text-red-300'
  }
  return map[tone]
}
