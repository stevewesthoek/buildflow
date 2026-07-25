import path from 'node:path'
import { Ajv, type ValidateFunction } from 'ajv'
import {
  WORKBENCH_MCP_REGISTRATION_API_VERSION,
  WORKBENCH_MCP_REGISTRATION_OPERATIONS,
  WORKBENCH_MCP_REGISTRATION_SCHEMA_VERSION,
  parseWorkbenchMcpAdapterCapabilities,
  parseWorkbenchMcpRegistrationRequest,
  type WorkbenchMcpAdapterCapabilities,
  type WorkbenchMcpAvailability,
  type WorkbenchMcpRegistrationManifest,
  type WorkbenchMcpRegistrationOperation,
  type WorkbenchMcpRegistrationRequest,
  type WorkbenchMcpRegistrationSelector
} from './registration-manifest.js'
import type { WorkbenchMcpProfile } from './configure-core.js'

export const WORKBENCH_MCP_ADAPTER_CONTRACT_VERSION = '1.0.0' as const
export const WORKBENCH_MCP_ADAPTER_ERROR_CODES = [
  'invalid_request',
  'identity_mismatch',
  'incompatible_version',
  'unsupported_capability',
  'not_found',
  'conflict',
  'permission_denied',
  'io_error',
  'partial_mutation',
  'rollback_failed',
  'internal'
] as const
export const WORKBENCH_MCP_ADAPTER_OUTCOMES = [
  'configured',
  'updated',
  'unchanged',
  'removed',
  'not_found',
  'present',
  'absent',
  'compliant',
  'drifted'
] as const

export type WorkbenchMcpAdapterErrorCode = typeof WORKBENCH_MCP_ADAPTER_ERROR_CODES[number]
export type WorkbenchMcpAdapterOutcome = typeof WORKBENCH_MCP_ADAPTER_OUTCOMES[number]
export type WorkbenchMcpAdapterMutationState = 'none' | 'planned' | 'complete' | 'partial'
export type WorkbenchMcpAdapterRollbackStatus = 'not_required' | 'not_attempted' | 'succeeded' | 'failed'
export type WorkbenchMcpAdapterOperation = Exclude<WorkbenchMcpRegistrationOperation, 'inspect_capabilities'>

type JsonSchema = Record<string, unknown>
type MaybePromise<T> = T | Promise<T>

export type WorkbenchMcpExecutableAdapterCapabilities = WorkbenchMcpAdapterCapabilities & {
  contractVersion: typeof WORKBENCH_MCP_ADAPTER_CONTRACT_VERSION
  registrationApiVersions: string[]
  manifestSchemaVersions: string[]
  adapterApiVersions: string[]
}

export type WorkbenchMcpAdapterRollbackEvidence = {
  supported: boolean
  attempted: boolean
  status: WorkbenchMcpAdapterRollbackStatus
  restoredPaths: string[]
  message?: string
}

export type WorkbenchMcpAdapterMutationEvidence = {
  state: WorkbenchMcpAdapterMutationState
  changedPaths: string[]
  rollback: WorkbenchMcpAdapterRollbackEvidence
}

export type WorkbenchMcpAdapterDiagnostic = {
  code: string
  message: string
}

export type WorkbenchMcpAdapterResult<Operation extends WorkbenchMcpAdapterOperation = WorkbenchMcpAdapterOperation> = {
  contractVersion: typeof WORKBENCH_MCP_ADAPTER_CONTRACT_VERSION
  adapterId: string
  clientId: string
  operation: Operation
  requestId: string
  registrationId: string
  profile: WorkbenchMcpProfile
  outcome: WorkbenchMcpAdapterOutcome
  changed: boolean
  dryRun: boolean
  mutation: WorkbenchMcpAdapterMutationEvidence
  diagnostics: WorkbenchMcpAdapterDiagnostic[]
}

export type WorkbenchMcpAdapterCompatibility = {
  contractVersion: typeof WORKBENCH_MCP_ADAPTER_CONTRACT_VERSION
  adapterId: string
  clientId: string
  operation: WorkbenchMcpRegistrationOperation
  registrationApiVersion: string
  manifestSchemaVersion?: string
  adapterApiVersion?: string
  atomicConfigure: boolean
  rollback: boolean
  dryRun: boolean
}

