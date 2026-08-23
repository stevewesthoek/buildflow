import type {
  ControlledWorkflowCanonicalizationVersion,
  ControlledWorkflowTopologyManifest,
  WorkflowConnectionSpec
} from './controlled-workflow-topology'

export type CanonicalJsonValue = null | boolean | number | string | CanonicalJsonValue[] | { [key: string]: CanonicalJsonValue }
export type CanonicalWorkflowIssue = { code: string; path: string; message: string }
export type Sha256Digest = (utf8: string) => string

export type CanonicalWorkflowNode = {
  id: string
  name: string
  type: string
  typeVersion: string | number | null
  disabled: boolean
  parameters: CanonicalJsonValue
}

export type CanonicalWorkflowTopology = {
  canonicalizationVersion: ControlledWorkflowCanonicalizationVersion
  workflowId: string
  nodes: CanonicalWorkflowNode[]
  connections: WorkflowConnectionSpec[]
}

export type PresenceValue = { state: 'missing' } | { state: 'present'; value: CanonicalJsonValue }
export type CredentialReference = { nodeId: string; credentialType: string; id?: string; name?: string }
export type ProtectedTriggerSnapshot = { nodeId: string; nodeType: string; parameters: CanonicalJsonValue }
export type ProtectedWorkflowSharingAssignment = { projectId: string; role: string }

export type ProtectedWorkflowSnapshot = {
  canonicalizationVersion: ControlledWorkflowCanonicalizationVersion
  workflowId: string
  activation: PresenceValue
  settings: PresenceValue
  tags: PresenceValue
  sharing: PresenceValue
  credentials: CredentialReference[]
  webhooks: ProtectedTriggerSnapshot[]
  schedules: ProtectedTriggerSnapshot[]
}

export type ControlledWorkflowProtectedDomain = Exclude<
  keyof ProtectedWorkflowSnapshot,
  'canonicalizationVersion' | 'workflowId'
>

const CONTROLLED_WORKFLOW_PROTECTED_DOMAIN_MAP = {
  activation: true,
  settings: true,
  tags: true,
  sharing: true,
  credentials: true,
  webhooks: true,
  schedules: true
} satisfies Record<ControlledWorkflowProtectedDomain, true>

export const CONTROLLED_WORKFLOW_PROTECTED_DOMAINS = Object.freeze(
  Object.keys(CONTROLLED_WORKFLOW_PROTECTED_DOMAIN_MAP) as ControlledWorkflowProtectedDomain[]
)

export function isCanonicalControlledWorkflowProtectedDomainList(
  value: unknown
): value is ControlledWorkflowProtectedDomain[] {
  if (!Array.isArray(value)
    || value.length === 0
    || value.length > CONTROLLED_WORKFLOW_PROTECTED_DOMAINS.length) return false
  let previousIndex = -1
  for (const domain of value) {
    if (typeof domain !== 'string') return false
    const index = (CONTROLLED_WORKFLOW_PROTECTED_DOMAINS as readonly string[]).indexOf(domain)
    if (index <= previousIndex) return false
    previousIndex = index
  }
  return true
}

