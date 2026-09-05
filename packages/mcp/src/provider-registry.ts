import {
  WORKBENCH_PROVIDER_CONTRACT_VERSION,
  evaluateProviderAdmission,
  type WorkbenchProviderHealth,
  type WorkbenchProviderLifecycleContract,
  type WorkbenchProviderLifecycleStatus
} from './provider-lifecycle.js'

export type WorkbenchProviderCompactEntry = {
  providerId: string
  displayName: string
  contractVersion: string
  health: WorkbenchProviderHealth
  lifecycleStatus: WorkbenchProviderLifecycleStatus
  compatible: boolean
  freshnessTimestamp: string
}

export type WorkbenchProviderFailureMode =
  | 'unavailable'
  | 'stale_revision'
  | 'incompatible_contract'
  | 'expired_artifact'
  | 'duplicate_identity'
  | 'removed'
  | 'admission_rejected'

export type WorkbenchProviderFailure = {
  providerId: string
  mode: WorkbenchProviderFailureMode
  reason: string
  timestamp: string
}

export type WorkbenchRegistryMutation =
  | { type: 'admitted'; providerId: string }
  | { type: 'rejected'; providerId: string; reason: string }
  | { type: 'removed'; providerId: string; receipt: string }
  | { type: 'health_changed'; providerId: string; from: WorkbenchProviderHealth; to: WorkbenchProviderHealth }
  | { type: 'marked_stale'; providerId: string; lastFreshness: string }

export type WorkbenchProviderRegistryState = {
  providers: Map<string, WorkbenchProviderLifecycleContract>
  failures: WorkbenchProviderFailure[]
  supportedContractVersion: string
}

export function createRegistryState(
  supportedContractVersion: string = WORKBENCH_PROVIDER_CONTRACT_VERSION
): WorkbenchProviderRegistryState {
  return {
    providers: new Map(),
    failures: [],
    supportedContractVersion
  }
}

export function listProviders(state: WorkbenchProviderRegistryState): WorkbenchProviderCompactEntry[] {
  return Array.from(state.providers.values()).map(contract => ({
    providerId: contract.identity.providerId,
    displayName: contract.identity.displayName,
    contractVersion: contract.identity.contractVersion,
    health: contract.health,
    lifecycleStatus: contract.lifecycleStatus,
    compatible: contract.compatible,
    freshnessTimestamp: contract.freshnessTimestamp
  }))
}

export function inspectProvider(
  state: WorkbenchProviderRegistryState,
  providerId: string
): WorkbenchProviderLifecycleContract | undefined {
  return state.providers.get(providerId)
}

export function registerProvider(
  state: WorkbenchProviderRegistryState,
  contract: WorkbenchProviderLifecycleContract
): WorkbenchRegistryMutation {
  const admission = evaluateProviderAdmission(
    contract,
    new Set(state.providers.keys()),
    state.supportedContractVersion
  )

  if (admission.admitted) {
    state.providers.set(contract.identity.providerId, contract)
    return { type: 'admitted', providerId: contract.identity.providerId }
  }

  const failure: WorkbenchProviderFailure = {
    providerId: contract.identity.providerId,
    mode: classifyFailureMode(admission.reason),
    reason: admission.reason,
    timestamp: contract.freshnessTimestamp
  }
  state.failures.push(failure)
  return { type: 'rejected', providerId: contract.identity.providerId, reason: admission.reason }
}

export function removeProvider(
  state: WorkbenchProviderRegistryState,
  providerId: string,
  receipt: string
): WorkbenchRegistryMutation {
  state.providers.delete(providerId)
  state.failures.push({
    providerId,
    mode: 'removed',
    reason: 'explicit_removal',
    timestamp: receipt
  })
  return { type: 'removed', providerId, receipt }
}

export function refreshProviderHealth(
  state: WorkbenchProviderRegistryState,
  contract: WorkbenchProviderLifecycleContract
): WorkbenchRegistryMutation | null {
  const existing = state.providers.get(contract.identity.providerId)
  if (!existing) return null

  const oldHealth = existing.health
  state.providers.set(contract.identity.providerId, contract)

  if (contract.health !== oldHealth) {
    if (contract.health === 'stale' || contract.health === 'unreachable') {
      state.failures.push({
        providerId: contract.identity.providerId,
        mode: 'stale_revision',
        reason: `health_degraded_to_${contract.health}`,
        timestamp: contract.freshnessTimestamp
      })
    }
    return {
      type: 'health_changed',
      providerId: contract.identity.providerId,
      from: oldHealth,
      to: contract.health
    }
  }
  return null
}

export function markStaleProviders(
  state: WorkbenchProviderRegistryState,
  cutoffTimestamp: string
): WorkbenchRegistryMutation[] {
  const mutations: WorkbenchRegistryMutation[] = []

  for (const [id, contract] of state.providers) {
    if (contract.freshnessTimestamp < cutoffTimestamp && contract.health === 'healthy') {
      const updated: WorkbenchProviderLifecycleContract = {
        ...contract,
        health: 'stale'
      }
      state.providers.set(id, updated)
      state.failures.push({
        providerId: id,
        mode: 'stale_revision',
        reason: 'freshness_before_cutoff',
        timestamp: contract.freshnessTimestamp
      })
      mutations.push({ type: 'marked_stale', providerId: id, lastFreshness: contract.freshnessTimestamp })
    }
  }
  return mutations
}

export function recentFailures(
  state: WorkbenchProviderRegistryState,
  limit: number = 20
): WorkbenchProviderFailure[] {
  return state.failures.slice(-limit)
}

function classifyFailureMode(reason: string): WorkbenchProviderFailureMode {
  switch (reason) {
    case 'incompatible_contract_version': return 'incompatible_contract'
    case 'duplicate_provider_identity': return 'duplicate_identity'
    case 'provider_incompatible': return 'incompatible_contract'
    case 'provider_unhealthy': return 'unavailable'
    case 'provider_not_installed': return 'admission_rejected'
    default: return 'admission_rejected'
  }
}
