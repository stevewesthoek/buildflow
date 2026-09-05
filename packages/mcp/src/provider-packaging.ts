import { WORKBENCH_PROVIDER_CONTRACT_VERSION } from './provider-lifecycle.js'

export type WorkbenchProviderManifest = {
  providerId: string
  displayName: string
  version: string
  contractVersion: string
  sourceRevision: string
  capabilities: string[]
  transportType: string
  configurationSchema?: string
}

export type WorkbenchProviderPackageAction = 'install' | 'remove' | 'upgrade' | 'health_check'

export type WorkbenchProviderPackageReceipt = {
  providerId: string
  action: WorkbenchProviderPackageAction
  previousVersion: string | null
  newVersion: string | null
  timestamp: string
  success: boolean
  failureReason?: string
}

export type WorkbenchPolicyBoundary =
  | 'source_lock'
  | 'grant_required'
  | 'confirmation_required'
  | 'command_allowlist'
  | 'mcp_allowlist'
  | 'validation_required'
  | 'git_discipline'
  | 'network_policy'
  | 'evidence_redaction'

export type WorkbenchPolicyViolation = {
  boundary: WorkbenchPolicyBoundary
  providerId: string
  description: string
}

export type WorkbenchProviderPolicyResult =
  | { permitted: true }
  | { permitted: false; violations: WorkbenchPolicyViolation[] }

export function validateInstall(
  manifest: WorkbenchProviderManifest,
  allowedTransports: ReadonlySet<string>,
  maxCapabilities: number,
  supportedContractVersion: string = WORKBENCH_PROVIDER_CONTRACT_VERSION
): WorkbenchProviderPolicyResult {
  const violations: WorkbenchPolicyViolation[] = []

  if (manifest.contractVersion !== supportedContractVersion) {
    violations.push({
      boundary: 'validation_required',
      providerId: manifest.providerId,
      description: `Contract version ${manifest.contractVersion} not supported; requires ${supportedContractVersion}`
    })
  }

  if (!allowedTransports.has(manifest.transportType)) {
    violations.push({
      boundary: 'network_policy',
      providerId: manifest.providerId,
      description: `Transport ${manifest.transportType} not in allowed set`
    })
  }

  if (manifest.capabilities.length > maxCapabilities) {
    violations.push({
      boundary: 'command_allowlist',
      providerId: manifest.providerId,
      description: `Capability count ${manifest.capabilities.length} exceeds maximum ${maxCapabilities}`
    })
  }

  if (!manifest.providerId || !manifest.version) {
    violations.push({
      boundary: 'validation_required',
      providerId: manifest.providerId,
      description: 'Missing required manifest fields'
    })
  }

  return violations.length === 0 ? { permitted: true } : { permitted: false, violations }
}

export function validateDiscovery(
  providerId: string,
  activeSourceLock: string | null,
  requestedSourceId: string
): WorkbenchProviderPolicyResult {
  if (activeSourceLock !== null && activeSourceLock !== requestedSourceId) {
    return {
      permitted: false,
      violations: [{
        boundary: 'source_lock',
        providerId,
        description: `Source lock active for ${activeSourceLock}; cannot discover for ${requestedSourceId}`
      }]
    }
  }
  return { permitted: true }
}

export function validateCapabilityExecution(
  providerId: string,
  capabilityId: string,
  commandAllowlist: ReadonlySet<string>,
  mcpAllowlist: ReadonlySet<string>,
  options: {
    grantAvailable: boolean
    confirmationAvailable: boolean
    requiresGrant: boolean
    requiresConfirmation: boolean
  }
): WorkbenchProviderPolicyResult {
  const violations: WorkbenchPolicyViolation[] = []

  if (!commandAllowlist.has(capabilityId) && !mcpAllowlist.has(capabilityId)) {
    violations.push({
      boundary: 'command_allowlist',
      providerId,
      description: `Capability ${capabilityId} not in command or MCP allowlist`
    })
  }

  if (options.requiresGrant && !options.grantAvailable) {
    violations.push({
      boundary: 'grant_required',
      providerId,
      description: `Grant required but not available for ${capabilityId}`
    })
  }

  if (options.requiresConfirmation && !options.confirmationAvailable) {
    violations.push({
      boundary: 'confirmation_required',
      providerId,
      description: `Confirmation required but not available for ${capabilityId}`
    })
  }

  return violations.length === 0 ? { permitted: true } : { permitted: false, violations }
}
