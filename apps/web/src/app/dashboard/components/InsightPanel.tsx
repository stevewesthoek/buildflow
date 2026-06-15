import type { ActiveSourcesMode, KnowledgeSource, WriteMode } from '@workbench/shared'

import { DashboardButton } from './ui/DashboardButton'
import { DashboardCodeText } from './ui/DashboardCodeText'
import { DashboardMetaRow } from './ui/DashboardMetaRow'
import { DashboardPanel } from './ui/DashboardPanel'
import { DashboardSectionHeader } from './ui/DashboardSectionHeader'
import { DashboardStatusDot } from './ui/DashboardStatusDot'
import type { DashboardActivityEvent, DashboardLocalPlan, DashboardSection } from '../types'

type InsightPanelProps = {
  loading: boolean
  error: string | null
  section: DashboardSection
  activeMode: ActiveSourcesMode
  writeMode: WriteMode
  agentConnected: boolean
  activityEntries: DashboardActivityEvent[]
  localPlan: DashboardLocalPlan | null
  sources: KnowledgeSource[]
  selectedSource: KnowledgeSource | null
  activeSourceIds: string[]
  onSelectSource: (sourceId: string) => void
  onToggleActiveSource: (sourceId: string) => void
  onToggleEnabled: (source: KnowledgeSource, nextEnabled: boolean) => void
  onReindexSource: (source: KnowledgeSource) => void
  onRemoveSource: (source: KnowledgeSource) => void
}

