import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {
  CONTROLLED_WORKFLOW_PROTECTED_DOMAINS,
  canonicalizeN8nWorkflow,
  compareControlledWorkflowCandidate,
  hashCanonicalWorkflowTopology,
  isCanonicalControlledWorkflowProtectedDomainList,
  stableSerializeCanonicalValue
} from '../packages/shared/src/controlled-workflow-canonicalization'
import type { ControlledWorkflowTopologyManifest } from '../packages/shared/src/controlled-workflow-topology'

const digest = (value: string) => crypto.createHash('sha256').update(value, 'utf8').digest('hex')
const edge = { sourceNodeId: 'node-a', sourceOutput: 'main', sourceOutputIndex: 0, targetNodeId: 'node-b', targetInput: 'main', targetInputIndex: 0 }
const liveWorkflow = {
  id: 'workflow-1', active: false, settings: { executionOrder: 'v1' },
  tags: [{ id: 'tag-1', name: 'stable' }], shared: [{ projectId: 'project-1', role: 'owner' }],
  nodes: [{
    id: 'node-a', name: 'Source', type: 'n8n-nodes-base.set', typeVersion: 1, disabled: false,
    parameters: { value: 'before', nested: { enabled: true } },
    credentials: { serviceApi: { id: 'credential-1', name: 'Service' } }
  }],
  connections: {}
}
const candidateWorkflow = {
  ...liveWorkflow,
  nodes: [
    { ...liveWorkflow.nodes[0], parameters: { value: 'after', nested: { enabled: true } } },
    { id: 'node-b', name: 'Target', type: 'n8n-nodes-base.set', typeVersion: 1, parameters: { result: 'ok' } }
  ],
  connections: { Source: { main: [[{ node: 'Target', type: 'main', index: 0 }]] } }
}

const liveCanonical = canonicalizeN8nWorkflow(liveWorkflow)
const candidateCanonical = canonicalizeN8nWorkflow(candidateWorkflow)
assert.equal(liveCanonical.ok, true)
assert.equal(candidateCanonical.ok, true)
if (!liveCanonical.ok || !candidateCanonical.ok) throw new Error('canonicalization failed')

const reordered = canonicalizeN8nWorkflow({
  connections: candidateWorkflow.connections,
  nodes: [candidateWorkflow.nodes[1], { ...candidateWorkflow.nodes[0], parameters: { nested: { enabled: true }, value: 'after' } }],
  shared: candidateWorkflow.shared,
  tags: candidateWorkflow.tags,
  settings: candidateWorkflow.settings,
  active: candidateWorkflow.active,
  id: candidateWorkflow.id
})
assert.equal(reordered.ok, true)
if (!reordered.ok) throw new Error('reordered canonicalization failed')
assert.equal(stableSerializeCanonicalValue(candidateCanonical.topology), stableSerializeCanonicalValue(reordered.topology))
assert.equal(hashCanonicalWorkflowTopology(candidateCanonical.topology, digest), hashCanonicalWorkflowTopology(reordered.topology, digest))

const manifest: ControlledWorkflowTopologyManifest = {
  schemaVersion: 1,
  kind: 'n8n-controlled-topology-migration',
  workflow: {
    id: 'workflow-1', canonicalizationVersion: 1,
    expectedLiveCanonicalSha256: hashCanonicalWorkflowTopology(liveCanonical.topology, digest),
    candidateCanonicalSha256: hashCanonicalWorkflowTopology(candidateCanonical.topology, digest),
    rollbackCanonicalSha256: hashCanonicalWorkflowTopology(liveCanonical.topology, digest)
  },
  artifacts: { candidatePath: 'operations/candidate.json', candidateSha256: 'a'.repeat(64), rollbackPath: 'operations/rollback.json', rollbackSha256: 'b'.repeat(64) },
  invariants: { activation: 'unchanged', settings: 'unchanged', tags: 'unchanged', sharing: 'unchanged', credentials: 'unchanged', webhooks: 'unchanged', schedules: 'unchanged' },
  nodes: {
    add: [{ id: 'node-b', name: 'Target', type: 'n8n-nodes-base.set', allowedParameterPointers: ['/parameters/result'] }],
    remove: [],
    modify: [{ id: 'node-a', allowedJsonPointers: ['/parameters/value'] }]
  },
  connections: { add: [edge], remove: [] },
  routes: { required: [edge], forbidden: [] }
}

