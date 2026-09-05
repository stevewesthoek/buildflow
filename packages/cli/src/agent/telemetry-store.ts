import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { z } from 'zod'
import { getConfigDir } from '../utils/paths'

export const TELEMETRY_RECORD_SCHEMA_VERSION = 1 as const
export const TELEMETRY_STORE_VERSION = 1 as const

const SafeIdentifierSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/)
const SafeTagSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/)
const IsoDateSchema = z.string().refine(value => Number.isFinite(Date.parse(value)), 'Expected an ISO-compatible date')
const NonNegativeFiniteSchema = z.number().finite().nonnegative()
const NonNegativeIntegerSchema = z.number().int().nonnegative()

export const TelemetryScopeSchema = z.object({
  sourceId: SafeIdentifierSchema.optional(),
  runId: SafeIdentifierSchema.optional(),
  sessionId: SafeIdentifierSchema.optional(),
  requestId: SafeIdentifierSchema.optional(),
  actionId: SafeIdentifierSchema.optional(),
  packetId: SafeIdentifierSchema.optional(),
  taskId: SafeIdentifierSchema.optional()
}).strict()

export const TelemetryDimensionsSchema = z.object({
  component: z.enum(['action', 'server', 'command', 'validation', 'index', 'graphify', 'git', 'tunnel', 'conversation', 'executor']).optional(),
  operation: SafeTagSchema.optional(),
  outcome: z.enum(['success', 'failure', 'cancelled', 'timed_out', 'rejected', 'queued', 'degraded']).optional(),
  engine: z.enum(['direct', 'codex', 'future_adapter', 'human']).optional(),
  profile: z.enum(['economy', 'balanced', 'frontier']).optional(),
  health: z.enum(['healthy', 'degraded', 'overloaded', 'unknown']).optional(),
  commandKind: SafeTagSchema.optional(),
  validationKind: SafeTagSchema.optional(),
  reasonCode: SafeTagSchema.optional()
}).strict()

export const TelemetryMeasurementsSchema = z.object({
  durationMs: NonNegativeFiniteSchema.optional(),
  queueWaitMs: NonNegativeFiniteSchema.optional(),
  responseBytes: NonNegativeIntegerSchema.optional(),
  promptBytes: NonNegativeIntegerSchema.optional(),
  renderedBytes: NonNegativeIntegerSchema.optional(),
  heapBytes: NonNegativeIntegerSchema.optional(),
  rssBytes: NonNegativeIntegerSchema.optional(),
  cpuUserMicros: NonNegativeIntegerSchema.optional(),
  cpuSystemMicros: NonNegativeIntegerSchema.optional(),
  eventLoopDelayMs: NonNegativeFiniteSchema.optional(),
  count: NonNegativeIntegerSchema.optional(),
  entriesExamined: NonNegativeIntegerSchema.optional(),
  directoriesVisited: NonNegativeIntegerSchema.optional(),
  filesConsidered: NonNegativeIntegerSchema.optional(),
  bytesConsidered: NonNegativeIntegerSchema.optional(),
  maxDepth: NonNegativeIntegerSchema.optional(),
  resultsEmitted: NonNegativeIntegerSchema.optional(),
  toolCalls: NonNegativeIntegerSchema.optional(),
  actionRoundTrips: NonNegativeIntegerSchema.optional(),
  retries: NonNegativeIntegerSchema.optional(),
  interruptions: NonNegativeIntegerSchema.optional()
}).strict()

export const TELEMETRY_SAMPLE_NAMES = ['request_latency', 'queue_wait', 'response_size', 'event_loop_delay', 'runtime_resource', 'command_duration', 'validation_duration', 'index_duration', 'graphify_duration', 'git_lock_wait', 'tunnel_health', 'conversation_efficiency'] as const
export const TELEMETRY_EVENT_NAMES = ['request_completed', 'request_failed', 'request_rejected', 'command_completed', 'command_failed', 'validation_completed', 'validation_failed', 'index_completed', 'index_failed', 'graphify_completed', 'graphify_failed', 'git_lock_contended', 'tunnel_health_changed', 'telemetry_store_recovered'] as const

