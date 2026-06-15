import type { ActiveSourcesMode, KnowledgeSource, WriteMode } from '@workbench/shared'

import type { DashboardLocalPlan } from '../types'
import { DashboardButton } from './ui/DashboardButton'
import { DashboardCodeText } from './ui/DashboardCodeText'
import { DashboardListRow } from './ui/DashboardListRow'
import { DashboardMetaRow } from './ui/DashboardMetaRow'
import { DashboardPanel } from './ui/DashboardPanel'
import { DashboardSectionHeader } from './ui/DashboardSectionHeader'
import { DashboardStatusDot } from './ui/DashboardStatusDot'

type SetupChecklistPanelProps = {
  sources: KnowledgeSource[]
  agentConnected: boolean
  activeMode: ActiveSourcesMode
  activeSourceIds: string[]
  writeMode: WriteMode
  localPlan: DashboardLocalPlan | null
  openApiUrl: string
  copyStatus: 'idle' | 'copied' | 'error'
  onOpenSources: () => void
  onOpenSettings: () => void
  onOpenPlan: () => void
  onOpenHandoff: () => void
  onCopyOpenApi: () => void
  variant?: 'full' | 'compact'
}

type ChecklistItem = {
  id: string
  title: string
  detail: string
  done: boolean
  warn?: boolean
  actionLabel?: string
  onAction?: () => void
}

const statusLabel = (done: boolean, warn?: boolean) => done ? 'Done' : warn ? 'Needs attention' : 'Pending'

