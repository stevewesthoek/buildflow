import fs from 'fs'
import path from 'path'
import type { IndexedDoc } from '@buildflow/shared'
import { getConfigDir } from '../utils/paths'

export type SourceIndexStatus = 'ready' | 'pending' | 'indexing' | 'failed' | 'disabled' | 'unknown'

export type SourceIndexRecord = {
  indexed?: boolean
  indexStatus: SourceIndexStatus
  indexedFileCount?: number
  lastIndexedAt?: string
  indexError?: string
}

export type SourceIndexState = Record<string, SourceIndexRecord>

const INDEX_STATE_FILENAME = 'index-state.json'
let pendingWrite: NodeJS.Timeout | null = null
let pendingState: SourceIndexState | null = null

export function getIndexStatePath(): string {
  return path.join(getConfigDir(), INDEX_STATE_FILENAME)
}

export function loadIndexState(): SourceIndexState {
  const statePath = getIndexStatePath()
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
  pendingState = state
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
  const statePath = getIndexStatePath()
  const dir = path.dirname(statePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(statePath, JSON.stringify(pendingState, null, 2))
  pendingWrite = null
  pendingState = null
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
    const hasConfirmedReady = current?.indexStatus === 'ready'
    state[source.id] = {
      ...(current || {}),
      indexed: indexedFileCount > 0 || hasConfirmedReady,
      indexStatus:
        indexedFileCount > 0 || hasConfirmedReady
          ? 'ready'
          : current?.indexStatus === 'failed' && current.indexError
            ? 'failed'
            : 'pending',
      indexedFileCount,
      indexError: indexedFileCount > 0 || hasConfirmedReady ? undefined : current?.indexError
    }
  }

  saveIndexState(state)
}