export type WorkbenchMcpConfigureRequest = Extract<WorkbenchMcpRegistrationRequest, { operation: 'configure' }>
export type WorkbenchMcpRemoveRequest = Extract<WorkbenchMcpRegistrationRequest, { operation: 'remove' }>
export type WorkbenchMcpStatusRequest = {
  apiVersion: typeof WORKBENCH_MCP_REGISTRATION_API_VERSION
  requestId: string
  operation: 'status'
  selector: WorkbenchMcpRegistrationSelector
}
export type WorkbenchMcpAuditRequest = {
  apiVersion: typeof WORKBENCH_MCP_REGISTRATION_API_VERSION
  requestId: string
  operation: 'audit'
  selector: WorkbenchMcpRegistrationSelector
}

export interface WorkbenchMcpClientAdapter {
  readonly adapterId: string
  readonly clientId: string
  inspectCapabilities(): MaybePromise<WorkbenchMcpExecutableAdapterCapabilities>
  configure(request: WorkbenchMcpConfigureRequest): MaybePromise<WorkbenchMcpAdapterResult<'configure'>>
  remove(request: WorkbenchMcpRemoveRequest): MaybePromise<WorkbenchMcpAdapterResult<'remove'>>
  status(request: WorkbenchMcpStatusRequest): MaybePromise<WorkbenchMcpAdapterResult<'status'>>
  audit(request: WorkbenchMcpAuditRequest): MaybePromise<WorkbenchMcpAdapterResult<'audit'>>
}

const identifierSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 160,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
} as const
const versionListSchema = {
  type: 'array',
  minItems: 1,
  maxItems: 32,
  uniqueItems: true,
  items: { type: 'string', minLength: 1, maxLength: 80 }
} as const

export const WORKBENCH_MCP_EXECUTABLE_ADAPTER_CAPABILITIES_JSON_SCHEMA: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Workbench MCP Executable Adapter Capabilities',
  type: 'object',
  additionalProperties: false,
  required: [
    'apiVersion',
    'contractVersion',
    'adapterId',
    'clientId',
    'registrationApiVersions',
    'manifestSchemaVersions',
    'adapterApiVersions',
    'operations',
    'transports',
    'scopeDimensions',
    'availabilityModes',
    'credentialReferenceKinds',
    'supports'
  ],
  properties: {
    apiVersion: { const: WORKBENCH_MCP_REGISTRATION_API_VERSION },
    contractVersion: { const: WORKBENCH_MCP_ADAPTER_CONTRACT_VERSION },
    adapterId: identifierSchema,
    clientId: identifierSchema,
    registrationApiVersions: versionListSchema,
    manifestSchemaVersions: versionListSchema,
    adapterApiVersions: versionListSchema,
    operations: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { enum: [...WORKBENCH_MCP_REGISTRATION_OPERATIONS] }
    },
    transports: {
      type: 'array',
      minItems: 1,
      maxItems: 1,
      uniqueItems: true,
      items: { const: 'stdio' }
    },
    scopeDimensions: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { enum: ['client', 'project', 'profile'] }
    },
    availabilityModes: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { enum: ['required', 'optional'] }
    },
    credentialReferenceKinds: {
      type: 'array',
      minItems: 1,
      maxItems: 1,
      uniqueItems: true,
      items: { const: 'file' }
    },
    supports: {
      type: 'object',
      additionalProperties: false,
      required: ['capabilityInspection', 'atomicConfigure', 'rollback', 'dryRun'],
      properties: {
        capabilityInspection: { const: true },
        atomicConfigure: { type: 'boolean' },
        rollback: { type: 'boolean' },
        dryRun: { type: 'boolean' }
      }
    }
  }
}

const ajv = new Ajv({ allErrors: true, strict: false })
const capabilitiesValidator = ajv.compile(WORKBENCH_MCP_EXECUTABLE_ADAPTER_CAPABILITIES_JSON_SCHEMA)

