import type { PromptPacketTransportContract } from './prompt-packet-compiler'
import type { PersistedDelegationOperation } from './external-delegation-store'
import { evaluateProviderAdmission, type ProviderAdmissionDecision } from './external-delegation-protocol'

export const PROVIDER_REGISTRY_SCHEMA_VERSION = 1 as const
export const RUNTIME_PROVENANCE_SCHEMA_VERSION = 1 as const
export const DELEGATION_PROTOCOL_VERSION = 1 as const

export type ProviderCapabilityRegistration = {
  schemaVersion: typeof PROVIDER_REGISTRY_SCHEMA_VERSION
  adapterId: string
  providerKind: string
  adapterVersion: string
  supportedExecutionProfiles: string[]
  supportedProtocolVersion: number
  capabilityFlags: string[]
  authorizationMode: 'none' | 'external' | 'delegated'
  confirmationRequired: boolean
  cancellationSupported: boolean
  statusReadbackSupported: boolean
  reconciliationSupported: boolean
  evidenceImportSupported: boolean
  networkRequired: boolean
  runtimeRequirement: 'local' | 'hosted' | 'either'
  provenanceRequired: boolean
  enabled: boolean
  disabledReasonCode?: string
}

export type ProviderRegistryResult =
  | { ok: true; registrations: ProviderCapabilityRegistration[] }
  | { ok: false; reasonCode: 'duplicate_adapter' | 'invalid_registration'; manualFallback: true }

export type RuntimeProvenance = {
  schemaVersion: typeof RUNTIME_PROVENANCE_SCHEMA_VERSION
  packageVersion: string
  gitCommit: string
  buildTimestamp: string
  buildIdentifier: string
  sourceIdentity: string
  runtimeMode: 'local' | 'hosted' | 'test'
  protocolVersion: number
  dirtyBuild: boolean
  confidence: 'verified' | 'partial' | 'unknown'
  reasonCode: string
}

export type RolloutInputs = {
  repositoryVersion: string
  repositoryCommit: string
  builtArtifactVersion: string
  liveRuntimeVersion: string
  liveGitCommit: string
  liveBuildTimestamp: string
  repositoryDiscoveryGeneration: string
  clientDiscoveryGeneration: string
  adapterProtocolVersion: number
  requiredProtocolVersion: number
  requiredSchemaVersion: number
  liveSchemaVersion: number
  deploymentRequired: boolean
}

export type RolloutReason =
  | 'repository_identity_unknown'
  | 'artifact_version_stale'
  | 'deployment_required'
  | 'restart_required'
  | 'protocol_or_schema_mismatch'
  | 'reconnect_required'
  | 'ready'

export type RolloutDecision = {
  action: 'none' | 'rebuild_required' | 'restart_required' | 'reconnect_required' | 'deployment_required' | 'blocked'
  rebuildRequired: boolean
  restartRequired: boolean
  reconnectRequired: boolean
  deploymentRequired: boolean
  blocked: boolean
  reasonCode: RolloutReason
  nextAction: string
  manualFallback: true
}

export type ProvenanceAdmissionReason =
  | 'provenance_verified'
  | 'provenance_unknown'
  | 'provenance_partial'
  | 'git_commit_unknown'
  | 'build_timestamp_unknown'
  | 'package_version_mismatch'
  | 'protocol_version_mismatch'
  | 'source_identity_mismatch'
  | 'dirty_build_blocked'
  | 'adapter_version_unsupported'
  | 'runtime_mode_unsupported'
  | 'restart_required'
  | 'deployment_required'
  | 'adapter_disabled'
  | 'adapter_unknown'
  | 'duplicate_adapter'

export type ProviderRegistryFailureReason = Extract<ProviderRegistryResult, { ok: false }>['reasonCode']

export type ComposedProviderAdmissionReason =
  | ProviderRegistryFailureReason
  | ProvenanceAdmissionReason
  | RolloutReason
  | ProviderAdmissionDecision['reasonCode']

export type ComposedProviderAdmission = {
  allowed: boolean
  reasonCode: ComposedProviderAdmissionReason
  nextAction: string
  manualFallback: true
}

const MAX_TEXT = 160

function bounded(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_TEXT) : ''
}

function isVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)
}

function isKnown(value: string): boolean {
  return Boolean(value && value !== 'unknown' && value !== 'missing')
}

