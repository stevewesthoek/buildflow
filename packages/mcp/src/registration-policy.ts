import fs from 'node:fs'
import {
  WORKBENCH_MCP_ADAPTER_CONTRACT_VERSION,
  type WorkbenchMcpClientAdapter,
  type WorkbenchMcpExecutableAdapterCapabilities
} from './adapter-contract.js'
import {
  BRAIN_PROFILE_ALLOWED_COMMAND_KINDS,
  BRAIN_PROFILE_ALLOWED_TOOLS,
  PROFILE_AVAILABILITY,
  WORKBENCH_MCP_PROFILES,
  canonicalProjectRoot,
  type WorkbenchMcpProfile
} from './configure-core.js'
import {
  WORKBENCH_MCP_ORCHESTRATION_VERSION,
  WORKBENCH_MCP_REGISTER_COMMAND,
  WorkbenchMcpAdapterRegistry,
  executeWorkbenchMcpRegisterCommand,
  type WorkbenchMcpOrchestrationResult,
  type WorkbenchMcpRegisterCommand,
  type WorkbenchMcpSummaryTarget
} from './registration-orchestrator.js'
import {
  WORKBENCH_MCP_REGISTRATION_API_VERSION,
  WORKBENCH_MCP_REGISTRATION_SCHEMA_VERSION,
  parseWorkbenchMcpRegistrationRequest,
  type WorkbenchMcpRegistrationManifest,
  type WorkbenchMcpRegistrationOperation,
  type WorkbenchMcpRegistrationRequest,
  type WorkbenchMcpRegistrationSelector
} from './registration-manifest.js'

export const WORKBENCH_MCP_POLICY_VERSION = '1.0.0' as const
export const WORKBENCH_MCP_AUTHORITATIVE_SCOPE = 'project' as const
export const WORKBENCH_MCP_POLICY_DECISION_CODES = [
  'allowed',
  'invalid_policy_version',
  'invalid_request',
  'unsupported_scope',
  'unknown_profile',
  'ownership_mismatch',
  'duplicate_registration',
  'conflicting_registration',
  'unknown_adapter',
  'capability_mismatch',
  'incompatible_version',
  'admission_widening',
  'availability_mismatch',
  'credential_reference_mismatch'
] as const

export type WorkbenchMcpPolicyDecisionCode = typeof WORKBENCH_MCP_POLICY_DECISION_CODES[number]
export type WorkbenchMcpRequestedScope = 'project' | 'global'

export type WorkbenchMcpObservedRegistration = {
  registrationId: string
  adapterId: string
  clientId: string
  projectRoot: string
  profile: WorkbenchMcpProfile
}

export type WorkbenchMcpPolicyRequest = {
  policyVersion: typeof WORKBENCH_MCP_POLICY_VERSION
  scope: WorkbenchMcpRequestedScope
  ownerProjectRoot: string
  command: WorkbenchMcpRegisterCommand
  observedRegistrations?: WorkbenchMcpObservedRegistration[]
}

export type WorkbenchMcpPolicyDecision = {
  policyVersion: typeof WORKBENCH_MCP_POLICY_VERSION
  allowed: boolean
  code: WorkbenchMcpPolicyDecisionCode
  reason: string
  operation?: WorkbenchMcpRegistrationOperation | 'summary'
  profile?: WorkbenchMcpProfile
  clientId?: string
  adapterId?: string
  projectRoot?: string
}

export type WorkbenchMcpPolicyExecutionResult = {
  decision: WorkbenchMcpPolicyDecision
  result?: WorkbenchMcpOrchestrationResult
}

type PolicyTarget = {
  operation: WorkbenchMcpRegistrationOperation
  profile?: WorkbenchMcpProfile
  clientId: string
  adapterId?: string
  projectRoot?: string
  manifest?: WorkbenchMcpRegistrationManifest
  selector?: WorkbenchMcpRegistrationSelector
  dryRun?: boolean
}

