import type { KnowledgeSource, ActiveSourcesMode, WriteMode } from '@workbench/shared'

export type DashboardSection = 'overview' | 'sources' | 'activity' | 'plan' | 'handoff' | 'settings'

export type DashboardActivityTone = 'neutral' | 'good' | 'warn' | 'bad'

export type DashboardActivityEvent = {
  id: string
  type: string
  title: string
  detail: string
  timestamp: string
  tone: DashboardActivityTone
}

export type DashboardSourceSnapshot = {
  sources: KnowledgeSource[]
  activeMode: ActiveSourcesMode
  activeSourceIds: string[]
  writeMode: WriteMode
  savedAt: string
}

export type DashboardPlanTaskStatus = 'pending' | 'active' | 'done' | 'blocked'

export type DashboardPlanTask = {
  id: string
  title: string
  detail: string
  status: DashboardPlanTaskStatus
}

export type DashboardLocalPlan = {
  id: string
  title: string
  summary: string
  sourceId: string | null
  createdAt: string
  updatedAt: string
  tasks: DashboardPlanTask[]
}
