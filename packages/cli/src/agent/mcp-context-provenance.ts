import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const WORKBENCH_MCP_CONTEXT_PROVENANCE_FILENAME = 'workbench-mcp-context-provenance.json' as const
export type McpContextProvenance = { provenanceId: string; sessionId: string; requestId: string; packageId?: string; sourceIds: string[]; providerIds: string[]; capabilityId: 'context.read'; authorizationGrantId: string; deliveredAt: string; evidence: Array<{ kind: string; reference: string }> }
export type McpContextProvenanceOptions = { rootDir?: string; maxRecords?: number }
function file(options: McpContextProvenanceOptions = {}) { return path.join(path.resolve(options.rootDir ?? process.env.WORKBENCH_PROVIDER_STATE_DIR ?? path.join(process.cwd(), '.workbench-provider-state')), WORKBENCH_MCP_CONTEXT_PROVENANCE_FILENAME) }
export function recordMcpContextProvenance(input: Omit<McpContextProvenance, 'provenanceId'>, options: McpContextProvenanceOptions = {}) { const target = file(options); let records: McpContextProvenance[] = []; try { records = JSON.parse(fs.readFileSync(target, 'utf8')).records || [] } catch {} const record = { ...input, provenanceId: `mcp-context-provenance-${crypto.randomUUID()}`, sourceIds: [...new Set(input.sourceIds)].sort(), providerIds: [...new Set(input.providerIds)].sort(), evidence: input.evidence.slice(0, 8) }; fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); fs.writeFileSync(target, JSON.stringify({ version: 1, records: [...records, record].slice(-(options.maxRecords ?? 500)) }), { mode: 0o600 }); return record }
