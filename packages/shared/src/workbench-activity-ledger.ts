import { z } from 'zod'

export const WORKBENCH_ACTIVITY_LEDGER_SCHEMA_VERSION = 1 as const

export const WORKBENCH_ACTIVITY_KINDS = [
  'run_started',
  'run_progress',
  'run_blocked',
  'run_completed',
  'run_failed',
  'run_cancelled',
  'control_requested',
  'task_started',
  'task_progress',
  'task_completed',
  'task_failed',
  'packet_status',
  'file_read',
  'file_changed',
  'diff_ready',
  'validation_started',
  'validation_completed',
  'validation_failed',
  'approval_required',
  'approval_resolved',
  'executor_started',
  'executor_completed',
  'executor_failed',
  'resource_sample',
  'commit_created',
  'push_completed'
] as const

export type WorkbenchActivityKind = typeof WORKBENCH_ACTIVITY_KINDS[number]

const ActivityIdSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/)
const ActivitySummarySchema = z.string().min(1).max(220)
const ActivityStatusSchema = z.string().min(1).max(64)
const ActivityPathSchema = z.string().min(1).max(512)
const ActivityRefSchema = z.string().min(1).max(512)
const IsoDateSchema = z.string().refine(value => Number.isFinite(Date.parse(value)), 'Expected an ISO-compatible date')
const NonNegativeIntegerSchema = z.number().int().nonnegative()
const NonNegativeFiniteSchema = z.number().finite().nonnegative()

export const WorkbenchActivityEvidenceRefSchema = z.object({
  kind: z.enum(['path', 'diff', 'validation', 'commit', 'packet', 'event', 'artifact', 'approval']),
  ref: ActivityRefSchema
}).strict()

export const WorkbenchActivityProgressSchema = z.object({
  completed: NonNegativeIntegerSchema,
  total: NonNegativeIntegerSchema,
  percent: z.number().finite().min(0).max(100),
  confidence: z.enum(['exact', 'heuristic'])
}).strict()

export const WorkbenchActivityTelemetrySchema = z.object({
  adapter: z.string().min(1).max(64).optional(),
  model: z.string().min(1).max(128).optional(),
  reasoningLevel: z.string().min(1).max(64).optional(),
  inputTokens: NonNegativeIntegerSchema.optional(),
  outputTokens: NonNegativeIntegerSchema.optional(),
  costMicros: NonNegativeIntegerSchema.optional(),
  durationMs: NonNegativeFiniteSchema.optional(),
  rssBytes: NonNegativeIntegerSchema.optional()
}).strict()

export const WorkbenchActivityEntrySchema = z.object({
  schemaVersion: z.literal(WORKBENCH_ACTIVITY_LEDGER_SCHEMA_VERSION),
  id: ActivityIdSchema,
  sourceId: ActivityIdSchema,
  runId: ActivityIdSchema,
  kind: z.enum(WORKBENCH_ACTIVITY_KINDS),
  summary: ActivitySummarySchema,
  occurredAt: IsoDateSchema,
  taskId: ActivityIdSchema.optional(),
  packetId: ActivityIdSchema.optional(),
  validationJobId: ActivityIdSchema.optional(),
  requestId: ActivityIdSchema.optional(),
  status: ActivityStatusSchema.optional(),
  paths: z.array(ActivityPathSchema).max(24).optional(),
  evidenceRefs: z.array(WorkbenchActivityEvidenceRefSchema).max(12).optional(),
  progress: WorkbenchActivityProgressSchema.optional(),
  telemetry: WorkbenchActivityTelemetrySchema.optional()
}).strict()

export const WorkbenchActivityProjectionSchema = z.object({
  schemaVersion: z.literal(WORKBENCH_ACTIVITY_LEDGER_SCHEMA_VERSION),
  generatedAt: IsoDateSchema,
  startedAt: IsoDateSchema.optional(),
  sourceId: ActivityIdSchema.optional(),
  runId: ActivityIdSchema.optional(),
  events: z.array(WorkbenchActivityEntrySchema).max(100),
  totalAvailable: NonNegativeIntegerSchema,
  truncated: z.boolean()
}).strict()

export type WorkbenchActivityEvidenceRef = z.infer<typeof WorkbenchActivityEvidenceRefSchema>
export type WorkbenchActivityProgress = z.infer<typeof WorkbenchActivityProgressSchema>
export type WorkbenchActivityTelemetry = z.infer<typeof WorkbenchActivityTelemetrySchema>
export type WorkbenchActivityEntry = z.infer<typeof WorkbenchActivityEntrySchema>
export type WorkbenchActivityProjection = z.infer<typeof WorkbenchActivityProjectionSchema>
