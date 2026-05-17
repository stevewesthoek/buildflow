'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { ActiveSourcesMode, KnowledgeSource } from '@buildflow/shared'

const CACHE_KEY = 'buildflow-dashboard-source-snapshot'

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
}

const terminalStatuses = new Set(['ready', 'failed', 'disabled'])

const toneClass: Record<StatusTone, string> = {
  neutral: 'bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-800',
  good: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900/70',
  warn: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900/70',
  bad: 'bg-red-50 text-red-700 ring-red-200 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-900/70'
}

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
  } catch {
    // Cache is best-effort only.
  }
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
  const [showAddSource, setShowAddSource] = useState(false)
  const [sourcePath, setSourcePath] = useState('')
  const [sourceLabel, setSourceLabel] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activity, setActivity] = useState<ActivityLine[]>([])
  const hydratedRef = useRef(false)

  const readyCount = useMemo(() => sources.filter(source => source.enabled && source.indexStatus === 'ready').length, [sources])
  const indexingCount = useMemo(() => sources.filter(source => source.enabled && source.indexStatus === 'indexing').length, [sources])
  const activeSources = useMemo(() => sources.filter(source => activeSourceIds.includes(source.id)), [sources, activeSourceIds])
  const enabledSources = useMemo(() => sources.filter(source => source.enabled), [sources])

  const pushActivity = (label: string, detail: string, tone: StatusTone = 'neutral') => {
    setActivity(current => [{ id: `${Date.now()}-${label}`, label, detail, tone }, ...current].slice(0, 3))
  }

  const refreshSources = async (silent = false) => {
    try {
      if (!silent) setLoading(true)
      setError(null)
      const [sourcesData, activeData] = await Promise.all([
        fetchJson('/api/agent/sources'),
        fetchJson('/api/agent/active-sources')
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
  }, [])

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
    const confirmed = window.confirm(`Remove ${source.label} from BuildFlow?`)
    if (!confirmed) return
    await mutate('Removed', source, '/api/agent/sources/remove', { sourceId: source.id }, `${source.label} removed.`)
  }

  const addSource = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const path = sourcePath.trim()
    if (!path) {
      setError('Repository path is required.')
      return
    }
    const ok = await mutate('Added', null, '/api/agent/sources/add', {
      path,
      label: sourceLabel.trim() || undefined,
      id: sourceId.trim() || undefined
    }, `${sourceLabel.trim() || sourceId.trim() || path} added.`)
    if (ok) {
      setSourcePath('')
      setSourceLabel('')
      setSourceId('')
      setShowAddSource(false)
    }
  }

  return (
    <main className="h-screen overflow-hidden bg-slate-50 text-slate-950 dark:bg-slate-950 dark:text-slate-50">
      <div className="mx-auto flex h-full max-w-7xl flex-col gap-4 p-4 sm:p-5">
        <header className="flex shrink-0 flex-wrap items-start justify-between gap-3 rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/80">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">BuildFlow agent</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">Sources dashboard</h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-600 dark:text-slate-300">One fast view for connected repos, live conversation context, and source maintenance.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-3 py-1 text-xs font-medium ring-1 ${agentConnected ? toneClass.good : toneClass.warn}`}>
              {agentConnected ? 'Agent connected' : 'Agent unavailable'}
            </span>
            <button type="button" onClick={() => refreshSources(false)} disabled={loading || Boolean(busySourceId)} className="rounded-full border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800">
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
            <button type="button" onClick={() => setShowAddSource(value => !value)} className="rounded-full bg-slate-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 dark:bg-white dark:text-slate-950 dark:hover:bg-slate-200">
              {showAddSource ? 'Close add' : 'Add repo'}
            </button>
          </div>
        </header>

        <section className="grid shrink-0 gap-3 sm:grid-cols-4">
          <Metric label="Sources" value={sources.length} detail={`${enabledSources.length} enabled`} />
          <Metric label="Ready" value={readyCount} detail="searchable" tone={readyCount > 0 ? 'good' : 'neutral'} />
          <Metric label="Indexing" value={indexingCount} detail="running now" tone={indexingCount > 0 ? 'warn' : 'neutral'} />
          <Metric label="Live connections" value={activeSourceIds.length} detail={activeMode} tone={activeSourceIds.length > 0 ? 'good' : 'neutral'} />
        </section>

        {(notice || error || showAddSource) ? (
          <section className="shrink-0 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            {notice ? <p className="text-sm text-emerald-700 dark:text-emerald-300">{notice}</p> : null}
            {error ? <p className="text-sm text-red-700 dark:text-red-300">{error}</p> : null}
            {showAddSource ? (
              <form onSubmit={addSource} className="mt-3 grid gap-2 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
                <input value={sourcePath} onChange={event => setSourcePath(event.target.value)} placeholder="Repo path" className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-950 dark:focus:border-slate-500" />
                <input value={sourceLabel} onChange={event => setSourceLabel(event.target.value)} placeholder="Label optional" className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-950 dark:focus:border-slate-500" />
                <input value={sourceId} onChange={event => setSourceId(event.target.value)} placeholder="ID optional" className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-950 dark:focus:border-slate-500" />
                <button type="submit" disabled={busySourceId === 'new-source'} className="rounded-xl bg-slate-950 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-slate-950">
                  {busySourceId === 'new-source' ? 'Adding…' : 'Add'}
                </button>
              </form>
            ) : null}
          </section>
        ) : null}

        <section className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-h-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <div className="grid grid-cols-[minmax(0,1fr)_8rem_8rem_14rem] gap-3 border-b border-slate-200 px-4 py-3 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500 dark:border-slate-800 dark:text-slate-400 max-md:hidden">
              <span>Source</span>
              <span>Status</span>
              <span>Connection</span>
              <span className="text-right">Actions</span>
            </div>
            <div className="h-full min-h-0 overflow-y-auto pb-10 md:pb-0">
              {loading && sources.length === 0 ? (
                <div className="flex h-full items-center justify-center p-8 text-sm text-slate-500">Loading sources…</div>
              ) : sources.length === 0 ? (
                <div className="flex h-full items-center justify-center p-8 text-center">
                  <div>
                    <p className="font-medium">No repos connected yet.</p>
                    <p className="mt-1 text-sm text-slate-500">Add a repo path to make it available to the BuildFlow agent.</p>
                  </div>
                </div>
              ) : (
                <div className="divide-y divide-slate-200 dark:divide-slate-800">
                  {sources.map(source => {
                    const active = activeSourceIds.includes(source.id)
                    const busy = busySourceId === source.id
                    return (
                      <article key={source.id} className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_8rem_8rem_14rem] md:items-center">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${source.enabled && source.indexStatus === 'ready' ? 'bg-emerald-500' : source.indexStatus === 'failed' ? 'bg-red-500' : source.indexStatus === 'indexing' ? 'bg-amber-500' : 'bg-slate-400'}`} />
                            <h2 className="truncate text-sm font-semibold">{source.label}</h2>
                            <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">{source.id}</span>
                          </div>
                          <p className="mt-1 truncate font-mono text-xs text-slate-500 dark:text-slate-400">{source.path}</p>
                        </div>
                        <Badge tone={statusTone(source)}>{statusLabel(source)}</Badge>
                        <Badge tone={active ? 'good' : 'neutral'}>{active ? 'live' : 'idle'}</Badge>
                        <div className="flex flex-wrap justify-start gap-1.5 md:justify-end">
                          <ActionButton disabled={busy || (!source.enabled && !active)} onClick={() => toggleActive(source)}>{active ? 'Deactivate' : 'Activate'}</ActionButton>
                          <ActionButton disabled={busy || !source.enabled || source.indexStatus === 'indexing'} onClick={() => reindexSource(source)}>Re-index</ActionButton>
                          <ActionButton disabled={busy} onClick={() => toggleEnabled(source)}>{source.enabled ? 'Disable' : 'Enable'}</ActionButton>
                          <ActionButton disabled={busy} danger onClick={() => removeSource(source)}>Remove</ActionButton>
                        </div>
                      </article>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          <aside className="grid min-h-0 gap-4 lg:grid-rows-[auto_minmax(0,1fr)]">
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">Live conversation</p>
              <h2 className="mt-2 text-lg font-semibold">Current ChatGPT chat</h2>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Connected to {activeSources.length > 0 ? countLabel(activeSources.length, 'source') : 'no sources'}.</p>
              <div className="mt-3 space-y-2">
                {activeSources.length > 0 ? activeSources.map(source => (
                  <div key={source.id} className="rounded-xl bg-slate-100 px-3 py-2 text-sm dark:bg-slate-800">
                    <div className="truncate font-medium">{source.label}</div>
                    <div className="truncate font-mono text-xs text-slate-500 dark:text-slate-400">{source.id}</div>
                  </div>
                )) : <p className="rounded-xl bg-slate-100 px-3 py-2 text-sm text-slate-500 dark:bg-slate-800 dark:text-slate-400">Activate a source to connect this conversation.</p>}
              </div>
            </div>

            <div className="min-h-0 overflow-hidden rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">Agent activity</p>
              <div className="mt-3 space-y-2">
                {activity.length > 0 ? activity.map(item => (
                  <div key={item.id} className={`rounded-xl px-3 py-2 text-sm ring-1 ${toneClass[item.tone]}`}>
                    <div className="font-medium">{item.label}</div>
                    <div className="mt-0.5 text-xs opacity-80">{item.detail}</div>
                  </div>
                )) : <p className="rounded-xl bg-slate-100 px-3 py-2 text-sm text-slate-500 dark:bg-slate-800 dark:text-slate-400">No dashboard actions yet.</p>}
              </div>
            </div>
          </aside>
        </section>
      </div>
    </main>
  )
}

function Metric({ label, value, detail, tone = 'neutral' }: { label: string; value: number; detail: string; tone?: StatusTone }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</p>
      <div className="mt-1 flex items-end justify-between gap-2">
        <strong className="text-2xl font-semibold">{value}</strong>
        <span className={`rounded-full px-2 py-1 text-xs ring-1 ${toneClass[tone]}`}>{detail}</span>
      </div>
    </div>
  )
}

function Badge({ children, tone }: { children: string; tone: StatusTone }) {
  return <span className={`inline-flex w-fit rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${toneClass[tone]}`}>{children}</span>
}

function ActionButton({ children, disabled, danger = false, onClick }: { children: string; disabled?: boolean; danger?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${danger ? 'border-red-200 text-red-700 hover:bg-red-50 dark:border-red-900/60 dark:text-red-300 dark:hover:bg-red-950/30' : 'border-slate-300 text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800'}`}
    >
      {children}
    </button>
  )
}
