import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { getConfigDir } from '../utils/paths'
import { GPT_ACTION_TARGET_BYTES, measureJsonPayload } from './payload-budget'

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
}

type AgentEventStore = {
  version: 1
  updatedAt: string
  events: AgentEvent[]
}

const EVENT_STORE_PATH = path.join(getConfigDir(), 'agent-events.json')
const MAX_EVENTS_TOTAL = 500
const MAX_EVENTS_PER_JOB_RESPONSE = 25
const MAX_EVENT_MESSAGE_LENGTH = 220

function compactMessage(value: string): string {
  const cleaned = String(value || '').replace(/\s+/g, ' ').trim()
  return cleaned.length > MAX_EVENT_MESSAGE_LENGTH ? `${cleaned.slice(0, MAX_EVENT_MESSAGE_LENGTH - 3)}...` : cleaned
}

function ensureEventStoreDir(): void {
  fs.mkdirSync(path.dirname(EVENT_STORE_PATH), { recursive: true })
}

function readStore(): AgentEventStore {
  try {
    if (!fs.existsSync(EVENT_STORE_PATH)) return { version: 1, updatedAt: new Date().toISOString(), events: [] }
    const parsed = JSON.parse(fs.readFileSync(EVENT_STORE_PATH, 'utf8')) as Partial<AgentEventStore>
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      events: Array.isArray(parsed.events) ? parsed.events.filter(isAgentEvent) : []
    }
  } catch {
    return { version: 1, updatedAt: new Date().toISOString(), events: [] }
  }
}

function writeStore(store: AgentEventStore): void {
  ensureEventStoreDir()
  const events = store.events
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-MAX_EVENTS_TOTAL)
  fs.writeFileSync(EVENT_STORE_PATH, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), events }), 'utf8')
}

function isAgentEvent(value: unknown): value is AgentEvent {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<AgentEvent>
  return typeof item.id === 'string' && typeof item.jobId === 'string' && typeof item.sourceId === 'string' && typeof item.type === 'string' && typeof item.message === 'string' && typeof item.createdAt === 'string'
}

export function appendAgentEvent(input: Omit<AgentEvent, 'id' | 'createdAt' | 'message'> & { message: string }): AgentEvent {
  const event: AgentEvent = {
    id: `evt-${crypto.randomUUID()}`,
    createdAt: new Date().toISOString(),
    ...input,
    message: compactMessage(input.message)
  }
  const store = readStore()
  store.events.push(event)
  writeStore(store)
  return event
}

export function listAgentEvents(params: { jobId?: string; limit?: number } = {}): { events: AgentEvent[]; returnedBytes: number; budgetBytes: number } {
  const maxEvents = Math.min(MAX_EVENTS_PER_JOB_RESPONSE, Math.max(1, Number(params.limit || 12)))
  const store = readStore()
  const scoped = params.jobId ? store.events.filter(event => event.jobId === params.jobId) : store.events
  const events = scoped.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, maxEvents)
  const payload = { events }
  return {
    events,
    returnedBytes: measureJsonPayload(payload),
    budgetBytes: GPT_ACTION_TARGET_BYTES
  }
}