export type CanonicalWorkflowResult =
  | { ok: true; topology: CanonicalWorkflowTopology; protected: ProtectedWorkflowSnapshot }
  | { ok: false; issues: CanonicalWorkflowIssue[] }

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const pointerToken = (value: string) => value.replace(/~/g, '~0').replace(/\//g, '~1')
const MAX_CANONICAL_JSON_DEPTH = 100
const MAX_STABLE_JSON_DEPTH = MAX_CANONICAL_JSON_DEPTH + 16
const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

function canonicalJson(value: unknown, path: string, issues: CanonicalWorkflowIssue[], depth = 0): CanonicalJsonValue | undefined {
  if (depth > MAX_CANONICAL_JSON_DEPTH) {
    issues.push({ code: 'MAX_DEPTH_EXCEEDED', path, message: `workflow JSON exceeds maximum depth ${MAX_CANONICAL_JSON_DEPTH}` })
    return undefined
  }
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value
    issues.push({ code: 'NON_JSON_NUMBER', path, message: 'workflow contains a non-finite number' })
    return undefined
  }
  if (Array.isArray(value)) {
    const output: CanonicalJsonValue[] = []
    value.forEach((item, index) => {
      const child = canonicalJson(item, `${path}/${index}`, issues, depth + 1)
      if (child !== undefined) output.push(child)
    })
    return output
  }
  if (isRecord(value)) {
    const output: Record<string, CanonicalJsonValue> = Object.create(null)
    for (const key of Object.keys(value).sort()) {
      const child = canonicalJson(value[key], `${path}/${pointerToken(key)}`, issues, depth + 1)
      if (child !== undefined) output[key] = child
    }
    return output
  }
  issues.push({ code: 'NON_JSON_VALUE', path, message: 'workflow contains a non-JSON value' })
  return undefined
}

function sortUnknown(value: unknown, depth = 0): unknown {
  if (depth > MAX_STABLE_JSON_DEPTH) throw new Error(`canonical value exceeds maximum depth ${MAX_STABLE_JSON_DEPTH}`)
  if (Array.isArray(value)) return value.map(item => sortUnknown(item, depth + 1))
  if (isRecord(value)) {
    const output: Record<string, unknown> = Object.create(null)
    for (const key of Object.keys(value).sort()) output[key] = sortUnknown(value[key], depth + 1)
    return output
  }
  return value
}

export function stableSerializeCanonicalValue(value: unknown): string {
  return JSON.stringify(sortUnknown(value))
}

function presence(record: Record<string, unknown>, key: string, path: string, issues: CanonicalWorkflowIssue[]): PresenceValue {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return { state: 'missing' }
  const value = canonicalJson(record[key], path, issues)
  return value === undefined ? { state: 'missing' } : { state: 'present', value }
}

function semanticSharingPresence(
  workflow: Record<string, unknown>,
  workflowId: string,
  issues: CanonicalWorkflowIssue[]
): PresenceValue {
  const hasShared = Object.prototype.hasOwnProperty.call(workflow, 'shared')
  const hasSharing = Object.prototype.hasOwnProperty.call(workflow, 'sharing')
  if (!hasShared && !hasSharing) return { state: 'missing' }
  if (hasShared && hasSharing) {
    issues.push({
      code: 'AMBIGUOUS_SHARING_FIELDS',
      path: '/sharing',
      message: 'workflow may contain only one sharing representation'
    })
    return { state: 'missing' }
  }

  const key = hasShared ? 'shared' : 'sharing'
  const raw = workflow[key]
  if (!Array.isArray(raw)) {
    issues.push({ code: 'INVALID_SHARING', path: `/${key}`, message: 'sharing must be an array' })
    return { state: 'missing' }
  }

  const assignments: ProtectedWorkflowSharingAssignment[] = []
  const seenProjects = new Set<string>()
  raw.forEach((value, index) => {
    const basePath = `/${key}/${index}`
    if (!isRecord(value)) {
      issues.push({ code: 'INVALID_SHARING_ENTRY', path: basePath, message: 'sharing entry must be an object' })
      return
    }
    const projectId = typeof value.projectId === 'string' && value.projectId === value.projectId.trim()
      && value.projectId.length > 0 && value.projectId.length <= 200
      ? value.projectId
      : ''
    const role = typeof value.role === 'string' && value.role === value.role.trim()
      && value.role.length > 0 && value.role.length <= 160
      ? value.role
      : ''
    if (!projectId) issues.push({ code: 'INVALID_SHARING_PROJECT_ID', path: `${basePath}/projectId`, message: 'sharing project ID is required' })
    if (!role) issues.push({ code: 'INVALID_SHARING_ROLE', path: `${basePath}/role`, message: 'sharing role is required' })
    if (Object.prototype.hasOwnProperty.call(value, 'workflowId') && value.workflowId !== workflowId) {
      issues.push({ code: 'SHARING_WORKFLOW_ID_MISMATCH', path: `${basePath}/workflowId`, message: 'sharing workflow ID does not match the workflow' })
    }
    if (Object.prototype.hasOwnProperty.call(value, 'project')) {
      if (!isRecord(value.project)) {
        issues.push({ code: 'INVALID_SHARING_PROJECT', path: `${basePath}/project`, message: 'expanded sharing project must be an object' })
      } else if (Object.prototype.hasOwnProperty.call(value.project, 'id') && value.project.id !== projectId) {
        issues.push({ code: 'SHARING_PROJECT_ID_MISMATCH', path: `${basePath}/project/id`, message: 'expanded project ID does not match the sharing project ID' })
      }
    }
    if (!projectId || !role) return
    if (seenProjects.has(projectId)) {
      issues.push({ code: 'DUPLICATE_SHARING_PROJECT', path: `${basePath}/projectId`, message: 'sharing project IDs must be unique' })
      return
    }
    seenProjects.add(projectId)
    assignments.push({ projectId, role })
  })
  assignments.sort((left, right) => compareText(
    JSON.stringify([left.projectId, left.role]),
    JSON.stringify([right.projectId, right.role])
  ))
  return { state: 'present', value: assignments }
}

