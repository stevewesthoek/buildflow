import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { listKnowledgeProviders } from './knowledge-provider.js'
import type { ProviderInventoryStoreOptions } from './provider-inventory.js'
import { inspectProviderInventory } from './provider-inventory.js'

export const PROVIDER_ACTIVATION_FILENAME = 'workbench-provider-activation.json' as const
export type ProviderActivationState = 'requested' | 'approved' | 'rejected' | 'deactivated'
export type ProviderActivationEventType = 'activation.requested' | 'activation.approved' | 'activation.rejected' | 'provider.selected' | 'provider.unavailable' | 'provider.deactivated'
export type ProviderActivationRecord = { activationId: string; providerId: string; state: ProviderActivationState; actorId: string; sessionId?: string; requestedAt: string; decidedAt?: string; reason?: string; manifestDigest?: string }
export type ProviderActivationEvent = { eventId: string; eventType: ProviderActivationEventType; providerId: string; actorId?: string; sessionId?: string; occurredAt: string; reason?: string; manifestDigest?: string }
export type ProviderActivationStore = { version: 1; updatedAt: string; activations: ProviderActivationRecord[]; events: ProviderActivationEvent[] }
export type ProviderActivationOptions = ProviderInventoryStoreOptions & { knowledgeRootDir?: string; now?: () => Date; recordSelection?: boolean }
export type ProviderActivationFailure = { ok: false; code: 'invalid_request' | 'activation_missing' | 'provider_missing' | 'provider_ineligible' | 'provider_unavailable' | 'invalid_transition' | 'store_unavailable'; message: string }
export type ProviderActivationResult<T> = { ok: true; value: T } | ProviderActivationFailure

const MAX = 500
function root(options: ProviderActivationOptions = {}): string { return path.resolve(options.rootDir ?? path.join(process.cwd(), '.workbench-provider-state')) }
function file(options?: ProviderActivationOptions): string { return path.join(root(options), PROVIDER_ACTIVATION_FILENAME) }
function now(options?: ProviderActivationOptions): string { return (options?.now ?? (() => new Date()))().toISOString() }
function fail(code: ProviderActivationFailure['code'], message: string): ProviderActivationFailure { return { ok: false, code, message } }
function empty(timestamp: string): ProviderActivationStore { return { version: 1, updatedAt: timestamp, activations: [], events: [] } }
function read(options?: ProviderActivationOptions): ProviderActivationStore | undefined { try { const value = JSON.parse(fs.readFileSync(file(options), 'utf8')) as ProviderActivationStore; return value.version === 1 && Array.isArray(value.activations) && Array.isArray(value.events) ? value : undefined } catch { return empty(now(options)) } }
function write(store: ProviderActivationStore, options?: ProviderActivationOptions): void { const target = file(options); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); store.activations = store.activations.slice(-MAX); store.events = store.events.slice(-MAX * 2); const temporary = `${target}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`; fs.writeFileSync(temporary, JSON.stringify(store), { encoding: 'utf8', mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, target); fs.chmodSync(target, 0o600) }
function event(store: ProviderActivationStore, eventType: ProviderActivationEventType, providerId: string, timestamp: string, data: Omit<ProviderActivationEvent, 'eventId' | 'eventType' | 'providerId' | 'occurredAt'> = {}): void { store.events.push({ eventId: `provider-event-${crypto.randomUUID()}`, eventType, providerId, occurredAt: timestamp, ...data }) }

