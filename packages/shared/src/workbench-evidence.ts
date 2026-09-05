import { z } from 'zod'

export const WORKBENCH_EVIDENCE_SCHEMA_VERSION = 1 as const

export const WORKBENCH_EVIDENCE_KINDS = [
  'raw_log',
  'diff',
  'validation_result',
  'capability_result'
] as const

export const WORKBENCH_EVIDENCE_RETENTION_CLASSES = [
  'active_run',
  'standard',
  'diagnostic',
  'ephemeral'
] as const

export const WORKBENCH_EVIDENCE_REDACTION_STATES = [
  'redacted',
  'not_required'
] as const

export const WORKBENCH_EVIDENCE_CONTENT_ENCODING = 'utf8' as const
export const WORKBENCH_EVIDENCE_MAX_CONTENT_BYTES = 256 * 1024
export const WORKBENCH_EVIDENCE_MAX_RECORDS = 500
export const WORKBENCH_EVIDENCE_MAX_STORE_BYTES = 8 * 1024 * 1024
export const WORKBENCH_EVIDENCE_PAGE_DEFAULT_BYTES = 4_000
export const WORKBENCH_EVIDENCE_PAGE_MAX_BYTES = 4_000

// One local retention authority. active_run is protected while its durable
// Workbench run is active, then follows the bounded terminal grace period.
export const WORKBENCH_EVIDENCE_RETENTION_POLICY_MS = {
  active_run: 24 * 60 * 60_000,
  standard: 24 * 60 * 60_000,
  diagnostic: 7 * 24 * 60 * 60_000,
  ephemeral: 60 * 60_000
} as const

export const workbenchEvidenceIdSchema = z.string()
  .min(5)
  .max(164)
  .regex(/^evd-[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/)
  .refine(value => !value.includes('..') && !value.includes('/') && !value.includes('\\'), 'Evidence IDs must be opaque and path-safe')

const OwnerIdSchema = z.string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/)

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const IsoDateSchema = z.string().refine(value => Number.isFinite(Date.parse(value)), 'Expected an ISO-compatible date')

export const WorkbenchEvidenceOwnerSchema = z.object({
  sourceId: OwnerIdSchema,
  sessionId: OwnerIdSchema.optional(),
  runId: OwnerIdSchema.optional(),
  taskId: OwnerIdSchema.optional(),
  packetId: OwnerIdSchema.optional(),
  requestId: OwnerIdSchema.optional(),
  operationId: OwnerIdSchema.optional(),
  providerId: OwnerIdSchema.optional()
}).strict()

export const WorkbenchEvidenceReadOwnerSchema = WorkbenchEvidenceOwnerSchema
  .omit({ sourceId: true })
  .partial()
  .strict()

export const WorkbenchEvidenceMetadataSchema = z.object({
  schemaVersion: z.literal(WORKBENCH_EVIDENCE_SCHEMA_VERSION),
  evidenceId: workbenchEvidenceIdSchema,
  kind: z.enum(WORKBENCH_EVIDENCE_KINDS),
  owner: WorkbenchEvidenceOwnerSchema,
  contentEncoding: z.literal(WORKBENCH_EVIDENCE_CONTENT_ENCODING),
  byteLength: z.number().int().nonnegative().max(WORKBENCH_EVIDENCE_MAX_CONTENT_BYTES),
  sha256: Sha256Schema,
  integritySha256: Sha256Schema,
  retentionClass: z.enum(WORKBENCH_EVIDENCE_RETENTION_CLASSES),
  redactionState: z.enum(WORKBENCH_EVIDENCE_REDACTION_STATES),
  createdAt: IsoDateSchema
}).strict()

export const WorkbenchEvidenceRecordSchema = WorkbenchEvidenceMetadataSchema.extend({
  content: z.string().max(WORKBENCH_EVIDENCE_MAX_CONTENT_BYTES)
}).strict()

export type WorkbenchEvidenceKind = typeof WORKBENCH_EVIDENCE_KINDS[number]
export type WorkbenchEvidenceRetentionClass = typeof WORKBENCH_EVIDENCE_RETENTION_CLASSES[number]
export type WorkbenchEvidenceRedactionState = typeof WORKBENCH_EVIDENCE_REDACTION_STATES[number]
export type WorkbenchEvidenceOwner = z.infer<typeof WorkbenchEvidenceOwnerSchema>
export type WorkbenchEvidenceReadOwner = z.infer<typeof WorkbenchEvidenceReadOwnerSchema>
export type WorkbenchEvidenceMetadata = z.infer<typeof WorkbenchEvidenceMetadataSchema>
export type WorkbenchEvidenceRecord = z.infer<typeof WorkbenchEvidenceRecordSchema>
