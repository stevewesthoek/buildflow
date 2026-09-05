import { formatMcpContextWorkflowResponse, negotiateMcpContextClient, recordMcpContextWorkflowResult, type McpContextClientCapabilities } from './mcp-context-workflow'
import type { PreparedContext } from './prepare-task-context'

export type McpWorkflowProfile = { name: 'full' | 'partial' | 'legacy' | 'unknown'; capabilities?: McpContextClientCapabilities }
export const MCP_WORKFLOW_PROFILES: readonly McpWorkflowProfile[] = [
  { name: 'full', capabilities: { clientId: 'soak-full', contextWorkflow: true, features: ['freshness', 'warnings'], requestedScope: 'active-source' } },
  { name: 'partial', capabilities: { clientId: 'soak-partial', contextWorkflow: false, features: ['warnings'] } },
  { name: 'legacy' },
  { name: 'unknown', capabilities: { clientId: '', contextWorkflow: true } }
]
export type McpWorkflowSoakResult = { profile: McpWorkflowProfile['name']; negotiated: boolean; delivered: boolean; failures: string[]; requests: number; averageLatencyMs: number; maximumPackageBytes: number }

export function runMcpWorkflowSoak(input: { context: PreparedContext; sessionId: string; profiles?: readonly McpWorkflowProfile[]; repetitions?: number; concurrent?: number }): McpWorkflowSoakResult[] {
  const repetitions = Math.max(1, Math.min(input.repetitions || 3, 32)); const concurrent = Math.max(1, Math.min(input.concurrent || 2, 8)); const profiles = input.profiles || MCP_WORKFLOW_PROFILES
  return profiles.map(profile => { const failures: string[] = []; let negotiated = 0; let delivered = 0; let bytes = 0; const started = Date.now(); for (let index = 0; index < repetitions * concurrent; index++) { const result = negotiateMcpContextClient(profile.capabilities); if (!result.supported) { failures.push(result.reason || 'unsupported_client'); recordMcpContextWorkflowResult({ clientId: result.clientId, ok: false, latencyMs: 0, failureCode: result.reason || 'unsupported_client' }); continue }; negotiated += 1; const response = formatMcpContextWorkflowResponse(input.context, input.sessionId); if (!response.ok) { failures.push('code' in response ? response.code : 'context_rejected'); continue }; delivered += 1; bytes = Math.max(bytes, response.metadata.bytes); recordMcpContextWorkflowResult({ clientId: result.clientId, ok: true, latencyMs: 0, packageBytes: response.metadata.bytes }) } return { profile: profile.name, negotiated: negotiated > 0, delivered: delivered > 0, failures: [...new Set(failures)], requests: repetitions * concurrent, averageLatencyMs: Math.round((Date.now() - started) / (repetitions * concurrent)), maximumPackageBytes: bytes } })
}
