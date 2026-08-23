import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import {
  WORKBENCH_ACTIVITY_LEDGER_SCHEMA_VERSION,
  type WorkbenchActivityEntry,
  type WorkbenchActivityEvidenceRef,
  type WorkbenchActivityKind,
  type WorkbenchActivityProgress,
  type WorkbenchActivityProjection,
  type WorkbenchActivityTelemetry
} from '@workbench/shared'
import { getConfigDir } from '../utils/paths'
import { GPT_ACTION_TARGET_BYTES, measureJsonPayload } from './payload-budget'
import { redactSecrets } from './safe-access'

export type AgentEventType =
  | 'job_started'
  | 'control_requested'
  | 'preflight_started'
  | 'command_started'
  | 'command_completed'
  | 'command_failed'
  | 'job_paused'
  | 'job_cancelled'
  | 'job_completed'
  | 'job_blocked'
  | 'job_failed'
  | 'task_step_failed'
  | 'file_changed'
  | 'diff_ready'
  | 'approval_required'
  | 'approval_resolved'
  | 'validation_started'
  | 'validation_completed'
  | 'validation_failed'
  | 'task_committed'
  | 'task_pushed'
  | 'packet_claimed'
  | 'packet_started'
  | 'packet_completed'
  | 'packet_failed'
  | 'packet_paused'
  | 'packet_resumed'
  | 'packet_cancelled'
  | 'packet_lease_renewed'

export type AgentEvent = {
  id: string
  jobId: string
  sourceId: string
  type: AgentEventType
  message: string
  createdAt: string
  commandKind?: string
  status?: string
  approvalOperation?: string
  approvalReason?: string
  taskId?: string
  packetId?: string
  validationJobId?: string
  requestId?: string
  activityKind?: WorkbenchActivityKind
  paths?: string[]
  evidenceRefs?: WorkbenchActivityEvidenceRef[]
  progress?: WorkbenchActivityProgress
  telemetry?: WorkbenchActivityTelemetry
}

type AgentEventStore = {
  version: 1
  updatedAt: string
  events: AgentEvent[]
}

export type AgentEventStoreOptions = {
  storePath?: string
  now?: () => Date
}

const DEFAULT_EVENT_STORE_PATH = path.join(getConfigDir(), 'agent-events.json')
const MAX_EVENTS_TOTAL = 500
const MAX_EVENTS_PER_JOB_RESPONSE = 25
const MAX_ACTIVITY_EVENTS = 100
const MAX_EVENT_MESSAGE_LENGTH = 220
const MAX_ACTIVITY_PATHS = 24
const MAX_ACTIVITY_EVIDENCE_REFS = 12

const ACTIVITY_KIND_BY_EVENT_TYPE: Record<AgentEventType, WorkbenchActivityKind> = {
  job_started: 'run_started',
  control_requested: 'control_requested',
  preflight_started: 'run_progress',
  command_started: 'executor_started',
  command_completed: 'executor_completed',
  command_failed: 'executor_failed',
  job_paused: 'run_progress',
  job_cancelled: 'run_cancelled',
  job_completed: 'run_completed',
  job_blocked: 'run_blocked',
  job_failed: 'run_failed',
  task_step_failed: 'task_failed',
  file_changed: 'file_changed',
  diff_ready: 'diff_ready',
  approval_required: 'approval_required',
  approval_resolved: 'approval_resolved',
  validation_started: 'validation_started',
  validation_completed: 'validation_completed',
  validation_failed: 'validation_failed',
  task_committed: 'commit_created',
  task_pushed: 'push_completed',
  packet_claimed: 'packet_status',
  packet_started: 'packet_status',
  packet_completed: 'packet_status',
  packet_failed: 'packet_status',
  packet_paused: 'packet_status',
  packet_resumed: 'packet_status',
  packet_cancelled: 'packet_status',
  packet_lease_renewed: 'packet_status'
}

function eventStorePath(options: AgentEventStoreOptions): string {
  return options.storePath || DEFAULT_EVENT_STORE_PATH
}

function nowIso(options: AgentEventStoreOptions): string {
  return (options.now?.() || new Date()).toISOString()
}

function compactMessage(value: string): string {
  const cleaned = redactSecrets(String(value || '')).replace(/\s+/g, ' ').trim()
  return cleaned.length > MAX_EVENT_MESSAGE_LENGTH ? `${cleaned.slice(0, MAX_EVENT_MESSAGE_LENGTH - 3)}...` : cleaned
}

function compactString(value: unknown, max = 160): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) return undefined
  return normalized.slice(0, max)
}

function compactPaths(paths: unknown): string[] | undefined {
  if (!Array.isArray(paths)) return undefined
  const normalized = Array.from(new Set(paths
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean)))
    .slice(0, MAX_ACTIVITY_PATHS)
    .map(item => item.slice(0, 512))
  return normalized.length > 0 ? normalized : undefined
}

