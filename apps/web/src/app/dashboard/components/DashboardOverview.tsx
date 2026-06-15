import type { KnowledgeSource, WriteMode } from '@workbench/shared'
import { CheckCircle2 } from 'lucide-react'

import {
  getFailedSourceCount,
  getIndexingSourceCount,
  getReadySourceCount,
} from '../helpers'
import type { DashboardActivityEvent } from '../types'
import type { DashboardLocalPlan } from '../types'
import { DashboardButton } from './ui/DashboardButton'
import { DashboardMetricCard } from './ui/DashboardMetricCard'
import { DashboardPanel } from './ui/DashboardPanel'
import { DashboardSectionHeader } from './ui/DashboardSectionHeader'
import { DashboardStatusDot } from './ui/DashboardStatusDot'

type DashboardOverviewProps = {
  loading: boolean
  agentConnected: boolean
  sources: KnowledgeSource[]
  writeMode: WriteMode
  localPlan: DashboardLocalPlan | null
  activityEntries: DashboardActivityEvent[]
  onManageSources: () => void
  onOpenHandoff: () => void
  onOpenPlan: () => void
}

const formatCount = (value: number) => value.toLocaleString()

export function DashboardOverview({
  loading,
  agentConnected,
  sources,
  writeMode,
  localPlan,
  activityEntries,
  onManageSources,
  onOpenHandoff,
  onOpenPlan
}: DashboardOverviewProps) {
  const readyCount = getReadySourceCount(sources)
  const indexingCount = getIndexingSourceCount(sources)
  const failedCount = getFailedSourceCount(sources)
  const enabledCount = sources.filter(source => source.enabled).length
  const indexedFiles = sources.reduce((total, source) => total + (typeof source.indexedFileCount === 'number' ? source.indexedFileCount : 0), 0)
  const doneCount = localPlan?.tasks.filter(task => task.status === 'done').length ?? 0
  const activeTasks = localPlan?.tasks.filter(task => task.status === 'active').length ?? 0
  const totalTasks = localPlan?.tasks.length ?? 0
  const nextTask = localPlan?.tasks.find(task => task.status === 'active') || localPlan?.tasks.find(task => task.status === 'pending') || localPlan?.tasks[0] || null
  const topSources = [...sources]
    .sort((a, b) => (b.indexedFileCount ?? 0) - (a.indexedFileCount ?? 0))
    .slice(0, 4)
  const planProgress = totalTasks > 0 ? Math.round((doneCount / totalTasks) * 100) : 0
  const sourceHealth = sources.length > 0 ? Math.round((readyCount / sources.length) * 100) : 0
  const recentActivity = activityEntries.slice(0, 4)
  const setupProgress = Math.round(([
    agentConnected,
    sources.length > 0,
    readyCount > 0,
    Boolean(localPlan)
  ].filter(Boolean).length / 4) * 100)

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3">
      <DashboardPanel variant="raised" className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 max-w-2xl">
            <DashboardSectionHeader
              eyebrow="Overview"
              title="Good morning, Steve"
              detail="BuildFlow Local is your compact AI workbench for sources, plans, and safe execution."
            />
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-bf-muted dark:text-slate-300">
              <span className="inline-flex items-center gap-1.5"><DashboardStatusDot tone={agentConnected ? 'good' : 'neutral'} />{agentConnected ? 'Agent connected' : 'Agent offline'}</span>
              <span>·</span>
              <span>{enabledCount} enabled sources</span>
              <span>·</span>
              <span>{writeMode}</span>
              {loading ? <><span>·</span><span>refreshing</span></> : null}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <DashboardButton type="button" onClick={onManageSources} variant="secondary">
              Manage sources
            </DashboardButton>
            <DashboardButton type="button" onClick={onOpenPlan} variant={localPlan ? 'secondary' : 'primary'}>
              {localPlan ? 'Open plan' : 'New plan'}
            </DashboardButton>
            <DashboardButton type="button" onClick={onOpenHandoff} variant="primary">
              Handoff
            </DashboardButton>
          </div>
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <DashboardMetricCard label="Sources" value={formatCount(sources.length)} detail={`${readyCount} ready · ${enabledCount} enabled`} tone={readyCount > 0 ? 'good' : 'neutral'} />
          <DashboardMetricCard label="Files indexed" value={formatCount(indexedFiles)} detail="Across all local sources" tone="neutral" />
          <DashboardMetricCard label="Plans" value={localPlan ? '1' : '0'} detail={localPlan ? `${planProgress}% complete` : 'Create a local plan'} tone={localPlan ? 'good' : 'neutral'} />
          <DashboardMetricCard label="Tasks" value={formatCount(totalTasks)} detail={totalTasks ? `${doneCount} done · ${activeTasks} active` : 'No local tasks yet'} tone={activeTasks > 0 ? 'warn' : doneCount > 0 ? 'good' : 'neutral'} />
        </div>
      </DashboardPanel>

      <div className="grid min-h-0 gap-3 xl:grid-cols-[minmax(0,1.35fr)_minmax(18rem,0.75fr)]">
        <div className="grid min-h-0 gap-3 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
          <DashboardPanel variant="flat" className="min-h-0 overflow-hidden p-4">
            <DashboardSectionHeader eyebrow="Activity overview" title="Recent activity" detail="Real dashboard events, surfaced without a decorative chart." />
            {recentActivity.length > 0 ? (
              <div className="mt-4 space-y-3">
                {recentActivity.map((entry, index) => (
                  <div key={entry.id} className="flex items-start gap-3">
                    <div className="flex flex-col items-center pt-0.5">
                      <span className={`h-2.5 w-2.5 rounded-full ${entry.tone === 'good' ? 'bg-emerald-500' : entry.tone === 'warn' ? 'bg-amber-500' : entry.tone === 'bad' ? 'bg-red-500' : 'bg-slate-400 dark:bg-slate-500'}`} />
                      {index < recentActivity.length - 1 ? <span className="mt-1 h-full w-px flex-1 bg-bf-border/60 dark:bg-slate-800/60" /> : null}
                    </div>
                    <div className="min-w-0 flex-1 pb-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="text-[12px] font-medium text-bf-text dark:text-slate-100">{entry.title}</div>
                        <div className="text-[10px] uppercase tracking-[0.08em] text-bf-muted dark:text-slate-500">{entry.type}</div>
                      </div>
                      <div className="mt-0.5 text-[12px] leading-5 text-bf-muted dark:text-slate-300">{entry.detail}</div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-4 rounded-[14px] bg-bf-subtle/50 px-4 py-3 text-[12px] leading-5 text-bf-muted dark:bg-slate-950/30 dark:text-slate-300">
                Activity will appear here after you add sources, change plans, or refresh the workspace.
              </div>
            )}
            <div className="mt-4 flex flex-wrap gap-2 text-[11px] text-bf-muted dark:text-slate-400">
              <span className="rounded-full bg-bf-subtle/80 px-2.5 py-1 dark:bg-slate-900/50">{readyCount} ready</span>
              <span className="rounded-full bg-bf-subtle/80 px-2.5 py-1 dark:bg-slate-900/50">{indexingCount} indexing</span>
              <span className="rounded-full bg-bf-subtle/80 px-2.5 py-1 dark:bg-slate-900/50">{failedCount} failed</span>
            </div>
          </DashboardPanel>

          <div className="grid min-h-0 gap-3">
            <DashboardPanel variant="flat" className="p-4">
              <DashboardSectionHeader eyebrow="Source health" title={`${sourceHealth}% healthy`} detail="Ready sources divided by connected sources." />
              <div className="mt-4 space-y-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-emerald-500/12 to-slate-500/10 ring-1 ring-inset ring-emerald-500/25 dark:from-emerald-500/10 dark:to-slate-500/10 dark:ring-emerald-500/20">
                    <div className="text-center">
                      <div className="text-xl font-semibold leading-none text-bf-text dark:text-slate-50">{sourceHealth}%</div>
                      <div className="mt-0.5 text-[10px] uppercase tracking-[0.08em] text-bf-muted dark:text-slate-400">Ready</div>
                    </div>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[12px] font-medium text-bf-text dark:text-slate-100">
                      {readyCount > 0 ? `${readyCount} sources ready` : 'No ready sources yet'}
                    </div>
                    <div className="mt-0.5 text-[12px] leading-5 text-bf-muted dark:text-slate-300">
                      {indexingCount > 0 ? `${indexingCount} still indexing` : 'Indexing is idle'}
                    </div>
                  </div>
                </div>
                <div className="grid gap-2 text-[12px] text-bf-muted dark:text-slate-300 sm:grid-cols-3 sm:gap-3">
                  <div className="rounded-[12px] bg-bf-subtle/45 px-3 py-2 dark:bg-slate-950/28">
                    <div className="text-bf-muted dark:text-slate-400">Connected</div>
                    <div className="mt-0.5 text-bf-text dark:text-slate-100">{sources.length}</div>
                  </div>
                  <div className="rounded-[12px] bg-bf-subtle/45 px-3 py-2 dark:bg-slate-950/28">
                    <div className="text-bf-muted dark:text-slate-400">Indexed files</div>
                    <div className="mt-0.5 text-bf-text dark:text-slate-100">{formatCount(indexedFiles)}</div>
                  </div>
                  <div className="rounded-[12px] bg-bf-subtle/45 px-3 py-2 dark:bg-slate-950/28">
                    <div className="text-bf-muted dark:text-slate-400">Failures</div>
                    <div className="mt-0.5 text-bf-text dark:text-slate-100">{failedCount}</div>
                  </div>
                </div>
              </div>
            </DashboardPanel>

            <DashboardPanel variant="flat" className="p-4">
              <DashboardSectionHeader eyebrow="Next action" title={nextTask ? nextTask.title : readyCount > 0 ? 'Create a local plan' : 'Add a source'} detail={nextTask ? nextTask.detail : readyCount > 0 ? 'Turn ready source context into a scoped plan.' : 'Connect a local source before planning.'} />
              <div className="mt-4 flex flex-wrap gap-2">
                <DashboardButton type="button" variant="primary" onClick={nextTask ? onOpenHandoff : onOpenPlan}>
                  {nextTask ? 'Open handoff' : 'Create plan'}
                </DashboardButton>
                <DashboardButton type="button" variant="secondary" onClick={onManageSources}>
                  Sources
                </DashboardButton>
              </div>
              <div className="mt-4 rounded-[14px] bg-bf-subtle/45 px-3 py-2.5 text-[12px] leading-5 text-bf-muted dark:bg-slate-950/28 dark:text-slate-300">
                Setup completion is {setupProgress}%. {setupProgress >= 75 ? 'The checklist now stays compact in Overview.' : 'Complete setup to keep the workspace ready.'}
              </div>
            </DashboardPanel>
          </div>
        </div>

        <div className="grid min-h-0 gap-3">
          <DashboardPanel variant="flat" className="p-4">
            <DashboardSectionHeader eyebrow="Top sources" title="Largest contexts" detail="Most indexed local sources." />
            <div className="mt-3 space-y-2">
              {topSources.length === 0 ? (
                <p className="text-[12px] text-bf-muted dark:text-slate-400">No sources connected yet.</p>
              ) : topSources.map(source => {
                const count = source.indexedFileCount ?? 0
                const percent = indexedFiles > 0 ? Math.max(8, Math.round((count / indexedFiles) * 100)) : 8
                return (
                  <div key={source.id} className="space-y-1.5">
                    <div className="flex items-start justify-between gap-3 text-[12px]">
                      <div className="min-w-0 flex-1">
                        <div className="break-words font-medium text-bf-text dark:text-slate-100">{source.label}</div>
                        <div className="mt-0.5 text-[11px] text-bf-muted dark:text-slate-400">{formatCount(count)} files</div>
                      </div>
                      <div className="shrink-0 text-[11px] text-bf-muted dark:text-slate-400">{percent}%</div>
                    </div>
                    <div className="h-1 overflow-hidden rounded-full bg-bf-subtle dark:bg-slate-900">
                      <div className="h-full rounded-full bg-blue-500/80" style={{ width: `${percent}%` }} />
                    </div>
                  </div>
                )
              })}
            </div>
          </DashboardPanel>

          <DashboardPanel variant="flat" className="p-4">
            <DashboardSectionHeader eyebrow="Workflow" title="Your local flow" detail="Connect, plan, execute, verify." />
            <div className="mt-3 space-y-2 text-[12px]">
              {[
                ['Connect sources', readyCount > 0],
                ['Plan in ChatGPT', Boolean(localPlan)],
                ['Prepare handoff', readyCount > 0],
                ['Verify safe changes', writeMode === 'safeWrites']
              ].map(([label, done]) => (
                <div key={String(label)} className="flex items-center gap-2 text-bf-muted dark:text-slate-300">
                  {done ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" strokeWidth={1.8} /> : <DashboardStatusDot tone="neutral" />}
                  <span>{label}</span>
                </div>
              ))}
            </div>
          </DashboardPanel>
        </div>
      </div>
    </div>
  )
}
