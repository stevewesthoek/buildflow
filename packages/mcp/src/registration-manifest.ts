import path from 'node:path'
import { Ajv, type ValidateFunction } from 'ajv'
import {
  RUN_WORKBENCH_DIRECT_COMMAND_KINDS,
  type RunWorkbenchDirectCommandKind
} from '@workbench/shared'
import { WORKBENCH_TOOL_NAMES, type WorkbenchToolName } from './contracts.js'
import {
  BRAIN_PROFILE_ALLOWED_COMMAND_KINDS,
  BRAIN_PROFILE_ALLOWED_TOOLS,
  PROFILE_AVAILABILITY,
  type WorkbenchMcpProfile
} from './configure-core.js'

export const WORKBENCH_MCP_REGISTRATION_SCHEMA_VERSION = '1.0.0' as const
export const WORKBENCH_MCP_REGISTRATION_API_VERSION = '1.0.0' as const
export const WORKBENCH_MCP_REGISTRATION_KIND = 'workbench.mcp.registration' as const
export const WORKBENCH_MCP_REGISTRATION_OPERATIONS = [
  'inspect_capabilities',
  'configure',
  'remove',
  'status',
  'audit'
] as const

export type WorkbenchMcpRegistrationOperation = typeof WORKBENCH_MCP_REGISTRATION_OPERATIONS[number]
export type WorkbenchMcpAvailability = 'required' | 'optional'
export type WorkbenchMcpUnavailableBehavior = 'block_startup' | 'continue_without_workbench'
export type WorkbenchMcpRollbackStrategy = 'restore_previous_or_remove' | 'remove_created_registration'

export type WorkbenchMcpCredentialReference = {
  id: string
  kind: 'file'
  path: string
  inject: {
    kind: 'environment'
    name: 'WORKBENCH_MCP_CREDENTIAL_FILE'
  }
}

export type WorkbenchMcpRegistrationManifest = {
  schemaVersion: typeof WORKBENCH_MCP_REGISTRATION_SCHEMA_VERSION
  kind: typeof WORKBENCH_MCP_REGISTRATION_KIND
  registrationId: string
  server: {
    id: 'workbench'
    transport: 'stdio'
    executable: {
      command: string
      args: string[]
      cwd: string
    }
    credentialReferences: WorkbenchMcpCredentialReference[]
  }
  target: {
    client: {
      id: string
      adapterId: string
    }
    project: {
      root: string
    }
    profile: WorkbenchMcpProfile
  }
  availability: {
    startup: WorkbenchMcpAvailability
    onUnavailable: WorkbenchMcpUnavailableBehavior
  }
  admission: {
    tools: WorkbenchToolName[]
    commandKinds: RunWorkbenchDirectCommandKind[]
  }
  compatibility: {
    registrationApiVersion: typeof WORKBENCH_MCP_REGISTRATION_API_VERSION
    minimumWorkbenchVersion: string
    adapterApiVersion: string
  }
  rollback: {
    strategy: WorkbenchMcpRollbackStrategy
    backupRequired: boolean
    metadata: {
      transactionId?: string
      backupRef?: string
      previousManifestDigest?: string
    }
  }
}

export type WorkbenchMcpAdapterCapabilities = {
  apiVersion: typeof WORKBENCH_MCP_REGISTRATION_API_VERSION
  adapterId: string
  clientId: string
  operations: WorkbenchMcpRegistrationOperation[]
  transports: ['stdio']
  scopeDimensions: Array<'client' | 'project' | 'profile'>
  availabilityModes: WorkbenchMcpAvailability[]
  credentialReferenceKinds: ['file']
  supports: {
    capabilityInspection: true
    atomicConfigure: boolean
    rollback: boolean
    dryRun: boolean
  }
}

export type WorkbenchMcpRegistrationSelector = {
  registrationId: string
  clientId: string
  projectRoot: string
  profile: WorkbenchMcpProfile
}

export type WorkbenchMcpRegistrationRequest =
  | {
      apiVersion: typeof WORKBENCH_MCP_REGISTRATION_API_VERSION
      requestId: string
      operation: 'inspect_capabilities'
      adapterId: string
      clientId: string
    }
  | {
      apiVersion: typeof WORKBENCH_MCP_REGISTRATION_API_VERSION
      requestId: string
      operation: 'configure'
      manifest: WorkbenchMcpRegistrationManifest
      dryRun?: boolean
    }
  | {
      apiVersion: typeof WORKBENCH_MCP_REGISTRATION_API_VERSION
      requestId: string
      operation: 'remove'
      selector: WorkbenchMcpRegistrationSelector
      dryRun?: boolean
    }
  | {
      apiVersion: typeof WORKBENCH_MCP_REGISTRATION_API_VERSION
      requestId: string
      operation: 'status' | 'audit'
      selector: WorkbenchMcpRegistrationSelector
    }

