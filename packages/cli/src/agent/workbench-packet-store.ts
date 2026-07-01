import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { getConfigDir } from '../utils/paths'
import type { WorkbenchPacket } from './workbench-packets'

export const WORKBENCH_PACKET_STORE_VERSION = 1 as const

export type WorkbenchPacketStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'

export type WorkbenchPacketRecord = {
  storeVersion: typeof WORKBENCH_PACKET_STORE_VERSION
  packet: WorkbenchPacket
  status: WorkbenchPacketStatus
  exactPaths: string[]
  reservedAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
  failedAt?: string
  cancelledAt?: string
  failureReason?: string
  commitHash?: string
  controlRequested?: 'pause' | 'cancel'
  controlReason?: string
  pausedAt?: string
  leaseOwner?: string
  leaseToken?: string
  leaseAcquiredAt?: string
  leaseExpiresAt?: string
  claimAttempt: number
}

type WorkbenchPacketStore = {
  version: typeof WORKBENCH_PACKET_STORE_VERSION
  updatedAt: string
  packets: WorkbenchPacketRecord[]
}

export type PacketReservationResult =
  | { ok: true; created: boolean; record: WorkbenchPacketRecord }
  | { ok: false; code: 'PACKET_STORE_BUSY' | 'PACKET_ID_CONFLICT' | 'IDEMPOTENCY_KEY_CONFLICT'; message: string }

const STORE_PATH = path.join(getConfigDir(), 'workbench-packets.json')
const LOCK_PATH = `${STORE_PATH}.lock`
const MAX_PACKET_RECORDS = 500

function emptyStore(): WorkbenchPacketStore {
  return { version: WORKBENCH_PACKET_STORE_VERSION, updatedAt: new Date().toISOString(), packets: [] }
}

function readStore(): WorkbenchPacketStore {
  try {
    if (!fs.existsSync(STORE_PATH)) return emptyStore()
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as Partial<WorkbenchPacketStore>
    return {
      version: WORKBENCH_PACKET_STORE_VERSION,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      packets: Array.isArray(parsed.packets)
        ? parsed.packets.filter(isPacketRecord).map(record => ({
            ...record,
            claimAttempt: Math.max(0, Number(record.claimAttempt || 0))
          }))
        : []
    }
  } catch {
    return emptyStore()
  }
}

function isPacketRecord(value: unknown): value is WorkbenchPacketRecord {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<WorkbenchPacketRecord>
  return item.storeVersion === WORKBENCH_PACKET_STORE_VERSION
    && typeof item.packet?.packetId === 'string'
    && typeof item.packet?.idempotencyKey === 'string'
    && typeof item.status === 'string'
    && Array.isArray(item.exactPaths)
    && typeof item.reservedAt === 'string'
    && typeof item.updatedAt === 'string'
}

function persistStore(store: WorkbenchPacketStore): void {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true })
  const payload: WorkbenchPacketStore = {
    version: WORKBENCH_PACKET_STORE_VERSION,
    updatedAt: new Date().toISOString(),
    packets: store.packets
      .sort((a, b) => a.reservedAt.localeCompare(b.reservedAt))
      .slice(-MAX_PACKET_RECORDS)
  }
  const temporaryPath = `${STORE_PATH}.tmp`
  fs.writeFileSync(temporaryPath, JSON.stringify(payload), 'utf8')
  fs.renameSync(temporaryPath, STORE_PATH)
}

function withExclusiveStoreLock<T>(callback: () => T): T | undefined {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true })
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(LOCK_PATH, 'wx')
    return callback()
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : ''
    if (code === 'EEXIST') return undefined
    throw error
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    try {
      if (descriptor !== undefined && fs.existsSync(LOCK_PATH)) fs.unlinkSync(LOCK_PATH)
    } catch {
      // A stale lock is safe to leave for operator recovery rather than deleting an unknown lock.
    }
  }
}

