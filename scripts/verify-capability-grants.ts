import assert from 'node:assert/strict'
import {
  controlledN8nWorkflowGrantSchema,
  findControlledN8nWorkflowGrant,
  loadControlledN8nWorkflowGrants,
  type ControlledN8nWorkflowGrant
} from '../packages/cli/src/agent/capability-grants'

const hash = 'a'.repeat(64)
const baseGrant = {
  grantId: 'controlled-workflow-1',
  version: 1,
  enabled: true,
  sourceId: 'example-source',
  workflowId: 'workflow-1',
  wrapperPath: 'tools/n8n-api.sh',
  wrapperSha256: hash,
  allowedCandidateRoots: ['operations/automations/n8n/workflows'],
  allowedRollbackRoots: ['operations/reports/artifacts'],
  allowedManifestRoots: ['operations/automations/n8n'],
  canonicalizationVersion: 1,
  confirmationTtlSeconds: 600,
  operationTimeoutMs: 120000,
  maxArtifactBytes: 1048576,
  maximumPolicy: {
    activation: 'unchanged',
    settings: 'unchanged',
    tags: 'unchanged',
    sharing: 'unchanged',
    credentials: 'unchanged',
    webhooks: 'unchanged',
    schedules: 'unchanged'
  }
} satisfies ControlledN8nWorkflowGrant

assert.equal(controlledN8nWorkflowGrantSchema.safeParse(baseGrant).success, true)
assert.equal(controlledN8nWorkflowGrantSchema.safeParse({ ...baseGrant, canonicalizationVersion: 2 }).success, true)
assert.equal(controlledN8nWorkflowGrantSchema.safeParse({ ...baseGrant, canonicalizationVersion: 3 }).success, false)

const valid = loadControlledN8nWorkflowGrants([baseGrant])
assert.equal(valid.issues.length, 0)
assert.equal(valid.grants.length, 1)
assert.equal(findControlledN8nWorkflowGrant(valid.grants, 'example-source', 'workflow-1')?.grantId, 'controlled-workflow-1')
assert.equal(findControlledN8nWorkflowGrant(valid.grants, 'other-source', 'workflow-1'), undefined)

const disabled = loadControlledN8nWorkflowGrants([{ ...baseGrant, enabled: false }])
assert.equal(disabled.issues.length, 0)
assert.equal(findControlledN8nWorkflowGrant(disabled.grants, 'example-source', 'workflow-1'), undefined)

const invalidPath = loadControlledN8nWorkflowGrants([{ ...baseGrant, wrapperPath: '../tools/n8n-api.sh' }])
assert.equal(invalidPath.grants.length, 0)
assert.equal(invalidPath.issues.length, 1)

const unknownField = loadControlledN8nWorkflowGrants([{ ...baseGrant, repositoryMayAuthorizeItself: true }])
assert.equal(unknownField.grants.length, 0)
assert.equal(unknownField.issues.length, 1)

const expandedPolicy = loadControlledN8nWorkflowGrants([{
  ...baseGrant,
  maximumPolicy: { ...baseGrant.maximumPolicy, activation: 'change' }
}])
assert.equal(expandedPolicy.grants.length, 0)
assert.equal(expandedPolicy.issues.length, 1)

const duplicateGrantId = loadControlledN8nWorkflowGrants([
  baseGrant,
  { ...baseGrant, sourceId: 'second-source' }
])
assert.equal(duplicateGrantId.grants.length, 1)
assert.equal(duplicateGrantId.issues[0]?.issues[0]?.path, 'grantId')

const duplicateAuthority = loadControlledN8nWorkflowGrants([
  baseGrant,
  { ...baseGrant, grantId: 'controlled-workflow-2' }
])
assert.equal(duplicateAuthority.grants.length, 1)
assert.equal(duplicateAuthority.issues[0]?.issues[0]?.path, 'sourceId,workflowId')

const malformedContainer = loadControlledN8nWorkflowGrants({ grantId: 'not-an-array' })
assert.equal(malformedContainer.grants.length, 0)
assert.equal(malformedContainer.issues.length, 1)

console.log('controlled n8n workflow capability grant verification passed')
