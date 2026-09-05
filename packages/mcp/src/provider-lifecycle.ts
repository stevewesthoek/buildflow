import { Ajv, type ValidateFunction } from 'ajv'

export const WORKBENCH_PROVIDER_CONTRACT_VERSION = '1' as const
export const WORKBENCH_PROVIDER_KIND = 'workbench.provider.lifecycle' as const

export const WORKBENCH_PROVIDER_HEALTH_VALUES = ['healthy', 'stale', 'degraded', 'unreachable'] as const
export const WORKBENCH_PROVIDER_LIFECYCLE_STATUS_VALUES = [
  'installed', 'installing', 'upgrading', 'removing', 'removed', 'failed'
] as const

export type WorkbenchProviderHealth = typeof WORKBENCH_PROVIDER_HEALTH_VALUES[number]
export type WorkbenchProviderLifecycleStatus = typeof WORKBENCH_PROVIDER_LIFECYCLE_STATUS_VALUES[number]

export type WorkbenchProviderIdentity = {
  providerId: string
  displayName: string
  contractVersion: string
  sourceRevision: string
}

export type WorkbenchProviderLifecycleContract = {
  kind: typeof WORKBENCH_PROVIDER_KIND
  identity: WorkbenchProviderIdentity
  health: WorkbenchProviderHealth
  freshnessTimestamp: string
  compatible: boolean
  lifecycleStatus: WorkbenchProviderLifecycleStatus
  summary?: string
  schemaRefs?: string[]
  transportRef?: string
}

export type WorkbenchProviderAdmissionResult =
  | { admitted: true }
  | { admitted: false; reason: string }

type JsonSchema = Record<string, unknown>

const boundedString = (maxLength: number): JsonSchema => ({
  type: 'string',
  minLength: 1,
  maxLength
})

export const WORKBENCH_PROVIDER_LIFECYCLE_JSON_SCHEMA: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Workbench Provider Lifecycle Contract',
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'identity', 'health', 'freshnessTimestamp', 'compatible', 'lifecycleStatus'],
  properties: {
    kind: { const: WORKBENCH_PROVIDER_KIND },
    identity: {
      type: 'object',
      additionalProperties: false,
      required: ['providerId', 'displayName', 'contractVersion', 'sourceRevision'],
      properties: {
        providerId: {
          type: 'string',
          minLength: 1,
          maxLength: 160,
          pattern: '^[a-z][a-z0-9._-]*$'
        },
        displayName: boundedString(256),
        contractVersion: boundedString(32),
        sourceRevision: boundedString(256)
      }
    },
    health: { enum: [...WORKBENCH_PROVIDER_HEALTH_VALUES] },
    freshnessTimestamp: boundedString(40),
    compatible: { type: 'boolean' },
    lifecycleStatus: { enum: [...WORKBENCH_PROVIDER_LIFECYCLE_STATUS_VALUES] },
    summary: boundedString(4096),
    schemaRefs: {
      type: 'array',
      maxItems: 64,
      items: boundedString(2048)
    },
    transportRef: boundedString(2048)
  }
}

const ajv = new Ajv({ allErrors: true, strict: false })
const contractValidator = ajv.compile(WORKBENCH_PROVIDER_LIFECYCLE_JSON_SCHEMA)

function validationErrors(validator: ValidateFunction): string[] {
  return (validator.errors ?? []).map(e => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`)
}

function isCanonicalTimestamp(value: string): boolean {
  const ms = Date.parse(value)
  return Number.isFinite(ms) && new Date(ms).toISOString() === value
}

export function validateProviderLifecycleContract(value: unknown): value is WorkbenchProviderLifecycleContract {
  if (!contractValidator(value)) return false
  const contract = value as WorkbenchProviderLifecycleContract
  return isCanonicalTimestamp(contract.freshnessTimestamp)
}

export function parseProviderLifecycleContract(value: unknown): WorkbenchProviderLifecycleContract {
  if (!contractValidator(value)) {
    throw new Error(`Invalid provider lifecycle contract: ${validationErrors(contractValidator).join('; ')}`)
  }
  const contract = value as WorkbenchProviderLifecycleContract
  if (!isCanonicalTimestamp(contract.freshnessTimestamp)) {
    throw new Error('Invalid provider lifecycle contract: freshnessTimestamp must be a canonical ISO-8601 timestamp')
  }
  return contract
}

export function evaluateProviderAdmission(
  contract: WorkbenchProviderLifecycleContract,
  knownProviderIds: ReadonlySet<string>,
  supportedContractVersion: string
): WorkbenchProviderAdmissionResult {
  if (contract.identity.contractVersion !== supportedContractVersion) {
    return { admitted: false, reason: 'incompatible_contract_version' }
  }
  if (knownProviderIds.has(contract.identity.providerId)) {
    return { admitted: false, reason: 'duplicate_provider_identity' }
  }
  if (!contract.compatible) {
    return { admitted: false, reason: 'provider_incompatible' }
  }
  if (contract.health !== 'healthy') {
    return { admitted: false, reason: 'provider_unhealthy' }
  }
  if (contract.lifecycleStatus !== 'installed') {
    return { admitted: false, reason: 'provider_not_installed' }
  }
  return { admitted: true }
}
