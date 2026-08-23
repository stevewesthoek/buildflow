import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateWorkspaceEntry,
  validateDiscoveryRoot,
  selectWorkspace,
  createDiscoveryState,
  registerWorkspace,
  removeWorkspace,
  listWorkspaces,
  reconcileWorkspaces,
  isPathTraversal,
  WORKBENCH_WORKSPACE_KIND,
  WORKBENCH_WORKSPACE_CONTRACT_VERSION,
  type WorkbenchWorkspaceEntry,
  type WorkbenchDiscoveryConfig
} from '../workspace-discovery.js'

function makeEntry(overrides: Partial<WorkbenchWorkspaceEntry> = {}): WorkbenchWorkspaceEntry {
  return {
    kind: WORKBENCH_WORKSPACE_KIND,
    contractVersion: WORKBENCH_WORKSPACE_CONTRACT_VERSION,
    identity: {
      workspaceId: 'ws-test',
      displayName: 'Test Workspace',
      workspaceType: 'git_repository',
      rootPath: '/Users/test/repo',
      discoveredAt: '2026-08-21T00:00:00Z'
    },
    state: 'active',
    lastSeenAt: '2026-08-21T00:00:00Z',
    ...overrides
  }
}

const defaultConfig: WorkbenchDiscoveryConfig = {
  roots: [],
  reconciliationIntervalMs: 60000,
  maxWorkspaces: 100,
  ignorePatterns: ['node_modules', '.git']
}

describe('workspace-discovery', () => {
  describe('validateWorkspaceEntry', () => {
    it('accepts a valid workspace entry', () => {
      const entry = makeEntry()
      const result = validateWorkspaceEntry(entry)
      assert.equal(result.valid, true)
    })

    it('rejects an entry missing required fields', () => {
      const result = validateWorkspaceEntry({ kind: WORKBENCH_WORKSPACE_KIND })
      assert.equal(result.valid, false)
    })

    it('rejects an entry with unknown state', () => {
      const entry = makeEntry({ state: 'unknown_state' as never })
      const result = validateWorkspaceEntry(entry)
      assert.equal(result.valid, false)
    })

    it('rejects an entry with wrong kind', () => {
      const entry = makeEntry({ kind: 'wrong.kind' as never })
      const result = validateWorkspaceEntry(entry)
      assert.equal(result.valid, false)
    })
  })

  describe('validateDiscoveryRoot', () => {
    it('accepts a valid discovery root', () => {
      const result = validateDiscoveryRoot({ rootId: 'root-1', path: '/Users/test', recursive: true, maxDepth: 3, enabled: true })
      assert.equal(result.valid, true)
    })

    it('rejects maxDepth > 10', () => {
      const result = validateDiscoveryRoot({ rootId: 'root-1', path: '/Users/test', recursive: true, maxDepth: 15, enabled: true })
      assert.equal(result.valid, false)
    })
  })

  describe('selectWorkspace', () => {
    it('selects an active workspace', () => {
      const entry = makeEntry({ state: 'active' })
      const result = selectWorkspace(entry)
      assert.equal(result.selected, true)
    })

    it('rejects a removed workspace', () => {
      const entry = makeEntry({ state: 'removed' })
      const result = selectWorkspace(entry)
      assert.equal(result.selected, false)
      assert.equal('reason' in result && result.reason, 'workspace has been removed')
    })

    it('rejects an unavailable workspace', () => {
      const entry = makeEntry({ state: 'unavailable' })
      const result = selectWorkspace(entry)
      assert.equal(result.selected, false)
    })

    it('rejects path traversal', () => {
      const entry = makeEntry({
        identity: { ...makeEntry().identity, rootPath: '/Users/../etc/passwd' }
      })
      const result = selectWorkspace(entry)
      assert.equal(result.selected, false)
    })
  })

  describe('isPathTraversal', () => {
    it('detects .. traversal', () => {
      assert.equal(isPathTraversal('/a/../b'), true)
    })

    it('accepts clean absolute paths', () => {
      assert.equal(isPathTraversal('/Users/test/repo'), false)
    })
  })

  describe('registry operations', () => {
    it('registers and lists workspaces', () => {
      const state = createDiscoveryState(defaultConfig)
      const entry = makeEntry()
      const result = registerWorkspace(state, entry)
      assert.equal(result.registered, true)
      const list = listWorkspaces(state)
      assert.equal(list.length, 1)
    })

    it('enforces maxWorkspaces limit', () => {
      const state = createDiscoveryState({ ...defaultConfig, maxWorkspaces: 2 })
      registerWorkspace(state, makeEntry({ identity: { ...makeEntry().identity, workspaceId: 'ws-1' } }))
      registerWorkspace(state, makeEntry({ identity: { ...makeEntry().identity, workspaceId: 'ws-2' } }))
      const result = registerWorkspace(state, makeEntry({ identity: { ...makeEntry().identity, workspaceId: 'ws-3' } }))
      assert.equal(result.registered, false)
    })

    it('rejects traversal at registration time', () => {
      const state = createDiscoveryState(defaultConfig)
      const result = registerWorkspace(state, makeEntry({
        identity: { ...makeEntry().identity, rootPath: '/Users/../etc' }
      }))
      assert.equal(result.registered, false)
    })

    it('allows an existing workspace to be updated at the limit', () => {
      const state = createDiscoveryState({ ...defaultConfig, maxWorkspaces: 1 })
      const entry = makeEntry()
      assert.equal(registerWorkspace(state, entry).registered, true)
      const result = registerWorkspace(state, { ...entry, identity: { ...entry.identity, displayName: 'Updated' } })
      assert.equal(result.registered, true)
      assert.equal(state.workspaces.get(entry.identity.workspaceId)?.identity.displayName, 'Updated')
    })

    it('removes a workspace (marks as removed)', () => {
      const state = createDiscoveryState(defaultConfig)
      const entry = makeEntry()
      registerWorkspace(state, entry)
      removeWorkspace(state, entry.identity.workspaceId)
      const list = listWorkspaces(state)
      assert.equal(list.length, 0)
    })

    it('returns error removing nonexistent workspace', () => {
      const state = createDiscoveryState(defaultConfig)
      const result = removeWorkspace(state, 'nonexistent')
      assert.equal(result.removed, false)
    })
  })

  describe('reconcileWorkspaces', () => {
    it('marks missing active workspaces as unavailable', () => {
      const state = createDiscoveryState(defaultConfig)
      const entry = makeEntry({ identity: { ...makeEntry().identity, workspaceId: 'ws-gone', rootPath: '/gone' } })
      registerWorkspace(state, entry)
      const { marked_unavailable } = reconcileWorkspaces(state, ['/different'], '2026-08-21T01:00:00Z')
      assert.equal(marked_unavailable, 1)
    })

    it('updates lastReconciliationAt', () => {
      const state = createDiscoveryState(defaultConfig)
      reconcileWorkspaces(state, [], '2026-08-21T01:00:00Z')
      assert.equal(state.lastReconciliationAt, '2026-08-21T01:00:00Z')
    })
  })
})