function credentialReferences(node: Record<string, unknown>, nodeId: string): CredentialReference[] {
  const credentials = node.credentials
  if (!isRecord(credentials)) return []
  return Object.keys(credentials).sort().flatMap(credentialType => {
    const value = credentials[credentialType]
    if (!isRecord(value)) return []
    const id = typeof value.id === 'string' ? value.id : undefined
    const name = typeof value.name === 'string' ? value.name : undefined
    return [{ nodeId, credentialType, ...(id ? { id } : {}), ...(name ? { name } : {}) }]
  })
}

const edgeKey = (edge: WorkflowConnectionSpec): string => JSON.stringify([
  edge.sourceNodeId, edge.sourceOutput, edge.sourceOutputIndex,
  edge.targetNodeId, edge.targetInput, edge.targetInputIndex
])

function extractConnections(workflow: Record<string, unknown>, nodeIdsByName: Map<string, string>, issues: CanonicalWorkflowIssue[]): WorkflowConnectionSpec[] {
  if (workflow.connections === undefined) return []
  if (!isRecord(workflow.connections)) {
    issues.push({ code: 'INVALID_CONNECTIONS', path: '/connections', message: 'connections must be an object' })
    return []
  }
  const edges: WorkflowConnectionSpec[] = []
  for (const sourceName of Object.keys(workflow.connections).sort()) {
    const sourceNodeId = nodeIdsByName.get(sourceName)
    const outputs = workflow.connections[sourceName]
    if (!sourceNodeId || !isRecord(outputs)) {
      issues.push({ code: 'INVALID_CONNECTION_SOURCE', path: `/connections/${pointerToken(sourceName)}`, message: 'connection source is invalid' })
      continue
    }
    for (const sourceOutput of Object.keys(outputs).sort()) {
      const groups = outputs[sourceOutput]
      if (!Array.isArray(groups)) {
        issues.push({ code: 'INVALID_CONNECTION_OUTPUT', path: `/connections/${pointerToken(sourceName)}/${pointerToken(sourceOutput)}`, message: 'connection output must be an array' })
        continue
      }
      groups.forEach((group, sourceOutputIndex) => {
        if (!Array.isArray(group)) {
          issues.push({ code: 'INVALID_CONNECTION_GROUP', path: `/connections/${pointerToken(sourceName)}/${pointerToken(sourceOutput)}/${sourceOutputIndex}`, message: 'connection group must be an array' })
          return
        }
        group.forEach((rawEdge, edgeIndex) => {
          if (!isRecord(rawEdge) || typeof rawEdge.node !== 'string') {
            issues.push({ code: 'INVALID_CONNECTION', path: `/connections/${pointerToken(sourceName)}/${pointerToken(sourceOutput)}/${sourceOutputIndex}/${edgeIndex}`, message: 'connection entry is malformed' })
            return
          }
          const targetNodeId = nodeIdsByName.get(rawEdge.node)
          if (!targetNodeId) {
            issues.push({ code: 'UNKNOWN_TARGET_NODE', path: `/connections/${pointerToken(sourceName)}/${pointerToken(sourceOutput)}/${sourceOutputIndex}/${edgeIndex}`, message: 'connection target is unknown' })
            return
          }
          edges.push({
            sourceNodeId,
            sourceOutput,
            sourceOutputIndex,
            targetNodeId,
            targetInput: typeof rawEdge.type === 'string' ? rawEdge.type : 'main',
            targetInputIndex: typeof rawEdge.index === 'number' && Number.isInteger(rawEdge.index) && rawEdge.index >= 0 ? rawEdge.index : 0
          })
        })
      })
    }
  }
  edges.sort((a, b) => compareText(edgeKey(a), edgeKey(b)))
  const seen = new Set<string>()
  edges.forEach(edge => {
    const key = edgeKey(edge)
    if (seen.has(key)) issues.push({ code: 'DUPLICATE_CONNECTION', path: '/connections', message: 'workflow contains a duplicate connection' })
    seen.add(key)
  })
  return edges
}