function validationErrors(validator: ValidateFunction): string[] {
  return (validator.errors ?? []).map(error => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

function sortedDiagnostics(values: readonly WorkbenchMcpAdapterDiagnostic[]): WorkbenchMcpAdapterDiagnostic[] {
  return [...values]
    .map(value => ({ code: value.code, message: value.message }))
    .sort((left, right) => left.code.localeCompare(right.code) || left.message.localeCompare(right.message))
}

function operationRegistrationId(request: Exclude<WorkbenchMcpRegistrationRequest, { operation: 'inspect_capabilities' }>): string {
  return request.operation === 'configure' ? request.manifest.registrationId : request.selector.registrationId
}

function operationProfile(request: Exclude<WorkbenchMcpRegistrationRequest, { operation: 'inspect_capabilities' }>): WorkbenchMcpProfile {
  return request.operation === 'configure' ? request.manifest.target.profile : request.selector.profile
}

function baseCapabilities(value: WorkbenchMcpExecutableAdapterCapabilities): WorkbenchMcpAdapterCapabilities {
  return {
    apiVersion: value.apiVersion,
    adapterId: value.adapterId,
    clientId: value.clientId,
    operations: [...value.operations],
    transports: ['stdio'],
    scopeDimensions: [...value.scopeDimensions],
    availabilityModes: [...value.availabilityModes],
    credentialReferenceKinds: ['file'],
    supports: { ...value.supports }
  }
}

export function parseWorkbenchMcpExecutableAdapterCapabilities(value: unknown): WorkbenchMcpExecutableAdapterCapabilities {
  if (!capabilitiesValidator(value)) {
    throw new WorkbenchMcpAdapterContractError(
      'invalid_request',
      `Invalid Workbench MCP executable adapter capabilities: ${validationErrors(capabilitiesValidator).join('; ')}`
    )
  }
  const capabilities = value as WorkbenchMcpExecutableAdapterCapabilities
  parseWorkbenchMcpAdapterCapabilities(baseCapabilities(capabilities))
  return capabilities
}

export class WorkbenchMcpAdapterContractError extends Error {
  readonly code: WorkbenchMcpAdapterErrorCode
  readonly retryable: boolean
  readonly adapterId?: string
  readonly clientId?: string
  readonly operation?: WorkbenchMcpRegistrationOperation
  readonly mutation?: WorkbenchMcpAdapterMutationEvidence

  constructor(
    code: WorkbenchMcpAdapterErrorCode,
    message: string,
    options: {
      retryable?: boolean
      adapterId?: string
      clientId?: string
      operation?: WorkbenchMcpRegistrationOperation
      mutation?: WorkbenchMcpAdapterMutationEvidence
      cause?: unknown
    } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'WorkbenchMcpAdapterContractError'
    this.code = code
    this.retryable = options.retryable ?? false
    this.adapterId = options.adapterId
    this.clientId = options.clientId
    this.operation = options.operation
    this.mutation = options.mutation === undefined ? undefined : normalizeMutationEvidence(options.mutation)
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.adapterId ? { adapterId: this.adapterId } : {}),
      ...(this.clientId ? { clientId: this.clientId } : {}),
      ...(this.operation ? { operation: this.operation } : {}),
      ...(this.mutation ? { mutation: this.mutation } : {})
    }
  }
}

export function normalizeMutationEvidence(value: WorkbenchMcpAdapterMutationEvidence): WorkbenchMcpAdapterMutationEvidence {
  const changedPaths = sortedUnique(value.changedPaths)
  const restoredPaths = sortedUnique(value.rollback.restoredPaths)
  if ((value.state === 'complete' || value.state === 'partial') && changedPaths.length === 0) {
    throw new WorkbenchMcpAdapterContractError('invalid_request', `${value.state} mutation evidence requires changed paths`)
  }
  if ((value.rollback.status === 'succeeded' || value.rollback.status === 'failed') && !value.rollback.attempted) {
    throw new WorkbenchMcpAdapterContractError('invalid_request', 'completed rollback evidence requires attempted=true')
  }
  if (value.rollback.attempted && !value.rollback.supported) {
    throw new WorkbenchMcpAdapterContractError('invalid_request', 'rollback cannot be attempted when unsupported')
  }
  return {
    state: value.state,
    changedPaths,
    rollback: {
      supported: value.rollback.supported,
      attempted: value.rollback.attempted,
      status: value.rollback.status,
      restoredPaths,
      ...(value.rollback.message ? { message: value.rollback.message } : {})
    }
  }
}