export function validateProviderRegistry(registrations: ProviderCapabilityRegistration[]): ProviderRegistryResult {
  const seen = new Set<string>()
  const normalized: ProviderCapabilityRegistration[] = []
  for (const registration of registrations) {
    const adapterId = bounded(registration.adapterId)
    if (!adapterId || !bounded(registration.providerKind) || !isVersion(registration.adapterVersion)
      || registration.schemaVersion !== PROVIDER_REGISTRY_SCHEMA_VERSION
      || !Number.isInteger(registration.supportedProtocolVersion)
      || registration.supportedProtocolVersion < 1) {
      return { ok: false, reasonCode: 'invalid_registration', manualFallback: true }
    }
    if (seen.has(adapterId)) return { ok: false, reasonCode: 'duplicate_adapter', manualFallback: true }
    seen.add(adapterId)
    normalized.push({
      ...registration,
      adapterId,
      providerKind: bounded(registration.providerKind),
      adapterVersion: bounded(registration.adapterVersion),
      supportedExecutionProfiles: [...new Set(registration.supportedExecutionProfiles.map(bounded).filter(Boolean))].slice(0, 12),
      capabilityFlags: [...new Set(registration.capabilityFlags.map(bounded).filter(Boolean))].slice(0, 24),
      ...(registration.disabledReasonCode ? { disabledReasonCode: bounded(registration.disabledReasonCode) } : {})
    })
  }
  return { ok: true, registrations: normalized }
}

export function evaluateRuntimeProvenance(params: {
  provenance: RuntimeProvenance
  registration: ProviderCapabilityRegistration
  lockedSourceId: string
  requiredPackageVersion: string
  requiredAdapterVersion?: string
  allowDirtyPreviewOnly?: boolean
}): { allowed: boolean; previewOnly: boolean; reasonCode: ProvenanceAdmissionReason; nextAction: string; manualFallback: true } {
  const { provenance, registration } = params
  const fail = (reasonCode: ProvenanceAdmissionReason, nextAction: string, previewOnly = false) => ({ allowed: false, previewOnly, reasonCode, nextAction, manualFallback: true as const })
  if (!registration.enabled) return fail('adapter_disabled', 'Use manual fallback or enable the reviewed adapter registration.')
  if (params.requiredAdapterVersion && registration.adapterVersion !== params.requiredAdapterVersion) return fail('adapter_version_unsupported', 'Use the reviewed adapter version.')
  if (provenance.confidence === 'unknown') return fail('provenance_unknown', 'Rebuild and restart from a verifiable artifact.')
  if (provenance.confidence === 'partial') return fail('provenance_partial', 'Complete runtime provenance before live execution.')
  if (!isKnown(provenance.gitCommit)) return fail('git_commit_unknown', 'Rebuild with a known Git commit.')
  if (!isKnown(provenance.buildTimestamp)) return fail('build_timestamp_unknown', 'Rebuild with a known build timestamp.')
  if (provenance.packageVersion !== params.requiredPackageVersion) return fail('package_version_mismatch', 'Rebuild and restart the current repository version.')
  if (provenance.protocolVersion !== registration.supportedProtocolVersion) return fail('protocol_version_mismatch', 'Use a matching adapter protocol version.')
  if (provenance.sourceIdentity !== params.lockedSourceId) return fail('source_identity_mismatch', 'Use the runtime built for the locked Workbench source.')
  if (registration.runtimeRequirement !== 'either' && provenance.runtimeMode !== registration.runtimeRequirement) return fail('runtime_mode_unsupported', 'Use a supported runtime mode.')
  if (provenance.dirtyBuild) {
    return params.allowDirtyPreviewOnly
      ? fail('dirty_build_blocked', 'Preview only; produce a clean verified build for live execution.', true)
      : fail('dirty_build_blocked', 'Produce a clean verified build before live execution.')
  }
  return { allowed: true, previewOnly: false, reasonCode: 'provenance_verified', nextAction: 'Continue through guarded provider admission.', manualFallback: true }
}

