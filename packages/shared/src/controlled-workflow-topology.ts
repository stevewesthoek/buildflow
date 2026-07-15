import { z } from 'zod'

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const boundedIdSchema = z.string().trim().min(1).max(200)
const boundedNameSchema = z.string().trim().min(1).max(300)
const endpointNameSchema = z.string().trim().min(1).max(160)

const repositoryRelativePathSchema = z.string().trim().min(1).max(1000).refine(value => {
  const normalized = value.replace(/\\/g, '/')
  if (normalized.startsWith('/') || normalized.startsWith('//') || /^[A-Za-z]:\//.test(normalized)) return false
  const segments = normalized.split('/')
  return segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..')
}, 'path must be a normalized repository-relative file path')

const exactJsonPointerSchema = z.string().min(1).max(1000).refine(
  value => /^(?:\/(?:[^~/]|~0|~1)*)+$/.test(value),
  'JSON Pointer must be absolute and use only RFC 6901 ~0 and ~1 escapes'
)

const protectedInvariantSchema = z.literal('unchanged')

const protectedWorkflowInvariantsSchema = z.object({
  activation: protectedInvariantSchema,
  settings: protectedInvariantSchema,
  tags: protectedInvariantSchema,
  sharing: protectedInvariantSchema,
  credentials: protectedInvariantSchema,
  webhooks: protectedInvariantSchema,
  schedules: protectedInvariantSchema
}).strict()

export const workflowConnectionSpecSchema = z.object({
  sourceNodeId: boundedIdSchema,
  sourceOutput: endpointNameSchema,
  sourceOutputIndex: z.number().int().min(0).max(10_000),
  targetNodeId: boundedIdSchema,
  targetInput: endpointNameSchema,
  targetInputIndex: z.number().int().min(0).max(10_000)
}).strict()

const nodeAdditionSchema = z.object({
  id: boundedIdSchema,
  name: boundedNameSchema,
  type: boundedNameSchema,
  allowedParameterPointers: z.array(exactJsonPointerSchema).max(200)
}).strict()

const nodeRemovalSchema = z.object({
  id: boundedIdSchema
}).strict()

const nodeModificationSchema = z.object({
  id: boundedIdSchema,
  allowedJsonPointers: z.array(exactJsonPointerSchema).min(1).max(200)
}).strict()

const connectionKey = (connection: z.infer<typeof workflowConnectionSpecSchema>): string => [
  connection.sourceNodeId,
  connection.sourceOutput,
  String(connection.sourceOutputIndex),
  connection.targetNodeId,
  connection.targetInput,
  String(connection.targetInputIndex)
].join('\u0000')

const addDuplicateIssues = <T>(
  values: T[],
  keyOf: (value: T) => string,
  path: Array<string | number>,
  label: string,
  context: z.RefinementCtx
): Set<string> => {
  const seen = new Set<string>()
  values.forEach((value, index) => {
    const key = keyOf(value)
    if (seen.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, index],
        message: `duplicate ${label}`
      })
    }
    seen.add(key)
  })
  return seen
}

export const controlledWorkflowTopologyManifestSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('n8n-controlled-topology-migration'),
  workflow: z.object({
    id: boundedIdSchema,
    canonicalizationVersion: z.literal(1),
    expectedLiveCanonicalSha256: sha256Schema,
    candidateCanonicalSha256: sha256Schema,
    rollbackCanonicalSha256: sha256Schema
  }).strict(),
  artifacts: z.object({
    candidatePath: repositoryRelativePathSchema,
    candidateSha256: sha256Schema,
    rollbackPath: repositoryRelativePathSchema,
    rollbackSha256: sha256Schema
  }).strict(),
  invariants: protectedWorkflowInvariantsSchema,
  nodes: z.object({
    add: z.array(nodeAdditionSchema).max(500),
    remove: z.array(nodeRemovalSchema).max(500),
    modify: z.array(nodeModificationSchema).max(500)
  }).strict(),
  connections: z.object({
    add: z.array(workflowConnectionSpecSchema).max(2_000),
    remove: z.array(workflowConnectionSpecSchema).max(2_000)
  }).strict(),
  routes: z.object({
    required: z.array(workflowConnectionSpecSchema).max(2_000),
    forbidden: z.array(workflowConnectionSpecSchema).max(2_000)
  }).strict()
}).strict().superRefine((manifest, context) => {
  manifest.nodes.add.forEach((node, index) => {
    addDuplicateIssues(node.allowedParameterPointers, value => value, ['nodes', 'add', index, 'allowedParameterPointers'], 'allowed parameter pointer', context)
  })
  manifest.nodes.modify.forEach((node, index) => {
    addDuplicateIssues(node.allowedJsonPointers, value => value, ['nodes', 'modify', index, 'allowedJsonPointers'], 'allowed JSON pointer', context)
  })

  const addIds = addDuplicateIssues(manifest.nodes.add, node => node.id, ['nodes', 'add'], 'node addition ID', context)
  const removeIds = addDuplicateIssues(manifest.nodes.remove, node => node.id, ['nodes', 'remove'], 'node removal ID', context)
  const modifyIds = addDuplicateIssues(manifest.nodes.modify, node => node.id, ['nodes', 'modify'], 'node modification ID', context)

  for (const id of addIds) {
    if (removeIds.has(id) || modifyIds.has(id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['nodes'], message: `node ${id} has contradictory declarations` })
    }
  }
  for (const id of removeIds) {
    if (modifyIds.has(id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['nodes'], message: `node ${id} has contradictory declarations` })
    }
  }

  const connectionAdds = addDuplicateIssues(manifest.connections.add, connectionKey, ['connections', 'add'], 'connection addition', context)
  const connectionRemoves = addDuplicateIssues(manifest.connections.remove, connectionKey, ['connections', 'remove'], 'connection removal', context)
  for (const key of connectionAdds) {
    if (connectionRemoves.has(key)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['connections'], message: 'connection is declared for both addition and removal' })
    }
  }

  const requiredRoutes = addDuplicateIssues(manifest.routes.required, connectionKey, ['routes', 'required'], 'required route', context)
  const forbiddenRoutes = addDuplicateIssues(manifest.routes.forbidden, connectionKey, ['routes', 'forbidden'], 'forbidden route', context)
  for (const key of requiredRoutes) {
    if (forbiddenRoutes.has(key)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['routes'], message: 'route is both required and forbidden' })
    }
  }
})

export type WorkflowConnectionSpec = z.infer<typeof workflowConnectionSpecSchema>
export type ControlledWorkflowTopologyManifest = z.infer<typeof controlledWorkflowTopologyManifestSchema>

export type ControlledWorkflowTopologyManifestValidation =
  | { ok: true; manifest: ControlledWorkflowTopologyManifest }
  | { ok: false; issues: Array<{ path: string; message: string }> }

export function validateControlledWorkflowTopologyManifest(value: unknown): ControlledWorkflowTopologyManifestValidation {
  const parsed = controlledWorkflowTopologyManifestSchema.safeParse(value)
  if (parsed.success) return { ok: true, manifest: parsed.data }
  return {
    ok: false,
    issues: parsed.error.issues.slice(0, 50).map(issue => ({
      path: issue.path.map(String).join('.') || 'manifest',
      message: issue.message.slice(0, 500)
    }))
  }
}