function decision(
  allowed: boolean,
  code: WorkbenchMcpPolicyDecisionCode,
  reason: string,
  target: Partial<PolicyTarget> = {}
): WorkbenchMcpPolicyDecision {
  return {
    policyVersion: WORKBENCH_MCP_POLICY_VERSION,
    allowed,
    code,
    reason,
    ...(target.operation ? { operation: target.operation } : {}),
    ...(target.profile ? { profile: target.profile } : {}),
    ...(target.clientId ? { clientId: target.clientId } : {}),
    ...(target.adapterId ? { adapterId: target.adapterId } : {}),
    ...(target.projectRoot ? { projectRoot: target.projectRoot } : {})
  }
}

function canonicalOwnedRoot(value: string): string {
  return canonicalProjectRoot(value, 'Policy owner project root')
}

function canonicalTargetRoot(value: string): string {
  return canonicalProjectRoot(value, 'Registration target project root')
}

function targetFromRequest(request: WorkbenchMcpRegistrationRequest, explicitAdapterId?: string): PolicyTarget {
  if (request.operation === 'inspect_capabilities') {
    return { operation: request.operation, clientId: request.clientId, adapterId: request.adapterId }
  }
  if (request.operation === 'configure') {
    return {
      operation: request.operation,
      clientId: request.manifest.target.client.id,
      adapterId: request.manifest.target.client.adapterId,
      projectRoot: request.manifest.target.project.root,
      profile: request.manifest.target.profile,
      manifest: request.manifest,
      dryRun: request.dryRun
    }
  }
  return {
    operation: request.operation,
    clientId: request.selector.clientId,
    adapterId: explicitAdapterId,
    projectRoot: request.selector.projectRoot,
    profile: request.selector.profile,
    selector: request.selector,
    ...('dryRun' in request ? { dryRun: request.dryRun } : {})
  }
}

function resolveAdapter(
  registry: WorkbenchMcpAdapterRegistry,
  target: PolicyTarget
): { adapter?: WorkbenchMcpClientAdapter; denied?: WorkbenchMcpPolicyDecision } {
  try {
    return { adapter: registry.resolve(target.clientId, target.adapterId) }
  } catch {
    return {
      denied: decision(false, 'unknown_adapter', 'The requested client and adapter identity is not registered.', target)
    }
  }
}

function capabilityDenial(
  capabilities: WorkbenchMcpExecutableAdapterCapabilities,
  target: PolicyTarget
): WorkbenchMcpPolicyDecision | undefined {
  if (
    capabilities.contractVersion !== WORKBENCH_MCP_ADAPTER_CONTRACT_VERSION ||
    capabilities.apiVersion !== WORKBENCH_MCP_REGISTRATION_API_VERSION ||
    !capabilities.registrationApiVersions.includes(WORKBENCH_MCP_REGISTRATION_API_VERSION) ||
    !capabilities.manifestSchemaVersions.includes(WORKBENCH_MCP_REGISTRATION_SCHEMA_VERSION) ||
    !capabilities.adapterApiVersions.includes(WORKBENCH_MCP_ADAPTER_CONTRACT_VERSION)
  ) {
    return decision(false, 'incompatible_version', 'Adapter contract, registration API, schema, or compatibility versions are unsupported.', target)
  }
  if (
    !capabilities.operations.includes(target.operation) ||
    !capabilities.transports.includes('stdio') ||
    !['client', 'project', 'profile'].every(scope => capabilities.scopeDimensions.includes(scope as 'client' | 'project' | 'profile')) ||
    !capabilities.credentialReferenceKinds.includes('file')
  ) {
    return decision(false, 'capability_mismatch', 'Adapter capabilities do not satisfy the client-neutral registration policy.', target)
  }
  if (target.profile && !capabilities.availabilityModes.includes(PROFILE_AVAILABILITY[target.profile])) {
    return decision(false, 'availability_mismatch', 'Adapter does not support the profile availability mode.', target)
  }
  if (target.dryRun && !capabilities.supports.dryRun) {
    return decision(false, 'capability_mismatch', 'Adapter does not support requested dry-run execution.', target)
  }
  if ((target.operation === 'configure' || target.operation === 'remove') && !capabilities.supports.rollback) {
    return decision(false, 'capability_mismatch', 'Mutating registration operations require rollback support.', target)
  }
  return undefined
}