export function canonicalizeN8nWorkflow(
  input: unknown,
  canonicalizationVersion: ControlledWorkflowCanonicalizationVersion = 1
): CanonicalWorkflowResult {
  if (!isRecord(input)) return { ok: false, issues: [{ code: 'INVALID_WORKFLOW', path: '/', message: 'workflow must be an object' }] }
  const issues: CanonicalWorkflowIssue[] = []
  const workflowId = typeof input.id === 'string' && input.id.length > 0 ? input.id : ''
  if (!workflowId) issues.push({ code: 'INVALID_WORKFLOW_ID', path: '/id', message: 'workflow ID is required' })
  if (!Array.isArray(input.nodes)) issues.push({ code: 'INVALID_NODES', path: '/nodes', message: 'nodes must be an array' })

  const nodes: CanonicalWorkflowNode[] = []
  const ids = new Set<string>()
  const idsByName = new Map<string, string>()
  const credentials: CredentialReference[] = []
  const webhooks: ProtectedTriggerSnapshot[] = []
  const schedules: ProtectedTriggerSnapshot[] = []

  if (Array.isArray(input.nodes)) input.nodes.forEach((value, index) => {
    const basePath = `/nodes/${index}`
    if (!isRecord(value)) {
      issues.push({ code: 'INVALID_NODE', path: basePath, message: 'node must be an object' })
      return
    }
    const id = typeof value.id === 'string' && value.id.length > 0 ? value.id : ''
    const name = typeof value.name === 'string' && value.name.length > 0 ? value.name : ''
    const type = typeof value.type === 'string' && value.type.length > 0 ? value.type : ''
    if (!id) issues.push({ code: 'INVALID_NODE_ID', path: `${basePath}/id`, message: 'node ID is required' })
    if (!name) issues.push({ code: 'INVALID_NODE_NAME', path: `${basePath}/name`, message: 'node name is required' })
    if (!type) issues.push({ code: 'INVALID_NODE_TYPE', path: `${basePath}/type`, message: 'node type is required' })
    if (id && ids.has(id)) issues.push({ code: 'DUPLICATE_NODE_ID', path: `${basePath}/id`, message: 'node IDs must be unique' })
    if (name && idsByName.has(name)) issues.push({ code: 'DUPLICATE_NODE_NAME', path: `${basePath}/name`, message: 'node names must be unique' })
    if (id) ids.add(id)
    if (id && name) idsByName.set(name, id)
    const parameters = canonicalJson(value.parameters ?? {}, `${basePath}/parameters`, issues) ?? {}
    const node: CanonicalWorkflowNode = {
      id,
      name,
      type,
      typeVersion: typeof value.typeVersion === 'number' || typeof value.typeVersion === 'string' ? value.typeVersion : null,
      disabled: value.disabled === true,
      parameters
    }
    nodes.push(node)
    if (id) credentials.push(...credentialReferences(value, id))
    const lowerType = type.toLowerCase()
    if (id && lowerType.includes('webhook')) webhooks.push({ nodeId: id, nodeType: type, parameters })
    if (id && (lowerType.includes('schedule') || lowerType.includes('cron'))) schedules.push({ nodeId: id, nodeType: type, parameters })
  })

  const connections = extractConnections(input, idsByName, issues)
  const sharingKey = Object.prototype.hasOwnProperty.call(input, 'shared') ? 'shared' : Object.prototype.hasOwnProperty.call(input, 'sharing') ? 'sharing' : ''
  const protectedSnapshot: ProtectedWorkflowSnapshot = {
    canonicalizationVersion,
    workflowId,
    activation: presence(input, 'active', '/active', issues),
    settings: presence(input, 'settings', '/settings', issues),
    tags: presence(input, 'tags', '/tags', issues),
    sharing: canonicalizationVersion === 2
      ? semanticSharingPresence(input, workflowId, issues)
      : sharingKey ? presence(input, sharingKey, `/${sharingKey}`, issues) : { state: 'missing' },
    credentials: credentials.sort((a, b) => compareText(JSON.stringify([a.nodeId, a.credentialType]), JSON.stringify([b.nodeId, b.credentialType]))),
    webhooks: webhooks.sort((a, b) => compareText(a.nodeId, b.nodeId)),
    schedules: schedules.sort((a, b) => compareText(a.nodeId, b.nodeId))
  }
  if (issues.length > 0) return { ok: false, issues: issues.slice(0, 100) }
  nodes.sort((a, b) => compareText(a.id, b.id))
  return { ok: true, topology: { canonicalizationVersion, workflowId, nodes, connections }, protected: protectedSnapshot }
}

