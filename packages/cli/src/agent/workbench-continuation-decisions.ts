import fs from 'fs'
import path from 'path'
import { getConfigDir } from '../utils/paths'

export const WORKBENCH_CONTINUATION_DECISION_STORE_VERSION = 1 as const

export type WorkbenchContinuationDecision = {
  version: typeof WORKBENCH_CONTINUATION_DECISION_STORE_VERSION
  runId: string
  packetId: string
  outcome: 'continue' | 'stop' | 'repair' | 'blocked'
  nextTaskId?: string
  evidence: {
    status: string
    completedSteps: number
    validationPassed: boolean
    commitHash?: string
    errorCodes: string[]
  }
  reason: string
  decidedAt: string
}

type WorkbenchContinuationDecisionStore = {
  version: typeof WORKBENCH_CONTINUATION_DECISION_STORE_VERSION
  updatedAt: string
  decisions: WorkbenchContinuationDecision[]
}

const STORE_PATH = path.join(getConfigDir(), 'workbench-continuation-decisions.json')
const MAX_DECISIONS = 500
const MAX_REASON_LENGTH = 320
const MAX_ERROR_CODES = 8

function emptyStore(): WorkbenchContinuationDecisionStore {
  return {
    version: WORKBENCH_CONTINUATION_DECISION_STORE_VERSION,
    updatedAt: new Date().toISOString(),
    decisions: []
  }
}

function compactReason(value: string): string {
  const cleaned = String(value || '').replace(/\s+/g, ' ').trim()
  return cleaned.length > MAX_REASON_LENGTH
    ? `${cleaned.slice(0, MAX_REASON_LENGTH - 3)}...`
    : cleaned
}

function isDecision(value: unknown): value is WorkbenchContinuationDecision {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<WorkbenchContinuationDecision>
  return item.version === WORKBENCH_CONTINUATION_DECISION_STORE_VERSION
    && typeof item.runId === 'string'
    && typeof item.packetId === 'string'
    && ['continue', 'stop', 'repair', 'blocked'].includes(String(item.outcome || ''))
    && typeof item.evidence?.status === 'string'
    && typeof item.evidence?.completedSteps === 'number'
    && typeof item.evidence?.validationPassed === 'boolean'
    && Array.isArray(item.evidence?.errorCodes)
    && typeof item.reason === 'string'
    && typeof item.decidedAt === 'string'
}

function readStore(): WorkbenchContinuationDecisionStore {
  try {
    if (!fs.existsSync(STORE_PATH)) return emptyStore()
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as Partial<WorkbenchContinuationDecisionStore>
    return {
      version: WORKBENCH_CONTINUATION_DECISION_STORE_VERSION,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      decisions: Array.isArray(parsed.decisions)
        ? parsed.decisions.filter(isDecision).slice(-MAX_DECISIONS)
        : []
    }
  } catch {
    return emptyStore()
  }
}

function persistStore(store: WorkbenchContinuationDecisionStore): void {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true })
  const payload: WorkbenchContinuationDecisionStore = {
    version: WORKBENCH_CONTINUATION_DECISION_STORE_VERSION,
    updatedAt: new Date().toISOString(),
    decisions: store.decisions
      .sort((a, b) => a.decidedAt.localeCompare(b.decidedAt))
      .slice(-MAX_DECISIONS)
  }
  const temporaryPath = `${STORE_PATH}.tmp`
  fs.writeFileSync(temporaryPath, JSON.stringify(payload), 'utf8')
  fs.renameSync(temporaryPath, STORE_PATH)
}

export function recordWorkbenchContinuationDecision(
  input: Omit<WorkbenchContinuationDecision, 'version' | 'reason' | 'decidedAt'> & {
    reason: string
    decidedAt?: string
  }
): WorkbenchContinuationDecision {
  const decision: WorkbenchContinuationDecision = {
    version: WORKBENCH_CONTINUATION_DECISION_STORE_VERSION,
    runId: String(input.runId || '').trim(),
    packetId: String(input.packetId || '').trim(),
    outcome: input.outcome,
    nextTaskId: input.nextTaskId ? String(input.nextTaskId).trim() : undefined,
    evidence: {
      status: String(input.evidence.status || '').trim(),
      completedSteps: Math.max(0, Number(input.evidence.completedSteps || 0)),
      validationPassed: input.evidence.validationPassed === true,
      commitHash: input.evidence.commitHash ? String(input.evidence.commitHash).trim() : undefined,
      errorCodes: Array.from(new Set(input.evidence.errorCodes.map(code => String(code || '').trim()).filter(Boolean))).slice(0, MAX_ERROR_CODES)
    },
    reason: compactReason(input.reason),
    decidedAt: input.decidedAt || new Date().toISOString()
  }

  if (!decision.runId) throw new Error('runId is required')
  if (!decision.packetId) throw new Error('packetId is required')
  if (!decision.evidence.status) throw new Error('evidence status is required')
  if (!decision.reason) throw new Error('continuation decision reason is required')

  const store = readStore()
  store.decisions = store.decisions.filter(item => item.packetId !== decision.packetId)
  store.decisions.push(decision)
  persistStore(store)
  return decision
}

export function getWorkbenchContinuationDecision(packetId: string): WorkbenchContinuationDecision | undefined {
  const normalizedPacketId = String(packetId || '').trim()
  if (!normalizedPacketId) return undefined
  return readStore().decisions.find(item => item.packetId === normalizedPacketId)
}

export function listWorkbenchContinuationDecisions(params: { runId?: string; limit?: number } = {}): WorkbenchContinuationDecision[] {
  const limit = Math.max(1, Math.min(50, Number(params.limit || 20)))
  const runId = String(params.runId || '').trim()
  return readStore().decisions
    .filter(item => !runId || item.runId === runId)
    .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))
    .slice(0, limit)
}