const toneClasses: Record<NonNullable<DashboardActivityEvent['tone']>, string> = {
  neutral: 'text-slate-700 dark:text-slate-300',
  good: 'text-emerald-700 dark:text-emerald-300',
  warn: 'text-amber-700 dark:text-amber-300',
  bad: 'text-red-700 dark:text-red-300'
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

export function InsightPanel({
  loading,
  error,
  section,
  activeMode,
  writeMode,
  agentConnected,
  activityEntries,
  localPlan,
  sources,
  selectedSource,
  activeSourceIds,
  onSelectSource,
  onToggleActiveSource,
  onToggleEnabled,
  onReindexSource,
  onRemoveSource
}: InsightPanelProps) {
  const titleBySection: Record<DashboardSection, string> = {
    overview: 'Inspector',
    sources: 'Sources',
    activity: 'Activity',
    plan: 'Plans',
    handoff: 'Handoff',
    settings: 'Settings'
  }

  const shownActivity = activityEntries.slice(0, 4)
  const primaryActivity = activityEntries[0]
  const selectedSourceIndex = selectedSource ? sources.findIndex(source => source.id === selectedSource.id) : -1
  const doneTaskCount = localPlan?.tasks.filter(task => task.status === 'done').length ?? 0
  const nextPlanTask = localPlan?.tasks.find(task => task.status === 'active') || localPlan?.tasks.find(task => task.status === 'pending') || localPlan?.tasks[0] || null
  const readySourceCount = sources.filter(source => source.enabled && source.indexStatus === 'ready').length
  const topSource = [...sources].sort((a, b) => (b.indexedFileCount ?? 0) - (a.indexedFileCount ?? 0))[0] || null

  const selectedSourceBody = selectedSource ? (
    <div className="space-y-3">
      <DashboardSectionHeader
        eyebrow="Source"
        title={selectedSource.label}
        detail={selectedSource.path}
      />
      <div className="space-y-1.5">
        <DashboardMetaRow label="ID" value={<DashboardCodeText>{selectedSource.id}</DashboardCodeText>} className="text-[12px]" />
        <DashboardMetaRow label="Path" value={<DashboardCodeText>{selectedSource.path}</DashboardCodeText>} className="text-[12px]" />
        <DashboardMetaRow label="Index" value={selectedSource.indexStatus || 'unknown'} className="text-[12px]" />
        <DashboardMetaRow label="Files" value={typeof selectedSource.indexedFileCount === 'number' ? selectedSource.indexedFileCount.toLocaleString() : 'Unknown'} className="text-[12px]" />
        <DashboardMetaRow label="Enabled" value={selectedSource.enabled ? 'Enabled' : 'Disabled'} className="text-[12px]" />
        <DashboardMetaRow label="Active" value={activeSourceIds.includes(selectedSource.id) ? 'Active' : 'Idle'} className="text-[12px]" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <DashboardButton type="button" variant="secondary" className="justify-center" onClick={() => onSelectSource(selectedSource.id)}>
          Focus
        </DashboardButton>
        <DashboardButton
          type="button"
          variant="secondary"
          className="justify-center"
          onClick={() => onToggleActiveSource(selectedSource.id)}
          disabled={!selectedSource.enabled && !activeSourceIds.includes(selectedSource.id)}
        >
          {activeSourceIds.includes(selectedSource.id) ? 'Deactivate' : 'Activate'}
        </DashboardButton>
        <DashboardButton
          type="button"
          variant="secondary"
          className="justify-center"
          onClick={() => onToggleEnabled(selectedSource, !selectedSource.enabled)}
        >
          {selectedSource.enabled ? 'Disable' : 'Enable'}
        </DashboardButton>
        <DashboardButton
          type="button"
          variant="secondary"
          className="justify-center"
          onClick={() => onReindexSource(selectedSource)}
          disabled={!selectedSource.enabled || selectedSource.indexStatus === 'indexing'}
        >
          Reindex
        </DashboardButton>
        <DashboardButton
          type="button"
          variant="danger"
          className="col-span-2 justify-center"
          onClick={() => onRemoveSource(selectedSource)}
        >
          Remove source
        </DashboardButton>
      </div>
      <div className="rounded-md border border-bf-border/60 bg-bf-subtle/40 px-3 py-2 dark:border-slate-800/70 dark:bg-slate-950/35">
        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-bf-muted dark:text-slate-400">Selection</div>
        <div className="mt-1 text-[12px] text-bf-muted dark:text-slate-300">
          {selectedSourceIndex >= 0
            ? `Source ${selectedSourceIndex + 1} of ${sources.length}.`
            : 'Source selected from the workspace.'}
        </div>
      </div>
    </div>
  ) : null

  const contextualBody = (() => {
    switch (section) {
      case 'overview':
        return (
          <div className="space-y-3">
            <div className="rounded-[14px] bg-bf-subtle/35 px-3 py-2.5 ring-1 ring-inset ring-bf-border/35 dark:bg-slate-950/24 dark:ring-slate-800/50">
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-bf-muted dark:text-slate-400">Current state</div>
              <div className="mt-1 flex items-center gap-2 text-[12px] text-bf-text dark:text-slate-100">
                <DashboardStatusDot tone={agentConnected ? 'good' : 'neutral'} />
                <span>{agentConnected ? 'Agent connected' : 'Agent offline'}</span>
              </div>
              <div className="mt-1 text-[12px] leading-5 text-bf-muted dark:text-slate-300">
                {readySourceCount > 0 ? `${readySourceCount} ready sources` : 'No ready sources yet'}
              </div>
            </div>

            <div className="space-y-2 rounded-[14px] bg-bf-subtle/35 px-3 py-2.5 ring-1 ring-inset ring-bf-border/35 dark:bg-slate-950/24 dark:ring-slate-800/50">
              <DashboardMetaRow label="Next action" value={primaryActivity?.title || 'Use Sources or Handoff'} />
              <DashboardMetaRow label="Plan" value={localPlan ? localPlan.title : 'No active plan'} />
              <DashboardMetaRow label="Source" value={topSource ? topSource.label : 'No source selected'} />
              <div className="pt-1 text-[12px] leading-5 text-bf-muted dark:text-slate-300">
                {primaryActivity?.detail || 'Keep the workspace calm and move straight to the next useful step.'}
              </div>
            </div>
          </div>
        )
      case 'sources':
        return (
          <div className="space-y-3">
            <DashboardMetaRow label="Mode" value={summarizeMode(activeMode)} className="text-[12px]" />
            <DashboardMetaRow label="Write" value={summarizeWriteMode(writeMode)} className="text-[12px]" />
            {selectedSource ? (
              <div className="rounded-[14px] bg-bf-subtle/35 px-3 py-2.5 ring-1 ring-inset ring-bf-border/35 dark:bg-slate-950/24 dark:ring-slate-800/50">
                <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-bf-muted dark:text-slate-400">Selection</div>
                <div className="mt-1 text-[12px] text-bf-text dark:text-slate-100">{selectedSource.label}</div>
                <div className="mt-0.5 text-[12px] leading-5 text-bf-muted dark:text-slate-300">
                  {selectedSource.indexStatus || 'unknown'} · {typeof selectedSource.indexedFileCount === 'number' ? `${selectedSource.indexedFileCount.toLocaleString()} files` : 'files unknown'}
                </div>
              </div>
            ) : (
              <div className="rounded-[14px] bg-bf-subtle/35 px-3 py-2.5 ring-1 ring-inset ring-bf-border/35 dark:bg-slate-950/24 dark:ring-slate-800/50">
                <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-bf-muted dark:text-slate-400">Source note</div>
                <div className="mt-1 text-[12px] leading-5 text-bf-muted dark:text-slate-300">
                  {loading ? 'Refreshing source state...' : 'Select a source to inspect it here.'}
                </div>
              </div>
            )}
          </div>
        )
      case 'activity':
        return (
          <div className="space-y-2">
            {shownActivity.length === 0 ? (
              <div className="rounded-[14px] border border-dashed border-bf-border/60 bg-bf-subtle/35 px-3 py-3 text-[12px] leading-5 text-bf-muted dark:border-slate-800/60 dark:bg-slate-950/24 dark:text-slate-300">
                BuildFlow activity will appear here.
              </div>
            ) : (
              shownActivity.map((entry, index) => (
                <div key={entry.id || `${entry.title}-${index}`} className="flex w-full items-start gap-2 rounded-[12px] px-3 py-2 hover:bg-bf-subtle/45 dark:hover:bg-slate-900/35">
                  <DashboardStatusDot tone={entry.tone || 'neutral'} className="mt-1" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[12px] font-medium text-bf-text dark:text-slate-50">{entry.title}</div>
                    <div className={`mt-0.5 line-clamp-2 text-[12px] leading-5 ${toneClasses[entry.tone || 'neutral']}`}>{entry.detail}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        )
      case 'plan':
        return (
          <div className="space-y-3">
            <DashboardMetaRow label="Plan" value={localPlan ? localPlan.title : 'Not loaded yet'} className="text-[12px]" />
            <DashboardMetaRow label="Progress" value={localPlan ? `${doneTaskCount}/${localPlan.tasks.length} done` : 'No tasks'} className="text-[12px]" />
            <div className="rounded-[14px] bg-bf-subtle/35 px-3 py-2.5 ring-1 ring-inset ring-bf-border/35 dark:bg-slate-950/24 dark:ring-slate-800/50">
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-bf-muted dark:text-slate-400">Next task</div>
              <div className="mt-1 truncate text-[12px] font-medium text-bf-text dark:text-slate-100">{nextPlanTask?.title || 'Create a local plan'}</div>
              <div className="mt-0.5 line-clamp-2 text-[12px] text-bf-muted dark:text-slate-300">{nextPlanTask?.detail || 'Review sources, then create a local execution plan.'}</div>
            </div>
          </div>
        )
      case 'handoff':
        return (
          <div className="space-y-3">
            <DashboardMetaRow label="Codex" value={<DashboardCodeText>Scoped review</DashboardCodeText>} className="text-[12px]" />
            <DashboardMetaRow label="Plan" value={localPlan ? `${doneTaskCount}/${localPlan.tasks.length} done` : 'No local plan'} className="text-[12px]" />
            <DashboardMetaRow label="Claude" value={<DashboardCodeText>Long-context orchestration</DashboardCodeText>} className="text-[12px]" />
            <div className="rounded-md border border-bf-border/60 bg-bf-subtle/40 px-3 py-2 dark:border-slate-800/70 dark:bg-slate-950/35">
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-bf-muted dark:text-slate-400">Copy tip</div>
              <div className="mt-1 text-[12px] text-bf-muted dark:text-slate-300">Use the compact copy buttons in the main Handoff panel.</div>
            </div>
          </div>
        )
      case 'settings':
        return (
          <div className="space-y-3">
            <DashboardMetaRow label="Agent" value={agentConnected ? 'Connected' : 'Disconnected'} className="text-[12px]" />
            <DashboardMetaRow label="Context" value={summarizeMode(activeMode)} className="text-[12px]" />
            <DashboardMetaRow label="Write" value={summarizeWriteMode(writeMode)} className="text-[12px]" />
          </div>
        )
    }
  })()

  return (
    <aside className="hidden h-full min-h-0 w-full overflow-hidden border-l border-bf-border/70 bg-bf-bg dark:border-slate-800/70 dark:bg-slate-950/90 xl:flex xl:w-[18rem] 2xl:w-[20rem]">
      <div className="flex h-full min-h-0 w-full flex-col">
        <div className="shrink-0 border-b border-bf-border/70 px-4 py-4 dark:border-slate-800/70">
          <DashboardSectionHeader eyebrow={titleBySection[section]} title={section === 'activity' ? 'Recent activity' : 'Current state'} />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4">
          <div className="space-y-3">
            <DashboardPanel variant="flat" className="p-3">
              <div className="space-y-2.5">
                <DashboardMetaRow
                  label="Agent"
                  value={<span className="inline-flex items-center gap-1.5"><DashboardStatusDot tone={agentConnected ? 'good' : 'neutral'} />{agentConnected ? 'Connected' : 'Disconnected'}</span>}
                  className="text-[12px]"
                />
                <DashboardMetaRow label="Context" value={summarizeMode(activeMode)} className="text-[12px]" />
                <DashboardMetaRow label="Write" value={summarizeWriteMode(writeMode)} className="text-[12px]" />
              </div>
            </DashboardPanel>

            {selectedSourceBody ? (
              <DashboardPanel variant="flat" className="p-3">
                {selectedSourceBody}
              </DashboardPanel>
            ) : null}

            {error ? (
              <DashboardPanel variant="flat" className="p-3">
                <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-bf-muted">Source refresh</div>
                <p className="mt-1 min-w-0 break-words text-[13px] leading-5 text-red-700 dark:text-red-200">{error}</p>
              </DashboardPanel>
            ) : null}

            <DashboardPanel variant="flat" className="p-3">
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-bf-muted dark:text-slate-400">
                {section === 'activity' ? 'Timeline' : section === 'sources' ? 'Context' : 'Section'}
              </div>
              <div className="mt-3">{contextualBody}</div>
            </DashboardPanel>
          </div>
        </div>
      </div>
    </aside>
  )
}
