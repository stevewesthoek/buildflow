import type { KnowledgeSource, ActiveSourcesMode, WriteMode } from '@workbench/shared'

import type { DashboardActivityEvent, DashboardLocalPlan } from './types'

type HandoffPromptContext = {
  sources: KnowledgeSource[]
  selectedSource: KnowledgeSource | null
  activeMode: ActiveSourcesMode
  activeSourceIds: string[]
  writeMode: WriteMode
  agentConnected: boolean
  activityFeedEntries: DashboardActivityEvent[]
  localPlan: DashboardLocalPlan | null
  currentSection?: string
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

const summarizeSource = (source: KnowledgeSource, activeSourceIds: string[]) => {
  const status = source.indexStatus || 'unknown'
  const fileCount = typeof source.indexedFileCount === 'number' ? `${source.indexedFileCount} files` : 'files unknown'
  const activeState = activeSourceIds.includes(source.id) ? 'active' : 'idle'
  return `${source.label} (${source.id}) · ${source.path} · ${source.enabled ? 'enabled' : 'disabled'} · ${activeState} · ${status} · ${fileCount}`
}

const summarizeRecentActivity = (entries: DashboardActivityEvent[], limit = 3) =>
  entries
    .slice(0, limit)
    .map(entry => `- ${entry.title}: ${entry.detail}`)
    .join('\n')

const summarizeSources = (sources: KnowledgeSource[]) => {
  const readyCount = sources.filter(source => source.enabled && source.indexStatus === 'ready').length
  const indexingCount = sources.filter(source => source.enabled && source.indexStatus === 'indexing').length
  const failedCount = sources.filter(source => source.enabled && source.indexStatus === 'failed').length
  const enabledCount = sources.filter(source => source.enabled).length

  return [
    `${sources.length} sources total`,
    `${enabledCount} enabled`,
    `${readyCount} ready`,
    indexingCount > 0 ? `${indexingCount} indexing` : null,
    failedCount > 0 ? `${failedCount} failed` : null
  ]
    .filter(Boolean)
    .join(' · ')
}

const summarizePlan = (plan: DashboardLocalPlan | null) => {
  if (!plan) return 'No local plan is loaded.'
  const tasks = plan.tasks
    .map(task => `- [${task.status}] ${task.title}: ${task.detail}`)
    .join('\n')
  return [
    `Plan: ${plan.title}`,
    `Summary: ${plan.summary}`,
    `Source: ${plan.sourceId || 'workspace'}`,
    'Tasks:',
    tasks || '- No tasks recorded.'
  ].join('\n')
}

const suggestedNextStep = (sources: KnowledgeSource[], selectedSource: KnowledgeSource | null) => {
  const readyCount = sources.filter(source => source.enabled && source.indexStatus === 'ready').length
  const indexingCount = sources.filter(source => source.enabled && source.indexStatus === 'indexing').length
  const failedSource = sources.find(source => source.enabled && source.indexStatus === 'failed')

  if (selectedSource) {
    return `Work in the selected source ${selectedSource.label} and keep the change scoped to that context.`
  }
  if (sources.length === 0) {
    return 'Add and index a local source before starting implementation work.'
  }
  if (indexingCount > 0) {
    return 'Wait for source indexing to settle, then re-check the dashboard state.'
  }
  if (failedSource) {
    return `Inspect or reindex the failed source ${failedSource.label} before making broader changes.`
  }
  if (readyCount > 0) {
    return 'Review the dashboard state and implement the next scoped task against the current workspace.'
  }
  return 'Review the workspace state and choose the next narrow task carefully.'
}

const buildGuardrails = () => [
  'Preserve API routes and endpoint contracts.',
  'Preserve the Custom GPT schema and action contracts.',
  'Preserve existing source behavior and dashboard reliability.',
  'Do not touch unrelated repositories or sources outside the requested scope.',
  'Run type-checks before finishing.',
  'Keep changes scoped and incremental.'
]

export function buildCodexHandoffPrompt(context: HandoffPromptContext) {
  const selectedSource = context.selectedSource ? `Selected source: ${summarizeSource(context.selectedSource, context.activeSourceIds)}` : 'Selected source: none'
  const activitySummary = summarizeRecentActivity(context.activityFeedEntries)
  const sourceSummary = summarizeSources(context.sources)
  const planSummary = summarizePlan(context.localPlan)
  const activeSourceSummary = context.activeSourceIds.length > 0 ? context.activeSourceIds.join(', ') : 'none'

  return [
    'You are working in the public BuildFlow Local repo.',
    `Current section: ${context.currentSection || 'Handoff'}.`,
    `Workspace status: ${context.agentConnected ? 'agent connected' : 'agent disconnected'}.`,
    selectedSource,
    `Active context mode: ${summarizeMode(context.activeMode)}.`,
    `Active sources: ${activeSourceSummary}.`,
    `Write mode: ${summarizeWriteMode(context.writeMode)}.`,
    `Source readiness: ${sourceSummary}.`,
    'Current local plan:',
    planSummary,
    `Next step: ${suggestedNextStep(context.sources, context.selectedSource)}.`,
    'Recent activity:',
    activitySummary || '- No recent activity events recorded.',
    '',
    'Guardrails:',
    ...buildGuardrails(),
    '',
    'Keep the implementation scoped to the next useful dashboard task.',
    'Report the files changed and validation results when done.'
  ].join('\n')
}

export function buildClaudeHandoffPrompt(context: HandoffPromptContext) {
  const selectedSource = context.selectedSource ? summarizeSource(context.selectedSource, context.activeSourceIds) : 'none'
  const activitySummary = summarizeRecentActivity(context.activityFeedEntries, 4)
  const sourceSummary = summarizeSources(context.sources)
  const planSummary = summarizePlan(context.localPlan)
  const activeSourceSummary = context.activeSourceIds.length > 0 ? context.activeSourceIds.join(', ') : 'none'

  return [
    'Work in the local BuildFlow repo.',
    'Use the existing dashboard design system and keep the current reliability behavior intact.',
    `Current section: ${context.currentSection || 'Handoff'}.`,
    `Agent: ${context.agentConnected ? 'connected' : 'disconnected'}.`,
    `Selected source: ${selectedSource}.`,
    `Active context mode: ${summarizeMode(context.activeMode)}.`,
    `Active sources: ${activeSourceSummary}.`,
    `Write mode: ${summarizeWriteMode(context.writeMode)}.`,
    `Source readiness: ${sourceSummary}.`,
    'Current local plan:',
    planSummary,
    `Relevant activity:`,
    activitySummary || '- No recent activity events recorded.',
    '',
    'Guardrails:',
    '- Keep source reliability intact.',
    '- Avoid broad unrelated changes.',
    '- Do not touch unrelated repositories or sources outside the requested scope.',
    '- Preserve API routes, OpenAPI, and Custom GPT contracts.',
    '- Run type-checks and the relevant dashboard validation scripts.',
    '',
    'When finished, report the files changed and the validation results.'
  ].join('\n')
}