export function createWorkbenchMcpAdapterResult<Operation extends WorkbenchMcpAdapterOperation>(input: {
  adapterId: string
  clientId: string
  operation: Operation
  requestId: string
  registrationId: string
  profile: WorkbenchMcpProfile
  outcome: WorkbenchMcpAdapterOutcome
  dryRun?: boolean
  mutation: WorkbenchMcpAdapterMutationEvidence
  diagnostics?: readonly WorkbenchMcpAdapterDiagnostic[]
}): WorkbenchMcpAdapterResult<Operation> {
  const mutation = normalizeMutationEvidence(input.mutation)
  return {
    contractVersion: WORKBENCH_MCP_ADAPTER_CONTRACT_VERSION,
    adapterId: input.adapterId,
    clientId: input.clientId,
    operation: input.operation,
    requestId: input.requestId,
    registrationId: input.registrationId,
    profile: input.profile,
    outcome: input.outcome,
    changed: mutation.state === 'complete' || mutation.state === 'partial',
    dryRun: input.dryRun ?? false,
    mutation,
    diagnostics: sortedDiagnostics(input.diagnostics ?? [])
  }
}

function contractError(
  code: WorkbenchMcpAdapterErrorCode,
  message: string,
  capabilities: WorkbenchMcpExecutableAdapterCapabilities,
  operation: WorkbenchMcpRegistrationOperation
): never {
  throw new WorkbenchMcpAdapterContractError(code, message, {
    adapterId: capabilities.adapterId,
    clientId: capabilities.clientId,
    operation
  })
}

function requireMember(
  values: readonly string[],
  expected: string,
  label: string,
  capabilities: WorkbenchMcpExecutableAdapterCapabilities,
  operation: WorkbenchMcpRegistrationOperation,
  code: WorkbenchMcpAdapterErrorCode = 'unsupported_capability'
): void {
  if (!values.includes(expected)) contractError(code, `${label} ${expected} is not supported`, capabilities, operation)
}

function parseRequest(value: unknown): WorkbenchMcpRegistrationRequest {
  try {
    return parseWorkbenchMcpRegistrationRequest(value)
  } catch (error) {
    throw new WorkbenchMcpAdapterContractError(
      'invalid_request',
      error instanceof Error ? error.message : 'Invalid Workbench MCP registration request',
      { cause: error }
    )
  }
}