const valid = compareControlledWorkflowCandidate({ live: liveWorkflow, candidate: candidateWorkflow, manifest, digest })
assert.equal(valid.ok, true, JSON.stringify(valid.issues))
assert.equal(canonicalizeN8nWorkflow(null).ok, false)
assert.equal(canonicalizeN8nWorkflow({ ...liveWorkflow, nodes: [liveWorkflow.nodes[0], liveWorkflow.nodes[0]] }).ok, false)

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const invalidManifests: Array<[ControlledWorkflowTopologyManifest, string]> = []
const undeclaredAdd = clone(manifest); undeclaredAdd.nodes.add = []; invalidManifests.push([undeclaredAdd, 'UNDECLARED_NODE_ADDITION'])
const undeclaredModify = clone(manifest); undeclaredModify.nodes.modify = []; invalidManifests.push([undeclaredModify, 'UNDECLARED_NODE_MODIFICATION'])
const parentPointer = clone(manifest); parentPointer.nodes.modify[0].allowedJsonPointers = ['/parameters']; invalidManifests.push([parentPointer, 'UNDECLARED_NODE_MODIFICATION'])
const undeclaredConnection = clone(manifest); undeclaredConnection.connections.add = []; invalidManifests.push([undeclaredConnection, 'UNDECLARED_CONNECTION_ADDITION'])
const missingRoute = clone(manifest); missingRoute.routes.required = [{ ...edge, targetNodeId: 'missing' }]; invalidManifests.push([missingRoute, 'MISSING_REQUIRED_ROUTE'])
const forbiddenRoute = clone(manifest); forbiddenRoute.routes.forbidden = [edge]; invalidManifests.push([forbiddenRoute, 'FORBIDDEN_ROUTE_PRESENT'])
for (const [invalidManifest, code] of invalidManifests) {
  const result = compareControlledWorkflowCandidate({ live: liveWorkflow, candidate: candidateWorkflow, manifest: invalidManifest, digest })
  assert.equal(result.ok, false)
  assert.ok(result.issues.some(issue => issue.code === code), `${code} must be reported`)
}

const removalCandidate = { ...liveWorkflow, nodes: [], connections: {} }
const removalCanonical = canonicalizeN8nWorkflow(removalCandidate)
assert.equal(removalCanonical.ok, true)
if (!removalCanonical.ok) throw new Error('removal canonicalization failed')
const removalManifest = clone(manifest)
removalManifest.workflow.candidateCanonicalSha256 = hashCanonicalWorkflowTopology(removalCanonical.topology, digest)
removalManifest.nodes = { add: [], remove: [], modify: [] }
removalManifest.connections = { add: [], remove: [] }
removalManifest.routes = { required: [], forbidden: [] }
assert.ok(compareControlledWorkflowCandidate({ live: liveWorkflow, candidate: removalCandidate, manifest: removalManifest, digest }).issues.some(issue => issue.code === 'UNDECLARED_NODE_REMOVAL'))

