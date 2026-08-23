import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateArtifactMount,
  createArtifactBridgeState,
  mountArtifact,
  releaseArtifact,
  resolveVirtualPath,
  listMountsForRun,
  createScratchArea,
  WORKBENCH_ARTIFACT_BRIDGE_KIND,
  WORKBENCH_ARTIFACT_BRIDGE_CONTRACT_VERSION,
  VIRTUAL_PATH_PREFIX,
  type WorkbenchArtifactMount
} from '../artifact-bridge.js'

function makeMount(overrides: Partial<WorkbenchArtifactMount> = {}): WorkbenchArtifactMount {
  return {
    kind: WORKBENCH_ARTIFACT_BRIDGE_KIND,
    contractVersion: WORKBENCH_ARTIFACT_BRIDGE_CONTRACT_VERSION,
    mountId: 'mount-1',
    runId: 'run-1',
    virtualPath: `${VIRTUAL_PATH_PREFIX}artifact-1`,
    sourcePath: '/Users/test/file.txt',
    sourceType: 'local_file_picker',
    access: 'read_only',
    state: 'mounted',
    mountedAt: '2026-08-21T00:00:00Z',
    provenance: {
      grantId: 'grant-1',
      mountedBy: 'test',
      timestamp: '2026-08-21T00:00:00Z'
    },
    ...overrides
  }
}

describe('artifact-bridge', () => {
  describe('validateArtifactMount', () => {
    it('accepts a valid mount', () => {
      const result = validateArtifactMount(makeMount())
      assert.equal(result.valid, true)
    })

    it('rejects missing required fields', () => {
      const result = validateArtifactMount({ kind: WORKBENCH_ARTIFACT_BRIDGE_KIND })
      assert.equal(result.valid, false)
    })

    it('rejects invalid access type', () => {
      const result = validateArtifactMount(makeMount({ access: 'execute' as never }))
      assert.equal(result.valid, false)
    })
  })

  describe('mountArtifact', () => {
    it('mounts a valid artifact', () => {
      const state = createArtifactBridgeState()
      const result = mountArtifact(state, makeMount())
      assert.equal(result.mounted, true)
    })

    it('rejects virtual path outside namespace', () => {
      const state = createArtifactBridgeState()
      const result = mountArtifact(state, makeMount({ virtualPath: '/other/path' }))
      assert.equal(result.mounted, false)
    })

    it('rejects source path with traversal', () => {
      const state = createArtifactBridgeState()
      const result = mountArtifact(state, makeMount({ sourcePath: '/Users/../etc/passwd' }))
      assert.equal(result.mounted, false)
    })

    it('rejects virtual path traversal', () => {
      const state = createArtifactBridgeState()
      const result = mountArtifact(state, makeMount({ virtualPath: `${VIRTUAL_PATH_PREFIX}artifact-1/../outside` }))
      assert.equal(result.mounted, false)
    })
  })

  describe('releaseArtifact', () => {
    it('releases a mounted artifact', () => {
      const state = createArtifactBridgeState()
      mountArtifact(state, makeMount())
      const result = releaseArtifact(state, 'mount-1')
      assert.equal(result.released, true)
      assert.equal(state.mounts.get('mount-1')?.state, 'released')
    })

    it('returns error releasing nonexistent mount', () => {
      const state = createArtifactBridgeState()
      const result = releaseArtifact(state, 'missing')
      assert.equal(result.released, false)
    })
  })

  describe('resolveVirtualPath', () => {
    it('resolves mounted artifact path', () => {
      const state = createArtifactBridgeState()
      mountArtifact(state, makeMount())
      const result = resolveVirtualPath(state, `${VIRTUAL_PATH_PREFIX}artifact-1/file.txt`, '2026-08-21T10:00:00Z')
      assert.equal(result.success, true)
    })

    it('rejects path outside namespace', () => {
      const state = createArtifactBridgeState()
      const result = resolveVirtualPath(state, '/outside/namespace', '2026-08-21T10:00:00Z')
      assert.equal(result.success, false)
      assert.equal('error' in result && result.error, 'filesystem_scope_denied')
    })

    it('returns artifact_missing for no match', () => {
      const state = createArtifactBridgeState()
      const result = resolveVirtualPath(state, `${VIRTUAL_PATH_PREFIX}nonexistent`, '2026-08-21T10:00:00Z')
      assert.equal(result.success, false)
      assert.equal('error' in result && result.error, 'artifact_missing')
    })

    it('does not match a sibling mount by string prefix', () => {
      const state = createArtifactBridgeState()
      mountArtifact(state, makeMount())
      const result = resolveVirtualPath(state, `${VIRTUAL_PATH_PREFIX}artifact-10/file.txt`, '2026-08-21T10:00:00Z')
      assert.equal(result.success, false)
      assert.equal('error' in result && result.error, 'artifact_missing')
    })

    it('rejects traversal in a resolved virtual path', () => {
      const state = createArtifactBridgeState()
      mountArtifact(state, makeMount())
      const result = resolveVirtualPath(state, `${VIRTUAL_PATH_PREFIX}artifact-1/../secret`, '2026-08-21T10:00:00Z')
      assert.equal(result.success, false)
      assert.equal('error' in result && result.error, 'filesystem_scope_denied')
    })

    it('returns artifact_not_mounted for released artifact', () => {
      const state = createArtifactBridgeState()
      mountArtifact(state, makeMount())
      releaseArtifact(state, 'mount-1')
      const result = resolveVirtualPath(state, `${VIRTUAL_PATH_PREFIX}artifact-1`, '2026-08-21T10:00:00Z')
      assert.equal(result.success, false)
      assert.equal('error' in result && result.error, 'artifact_not_mounted')
    })

    it('returns artifact_expired for expired artifact', () => {
      const state = createArtifactBridgeState()
      mountArtifact(state, makeMount({ expiresAt: '2026-08-21T09:00:00Z' }))
      const result = resolveVirtualPath(state, `${VIRTUAL_PATH_PREFIX}artifact-1`, '2026-08-21T10:00:00Z')
      assert.equal(result.success, false)
      assert.equal('error' in result && result.error, 'artifact_expired')
    })
  })

  describe('listMountsForRun', () => {
    it('lists only mounted artifacts for the run', () => {
      const state = createArtifactBridgeState()
      mountArtifact(state, makeMount({ mountId: 'mount-a', runId: 'run-1' }))
      mountArtifact(state, makeMount({ mountId: 'mount-b', runId: 'run-2', virtualPath: `${VIRTUAL_PATH_PREFIX}b` }))
      const mounts = listMountsForRun(state, 'run-1')
      assert.equal(mounts.length, 1)
      assert.equal(mounts[0].mountId, 'mount-a')
    })
  })

  describe('createScratchArea', () => {
    it('creates a scratch area', () => {
      const state = createArtifactBridgeState()
      const result = createScratchArea(state, {
        scratchId: 'scratch-1',
        runId: 'run-1',
        rootPath: '/tmp/workbench-scratch/run-1',
        maxBytes: 100 * 1024 * 1024,
        currentBytes: 0,
        fileCount: 0,
        createdAt: '2026-08-21T00:00:00Z'
      })
      assert.equal(result.created, true)
    })

    it('rejects traversal in scratch path', () => {
      const state = createArtifactBridgeState()
      const result = createScratchArea(state, {
        scratchId: 'scratch-bad',
        runId: 'run-1',
        rootPath: '/tmp/../etc/scratch',
        maxBytes: 1024,
        currentBytes: 0,
        fileCount: 0,
        createdAt: '2026-08-21T00:00:00Z'
      })
      assert.equal(result.created, false)
    })
  })
})