export function negotiateWorkbenchMcpAdapterCompatibility(
  capabilitiesValue: unknown,
  requestValue: unknown
): WorkbenchMcpAdapterCompatibility {
  const capabilities = parseWorkbenchMcpExecutableAdapterCapabilities(capabilitiesValue)
  const request = parseRequest(requestValue)
  const operation = request.operation

  if (!capabilities.operations.includes(operation)) {
    contractError('unsupported_capability', `Operation ${operation} is not supported`, capabilities, operation)
  }
  requireMember(
    capabilities.registrationApiVersions,
    request.apiVersion,
    'Registration API version',
    capabilities,
    operation,
    'incompatible_version'
  )

  if (operation === 'inspect_capabilities') {
    if (request.adapterId !== capabilities.adapterId || request.clientId !== capabilities.clientId) {
      contractError('identity_mismatch', 'Capability request identity does not match the adapter', capabilities, operation)
    }
    return {
      contractVersion: WORKBENCH_MCP_ADAPTER_CONTRACT_VERSION,
      adapterId: capabilities.adapterId,
      clientId: capabilities.clientId,
      operation,
      registrationApiVersion: request.apiVersion,
      atomicConfigure: capabilities.supports.atomicConfigure,
      rollback: capabilities.supports.rollback,
      dryRun: capabilities.supports.dryRun
    }
  }

  requireMember(capabilities.scopeDimensions, 'client', 'Scope dimension', capabilities, operation)
  requireMember(capabilities.scopeDimensions, 'project', 'Scope dimension', capabilities, operation)
  requireMember(capabilities.scopeDimensions, 'profile', 'Scope dimension', capabilities, operation)

  const clientId = operation === 'configure' ? request.manifest.target.client.id : request.selector.clientId
  if (clientId !== capabilities.clientId) {
    contractError('identity_mismatch', `Client ${clientId} does not match adapter client ${capabilities.clientId}`, capabilities, operation)
  }

  if ((operation === 'configure' || operation === 'remove') && request.dryRun && !capabilities.supports.dryRun) {
    contractError('unsupported_capability', 'Dry-run is not supported', capabilities, operation)
  }

  if (operation !== 'configure') {
    return {
      contractVersion: WORKBENCH_MCP_ADAPTER_CONTRACT_VERSION,
      adapterId: capabilities.adapterId,
      clientId: capabilities.clientId,
      operation,
      registrationApiVersion: request.apiVersion,
      atomicConfigure: capabilities.supports.atomicConfigure,
      rollback: capabilities.supports.rollback,
      dryRun: capabilities.supports.dryRun
    }
  }

  const manifest = request.manifest
  if (manifest.target.client.adapterId !== capabilities.adapterId) {
    contractError(
      'identity_mismatch',
      `Manifest adapter ${manifest.target.client.adapterId} does not match ${capabilities.adapterId}`,
      capabilities,
      operation
    )
  }
  requireMember(capabilities.transports, manifest.server.transport, 'Transport', capabilities, operation)
  requireMember(capabilities.availabilityModes, manifest.availability.startup, 'Availability mode', capabilities, operation)
  for (const reference of manifest.server.credentialReferences) {
    requireMember(capabilities.credentialReferenceKinds, reference.kind, 'Credential reference kind', capabilities, operation)
  }
  requireMember(
    capabilities.registrationApiVersions,
    manifest.compatibility.registrationApiVersion,
    'Manifest registration API version',
    capabilities,
    operation,
    'incompatible_version'
  )
  requireMember(
    capabilities.manifestSchemaVersions,
    manifest.schemaVersion,
    'Manifest schema version',
    capabilities,
    operation,
    'incompatible_version'
  )
  requireMember(
    capabilities.adapterApiVersions,
    manifest.compatibility.adapterApiVersion,
    'Adapter API version',
    capabilities,
    operation,
    'incompatible_version'
  )
  if (manifest.rollback.backupRequired && !capabilities.supports.atomicConfigure && !capabilities.supports.rollback) {
    contractError(
      'unsupported_capability',
      'Backup-required configuration needs atomic configure or rollback support',
      capabilities,
      operation
    )
  }
  if (!path.isAbsolute(manifest.target.project.root)) {
    contractError('invalid_request', 'Project root must be absolute', capabilities, operation)
  }

  return {
    contractVersion: WORKBENCH_MCP_ADAPTER_CONTRACT_VERSION,
    adapterId: capabilities.adapterId,
    clientId: capabilities.clientId,
    operation,
    registrationApiVersion: manifest.compatibility.registrationApiVersion,
    manifestSchemaVersion: manifest.schemaVersion,
    adapterApiVersion: manifest.compatibility.adapterApiVersion,
    atomicConfigure: capabilities.supports.atomicConfigure,
    rollback: capabilities.supports.rollback,
    dryRun: capabilities.supports.dryRun
  }
}

