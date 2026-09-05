import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export type KnowledgeRefreshOwnershipState = 'acquired' | 'renewed' | 'expired' | 'released' | 'recovered'
export type KnowledgeRefreshOwnershipEvent = { eventId: string; ownerId: string; state: KnowledgeRefreshOwnershipState; occurredAt: string; leaseExpiresAt?: string; reason?: string }
export type KnowledgeRefreshOwnershipRecord = { runtimeId: string; ownerId: string; state: KnowledgeRefreshOwnershipState; acquiredAt: string; updatedAt: string; leaseExpiresAt: string; events: KnowledgeRefreshOwnershipEvent[] }
export type KnowledgeRefreshOwnershipResult<T> = { ok: true; value: T } | { ok: false; reason: 'ownership_busy' | 'ownership_corrupt' | 'ownership_missing' | 'ownership_invalid'; message: string }
export type KnowledgeRefreshOwnershipOptions = { rootDir: string; maxEvents?: number }

const VERSION = 1 as const
const FILENAME = 'workbench-knowledge-refresh-ownership.json'
type State = { version: typeof VERSION; record?: KnowledgeRefreshOwnershipRecord }

function target(options: KnowledgeRefreshOwnershipOptions): string { return path.join(path.resolve(options.rootDir), FILENAME) }
function event(ownerId: string, state: KnowledgeRefreshOwnershipState, at: string, leaseExpiresAt?: string, reason?: string): KnowledgeRefreshOwnershipEvent { return { eventId: `knowledge-refresh-ownership-${crypto.randomUUID()}`, ownerId, state, occurredAt: at, ...(leaseExpiresAt ? { leaseExpiresAt } : {}), ...(reason ? { reason } : {}) } }

export class KnowledgeRefreshOwnershipStore {
  constructor(private readonly options: KnowledgeRefreshOwnershipOptions) {}
  private read(): KnowledgeRefreshOwnershipResult<State> {
    try {
      const file = target(this.options)
      if (!fs.existsSync(file)) return { ok: true, value: { version: VERSION } }
      const value = JSON.parse(fs.readFileSync(file, 'utf8')) as State
      if (value.version !== VERSION || (value.record !== undefined && (!value.record.runtimeId || !value.record.ownerId || !value.record.leaseExpiresAt || !Array.isArray(value.record.events)))) return { ok: false, reason: 'ownership_corrupt', message: 'Refresh ownership state is invalid.' }
      return { ok: true, value }
    } catch { return { ok: false, reason: 'ownership_corrupt', message: 'Refresh ownership state could not be read safely.' } }
  }
  private write(state: State): KnowledgeRefreshOwnershipResult<boolean> {
    const file = target(this.options); const lock = `${file}.lock`; let fd: number | undefined
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fd = fs.openSync(lock, 'wx', 0o600)
      const temp = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
      const record = state.record ? { ...state.record, events: state.record.events.slice(-(this.options.maxEvents ?? 100)) } : undefined
      fs.writeFileSync(temp, JSON.stringify({ version: VERSION, ...(record ? { record } : {}) }), { encoding: 'utf8', mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); fs.chmodSync(file, 0o600)
      return { ok: true, value: true }
    } catch (error) { return { ok: false, reason: error instanceof Error && error.message.includes('EEXIST') ? 'ownership_busy' : 'ownership_corrupt', message: 'Refresh ownership state could not be persisted safely.' } }
    finally { if (fd !== undefined) { try { fs.closeSync(fd) } catch {} ; try { fs.rmSync(lock, { force: true }) } catch {} } }
  }
  get(): KnowledgeRefreshOwnershipResult<KnowledgeRefreshOwnershipRecord | undefined> { const state = this.read(); return state.ok ? { ok: true, value: state.value.record ? { ...state.value.record, events: [...state.value.record.events] } : undefined } : state }
  acquire(runtimeId: string, ownerId: string, now: Date, leaseMs: number): KnowledgeRefreshOwnershipResult<KnowledgeRefreshOwnershipRecord> {
    const state = this.read(); if (!state.ok) return state; const current = state.value.record; const at = now.toISOString(); const expires = new Date(now.getTime() + Math.max(1_000, leaseMs)).toISOString()
    if (current && current.ownerId !== ownerId && Date.parse(current.leaseExpiresAt) > now.getTime()) return { ok: false, reason: 'ownership_busy', message: 'Refresh runtime is owned by another live supervisor.' }
    const recovered = current && current.ownerId !== ownerId && Date.parse(current.leaseExpiresAt) <= now.getTime()
    const priorEvents = recovered ? [...(current?.events ?? []), event(current!.ownerId, 'expired', at, current!.leaseExpiresAt, 'ownership_lease_expired')] : [...(current?.events ?? [])]
    const next: KnowledgeRefreshOwnershipRecord = { runtimeId, ownerId, state: recovered ? 'recovered' : 'acquired', acquiredAt: recovered ? current!.acquiredAt : at, updatedAt: at, leaseExpiresAt: expires, events: [...priorEvents, event(ownerId, recovered ? 'recovered' : 'acquired', at, expires, recovered ? 'abandoned_owner' : undefined)] }
    const saved = this.write({ version: VERSION, record: next }); return saved.ok ? { ok: true, value: next } : saved
  }
  renew(ownerId: string, now: Date, leaseMs: number): KnowledgeRefreshOwnershipResult<KnowledgeRefreshOwnershipRecord> { const state = this.read(); if (!state.ok) return state; const current = state.value.record; if (!current || current.ownerId !== ownerId) return { ok: false, reason: 'ownership_missing', message: 'Refresh supervisor does not own the runtime.' }; const at = now.toISOString(); const expires = new Date(now.getTime() + Math.max(1_000, leaseMs)).toISOString(); const next = { ...current, state: 'renewed' as const, updatedAt: at, leaseExpiresAt: expires, events: [...current.events, event(ownerId, 'renewed', at, expires)] }; const saved = this.write({ version: VERSION, record: next }); return saved.ok ? { ok: true, value: next } : saved }
  release(ownerId: string, now: Date, reason = 'shutdown'): KnowledgeRefreshOwnershipResult<KnowledgeRefreshOwnershipRecord> { const state = this.read(); if (!state.ok) return state; const current = state.value.record; if (!current || current.ownerId !== ownerId) return { ok: false, reason: 'ownership_missing', message: 'Refresh supervisor does not own the runtime.' }; const at = now.toISOString(); const next = { ...current, state: 'released' as const, updatedAt: at, leaseExpiresAt: at, events: [...current.events, event(ownerId, 'released', at, at, reason)] }; const saved = this.write({ version: VERSION, record: next }); return saved.ok ? { ok: true, value: next } : saved }
}