function compactEvidenceRefs(refs: unknown): WorkbenchActivityEvidenceRef[] | undefined {
  if (!Array.isArray(refs)) return undefined
  const allowedKinds = new Set<WorkbenchActivityEvidenceRef['kind']>(['path', 'diff', 'validation', 'commit', 'packet', 'event', 'artifact', 'approval'])
  const normalized = refs.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const value = item as Partial<WorkbenchActivityEvidenceRef>
    const kind = value.kind
    const ref = compactString(value.ref, 512)
    return kind && allowedKinds.has(kind) && ref ? [{ kind, ref }] : []
  }).slice(0, MAX_ACTIVITY_EVIDENCE_REFS)
  return normalized.length > 0 ? normalized : undefined
}

function ensureEventStoreDir(options: AgentEventStoreOptions): void {
  fs.mkdirSync(path.dirname(eventStorePath(options)), { recursive: true })
}

function readStore(options: AgentEventStoreOptions = {}): AgentEventStore {
  try {
    const storePath = eventStorePath(options)
    if (!fs.existsSync(storePath)) return { version: 1, updatedAt: nowIso(options), events: [] }
    const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8')) as Partial<AgentEventStore>
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : nowIso(options),
      events: Array.isArray(parsed.events) ? parsed.events.filter(isAgentEvent) : []
    }
  } catch {
    return { version: 1, updatedAt: nowIso(options), events: [] }
  }
}

function writeStore(store: AgentEventStore, options: AgentEventStoreOptions = {}): void {
  ensureEventStoreDir(options)
  const events = store.events
    .sort(compareAgentEventsChronological)
    .slice(-MAX_EVENTS_TOTAL)
  const storePath = eventStorePath(options)
  const temporaryPath = `${storePath}.tmp`
  fs.writeFileSync(temporaryPath, JSON.stringify({ version: 1, updatedAt: nowIso(options), events }), 'utf8')
  fs.renameSync(temporaryPath, storePath)
}

function isAgentEvent(value: unknown): value is AgentEvent {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<AgentEvent>
  return typeof item.id === 'string'
    && typeof item.jobId === 'string'
    && typeof item.sourceId === 'string'
    && typeof item.type === 'string'
    && typeof item.message === 'string'
    && typeof item.createdAt === 'string'
}

function compareAgentEventsChronological(a: AgentEvent, b: AgentEvent): number {
  const byTime = a.createdAt.localeCompare(b.createdAt)
  return byTime !== 0 ? byTime : a.id.localeCompare(b.id)
}

function toActivityEntry(event: AgentEvent): WorkbenchActivityEntry {
  const entry: WorkbenchActivityEntry = {
    schemaVersion: WORKBENCH_ACTIVITY_LEDGER_SCHEMA_VERSION,
    id: event.id,
    sourceId: event.sourceId,
    runId: event.jobId,
    kind: event.activityKind || ACTIVITY_KIND_BY_EVENT_TYPE[event.type] || 'run_progress',
    summary: compactMessage(event.message) || event.type,
    occurredAt: event.createdAt,
    ...(compactString(event.taskId) ? { taskId: compactString(event.taskId) } : {}),
    ...(compactString(event.packetId) ? { packetId: compactString(event.packetId) } : {}),
    ...(compactString(event.validationJobId) ? { validationJobId: compactString(event.validationJobId) } : {}),
    ...(compactString(event.requestId) ? { requestId: compactString(event.requestId) } : {}),
    ...(compactString(event.status, 64) ? { status: compactString(event.status, 64) } : {}),
    ...(compactPaths(event.paths) ? { paths: compactPaths(event.paths) } : {}),
    ...(compactEvidenceRefs(event.evidenceRefs) ? { evidenceRefs: compactEvidenceRefs(event.evidenceRefs) } : {}),
    ...(event.progress ? { progress: event.progress } : {}),
    ...(event.telemetry ? { telemetry: event.telemetry } : {})
  }
  return entry
}

export function findOpenApprovalActivity(
  params: { jobId: string; sourceId: string; operation: string; paths: string[]; reason?: string },
  options: AgentEventStoreOptions = {}
): AgentEvent | undefined {
  const operation = compactString(params.operation, 96)
  const paths = compactPaths(params.paths) || []
  const reason = params.reason === undefined ? undefined : compactMessage(params.reason)
  if (!operation) return undefined
  const samePaths = (left?: string[]) => {
    const a = [...(left || [])].sort()
    const b = [...paths].sort()
    return a.length === b.length && a.every((value, index) => value === b[index])
  }
  const openByReason = new Map<string, AgentEvent>()
  for (const event of readStore(options).events.sort(compareAgentEventsChronological)) {
    if (event.jobId !== params.jobId || event.sourceId !== params.sourceId) continue
    if (event.approvalOperation !== operation || !samePaths(event.paths) || !event.approvalReason) continue
    if (reason !== undefined && event.approvalReason !== reason) continue
    const kind = event.activityKind || ACTIVITY_KIND_BY_EVENT_TYPE[event.type]
    if (kind === 'approval_required') openByReason.set(event.approvalReason, event)
    if (kind === 'approval_resolved') openByReason.delete(event.approvalReason)
  }
  if (reason !== undefined) return openByReason.get(reason)
  return openByReason.size === 1 ? [...openByReason.values()][0] : undefined
}