export function hashCanonicalWorkflowTopology(topology: CanonicalWorkflowTopology, digest: Sha256Digest): string {
  const hash = digest(stableSerializeCanonicalValue(topology))
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('digest must return a lowercase SHA-256 hex value')
  return hash
}

function jsonDiff(before: CanonicalJsonValue, after: CanonicalJsonValue, path: string): string[] {
  if (stableSerializeCanonicalValue(before) === stableSerializeCanonicalValue(after)) return []
  if (Array.isArray(before) || Array.isArray(after) || before === null || after === null || typeof before !== 'object' || typeof after !== 'object') return [path]
  const left = before as Record<string, CanonicalJsonValue>
  const right = after as Record<string, CanonicalJsonValue>
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
  return keys.flatMap(key => {
    const childPath = `${path}/${pointerToken(key)}`
    if (!Object.prototype.hasOwnProperty.call(left, key) || !Object.prototype.hasOwnProperty.call(right, key)) return [childPath]
    return jsonDiff(left[key], right[key], childPath)
  })
}

function nodeDiff(before: CanonicalWorkflowNode, after: CanonicalWorkflowNode): string[] {
  return jsonDiff(
    { name: before.name, type: before.type, typeVersion: before.typeVersion, disabled: before.disabled, parameters: before.parameters },
    { name: after.name, type: after.type, typeVersion: after.typeVersion, disabled: after.disabled, parameters: after.parameters },
    ''
  )
}

function parameterPointers(value: CanonicalJsonValue, path = '/parameters'): string[] {
  if (Array.isArray(value) || value === null || typeof value !== 'object') return [path]
  const entries = Object.entries(value)
  return entries.length === 0 ? [] : entries.flatMap(([key, child]) => parameterPointers(child, `${path}/${pointerToken(key)}`))
}

const difference = (left: Set<string>, right: Set<string>) => [...left].filter(value => !right.has(value)).sort()

export type ControlledWorkflowComparison = {
  ok: boolean
  liveCanonicalSha256?: string
  candidateCanonicalSha256?: string
  issues: CanonicalWorkflowIssue[]
}

