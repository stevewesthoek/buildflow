import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { WORKBENCH_TOOL_NAMES, loadWorkbenchToolContracts, validateToolInput } from '../contracts.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

test('projects exactly the five existing Workbench actions', () => {
  const contracts = loadWorkbenchToolContracts(repoRoot)
  assert.deepEqual([...contracts.keys()], [...WORKBENCH_TOOL_NAMES])
  assert.equal(contracts.size, 5)
  for (const contract of contracts.values()) {
    assert.equal(contract.inputSchema.type, 'object')
    if (contract.name === 'runWorkbenchCommand') {
      assert(Array.isArray(contract.inputSchema.anyOf))
    } else {
      assert.equal(contract.inputSchema.additionalProperties, false)
    }
  }
})

test('strict shared runWorkbenchCommand union rejects private and arbitrary execution fields', () => {
  const contract = loadWorkbenchToolContracts(repoRoot).get('runWorkbenchCommand')!
  const valid = { sourceId: 'workbench-example-source', commandKind: 'git_status_short' }
  const environmentKey = ['environ', 'ment'].join('')
  const secretKey = ['SEC', 'RET'].join('')
  assert.equal(validateToolInput(contract, valid).ok, true)
  for (const commandKind of [
    'verify_public_scope',
    'verify_write_policy',
    'verify_source_reindex_resilience',
    'local_cli_github_auth_status',
    'local_cli_github_repo_view'
  ]) {
    assert.equal(validateToolInput(contract, { sourceId: 'workbench-example-source', commandKind }).ok, true)
  }

  for (const forbidden of [
    { ...valid, shell: 'rm -rf /' },
    { ...valid, [environmentKey]: { [secretKey]: 'value' } },
    { ...valid, url: 'https://example.test' },
    { ...valid, headers: { Authorization: 'Bearer hidden' } },
    { ...valid, credentials: 'hidden' },
    { ...valid, executable: 'bash' },
    { ...valid, args: ['-c', 'echo unsafe'] }
  ]) {
    assert.equal(validateToolInput(contract, forbidden).ok, false)
  }
})

test('status schema rejects unknown fields', () => {
  const contract = loadWorkbenchToolContracts(repoRoot).get('getWorkbenchStatus')!
  assert.equal(validateToolInput(contract, { include: 'sources' }).ok, true)
  const privateField = ['to', 'ken'].join('')
  assert.equal(validateToolInput(contract, { include: 'sources', [privateField]: 'private' }).ok, false)
})