export function reserveWorkbenchPacket(params: {
  packet: WorkbenchPacket
  exactPaths: string[]
}): PacketReservationResult {
  const locked = withExclusiveStoreLock<PacketReservationResult>(() => {
    const store = readStore()
    const byId = store.packets.find(record => record.packet.packetId === params.packet.packetId)
    const byKey = store.packets.find(record => record.packet.idempotencyKey === params.packet.idempotencyKey)

    if (byId) {
      if (byId.packet.idempotencyKey === params.packet.idempotencyKey && byId.packet.runId === params.packet.runId) {
        return { ok: true, created: false, record: byId }
      }
      return { ok: false, code: 'PACKET_ID_CONFLICT', message: 'packetId is already reserved for a different packet' }
    }

    if (byKey) {
      return { ok: false, code: 'IDEMPOTENCY_KEY_CONFLICT', message: 'idempotencyKey is already reserved for a different packet' }
    }

    const now = new Date().toISOString()
    const record: WorkbenchPacketRecord = {
      storeVersion: WORKBENCH_PACKET_STORE_VERSION,
      packet: params.packet,
      status: 'queued',
      exactPaths: Array.from(new Set(params.exactPaths)),
      reservedAt: now,
      updatedAt: now,
      claimAttempt: 0
    }
    store.packets.push(record)
    persistStore(store)
    return { ok: true, created: true, record }
  })

  return locked || { ok: false, code: 'PACKET_STORE_BUSY', message: 'packet reservation store is busy; retry with the same idempotency key' }
}

export function getWorkbenchPacketRecord(packetId: string): WorkbenchPacketRecord | undefined {
  return readStore().packets.find(record => record.packet.packetId === packetId)
}

export function updateWorkbenchPacketStatus(params: {
  packetId: string
  status: WorkbenchPacketStatus
  failureReason?: string
}): WorkbenchPacketRecord | undefined {
  return withExclusiveStoreLock<WorkbenchPacketRecord | undefined>(() => {
    const store = readStore()
    const index = store.packets.findIndex(record => record.packet.packetId === params.packetId)
    if (index < 0) return undefined
    const now = new Date().toISOString()
    const current = store.packets[index]
    const updated: WorkbenchPacketRecord = {
      ...current,
      status: params.status,
      updatedAt: now,
      startedAt: params.status === 'running' ? current.startedAt || now : current.startedAt,
      completedAt: params.status === 'completed' ? now : current.completedAt,
      failedAt: params.status === 'failed' ? now : current.failedAt,
      cancelledAt: params.status === 'cancelled' ? now : current.cancelledAt,
      failureReason: params.status === 'failed' ? params.failureReason : current.failureReason
    }
    store.packets[index] = updated
    persistStore(store)
    return updated
  })
}




export function listWorkbenchPacketRecords(params: { runId?: string; sourceId?: string; limit?: number } = {}): WorkbenchPacketRecord[] {
  const limit = Math.max(1, Math.min(20, Number(params.limit || 10)))
  return readStore().packets
    .filter(record => !params.runId || record.packet.runId === params.runId)
    .filter(record => !params.sourceId || record.packet.sourceId === params.sourceId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit)
}




export type PacketClaimResult =
  | { ok: true; claimed: boolean; record: WorkbenchPacketRecord }
  | { ok: false; code: 'PACKET_STORE_BUSY' | 'PACKET_NOT_FOUND' | 'PACKET_NOT_QUEUED' | 'LEASE_OWNER_INVALID'; message: string }

export type PacketLeaseResult =
  | { ok: true; record: WorkbenchPacketRecord }
  | { ok: false; code: 'PACKET_STORE_BUSY' | 'PACKET_NOT_FOUND' | 'LEASE_INVALID' | 'PACKET_NOT_RUNNING'; message: string }

const DEFAULT_LEASE_MS = 60_000
const MIN_LEASE_MS = 5_000
const MAX_LEASE_MS = 5 * 60_000

function boundedLeaseMs(value?: number): number {
  const numeric = Number(value || DEFAULT_LEASE_MS)
  if (!Number.isFinite(numeric)) return DEFAULT_LEASE_MS
  return Math.max(MIN_LEASE_MS, Math.min(MAX_LEASE_MS, Math.floor(numeric)))
}

function clearLease(record: WorkbenchPacketRecord): WorkbenchPacketRecord {
  return {
    ...record,
    leaseOwner: undefined,
    leaseToken: undefined,
    leaseAcquiredAt: undefined,
    leaseExpiresAt: undefined
  }
}

