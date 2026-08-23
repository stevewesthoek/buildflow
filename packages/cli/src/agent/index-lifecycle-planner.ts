import type { RepositoryHealth } from './context-intelligence-models'
import { planIndex, type IndexPlan, type IndexPlannerOptions } from './index-planner'

export type ChangedPathKind = 'added' | 'changed' | 'removed'
export type ChangedIndexPath = { path: string; kind: ChangedPathKind }
export type PathSnapshot = string[] | Record<string, string>
export type IndexLifecyclePlan = {
  sourceId: string
  status: 'planned' | 'completed' | 'failed'
  refresh: 'reuse' | 'observe' | 'incremental' | 'full' | 'fail'
  changedPaths: ChangedIndexPath[]
  indexPlan: IndexPlan
  reason: string
}

export function detectChangedIndexPaths(indexedPaths: PathSnapshot, observedPaths: PathSnapshot): ChangedIndexPath[] {
  const indexed = Array.isArray(indexedPaths)
    ? Object.fromEntries(indexedPaths.filter(Boolean).map(filePath => [filePath, '']))
    : indexedPaths
  const observed = Array.isArray(observedPaths)
    ? Object.fromEntries(observedPaths.filter(Boolean).map(filePath => [filePath, '']))
    : observedPaths
  return Array.from(new Set([...Object.keys(indexed), ...Object.keys(observed)])).sort().flatMap<ChangedIndexPath>(filePath => {
    if (!(filePath in indexed)) return [{ path: filePath, kind: 'added' as const }]
    if (!(filePath in observed)) return [{ path: filePath, kind: 'removed' as const }]
    if (indexed[filePath] !== '' && observed[filePath] !== '' && indexed[filePath] !== observed[filePath]) return [{ path: filePath, kind: 'changed' as const }]
    return []
  })
}

export function planIndexLifecycle(health: RepositoryHealth, indexedPaths: PathSnapshot = [], observedPaths: PathSnapshot = [], options?: IndexPlannerOptions): IndexLifecyclePlan {
  const indexPlan = planIndex({ health }, options)
  const changedPaths = detectChangedIndexPaths(indexedPaths, observedPaths)
  if (health.runtimeAvailability !== 'available' || health.freshnessState === 'unavailable') return { sourceId: health.sourceId, status: 'failed', refresh: 'fail', changedPaths, indexPlan, reason: 'Repository unavailable; no refresh work may proceed.' }
  if (indexPlan.recommendation === 'none') return { sourceId: health.sourceId, status: 'completed', refresh: 'reuse', changedPaths, indexPlan, reason: 'Fresh index may be reused.' }
  if (indexPlan.recommendation === 'observe') return { sourceId: health.sourceId, status: 'planned', refresh: 'observe', changedPaths, indexPlan, reason: 'Observation is required before refresh planning can proceed.' }
  if (indexPlan.recommendation === 'incremental') return { sourceId: health.sourceId, status: 'planned', refresh: 'incremental', changedPaths, indexPlan, reason: 'Changed repository state supports bounded incremental refresh planning.' }
  return { sourceId: health.sourceId, status: 'planned', refresh: 'full', changedPaths, indexPlan, reason: 'Full refresh is planned because incremental baseline is unavailable.' }
}
