import crypto from 'node:crypto'
import { serializeCodexReviewOutputSchema } from './codex-review-transport'
import type { StrictSchema } from './codex-strict-schema'

export const WORKBENCH_CHANGE_PROPOSAL_SCHEMA_VERSION = 'r21.2.change-proposal.v1' as const
export const WORKBENCH_CHANGE_PROPOSAL_MAX_CHANGES = 1 as const
export const WORKBENCH_CHANGE_PROPOSAL_MAX_REPLACEMENT_BYTES = 8 * 1024
export const WORKBENCH_CHANGE_PROPOSAL_MAX_SUMMARY_BYTES = 512

export type WorkbenchChangeProposalChange = Readonly<{
  path: string
  operation: 'replace'
  originalDigest: string
  replacementText: string
}>

export type WorkbenchChangeProposal = Readonly<{
  schemaVersion: typeof WORKBENCH_CHANGE_PROPOSAL_SCHEMA_VERSION
  changes: readonly WorkbenchChangeProposalChange[]
  summary: string
}>

export type ParsedWorkbenchChangeProposal = Readonly<{
  proposal: WorkbenchChangeProposal
  replacementDigest?: string
  replacementBytes: number
  validation: 'PASS'
}>

export type ChangeProposalParseResult =
  | Readonly<{ ok: true; parsed: ParsedWorkbenchChangeProposal }>
  | Readonly<{ ok: false; code: 'PROPOSAL_INVALID' | 'PROPOSAL_UNSAFE'; message: string }>

type RecordValue = Record<string, unknown>

function isRecord(value: unknown): value is RecordValue {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

function exactString(value: string): StrictSchema {
  return { type: 'string', enum: [value] }
}

export function buildWorkbenchChangeProposalSchema(relativePath: string, originalDigest: string): StrictSchema {
  const change: StrictSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['path', 'operation', 'originalDigest', 'replacementText'],
    properties: {
      path: exactString(relativePath),
      operation: { type: 'string', enum: ['replace'] },
      originalDigest: exactString(originalDigest),
      replacementText: { type: 'string', maxLength: WORKBENCH_CHANGE_PROPOSAL_MAX_REPLACEMENT_BYTES }
    }
  }
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'changes', 'summary'],
    properties: {
      schemaVersion: exactString(WORKBENCH_CHANGE_PROPOSAL_SCHEMA_VERSION),
      changes: { type: 'array', minItems: 0, maxItems: WORKBENCH_CHANGE_PROPOSAL_MAX_CHANGES, items: change },
      summary: { type: 'string', minLength: 1, maxLength: WORKBENCH_CHANGE_PROPOSAL_MAX_SUMMARY_BYTES }
    }
  }
}

export function serializeWorkbenchChangeProposalSchema(schema: StrictSchema): string {
  return serializeCodexReviewOutputSchema(schema)
}

function unsafePath(value: string): boolean {
  const normalized = value.replace(/\\/g, '/')
  return normalized !== value || value.length === 0 || value.length > 500 || value.startsWith('/') || value.startsWith('~') || value.includes('\0') || value.split('/').some(part => part.length === 0 || part === '.' || part === '..')
}

export function parseWorkbenchChangeProposal(raw: string, expectedPath: string, expectedOriginalDigest: string): ChangeProposalParseResult {
  let value: unknown
  try { value = JSON.parse(raw) } catch { return { ok: false, code: 'PROPOSAL_INVALID', message: 'provider response is not valid JSON' } }
  if (!isRecord(value) || Object.keys(value).some(key => !['schemaVersion', 'changes', 'summary'].includes(key))) return { ok: false, code: 'PROPOSAL_INVALID', message: 'proposal root contains unsupported fields' }
  if (value.schemaVersion !== WORKBENCH_CHANGE_PROPOSAL_SCHEMA_VERSION) return { ok: false, code: 'PROPOSAL_INVALID', message: 'proposal schemaVersion is unsupported' }
  if (!Array.isArray(value.changes) || value.changes.length > WORKBENCH_CHANGE_PROPOSAL_MAX_CHANGES) return { ok: false, code: 'PROPOSAL_INVALID', message: 'proposal must contain zero or one change' }
  if (typeof value.summary !== 'string' || value.summary.trim().length === 0 || Buffer.byteLength(value.summary, 'utf8') > WORKBENCH_CHANGE_PROPOSAL_MAX_SUMMARY_BYTES || /\0/.test(value.summary)) return { ok: false, code: 'PROPOSAL_INVALID', message: 'proposal summary is invalid or exceeds its bound' }
  const changes: WorkbenchChangeProposalChange[] = []
  for (const item of value.changes) {
    if (!isRecord(item) || Object.keys(item).some(key => !['path', 'operation', 'originalDigest', 'replacementText'].includes(key))) return { ok: false, code: 'PROPOSAL_INVALID', message: 'proposal change contains unsupported fields' }
    if (typeof item.path !== 'string' || unsafePath(item.path) || item.path !== expectedPath) return { ok: false, code: 'PROPOSAL_UNSAFE', message: 'proposal path is not the exact admitted repository-relative path' }
    if (item.operation !== 'replace') return { ok: false, code: 'PROPOSAL_INVALID', message: 'proposal operation is unsupported' }
    if (item.originalDigest !== expectedOriginalDigest) return { ok: false, code: 'PROPOSAL_UNSAFE', message: 'proposal originalDigest does not match the Workbench source digest' }
    if (typeof item.replacementText !== 'string' || /\0/.test(item.replacementText)) return { ok: false, code: 'PROPOSAL_INVALID', message: 'proposal replacementText is not bounded text' }
    const replacementBytes = Buffer.byteLength(item.replacementText, 'utf8')
    if (replacementBytes > WORKBENCH_CHANGE_PROPOSAL_MAX_REPLACEMENT_BYTES) return { ok: false, code: 'PROPOSAL_INVALID', message: 'proposal replacementText exceeds its byte bound' }
    changes.push({ path: item.path, operation: 'replace', originalDigest: item.originalDigest, replacementText: item.replacementText })
  }
  const replacementText = changes[0]?.replacementText
  return {
    ok: true,
    parsed: {
      proposal: { schemaVersion: WORKBENCH_CHANGE_PROPOSAL_SCHEMA_VERSION, changes, summary: value.summary },
      ...(replacementText !== undefined ? { replacementDigest: sha256(replacementText) } : {}),
      replacementBytes: replacementText === undefined ? 0 : Buffer.byteLength(replacementText, 'utf8'),
      validation: 'PASS'
    }
  }
}
