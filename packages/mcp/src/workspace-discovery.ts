import { Ajv, type ValidateFunction } from 'ajv'

export const WORKBENCH_WORKSPACE_CONTRACT_VERSION = '1' as const
export const WORKBENCH_WORKSPACE_KIND = 'workbench.workspace.discovery' as const

export const WORKBENCH_WORKSPACE_TYPE_VALUES = [
  'git_repository', 'git_worktree', 'ordinary_folder', 'knowledge_folder'
] as const

export const WORKBENCH_WORKSPACE_STATE_VALUES = [
  'active', 'discovered', 'removed', 'unavailable'
] as const

export type WorkbenchWorkspaceType = typeof WORKBENCH_WORKSPACE_TYPE_VALUES[number]
export type WorkbenchWorkspaceState = typeof WORKBENCH_WORKSPACE_STATE_VALUES[number]

export type WorkbenchWorkspaceIdentity = {
  workspaceId: string
  displayName: string
  workspaceType: WorkbenchWorkspaceType
  rootPath: string
  discoveredAt: string
}

export type WorkbenchGitContext = {
  branch: string
  remoteUrl?: string
  headCommit?: string
  worktreeRoot?: string
  parentRepositoryId?: string
}

export type WorkbenchDiscoveryRoot = {
  rootId: string
  path: string
  recursive: boolean
  maxDepth: number
  enabled: boolean
}

export type WorkbenchWorkspaceEntry = {
  kind: typeof WORKBENCH_WORKSPACE_KIND
  contractVersion: typeof WORKBENCH_WORKSPACE_CONTRACT_VERSION
  identity: WorkbenchWorkspaceIdentity
  state: WorkbenchWorkspaceState
  gitContext?: WorkbenchGitContext
  discoveryRootId?: string
  lastSeenAt: string
}

export type WorkbenchDiscoveryConfig = {
  roots: WorkbenchDiscoveryRoot[]
  reconciliationIntervalMs: number
  maxWorkspaces: number
  ignorePatterns: string[]
}

export type WorkbenchWorkspaceSelectionResult =
  | { selected: true; workspace: WorkbenchWorkspaceEntry }
  | { selected: false; reason: string }

type JsonSchema = Record<string, unknown>

const boundedString = (maxLength: number): JsonSchema => ({
  type: 'string',
  minLength: 1,
  maxLength
})

export const WORKBENCH_WORKSPACE_JSON_SCHEMA: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Workbench Workspace Entry',
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'contractVersion', 'identity', 'state', 'lastSeenAt'],
  properties: {
    kind: { const: WORKBENCH_WORKSPACE_KIND },
    contractVersion: { const: WORKBENCH_WORKSPACE_CONTRACT_VERSION },
    identity: {
      type: 'object',
      additionalProperties: false,
      required: ['workspaceId', 'displayName', 'workspaceType', 'rootPath', 'discoveredAt'],
      properties: {
        workspaceId: boundedString(128),
        displayName: boundedString(256),
        workspaceType: { enum: [...WORKBENCH_WORKSPACE_TYPE_VALUES] },
        rootPath: boundedString(1024),
        discoveredAt: boundedString(64)
      }
    },
    state: { enum: [...WORKBENCH_WORKSPACE_STATE_VALUES] },
    gitContext: {
      type: 'object',
      additionalProperties: false,
      required: ['branch'],
      properties: {
        branch: boundedString(256),
        remoteUrl: boundedString(1024),
        headCommit: boundedString(64),
        worktreeRoot: boundedString(1024),
        parentRepositoryId: boundedString(128)
      }
    },
    discoveryRootId: boundedString(128),
    lastSeenAt: boundedString(64)
  }
}

export const WORKBENCH_DISCOVERY_ROOT_JSON_SCHEMA: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Workbench Discovery Root',
  type: 'object',
  additionalProperties: false,
  required: ['rootId', 'path', 'recursive', 'maxDepth', 'enabled'],
  properties: {
    rootId: boundedString(128),
    path: boundedString(1024),
    recursive: { type: 'boolean' },
    maxDepth: { type: 'integer', minimum: 1, maximum: 10 },
    enabled: { type: 'boolean' }
  }
}

let workspaceValidator: ValidateFunction | undefined
let discoveryRootValidator: ValidateFunction | undefined

function getWorkspaceValidator(): ValidateFunction {
  if (!workspaceValidator) {
    const ajv = new Ajv({ strict: false, allErrors: true })
    workspaceValidator = ajv.compile(WORKBENCH_WORKSPACE_JSON_SCHEMA)
  }
  return workspaceValidator
}

function getDiscoveryRootValidator(): ValidateFunction {
  if (!discoveryRootValidator) {
    const ajv = new Ajv({ strict: false, allErrors: true })
    discoveryRootValidator = ajv.compile(WORKBENCH_DISCOVERY_ROOT_JSON_SCHEMA)
  }
  return discoveryRootValidator
}