function assertResultMatchesRequest(
  result: WorkbenchMcpAdapterResult,
  request: Exclude<WorkbenchMcpRegistrationRequest, { operation: 'inspect_capabilities' }>,
  capabilities: WorkbenchMcpExecutableAdapterCapabilities
): void {
  const expectedRegistrationId = operationRegistrationId(request)
  const expectedProfile = operationProfile(request)
  const expectedDryRun = (request.operation === 'configure' || request.operation === 'remove') && request.dryRun === true
  if (result.contractVersion !== WORKBENCH_MCP_ADAPTER_CONTRACT_VERSION) {
    contractError('incompatible_version', 'Adapter result contract version is incompatible', capabilities, request.operation)
  }
  if (result.adapterId !== capabilities.adapterId || result.clientId !== capabilities.clientId) {
    contractError('identity_mismatch', 'Adapter result identity does not match capabilities', capabilities, request.operation)
  }
  if (result.operation !== request.operation || result.requestId !== request.requestId) {
    contractError('invalid_request', 'Adapter result does not match the request operation or request ID', capabilities, request.operation)
  }
  if (result.registrationId !== expectedRegistrationId || result.profile !== expectedProfile) {
    contractError('invalid_request', 'Adapter result changed registration identity or profile', capabilities, request.operation)
  }
  if (result.dryRun !== expectedDryRun) {
    contractError('invalid_request', 'Adapter result dry-run flag does not match the request', capabilities, request.operation)
  }
  const normalized = normalizeMutationEvidence(result.mutation)
  if (JSON.stringify(normalized) !== JSON.stringify(result.mutation)) {
    contractError('invalid_request', 'Adapter result mutation evidence is not normalized', capabilities, request.operation)
  }
  if (result.changed !== (result.mutation.state === 'complete' || result.mutation.state === 'partial')) {
    contractError('invalid_request', 'Adapter result changed flag conflicts with mutation evidence', capabilities, request.operation)
  }
  if (expectedProfile === 'brain' && result.profile !== 'brain') {
    contractError('identity_mismatch', 'Brain profile must remain restricted and unchanged', capabilities, request.operation)
  }
}

export async function executeWorkbenchMcpAdapterRequest(
  adapter: WorkbenchMcpClientAdapter,
  requestValue: unknown
): Promise<WorkbenchMcpExecutableAdapterCapabilities | WorkbenchMcpAdapterResult> {
  const capabilities = parseWorkbenchMcpExecutableAdapterCapabilities(await adapter.inspectCapabilities())
  if (adapter.adapterId !== capabilities.adapterId || adapter.clientId !== capabilities.clientId) {
    contractError('identity_mismatch', 'Adapter instance identity does not match advertised capabilities', capabilities, 'inspect_capabilities')
  }
  const request = parseRequest(requestValue)
  negotiateWorkbenchMcpAdapterCompatibility(capabilities, request)
  if (request.operation === 'inspect_capabilities') return capabilities

  let result: WorkbenchMcpAdapterResult
  switch (request.operation) {
    case 'configure':
      result = await adapter.configure(request)
      break
    case 'remove':
      result = await adapter.remove(request)
      break
    case 'status':
      result = await adapter.status(request as WorkbenchMcpStatusRequest)
      break
    case 'audit':
      result = await adapter.audit(request as WorkbenchMcpAuditRequest)
      break
  }
  assertResultMatchesRequest(result, request, capabilities)
  return result
}

export function defaultWorkbenchMcpExecutableAdapterCapabilities(input: {
  adapterId: string
  clientId: string
  adapterApiVersion?: string
  atomicConfigure?: boolean
  rollback?: boolean
  dryRun?: boolean
}): WorkbenchMcpExecutableAdapterCapabilities {
  return parseWorkbenchMcpExecutableAdapterCapabilities({
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    contractVersion: WORKBENCH_MCP_ADAPTER_CONTRACT_VERSION,
    adapterId: input.adapterId,
    clientId: input.clientId,
    registrationApiVersions: [WORKBENCH_MCP_REGISTRATION_API_VERSION],
    manifestSchemaVersions: [WORKBENCH_MCP_REGISTRATION_SCHEMA_VERSION],
    adapterApiVersions: [input.adapterApiVersion ?? WORKBENCH_MCP_ADAPTER_CONTRACT_VERSION],
    operations: [...WORKBENCH_MCP_REGISTRATION_OPERATIONS],
    transports: ['stdio'],
    scopeDimensions: ['client', 'project', 'profile'],
    availabilityModes: ['required', 'optional'] satisfies WorkbenchMcpAvailability[],
    credentialReferenceKinds: ['file'],
    supports: {
      capabilityInspection: true,
      atomicConfigure: input.atomicConfigure ?? true,
      rollback: input.rollback ?? true,
      dryRun: input.dryRun ?? true
    }
  })
}
