import type { KnowledgeSource } from '@workbench/shared'
import { Activity, Database, GitBranch, LayoutDashboard, ListChecks, Settings } from 'lucide-react'
import { getSourceIndexStatusLabel } from '../helpers'
import { DashboardListRow } from './ui/DashboardListRow'
import { DashboardNavItem } from './ui/DashboardNavItem'
import { DashboardStatusDot } from './ui/DashboardStatusDot'

type DashboardSection = 'overview' | 'sources' | 'activity' | 'plan' | 'handoff' | 'settings'

type DashboardRailProps = {
  activeSection: DashboardSection
  sources: KnowledgeSource[]
  selectedSourceId: string | null
  onSelectSection: (section: DashboardSection) => void
  onSelectSource: (sourceId: string) => void
}

const NAV_ITEMS: { id: DashboardSection; label: string; icon: JSX.Element }[] = [
  { id: 'overview', label: 'Overview', icon: <LayoutDashboard className="h-3.5 w-3.5" strokeWidth={1.8} /> },
  { id: 'sources', label: 'Sources', icon: <Database className="h-3.5 w-3.5" strokeWidth={1.8} /> },
  { id: 'activity', label: 'Activity', icon: <Activity className="h-3.5 w-3.5" strokeWidth={1.8} /> },
  { id: 'plan', label: 'Plans', icon: <ListChecks className="h-3.5 w-3.5" strokeWidth={1.8} /> },
  { id: 'handoff', label: 'Handoff', icon: <GitBranch className="h-3.5 w-3.5" strokeWidth={1.8} /> },
  { id: 'settings', label: 'Settings', icon: <Settings className="h-3.5 w-3.5" strokeWidth={1.8} /> }
]

export function DashboardRail({
  activeSection,
  sources,
  selectedSourceId,
  onSelectSection,
  onSelectSource
}: DashboardRailProps) {
  const shownSources = sources.slice(0, 5)

  return (
    <aside className="flex h-full min-h-0 flex-col border-r border-bf-border/80 bg-bf-bg/96 dark:border-slate-800/80 dark:bg-slate-950/78">
      <div className="shrink-0 border-b border-bf-border/70 px-3 py-3.5 dark:border-slate-800/70">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-md border border-bf-border/80 bg-bf-surface text-[11px] font-semibold text-bf-text dark:border-slate-800 dark:bg-slate-900 dark:text-slate-50">
            BF
          </div>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-bf-text dark:text-slate-50">BuildFlow Local</div>
            <div className="text-[11px] text-bf-muted dark:text-slate-400">Local repo workbench</div>
          </div>
        </div>
      </div>

      <nav className="shrink-0 px-2.5 py-2.5">
        <div className="space-y-1">
          {NAV_ITEMS.map(item => {
            const isActive = activeSection === item.id
            return (
              <DashboardNavItem
                key={item.id}
                onClick={() => onSelectSection(item.id)}
                active={isActive}
                icon={item.icon}
                aria-current={isActive ? 'page' : undefined}
              >
                {item.label}
              </DashboardNavItem>
            )
          })}
        </div>
      </nav>

      <div className="min-h-0 flex-1 px-2.5 pb-2.5">
        <div className="flex h-full min-h-0 flex-col">
          <div className="shrink-0 px-1 pb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-bf-muted dark:text-slate-400">
            Sources
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-0.5">
            {shownSources.length === 0 ? (
              <div className="rounded-lg border border-dashed border-bf-border/70 bg-bf-subtle px-3 py-3 text-sm text-bf-muted dark:border-slate-800/70 dark:bg-slate-950/40 dark:text-slate-300">
                No sources yet. Add a local folder in Sources.
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-bf-border/70 bg-bf-surface/80 shadow-[0_10px_24px_-20px_rgba(15,23,42,0.25)] dark:border-slate-800/70 dark:bg-slate-950/40 dark:shadow-[0_10px_24px_-20px_rgba(15,23,42,0.5)]">
                {shownSources.map(source => (
                  <DashboardListRow
                    key={source.id}
                    className="px-2.5"
                    selected={selectedSourceId === source.id}
                    onClick={() => onSelectSource(source.id)}
                  >
                    <DashboardStatusDot tone={source.enabled ? 'good' : 'neutral'} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-bf-text dark:text-slate-50">{source.label}</div>
                      <div className="truncate font-mono-ui text-[10px] text-bf-muted dark:text-slate-400">{source.path}</div>
                    </div>
                    <div className="shrink-0 text-right text-[10px] text-bf-muted dark:text-slate-400">{getSourceIndexStatusLabel(source)}</div>
                  </DashboardListRow>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </aside>
  )
}
