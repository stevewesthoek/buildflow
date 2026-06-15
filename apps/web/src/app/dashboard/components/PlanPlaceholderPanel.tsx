import type { KnowledgeSource } from '@workbench/shared'
import { CalendarDays, CheckCircle2, Clock3, ListTodo } from 'lucide-react'

import type { DashboardLocalPlan, DashboardPlanTaskStatus } from '../types'
import { DashboardButton } from './ui/DashboardButton'
import { DashboardCodeText } from './ui/DashboardCodeText'
import { DashboardListRow } from './ui/DashboardListRow'
import { DashboardMetricCard } from './ui/DashboardMetricCard'
import { DashboardMetaRow } from './ui/DashboardMetaRow'
import { DashboardPanel } from './ui/DashboardPanel'
import { DashboardSectionHeader } from './ui/DashboardSectionHeader'
import { DashboardStatusDot } from './ui/DashboardStatusDot'

type PlanPlaceholderPanelProps = {
  sources: KnowledgeSource[]
  agentConnected: boolean
  selectedSource: KnowledgeSource | null
  plan: DashboardLocalPlan | null
  importError: string | null
  onCreatePlan: () => void
  onUpdateTaskStatus: (taskId: string, status: DashboardPlanTaskStatus) => void
  onClearPlan: () => void
  onOpenHandoff: () => void
  onExportPlan: () => void
  onImportPlan: (file: File) => void
  variant?: 'full' | 'compact'
}

const STATUS_SEQUENCE: DashboardPlanTaskStatus[] = ['pending', 'active', 'done', 'blocked']

const STATUS_TONE: Record<DashboardPlanTaskStatus, 'neutral' | 'good' | 'warn' | 'bad'> = {
  pending: 'neutral',
  active: 'good',
  done: 'good',
  blocked: 'warn'
}

const STATUS_LABEL: Record<DashboardPlanTaskStatus, string> = {
  pending: 'To do',
  active: 'In progress',
  done: 'Done',
  blocked: 'Blocked'
}

const nextStatus = (status: DashboardPlanTaskStatus) => {
  const index = STATUS_SEQUENCE.indexOf(status)
  return STATUS_SEQUENCE[(index + 1) % STATUS_SEQUENCE.length]
}

