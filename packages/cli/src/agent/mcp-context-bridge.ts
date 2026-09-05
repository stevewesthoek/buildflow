import path from 'node:path'
import { authorizeActiveContext, type ContextBrokerOptions } from './context-broker'
import type { PreparedContext } from './prepare-task-context'
import { recordMcpContextConsumption, touchMcpContextSession, validateMcpContextSession } from './mcp-context-observability'
import { authorizeMcpCapability } from './mcp-session-capability-authorization'
import { recordMcpContextProvenance } from './mcp-context-provenance'

export type McpContextConsumption = {
  sessionId: string
  sourceIds: string[]
  repository: {
    freshnessState?: string
    indexedRevision?: string
    observedRevision?: string
    indexGeneration?: string
    warnings: string[]
  }
  knowledge: {
    available: boolean
    packageId?: string
    sourceIds: string[]
    files: number
    bytes: number
    queries: number
    warnings: string[]
    sources: Array<{ providerId: string; freshness: string; indexGeneration: number; freshnessState: string }>
    diagnostics?: { available: boolean; latencyMs: number; packageBytes: number; failures: number }
  }
}

export type McpContextConsumptionResult = { ok: true; context: McpContextConsumption } | {
  ok: false
  code: 'context_session_required' | 'context_session_not_confirmed' | 'source_not_active' | 'context_unavailable'
  message: string
}

export function consumePreparedMcpContext(
  prepared: PreparedContext,
  sessionId: string | undefined,
  options: ContextBrokerOptions = {},
  requestId?: string
): McpContextConsumptionResult {
  if (!sessionId) { recordMcpContextConsumption({ outcome: 'rejected', requestId, sourceIds: prepared.sourceIds, providerIds: prepared.knowledgeContext?.sources.map(item => item.providerId) || [], failureCode: 'context_session_required', freshnessWarnings: prepared.uncertainty.length, packageBytes: prepared.knowledgeContext?.bytes || 0, retrievalLatencyMs: prepared.knowledgeContext?.diagnostics.latencyMs || 0, preparationLatencyMs: prepared.timings.totalMs }, options.mcpObservability); return { ok: false, code: 'context_session_required', message: 'MCP context consumption requires a Context Intelligence session.' } }
  const lifecycle = validateMcpContextSession(sessionId, { contextStore: options.storeOptions, observability: options.mcpObservability, ownerId: options.ownerId })
  if ('message' in lifecycle) { const code = lifecycle.code === 'session_missing' || lifecycle.code === 'session_unavailable' ? 'context_session_required' : lifecycle.code === 'session_unconfirmed' ? 'context_session_not_confirmed' : 'context_unavailable'; recordMcpContextConsumption({ outcome: 'rejected', requestId, sessionId, sourceIds: prepared.sourceIds, providerIds: prepared.knowledgeContext?.sources.map(item => item.providerId) || [], failureCode: lifecycle.code, freshnessWarnings: prepared.uncertainty.length, packageBytes: prepared.knowledgeContext?.bytes || 0, retrievalLatencyMs: prepared.knowledgeContext?.diagnostics.latencyMs || 0, preparationLatencyMs: prepared.timings.totalMs }, options.mcpObservability); return { ok: false, code, message: lifecycle.message } }
  const capability = authorizeMcpCapability(sessionId, 'context.read', { ...options.mcpCapabilityAuthorization, contextStore: options.storeOptions })
  if ('code' in capability) { recordMcpContextConsumption({ outcome: 'rejected', requestId, sessionId, sourceIds: prepared.sourceIds, providerIds: prepared.knowledgeContext?.sources.map(item => item.providerId) || [], failureCode: capability.code, freshnessWarnings: prepared.uncertainty.length, packageBytes: prepared.knowledgeContext?.bytes || 0, retrievalLatencyMs: prepared.knowledgeContext?.diagnostics.latencyMs || 0, preparationLatencyMs: prepared.timings.totalMs }, options.mcpObservability); return { ok: false, code: 'context_unavailable', message: `Capability authorization denied: ${capability.code}.` } }
  const repositorySourceIds = prepared.contextMetadata?.selectedSource ? [prepared.contextMetadata.selectedSource] : prepared.sourceIds
  for (const sourceId of repositorySourceIds) {
    const authorization = authorizeActiveContext(sessionId, sourceId, options)
    if ('message' in authorization) { const code = authorization.code === 'session_unavailable' ? 'context_session_required' : authorization.message.includes('confirmed') ? 'context_session_not_confirmed' : 'source_not_active'; recordMcpContextConsumption({ outcome: 'rejected', requestId, sessionId, sourceIds: prepared.sourceIds, providerIds: prepared.knowledgeContext?.sources.map(item => item.providerId) || [], failureCode: code, freshnessWarnings: prepared.uncertainty.length, packageBytes: prepared.knowledgeContext?.bytes || 0, retrievalLatencyMs: prepared.knowledgeContext?.diagnostics.latencyMs || 0, preparationLatencyMs: prepared.timings.totalMs }, options.mcpObservability); return { ok: false, code, message: authorization.message } }
  }
  const repository = prepared.contextMetadata
  const knowledge = prepared.knowledgeContext
  recordMcpContextConsumption({ outcome: knowledge?.warnings.length || repository?.warnings.length ? 'degraded' : 'success', requestId, sessionId, sourceIds: prepared.sourceIds, providerIds: knowledge?.sources.map(item => item.providerId) || [], packageId: knowledge?.packageId, freshnessWarnings: (knowledge?.warnings.length || 0) + (repository?.warnings.length || 0), packageBytes: knowledge?.bytes || 0, retrievalLatencyMs: knowledge?.diagnostics.latencyMs || 0, preparationLatencyMs: prepared.timings.totalMs }, options.mcpObservability)
  recordMcpContextProvenance({ sessionId, requestId: requestId || 'context-request', ...(knowledge?.packageId ? { packageId: knowledge.packageId } : {}), sourceIds: prepared.sourceIds, providerIds: knowledge?.sources.map(item => item.providerId) || [], capabilityId: 'context.read', authorizationGrantId: capability.grant.grantId, deliveredAt: new Date().toISOString(), evidence: [{ kind: 'context-package', reference: knowledge?.packageId || 'repository-context' }] }, { rootDir: options.mcpCapabilityAuthorization?.storePath ? path.dirname(options.mcpCapabilityAuthorization.storePath) : undefined })
  touchMcpContextSession(sessionId, prepared.sourceIds, knowledge?.sources.map(item => item.providerId) || [], true, options.mcpObservability)
  return {
    ok: true,
    context: {
      sessionId,
      sourceIds: [...prepared.sourceIds].sort(),
      repository: {
        freshnessState: repository?.freshnessState,
        indexedRevision: repository?.indexedRevision,
        observedRevision: repository?.observedRevision,
        indexGeneration: repository?.indexGeneration,
        warnings: [...(repository?.warnings || [])].slice(0, 16)
      },
      knowledge: {
        available: Boolean(knowledge),
        ...(knowledge?.packageId ? { packageId: knowledge.packageId } : {}),
        sourceIds: [...(knowledge?.sourceIds || [])].sort(),
        files: knowledge?.files || 0,
        bytes: knowledge?.bytes || 0,
        queries: knowledge?.queries || 0,
        warnings: [...(knowledge?.warnings || [])].slice(0, 16),
        sources: [...(knowledge?.sources || [])].slice(0, 64),
        ...(knowledge?.diagnostics ? { diagnostics: knowledge.diagnostics } : {})
      }
    }
  }
}