function manifestDenial(manifest: WorkbenchMcpRegistrationManifest, target: PolicyTarget): WorkbenchMcpPolicyDecision | undefined {
  if (manifest.registrationId !== 'workbench' || manifest.server.id !== 'workbench' || manifest.server.transport !== 'stdio') {
    return decision(false, 'ownership_mismatch', 'Workbench registration and server identities are authoritative.', target)
  }
  if (manifest.server.credentialReferences.length !== 1) {
    return decision(false, 'credential_reference_mismatch', 'Exactly one file credential reference is required.', target)
  }
  const reference = manifest.server.credentialReferences[0]
  if (
    reference.kind !== 'file' ||
    !fs.existsSync(reference.path) ||
    reference.inject.kind !== 'environment' ||
    reference.inject.name !== 'WORKBENCH_MCP_CREDENTIAL_FILE'
  ) {
    return decision(false, 'credential_reference_mismatch', 'Credential material must be referenced by file and injected through WORKBENCH_MCP_CREDENTIAL_FILE.', target)
  }
  const expectedAvailability = PROFILE_AVAILABILITY[manifest.target.profile]
  const expectedUnavailable = manifest.target.profile === 'brain' ? 'continue_without_workbench' : 'block_startup'
  if (manifest.availability.startup !== expectedAvailability || manifest.availability.onUnavailable !== expectedUnavailable) {
    return decision(false, 'availability_mismatch', 'Profile availability semantics do not match policy.', target)
  }
  if (manifest.target.profile === 'brain') {
    const tools = new Set(BRAIN_PROFILE_ALLOWED_TOOLS.split(','))
    const commands = new Set(BRAIN_PROFILE_ALLOWED_COMMAND_KINDS.split(','))
    if (manifest.admission.tools.some(tool => !tools.has(tool)) || manifest.admission.commandKinds.some(kind => !commands.has(kind))) {
      return decision(false, 'admission_widening', 'Brain profile admission may only narrow to its canonical tool and command set.', target)
    }
  }
  return undefined
}

function duplicateDenial(
  observed: readonly WorkbenchMcpObservedRegistration[],
  ownerRoot: string,
  target: PolicyTarget
): WorkbenchMcpPolicyDecision | undefined {
  if (!target.projectRoot || !target.profile) return undefined
  const relevant = observed.filter(item => {
    try {
      return canonicalTargetRoot(item.projectRoot) === ownerRoot && item.clientId === target.clientId
    } catch {
      return false
    }
  })
  const exact = relevant.filter(item =>
    item.registrationId === 'workbench' &&
    item.adapterId === target.adapterId &&
    item.profile === target.profile
  )
  if (exact.length > 1) {
    return decision(false, 'duplicate_registration', 'Multiple identical project registrations were observed.', target)
  }
  const conflicts = relevant.filter(item =>
    item.registrationId !== 'workbench' ||
    item.adapterId !== target.adapterId ||
    item.profile !== target.profile
  )
  if (conflicts.length > 0) {
    return decision(false, 'conflicting_registration', 'A conflicting project registration was observed for this client.', target)
  }
  return undefined
}

