import { decideProviderActivation, requestProviderActivation, type ProviderActivationRecord, type ProviderActivationOptions } from './provider-activation.js'
import { discoverCapabilityProviders, registerCapabilityProvider, transitionCapabilityProvider, type CapabilityDiscoveryCandidate, type CapabilityProviderManifest } from './capability-provider.js'
import type { ProviderInventoryRecord, ProviderInventoryStoreOptions } from './provider-inventory.js'

export type McpCapabilityProviderOptions = ProviderInventoryStoreOptions & { activation?: ProviderActivationOptions; registeredBy: string; approvedBy: string; sessionId?: string; now?: () => Date }
export type McpCapabilityProviderConnection = { candidate: CapabilityDiscoveryCandidate; provider: ProviderInventoryRecord; activation: ProviderActivationRecord }
export type McpCapabilityProviderResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string }

function failure(code: string, message: string): McpCapabilityProviderResult<never> { return { ok: false, code, message } }

export async function connectMcpCapabilityProvider(manifest: CapabilityProviderManifest, options: McpCapabilityProviderOptions): Promise<McpCapabilityProviderResult<McpCapabilityProviderConnection>> {
  const discovered = discoverCapabilityProviders([{ source: 'mcp', manifest }], options.now?.())
  if (discovered.failures.length > 0 || !discovered.candidates[0]) return failure('discovery_failed', discovered.failures[0]?.message ?? 'Capability manifest could not be discovered.')
  const candidate = discovered.candidates[0]
  const registered = registerCapabilityProvider(candidate, options)
  if (!registered.ok) return registered
  for (const state of ['reviewed', 'registered', 'enabled'] as const) { const transitioned = transitionCapabilityProvider(manifest.providerId, state, options); if (!transitioned.ok) return transitioned }
  const activationOptions = options.activation ?? { rootDir: options.rootDir, now: options.now }
  const requested = requestProviderActivation(manifest.providerId, options.registeredBy, options.sessionId, activationOptions)
  if (!requested.ok) return requested
  const approved = decideProviderActivation(requested.value.activationId, true, options.approvedBy, 'approved for bounded MCP capability use', activationOptions)
  if (!approved.ok) return approved
  return { ok: true, value: { candidate, provider: registered.value, activation: approved.value } }
}