type JsonSchema = Record<string, unknown>

const identifierSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 160,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
} as const

const pathSchema = { type: 'string', minLength: 1, maxLength: 4096 } as const
const versionSchema = { type: 'string', minLength: 1, maxLength: 80 } as const

export const WORKBENCH_MCP_REGISTRATION_MANIFEST_JSON_SCHEMA: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Workbench MCP Registration Manifest',
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'kind',
    'registrationId',
    'server',
    'target',
    'availability',
    'admission',
    'compatibility',
    'rollback'
  ],
  properties: {
    schemaVersion: { const: WORKBENCH_MCP_REGISTRATION_SCHEMA_VERSION },
    kind: { const: WORKBENCH_MCP_REGISTRATION_KIND },
    registrationId: identifierSchema,
    server: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'transport', 'executable', 'credentialReferences'],
      properties: {
        id: { const: 'workbench' },
        transport: { const: 'stdio' },
        executable: {
          type: 'object',
          additionalProperties: false,
          required: ['command', 'args', 'cwd'],
          properties: {
            command: pathSchema,
            args: {
              type: 'array',
              maxItems: 64,
              items: { type: 'string', minLength: 1, maxLength: 4096 }
            },
            cwd: pathSchema
          }
        },
        credentialReferences: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'kind', 'path', 'inject'],
            properties: {
              id: identifierSchema,
              kind: { const: 'file' },
              path: pathSchema,
              inject: {
                type: 'object',
                additionalProperties: false,
                required: ['kind', 'name'],
                properties: {
                  kind: { const: 'environment' },
                  name: { const: 'WORKBENCH_MCP_CREDENTIAL_FILE' }
                }
              }
            }
          }
        }
      }
    },
    target: {
      type: 'object',
      additionalProperties: false,
      required: ['client', 'project', 'profile'],
      properties: {
        client: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'adapterId'],
          properties: { id: identifierSchema, adapterId: identifierSchema }
        },
        project: {
          type: 'object',
          additionalProperties: false,
          required: ['root'],
          properties: { root: pathSchema }
        },
        profile: { enum: ['workbench', 'brain'] }
      }
    },
    availability: {
      type: 'object',
      additionalProperties: false,
      required: ['startup', 'onUnavailable'],
      properties: {
        startup: { enum: ['required', 'optional'] },
        onUnavailable: { enum: ['block_startup', 'continue_without_workbench'] }
      }
    },
    admission: {
      type: 'object',
      additionalProperties: false,
      required: ['tools', 'commandKinds'],
      properties: {
        tools: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: { enum: [...WORKBENCH_TOOL_NAMES] }
        },
        commandKinds: {
          type: 'array',
          uniqueItems: true,
          items: { enum: [...RUN_WORKBENCH_DIRECT_COMMAND_KINDS] }
        }
      }
    },
    compatibility: {
      type: 'object',
      additionalProperties: false,
      required: ['registrationApiVersion', 'minimumWorkbenchVersion', 'adapterApiVersion'],
      properties: {
        registrationApiVersion: { const: WORKBENCH_MCP_REGISTRATION_API_VERSION },
        minimumWorkbenchVersion: versionSchema,
        adapterApiVersion: versionSchema
      }
    },
    rollback: {
      type: 'object',
      additionalProperties: false,
      required: ['strategy', 'backupRequired', 'metadata'],
      properties: {
        strategy: { enum: ['restore_previous_or_remove', 'remove_created_registration'] },
        backupRequired: { type: 'boolean' },
        metadata: {
          type: 'object',
          additionalProperties: false,
          properties: {
            transactionId: identifierSchema,
            backupRef: { type: 'string', minLength: 1, maxLength: 4096 },
            previousManifestDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' }
          }
        }
      }
    }
  }
}

export const WORKBENCH_MCP_ADAPTER_CAPABILITIES_JSON_SCHEMA: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Workbench MCP Adapter Capabilities',
  type: 'object',
  additionalProperties: false,
  required: [
    'apiVersion',
    'adapterId',
    'clientId',
    'operations',
    'transports',
    'scopeDimensions',
    'availabilityModes',
    'credentialReferenceKinds',
    'supports'
  ],
  properties: {
    apiVersion: { const: WORKBENCH_MCP_REGISTRATION_API_VERSION },
    adapterId: identifierSchema,
    clientId: identifierSchema,
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

const selectorSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['registrationId', 'clientId', 'projectRoot', 'profile'],
  properties: {
    registrationId: identifierSchema,
    clientId: identifierSchema,
    projectRoot: pathSchema,
    profile: { enum: ['workbench', 'brain'] }
  }
} as const