export const TelemetrySampleSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('sample'),
  id: SafeIdentifierSchema,
  name: z.enum(TELEMETRY_SAMPLE_NAMES),
  recordedAt: IsoDateSchema,
  scope: TelemetryScopeSchema,
  dimensions: TelemetryDimensionsSchema,
  measurements: TelemetryMeasurementsSchema
}).strict()

export const TelemetryEventSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('event'),
  id: SafeIdentifierSchema,
  name: z.enum(TELEMETRY_EVENT_NAMES),
  occurredAt: IsoDateSchema,
  scope: TelemetryScopeSchema,
  dimensions: TelemetryDimensionsSchema,
  measurements: TelemetryMeasurementsSchema
}).strict()

export type TelemetryScope = z.infer<typeof TelemetryScopeSchema>
export type TelemetryDimensions = z.infer<typeof TelemetryDimensionsSchema>
export type TelemetryMeasurements = z.infer<typeof TelemetryMeasurementsSchema>
export type TelemetrySample = z.infer<typeof TelemetrySampleSchema>
export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>

export type TelemetryRetentionPolicy = {
  maxAgeMs: number
  maxSamples: number
  maxEvents: number
  maxFileBytes: number
}

export type TelemetryStoreOptions = {
  storePath?: string
  now?: () => Date
  retention?: Partial<TelemetryRetentionPolicy>
}

export type TelemetryStore = {
  version: 1
  updatedAt: string
  samples: TelemetrySample[]
  events: TelemetryEvent[]
}

export const DEFAULT_TELEMETRY_RETENTION: Readonly<TelemetryRetentionPolicy> = Object.freeze({
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxSamples: 5_000,
  maxEvents: 2_000,
  maxFileBytes: 4 * 1024 * 1024
})

const StoreSchema = z.object({
  version: z.literal(1),
  updatedAt: IsoDateSchema,
  samples: z.array(TelemetrySampleSchema),
  events: z.array(TelemetryEventSchema)
}).strict()

function now(options: TelemetryStoreOptions): Date {
  return options.now ? options.now() : new Date()
}

function storePath(options: TelemetryStoreOptions): string {
  return options.storePath ? path.resolve(options.storePath) : path.join(getConfigDir(), 'telemetry.json')
}

function retention(options: TelemetryStoreOptions): TelemetryRetentionPolicy {
  return {
    maxAgeMs: Math.max(1, Math.floor(options.retention?.maxAgeMs ?? DEFAULT_TELEMETRY_RETENTION.maxAgeMs)),
    maxSamples: Math.max(1, Math.floor(options.retention?.maxSamples ?? DEFAULT_TELEMETRY_RETENTION.maxSamples)),
    maxEvents: Math.max(1, Math.floor(options.retention?.maxEvents ?? DEFAULT_TELEMETRY_RETENTION.maxEvents)),
    maxFileBytes: Math.max(512, Math.floor(options.retention?.maxFileBytes ?? DEFAULT_TELEMETRY_RETENTION.maxFileBytes))
  }
}

function emptyStore(options: TelemetryStoreOptions): TelemetryStore {
  return { version: 1, updatedAt: now(options).toISOString(), samples: [], events: [] }
}

function recordTime(record: TelemetrySample | TelemetryEvent): number {
  return Date.parse(record.kind === 'sample' ? record.recordedAt : record.occurredAt)
}

