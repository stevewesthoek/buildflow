import type { KnowledgeSource, ActiveSourcesMode, WriteMode } from '@workbench/shared'

export function getAgentHealthLabel(agentConnected: boolean): string {
  return agentConnected ? 'Agent connected' : 'Agent disconnected'
}

export function getAgentHealthClassName(agentConnected: boolean): string {
  return agentConnected ? 'bg-emerald-500' : 'bg-slate-400'
}

export function getSourceEnabledClassName(enabled: boolean): string {
  return enabled ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'
}

export function getSourceIndexStatusClassName(indexStatus?: string): string {
  switch (indexStatus) {
    case 'ready':
      return 'bg-emerald-100 text-emerald-800'
    case 'indexing':
      return 'bg-blue-100 text-blue-800'
    case 'pending':
      return 'bg-amber-100 text-amber-800'
    case 'failed':
      return 'bg-red-100 text-red-800'
    case 'disabled':
      return 'bg-gray-100 text-gray-600'
    default:
      return 'bg-gray-100 text-gray-600'
  }
}

export function getSourceIndexStatusLabel(source: KnowledgeSource): string {
  const status = source.indexStatus || 'unknown'
  const fileCount = typeof source.indexedFileCount === 'number' ? ` · ${source.indexedFileCount} files` : ''
  return `${status}${fileCount}`
}

export function getSourceActiveClassName(isActive: boolean): string {
  return isActive ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-600'
}

export function getDisabledSourceCount(sources: KnowledgeSource[]): number {
  return sources.filter(s => !s.enabled).length
}

export function getReadySourceCount(sources: KnowledgeSource[]): number {
  return sources.filter(s => s.enabled && s.indexStatus === 'ready').length
}

export function getIndexingSourceCount(sources: KnowledgeSource[]): number {
  return sources.filter(s => s.enabled && s.indexStatus === 'indexing').length
}

export function getFailedSourceCount(sources: KnowledgeSource[]): number {
  return sources.filter(s => s.enabled && s.indexStatus === 'failed').length
}

export function getActiveContextLabel(mode: ActiveSourcesMode): string {
  switch (mode) {
    case 'single':
      return 'Single source'
    case 'multi':
      return 'Multiple sources'
    case 'all':
      return 'All enabled sources'
  }
}

export function getWriteModeLabel(mode: WriteMode): string {
  switch (mode) {
    case 'readOnly':
      return 'Read-only'
    case 'artifactsOnly':
      return 'Artifacts only'
    case 'safeWrites':
      return 'Safe writes'
  }
}