const requestBase = {
  apiVersion: { const: WORKBENCH_MCP_REGISTRATION_API_VERSION },
  requestId: identifierSchema
}

export const WORKBENCH_MCP_REGISTRATION_REQUEST_JSON_SCHEMA: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Workbench MCP Registration Request',
  definitions: { manifest: WORKBENCH_MCP_REGISTRATION_MANIFEST_JSON_SCHEMA },
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['apiVersion', 'requestId', 'operation', 'adapterId', 'clientId'],
      properties: {
        ...requestBase,
        operation: { const: 'inspect_capabilities' },
        adapterId: identifierSchema,
        clientId: identifierSchema
      }
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['apiVersion', 'requestId', 'operation', 'manifest'],
      properties: {
        ...requestBase,
        operation: { const: 'configure' },
        manifest: { $ref: '#/definitions/manifest' },
        dryRun: { type: 'boolean' }
      }
    },
    ...(['remove', 'status', 'audit'] as const).map(operation => ({
      type: 'object',
      additionalProperties: false,
      required: ['apiVersion', 'requestId', 'operation', 'selector'],
      properties: {
        ...requestBase,
        operation: { const: operation },
        selector: selectorSchema,
        ...(operation === 'remove' ? { dryRun: { type: 'boolean' } } : {})
      }
    }))
  ]
}

const ajv = new Ajv({ allErrors: true, strict: false })
const manifestValidator = ajv.compile(WORKBENCH_MCP_REGISTRATION_MANIFEST_JSON_SCHEMA)
const capabilitiesValidator = ajv.compile(WORKBENCH_MCP_ADAPTER_CAPABILITIES_JSON_SCHEMA)
const requestValidator = ajv.compile(WORKBENCH_MCP_REGISTRATION_REQUEST_JSON_SCHEMA)

function sameMembers<T extends string>(actual: readonly T[], expected: readonly T[]): boolean {
  return actual.length === expected.length && expected.every(value => actual.includes(value))
}

function semanticManifestErrors(manifest: WorkbenchMcpRegistrationManifest): string[] {
  const errors: string[] = []
  const absolutePaths = [
    ['server executable command', manifest.server.executable.command],
    ['server executable cwd', manifest.server.executable.cwd],
    ['target project root', manifest.target.project.root],
    ...manifest.server.credentialReferences.map(reference => [`credential reference ${reference.id}`, reference.path] as const)
  ] as const
  for (const [label, value] of absolutePaths) {
    if (!path.isAbsolute(value)) errors.push(`${label} must be an absolute path`)
  }

  const expectedTools = manifest.target.profile === 'brain'
    ? BRAIN_PROFILE_ALLOWED_TOOLS.split(',') as WorkbenchToolName[]
    : [...WORKBENCH_TOOL_NAMES]
  const expectedCommandKinds = manifest.target.profile === 'brain'
    ? BRAIN_PROFILE_ALLOWED_COMMAND_KINDS.split(',') as RunWorkbenchDirectCommandKind[]
    : [...RUN_WORKBENCH_DIRECT_COMMAND_KINDS]
  if (!sameMembers(manifest.admission.tools, expectedTools)) {
    errors.push(`${manifest.target.profile} profile tools must match the canonical admission set`)
  }
  if (!sameMembers(manifest.admission.commandKinds, expectedCommandKinds)) {
    errors.push(`${manifest.target.profile} profile command kinds must match the canonical admission set`)
  }

  const expectedAvailability = PROFILE_AVAILABILITY[manifest.target.profile]
  if (manifest.availability.startup !== expectedAvailability) {
    errors.push(`${manifest.target.profile} profile availability must be ${expectedAvailability}`)
  }
  const expectedUnavailableBehavior = manifest.target.profile === 'brain'
    ? 'continue_without_workbench'
    : 'block_startup'
  if (manifest.availability.onUnavailable !== expectedUnavailableBehavior) {
    errors.push(`${manifest.target.profile} profile unavailable behavior must be ${expectedUnavailableBehavior}`)
  }

  const credentialIds = manifest.server.credentialReferences.map(reference => reference.id)
  if (new Set(credentialIds).size !== credentialIds.length) errors.push('credential reference ids must be unique')
  return errors
}