function eligibility(providerId: string, options: ProviderActivationOptions): ProviderActivationResult<{ manifestDigest: string; providerType: string }> {
  const inventory = inspectProviderInventory(providerId, options)
  if (!inventory.ok) return fail('store_unavailable', inventory.message)
  if (!inventory.value) {
    const knowledge = listKnowledgeProviders({ rootDir: options.knowledgeRootDir ?? options.rootDir })
    if (!knowledge.ok) return fail('store_unavailable', knowledge.message)
    const provider = knowledge.value.find(item => item.providerId === providerId)
    if (!provider) return fail('provider_missing', `Provider ${providerId} is not registered.`)
    if (provider.lifecycle !== 'enabled') return fail('provider_ineligible', 'Knowledge provider is not enabled in the knowledge registry.')
    if (provider.health !== 'healthy' || !provider.freshness.observedAt) return fail('provider_unavailable', 'Knowledge provider health or freshness is unavailable.')
    return { ok: true, value: { manifestDigest: `knowledge:${providerId}:${provider.providerVersion}`, providerType: 'knowledge' } }
  }
  if (inventory.value.registrationState !== 'enabled') return fail('provider_ineligible', 'Provider must be enabled before activation.')
  if (inventory.value.health !== 'healthy') return fail(inventory.value.health === 'unreachable' ? 'provider_unavailable' : 'provider_ineligible', `Provider health is ${inventory.value.health}.`)
  if (inventory.value.location.kind === 'local-path') {
    try { if (!fs.statSync(inventory.value.location.value).isDirectory()) return fail('provider_unavailable', 'Provider location is not an available directory.') } catch { return fail('provider_unavailable', 'Provider location is unavailable.') }
  }
  if (inventory.value.providerType === 'knowledge') {
    const knowledge = listKnowledgeProviders({ rootDir: options.knowledgeRootDir ?? options.rootDir })
    if (!knowledge.ok) return fail('store_unavailable', knowledge.message)
    const provider = knowledge.value.find(item => item.providerId === providerId)
    if (!provider || provider.lifecycle !== 'enabled') return fail('provider_ineligible', 'Knowledge provider is not enabled in the knowledge registry.')
    if (provider.health !== 'healthy' || !provider.freshness.observedAt) return fail('provider_unavailable', 'Knowledge provider health or freshness is unavailable.')
  }
  return { ok: true, value: { manifestDigest: inventory.value.manifestIdentity.digest, providerType: inventory.value.providerType } }
}

export function requestProviderActivation(providerId: string, actorId: string, sessionId?: string, options?: ProviderActivationOptions): ProviderActivationResult<ProviderActivationRecord> {
  if (!providerId || !actorId || actorId.length > 160) return fail('invalid_request', 'Provider activation requires bounded provider and actor identities.')
  const timestamp = now(options); const store = read(options); if (!store) return fail('store_unavailable', 'Provider activation state is corrupt.')
  const candidate = eligibility(providerId, options ?? {})
  if (!candidate.ok) { event(store, 'activation.rejected', providerId, timestamp, { actorId, sessionId, reason: candidate.code }); store.updatedAt = timestamp; write(store, options); return candidate }
  const existing = [...store.activations].reverse().find(item => item.providerId === providerId && ['requested', 'approved'].includes(item.state))
  if (existing) return { ok: true, value: existing }
  const record: ProviderActivationRecord = { activationId: `provider-activation-${crypto.randomUUID()}`, providerId, state: 'requested', actorId, ...(sessionId ? { sessionId } : {}), requestedAt: timestamp, manifestDigest: candidate.value.manifestDigest }
  store.activations.push(record); event(store, 'activation.requested', providerId, timestamp, { actorId, sessionId, manifestDigest: record.manifestDigest }); store.updatedAt = timestamp; write(store, options); return { ok: true, value: record }
}

