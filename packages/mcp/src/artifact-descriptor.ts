import { Ajv, type ValidateFunction } from 'ajv'

export const WORKBENCH_ARTIFACT_DESCRIPTOR_VERSION = '1.0.0' as const
export const WORKBENCH_ARTIFACT_DESCRIPTOR_KIND = 'workbench.external-artifact.descriptor' as const
export const WORKBENCH_ARTIFACT_SOURCE_TYPES = [
  'chatgpt_file_reference',
  'local_file_picker',
  'provider_file'
] as const
export const WORKBENCH_ARTIFACT_TYPES = ['file', 'directory', 'collection'] as const

export type WorkbenchArtifactSourceType = typeof WORKBENCH_ARTIFACT_SOURCE_TYPES[number]
export type WorkbenchArtifactType = typeof WORKBENCH_ARTIFACT_TYPES[number]
export type WorkbenchArtifactAvailability = 'available' | 'expired' | 'provider_removed'

export type WorkbenchArtifactDescriptor = {
  descriptorVersion: typeof WORKBENCH_ARTIFACT_DESCRIPTOR_VERSION
  kind: typeof WORKBENCH_ARTIFACT_DESCRIPTOR_KIND
  artifactId: string
  sourceType: WorkbenchArtifactSourceType
  artifactType: WorkbenchArtifactType
  filename?: string
  mimeType?: string
  byteSize?: number
  fileCount?: number
  originalReference?: string
  sha256?: string
  freshness?: {
    createdAt?: string
    expiresAt?: string
  }
  adapterTransportReference?: string
}

type JsonSchema = Record<string, unknown>

const boundedString = (maxLength: number): JsonSchema => ({
  type: 'string',
  minLength: 1,
  maxLength
})

export const WORKBENCH_ARTIFACT_DESCRIPTOR_JSON_SCHEMA: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Workbench External Artifact Descriptor',
  type: 'object',
  additionalProperties: false,
  required: ['descriptorVersion', 'kind', 'artifactId', 'sourceType', 'artifactType'],
  properties: {
    descriptorVersion: { const: WORKBENCH_ARTIFACT_DESCRIPTOR_VERSION },
    kind: { const: WORKBENCH_ARTIFACT_DESCRIPTOR_KIND },
    artifactId: {
      type: 'string',
      minLength: 1,
      maxLength: 160,
      pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    },
    sourceType: { enum: [...WORKBENCH_ARTIFACT_SOURCE_TYPES] },
    artifactType: { enum: [...WORKBENCH_ARTIFACT_TYPES] },
    filename: boundedString(1024),
    mimeType: {
      type: 'string',
      minLength: 3,
      maxLength: 255,
      pattern: '^[^\\s/]+/[^\\s/]+$'
    },
    byteSize: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    fileCount: { type: 'integer', minimum: 0, maximum: 1_000_000 },
    originalReference: boundedString(4096),
    sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    freshness: {
      type: 'object',
      additionalProperties: false,
      minProperties: 1,
      properties: {
        createdAt: boundedString(40),
        expiresAt: boundedString(40)
      }
    },
    adapterTransportReference: boundedString(4096)
  }
}

const ajv = new Ajv({ allErrors: true, strict: false })
const descriptorValidator = ajv.compile(WORKBENCH_ARTIFACT_DESCRIPTOR_JSON_SCHEMA)

function validationErrors(validator: ValidateFunction): string[] {
  return (validator.errors ?? []).map(error => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
}

function isCanonicalTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
}

function semanticDescriptorErrors(descriptor: WorkbenchArtifactDescriptor): string[] {
  const errors: string[] = []
  const freshness = descriptor.freshness
  if (freshness?.createdAt && !isCanonicalTimestamp(freshness.createdAt)) {
    errors.push('freshness.createdAt must be a canonical ISO-8601 timestamp')
  }
  if (freshness?.expiresAt && !isCanonicalTimestamp(freshness.expiresAt)) {
    errors.push('freshness.expiresAt must be a canonical ISO-8601 timestamp')
  }
  if (
    freshness?.createdAt
    && freshness.expiresAt
    && Date.parse(freshness.expiresAt) < Date.parse(freshness.createdAt)
  ) {
    errors.push('freshness.expiresAt must not precede freshness.createdAt')
  }
  if (descriptor.artifactType === 'file' && descriptor.fileCount !== undefined && descriptor.fileCount !== 1) {
    errors.push('file artifacts must have fileCount 1 when fileCount is present')
  }
  return errors
}

export function validateWorkbenchArtifactDescriptor(value: unknown): value is WorkbenchArtifactDescriptor {
  if (!descriptorValidator(value)) return false
  return semanticDescriptorErrors(value as WorkbenchArtifactDescriptor).length === 0
}

export function parseWorkbenchArtifactDescriptor(value: unknown): WorkbenchArtifactDescriptor {
  if (!descriptorValidator(value)) {
    throw new Error(`Invalid Workbench artifact descriptor: ${validationErrors(descriptorValidator).join('; ')}`)
  }
  const descriptor = value as WorkbenchArtifactDescriptor
  const errors = semanticDescriptorErrors(descriptor)
  if (errors.length > 0) throw new Error(`Invalid Workbench artifact descriptor: ${errors.join('; ')}`)
  return descriptor
}

export function createWorkbenchArtifactDescriptor(
  descriptor: Omit<WorkbenchArtifactDescriptor, 'descriptorVersion' | 'kind'>
): WorkbenchArtifactDescriptor {
  return parseWorkbenchArtifactDescriptor({
    descriptorVersion: WORKBENCH_ARTIFACT_DESCRIPTOR_VERSION,
    kind: WORKBENCH_ARTIFACT_DESCRIPTOR_KIND,
    ...descriptor
  })
}

export function assertDescriptorHasNoAuthority(
  descriptor: unknown
): void {
  parseWorkbenchArtifactDescriptor(descriptor)
}

export function classifyWorkbenchArtifactAvailability(
  descriptor: WorkbenchArtifactDescriptor,
  options: { now: string; providerAvailable: boolean }
): WorkbenchArtifactAvailability {
  parseWorkbenchArtifactDescriptor(descriptor)
  if (!isCanonicalTimestamp(options.now)) {
    throw new Error('Artifact availability time must be a canonical ISO-8601 timestamp')
  }
  if (!options.providerAvailable) return 'provider_removed'
  const expiresAt = descriptor.freshness?.expiresAt
  return expiresAt && Date.parse(options.now) >= Date.parse(expiresAt) ? 'expired' : 'available'
}