const protectedCases: Array<[string, unknown]> = [
  ['activation', { ...candidateWorkflow, active: true }],
  ['settings', { ...candidateWorkflow, settings: { executionOrder: 'v2' } }],
  ['tags', { ...candidateWorkflow, tags: [{ id: 'tag-2' }] }],
  ['sharing', { ...candidateWorkflow, shared: [{ projectId: 'project-2' }] }],
  ['credentials', { ...candidateWorkflow, nodes: candidateWorkflow.nodes.map((node, index) => index === 0 ? { ...node, credentials: { serviceApi: { id: 'never-print-this-reference', name: 'Changed' } } } : node) }],
  ['webhooks', { ...candidateWorkflow, nodes: [...candidateWorkflow.nodes, { id: 'webhook-node', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 1, parameters: { path: 'changed' } }] }],
  ['schedules', { ...candidateWorkflow, nodes: [...candidateWorkflow.nodes, { id: 'schedule-node', name: 'Schedule', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1, parameters: { interval: 5 } }] }]
]
assert.deepEqual(CONTROLLED_WORKFLOW_PROTECTED_DOMAINS, protectedCases.map(([domain]) => domain))
assert.equal(isCanonicalControlledWorkflowProtectedDomainList(['activation', 'settings']), true)
assert.equal(isCanonicalControlledWorkflowProtectedDomainList([]), false)
assert.equal(isCanonicalControlledWorkflowProtectedDomainList(['settings', 'activation']), false)
assert.equal(isCanonicalControlledWorkflowProtectedDomainList(['activation', 'workflow']), false)
for (const [domain, candidate] of protectedCases) {
  const canonical = canonicalizeN8nWorkflow(candidate)
  assert.equal(canonical.ok, true)
  if (!canonical.ok) continue
  const changedManifest = clone(manifest)
  changedManifest.workflow.candidateCanonicalSha256 = hashCanonicalWorkflowTopology(canonical.topology, digest)
  if (domain === 'webhooks') changedManifest.nodes.add.push({ id: 'webhook-node', name: 'Webhook', type: 'n8n-nodes-base.webhook', allowedParameterPointers: ['/parameters/path'] })
  if (domain === 'schedules') changedManifest.nodes.add.push({ id: 'schedule-node', name: 'Schedule', type: 'n8n-nodes-base.scheduleTrigger', allowedParameterPointers: ['/parameters/interval'] })
  const result = compareControlledWorkflowCandidate({ live: liveWorkflow, candidate, manifest: changedManifest, digest })
  assert.ok(result.issues.some(issue => issue.path === `/invariants/${domain}`), `${domain} change must fail`)
  assert.equal(JSON.stringify(result.issues).includes('never-print-this-reference'), false)
}

const realisticSharingA = [
  {
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    workflowId: 'workflow-1',
    projectId: 'project-owner',
    role: 'workflow:owner',
    project: {
      id: 'project-owner',
      name: 'Original display name',
      type: 'personal',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      projectRelations: [{ userId: 'user-owner', projectId: 'project-owner', role: 'project:personalOwner' }]
    }
  },
  {
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    workflowId: 'workflow-1',
    projectId: 'project-editor',
    role: 'workflow:editor',
    project: {
      id: 'project-editor',
      name: 'Team display name',
      type: 'team',
      projectRelations: [{ userId: 'user-editor', projectId: 'project-editor', role: 'project:editor' }]
    }
  }
]
const realisticSharingB = [
  {
    ...realisticSharingA[1],
    updatedAt: '2026-07-21T00:00:00.000Z',
    project: {
      ...realisticSharingA[1].project,
      name: 'Renamed team',
      projectRelations: [{ userId: 'different-expanded-user', projectId: 'project-editor', role: 'project:admin' }]
    }
  },
  {
    ...realisticSharingA[0],
    updatedAt: '2026-07-21T00:00:00.000Z',
    project: {
      ...realisticSharingA[0].project,
      name: 'Renamed personal project',
      updatedAt: '2026-07-21T00:00:00.000Z'
    }
  }
]
const sharingV1A = canonicalizeN8nWorkflow({ ...liveWorkflow, shared: realisticSharingA }, 1)
const sharingV1B = canonicalizeN8nWorkflow({ ...liveWorkflow, shared: realisticSharingB }, 1)
const sharingV2A = canonicalizeN8nWorkflow({ ...liveWorkflow, shared: realisticSharingA }, 2)
const sharingV2B = canonicalizeN8nWorkflow({ ...liveWorkflow, shared: realisticSharingB }, 2)
assert.equal(sharingV1A.ok, true)
assert.equal(sharingV1B.ok, true)
assert.equal(sharingV2A.ok, true)
assert.equal(sharingV2B.ok, true)
if (!sharingV1A.ok || !sharingV1B.ok || !sharingV2A.ok || !sharingV2B.ok) throw new Error('sharing canonicalization failed')
assert.notEqual(stableSerializeCanonicalValue(sharingV1A.protected.sharing), stableSerializeCanonicalValue(sharingV1B.protected.sharing))
assert.equal(stableSerializeCanonicalValue(sharingV2A.protected.sharing), stableSerializeCanonicalValue(sharingV2B.protected.sharing))
assert.deepEqual(sharingV2A.protected.sharing, {
  state: 'present',
  value: [
    { projectId: 'project-editor', role: 'workflow:editor' },
    { projectId: 'project-owner', role: 'workflow:owner' }
  ]
})