export function decideProviderActivation(activationId: string, approved: boolean, actorId: string, reason: string, options?: ProviderActivationOptions): ProviderActivationResult<ProviderActivationRecord> {
  if (!activationId || !actorId || !reason || reason.length > 240) return fail('invalid_request', 'Activation decisions require bounded actor and reason fields.')
  const timestamp = now(options); const store = read(options); if (!store) return fail('store_unavailable', 'Provider activation state is corrupt.')
  const record = store.activations.find(item => item.activationId === activationId)
  if (!record) return fail('activation_missing', 'Provider activation request was not found.')
  if (record.state !== 'requested') return fail('invalid_transition', 'Provider activation request is not pending.')
  if (approved) {
    const candidate = eligibility(record.providerId, options ?? {})
    if (!candidate.ok) { record.state = 'rejected'; record.decidedAt = timestamp; record.reason = candidate.code; event(store, 'activation.rejected', record.providerId, timestamp, { actorId, sessionId: record.sessionId, reason: candidate.code }); store.updatedAt = timestamp; write(store, options); return candidate }
    record.state = 'approved'; record.decidedAt = timestamp; record.reason = reason; record.manifestDigest = candidate.value.manifestDigest; event(store, 'activation.approved', record.providerId, timestamp, { actorId, sessionId: record.sessionId, reason, manifestDigest: record.manifestDigest })
  } else { record.state = 'rejected'; record.decidedAt = timestamp; record.reason = reason; event(store, 'activation.rejected', record.providerId, timestamp, { actorId, sessionId: record.sessionId, reason }) }
  store.updatedAt = timestamp; write(store, options); return { ok: true, value: record }
}

export function deactivateProvider(providerId: string, actorId: string, reason: string, options?: ProviderActivationOptions): ProviderActivationResult<boolean> {
  if (!providerId || !actorId || !reason || reason.length > 240) return fail('invalid_request', 'Provider deactivation requires bounded actor and reason fields.')
  const timestamp = now(options); const store = read(options); if (!store) return fail('store_unavailable', 'Provider activation state is corrupt.')
  const active = [...store.activations].reverse().find(item => item.providerId === providerId && item.state === 'approved')
  if (!active) return fail('activation_missing', 'Provider has no approved activation.')
  active.state = 'deactivated'; active.decidedAt = timestamp; active.reason = reason; event(store, 'provider.deactivated', providerId, timestamp, { actorId, sessionId: active.sessionId, reason }); store.updatedAt = timestamp; write(store, options); return { ok: true, value: true }
}

export function resolveActiveProviders(options?: ProviderActivationOptions): ProviderActivationResult<string[]> {
  const timestamp = now(options); const store = read(options); if (!store) return fail('store_unavailable', 'Provider activation state is corrupt.')
  const active = new Map<string, ProviderActivationRecord>()
  for (const record of store.activations) if (record.state === 'approved') active.set(record.providerId, record)
  const selected: string[] = []
  for (const [providerId, record] of active) {
    const candidate = eligibility(providerId, options ?? {})
    if (!candidate.ok) { if (options?.recordSelection !== false) event(store, candidate.code === 'provider_unavailable' ? 'provider.unavailable' : 'activation.rejected', providerId, timestamp, { actorId: record.actorId, sessionId: record.sessionId, reason: candidate.code }); continue }
    if (options?.recordSelection !== false) event(store, 'provider.selected', providerId, timestamp, { actorId: record.actorId, sessionId: record.sessionId, manifestDigest: candidate.value.manifestDigest }); selected.push(providerId)
  }
  if (options?.recordSelection !== false) { store.updatedAt = timestamp; write(store, options) }
  return { ok: true, value: selected.sort() }
}

export function getProviderActivationDiagnostics(options?: ProviderActivationOptions): { activations: ProviderActivationRecord[]; activeProviderIds: string[]; failedActivations: ProviderActivationRecord[]; blockedProviderIds: string[]; recentEvents: ProviderActivationEvent[] } {
  const store = read(options) ?? empty(now(options)); const active = resolveActiveProviders({ ...options, recordSelection: false }); const activeProviderIds = active.ok ? active.value : []; const latest = new Map<string, ProviderActivationRecord>(); for (const record of store.activations) latest.set(record.providerId, record)
  return { activations: store.activations.slice(-64), activeProviderIds, failedActivations: store.activations.filter(item => item.state === 'rejected').slice(-32), blockedProviderIds: [...latest.values()].filter(item => item.state === 'rejected').map(item => item.providerId).sort(), recentEvents: store.events.slice(-64) }
}
