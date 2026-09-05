import fs from 'fs'
import path from 'path'
import type { IndexedDoc } from '@workbench/shared'
import { getConfigDir } from '../utils/paths'
import type { IndexScanFailureCode } from './index-scan-policy'

export type SourceIndexStatus = 'ready' | 'pending' | 'indexing' | 'failed' | 'disabled' | 'unknown'

export type SourceIndexRecord = {
  indexed?: boolean
  indexStatus: SourceIndexStatus
  indexedFileCount?: number
  indexProgressCompleted?: number
  indexProgressTotal?: number
  lastIndexedAt?: string
  indexError?: string
  indexFailureCode?: IndexScanFailureCode
  sourceRevision?: string
  sourcePathIdentity?: string
  sourceWorktreeIdentity?: string
  indexPolicyVersion?: string
  indexExclusionVersion?: string
  indexPolicyIdentity?: string
  discoveredAt?: string
  queuedAt?: string
  indexingAt?: string
  readyAt?: string
}

export type SourceIndexState = Record<string, SourceIndexRecord>

const INDEX_STATE_FILENAME = 'index-state.json'
let pendingWrite: NodeJS.Timeout | null = null
let pendingState: SourceIndexState | null = null
let pendingStatePath: string | null = null

export function getIndexStatePath(): string {
  return path.join(getConfigDir(), INDEX_STATE_FILENAME)
}

export function loadIndexState(): SourceIndexState {
  const statePath = getIndexStatePath()
  // Pending writes are authoritative inside the current process. Reading the
  // on-disk snapshot here used to lose back-to-back mutations during the
  // 500 ms debounce window (for example disable -> enable -> list).
  if (pendingState && pendingStatePath === statePath) return pendingState
  if (!fs.existsSync(statePath)) return {}
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const state = parsed as SourceIndexState
    let changed = false
    for (const [sourceId, record] of Object.entries(state)) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        delete state[sourceId]
        changed = true
        continue
      }
      if (record.indexStatus === 'indexing') {
        state[sourceId] = {
          ...record,
          indexStatus: record.indexError ? 'failed' : 'pending',
          indexed: false
        }
        changed = true
      }
    }
    if (changed) saveIndexState(state)
    return state
  } catch {
    return {}
  }
}

export function saveIndexState(state: SourceIndexState, immediate: boolean = false): void {
  const statePath = getIndexStatePath()
  if (pendingState && pendingStatePath && pendingStatePath !== statePath) {
    if (pendingWrite) clearTimeout(pendingWrite)
    pendingWrite = null
    _flushIndexState()
  }
  pendingState = state
  pendingStatePath = statePath
  if (immediate) {
    if (pendingWrite) clearTimeout(pendingWrite)
    pendingWrite = null
    _flushIndexState()
  } else if (!pendingWrite) {
    pendingWrite = setTimeout(_flushIndexState, 500)
  }
}

function _flushIndexState(): void {
  if (!pendingState) return
  const statePath = pendingStatePath || getIndexStatePath()
  const dir = path.dirname(statePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(statePath, JSON.stringify(pendingState, null, 2))
  pendingWrite = null
  pendingState = null
  pendingStatePath = null
}

export function upsertIndexState(sourceId: string, record: Partial<SourceIndexRecord>): SourceIndexState {
  const state = loadIndexState()
  const current = state[sourceId] || { indexStatus: 'unknown' }
  const next: SourceIndexRecord = {
    ...current,
    ...record,
    indexStatus: record.indexStatus || current.indexStatus || 'unknown'
  }
  state[sourceId] = next
  saveIndexState(state)
  return state
}

export function flushIndexStateOnShutdown(): void {
  if (pendingWrite) {
    clearTimeout(pendingWrite)
    _flushIndexState()
  }
}

export function getIndexRecord(sourceId: string): SourceIndexRecord | undefined {
  return loadIndexState()[sourceId]
}

/**
 * Reconciliation only updates the observed document count. It must not infer
 * readiness from documents left by an older or interrupted build; readiness is
 * established by the explicit successful build transition and revision check.
 */
export function reconcileIndexRecord(current: SourceIndexRecord | undefined, indexedFileCount: number): SourceIndexRecord {
  const indexStatus = current?.indexStatus && current.indexStatus !== 'unknown'
    ? current.indexStatus
    : 'pending'
  return {
    ...(current || {}),
    indexed: indexStatus === 'ready',
    indexStatus,
    indexedFileCount,
    indexError: indexStatus === 'ready' ? undefined : current?.indexError
  }
}

export function reconcileIndexStateFromDocs(docs: IndexedDoc[], sources: Array<{ id: string; enabled: boolean }>): void {
  const state = loadIndexState()
  const counts = docs.reduce<Record<string, number>>((acc, doc) => {
    acc[doc.sourceId] = (acc[doc.sourceId] || 0) + 1
    return acc
  }, {})

  for (const source of sources) {
    if (!source.enabled) {
      state[source.id] = {
        ...(state[source.id] || {}),
        indexed: false,
        indexStatus: 'disabled',
        indexedFileCount: counts[source.id] || 0,
        indexError: state[source.id]?.indexError
      }
      continue
    }

    const indexedFileCount = counts[source.id] || 0
    const current = state[source.id]
    state[source.id] = reconcileIndexRecord(current, indexedFileCount)
  }

  saveIndexState(state)
}