const sharingRoleChanged = canonicalizeN8nWorkflow({
  ...liveWorkflow,
  shared: realisticSharingA.map((entry, index) => index === 0 ? { ...entry, role: 'workflow:editor' } : entry)
}, 2)
const sharingProjectChanged = canonicalizeN8nWorkflow({
  ...liveWorkflow,
  shared: realisticSharingA.map((entry, index) => index === 0
    ? { ...entry, projectId: 'project-other', project: { ...entry.project, id: 'project-other' } }
    : entry)
}, 2)
assert.equal(sharingRoleChanged.ok, true)
assert.equal(sharingProjectChanged.ok, true)
if (!sharingRoleChanged.ok || !sharingProjectChanged.ok) throw new Error('changed sharing canonicalization failed')
assert.notEqual(stableSerializeCanonicalValue(sharingV2A.protected.sharing), stableSerializeCanonicalValue(sharingRoleChanged.protected.sharing))
assert.notEqual(stableSerializeCanonicalValue(sharingV2A.protected.sharing), stableSerializeCanonicalValue(sharingProjectChanged.protected.sharing))

const sharingMissingV2 = canonicalizeN8nWorkflow({ ...liveWorkflow, shared: undefined }, 2)
const sharingPresentEmptyV2 = canonicalizeN8nWorkflow({ ...liveWorkflow, shared: [] }, 2)
assert.equal(sharingMissingV2.ok, false, 'an explicitly present undefined sharing value must fail closed')
assert.equal(sharingPresentEmptyV2.ok, true)
const sharingAbsentWorkflow = { ...liveWorkflow } as Record<string, unknown>
delete sharingAbsentWorkflow.shared
const sharingAbsentV2 = canonicalizeN8nWorkflow(sharingAbsentWorkflow, 2)
assert.equal(sharingAbsentV2.ok, true)
if (!sharingAbsentV2.ok || !sharingPresentEmptyV2.ok) throw new Error('sharing presence canonicalization failed')
assert.notEqual(stableSerializeCanonicalValue(sharingAbsentV2.protected.sharing), stableSerializeCanonicalValue(sharingPresentEmptyV2.protected.sharing))

const invalidSharingV2 = [
  { ...liveWorkflow, shared: [{ workflowId: 'different-workflow', projectId: 'project-owner', role: 'workflow:owner' }] },
  { ...liveWorkflow, shared: [{ projectId: 'project-owner', role: 'workflow:owner', project: { id: 'different-project' } }] },
  { ...liveWorkflow, shared: [{ projectId: 'project-owner', role: 'workflow:owner' }, { projectId: 'project-owner', role: 'workflow:editor' }] },
  { ...liveWorkflow, shared: [{ projectId: '', role: 'workflow:owner' }] },
  { ...liveWorkflow, shared: [{ projectId: 'project-owner', role: '' }] },
  { ...liveWorkflow, shared: realisticSharingA, sharing: realisticSharingA }
]
invalidSharingV2.forEach(workflow => assert.equal(canonicalizeN8nWorkflow(workflow, 2).ok, false))