async function evaluateTarget(
  registry: WorkbenchMcpAdapterRegistry,
  ownerRoot: string,
  target: PolicyTarget,
  observed: readonly WorkbenchMcpObservedRegistration[]
): Promise<WorkbenchMcpPolicyDecision> {
  if (target.profile && !(WORKBENCH_MCP_PROFILES as readonly string[]).includes(target.profile)) {
    return decision(false, 'unknown_profile', 'Unknown MCP registration profile.', target)
  }
  if (target.projectRoot) {
    let canonical: string
    try {
      canonical = canonicalTargetRoot(target.projectRoot)
    } catch (error) {
      return decision(false, 'invalid_request', error instanceof Error ? error.message : 'Invalid project root.', target)
    }
    if (canonical !== ownerRoot) {
      return decision(false, 'ownership_mismatch', 'Registration project root is not owned by this policy request.', { ...target, projectRoot: canonical })
    }
    target = { ...target, projectRoot: canonical }
  }
  const duplicate = duplicateDenial(observed, ownerRoot, target)
  if (duplicate) return duplicate
  const resolved = resolveAdapter(registry, target)
  if (resolved.denied) return resolved.denied
  const capabilities = await resolved.adapter!.inspectCapabilities()
  const capability = capabilityDenial(capabilities, { ...target, adapterId: resolved.adapter!.adapterId })
  if (capability) return capability
  if (target.manifest) {
    const manifest = manifestDenial(target.manifest, target)
    if (manifest) return manifest
  }
  return decision(true, 'allowed', 'Registration policy admitted the request.', { ...target, adapterId: resolved.adapter!.adapterId })
}

export async function evaluateWorkbenchMcpRegistrationPolicy(
  registry: WorkbenchMcpAdapterRegistry,
  input: WorkbenchMcpPolicyRequest
): Promise<WorkbenchMcpPolicyDecision> {
  if (input.policyVersion !== WORKBENCH_MCP_POLICY_VERSION) {
    return decision(false, 'invalid_policy_version', 'Unsupported registration policy version.')
  }
  if (input.scope !== WORKBENCH_MCP_AUTHORITATIVE_SCOPE) {
    return decision(false, 'unsupported_scope', 'Global registration is unsupported; project scope is authoritative.')
  }
  if (
    input.command.orchestrationVersion !== WORKBENCH_MCP_ORCHESTRATION_VERSION ||
    input.command.command !== WORKBENCH_MCP_REGISTER_COMMAND
  ) {
    return decision(false, 'incompatible_version', 'Unsupported orchestration command version.')
  }
  let ownerRoot: string
  try {
    ownerRoot = canonicalOwnedRoot(input.ownerProjectRoot)
  } catch (error) {
    return decision(false, 'invalid_request', error instanceof Error ? error.message : 'Invalid owner project root.')
  }
  const observed = input.observedRegistrations ?? []
  if (input.command.mode === 'summary') {
    const targets = [...input.command.targets].sort((left, right) =>
      left.clientId.localeCompare(right.clientId) || left.adapterId.localeCompare(right.adapterId)
    )
    for (const summaryTarget of targets) {
      const denied = await evaluateTarget(registry, ownerRoot, targetFromSummary(input.command.operation, summaryTarget), observed)
      if (!denied.allowed) return { ...denied, operation: 'summary' }
    }
    return {
      policyVersion: WORKBENCH_MCP_POLICY_VERSION,
      allowed: true,
      code: 'allowed',
      reason: 'Registration policy admitted every summary target.',
      operation: 'summary',
      projectRoot: ownerRoot
    }
  }
  let request: WorkbenchMcpRegistrationRequest
  try {
    request = parseWorkbenchMcpRegistrationRequest(input.command.request)
  } catch (error) {
    return decision(false, 'invalid_request', error instanceof Error ? error.message : 'Invalid registration request.')
  }
  return await evaluateTarget(registry, ownerRoot, targetFromRequest(request, input.command.adapterId), observed)
}

function targetFromSummary(operation: 'status' | 'audit', target: WorkbenchMcpSummaryTarget): PolicyTarget {
  return {
    operation,
    clientId: target.clientId,
    adapterId: target.adapterId,
    projectRoot: target.selector.projectRoot,
    profile: target.selector.profile,
    selector: target.selector
  }
}

export async function executeWorkbenchMcpRegisterCommandWithPolicy(
  registry: WorkbenchMcpAdapterRegistry,
  input: WorkbenchMcpPolicyRequest
): Promise<WorkbenchMcpPolicyExecutionResult> {
  const policy = await evaluateWorkbenchMcpRegistrationPolicy(registry, input)
  if (!policy.allowed) return { decision: policy }
  return {
    decision: policy,
    result: await executeWorkbenchMcpRegisterCommand(registry, input.command)
  }
}
