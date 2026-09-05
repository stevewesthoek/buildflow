import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const WORKBENCH_MCP_PROVENANCE_FILENAME = 'workbench-mcp-execution-provenance.json' as const
export type ProvenanceLifecycle = 'requested' | 'admitted' | 'completed' | 'failed' | 'denied' | 'cancelled'
export type ProvenanceOutcome = 'completed' | 'failed' | 'denied' | 'cancelled'
export type McpExecutionProvenance = {
  provenanceId: string; sessionId: string; requestId: string; executionId: string; dispatchId: string
  capabilityId: string; authorizationGrantId: string; authorizationApprovedAt: string
  authorizationApprovedBy: string; authorizationValidAtExecution: boolean
  providerId: string; sourceIds: string[]; contextOrigin?: string; planId: string; validationId: string
  occurredAt: string; lifecycle: ProvenanceLifecycle; outcome?: ProvenanceOutcome; failureCode?: string
  evidence: Array<{ evidenceId: string; kind: string; reference: string; recordedAt: string }>
}
export type ProvenanceOptions = { rootDir?: string; now?: () => Date; maxRecords?: number }
export type ProvenanceDiagnostic = { complete: number; incomplete: number; invalid: number; orphaned: number; traceCoverage: number; missingEvidence: string[]; invalidLineage: string[] }
const MAX = 500
function file(options: ProvenanceOptions = {}) { return path.join(path.resolve(options.rootDir ?? path.join(process.cwd(), '.workbench-provider-state')), WORKBENCH_MCP_PROVENANCE_FILENAME) }
function read(options: ProvenanceOptions = {}): McpExecutionProvenance[] { try { const value = JSON.parse(fs.readFileSync(file(options), 'utf8')) as { records?: McpExecutionProvenance[] }; return Array.isArray(value.records) ? value.records : [] } catch { return [] } }
function write(records: McpExecutionProvenance[], options: ProvenanceOptions = {}) { const target = file(options); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); fs.writeFileSync(target, JSON.stringify({ version: 1, updatedAt: (options.now ?? (() => new Date()))().toISOString(), records: records.slice(-(options.maxRecords ?? MAX)) }), { mode: 0o600 }) }
export function listMcpExecutionProvenance(options: ProvenanceOptions = {}) { return read(options) }
export function recordMcpExecutionProvenance(input: Omit<McpExecutionProvenance, 'provenanceId' | 'evidence'> & { provenanceId?: string; evidence?: McpExecutionProvenance['evidence'] }, options: ProvenanceOptions = {}): McpExecutionProvenance {
  const records = read(options); const record: McpExecutionProvenance = { ...input, provenanceId: input.provenanceId ?? `mcp-provenance-${crypto.randomUUID()}`, sourceIds: [...new Set(input.sourceIds)].sort(), evidence: [...(input.evidence ?? [])].slice(0, 16) }; write([...records, record], options); return record
}
export function verifyMcpExecutionProvenance(options: ProvenanceOptions = {}): ProvenanceDiagnostic {
  const records = read(options); const latest = new Map<string, McpExecutionProvenance>(); for (const record of records) latest.set(record.executionId, record); const missingEvidence: string[] = []; const invalidLineage: string[] = []; let complete = 0; let invalid = 0
  for (const record of latest.values()) { const missing = ['sessionId','requestId','executionId','capabilityId','authorizationGrantId','providerId','planId','validationId'].filter(field => !String((record as any)[field] || '')); const badEvidence = !record.evidence.length || record.evidence.some(item => !item.kind || !item.reference); if (badEvidence) missingEvidence.push(record.executionId); const sessionMismatch = !!record.contextOrigin && record.contextOrigin !== record.sessionId; if (missing.length || !record.authorizationValidAtExecution || sessionMismatch || !['requested','admitted','completed','failed','denied','cancelled'].includes(record.lifecycle)) { invalid++; invalidLineage.push(record.executionId) } else complete++ }
  const ids = new Set(records.map(record => record.executionId)); const orphaned = records.filter(record => !ids.has(record.executionId)).length
  return { complete, incomplete: latest.size - complete, invalid, orphaned, traceCoverage: latest.size ? Math.round((complete / latest.size) * 100) : 100, missingEvidence: [...new Set(missingEvidence)].slice(0, 32), invalidLineage: [...new Set(invalidLineage)].slice(0, 32) }
}