function validationErrors(validator: ValidateFunction): string[] {
  return (validator.errors ?? []).map(error => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
}

export function validateWorkbenchMcpRegistrationManifest(value: unknown): value is WorkbenchMcpRegistrationManifest {
  if (!manifestValidator(value)) return false
  return semanticManifestErrors(value as WorkbenchMcpRegistrationManifest).length === 0
}

export function parseWorkbenchMcpRegistrationManifest(value: unknown): WorkbenchMcpRegistrationManifest {
  if (!manifestValidator(value)) {
    throw new Error(`Invalid Workbench MCP registration manifest: ${validationErrors(manifestValidator).join('; ')}`)
  }
  const manifest = value as WorkbenchMcpRegistrationManifest
  const errors = semanticManifestErrors(manifest)
  if (errors.length > 0) throw new Error(`Invalid Workbench MCP registration manifest: ${errors.join('; ')}`)
  return manifest
}

export function parseWorkbenchMcpAdapterCapabilities(value: unknown): WorkbenchMcpAdapterCapabilities {
  if (!capabilitiesValidator(value)) {
    throw new Error(`Invalid Workbench MCP adapter capabilities: ${validationErrors(capabilitiesValidator).join('; ')}`)
  }
  return value as WorkbenchMcpAdapterCapabilities
}

export function parseWorkbenchMcpRegistrationRequest(value: unknown): WorkbenchMcpRegistrationRequest {
  if (!requestValidator(value)) {
    throw new Error(`Invalid Workbench MCP registration request: ${validationErrors(requestValidator).join('; ')}`)
  }
  const request = value as WorkbenchMcpRegistrationRequest
  if (request.operation === 'configure') parseWorkbenchMcpRegistrationManifest(request.manifest)
  if ('selector' in request && !path.isAbsolute(request.selector.projectRoot)) {
    throw new Error('Invalid Workbench MCP registration request: selector projectRoot must be an absolute path')
  }
  return request
}

export type CreateWorkbenchMcpRegistrationManifestInput = {
  registrationId: string
  clientId: string
  adapterId: string
  projectRoot: string
  profile: WorkbenchMcpProfile
  command: string
  args: readonly string[]
  cwd: string
  credentialFile: string
  minimumWorkbenchVersion: string
  adapterApiVersion: string
  rollback?: {
    strategy?: WorkbenchMcpRollbackStrategy
    backupRequired?: boolean
    transactionId?: string
    backupRef?: string
    previousManifestDigest?: string
  }
}

export function createWorkbenchMcpRegistrationManifest(
  input: CreateWorkbenchMcpRegistrationManifestInput
): WorkbenchMcpRegistrationManifest {
  const brain = input.profile === 'brain'
  const manifest: WorkbenchMcpRegistrationManifest = {
    schemaVersion: WORKBENCH_MCP_REGISTRATION_SCHEMA_VERSION,
    kind: WORKBENCH_MCP_REGISTRATION_KIND,
    registrationId: input.registrationId,
    server: {
      id: 'workbench',
      transport: 'stdio',
      executable: { command: input.command, args: [...input.args], cwd: input.cwd },
      credentialReferences: [{
        id: 'workbench-action',
        kind: 'file',
        path: input.credentialFile,
        inject: { kind: 'environment', name: 'WORKBENCH_MCP_CREDENTIAL_FILE' }
      }]
    },
    target: {
      client: { id: input.clientId, adapterId: input.adapterId },
      project: { root: input.projectRoot },
      profile: input.profile
    },
    availability: {
      startup: PROFILE_AVAILABILITY[input.profile],
      onUnavailable: brain ? 'continue_without_workbench' : 'block_startup'
    },
    admission: {
      tools: brain
        ? BRAIN_PROFILE_ALLOWED_TOOLS.split(',') as WorkbenchToolName[]
        : [...WORKBENCH_TOOL_NAMES],
      commandKinds: brain
        ? BRAIN_PROFILE_ALLOWED_COMMAND_KINDS.split(',') as RunWorkbenchDirectCommandKind[]
        : [...RUN_WORKBENCH_DIRECT_COMMAND_KINDS]
    },
    compatibility: {
      registrationApiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
      minimumWorkbenchVersion: input.minimumWorkbenchVersion,
      adapterApiVersion: input.adapterApiVersion
    },
    rollback: {
      strategy: input.rollback?.strategy ?? 'restore_previous_or_remove',
      backupRequired: input.rollback?.backupRequired ?? true,
      metadata: {
        ...(input.rollback?.transactionId ? { transactionId: input.rollback.transactionId } : {}),
        ...(input.rollback?.backupRef ? { backupRef: input.rollback.backupRef } : {}),
        ...(input.rollback?.previousManifestDigest
          ? { previousManifestDigest: input.rollback.previousManifestDigest }
          : {})
      }
    }
  }
  return parseWorkbenchMcpRegistrationManifest(manifest)
}
