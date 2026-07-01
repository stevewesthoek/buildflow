import fs from 'fs'
import path from 'path'
import { getConfigDir } from '../utils/paths'

export const WORKBENCH_REPAIR_STATE_VERSION = 1 as const
export const MAX_AUTOMATIC_REPAIR_ATTEMPTS = 1 as const

export type WorkbenchRepairState = {
  version: typeof WORKBENCH_REPAIR_STATE_VERSION
  runId: string
  taskId: string
  failedPacketId: string
  attemptCount: number
  status: 'eligible' | 'accepted' | 'exhausted' | 'cleared'
  updatedAt: string
  acceptedRepairPacketId?: string
  lastFailurePacketId?: string
}

type WorkbenchRepairStateStore = {
  version: typeof WORKBENCH_REPAIR_STATE_VERSION
  updatedAt: string
  states: WorkbenchRepairState[]
}

const STORE_PATH = path.join(getConfigDir(), 'workbench-repair-state.json')
const MAX_REPAIR_STATES = 500

function emptyStore(): WorkbenchRepairStateStore {
  return {
    version: WORKBENCH_REPAIR_STATE_VERSION,
    updatedAt: new Date().toISOString(),
    states: []
  }
}

function normalizeState(value: unknown): WorkbenchRepairState | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Partial<WorkbenchRepairState>
  if (item.version !== WORKBENCH_REPAIR_STATE_VERSION) return undefined
  if (typeof item.runId !== 'string' || !item.runId.trim()) return undefined
  if (typeof item.taskId !== 'string' || !item.taskId.trim()) return undefined
  if (typeof item.failedPacketId !== 'string' || !item.failedPacketId.trim()) return undefined
  if (!['eligible', 'accepted', 'exhausted', 'cleared'].includes(String(item.status))) return undefined

  const attemptCount = Math.max(0, Math.floor(Number(item.attemptCount || 0)))
  return {
    version: WORKBENCH_REPAIR_STATE_VERSION,
    runId: item.runId,
    taskId: item.taskId,
    failedPacketId: item.failedPacketId,
    attemptCount,
    status: attemptCount >= MAX_AUTOMATIC_REPAIR_ATTEMPTS && item.status === 'eligible'
      ? 'exhausted'
      : item.status as WorkbenchRepairState['status'],
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date().toISOString(),
    acceptedRepairPacketId: typeof item.acceptedRepairPacketId === 'string' ? item.acceptedRepairPacketId : undefined,
    lastFailurePacketId: typeof item.lastFailurePacketId === 'string' ? item.lastFailurePacketId : undefined
  }
}

function readStore(): WorkbenchRepairStateStore {
  try {
    if (!fs.existsSync(STORE_PATH)) return emptyStore()
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as Partial<WorkbenchRepairStateStore>
    return {
      version: WORKBENCH_REPAIR_STATE_VERSION,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      states: Array.isArray(parsed.states)
        ? parsed.states.map(normalizeState).filter((state): state is WorkbenchRepairState => Boolean(state)).slice(-MAX_REPAIR_STATES)
        : []
    }
  } catch {
    return emptyStore()
  }
}

function persistStore(store: WorkbenchRepairStateStore): void {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true })
  const payload: WorkbenchRepairStateStore = {
    version: WORKBENCH_REPAIR_STATE_VERSION,
    updatedAt: new Date().toISOString(),
    states: store.states
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .slice(-MAX_REPAIR_STATES)
  }
  const temporaryPath = `${STORE_PATH}.tmp`
  fs.writeFileSync(temporaryPath, JSON.stringify(payload), 'utf8')
  fs.renameSync(temporaryPath, STORE_PATH)
}

function stateIndex(store: WorkbenchRepairStateStore, runId: string, taskId: string): number {
  return store.states.findIndex(state => state.runId === runId && state.taskId === taskId)
}

export function getWorkbenchRepairState(runId: string, taskId: string): WorkbenchRepairState | undefined {
  return readStore().states.find(state => state.runId === runId && state.taskId === taskId)
}

export function recordWorkbenchRepairEligibility(params: {
  runId: string
  taskId: string
  failedPacketId: string
}): WorkbenchRepairState {
  const store = readStore()
  const index = stateIndex(store, params.runId, params.taskId)
  const previous = index >= 0 ? store.states[index] : undefined
  const attemptCount = previous?.attemptCount || 0
  const state: WorkbenchRepairState = {
    version: WORKBENCH_REPAIR_STATE_VERSION,
    runId: params.runId,
    taskId: params.taskId,
    failedPacketId: params.failedPacketId,
    attemptCount,
    status: attemptCount >= MAX_AUTOMATIC_REPAIR_ATTEMPTS ? 'exhausted' : 'eligible',
    updatedAt: new Date().toISOString(),
    acceptedRepairPacketId: previous?.acceptedRepairPacketId,
    lastFailurePacketId: params.failedPacketId
  }
  if (index >= 0) store.states[index] = state
  else store.states.push(state)
  persistStore(store)
  return state
}

export function acceptWorkbenchRepairAttempt(params: {
  runId: string
  taskId: string
  failedPacketId: string
  repairPacketId: string
}): WorkbenchRepairState {
  const store = readStore()
  const index = stateIndex(store, params.runId, params.taskId)
  const previous = index >= 0 ? store.states[index] : undefined
  if (!previous || previous.failedPacketId !== params.failedPacketId) {
    throw new Error('Repair acceptance requires matching persisted failed packet state.')
  }
  if (previous.status !== 'eligible' || previous.attemptCount >= MAX_AUTOMATIC_REPAIR_ATTEMPTS) {
    throw new Error('Automatic repair attempt is not eligible for this task.')
  }

  const state: WorkbenchRepairState = {
    ...previous,
    attemptCount: previous.attemptCount + 1,
    status: 'accepted',
    acceptedRepairPacketId: params.repairPacketId,
    updatedAt: new Date().toISOString()
  }
  store.states[index] = state
  persistStore(store)
  return state
}

export function exhaustWorkbenchRepairState(params: {
  runId: string
  taskId: string
  failedPacketId: string
}): WorkbenchRepairState {
  const store = readStore()
  const index = stateIndex(store, params.runId, params.taskId)
  const previous = index >= 0 ? store.states[index] : undefined
  const state: WorkbenchRepairState = {
    version: WORKBENCH_REPAIR_STATE_VERSION,
    runId: params.runId,
    taskId: params.taskId,
    failedPacketId: params.failedPacketId,
    attemptCount: Math.max(MAX_AUTOMATIC_REPAIR_ATTEMPTS, previous?.attemptCount || 0),
    status: 'exhausted',
    updatedAt: new Date().toISOString(),
    acceptedRepairPacketId: previous?.acceptedRepairPacketId,
    lastFailurePacketId: params.failedPacketId
  }
  if (index >= 0) store.states[index] = state
  else store.states.push(state)
  persistStore(store)
  return state
}

export function clearWorkbenchRepairState(runId: string, taskId: string): WorkbenchRepairState | undefined {
  const store = readStore()
  const index = stateIndex(store, runId, taskId)
  if (index < 0) return undefined
  const state: WorkbenchRepairState = {
    ...store.states[index],
    status: 'cleared',
    updatedAt: new Date().toISOString()
  }
  store.states[index] = state
  persistStore(store)
  return state
}
