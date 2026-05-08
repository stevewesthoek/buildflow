import type { FormEvent, RefObject } from 'react'
import type { KnowledgeSource, DiscoveredRepository } from '@buildflow/shared'
import { Folder, MoreHorizontal } from 'lucide-react'

import { DashboardButton } from './ui/DashboardButton'
import { DashboardCodeText } from './ui/DashboardCodeText'
import { DashboardListRow } from './ui/DashboardListRow'
import { DashboardMetricCard } from './ui/DashboardMetricCard'
import { DashboardPanel } from './ui/DashboardPanel'
import { DashboardSectionHeader } from './ui/DashboardSectionHeader'
import { DashboardStatusDot } from './ui/DashboardStatusDot'

type KnowledgeSourcesPanelProps = {
  sources: KnowledgeSource[]
  loading: boolean
  mutationLoading: boolean
  mutationError: string | null
  mutationNotice: string | null
  showAddSourceForm: boolean
  sourcePath: string
  discoveryRootPath: string
  discoveryIntervalMinutes: number
  discoveredRepos: DiscoveredRepository[]
  selectedDiscoveredRepoPath: string
  discoveryLoading: boolean
  discoveryError: string | null
  activeSourceIds: string[]
  selectedSourceId: string | null
  onAddSourceSubmit: (event: FormEvent<HTMLFormElement>) => void
  onDiscoveryRootPathChange: (value: string) => void
  onDiscoveryIntervalChange: (value: number) => void
  onDiscoverySettingsSubmit: (event: FormEvent<HTMLFormElement>) => void
  onRefreshDiscovery: () => void
  onDiscoveredRepoChange: (repoPath: string) => void
  onSelectSource: (sourceId: string) => void
  onToggleActiveSource: (sourceId: string) => void
  onToggleEnabled: (source: KnowledgeSource, nextEnabled: boolean) => void
  onSetAutoIndex: (source: KnowledgeSource, settings: { enabled?: boolean; intervalMinutes?: number }) => void
  onReindexSource: (source: KnowledgeSource) => void
  onRemoveSource: (source: KnowledgeSource) => void
  onToggleAddSourceForm: () => void
  addSourceFormRef: RefObject<HTMLFormElement>
}

const getStatusSummary = (source: KnowledgeSource) => {
  const fileCount = typeof source.indexedFileCount === 'number' ? `${source.indexedFileCount.toLocaleString()} files` : 'files unknown'
  const status = source.indexStatus || 'unknown'

  // Distinguish between first-time indexing and reindexing
  if (status === 'indexing') {
    const hasIndexedBefore = (source.indexedFileCount ?? 0) > 0
    return `${hasIndexedBefore ? 'reindexing' : 'indexing'} · ${fileCount}`
  }

  return `${status} · ${fileCount}`
}

