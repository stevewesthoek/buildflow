import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateGrant,
  evaluateGrant,
  createGrantStore,
  issueGrant,
  revokeGrant,
  findApplicableGrant,
  WORKBENCH_GRANT_KIND,
  WORKBENCH_GRANT_CONTRACT_VERSION,
  type WorkbenchGrant
} from '../workspace-grants.js'

function makeGrant(overrides: Partial<WorkbenchGrant> = {}): WorkbenchGrant {
  return {
    kind: WORKBENCH_GRANT_KIND,
    contractVersion: WORKBENCH_GRANT_CONTRACT_VERSION,
    identity: {
      grantId: 'grant-1',
      workspaceId: 'ws-1'
    },
    level: 3,
    scopes: ['read', 'write'],
    state: 'active',
    boundary: {
      allowedPaths: ['/Users/test/repo'],
      protectedPaths: []
    },
    grantedAt: '2026-08-21T00:00:00Z',
    grantedBy: 'test',
    auditReason: 'unit test',
    ...overrides
  }
}

describe('workspace-grants', () => {
  describe('validateGrant', () => {
    it('accepts a valid grant', () => {
      const result = validateGrant(makeGrant())
      assert.equal(result.valid, true)
    })

    it('rejects missing required fields', () => {
      const result = validateGrant({ kind: WORKBENCH_GRANT_KIND })
      assert.equal(result.valid, false)
    })

    it('rejects invalid level', () => {
      const result = validateGrant(makeGrant({ level: 10 as never }))
      assert.equal(result.valid, false)
    })

    it('rejects empty scopes array', () => {
      const result = validateGrant(makeGrant({ scopes: [] }))
      assert.equal(result.valid, false)
    })
  })

  describe('evaluateGrant', () => {
    it('permits active grant with matching scope in allowed path', () => {
      const grant = makeGrant()
      const result = evaluateGrant(grant, 'read', '/Users/test/repo/file.ts', '2026-08-21T10:00:00Z')
      assert.equal(result.permitted, true)
    })

    it('denies revoked grant', () => {
      const grant = makeGrant({ state: 'revoked' })
      const result = evaluateGrant(grant, 'read', '/any', '2026-08-21T10:00:00Z')
      assert.equal(result.permitted, false)
    })

    it('denies expired grant', () => {
      const grant = makeGrant({
        expiry: { expiresAt: '2026-08-21T09:00:00Z', warningThresholdMs: 60000 }
      })
      const result = evaluateGrant(grant, 'read', '/any', '2026-08-21T10:00:00Z')
      assert.equal(result.permitted, false)
      assert.ok('reason' in result && result.reason.includes('expired'))
    })

    it('denies scope not in grant', () => {
      const grant = makeGrant({ scopes: ['read'] })
      const result = evaluateGrant(grant, 'write', '/Users/test/repo/file.ts', '2026-08-21T10:00:00Z')
      assert.equal(result.permitted, false)
    })

    it('denies access to protected path', () => {
      const grant = makeGrant({
        boundary: { allowedPaths: ['/Users/test'], protectedPaths: ['/Users/test/secrets'] }
      })
      const result = evaluateGrant(grant, 'read', '/Users/test/secrets/key.pem', '2026-08-21T10:00:00Z')
      assert.equal(result.permitted, false)
    })

    it('denies path outside allowed boundary', () => {
      const grant = makeGrant({ boundary: { allowedPaths: ['/Users/test/repo'], protectedPaths: [] } })
      const result = evaluateGrant(grant, 'read', '/Users/test/other', '2026-08-21T10:00:00Z')
      assert.equal(result.permitted, false)
    })

    it('permits any path when allowedPaths is empty', () => {
      const grant = makeGrant({ boundary: { allowedPaths: [], protectedPaths: [] } })
      const result = evaluateGrant(grant, 'write', '/any/path', '2026-08-21T10:00:00Z')
      assert.equal(result.permitted, true)
    })

    it('rejects traversal even when the lexical prefix is allowed', () => {
      const grant = makeGrant()
      const result = evaluateGrant(grant, 'read', '/Users/test/repo/../secrets/key.pem', '2026-08-21T10:00:00Z')
      assert.equal(result.permitted, false)
      assert.ok('reason' in result && result.reason.includes('traversal'))
    })
  })

  describe('grant store', () => {
    it('issues and finds an active grant', () => {
      const store = createGrantStore()
      const grant = makeGrant()
      assert.equal(issueGrant(store, grant).issued, true)
      const result = findApplicableGrant(store, 'ws-1', 'read', '/Users/test/repo/x', '2026-08-21T10:00:00Z')
      assert.equal(result.permitted, true)
    })

    it('revokes a grant', () => {
      const store = createGrantStore()
      const grant = makeGrant()
      issueGrant(store, grant)
      assert.equal(revokeGrant(store, 'grant-1').revoked, true)
      const result = findApplicableGrant(store, 'ws-1', 'read', '/any', '2026-08-21T10:00:00Z')
      assert.equal(result.permitted, false)
    })

    it('returns error revoking already-revoked grant', () => {
      const store = createGrantStore()
      const grant = makeGrant({ state: 'revoked' })
      issueGrant(store, grant)
      const result = revokeGrant(store, 'grant-1')
      assert.equal(result.revoked, false)
    })

    it('filters by workspace id', () => {
      const store = createGrantStore()
      const grantA = makeGrant({ identity: { grantId: 'g-a', workspaceId: 'ws-a' } })
      const grantB = makeGrant({ identity: { grantId: 'g-b', workspaceId: 'ws-b' }, boundary: { allowedPaths: [], protectedPaths: [] } })
      issueGrant(store, grantA)
      issueGrant(store, grantB)
      const resultB = findApplicableGrant(store, 'ws-b', 'write', '/any', '2026-08-21T10:00:00Z')
      assert.equal(resultB.permitted, true)
      const resultC = findApplicableGrant(store, 'ws-c', 'read', '/any', '2026-08-21T10:00:00Z')
      assert.equal(resultC.permitted, false)
    })
  })
})
