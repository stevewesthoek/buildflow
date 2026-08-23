import { Ajv, type ValidateFunction } from 'ajv'

export const WORKBENCH_DEVICE_CONTRACT_VERSION = '1' as const
export const WORKBENCH_DEVICE_REGISTRY_KIND = 'workbench.device.registry' as const
export const WORKBENCH_DEVICE_LEASE_KIND = 'workbench.device.lease' as const

export const WORKBENCH_DEVICE_STATE_VALUES = [
  'online', 'busy', 'degraded', 'draining', 'offline', 'revoked'
] as const
export type WorkbenchDeviceState = typeof WORKBENCH_DEVICE_STATE_VALUES[number]

export const WORKBENCH_DEVICE_LEASE_STATE_VALUES = ['active', 'expired', 'released'] as const
export type WorkbenchDeviceLeaseState = typeof WORKBENCH_DEVICE_LEASE_STATE_VALUES[number]

export type WorkbenchDeviceIdentity = {
  deviceId: string
  friendlyName: string
  workbenchVersion: string
  platform: string
  architecture: string
  registeredAt: string
  publicKeyFingerprint?: string
}

export type WorkbenchDeviceCapacity = {
  activeRuns: number
  maxConcurrentRuns: number
  availableSlots: number
  queueDepth: number
  cpuPressure: 'low' | 'medium' | 'high'
  memoryPressure: 'low' | 'medium' | 'high'
}

export type WorkbenchDeviceRegistration = {
  kind: typeof WORKBENCH_DEVICE_REGISTRY_KIND
  contractVersion: typeof WORKBENCH_DEVICE_CONTRACT_VERSION
  deviceId: string
  userId: string
  identity: WorkbenchDeviceIdentity
  state: WorkbenchDeviceState
  capabilities: string[]
  enabledSourceFingerprints: string[]
  capacity: WorkbenchDeviceCapacity
  lastHeartbeatAt: string
  pairingNonce: string
}

export type WorkbenchDeviceLease = {
  kind: typeof WORKBENCH_DEVICE_LEASE_KIND
  contractVersion: typeof WORKBENCH_DEVICE_CONTRACT_VERSION
  leaseId: string
  deviceId: string
  runId: string
  sourceId: string
  state: WorkbenchDeviceLeaseState
  issuedAt: string
  expiresAt: string
  releasedAt?: string
}

type JsonSchema = Record<string, unknown>

const boundedString = (maxLength: number): JsonSchema => ({ type: 'string', minLength: 1, maxLength })

export const WORKBENCH_DEVICE_REGISTRATION_SCHEMA: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Workbench Device Registration',
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'contractVersion', 'deviceId', 'userId', 'identity', 'state', 'capabilities', 'enabledSourceFingerprints', 'capacity', 'lastHeartbeatAt', 'pairingNonce'],
  properties: {
    kind: { const: WORKBENCH_DEVICE_REGISTRY_KIND },
    contractVersion: { const: WORKBENCH_DEVICE_CONTRACT_VERSION },
    deviceId: boundedString(128),
    userId: boundedString(128),
    identity: {
      type: 'object',
      additionalProperties: false,
      required: ['deviceId', 'friendlyName', 'workbenchVersion', 'platform', 'architecture', 'registeredAt'],
      properties: {
        deviceId: boundedString(128),
        friendlyName: boundedString(256),
        workbenchVersion: boundedString(64),
        platform: boundedString(64),
        architecture: boundedString(64),
        registeredAt: boundedString(64),
        publicKeyFingerprint: boundedString(128)
      }
    },
    state: { enum: [...WORKBENCH_DEVICE_STATE_VALUES] },
    capabilities: { type: 'array', items: { type: 'string', maxLength: 128 } },
    enabledSourceFingerprints: { type: 'array', items: { type: 'string', maxLength: 256 } },
    capacity: {
      type: 'object',
      additionalProperties: false,
      required: ['activeRuns', 'maxConcurrentRuns', 'availableSlots', 'queueDepth', 'cpuPressure', 'memoryPressure'],
      properties: {
        activeRuns: { type: 'integer', minimum: 0 },
        maxConcurrentRuns: { type: 'integer', minimum: 1 },
        availableSlots: { type: 'integer', minimum: 0 },
        queueDepth: { type: 'integer', minimum: 0 },
        cpuPressure: { enum: ['low', 'medium', 'high'] },
        memoryPressure: { enum: ['low', 'medium', 'high'] }
      }
    },
    lastHeartbeatAt: boundedString(64),
    pairingNonce: boundedString(256)
  }
}

export const WORKBENCH_DEVICE_LEASE_SCHEMA: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Workbench Device Lease',
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'contractVersion', 'leaseId', 'deviceId', 'runId', 'sourceId', 'state', 'issuedAt', 'expiresAt'],
  properties: {
    kind: { const: WORKBENCH_DEVICE_LEASE_KIND },
    contractVersion: { const: WORKBENCH_DEVICE_CONTRACT_VERSION },
    leaseId: boundedString(128),
    deviceId: boundedString(128),
    runId: boundedString(128),
    sourceId: boundedString(128),
    state: { enum: [...WORKBENCH_DEVICE_LEASE_STATE_VALUES] },
    issuedAt: boundedString(64),
    expiresAt: boundedString(64),
    releasedAt: boundedString(64)
  }
}

let registrationValidator: ValidateFunction | undefined
let leaseValidator: ValidateFunction | undefined

function getRegistrationValidator(): ValidateFunction {
  if (!registrationValidator) {
    const ajv = new Ajv({ strict: false, allErrors: true })
    registrationValidator = ajv.compile(WORKBENCH_DEVICE_REGISTRATION_SCHEMA)
  }
  return registrationValidator
}