export function KnowledgeSourcesPanel({
  sources,
  loading,
  mutationLoading,
  mutationError,
  mutationNotice,
  showAddSourceForm,
  sourcePath,
  discoveryRootPath,
  discoveryIntervalMinutes,
  discoveredRepos,
  selectedDiscoveredRepoPath,
  discoveryLoading,
  discoveryError,
  activeSourceIds,
  selectedSourceId,
  onAddSourceSubmit,
  onDiscoveryRootPathChange,
  onDiscoveryIntervalChange,
  onDiscoverySettingsSubmit,
  onRefreshDiscovery,
  onDiscoveredRepoChange,
  onSelectSource,
  onToggleActiveSource,
  onToggleEnabled,
  onSetAutoIndex,
  onReindexSource,
  onRemoveSource,
  onToggleAddSourceForm,
  addSourceFormRef
}: KnowledgeSourcesPanelProps) {
  const shouldShowAddForm = sources.length === 0 || showAddSourceForm
  const readyCount = sources.filter(source => source.enabled && source.indexStatus === 'ready').length
  const indexingCount = sources.filter(source => source.enabled && source.indexStatus === 'indexing').length
  const failedCount = sources.filter(source => source.enabled && source.indexStatus === 'failed').length
  const searchableCount = sources.filter(source => source.enabled && source.indexStatus === 'ready').length
  const indexedFiles = sources.reduce((total, source) => total + (typeof source.indexedFileCount === 'number' ? source.indexedFileCount : 0), 0)
  const sourceHealth = sources.length > 0 ? Math.round((readyCount / sources.length) * 100) : 0
  const statusCopy = mutationError || mutationNotice || 'Connected local folders and source state.'
  const topSources = [...sources]
    .sort((a, b) => (b.indexedFileCount ?? 0) - (a.indexedFileCount ?? 0))
    .slice(0, 3)

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3 p-4 lg:p-5">
      <DashboardPanel variant="raised" className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <DashboardSectionHeader
            eyebrow="Sources"
            title="Context & Sources"
            detail={statusCopy}
          />
          <DashboardButton type="button" onClick={onToggleAddSourceForm} variant={showAddSourceForm || sources.length === 0 ? 'primary' : 'secondary'}>
            {showAddSourceForm ? 'Hide add source' : 'Add source'}
          </DashboardButton>
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <DashboardMetricCard label="Total sources" value={sources.length} detail="Connected" />
          <DashboardMetricCard label="Searchable" value={searchableCount} detail="Ready to search" tone={searchableCount > 0 ? 'good' : 'neutral'} />
          <DashboardMetricCard label="Indexing" value={indexingCount} detail={indexingCount > 0 ? 'In progress' : 'Idle'} tone={indexingCount > 0 ? 'warn' : 'neutral'} />
          <DashboardMetricCard label="Issues" value={failedCount} detail={failedCount > 0 ? 'Needs attention' : 'All good'} tone={failedCount > 0 ? 'bad' : 'good'} />
        </div>
      </DashboardPanel>

      <div className="grid min-h-0 gap-3 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="flex min-h-0 flex-col gap-3">
          {shouldShowAddForm ? (
            <DashboardPanel variant="flat" className="shrink-0 p-3">
              <form onSubmit={onDiscoverySettingsSubmit} className="grid gap-3 md:grid-cols-[minmax(0,1fr)_9rem_auto]">
                <label className="block">
                  <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.12em] text-bf-muted dark:text-slate-400">Repo root folder</span>
                  <input
                    value={discoveryRootPath}
                    onChange={e => onDiscoveryRootPathChange(e.target.value)}
                    className="w-full rounded-md border border-bf-border bg-bf-surface px-3 py-2 text-[13px] text-bf-text outline-none transition-colors placeholder:text-bf-muted focus:border-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:border-slate-500"
                    placeholder="~/Office/Repos"
                    disabled={discoveryLoading || mutationLoading}
                  />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.12em] text-bf-muted dark:text-slate-400">Scan every</span>
                  <select
                    value={discoveryIntervalMinutes}
                    onChange={e => onDiscoveryIntervalChange(Number(e.target.value))}
                    className="w-full rounded-md border border-bf-border bg-bf-surface px-3 py-2 text-[13px] text-bf-text outline-none transition-colors focus:border-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:border-slate-500"
                    disabled={discoveryLoading || mutationLoading}
                  >
                    <option value={10}>10 min</option>
                    <option value={30}>30 min</option>
                    <option value={60}>1 hour</option>
                  </select>
                </label>
                <div className="flex items-end">
                  <DashboardButton type="submit" disabled={discoveryLoading || mutationLoading} variant="secondary" className="w-full">
                    {discoveryLoading ? 'Scanning...' : 'Scan repos'}
                  </DashboardButton>
                </div>
              </form>
              <form ref={addSourceFormRef} onSubmit={onAddSourceSubmit} className="mt-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
                <label className="block">
                  <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.12em] text-bf-muted dark:text-slate-400">Discovered repo</span>
                  <select
                    value={selectedDiscoveredRepoPath}
                    onChange={e => onDiscoveredRepoChange(e.target.value)}
                    className="w-full rounded-md border border-bf-border bg-bf-surface px-3 py-2 text-[13px] text-bf-text outline-none transition-colors focus:border-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:border-slate-500"
                    disabled={mutationLoading || discoveredRepos.length === 0}
                  >
                    <option value="">{discoveredRepos.length === 0 ? 'Scan a root folder first' : 'Select a repository'}</option>
                    {discoveredRepos.map(repo => (
                      <option key={repo.path} value={repo.path} disabled={repo.alreadyAdded}>
                        {repo.account} / {repo.label}{repo.alreadyAdded ? ' · added' : ''}
                      </option>
                    ))}
                  </select>
                  <span className="mt-1 block truncate font-mono-ui text-[11px] text-bf-muted dark:text-slate-400">{sourcePath || 'Repository path will auto-fill from the picker.'}</span>
                </label>
                <div className="flex items-end gap-2">
                  <DashboardButton type="button" disabled={discoveryLoading} variant="secondary" onClick={onRefreshDiscovery}>
                    Refresh
                  </DashboardButton>
                  <DashboardButton type="submit" disabled={mutationLoading || !sourcePath} variant="primary">
                    {mutationLoading ? 'Working...' : 'Add source'}
                  </DashboardButton>
                </div>
              </form>
              {discoveryError ? <p className="mt-2 text-[12px] text-red-600 dark:text-red-300">{discoveryError}</p> : null}
              <p className="mt-2 text-[12px] text-bf-muted dark:text-slate-400">BuildFlow scans recursively for Git repos, groups them by account folder, and auto-generates label and source ID.</p>
            </DashboardPanel>
          ) : null}

          <DashboardPanel variant="flat" className="min-h-0 flex-1 overflow-hidden">
            <div className="flex items-center justify-between border-b border-bf-border/70 px-4 py-3 dark:border-slate-800/70">
              <DashboardSectionHeader title="Source list" detail={`${readyCount} ready · ${indexingCount} indexing · ${indexedFiles.toLocaleString()} files`} />
            </div>

            <div className="min-h-0 overflow-y-auto">
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <div className="text-center">
                    <div className="mx-auto mb-3 h-7 w-7 animate-spin rounded-full border-2 border-bf-border border-t-slate-500 dark:border-slate-700 dark:border-t-slate-400" />
                    <p className="text-[13px] font-medium text-bf-muted dark:text-slate-300">Loading sources...</p>
                  </div>
                </div>
              ) : sources.length === 0 ? (
                <div className="p-3">
                  <div className="rounded-lg border border-dashed border-bf-border/70 bg-bf-subtle/40 px-5 py-8 text-center dark:border-slate-700/70 dark:bg-slate-950/24">
                    <p className="text-[13px] font-semibold text-bf-text dark:text-slate-50">No knowledge sources connected yet</p>
                    <p className="mt-2 text-[13px] text-bf-muted dark:text-slate-300">Connect a local folder to start indexing content for ChatGPT.</p>
                    <div className="mt-4 rounded-md border border-bf-border/70 bg-bf-surface/65 px-4 py-3 text-left text-[12px] text-bf-text dark:border-slate-800/70 dark:bg-slate-950/40 dark:text-slate-300">
                      <DashboardCodeText>buildflow connect &lt;path&gt;</DashboardCodeText>
                    </div>
                  </div>
                </div>
              ) : (
                <div>
                  <div className="grid grid-cols-[minmax(0,1.7fr)_minmax(8.5rem,0.9fr)_2.5rem] gap-2 border-b border-bf-border/60 px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-bf-muted dark:border-slate-800/60 dark:text-slate-400">
                    <span>Source</span>
                    <span>Status</span>
                    <span className="text-right">Actions</span>
                  </div>
                  <div className="divide-y divide-bf-border/60 dark:divide-slate-800/60">
                    {sources.map(source => {
                      const isActive = activeSourceIds.includes(source.id)
                      const actions = [
                        {
                          label: isActive ? 'Deactivate' : 'Activate',
                          disabled: mutationLoading || (!source.enabled && !isActive),
                          onClick: () => onToggleActiveSource(source.id)
                        },
                        {
                          label: source.enabled ? 'Disable' : 'Enable',
                          disabled: mutationLoading,
                          onClick: () => onToggleEnabled(source, !source.enabled)
                        },
                        {
                          label: source.indexStatus === 'indexing' ? 'Indexing...' : 'Reindex',
                          disabled: mutationLoading || !source.enabled || source.indexStatus === 'indexing',
                          onClick: () => onReindexSource(source)
                        },
                        {
                          label: source.autoIndexEnabled === false ? 'Auto-index on' : 'Auto-index off',
                          disabled: mutationLoading || !source.enabled,
                          onClick: () => onSetAutoIndex(source, { enabled: source.autoIndexEnabled === false })
                        },
                        ...[1, 5, 15, 60].map(minutes => ({
                          label: `Every ${minutes} min`,
                          disabled: mutationLoading || !source.enabled || (source.autoIndexIntervalMinutes || 5) === minutes,
                          onClick: () => onSetAutoIndex(source, { intervalMinutes: minutes, enabled: true })
                        })),
                        {
                          label: 'Remove',
                          disabled: mutationLoading,
                          onClick: () => onRemoveSource(source)
                        }
                      ]

                      return (
                  <DashboardListRow
                          key={source.id}
                          className="grid min-h-[4.25rem] grid-cols-[minmax(0,1.7fr)_minmax(8.5rem,0.9fr)_2.5rem] gap-2 rounded-none px-4 py-2.5"
                          selected={selectedSourceId === source.id}
                          onClick={() => onSelectSource(source.id)}
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <DashboardStatusDot tone={source.enabled && source.indexStatus === 'ready' ? 'good' : source.indexStatus === 'failed' ? 'bad' : 'neutral'} />
                              <Folder className="h-3.5 w-3.5 shrink-0 text-bf-muted dark:text-slate-400" strokeWidth={1.8} />
                              <h4 className="text-[13px] font-medium text-bf-text dark:text-slate-50">{source.label}</h4>
                            </div>
                            <div className="mt-1 line-clamp-2 font-mono-ui text-[11px] leading-4 text-bf-muted dark:text-slate-400">{source.path}</div>
                          </div>
                          <div className="min-w-0 text-[11px] text-bf-muted dark:text-slate-300">
                            <div>
                              <span className="font-medium text-bf-text dark:text-slate-100">{getStatusSummary(source)}</span>
                            </div>
                            <div className="mt-1 text-bf-muted dark:text-slate-400">
                              {source.enabled ? 'Enabled' : 'Disabled'} · {isActive ? 'Active context' : 'Idle'}
                              {source.indexStatus === 'indexing' && (source.indexedFileCount ?? 0) > 0 ? ' · Searchable' : ''}
                              {source.autoIndexEnabled === false ? ' · Auto off' : ` · Auto ${source.autoIndexIntervalMinutes || 5}m`}
                            </div>
                          </div>
                          <details className="relative justify-self-end">
                            <summary
                              className="flex h-7 w-7 cursor-pointer list-none items-center justify-center rounded-[10px] border border-bf-border bg-bf-surface text-bf-muted transition-colors duration-150 hover:bg-bf-subtle hover:text-bf-text dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
                              onClick={event => event.stopPropagation()}
                            >
                              <MoreHorizontal className="h-3.5 w-3.5" strokeWidth={1.8} />
                            </summary>
                            <div
                              className="absolute right-0 top-9 z-10 w-44 overflow-hidden rounded-md border border-bf-border bg-bf-surface p-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"
                              onClick={event => event.stopPropagation()}
                            >
                              {actions.map(action => (
                                <button
                                  key={action.label}
                                  type="button"
                                  disabled={action.disabled}
                                  onClick={event => {
                                    event.stopPropagation()
                                    action.onClick()
                                  }}
                                  className="block w-full rounded-md px-3 py-2 text-left text-[12px] text-bf-text transition-colors duration-150 hover:bg-bf-subtle disabled:cursor-not-allowed disabled:opacity-40 dark:text-slate-200 dark:hover:bg-slate-800"
                                >
                                  {action.label}
                                </button>
                              ))}
                            </div>
                          </details>
                        </DashboardListRow>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          </DashboardPanel>
        </div>

        <div className="grid min-h-0 gap-3">
          <DashboardPanel variant="flat" className="p-4">
            <DashboardSectionHeader eyebrow="Source health" title={`${sourceHealth}%`} detail="Ready and searchable." />
            <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-bf-subtle dark:bg-slate-900">
              <div className="h-full rounded-full bg-emerald-500" style={{ width: `${sourceHealth}%` }} />
            </div>
            <div className="mt-4 space-y-2 text-[12px] text-bf-muted dark:text-slate-300">
              <div className="flex justify-between"><span>All sources</span><span>{sources.length}</span></div>
              <div className="flex justify-between"><span>Ready</span><span>{readyCount}</span></div>
              <div className="flex justify-between"><span>Indexed files</span><span>{indexedFiles.toLocaleString()}</span></div>
            </div>
          </DashboardPanel>

          <DashboardPanel variant="flat" className="p-4">
            <DashboardSectionHeader eyebrow="Most active" title="Largest contexts" />
            <div className="mt-3 space-y-2">
              {topSources.map(source => (
                <div key={source.id} className="flex items-center justify-between gap-3 text-[12px]">
                  <span className="truncate text-bf-text dark:text-slate-100">{source.label}</span>
                  <span className="font-mono-ui text-[11px] text-bf-muted dark:text-slate-400">{(source.indexedFileCount ?? 0).toLocaleString()} files</span>
                </div>
              ))}
              {topSources.length === 0 ? <p className="text-[12px] text-bf-muted dark:text-slate-400">No source activity yet.</p> : null}
            </div>
          </DashboardPanel>
        </div>
      </div>
    </div>
  )
}
