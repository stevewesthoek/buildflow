import type { ProviderInventoryRecord, ProviderInventoryStoreOptions } from './provider-inventory.js'
import { listProviderInventory } from './provider-inventory.js'

export const MCP_CAPABILITY_ADOPTION_VERSION = 1 as const
export type McpClientProfile = { clientId: string; supportsCapabilityDiscovery?: boolean; supportsContextWorkflow?: boolean; supportsApprovalMetadata?: boolean; requestedScope?: 'active-source' | 'explicit-source' | 'session-sources' }
export type McpClientCompatibility = { clientId: string; mode: 'full' | 'partial' | 'legacy'; supported: boolean; features: string[]; fallback: 'workflow' | 'metadata_only' | 'manual_approval'; reason?: 'missing_identity' | 'legacy_client' | 'partial_capability_support' | 'unsupported_scope' }
export type McpCapabilityDescription = { providerId: string; displayName: string; providerHealth: string; availability: 'available' | 'unavailable' | 'disabled'; capabilityId: string; description: string; operationId?: string; requiredPermission?: string; inputSchemaVersion?: string; approvalRequired: true; executionAvailable: boolean }
export type McpCapabilityAdoptionWorkflow = { version: typeof MCP_CAPABILITY_ADOPTION_VERSION; client: McpClientCompatibility; steps: Array<'request' | 'discover' | 'plan' | 'approve' | 'validate' | 'execute' | 'deliver'>; context: { requestable: boolean; defaultScope: 'active-source'; freshnessIncluded: boolean; provenanceIncluded: boolean }; capabilities: McpCapabilityDescription[] }
export type McpCapabilityAdoptionOptions = ProviderInventoryStoreOptions & { maxCapabilities?: number }

function compatibility(profile: McpClientProfile | undefined): McpClientCompatibility {
  if (!profile || typeof profile.clientId !== 'string' || profile.clientId.length === 0) return { clientId: '', mode: 'legacy', supported: false, features: [], fallback: 'manual_approval', reason: 'missing_identity' }
  if (profile.requestedScope && !['active-source', 'explicit-source', 'session-sources'].includes(profile.requestedScope)) return { clientId: profile.clientId.slice(0, 160), mode: 'legacy', supported: false, features: [], fallback: 'manual_approval', reason: 'unsupported_scope' }
  const discovery = profile.supportsCapabilityDiscovery === true; const context = profile.supportsContextWorkflow === true; const approval = profile.supportsApprovalMetadata === true
  if (discovery && context && approval) return { clientId: profile.clientId.slice(0, 160), mode: 'full', supported: true, features: ['capability-discovery', 'context-workflow', 'approval-metadata', 'freshness', 'provenance'], fallback: 'workflow' }
  if (discovery || context) return { clientId: profile.clientId.slice(0, 160), mode: 'partial', supported: true, features: [...(discovery ? ['capability-discovery'] : []), ...(context ? ['context-workflow'] : [])], fallback: 'metadata_only', reason: 'partial_capability_support' }
  return { clientId: profile.clientId.slice(0, 160), mode: 'legacy', supported: false, features: [], fallback: 'manual_approval', reason: 'legacy_client' }
}

export function listMcpCapabilityDescriptions(options: McpCapabilityAdoptionOptions = {}): McpCapabilityDescription[] {
  const inventory = listProviderInventory(options); if (!inventory.ok) return []
  const values: McpCapabilityDescription[] = []
  for (const provider of inventory.value.filter(item => item.providerType === 'capability').slice(0, 64)) {
    const availability = provider.registrationState === 'disabled' ? 'disabled' : provider.health === 'healthy' && provider.enabled ? 'available' : 'unavailable'
    const operations = provider.operationMetadata ?? []
    for (const capabilityId of provider.capabilities.slice(0, 128)) {
      const operation = operations.find(item => item.operationId === capabilityId) ?? operations[0]
      values.push({ providerId: provider.providerId, displayName: provider.displayName, providerHealth: provider.health, availability, capabilityId, description: operation?.description ?? `Approved operation for ${capabilityId}.`, ...(operation ? { operationId: operation.operationId, requiredPermission: operation.permission, inputSchemaVersion: operation.inputSchemaVersion } : {}), approvalRequired: true, executionAvailable: availability === 'available' })
    }
  }
  return values.sort((a, b) => a.providerId.localeCompare(b.providerId) || a.capabilityId.localeCompare(b.capabilityId)).slice(0, Math.min(options.maxCapabilities ?? 256, 256))
}

export function getMcpCapabilityAdoptionWorkflow(profile: McpClientProfile | undefined, options?: McpCapabilityAdoptionOptions): McpCapabilityAdoptionWorkflow {
  const client = compatibility(profile); const steps: McpCapabilityAdoptionWorkflow['steps'] = ['request', 'discover', 'plan', 'approve', 'validate', 'execute', 'deliver']
  return { version: MCP_CAPABILITY_ADOPTION_VERSION, client, steps, context: { requestable: client.supported, defaultScope: 'active-source', freshnessIncluded: client.supported, provenanceIncluded: client.supported }, capabilities: listMcpCapabilityDescriptions(options) }
}

export function getMcpCapabilityAdoptionDiagnostics(options?: McpCapabilityAdoptionOptions): { registeredProviders: string[]; availableCapabilities: string[]; unavailableProviders: string[]; workflowModes: { full: number; partial: number; legacy: number }; approvalRequired: true; executionReadiness: 'ready' | 'warning' | 'unavailable' } {
  const inventory = listProviderInventory(options); const providers = inventory.ok ? inventory.value.filter(item => item.providerType === 'capability') : []; const capabilities = listMcpCapabilityDescriptions(options); const available = capabilities.filter(item => item.availability === 'available'); return { registeredProviders: providers.map(item => item.providerId).sort().slice(0, 64), availableCapabilities: available.map(item => item.capabilityId).sort().slice(0, 256), unavailableProviders: providers.filter(item => item.health !== 'healthy' || item.registrationState === 'disabled').map(item => item.providerId).sort().slice(0, 64), workflowModes: { full: 0, partial: 0, legacy: 0 }, approvalRequired: true, executionReadiness: !inventory.ok ? 'unavailable' : available.length > 0 ? 'ready' : 'warning' }
}
