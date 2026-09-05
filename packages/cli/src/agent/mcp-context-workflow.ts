import type { PreparedContext } from './prepare-task-context'

export const MCP_CONTEXT_WORKFLOW_VERSION = 1 as const
export type McpContextClientCapabilities = { clientId: string; contextWorkflow?: boolean; features?: string[]; requestedScope?: 'active-source' | 'explicit-source' | 'session-sources' }
export type McpContextWorkflowNegotiation = { supported: boolean; version: typeof MCP_CONTEXT_WORKFLOW_VERSION; clientId: string; features: string[]; requestedScope: McpContextClientCapabilities['requestedScope']; reason?: 'missing_client_identity' | 'unsupported_context_workflow' | 'unsupported_scope' | 'malformed_capabilities' }
export type McpContextWorkflowResponse = { ok: true; metadata: { workflowVersion: 1; sessionId: string; sourceIds: string[]; packageId?: string; diagnosticsRef: string; provenanceRef: string; freshnessStates: string[]; warnings: string[]; files: number; bytes: number; queries: number }; context: PreparedContext } | { ok: false; code: 'unsupported_client' | 'session_required' | 'context_rejected'; message: string }

export type McpContextWorkflowDiagnostics = { negotiations: number; supportedNegotiations: number; failedNegotiations: number; unsupportedClients: number; unsupportedFeatures: number; requests: number; successfulDeliveries: number; rejectedRequests: number; averageLatencyMs: number; packageBytes: number; recentFailures: Array<{ code: string; clientId?: string }> }
const MAX_DIAGNOSTICS = 128
const workflowDiagnostics: McpContextWorkflowDiagnostics = { negotiations: 0, supportedNegotiations: 0, failedNegotiations: 0, unsupportedClients: 0, unsupportedFeatures: 0, requests: 0, successfulDeliveries: 0, rejectedRequests: 0, averageLatencyMs: 0, packageBytes: 0, recentFailures: [] }

export function negotiateMcpContextClient(capabilities: McpContextClientCapabilities | undefined): McpContextWorkflowNegotiation {
  workflowDiagnostics.negotiations += 1
  if (!capabilities || typeof capabilities !== 'object' || !capabilities.clientId || typeof capabilities.clientId !== 'string') { workflowDiagnostics.failedNegotiations += 1; workflowDiagnostics.unsupportedClients += 1; return { supported: false, version: MCP_CONTEXT_WORKFLOW_VERSION, clientId: '', features: [], requestedScope: undefined, reason: 'malformed_capabilities' } }
  const features = [...new Set((capabilities.features || []).filter(item => typeof item === 'string').slice(0, 16))].sort()
  const clientId = capabilities.clientId.slice(0, 160)
  if (capabilities.requestedScope && !['active-source', 'explicit-source', 'session-sources'].includes(capabilities.requestedScope)) { workflowDiagnostics.failedNegotiations += 1; workflowDiagnostics.unsupportedFeatures += 1; return { supported: false, version: MCP_CONTEXT_WORKFLOW_VERSION, clientId, features, requestedScope: undefined, reason: 'unsupported_scope' } }
  if (capabilities.contextWorkflow !== true) { workflowDiagnostics.failedNegotiations += 1; workflowDiagnostics.unsupportedClients += 1; return { supported: false, version: MCP_CONTEXT_WORKFLOW_VERSION, clientId, features, requestedScope: capabilities.requestedScope, reason: 'unsupported_context_workflow' } }
  workflowDiagnostics.supportedNegotiations += 1; return { supported: true, version: MCP_CONTEXT_WORKFLOW_VERSION, clientId, features, requestedScope: capabilities.requestedScope || 'active-source' }
}

export function recordMcpContextWorkflowResult(input: { clientId?: string; ok: boolean; latencyMs: number; packageBytes?: number; failureCode?: string }): void { workflowDiagnostics.requests += 1; if (input.ok) workflowDiagnostics.successfulDeliveries += 1; else { workflowDiagnostics.rejectedRequests += 1; if (input.failureCode) workflowDiagnostics.recentFailures = [...workflowDiagnostics.recentFailures, { code: input.failureCode, ...(input.clientId ? { clientId: input.clientId } : {}) }].slice(-MAX_DIAGNOSTICS) }; workflowDiagnostics.packageBytes += Math.max(0, Math.min(10_000_000, input.packageBytes || 0)); const completed = workflowDiagnostics.successfulDeliveries + workflowDiagnostics.rejectedRequests; workflowDiagnostics.averageLatencyMs = completed ? Math.round((workflowDiagnostics.averageLatencyMs * (completed - 1) + Math.max(0, input.latencyMs)) / completed) : 0 }
export function getMcpContextWorkflowDiagnostics(): McpContextWorkflowDiagnostics { return { ...workflowDiagnostics, recentFailures: workflowDiagnostics.recentFailures.slice(-MAX_DIAGNOSTICS) } }

export function formatMcpContextWorkflowResponse(context: PreparedContext, sessionId: string): McpContextWorkflowResponse {
  const knowledge = context.knowledgeContext
  const packageBytes = knowledge?.bytes || Buffer.byteLength(JSON.stringify(context), 'utf8')
  return { ok: true, metadata: { workflowVersion: MCP_CONTEXT_WORKFLOW_VERSION, sessionId, sourceIds: [...context.sourceIds].sort(), ...(knowledge?.packageId ? { packageId: knowledge.packageId } : {}), diagnosticsRef: `mcp-context-workflow:${sessionId}`, provenanceRef: `mcp-context-provenance:${knowledge?.packageId || sessionId}`, freshnessStates: [...new Set([...(context.contextMetadata?.freshnessState ? [context.contextMetadata.freshnessState] : []), ...(knowledge?.sources || []).map(item => item.freshnessState)])].sort(), warnings: [...(context.uncertainty || []), ...(context.contextMetadata?.warnings || []), ...(knowledge?.warnings || [])].slice(0, 32), files: knowledge?.files || (context.candidates || []).length, bytes: Math.min(packageBytes, 64 * 1024), queries: knowledge?.queries || 1 }, context }
}
