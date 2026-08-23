import { Ajv, type ValidateFunction } from 'ajv'

export const WORKBENCH_GRANT_CONTRACT_VERSION = '1' as const
export const WORKBENCH_GRANT_KIND = 'workbench.workspace.grant' as const

export const WORKBENCH_AUTONOMY_LEVEL_VALUES = [0, 1, 2, 3, 4, 5, 6] as const
export type WorkbenchAutonomyLevel = typeof WORKBENCH_AUTONOMY_LEVEL_VALUES[number]

export const WORKBENCH_GRANT_SCOPE_VALUES = [
  'read', 'write', 'command', 'git', 'network', 'capability', 'release'
] as const
export type WorkbenchGrantScope = typeof WORKBENCH_GRANT_SCOPE_VALUES[number]

export const WORKBENCH_GRANT_STATE_VALUES = [
  'active', 'expired', 'revoked', 'denied'
] as const
export type WorkbenchGrantState = typeof WORKBENCH_GRANT_STATE_VALUES[number]

export type WorkbenchGrantIdentity = {
  grantId: string
  workspaceId: string
  runId?: string
  sessionId?: string
}

export type WorkbenchGrantBoundary = {
  allowedPaths: string[]
  protectedPaths: string[]
  allowedCommands?: string[]
  maxDepth?: number
}

export type WorkbenchGrantExpiry = {
  expiresAt: string
  warningThresholdMs: number
}

export type WorkbenchGrant = {
  kind: typeof WORKBENCH_GRANT_KIND
  contractVersion: typeof WORKBENCH_GRANT_CONTRACT_VERSION
  identity: WorkbenchGrantIdentity
  level: WorkbenchAutonomyLevel
  scopes: WorkbenchGrantScope[]
  state: WorkbenchGrantState
  boundary: WorkbenchGrantBoundary
  expiry?: WorkbenchGrantExpiry
  grantedAt: string
  grantedBy: string
  auditReason: string
}

export type WorkbenchGrantEvaluation =
  | { permitted: true; effectiveScopes: WorkbenchGrantScope[] }
  | { permitted: false; reason: string }

function hasPathTraversal(value: string): boolean {
  return value.split(/[/\\]/).includes('..')
}

type JsonSchema = Record<string, unknown>

const boundedString = (maxLength: number): JsonSchema => ({
  type: 'string',
  minLength: 1,
  maxLength
})

export const WORKBENCH_GRANT_JSON_SCHEMA: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Workbench Workspace Grant',
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'contractVersion', 'identity', 'level', 'scopes', 'state', 'boundary', 'grantedAt', 'grantedBy', 'auditReason'],
  properties: {
    kind: { const: WORKBENCH_GRANT_KIND },
    contractVersion: { const: WORKBENCH_GRANT_CONTRACT_VERSION },
    identity: {
      type: 'object',
      additionalProperties: false,
      required: ['grantId', 'workspaceId'],
      properties: {
        grantId: boundedString(128),
        workspaceId: boundedString(128),
        runId: boundedString(128),
        sessionId: boundedString(128)
      }
    },
    level: { enum: [...WORKBENCH_AUTONOMY_LEVEL_VALUES] },
    scopes: {
      type: 'array',
      items: { enum: [...WORKBENCH_GRANT_SCOPE_VALUES] },
      minItems: 1,
      maxItems: 7,
      uniqueItems: true
    },
    state: { enum: [...WORKBENCH_GRANT_STATE_VALUES] },
    boundary: {
      type: 'object',
      additionalProperties: false,
      required: ['allowedPaths', 'protectedPaths'],
      properties: {
        allowedPaths: { type: 'array', items: boundedString(1024), maxItems: 100 },
        protectedPaths: { type: 'array', items: boundedString(1024), maxItems: 100 },
        allowedCommands: { type: 'array', items: boundedString(256), maxItems: 50 },
        maxDepth: { type: 'integer', minimum: 1, maximum: 20 }
      }
    },
    expiry: {
      type: 'object',
      additionalProperties: false,
      required: ['expiresAt', 'warningThresholdMs'],
      properties: {
        expiresAt: boundedString(64),
        warningThresholdMs: { type: 'integer', minimum: 0, maximum: 86400000 }
      }
    },
    grantedAt: boundedString(64),
    grantedBy: boundedString(256),
    auditReason: boundedString(512)
  }
}