export function validateWorkspaceEntry(input: unknown): { valid: true; entry: WorkbenchWorkspaceEntry } | { valid: false; errors: string[] } {
  const validate = getWorkspaceValidator()
  if (validate(input)) {
    return { valid: true, entry: input as WorkbenchWorkspaceEntry }
  }
  return { valid: false, errors: (validate.errors ?? []).map(e => `${e.instancePath} ${e.message ?? ''}`.trim()) }
}

export function validateDiscoveryRoot(input: unknown): { valid: true; root: WorkbenchDiscoveryRoot } | { valid: false; errors: string[] } {
  const validate = getDiscoveryRootValidator()
  if (validate(input)) {
    return { valid: true, root: input as WorkbenchDiscoveryRoot }
  }
  return { valid: false, errors: (validate.errors ?? []).map(e => `${e.instancePath} ${e.message ?? ''}`.trim()) }
}

export function isPathTraversal(path: string): boolean {
  const segments = path.split(/[/\\]/)
  return segments.includes('..') || path.startsWith('/') === false && segments[0] === '~'
}

export function selectWorkspace(entry: WorkbenchWorkspaceEntry): WorkbenchWorkspaceSelectionResult {
  if (entry.state === 'removed') return { selected: false, reason: 'workspace has been removed' }
  if (entry.state === 'unavailable') return { selected: false, reason: 'workspace is unavailable' }
  if (isPathTraversal(entry.identity.rootPath)) return { selected: false, reason: 'workspace path contains traversal' }
  return { selected: true, workspace: entry }
}

export type WorkbenchDiscoveryState = {
  config: WorkbenchDiscoveryConfig
  workspaces: Map<string, WorkbenchWorkspaceEntry>
  lastReconciliationAt: string | null
}

export function createDiscoveryState(config: WorkbenchDiscoveryConfig): WorkbenchDiscoveryState {
  return { config, workspaces: new Map(), lastReconciliationAt: null }
}

export function registerWorkspace(state: WorkbenchDiscoveryState, entry: WorkbenchWorkspaceEntry): { registered: true } | { registered: false; reason: string } {
  const existing = state.workspaces.get(entry.identity?.workspaceId)
  if (!existing && state.workspaces.size >= state.config.maxWorkspaces) {
    return { registered: false, reason: `workspace limit reached (${state.config.maxWorkspaces})` }
  }
  const validation = validateWorkspaceEntry(entry)
  if (!validation.valid) {
    return { registered: false, reason: `invalid workspace entry: ${validation.errors.join(', ')}` }
  }
  const selection = selectWorkspace(entry)
  if (!selection.selected) return { registered: false, reason: selection.reason }
  state.workspaces.set(entry.identity.workspaceId, entry)
  return { registered: true }
}

export function removeWorkspace(state: WorkbenchDiscoveryState, workspaceId: string): { removed: true } | { removed: false; reason: string } {
  const existing = state.workspaces.get(workspaceId)
  if (!existing) return { removed: false, reason: 'workspace not found' }
  const removed: WorkbenchWorkspaceEntry = { ...existing, state: 'removed' }
  state.workspaces.set(workspaceId, removed)
  return { removed: true }
}

export function listWorkspaces(state: WorkbenchDiscoveryState): WorkbenchWorkspaceEntry[] {
  return [...state.workspaces.values()].filter(w => w.state !== 'removed')
}

export function reconcileWorkspaces(state: WorkbenchDiscoveryState, discoveredPaths: string[], now: string): { added: number; marked_unavailable: number } {
  let added = 0
  let marked_unavailable = 0

  const discoveredSet = new Set(discoveredPaths)
  for (const [id, ws] of state.workspaces) {
    if (ws.state === 'active' && !discoveredSet.has(ws.identity.rootPath)) {
      state.workspaces.set(id, { ...ws, state: 'unavailable', lastSeenAt: now })
      marked_unavailable++
    }
  }

  const existingPaths = new Set([...state.workspaces.values()].map(w => w.identity.rootPath))
  for (const path of discoveredPaths) {
    if (!existingPaths.has(path) && state.workspaces.size < state.config.maxWorkspaces) {
      const id = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const entry: WorkbenchWorkspaceEntry = {
        kind: WORKBENCH_WORKSPACE_KIND,
        contractVersion: WORKBENCH_WORKSPACE_CONTRACT_VERSION,
        identity: {
          workspaceId: id,
          displayName: path.split('/').pop() ?? path,
          workspaceType: 'ordinary_folder',
          rootPath: path,
          discoveredAt: now
        },
        state: 'discovered',
        lastSeenAt: now
      }
      state.workspaces.set(id, entry)
      added++
    }
  }

  state.lastReconciliationAt = now
  return { added, marked_unavailable }
}