export function claimNextWorkbenchPacket(params: {
  workerId: string
  packetId?: string
  sourceId?: string
  runId?: string
  leaseMs?: number
}): PacketClaimResult {
  const workerId = String(params.workerId || '').trim()
  if (!workerId || workerId.length > 160) {
    return { ok: false, code: 'LEASE_OWNER_INVALID', message: 'workerId is required and must be at most 160 characters' }
  }

  const locked = withExclusiveStoreLock<PacketClaimResult>(() => {
    const store = readStore()
    const index = store.packets.findIndex(record =>
      record.status === 'queued'
      && (!params.packetId || record.packet.packetId === params.packetId)
      && (!params.sourceId || record.packet.sourceId === params.sourceId)
      && (!params.runId || record.packet.runId === params.runId)
    )
    if (index < 0) return { ok: false, code: 'PACKET_NOT_FOUND', message: 'no queued packet matched this claim' }

    const now = new Date()
    const leaseMs = boundedLeaseMs(params.leaseMs)
    const current = store.packets[index]
    const record: WorkbenchPacketRecord = {
      ...current,
      status: 'running',
      startedAt: current.startedAt || now.toISOString(),
      updatedAt: now.toISOString(),
      leaseOwner: workerId,
      leaseToken: `lease-${crypto.randomUUID()}`,
      leaseAcquiredAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
      claimAttempt: current.claimAttempt + 1
    }
    store.packets[index] = record
    persistStore(store)
    return { ok: true, claimed: true, record }
  })

  return locked || { ok: false, code: 'PACKET_STORE_BUSY', message: 'packet store is busy; retry the claim' }
}

export function renewWorkbenchPacketLease(params: {
  packetId: string
  leaseToken: string
  leaseMs?: number
}): PacketLeaseResult {
  const locked = withExclusiveStoreLock<PacketLeaseResult>(() => {
    const store = readStore()
    const index = store.packets.findIndex(record => record.packet.packetId === params.packetId)
    if (index < 0) return { ok: false, code: 'PACKET_NOT_FOUND', message: 'packet not found' }
    const current = store.packets[index]
    if (current.status !== 'running') return { ok: false, code: 'PACKET_NOT_RUNNING', message: `packet is ${current.status}` }
    if (!params.leaseToken || current.leaseToken !== params.leaseToken) {
      return { ok: false, code: 'LEASE_INVALID', message: 'lease token does not match the running packet' }
    }

    const now = new Date()
    const record: WorkbenchPacketRecord = {
      ...current,
      updatedAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + boundedLeaseMs(params.leaseMs)).toISOString()
    }
    store.packets[index] = record
    persistStore(store)
    return { ok: true, record }
  })

  return locked || { ok: false, code: 'PACKET_STORE_BUSY', message: 'packet store is busy; retry lease renewal' }
}

export function releaseWorkbenchPacketLease(params: {
  packetId: string
  leaseToken: string
  requeue?: boolean
}): PacketLeaseResult {
  const locked = withExclusiveStoreLock<PacketLeaseResult>(() => {
    const store = readStore()
    const index = store.packets.findIndex(record => record.packet.packetId === params.packetId)
    if (index < 0) return { ok: false, code: 'PACKET_NOT_FOUND', message: 'packet not found' }
    const current = store.packets[index]
    if (current.status !== 'running') return { ok: false, code: 'PACKET_NOT_RUNNING', message: `packet is ${current.status}` }
    if (!params.leaseToken || current.leaseToken !== params.leaseToken) {
      return { ok: false, code: 'LEASE_INVALID', message: 'lease token does not match the running packet' }
    }

    const now = new Date().toISOString()
    const record: WorkbenchPacketRecord = clearLease({
      ...current,
      status: params.requeue === false ? 'cancelled' : 'queued',
      updatedAt: now,
      cancelledAt: params.requeue === false ? now : current.cancelledAt
    })
    store.packets[index] = record
    persistStore(store)
    return { ok: true, record }
  })

  return locked || { ok: false, code: 'PACKET_STORE_BUSY', message: 'packet store is busy; retry lease release' }
}

export function recoverStaleWorkbenchPacketLeases(nowMs = Date.now()): { recovered: number; packetIds: string[] } {
  const locked = withExclusiveStoreLock<{ recovered: number; packetIds: string[] }>(() => {
    const store = readStore()
    const packetIds: string[] = []
    const now = new Date(nowMs).toISOString()
    store.packets = store.packets.map(record => {
      const expiresAt = record.leaseExpiresAt ? Date.parse(record.leaseExpiresAt) : Number.NaN
      if (record.status !== 'running' || !Number.isFinite(expiresAt) || expiresAt > nowMs) return record
      packetIds.push(record.packet.packetId)
      return clearLease({
        ...record,
        status: 'queued',
        updatedAt: now,
        failureReason: 'Recovered stale execution lease after timeout or restart.'
      })
    })
    if (packetIds.length > 0) persistStore(store)
    return { recovered: packetIds.length, packetIds }
  })

  return locked || { recovered: 0, packetIds: [] }
}




