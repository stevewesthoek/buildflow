import assert from 'node:assert/strict'
import { withSourceDefaults } from '../packages/cli/src/agent/config'

const cached = {
  id: 'source',
  label: 'Source',
  path: '/path/that/must/not/be-inspected',
  enabled: true,
  repoGroupId: 'git:cached',
  branchName: 'cached-branch'
}

const hydrated = withSourceDefaults(cached, { refreshGitMetadata: false })
assert.equal(hydrated.repoGroupId, 'git:cached')
assert.equal(hydrated.branchName, 'cached-branch')
assert.equal(hydrated.autoIndexEnabled, false)
assert.equal(hydrated.autoIndexIntervalMinutes, 5)

console.log('lite source hydration verification passed')