const semanticManifest = clone(manifest)
semanticManifest.workflow.canonicalizationVersion = 2
const semanticLive = { ...liveWorkflow, shared: realisticSharingA }
const semanticCandidate = { ...candidateWorkflow, shared: realisticSharingB }
const semanticLiveCanonical = canonicalizeN8nWorkflow(semanticLive, 2)
const semanticCandidateCanonical = canonicalizeN8nWorkflow(semanticCandidate, 2)
assert.equal(semanticLiveCanonical.ok, true)
assert.equal(semanticCandidateCanonical.ok, true)
if (!semanticLiveCanonical.ok || !semanticCandidateCanonical.ok) throw new Error('semantic sharing fixture failed')
semanticManifest.workflow.expectedLiveCanonicalSha256 = hashCanonicalWorkflowTopology(semanticLiveCanonical.topology, digest)
semanticManifest.workflow.rollbackCanonicalSha256 = semanticManifest.workflow.expectedLiveCanonicalSha256
semanticManifest.workflow.candidateCanonicalSha256 = hashCanonicalWorkflowTopology(semanticCandidateCanonical.topology, digest)
const semanticComparison = compareControlledWorkflowCandidate({ live: semanticLive, candidate: semanticCandidate, manifest: semanticManifest, digest })
assert.equal(semanticComparison.ok, true, JSON.stringify(semanticComparison.issues))
const roleChangedCandidate = { ...semanticCandidate, shared: [{ ...realisticSharingB[0], role: 'workflow:owner' }, realisticSharingB[1]] }
const roleChangedCanonical = canonicalizeN8nWorkflow(roleChangedCandidate, 2)
assert.equal(roleChangedCanonical.ok, true)
if (!roleChangedCanonical.ok) throw new Error('role-changed sharing fixture failed')
const roleChangedManifest = clone(semanticManifest)
roleChangedManifest.workflow.candidateCanonicalSha256 = hashCanonicalWorkflowTopology(roleChangedCanonical.topology, digest)
const roleChangedComparison = compareControlledWorkflowCandidate({ live: semanticLive, candidate: roleChangedCandidate, manifest: roleChangedManifest, digest })
assert.ok(roleChangedComparison.issues.some(issue => issue.path === '/invariants/sharing'))

const prototypeBefore = canonicalizeN8nWorkflow({
  id: 'prototype-workflow',
  nodes: [{ id: 'prototype-node', name: 'Prototype', type: 'n8n-nodes-base.set', parameters: JSON.parse('{"__proto__":{"value":"before"}}') }],
  connections: {}
})
const prototypeAfter = canonicalizeN8nWorkflow({
  id: 'prototype-workflow',
  nodes: [{ id: 'prototype-node', name: 'Prototype', type: 'n8n-nodes-base.set', parameters: JSON.parse('{"__proto__":{"value":"after"}}') }],
  connections: {}
})
assert.equal(prototypeBefore.ok, true)
assert.equal(prototypeAfter.ok, true)
if (!prototypeBefore.ok || !prototypeAfter.ok) throw new Error('prototype-key canonicalization failed')
assert.equal(Object.prototype.hasOwnProperty.call(prototypeBefore.topology.nodes[0].parameters, '__proto__'), true)
assert.equal(stableSerializeCanonicalValue(prototypeBefore.topology.nodes[0].parameters), '{"__proto__":{"value":"before"}}')
assert.notEqual(hashCanonicalWorkflowTopology(prototypeBefore.topology, digest), hashCanonicalWorkflowTopology(prototypeAfter.topology, digest))