const formatTime = (value: string) => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown'
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function PlanPlaceholderPanel({
  sources,
  agentConnected,
  selectedSource,
  plan,
  importError,
  onCreatePlan,
  onUpdateTaskStatus,
  onClearPlan,
  onOpenHandoff,
  onExportPlan,
  onImportPlan,
  variant = 'full'
}: PlanPlaceholderPanelProps) {
  const readyCount = sources.filter(source => source.enabled && source.indexStatus === 'ready').length
  const nextAction =
    sources.length === 0
      ? 'Add a source first'
      : !agentConnected
        ? 'Start the local agent'
        : plan
          ? 'Continue plan'
          : 'Create local plan'

  const doneCount = plan?.tasks.filter(task => task.status === 'done').length ?? 0
  const activeCount = plan?.tasks.filter(task => task.status === 'active').length ?? 0
  const blockedCount = plan?.tasks.filter(task => task.status === 'blocked').length ?? 0
  const pendingCount = plan?.tasks.filter(task => task.status === 'pending').length ?? 0
  const taskCount = plan?.tasks.length ?? 0
  const progress = taskCount > 0 ? Math.round((doneCount / taskCount) * 100) : 0
  const activeTask = plan?.tasks.find(task => task.status === 'active') || plan?.tasks.find(task => task.status === 'pending') || plan?.tasks[0]

  if (variant === 'compact') {
    return (
      <DashboardPanel variant="flat" className="p-4">
        <DashboardSectionHeader eyebrow="Plan" title={plan ? plan.title : 'No plan loaded yet'} detail={plan ? `${plan.tasks.length} local tasks` : 'Create a local plan from the current workspace.'} />
        <div className="mt-4 space-y-2">
          <DashboardMetaRow label="Next" value={nextAction} className="text-[12px]" />
          <DashboardButton type="button" variant="secondary" className="w-full justify-start" onClick={plan ? onOpenHandoff : onCreatePlan}>
            {plan ? 'Open handoff' : nextAction}
          </DashboardButton>
        </div>
      </DashboardPanel>
    )
  }

  if (!plan) {
    return (
      <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3">
        <DashboardPanel variant="raised" className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <DashboardSectionHeader
              eyebrow="Plans & Tasks"
              title="Create a local execution plan"
              detail="Turn ready source context into a small in-browser task plan."
            />
            <div className="flex flex-wrap gap-2">
              <DashboardButton type="button" variant="primary" onClick={onCreatePlan} disabled={sources.length === 0 || !agentConnected}>
                New plan
              </DashboardButton>
              <label className="inline-flex h-7 cursor-pointer items-center justify-center rounded-[10px] border border-bf-border/80 bg-bf-surface px-2.5 text-[12px] font-medium leading-none text-bf-text transition-colors duration-150 hover:bg-bf-subtle dark:bg-slate-900/90 dark:text-slate-200 dark:hover:bg-slate-800">
                Import
                <input
                  type="file"
                  accept="application/json,.json"
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0]
                    if (file) onImportPlan(file)
                    event.currentTarget.value = ''
                  }}
                />
              </label>
            </div>
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <DashboardMetricCard label="Sources" value={sources.length} detail={`${readyCount} ready`} tone={readyCount > 0 ? 'good' : 'neutral'} />
            <DashboardMetricCard label="Agent" value={agentConnected ? 'On' : 'Off'} detail={agentConnected ? 'Connected' : 'Start local stack'} tone={agentConnected ? 'good' : 'warn'} />
            <DashboardMetricCard label="Context" value={selectedSource?.label || 'Workspace'} detail="Plan scope" />
            <DashboardMetricCard label="Tasks" value="0" detail="No plan yet" />
          </div>
          {importError ? <p className="mt-3 text-[12px] text-red-700 dark:text-red-300">{importError}</p> : null}
        </DashboardPanel>

        <DashboardPanel variant="flat" className="p-4">
          <DashboardSectionHeader eyebrow="How it works" title="A local plan stays in your browser" detail="Create the plan, cycle task state, then hand off a scoped prompt." />
          <div className="mt-5 grid gap-3 md:grid-cols-3">
            {[
              ['1', 'Review sources', 'Make sure local context is ready.'],
              ['2', 'Create a plan', 'Generate a narrow execution path.'],
              ['3', 'Open Handoff', 'Copy the plan-aware prompt.']
            ].map(([step, title, detail]) => (
              <div key={step} className="rounded-lg border border-bf-border/55 bg-bf-surface/65 p-4 dark:border-slate-800/60 dark:bg-slate-950/30">
                <div className="font-mono-ui text-[11px] text-bf-muted dark:text-slate-500">{step}</div>
                <div className="mt-2 text-[13px] font-semibold text-bf-text dark:text-slate-100">{title}</div>
                <p className="mt-1 text-[12px] leading-5 text-bf-muted dark:text-slate-300">{detail}</p>
              </div>
            ))}
          </div>
        </DashboardPanel>
      </div>
    )
  }

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3">
      <DashboardPanel variant="raised" className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <DashboardSectionHeader
            eyebrow="Plans & Tasks"
            title={plan.title}
            detail={plan.summary}
          />
          <div className="flex flex-wrap gap-2">
            <DashboardButton type="button" variant="primary" onClick={onOpenHandoff}>Handoff</DashboardButton>
            <DashboardButton type="button" variant="secondary" onClick={onExportPlan}>Export</DashboardButton>
            <label className="inline-flex h-7 cursor-pointer items-center justify-center rounded-[10px] border border-bf-border/80 bg-bf-surface px-2.5 text-[12px] font-medium leading-none text-bf-text transition-colors duration-150 hover:bg-bf-subtle dark:bg-slate-900/90 dark:text-slate-200 dark:hover:bg-slate-800">
              Import
              <input
                type="file"
                accept="application/json,.json"
                className="sr-only"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0]
                  if (file) onImportPlan(file)
                  event.currentTarget.value = ''
                }}
              />
            </label>
            <DashboardButton type="button" variant="ghost" onClick={onClearPlan}>Clear</DashboardButton>
          </div>
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <DashboardMetricCard label="Progress" value={`${progress}%`} detail={`${doneCount}/${taskCount} done`} tone={progress === 100 ? 'good' : 'neutral'} />
          <DashboardMetricCard label="Active" value={activeCount} detail="In progress" tone={activeCount > 0 ? 'warn' : 'neutral'} />
          <DashboardMetricCard label="Blocked" value={blockedCount} detail="Needs review" tone={blockedCount > 0 ? 'bad' : 'good'} />
          <DashboardMetricCard label="Updated" value={<span className="text-[14px]">{formatTime(plan.updatedAt)}</span>} detail="Local browser plan" />
        </div>
        <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-bf-subtle dark:bg-slate-900">
          <div className="h-full rounded-full bg-emerald-500" style={{ width: `${progress}%` }} />
        </div>
        {importError ? <p className="mt-3 text-[12px] text-red-700 dark:text-red-300">{importError}</p> : null}
      </DashboardPanel>

      <div className="grid min-h-0 gap-3 xl:grid-cols-[minmax(0,1.25fr)_minmax(18rem,0.7fr)]">
        <DashboardPanel variant="flat" className="min-h-0 overflow-hidden">
          <div className="border-b border-bf-border/70 px-4 py-3 dark:border-slate-800/70">
            <DashboardSectionHeader eyebrow="Task overview" title="Local execution tasks" detail={`${pendingCount} to do · ${activeCount} in progress · ${doneCount} done`} />
          </div>
          <div className="min-h-0 overflow-y-auto divide-y divide-bf-border/55 dark:divide-slate-800/60">
            {plan.tasks.map((task, index) => (
              <DashboardListRow key={task.id} className="grid min-h-[4.25rem] grid-cols-[minmax(0,1fr)_8rem] items-center gap-3 rounded-none px-4 py-2.5 hover:bg-bf-subtle/55 dark:hover:bg-slate-900/35">
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <DashboardStatusDot tone={STATUS_TONE[task.status]} />
                    <span className="font-mono-ui text-[10px] text-bf-muted dark:text-slate-500">{String(index + 1).padStart(2, '0')}</span>
                    <span className="truncate text-[13px] font-medium text-bf-text dark:text-slate-100">{task.title}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[12px] leading-5 text-bf-muted dark:text-slate-300">{task.detail}</p>
                </div>
                <DashboardButton type="button" variant="secondary" className="justify-center" onClick={() => onUpdateTaskStatus(task.id, nextStatus(task.status))}>
                  {STATUS_LABEL[task.status]}
                </DashboardButton>
              </DashboardListRow>
            ))}
          </div>
        </DashboardPanel>

        <div className="grid min-h-0 gap-3">
          <DashboardPanel variant="flat" className="p-4">
            <DashboardSectionHeader eyebrow="Next" title={activeTask?.title || 'No next task'} detail={activeTask?.detail || 'All local plan tasks are complete.'} />
            <div className="mt-4 flex flex-wrap gap-2">
              <DashboardButton type="button" variant="primary" onClick={onOpenHandoff}>Prepare handoff</DashboardButton>
              {activeTask ? <DashboardButton type="button" variant="secondary" onClick={() => onUpdateTaskStatus(activeTask.id, 'done')}>Mark done</DashboardButton> : null}
            </div>
          </DashboardPanel>

          <DashboardPanel variant="flat" className="p-4">
            <DashboardSectionHeader eyebrow="Productivity" title="Plan stats" detail="Local-only browser state." />
            <div className="mt-4 space-y-3 text-[12px] text-bf-muted dark:text-slate-300">
              <div className="flex items-center justify-between gap-3"><span className="inline-flex items-center gap-2"><ListTodo className="h-3.5 w-3.5" />Tasks</span><span>{taskCount}</span></div>
              <div className="flex items-center justify-between gap-3"><span className="inline-flex items-center gap-2"><CheckCircle2 className="h-3.5 w-3.5" />Completed</span><span>{doneCount}</span></div>
              <div className="flex items-center justify-between gap-3"><span className="inline-flex items-center gap-2"><Clock3 className="h-3.5 w-3.5" />In progress</span><span>{activeCount}</span></div>
              <div className="flex items-center justify-between gap-3"><span className="inline-flex items-center gap-2"><CalendarDays className="h-3.5 w-3.5" />Updated</span><span>{formatTime(plan.updatedAt)}</span></div>
            </div>
          </DashboardPanel>
        </div>
      </div>
    </div>
  )
}