function getLeaseValidator(): ValidateFunction {
  if (!leaseValidator) {
    const ajv = new Ajv({ strict: false, allErrors: true })
    leaseValidator = ajv.compile(WORKBENCH_DEVICE_LEASE_SCHEMA)
  }
  return leaseValidator
}

export function validateDeviceRegistration(
  input: unknown
): { valid: true; registration: WorkbenchDeviceRegistration } | { valid: false; errors: string[] } {
  const validate = getRegistrationValidator()
  if (validate(input)) return { valid: true, registration: input as WorkbenchDeviceRegistration }
  return { valid: false, errors: (validate.errors ?? []).map(e => `${e.instancePath} ${e.message ?? ''}`.trim()) }
}

export function validateDeviceLease(
  input: unknown
): { valid: true; lease: WorkbenchDeviceLease } | { valid: false; errors: string[] } {
  const validate = getLeaseValidator()
  if (validate(input)) return { valid: true, lease: input as WorkbenchDeviceLease }
  return { valid: false, errors: (validate.errors ?? []).map(e => `${e.instancePath} ${e.message ?? ''}`.trim()) }
}

export type WorkbenchDeviceRegistryState = {
  devices: Map<string, WorkbenchDeviceRegistration>
  leases: Map<string, WorkbenchDeviceLease>
  maxDevices: number
}

export function createDeviceRegistryState(maxDevices = 32): WorkbenchDeviceRegistryState {
  return { devices: new Map(), leases: new Map(), maxDevices }
}

export function registerDevice(
  state: WorkbenchDeviceRegistryState,
  registration: WorkbenchDeviceRegistration
): { registered: true } | { registered: false; reason: string } {
  const validation = validateDeviceRegistration(registration)
  if (!validation.valid) return { registered: false, reason: `invalid registration: ${validation.errors.join(', ')}` }
  if (registration.identity.deviceId !== registration.deviceId) {
    return { registered: false, reason: 'device_identity_mismatch' }
  }
  const isUpdate = state.devices.has(registration.deviceId)
  if (!isUpdate && state.devices.size >= state.maxDevices) {
    return { registered: false, reason: 'device_limit_reached' }
  }
  state.devices.set(registration.deviceId, registration)
  return { registered: true }
}

export function revokeDevice(
  state: WorkbenchDeviceRegistryState,
  deviceId: string,
  timestamp: string
): { revoked: true } | { revoked: false; reason: string } {
  const existing = state.devices.get(deviceId)
  if (!existing) return { revoked: false, reason: 'device_not_found' }
  if (existing.state === 'revoked') return { revoked: false, reason: 'device_already_revoked' }
  state.devices.set(deviceId, { ...existing, state: 'revoked', lastHeartbeatAt: timestamp })
  return { revoked: true }
}

export function heartbeatDevice(
  state: WorkbenchDeviceRegistryState,
  deviceId: string,
  heartbeatAt: string,
  capacity: WorkbenchDeviceCapacity,
  newState?: WorkbenchDeviceState
): { acknowledged: true } | { acknowledged: false; reason: string } {
  const existing = state.devices.get(deviceId)
  if (!existing) return { acknowledged: false, reason: 'device_not_found' }
  if (existing.state === 'revoked') return { acknowledged: false, reason: 'device_revoked' }
  const resolvedState: WorkbenchDeviceState = newState ?? existing.state
  state.devices.set(deviceId, { ...existing, state: resolvedState, capacity, lastHeartbeatAt: heartbeatAt })
  return { acknowledged: true }
}

export function listEligibleDevices(
  state: WorkbenchDeviceRegistryState,
  sourceFingerprint?: string,
  requiredCapability?: string
): WorkbenchDeviceRegistration[] {
  return [...state.devices.values()].filter(d => {
    if (d.state === 'revoked' || d.state === 'offline') return false
    if (sourceFingerprint && !d.enabledSourceFingerprints.includes(sourceFingerprint)) return false
    if (requiredCapability && !d.capabilities.includes(requiredCapability)) return false
    return true
  })
}

export function issueLease(
  state: WorkbenchDeviceRegistryState,
  lease: WorkbenchDeviceLease
): { issued: true } | { issued: false; reason: string } {
  const validation = validateDeviceLease(lease)
  if (!validation.valid) return { issued: false, reason: `invalid lease: ${validation.errors.join(', ')}` }
  if (state.leases.has(lease.leaseId)) return { issued: false, reason: 'lease_id_already_exists' }
  const device = state.devices.get(lease.deviceId)
  if (!device) return { issued: false, reason: 'device_not_found' }
  if (device.state === 'revoked' || device.state === 'offline') {
    return { issued: false, reason: 'device_not_eligible' }
  }
  state.leases.set(lease.leaseId, lease)
  return { issued: true }
}

export function releaseLease(
  state: WorkbenchDeviceRegistryState,
  leaseId: string,
  timestamp: string
): { released: true } | { released: false; reason: string } {
  const existing = state.leases.get(leaseId)
  if (!existing) return { released: false, reason: 'lease_not_found' }
  if (existing.state === 'released') return { released: false, reason: 'lease_already_released' }
  state.leases.set(leaseId, { ...existing, state: 'released', releasedAt: timestamp })
  return { released: true }
}

export function checkLeaseExpiry(
  lease: WorkbenchDeviceLease,
  nowIso: string
): { expired: boolean } {
  const now = new Date(nowIso).getTime()
  const expiresAt = new Date(lease.expiresAt).getTime()
  return { expired: !isNaN(now) && !isNaN(expiresAt) && now >= expiresAt }
}