let grantValidator: ValidateFunction | undefined

function getGrantValidator(): ValidateFunction {
  if (!grantValidator) {
    const ajv = new Ajv({ strict: false, allErrors: true })
    grantValidator = ajv.compile(WORKBENCH_GRANT_JSON_SCHEMA)
  }
  return grantValidator
}

export function validateGrant(input: unknown): { valid: true; grant: WorkbenchGrant } | { valid: false; errors: string[] } {
  const validate = getGrantValidator()
  if (validate(input)) return { valid: true, grant: input as WorkbenchGrant }
  return { valid: false, errors: (validate.errors ?? []).map(e => `${e.instancePath} ${e.message ?? ''}`.trim()) }
}

export function evaluateGrant(grant: WorkbenchGrant, requestedScope: WorkbenchGrantScope, path: string, nowIso: string): WorkbenchGrantEvaluation {
  if (grant.state !== 'active') return { permitted: false, reason: `grant is ${grant.state}` }

  if (hasPathTraversal(path)) return { permitted: false, reason: 'path contains traversal' }

  if (grant.expiry) {
    const expiresAt = new Date(grant.expiry.expiresAt).getTime()
    const now = new Date(nowIso).getTime()
    if (now >= expiresAt) return { permitted: false, reason: 'grant has expired' }
  }

  if (!grant.scopes.includes(requestedScope)) {
    return { permitted: false, reason: `scope '${requestedScope}' not included in grant` }
  }

  for (const protectedPath of grant.boundary.protectedPaths) {
    if (path === protectedPath || path.startsWith(protectedPath + '/')) {
      return { permitted: false, reason: `path is protected: ${protectedPath}` }
    }
  }

  if (grant.boundary.allowedPaths.length > 0) {
    const allowed = grant.boundary.allowedPaths.some(
      allowedPath => path === allowedPath || path.startsWith(allowedPath + '/')
    )
    if (!allowed) return { permitted: false, reason: 'path not within allowed boundaries' }
  }

  return { permitted: true, effectiveScopes: grant.scopes }
}

export type WorkbenchGrantStore = {
  grants: Map<string, WorkbenchGrant>
}

export function createGrantStore(): WorkbenchGrantStore {
  return { grants: new Map() }
}

export function issueGrant(store: WorkbenchGrantStore, grant: WorkbenchGrant): { issued: true } | { issued: false; reason: string } {
  const validation = validateGrant(grant)
  if (!validation.valid) return { issued: false, reason: `invalid grant: ${validation.errors.join(', ')}` }
  store.grants.set(grant.identity.grantId, grant)
  return { issued: true }
}

export function revokeGrant(store: WorkbenchGrantStore, grantId: string): { revoked: true } | { revoked: false; reason: string } {
  const existing = store.grants.get(grantId)
  if (!existing) return { revoked: false, reason: 'grant not found' }
  if (existing.state !== 'active') return { revoked: false, reason: `grant already ${existing.state}` }
  store.grants.set(grantId, { ...existing, state: 'revoked' })
  return { revoked: true }
}

export function findApplicableGrant(store: WorkbenchGrantStore, workspaceId: string, scope: WorkbenchGrantScope, path: string, nowIso: string): WorkbenchGrantEvaluation {
  for (const grant of store.grants.values()) {
    if (grant.identity.workspaceId !== workspaceId) continue
    const result = evaluateGrant(grant, scope, path, nowIso)
    if (result.permitted) return result
  }
  return { permitted: false, reason: 'no applicable active grant found' }
}