export function hasValidationActivityEvent(
  params: { jobId: string; sourceId: string; validationJobId: string; kind: 'validation_started' | 'validation_completed' | 'validation_failed' },
  options: AgentEventStoreOptions = {}
): boolean {
  return readStore(options).events.some(event =>
    event.jobId === params.jobId
    && event.sourceId === params.sourceId
    && event.validationJobId === params.validationJobId
    && (event.activityKind || ACTIVITY_KIND_BY_EVENT_TYPE[event.type]) === params.kind)
}

export function hasPacketValidationActivityEvent(
  params: { jobId: string; sourceId: string; packetId: string; evidenceRef: string; kind: 'validation_started' | 'validation_completed' | 'validation_failed' },
  options: AgentEventStoreOptions = {}
): boolean {
  return readStore(options).events.some(event =>
    event.jobId === params.jobId
    && event.sourceId === params.sourceId
    && event.packetId === params.packetId
    && event.evidenceRefs?.some(ref => ref.kind === 'validation' && ref.ref === params.evidenceRef)
    && (event.activityKind || ACTIVITY_KIND_BY_EVENT_TYPE[event.type]) === params.kind)
}

export function appendAgentEvent(
  input: Omit<AgentEvent, 'id' | 'createdAt' | 'message'> & { message: string; createdAt?: string },
  options: AgentEventStoreOptions = {}
): AgentEvent {
  const createdAt = typeof input.createdAt === 'string' && Number.isFinite(Date.parse(input.createdAt))
    ? new Date(input.createdAt).toISOString()
    : nowIso(options)
  const event: AgentEvent = {
    id: `evt-${crypto.randomUUID()}`,
    ...input,
    createdAt,
    message: compactMessage(input.message),
    approvalOperation: compactString(input.approvalOperation, 96),
    approvalReason: input.approvalReason === undefined ? undefined : compactMessage(input.approvalReason),
    paths: compactPaths(input.paths),
    evidenceRefs: compactEvidenceRefs(input.evidenceRefs)
  }
  const store = readStore(options)
  store.events.push(event)
  writeStore(store, options)
  return event
}

export function listAgentEvents(
  params: { jobId?: string; limit?: number } = {},
  options: AgentEventStoreOptions = {}
): { events: AgentEvent[]; returnedBytes: number; budgetBytes: number } {
  const maxEvents = Math.min(MAX_EVENTS_PER_JOB_RESPONSE, Math.max(1, Number(params.limit || 12)))
  const store = readStore(options)
  const scoped = params.jobId ? store.events.filter(event => event.jobId === params.jobId) : store.events
  const events = scoped
    .sort((a, b) => compareAgentEventsChronological(b, a))
    .slice(0, maxEvents)
    .map(event => ({ ...event, message: compactMessage(event.message) }))
  const payload = { events }
  return {
    events,
    returnedBytes: measureJsonPayload(payload),
    budgetBytes: GPT_ACTION_TARGET_BYTES
  }
}

export function listWorkbenchActivity(
  params: { runId?: string; sourceId?: string; limit?: number } = {},
  options: AgentEventStoreOptions = {}
): { projection: WorkbenchActivityProjection; returnedBytes: number; budgetBytes: number } {
  const maxEvents = Math.min(MAX_ACTIVITY_EVENTS, Math.max(1, Number(params.limit || 50)))
  const store = readStore(options)
  const scoped = store.events.filter(event =>
    (!params.runId || event.jobId === params.runId)
    && (!params.sourceId || event.sourceId === params.sourceId))
  const totalAvailable = scoped.length
  const sortedScoped = [...scoped].sort(compareAgentEventsChronological)
  const startedAt = sortedScoped[0]?.createdAt
  const selected = sortedScoped
    .slice(-maxEvents)
    .map(toActivityEntry)
  const projection: WorkbenchActivityProjection = {
    schemaVersion: WORKBENCH_ACTIVITY_LEDGER_SCHEMA_VERSION,
    generatedAt: nowIso(options),
    ...(startedAt ? { startedAt } : {}),
    ...(params.sourceId ? { sourceId: params.sourceId } : {}),
    ...(params.runId ? { runId: params.runId } : {}),
    events: selected,
    totalAvailable,
    truncated: totalAvailable > selected.length
  }
  return {
    projection,
    returnedBytes: measureJsonPayload(projection),
    budgetBytes: GPT_ACTION_TARGET_BYTES
  }
}
