import { Ajv, type ValidateFunction } from 'ajv'

export const WORKBENCH_ARTIFACT_BRIDGE_CONTRACT_VERSION = '1' as const
export const WORKBENCH_ARTIFACT_BRIDGE_KIND = 'workbench.artifact.bridge' as const

export const WORKBENCH_ARTIFACT_ACCESS_VALUES = ['read_only', 'read_write'] as const
export type WorkbenchArtifactAccess = typeof WORKBENCH_ARTIFACT_ACCESS_VALUES[number]

export const WORKBENCH_ARTIFACT_STATE_VALUES = [
  'mounted', 'expired', 'released', 'missing', 'scope_denied'
] as const
export type WorkbenchArtifactState = typeof WORKBENCH_ARTIFACT_STATE_VALUES[number]

export const WORKBENCH_ARTIFACT_SOURCE_VALUES = [
  'chatgpt_file', 'local_file_picker', 'provider_backed', 'scratch'
] as const
export type WorkbenchArtifactSource = typeof WORKBENCH_ARTIFACT_SOURCE_VALUES[number]

export type WorkbenchArtifactMount = {
  kind: typeof WORKBENCH_ARTIFACT_BRIDGE_KIND
  contractVersion: typeof WORKBENCH_ARTIFACT_BRIDGE_CONTRACT_VERSION
  mountId: string
  runId: string
  sessionId?: string
  virtualPath: string
  sourcePath: string
  sourceType: WorkbenchArtifactSource
  access: WorkbenchArtifactAccess
  state: WorkbenchArtifactState
  sha256?: string
  byteSize?: number
  fileCount?: number
  mountedAt: string
  expiresAt?: string
  provenance: WorkbenchArtifactProvenance
}

export type WorkbenchArtifactProvenance = {
  originalReference?: string
  grantId: string
  mountedBy: string
  timestamp: string
}

export type WorkbenchScratchArea = {
  scratchId: string
  runId: string
  rootPath: string
  maxBytes: number
  currentBytes: number
  fileCount: number
  createdAt: string
}

export type WorkbenchArtifactReadResult =
  | { success: true; content: string; byteSize: number; sha256: string }
  | { success: false; error: 'artifact_missing' | 'artifact_not_mounted' | 'artifact_expired' | 'filesystem_scope_denied' | 'artifact_limit_exceeded'; message: string }

export type WorkbenchArtifactStatResult = {
  exists: boolean
  isFile: boolean
  isDirectory: boolean
  byteSize: number
  fileCount?: number
  sha256?: string
}

type JsonSchema = Record<string, unknown>

const boundedString = (maxLength: number): JsonSchema => ({
  type: 'string',
  minLength: 1,
  maxLength
})

export const WORKBENCH_ARTIFACT_MOUNT_JSON_SCHEMA: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Workbench Artifact Mount',
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'contractVersion', 'mountId', 'runId', 'virtualPath', 'sourcePath', 'sourceType', 'access', 'state', 'mountedAt', 'provenance'],
  properties: {
    kind: { const: WORKBENCH_ARTIFACT_BRIDGE_KIND },
    contractVersion: { const: WORKBENCH_ARTIFACT_BRIDGE_CONTRACT_VERSION },
    mountId: boundedString(128),
    runId: boundedString(128),
    sessionId: boundedString(128),
    virtualPath: boundedString(512),
    sourcePath: boundedString(1024),
    sourceType: { enum: [...WORKBENCH_ARTIFACT_SOURCE_VALUES] },
    access: { enum: [...WORKBENCH_ARTIFACT_ACCESS_VALUES] },
    state: { enum: [...WORKBENCH_ARTIFACT_STATE_VALUES] },
    sha256: boundedString(64),
    byteSize: { type: 'integer', minimum: 0 },
    fileCount: { type: 'integer', minimum: 0 },
    mountedAt: boundedString(64),
    expiresAt: boundedString(64),
    provenance: {
      type: 'object',
      additionalProperties: false,
      required: ['grantId', 'mountedBy', 'timestamp'],
      properties: {
        originalReference: boundedString(1024),
        grantId: boundedString(128),
        mountedBy: boundedString(256),
        timestamp: boundedString(64)
      }
    }
  }
}

let mountValidator: ValidateFunction | undefined

function getMountValidator(): ValidateFunction {
  if (!mountValidator) {
    const ajv = new Ajv({ strict: false, allErrors: true })
    mountValidator = ajv.compile(WORKBENCH_ARTIFACT_MOUNT_JSON_SCHEMA)
  }
  return mountValidator
}