const equivalentUnicodeNodes = [
  { id: '\u00e9', name: 'Composed', type: 'n8n-nodes-base.set', parameters: {} },
  { id: 'e\u0301', name: 'Decomposed', type: 'n8n-nodes-base.set', parameters: {} }
]
const unicodeOrderA = canonicalizeN8nWorkflow({ id: 'unicode-workflow', nodes: equivalentUnicodeNodes, connections: {} })
const unicodeOrderB = canonicalizeN8nWorkflow({ id: 'unicode-workflow', nodes: [...equivalentUnicodeNodes].reverse(), connections: {} })
assert.equal(unicodeOrderA.ok, true)
assert.equal(unicodeOrderB.ok, true)
if (!unicodeOrderA.ok || !unicodeOrderB.ok) throw new Error('unicode-order canonicalization failed')
assert.equal(stableSerializeCanonicalValue(unicodeOrderA.topology), stableSerializeCanonicalValue(unicodeOrderB.topology))

const collisionNodes = [
  { id: 'source\u0000nested', name: 'Source A', type: 'n8n-nodes-base.set', parameters: {} },
  { id: 'source', name: 'Source B', type: 'n8n-nodes-base.set', parameters: {} },
  { id: 'target', name: 'Target', type: 'n8n-nodes-base.set', parameters: {} }
]
const collisionLive = { id: 'collision-workflow', nodes: collisionNodes, connections: { 'Source A': { main: [[{ node: 'Target', type: 'main', index: 0 }]] } } }
const collisionCandidate = { id: 'collision-workflow', nodes: collisionNodes, connections: { 'Source B': { ['nested\u0000main']: [[{ node: 'Target', type: 'main', index: 0 }]] } } }
const collisionLiveCanonical = canonicalizeN8nWorkflow(collisionLive)
const collisionCandidateCanonical = canonicalizeN8nWorkflow(collisionCandidate)
assert.equal(collisionLiveCanonical.ok, true)
assert.equal(collisionCandidateCanonical.ok, true)
if (!collisionLiveCanonical.ok || !collisionCandidateCanonical.ok) throw new Error('collision canonicalization failed')
const collisionManifest: ControlledWorkflowTopologyManifest = {
  schemaVersion: 1,
  kind: 'n8n-controlled-topology-migration',
  workflow: {
    id: 'collision-workflow', canonicalizationVersion: 1,
    expectedLiveCanonicalSha256: hashCanonicalWorkflowTopology(collisionLiveCanonical.topology, digest),
    candidateCanonicalSha256: hashCanonicalWorkflowTopology(collisionCandidateCanonical.topology, digest),
    rollbackCanonicalSha256: hashCanonicalWorkflowTopology(collisionLiveCanonical.topology, digest)
  },
  artifacts: { candidatePath: 'operations/candidate.json', candidateSha256: 'c'.repeat(64), rollbackPath: 'operations/rollback.json', rollbackSha256: 'd'.repeat(64) },
  invariants: { activation: 'unchanged', settings: 'unchanged', tags: 'unchanged', sharing: 'unchanged', credentials: 'unchanged', webhooks: 'unchanged', schedules: 'unchanged' },
  nodes: { add: [], remove: [], modify: [] },
  connections: { add: [], remove: [] },
  routes: { required: [], forbidden: [] }
}
const collisionResult = compareControlledWorkflowCandidate({ live: collisionLive, candidate: collisionCandidate, manifest: collisionManifest, digest })
assert.equal(collisionResult.ok, false)
assert.ok(collisionResult.issues.some(issue => issue.code === 'UNDECLARED_CONNECTION_ADDITION'))
assert.ok(collisionResult.issues.some(issue => issue.code === 'UNDECLARED_CONNECTION_REMOVAL'))

let deeplyNestedParameters: unknown = 'leaf'
for (let depth = 0; depth < 150; depth += 1) deeplyNestedParameters = { value: deeplyNestedParameters }
const deeplyNested = canonicalizeN8nWorkflow({
  id: 'deep-workflow',
  nodes: [{ id: 'deep-node', name: 'Deep', type: 'n8n-nodes-base.set', parameters: deeplyNestedParameters }],
  connections: {}
})
assert.equal(deeplyNested.ok, false)
if (deeplyNested.ok === false) assert.ok(deeplyNested.issues.some(issue => issue.code === 'MAX_DEPTH_EXCEEDED'))

console.log('controlled workflow canonicalization verification passed')
