import assert from 'node:assert/strict'
import {
  controlledWorkflowTopologyManifestSchema,
  validateControlledWorkflowTopologyManifest,
  type ControlledWorkflowTopologyManifest
} from '../packages/shared/src/controlled-workflow-topology'

const hash = 'a'.repeat(64)
const connection = {
  sourceNodeId: 'source-node',
  sourceOutput: 'main',
  sourceOutputIndex: 0,
  targetNodeId: 'target-node',
  targetInput: 'main',
  targetInputIndex: 0
}

const validManifest = {
  schemaVersion: 1,
  kind: 'n8n-controlled-topology-migration',
  workflow: {
    id: 'workflow-1',
    canonicalizationVersion: 1,
    expectedLiveCanonicalSha256: hash,
    candidateCanonicalSha256: 'b'.repeat(64),
    rollbackCanonicalSha256: 'c'.repeat(64)
  },
  artifacts: {
    candidatePath: 'operations/automations/n8n/workflows/candidate.json',
    candidateSha256: 'd'.repeat(64),
    rollbackPath: 'operations/reports/artifacts/rollback.json',
    rollbackSha256: 'e'.repeat(64)
  },
  invariants: {
    activation: 'unchanged',
    settings: 'unchanged',
    tags: 'unchanged',
    sharing: 'unchanged',
    credentials: 'unchanged',
    webhooks: 'unchanged',
    schedules: 'unchanged'
  },
  nodes: {
    add: [{ id: 'target-node', name: 'Target', type: 'n8n-nodes-base.set', allowedParameterPointers: ['/parameters/value'] }],
    remove: [],
    modify: [{ id: 'source-node', allowedJsonPointers: ['/parameters/source'] }]
  },
  connections: { add: [connection], remove: [] },
  routes: { required: [connection], forbidden: [] }
} satisfies ControlledWorkflowTopologyManifest

assert.equal(controlledWorkflowTopologyManifestSchema.safeParse(validManifest).success, true)
assert.equal(validateControlledWorkflowTopologyManifest(validManifest).ok, true)
assert.equal(validateControlledWorkflowTopologyManifest({
  ...validManifest,
  workflow: { ...validManifest.workflow, canonicalizationVersion: 2 }
}).ok, true)

const invalidCases: unknown[] = [
  { ...validManifest, repositoryMayAuthorizeItself: true },
  { ...validManifest, workflow: { ...validManifest.workflow, unknown: true } },
  { ...validManifest, workflow: { ...validManifest.workflow, canonicalizationVersion: 3 } },
  { ...validManifest, artifacts: { ...validManifest.artifacts, candidatePath: '../candidate.json' } },
  { ...validManifest, invariants: { ...validManifest.invariants, activation: 'changed' } },
  { ...validManifest, nodes: { ...validManifest.nodes, add: [...validManifest.nodes.add, validManifest.nodes.add[0]] } },
  { ...validManifest, nodes: { add: validManifest.nodes.add, remove: [{ id: 'target-node' }], modify: validManifest.nodes.modify } },
  { ...validManifest, nodes: { ...validManifest.nodes, modify: [{ id: 'source-node', allowedJsonPointers: ['parameters/source'] }] } },
  { ...validManifest, nodes: { ...validManifest.nodes, modify: [{ id: 'source-node', allowedJsonPointers: ['/parameters/~2bad'] }] } },
  { ...validManifest, connections: { add: [connection, connection], remove: [] } },
  { ...validManifest, connections: { add: [connection], remove: [connection] } },
  { ...validManifest, routes: { required: [connection], forbidden: [connection] } }
]

for (const [index, invalid] of invalidCases.entries()) {
  const result = validateControlledWorkflowTopologyManifest(invalid)
  assert.equal(result.ok, false, `invalid manifest case ${index} must fail`)
  if (!result.ok) {
    assert.ok(result.issues.length > 0)
    assert.ok(result.issues.length <= 50)
  }
}

const pointerDuplicates = validateControlledWorkflowTopologyManifest({
  ...validManifest,
  nodes: {
    ...validManifest.nodes,
    modify: [{ id: 'source-node', allowedJsonPointers: ['/parameters/source', '/parameters/source'] }]
  }
})
assert.equal(pointerDuplicates.ok, false)

console.log('controlled workflow topology manifest verification passed')