export function SetupChecklistPanel({
  sources,
  agentConnected,
  activeMode,
  activeSourceIds,
  writeMode,
  localPlan,
  openApiUrl,
  copyStatus,
  onOpenSources,
  onOpenSettings,
  onOpenPlan,
  onOpenHandoff,
  onCopyOpenApi,
  variant = 'full'
}: SetupChecklistPanelProps) {
  const enabledSources = sources.filter(source => source.enabled)
  const readySources = sources.filter(source => source.enabled && source.indexStatus === 'ready')
  const indexingSources = sources.filter(source => source.enabled && source.indexStatus === 'indexing')
  const failedSources = sources.filter(source => source.enabled && source.indexStatus === 'failed')
  const activeContextReady = activeMode === 'all'
    ? readySources.length > 0
    : activeSourceIds.length > 0
  const handoffReady = agentConnected && readySources.length > 0
  const completedPlanTasks = localPlan?.tasks.filter(task => task.status === 'done').length ?? 0

  const items: ChecklistItem[] = [
    {
      id: 'agent',
      title: 'Local agent running',
      detail: agentConnected ? 'BuildFlow can reach the local agent.' : 'Start the local stack with pnpm local:restart.',
      done: agentConnected,
      warn: !agentConnected
    },
    {
      id: 'openapi',
      title: 'OpenAPI endpoint ready',
      detail: openApiUrl,
      done: true,
      actionLabel: copyStatus === 'copied' ? 'Copied' : 'Copy URL',
      onAction: onCopyOpenApi
    },
    {
      id: 'sources',
      title: 'Source added',
      detail: sources.length > 0 ? `${sources.length} sources connected, ${enabledSources.length} enabled.` : 'Add at least one local source.',
      done: sources.length > 0,
      actionLabel: sources.length > 0 ? 'Review' : 'Add source',
      onAction: onOpenSources
    },
    {
      id: 'index',
      title: 'Source indexed',
      detail: readySources.length > 0
        ? `${readySources.length} sources are ready.`
        : indexingSources.length > 0
          ? `${indexingSources.length} sources are still indexing.`
          : failedSources.length > 0
            ? `${failedSources.length} sources need reindex attention.`
            : 'Index a source before relying on context.',
      done: readySources.length > 0,
      warn: failedSources.length > 0,
      actionLabel: 'Sources',
      onAction: onOpenSources
    },
    {
      id: 'context',
      title: 'Context selected',
      detail: activeContextReady
        ? `${activeMode === 'all' ? 'All enabled ready sources' : `${activeSourceIds.length} selected sources`} are in context.`
        : 'Choose a source context in Settings.',
      done: activeContextReady,
      actionLabel: 'Settings',
      onAction: onOpenSettings
    },
    {
      id: 'write-mode',
      title: 'Write mode reviewed',
      detail: `Current mode: ${writeMode}.`,
      done: true,
      actionLabel: 'Settings',
      onAction: onOpenSettings
    },
    {
      id: 'plan',
      title: 'Local plan prepared',
      detail: localPlan ? `${completedPlanTasks}/${localPlan.tasks.length} tasks complete.` : 'Create a small local execution plan.',
      done: Boolean(localPlan),
      actionLabel: localPlan ? 'Open plan' : 'Create plan',
      onAction: onOpenPlan
    },
    {
      id: 'handoff',
      title: 'Handoff ready',
      detail: handoffReady ? 'Codex and Claude prompts can use the current workspace context.' : 'Add and index a source before handoff.',
      done: handoffReady,
      actionLabel: 'Handoff',
      onAction: onOpenHandoff
    }
  ]

  const doneCount = items.filter(item => item.done).length
  const mostlyComplete = doneCount >= Math.max(items.length - 2, 5)
  if (variant === 'compact') {
    return (
      <DashboardPanel variant="flat" className="overflow-hidden px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <DashboardSectionHeader
            eyebrow="Setup"
            title={mostlyComplete ? 'Setup almost complete' : 'First-run checklist'}
            detail={`${doneCount}/${items.length} steps complete · Open Settings to review the full checklist.`}
          />
          <DashboardButton type="button" variant="secondary" onClick={onOpenSettings}>Review setup</DashboardButton>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-bf-subtle/70 px-2.5 py-1 text-[11px] text-bf-muted dark:bg-slate-900/50 dark:text-slate-300">
            <DashboardStatusDot tone={agentConnected ? 'good' : 'neutral'} />
            {agentConnected ? 'Agent ready' : 'Agent offline'}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-bf-subtle/70 px-2.5 py-1 text-[11px] text-bf-muted dark:bg-slate-900/50 dark:text-slate-300">
            <DashboardStatusDot tone={readySources.length > 0 ? 'good' : indexingSources.length > 0 ? 'warn' : 'neutral'} />
            {readySources.length > 0 ? `${readySources.length} sources ready` : indexingSources.length > 0 ? `${indexingSources.length} indexing` : 'No ready sources'}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-bf-subtle/70 px-2.5 py-1 text-[11px] text-bf-muted dark:bg-slate-900/50 dark:text-slate-300">
            <DashboardStatusDot tone={localPlan ? 'good' : 'neutral'} />
            {localPlan ? `${localPlan.tasks.length} plan tasks` : 'No local plan'}
          </span>
        </div>
      </DashboardPanel>
    )
  }

  const shownItems = items

  return (
    <DashboardPanel variant="flat" className="overflow-hidden">
      <div className="p-4 pb-3">
        <DashboardSectionHeader
          eyebrow="Setup"
          title="First-run checklist"
          detail={`${doneCount}/${items.length} local setup steps complete.`}
        />
        <div className="mt-3">
          <DashboardMetaRow label="OpenAPI" value={<DashboardCodeText>{openApiUrl}</DashboardCodeText>} />
        </div>
      </div>
      <div className="divide-y divide-bf-border/55 dark:divide-slate-800/60">
        {shownItems.map(item => (
          <DashboardListRow key={item.id} className="items-start rounded-none px-4 py-3 hover:bg-bf-subtle/45 dark:hover:bg-slate-900/35">
            <DashboardStatusDot tone={item.done ? 'good' : item.warn ? 'warn' : 'neutral'} className="mt-1.5" />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="text-[12px] font-medium text-bf-text dark:text-slate-100">{item.title}</span>
                <span className="shrink-0 text-[10px] text-bf-muted dark:text-slate-500">{statusLabel(item.done, item.warn)}</span>
              </div>
              <p className="mt-1 line-clamp-2 text-[12px] leading-5 text-bf-muted dark:text-slate-300">{item.detail}</p>
            </div>
            {item.actionLabel && item.onAction ? (
              <DashboardButton type="button" variant="secondary" className="shrink-0" onClick={item.onAction}>
                {item.actionLabel}
              </DashboardButton>
            ) : null}
          </DashboardListRow>
        ))}
      </div>
      <div className="border-t border-bf-border/55 p-3 text-[12px] text-bf-muted dark:border-slate-800/60 dark:text-slate-400">
        Open Settings to review the full local setup checklist.
      </div>
    </DashboardPanel>
  )
}
