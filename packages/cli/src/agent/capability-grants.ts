import * as path from 'node:path'
import { z } from 'zod'

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const sourceIdSchema = z.string().trim().min(1).max(160)
const workflowIdSchema = z.string().trim().min(1).max(200)
const repositoryRelativePathSchema = z.string().trim().min(1).max(1000).refine(value => {
  if (path.isAbsolute(value)) return false
  const normalized = path.posix.normalize(value.replace(/\\/g, '/'))
  return normalized !== '.' && normalized !== '..' && !normalized.startsWith('../')
}, 'path must be repository-relative and must not escape its root')

const unchangedPolicySchema = z.literal('unchanged')

export const controlledN8nWorkflowGrantSchema = z.object({
  grantId: z.string().trim().min(1).max(160),
  version: z.number().int().min(1).max(1_000_000),
  enabled: z.boolean(),
  sourceId: sourceIdSchema,
  workflowId: workflowIdSchema,
  wrapperPath: repositoryRelativePathSchema,
  wrapperSha256: sha256Schema,
  allowedCandidateRoots: z.array(repositoryRelativePathSchema).min(1).max(20),
  allowedRollbackRoots: z.array(repositoryRelativePathSchema).min(1).max(20),
  allowedManifestRoots: z.array(repositoryRelativePathSchema).min(1).max(20),
  canonicalizationVersion: z.literal(1),
  confirmationTtlSeconds: z.number().int().min(30).max(3600),
  operationTimeoutMs: z.number().int().min(1000).max(900_000),
  maxArtifactBytes: z.number().int().min(1024).max(10 * 1024 * 1024),
  maximumPolicy: z.object({
    activation: unchangedPolicySchema,
    settings: unchangedPolicySchema,
    tags: unchangedPolicySchema,
    sharing: unchangedPolicySchema,
    credentials: unchangedPolicySchema,
    webhooks: unchangedPolicySchema,
    schedules: unchangedPolicySchema,
    allowedNodeTypes: z.array(z.string().trim().min(1).max(300)).max(200).optional()
  }).strict(),
  apiOriginFingerprint: sha256Schema.optional()
}).strict()

export type ControlledN8nWorkflowGrant = z.infer<typeof controlledN8nWorkflowGrantSchema>

export type CapabilityGrantIssue = {
  index: number
  grantId?: string
  issues: Array<{ path: string; message: string }>
}

export type ControlledN8nWorkflowGrantLoadResult = {
  grants: ControlledN8nWorkflowGrant[]
  issues: CapabilityGrantIssue[]
}

function boundedIssues(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.slice(0, 20).map(issue => ({
    path: issue.path.map(String).join('.') || 'grant',
    message: issue.message.slice(0, 500)
  }))
}

export function loadControlledN8nWorkflowGrants(value: unknown): ControlledN8nWorkflowGrantLoadResult {
  if (value === undefined) return { grants: [], issues: [] }
  if (!Array.isArray(value)) {
    return {
      grants: [],
      issues: [{
        index: -1,
        issues: [{ path: 'controlledN8nWorkflowGrants', message: 'Expected an array of grants.' }]
      }]
    }
  }

  const grants: ControlledN8nWorkflowGrant[] = []
  const issues: CapabilityGrantIssue[] = []
  const seenGrantIds = new Set<string>()
  const seenAuthorities = new Set<string>()

  value.forEach((entry, index) => {
    const parsed = controlledN8nWorkflowGrantSchema.safeParse(entry)
    if (!parsed.success) {
      const grantId = entry && typeof entry === 'object' && !Array.isArray(entry) && typeof (entry as Record<string, unknown>).grantId === 'string'
        ? String((entry as Record<string, unknown>).grantId)
        : undefined
      issues.push({ index, grantId, issues: boundedIssues(parsed.error) })
      return
    }

    const grant = parsed.data
    const authorityKey = `${grant.sourceId}\u0000${grant.workflowId}`
    if (seenGrantIds.has(grant.grantId)) {
      issues.push({
        index,
        grantId: grant.grantId,
        issues: [{ path: 'grantId', message: 'Duplicate grantId.' }]
      })
      return
    }
    if (seenAuthorities.has(authorityKey)) {
      issues.push({
        index,
        grantId: grant.grantId,
        issues: [{ path: 'sourceId,workflowId', message: 'Only one grant may authorize a source/workflow pair.' }]
      })
      return
    }

    seenGrantIds.add(grant.grantId)
    seenAuthorities.add(authorityKey)
    grants.push(grant)
  })

  return { grants, issues }
}

export function findControlledN8nWorkflowGrant(
  grants: ControlledN8nWorkflowGrant[],
  sourceId: string,
  workflowId: string
): ControlledN8nWorkflowGrant | undefined {
  return grants.find(grant => grant.enabled && grant.sourceId === sourceId && grant.workflowId === workflowId)
}
