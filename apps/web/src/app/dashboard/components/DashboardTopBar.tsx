import type { ReactNode } from 'react'
import { Code2, Moon, RefreshCw, Sun } from 'lucide-react'

import { getAgentHealthLabel } from '../helpers'
import { DashboardIconButton } from './ui/DashboardIconButton'
import { DashboardStatusDot } from './ui/DashboardStatusDot'

type DashboardTopBarProps = {
  currentSectionLabel: string
  agentConnected: boolean
  statusText?: string | null
  theme: 'light' | 'dark'
  onToggleTheme: () => void
  onRefresh: () => void
  children?: ReactNode
}

export function DashboardTopBar({
  currentSectionLabel,
  agentConnected,
  statusText,
  theme,
  onToggleTheme,
  onRefresh,
  children
}: DashboardTopBarProps) {
  const sourceUrl = process.env.NEXT_PUBLIC_WORKBENCH_SOURCE_URL || 'https://github.com/prochattools/workbench'

  return (
    <div className="shrink-0 border-b border-bf-border/80 bg-bf-surface/96 backdrop-blur supports-[backdrop-filter]:bg-bf-surface/92 dark:border-slate-800/80 dark:bg-slate-950/96">
      <div className="flex h-11 items-center justify-between gap-3 px-4 lg:px-5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-bf-muted dark:text-slate-400">
            <span className="text-bf-text dark:text-slate-200">BuildFlow</span>
            <span>·</span>
            <span>{currentSectionLabel}</span>
          </div>
        </div>

        <div className="hidden min-w-0 flex-1 items-center justify-center gap-2 xl:flex">
          <DashboardStatusDot tone={agentConnected ? 'good' : 'neutral'} />
          <span className="truncate text-[11px] font-medium text-bf-muted dark:text-slate-400">
            {getAgentHealthLabel(agentConnected)}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {children}
          <a
            href={sourceUrl}
            target="_blank"
            rel="noreferrer"
            aria-label="View corresponding source code"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-bf-border/80 px-2.5 text-[11px] font-medium text-bf-muted transition hover:bg-bf-subtle hover:text-bf-text dark:border-slate-800 dark:text-slate-400 dark:hover:bg-slate-900 dark:hover:text-slate-100"
          >
            <Code2 className="h-3.5 w-3.5" strokeWidth={1.8} />
            <span className="hidden sm:inline">Source</span>
          </a>
          <DashboardIconButton
            type="button"
            onClick={onRefresh}
            label="Refresh dashboard"
          >
            <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.8} />
          </DashboardIconButton>
          <DashboardIconButton
            type="button"
            onClick={onToggleTheme}
            label={`Switch dashboard theme to ${theme === 'dark' ? 'light' : 'dark'}`}
          >
            {theme === 'dark' ? <Sun className="h-3.5 w-3.5" strokeWidth={1.8} /> : <Moon className="h-3.5 w-3.5" strokeWidth={1.8} />}
          </DashboardIconButton>
        </div>
      </div>

      {statusText && /error|unable|fail|disconnect/i.test(statusText) ? (
        <div className="border-t border-bf-border/80 bg-bf-subtle px-5 py-2 text-[11px] dark:border-slate-800/80 dark:bg-slate-950/60">
          <div className="flex min-h-5 items-center gap-2 text-bf-muted dark:text-slate-300">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
            <span className="truncate">{statusText}</span>
          </div>
        </div>
      ) : null}
    </div>
  )
}