function prune(store: TelemetryStore, options: TelemetryStoreOptions): TelemetryStore {
  const limits = retention(options)
  const cutoff = now(options).getTime() - limits.maxAgeMs
  const result: TelemetryStore = {
    version: 1,
    updatedAt: now(options).toISOString(),
    samples: store.samples.filter(item => recordTime(item) >= cutoff).sort((a, b) => recordTime(a) - recordTime(b)).slice(-limits.maxSamples),
    events: store.events.filter(item => recordTime(item) >= cutoff).sort((a, b) => recordTime(a) - recordTime(b)).slice(-limits.maxEvents)
  }
  while (Buffer.byteLength(JSON.stringify(result), 'utf8') > limits.maxFileBytes && (result.samples.length || result.events.length)) {
    const sample = result.samples[0]
    const event = result.events[0]
    if (!event || (sample && recordTime(sample) <= recordTime(event))) result.samples.shift()
    else result.events.shift()
  }
  return result
}

function persist(store: TelemetryStore, options: TelemetryStoreOptions): TelemetryStore {
  const retained = prune(store, options)
  const target = storePath(options)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(retained), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  fs.renameSync(temporary, target)
  fs.chmodSync(target, 0o600)
  return retained
}

function quarantine(target: string, options: TelemetryStoreOptions): string | undefined {
  if (!fs.existsSync(target)) return undefined
  const destination = `${target}.corrupt-${now(options).getTime()}-${crypto.randomUUID().slice(0, 8)}`
  try {
    fs.renameSync(target, destination)
    fs.chmodSync(destination, 0o600)
    return destination
  } catch {
    return undefined
  }
}

function migrate(value: unknown, options: TelemetryStoreOptions): TelemetryStore {
  if (!value || typeof value !== 'object') throw new Error('Telemetry store must be an object')
  const raw = value as Record<string, unknown>
  if (raw.version === 1) return StoreSchema.parse(raw) as TelemetryStore
  if (raw.version !== 0 && raw.version !== undefined) throw new Error(`Unsupported telemetry store version: ${String(raw.version)}`)
  const normalizeSample = (item: unknown): TelemetrySample | undefined => {
    try {
      const candidate = item as Record<string, unknown>
      const { createdAt, ...rest } = candidate
      return TelemetrySampleSchema.parse({ ...rest, schemaVersion: 1, kind: 'sample', recordedAt: candidate.recordedAt ?? createdAt })
    } catch { return undefined }
  }
  const normalizeEvent = (item: unknown): TelemetryEvent | undefined => {
    try {
      const candidate = item as Record<string, unknown>
      const { createdAt, ...rest } = candidate
      return TelemetryEventSchema.parse({ ...rest, schemaVersion: 1, kind: 'event', occurredAt: candidate.occurredAt ?? createdAt })
    } catch { return undefined }
  }
  return {
    version: 1,
    updatedAt: now(options).toISOString(),
    samples: Array.isArray(raw.samples) ? raw.samples.map(normalizeSample).filter((item): item is TelemetrySample => Boolean(item)) : [],
    events: Array.isArray(raw.events) ? raw.events.map(normalizeEvent).filter((item): item is TelemetryEvent => Boolean(item)) : []
  }
}

export function redactTelemetryTag(value: string): string {
  const normalized = String(value || '').trim()
  if (/-----BEGIN [^-]+ PRIVATE KEY-----/i.test(normalized) || /\b(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)\b\s*[:=]/i.test(normalized) || /\bbearer\s+[A-Za-z0-9._~+/-]{8,}/i.test(normalized)) return 'redacted'
  const compact = normalized.replace(/\s+/g, '_').replace(/[^A-Za-z0-9._:/-]/g, '_').replace(/_+/g, '_').slice(0, 64)
  return SafeTagSchema.safeParse(compact).success ? compact : 'redacted'
}

function dimensions(value: Record<string, unknown> = {}): TelemetryDimensions {
  const normalized = { ...value }
  for (const key of ['operation', 'commandKind', 'validationKind', 'reasonCode']) {
    if (typeof normalized[key] === 'string') normalized[key] = redactTelemetryTag(normalized[key] as string)
  }
  return TelemetryDimensionsSchema.parse(normalized)
}

