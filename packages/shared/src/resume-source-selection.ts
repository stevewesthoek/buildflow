export type ResumeSourceSelection =
  | {
      status: 'ready'
      sourceId: string
      sourceCount: 1
    }
  | {
      status: 'source_selection_required'
      reason: 'no_active_source' | 'multiple_active_sources'
      sourceCount: number
      nextAction: string
    }

/**
 * Resume is source-bound. A status response must never make the GPT choose
 * between several globally active sources by array order.
 */
export function resolveResumeSourceSelection(activeSourceIds: readonly unknown[]): ResumeSourceSelection {
  const sourceIds = [...new Set(activeSourceIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))]
  if (sourceIds.length === 1) {
    return { status: 'ready', sourceId: sourceIds[0], sourceCount: 1 }
  }

  return {
    status: 'source_selection_required',
    reason: sourceIds.length === 0 ? 'no_active_source' : 'multiple_active_sources',
    sourceCount: sourceIds.length,
    nextAction: sourceIds.length === 0
      ? 'Select one source before resuming.'
      : 'Ask which named source to resume; never choose by source ID or array order.'
  }
}