export function finalizeWorkbenchPacketExecution(params: {
  packetId: string
  leaseToken: string
  status: 'completed' | 'failed' | 'paused' | 'cancelled'
  failureReason?: string
  commitHash?: string
}): PacketLeaseResult {
  const locked = withExclusiveStoreLock<PacketLeaseResult>(() => {
    const store = readStore()
    const index = store.packets.findIndex(record => record.packet.packetId === params.packetId)
    if (index < 0) return { ok: false, code: 'PACKET_NOT_FOUND', message: 'packet not found' }
    const current = store.packets[index]
    if (current.status !== 'running') return { ok: false, code: 'PACKET_NOT_RUNNING', message: `packet is ${current.status}` }
    if (!params.leaseToken || current.leaseToken !== params.leaseToken) {
      return { ok: false, code: 'LEASE_INVALID', message: 'lease token does not match the running packet' }
    }

    const now = new Date().toISOString()
    const updated = clearLease({
      ...current,
      status: params.status,
      updatedAt: now,
      completedAt: params.status === 'completed' ? now : current.completedAt,
      failedAt: params.status === 'failed' ? now : current.failedAt,
      pausedAt: params.status === 'paused' ? now : current.pausedAt,
      cancelledAt: params.status === 'cancelled' ? now : current.cancelledAt,
      failureReason: params.status === 'failed' ? params.failureReason || 'Packet execution failed.' : undefined,
      commitHash: params.status === 'completed' ? params.commitHash : current.commitHash,
      controlRequested: undefined,
      controlReason: undefined
    })
    store.packets[index] = updated
    persistStore(store)
    return { ok: true, record: updated }
  })

  return locked || { ok: false, code: 'PACKET_STORE_BUSY', message: 'packet store is busy; retry finalization' }
}




export function recoverInterruptedWorkbenchPacket(params: {
  packetId: string
  failureReason: string
}): WorkbenchPacketRecord | undefined {
  return withExclusiveStoreLock<WorkbenchPacketRecord | undefined>(() => {
    const store = readStore()
    const index = store.packets.findIndex(record => record.packet.packetId === params.packetId)
    if (index < 0) return undefined
    const current = store.packets[index]
    if (current.status !== 'running') return current
    const now = new Date().toISOString()
    const updated = clearLease({
      ...current,
      status: 'failed',
      updatedAt: now,
      failedAt: now,
      failureReason: params.failureReason
    })
    store.packets[index] = updated
    persistStore(store)
    return updated
  })
}




export function controlWorkbenchPacketsForRun(params: {
  runId: string
  action: 'pause' | 'resume' | 'cancel'
  reason?: string
}): { updated: number; packetIds: string[] } {
  const locked = withExclusiveStoreLock<{ updated: number; packetIds: string[] }>(() => {
    const store = readStore()
    const now = new Date().toISOString()
    const packetIds: string[] = []
    store.packets = store.packets.map(record => {
      if (record.packet.runId !== params.runId) return record
      if (params.action === 'pause') {
        if (record.status === 'queued') {
          packetIds.push(record.packet.packetId)
          return clearLease({
            ...record,
            status: 'paused',
            pausedAt: now,
            updatedAt: now,
            controlRequested: undefined,
            controlReason: params.reason
          })
        }
        if (record.status === 'running') {
          packetIds.push(record.packet.packetId)
          return { ...record, controlRequested: 'pause', controlReason: params.reason, updatedAt: now }
        }
      }
      if (params.action === 'cancel') {
        if (record.status === 'queued' || record.status === 'paused') {
          packetIds.push(record.packet.packetId)
          return clearLease({
            ...record,
            status: 'cancelled',
            cancelledAt: now,
            updatedAt: now,
            controlRequested: undefined,
            controlReason: params.reason
          })
        }
        if (record.status === 'running') {
          packetIds.push(record.packet.packetId)
          return { ...record, controlRequested: 'cancel', controlReason: params.reason, updatedAt: now }
        }
      }
      if (params.action === 'resume' && record.status === 'paused') {
        packetIds.push(record.packet.packetId)
        return clearLease({
          ...record,
          status: 'queued',
          updatedAt: now,
          controlRequested: undefined,
          controlReason: undefined
        })
      }
      return record
    })
    if (packetIds.length > 0) persistStore(store)
    return { updated: packetIds.length, packetIds }
  })
  return locked || { updated: 0, packetIds: [] }
}