export function validateArtifactMount(input: unknown): { valid: true; mount: WorkbenchArtifactMount } | { valid: false; errors: string[] } {
  const validate = getMountValidator()
  if (validate(input)) return { valid: true, mount: input as WorkbenchArtifactMount }
  return { valid: false, errors: (validate.errors ?? []).map(e => `${e.instancePath} ${e.message ?? ''}`.trim()) }
}

const VIRTUAL_PATH_PREFIX = '/workbench-inputs/'
const MAX_READ_BYTES = 10 * 1024 * 1024
const MAX_LIST_FILES = 1000

function hasPathTraversal(value: string): boolean {
  return value.split(/[/\\]/).includes('..')
}

function isWithinMount(virtualPath: string, mountPath: string): boolean {
  return virtualPath === mountPath || virtualPath.startsWith(`${mountPath}/`)
}

export type WorkbenchArtifactBridgeState = {
  mounts: Map<string, WorkbenchArtifactMount>
  scratches: Map<string, WorkbenchScratchArea>
}

export function createArtifactBridgeState(): WorkbenchArtifactBridgeState {
  return { mounts: new Map(), scratches: new Map() }
}

export function mountArtifact(
  state: WorkbenchArtifactBridgeState,
  mount: WorkbenchArtifactMount
): { mounted: true } | { mounted: false; reason: string } {
  if (!mount.virtualPath.startsWith(VIRTUAL_PATH_PREFIX) || hasPathTraversal(mount.virtualPath)) {
    return { mounted: false, reason: `virtual path must start with ${VIRTUAL_PATH_PREFIX}` }
  }
  if (hasPathTraversal(mount.sourcePath)) {
    return { mounted: false, reason: 'source path contains traversal' }
  }
  const validation = validateArtifactMount(mount)
  if (!validation.valid) {
    return { mounted: false, reason: `invalid mount: ${validation.errors.join(', ')}` }
  }
  state.mounts.set(mount.mountId, mount)
  return { mounted: true }
}

export function releaseArtifact(state: WorkbenchArtifactBridgeState, mountId: string): { released: true } | { released: false; reason: string } {
  const existing = state.mounts.get(mountId)
  if (!existing) return { released: false, reason: 'mount not found' }
  state.mounts.set(mountId, { ...existing, state: 'released' })
  return { released: true }
}

export function resolveVirtualPath(state: WorkbenchArtifactBridgeState, virtualPath: string, nowIso: string): WorkbenchArtifactReadResult {
  if (!virtualPath.startsWith(VIRTUAL_PATH_PREFIX) || hasPathTraversal(virtualPath)) {
    return { success: false, error: 'filesystem_scope_denied', message: 'path outside artifact namespace' }
  }

  for (const mount of state.mounts.values()) {
    if (isWithinMount(virtualPath, mount.virtualPath)) {
      if (mount.state !== 'mounted') {
        return { success: false, error: 'artifact_not_mounted', message: `artifact state is ${mount.state}` }
      }
      if (mount.expiresAt && new Date(mount.expiresAt).getTime() <= new Date(nowIso).getTime()) {
        return { success: false, error: 'artifact_expired', message: 'artifact mount has expired' }
      }
      if (mount.byteSize && mount.byteSize > MAX_READ_BYTES) {
        return { success: false, error: 'artifact_limit_exceeded', message: `artifact exceeds ${MAX_READ_BYTES} byte limit` }
      }
      return { success: true, content: '', byteSize: 0, sha256: mount.sha256 ?? '' }
    }
  }
  return { success: false, error: 'artifact_missing', message: 'no mount matches the requested path' }
}

export function listMountsForRun(state: WorkbenchArtifactBridgeState, runId: string): WorkbenchArtifactMount[] {
  return [...state.mounts.values()].filter(m => m.runId === runId && m.state === 'mounted')
}

export function createScratchArea(state: WorkbenchArtifactBridgeState, scratch: WorkbenchScratchArea): { created: true } | { created: false; reason: string } {
  if (hasPathTraversal(scratch.rootPath)) return { created: false, reason: 'scratch path contains traversal' }
  state.scratches.set(scratch.scratchId, scratch)
  return { created: true }
}

export { MAX_READ_BYTES, MAX_LIST_FILES, VIRTUAL_PATH_PREFIX }