export function evaluateRolloutAdmission(input: RolloutInputs): RolloutDecision {
  if (!isKnown(input.repositoryCommit) || !isVersion(input.repositoryVersion)) return { action: 'blocked', rebuildRequired: false, restartRequired: false, reconnectRequired: false, deploymentRequired: false, blocked: true, reasonCode: 'repository_identity_unknown', nextAction: 'Establish repository version and HEAD.', manualFallback: true }
  if (input.builtArtifactVersion !== input.repositoryVersion) return { action: 'rebuild_required', rebuildRequired: true, restartRequired: false, reconnectRequired: false, deploymentRequired: false, blocked: false, reasonCode: 'artifact_version_stale', nextAction: 'Build the current repository version.', manualFallback: true }
  if (input.deploymentRequired) return { action: 'deployment_required', rebuildRequired: false, restartRequired: false, reconnectRequired: false, deploymentRequired: true, blocked: false, reasonCode: 'deployment_required', nextAction: 'Deploy the reviewed artifact through the approved deployment path.', manualFallback: true }
  if (input.liveRuntimeVersion !== input.builtArtifactVersion || input.liveGitCommit !== input.repositoryCommit || !isKnown(input.liveBuildTimestamp)) return { action: 'restart_required', rebuildRequired: false, restartRequired: true, reconnectRequired: false, deploymentRequired: false, blocked: false, reasonCode: 'restart_required', nextAction: 'Restart the Workbench runtime from the current built artifact.', manualFallback: true }
  if (input.adapterProtocolVersion !== input.requiredProtocolVersion || input.liveSchemaVersion !== input.requiredSchemaVersion) return { action: 'blocked', rebuildRequired: false, restartRequired: false, reconnectRequired: false, deploymentRequired: false, blocked: true, reasonCode: 'protocol_or_schema_mismatch', nextAction: 'Use matching protocol and schema versions.', manualFallback: true }
  if (input.clientDiscoveryGeneration !== input.repositoryDiscoveryGeneration) return { action: 'reconnect_required', rebuildRequired: false, restartRequired: false, reconnectRequired: true, deploymentRequired: false, blocked: false, reasonCode: 'reconnect_required', nextAction: 'Reconnect the MCP/client discovery session.', manualFallback: true }
  return { action: 'none', rebuildRequired: false, restartRequired: false, reconnectRequired: false, deploymentRequired: false, blocked: false, reasonCode: 'ready', nextAction: 'Runtime provenance and rollout state are current.', manualFallback: true }
}

export function projectRuntimeReadiness(params: { provenance: RuntimeProvenance; rollout: RolloutDecision; repositoryVersion: string; repositoryCommit: string }) {
  const eligible = params.provenance.confidence === 'verified' && !params.provenance.dirtyBuild && params.rollout.action === 'none'
  return {
    repositoryVersion: bounded(params.repositoryVersion),
    repositoryCommit: bounded(params.repositoryCommit),
    liveVersion: bounded(params.provenance.packageVersion),
    liveCommit: bounded(params.provenance.gitCommit),
    buildTimestampState: isKnown(params.provenance.buildTimestamp) ? 'known' : 'unknown',
    provenanceConfidence: params.provenance.confidence,
    restartRequired: params.rollout.restartRequired,
    rebuildRequired: params.rollout.rebuildRequired,
    reconnectRequired: params.rollout.reconnectRequired,
    deploymentRequired: params.rollout.deploymentRequired,
    liveExecutionEligible: eligible,
    ...(eligible ? {} : { blocker: params.rollout.reasonCode === 'ready' ? params.provenance.reasonCode : params.rollout.reasonCode }),
    nextAction: eligible ? 'Continue through composed provider admission.' : params.rollout.nextAction
  }
}

export function evaluateComposedProviderAdmission(params: {
  registrations: ProviderCapabilityRegistration[]
  adapterId: string
  provenance: RuntimeProvenance
  rollout: RolloutDecision
  lockedSourceId: string
  requiredPackageVersion: string
  requiredAdapterVersion?: string
  operation: PersistedDelegationOperation
  contract: PromptPacketTransportContract
  expectedRevision: number
}): ComposedProviderAdmission {
  const registry = validateProviderRegistry(params.registrations)
  if (registry.ok === false) return { allowed: false, reasonCode: registry.reasonCode, nextAction: 'Fix the provider registry and use manual fallback.', manualFallback: true }
  const registration = registry.registrations.find(item => item.adapterId === params.adapterId)
  if (!registration) return { allowed: false, reasonCode: 'adapter_unknown', nextAction: 'Register a reviewed adapter or use manual fallback.', manualFallback: true }
  const provenance = evaluateRuntimeProvenance({
    provenance: params.provenance,
    registration,
    lockedSourceId: params.lockedSourceId,
    requiredPackageVersion: params.requiredPackageVersion,
    ...(params.requiredAdapterVersion ? { requiredAdapterVersion: params.requiredAdapterVersion } : {})
  })
  if (!provenance.allowed) return provenance
  if (params.rollout.action !== 'none') return { allowed: false, reasonCode: params.rollout.reasonCode, nextAction: params.rollout.nextAction, manualFallback: true }
  const base = evaluateProviderAdmission({ operation: params.operation, contract: params.contract, adapterIdentity: registration.adapterId, adapterSupported: true, expectedRevision: params.expectedRevision })
  return base
}