export function createTelemetrySample(input: Omit<TelemetrySample, 'schemaVersion' | 'kind' | 'id' | 'recordedAt' | 'scope' | 'dimensions' | 'measurements'> & { id?: string; recordedAt?: string; scope?: TelemetryScope; dimensions?: Record<string, unknown>; measurements?: TelemetryMeasurements }, options: TelemetryStoreOptions = {}): TelemetrySample {
  return TelemetrySampleSchema.parse({ schemaVersion: 1, kind: 'sample', id: input.id ?? `tel-${crypto.randomUUID()}`, name: input.name, recordedAt: input.recordedAt ?? now(options).toISOString(), scope: input.scope ?? {}, dimensions: dimensions(input.dimensions), measurements: input.measurements ?? {} })
}

export function createTelemetryEvent(input: Omit<TelemetryEvent, 'schemaVersion' | 'kind' | 'id' | 'occurredAt' | 'scope' | 'dimensions' | 'measurements'> & { id?: string; occurredAt?: string; scope?: TelemetryScope; dimensions?: Record<string, unknown>; measurements?: TelemetryMeasurements }, options: TelemetryStoreOptions = {}): TelemetryEvent {
  return TelemetryEventSchema.parse({ schemaVersion: 1, kind: 'event', id: input.id ?? `tel-${crypto.randomUUID()}`, name: input.name, occurredAt: input.occurredAt ?? now(options).toISOString(), scope: input.scope ?? {}, dimensions: dimensions(input.dimensions), measurements: input.measurements ?? {} })
}

export function loadTelemetryStore(options: TelemetryStoreOptions = {}): { store: TelemetryStore; quarantinedPath?: string } {
  const target = storePath(options)
  if (!fs.existsSync(target)) return { store: emptyStore(options) }
  try {
    const migrated = migrate(JSON.parse(fs.readFileSync(target, 'utf8')), options)
    const retained = prune(migrated, options)
    if (JSON.stringify(retained) !== JSON.stringify(migrated)) persist(retained, options)
    return { store: retained }
  } catch {
    return { store: emptyStore(options), quarantinedPath: quarantine(target, options) }
  }
}

export function appendTelemetrySample(input: Parameters<typeof createTelemetrySample>[0], options: TelemetryStoreOptions = {}): TelemetrySample {
  const sample = createTelemetrySample(input, options)
  const loaded = loadTelemetryStore(options).store
  loaded.samples.push(sample)
  persist(loaded, options)
  return sample
}

export function appendTelemetryEvent(input: Parameters<typeof createTelemetryEvent>[0], options: TelemetryStoreOptions = {}): TelemetryEvent {
  const event = createTelemetryEvent(input, options)
  const loaded = loadTelemetryStore(options).store
  loaded.events.push(event)
  persist(loaded, options)
  return event
}

export function deleteTelemetry(params: { all?: boolean; sourceId?: string; runId?: string; before?: string }, options: TelemetryStoreOptions = {}): { deletedSamples: number; deletedEvents: number } {
  if (!params.all && !params.sourceId && !params.runId && !params.before) throw new Error('Telemetry deletion requires all=true or a filter')
  const target = storePath(options)
  const loaded = loadTelemetryStore(options).store
  if (params.all) {
    fs.rmSync(target, { force: true })
    return { deletedSamples: loaded.samples.length, deletedEvents: loaded.events.length }
  }
  const before = params.before ? Date.parse(params.before) : undefined
  if (params.before && !Number.isFinite(before)) throw new Error('Telemetry deletion before must be an ISO-compatible date')
  const matches = (record: TelemetrySample | TelemetryEvent): boolean => {
    if (params.sourceId && record.scope.sourceId !== params.sourceId) return false
    if (params.runId && record.scope.runId !== params.runId) return false
    if (before !== undefined && recordTime(record) >= before) return false
    return true
  }
  const samples = loaded.samples.filter(item => !matches(item))
  const events = loaded.events.filter(item => !matches(item))
  persist({ ...loaded, samples, events }, options)
  return { deletedSamples: loaded.samples.length - samples.length, deletedEvents: loaded.events.length - events.length }
}