export function compareControlledWorkflowCandidate(params: {
  live: unknown
  candidate: unknown
  manifest: ControlledWorkflowTopologyManifest
  digest: Sha256Digest
}): ControlledWorkflowComparison {
  const version = params.manifest.workflow.canonicalizationVersion
  const live = canonicalizeN8nWorkflow(params.live, version)
  const candidate = canonicalizeN8nWorkflow(params.candidate, version)
  const issues: CanonicalWorkflowIssue[] = []
  if (live.ok === false || candidate.ok === false) {
    if (live.ok === false) issues.push(...live.issues.map(issue => ({ ...issue, path: `/live${issue.path}` })))
    if (candidate.ok === false) issues.push(...candidate.issues.map(issue => ({ ...issue, path: `/candidate${issue.path}` })))
    return { ok: false, issues: issues.slice(0, 100) }
  }

  if (live.topology.workflowId !== params.manifest.workflow.id || candidate.topology.workflowId !== params.manifest.workflow.id) issues.push({ code: 'WORKFLOW_ID_MISMATCH', path: '/workflow/id', message: 'workflow identity does not match the manifest' })
  const liveHash = hashCanonicalWorkflowTopology(live.topology, params.digest)
  const candidateHash = hashCanonicalWorkflowTopology(candidate.topology, params.digest)
  if (liveHash !== params.manifest.workflow.expectedLiveCanonicalSha256) issues.push({ code: 'LIVE_HASH_MISMATCH', path: '/workflow/expectedLiveCanonicalSha256', message: 'live canonical hash does not match the manifest' })
  if (candidateHash !== params.manifest.workflow.candidateCanonicalSha256) issues.push({ code: 'CANDIDATE_HASH_MISMATCH', path: '/workflow/candidateCanonicalSha256', message: 'candidate canonical hash does not match the manifest' })

  const liveNodes = new Map(live.topology.nodes.map(node => [node.id, node]))
  const candidateNodes = new Map(candidate.topology.nodes.map(node => [node.id, node]))
  const actualAdd = new Set([...candidateNodes.keys()].filter(id => !liveNodes.has(id)))
  const actualRemove = new Set([...liveNodes.keys()].filter(id => !candidateNodes.has(id)))
  const declaredAdd = new Map(params.manifest.nodes.add.map(node => [node.id, node]))
  const declaredRemove = new Set(params.manifest.nodes.remove.map(node => node.id))
  const declaredModify = new Map(params.manifest.nodes.modify.map(node => [node.id, new Set(node.allowedJsonPointers)]))

  difference(actualAdd, new Set(declaredAdd.keys())).forEach(id => issues.push({ code: 'UNDECLARED_NODE_ADDITION', path: `/nodes/${id}`, message: 'node addition is not declared' }))
  difference(new Set(declaredAdd.keys()), actualAdd).forEach(id => issues.push({ code: 'MISSING_NODE_ADDITION', path: `/manifest/nodes/add/${id}`, message: 'declared node addition did not occur' }))
  difference(actualRemove, declaredRemove).forEach(id => issues.push({ code: 'UNDECLARED_NODE_REMOVAL', path: `/nodes/${id}`, message: 'node removal is not declared' }))
  difference(declaredRemove, actualRemove).forEach(id => issues.push({ code: 'MISSING_NODE_REMOVAL', path: `/manifest/nodes/remove/${id}`, message: 'declared node removal did not occur' }))

  for (const id of actualAdd) {
    const declaration = declaredAdd.get(id)
    const node = candidateNodes.get(id)
    if (!declaration || !node) continue
    if (declaration.name !== node.name || declaration.type !== node.type) issues.push({ code: 'NODE_ADDITION_ASSERTION_MISMATCH', path: `/nodes/${id}`, message: 'added node name or type does not match the manifest' })
    const actualPointers = new Set(parameterPointers(node.parameters))
    const declaredPointers = new Set(declaration.allowedParameterPointers)
    difference(actualPointers, declaredPointers).forEach(pointer => issues.push({ code: 'UNDECLARED_ADDED_PARAMETER', path: `/nodes/${id}${pointer}`, message: 'added node parameter is not declared' }))
    difference(declaredPointers, actualPointers).forEach(pointer => issues.push({ code: 'MISSING_ADDED_PARAMETER', path: `/manifest/nodes/add/${id}${pointer}`, message: 'declared added parameter did not occur' }))
  }

  for (const [id, before] of liveNodes) {
    const after = candidateNodes.get(id)
    if (!after) continue
    const actualPointers = new Set(nodeDiff(before, after))
    const declaredPointers = declaredModify.get(id) || new Set<string>()
    difference(actualPointers, declaredPointers).forEach(pointer => issues.push({ code: 'UNDECLARED_NODE_MODIFICATION', path: `/nodes/${id}${pointer}`, message: 'node modification is not declared by an exact JSON Pointer' }))
    difference(declaredPointers, actualPointers).forEach(pointer => issues.push({ code: 'MISSING_NODE_MODIFICATION', path: `/manifest/nodes/modify/${id}${pointer}`, message: 'declared node modification did not occur' }))
  }
  for (const id of declaredModify.keys()) if (!liveNodes.has(id) || !candidateNodes.has(id)) issues.push({ code: 'INVALID_NODE_MODIFICATION_TARGET', path: `/manifest/nodes/modify/${id}`, message: 'node modification target is not present in both workflows' })

  const liveEdges = new Set(live.topology.connections.map(edgeKey))
  const candidateEdges = new Set(candidate.topology.connections.map(edgeKey))
  const actualConnectionAdd = new Set(difference(candidateEdges, liveEdges))
  const actualConnectionRemove = new Set(difference(liveEdges, candidateEdges))
  const declaredConnectionAdd = new Set(params.manifest.connections.add.map(edgeKey))
  const declaredConnectionRemove = new Set(params.manifest.connections.remove.map(edgeKey))
  difference(actualConnectionAdd, declaredConnectionAdd).forEach(() => issues.push({ code: 'UNDECLARED_CONNECTION_ADDITION', path: '/connections', message: 'connection addition is not declared' }))
  difference(declaredConnectionAdd, actualConnectionAdd).forEach(() => issues.push({ code: 'MISSING_CONNECTION_ADDITION', path: '/manifest/connections/add', message: 'declared connection addition did not occur' }))
  difference(actualConnectionRemove, declaredConnectionRemove).forEach(() => issues.push({ code: 'UNDECLARED_CONNECTION_REMOVAL', path: '/connections', message: 'connection removal is not declared' }))
  difference(declaredConnectionRemove, actualConnectionRemove).forEach(() => issues.push({ code: 'MISSING_CONNECTION_REMOVAL', path: '/manifest/connections/remove', message: 'declared connection removal did not occur' }))

  params.manifest.routes.required.forEach(route => { if (!candidateEdges.has(edgeKey(route))) issues.push({ code: 'MISSING_REQUIRED_ROUTE', path: '/routes/required', message: 'required route is absent' }) })
  params.manifest.routes.forbidden.forEach(route => { if (candidateEdges.has(edgeKey(route))) issues.push({ code: 'FORBIDDEN_ROUTE_PRESENT', path: '/routes/forbidden', message: 'forbidden route is present' }) })

  CONTROLLED_WORKFLOW_PROTECTED_DOMAINS.forEach(domain => {
    const before = live.protected[domain]
    const after = candidate.protected[domain]
    if (stableSerializeCanonicalValue(before) !== stableSerializeCanonicalValue(after)) issues.push({ code: 'PROTECTED_DOMAIN_CHANGED', path: `/invariants/${domain}`, message: `protected domain ${domain} changed` })
  })

  return { ok: issues.length === 0, liveCanonicalSha256: liveHash, candidateCanonicalSha256: candidateHash, issues: issues.slice(0, 100) }
}
