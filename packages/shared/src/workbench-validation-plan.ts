import crypto from 'node:crypto'
import { z } from 'zod'
import {
  exactCommandPolicySchema,
  validationJobSubmitRequestSchema,
  workbenchSourceIdSchema
} from './workbench-command-contract'

export const WORKBENCH_VALIDATION_PLAN_VERSION = 1 as const
export const WORKBENCH_VALIDATION_PLAN_MAX_NODES = 64
export const WORKBENCH_VALIDATION_PLAN_MAX_EDGES = 256
export const WORKBENCH_VALIDATION_PLAN_MAX_TIMEOUT_MS = 900_000
export const WORKBENCH_VALIDATION_NODE_MAX_TIMEOUT_MS = 900_000
export const WORKBENCH_VALIDATION_EVIDENCE_ORDER = 'topological_lexical' as const

const safeIdSchema = z.string().trim().min(1).max(160).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/,
  'identifier contains unsupported characters'
)
const gitHeadSchema = z.string().regex(/^[0-9a-f]{7,64}$/i, 'expectedHead must be a Git commit hash')
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'value must be a lowercase SHA-256 hex digest')
const timeoutSchema = z.number().int().min(1_000).max(WORKBENCH_VALIDATION_NODE_MAX_TIMEOUT_MS)
const packageDirSchema = z.string().trim().min(1).max(500)
const scriptNameSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9:_-]+$/)
const markerSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9 _:\-()|]+$/)
const argsSchema = z.array(z.string().min(1).max(500)).max(100)
const protectedPathSchema = z.string().trim().min(1).max(1_000)
const protectedPathsSchema = z.array(protectedPathSchema).max(50)
const branchSchema = z.string().min(1).max(240).regex(/^[A-Za-z0-9._/-]+$/).refine(
  value => !value.startsWith('-') && !value.includes('..'),
  'requiredBranch must be a safe branch name'
)

function isSafeRepoRelativePath(value: string): boolean {
  if (!value || value.length > 1_000 || value.startsWith('/') || value.includes('\\')) return false
  const segments = value.split('/')
  return segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..')
}

const outputPathSchema = z.string().trim().min(1).max(1_000).refine(
  isSafeRepoRelativePath,
  'outputPaths must contain normalized repo-relative paths'
)

export const validationPlanCommandSchema = z.discriminatedUnion('commandKind', [
  z.object({ commandKind: z.literal('type_check_web') }).strict(),
  z.object({ commandKind: z.literal('type_check_cli') }).strict(),
  z.object({
    commandKind: z.literal('run_package_script'),
    packageDir: packageDirSchema,
    scriptName: scriptNameSchema
  }).strict(),
  z.object({
    commandKind: z.literal('run_package_test'),
    packageDir: packageDirSchema
  }).strict(),
  z.object({
    commandKind: z.literal('run_package_test_marker'),
    packageDir: packageDirSchema,
    marker: markerSchema
  }).strict(),
  z.object({
    commandKind: z.literal('run_exact_command'),
    packageDir: packageDirSchema.optional(),
    executable: z.enum(['node', 'pnpm', 'rg']),
    args: argsSchema,
    nodeVersion: z.literal('20').optional(),
    policy: exactCommandPolicySchema.optional(),
    protectedPaths: protectedPathsSchema.optional(),
    requiredBranch: branchSchema.optional()
  }).strict()
])

export const validationCpuClassSchema = z.enum(['light', 'normal', 'heavy'])
export const validationMemoryClassSchema = z.enum(['small', 'medium', 'large'])
export const validationSideEffectClassSchema = z.enum([
  'read_only',
  'isolated_output',
  'shared_output',
  'repository_mutating'
])

export const validationPlanNodeSchema = z.object({
  nodeId: safeIdSchema,
  dependsOn: z.array(safeIdSchema).max(WORKBENCH_VALIDATION_PLAN_MAX_NODES).default([]),
  command: validationPlanCommandSchema,
  cpuClass: validationCpuClassSchema,
  memoryClass: validationMemoryClassSchema,
  sideEffectClass: validationSideEffectClassSchema,
  outputPaths: z.array(outputPathSchema).max(50).optional(),
  artifactIsolationKey: safeIdSchema.optional(),
  inputIdentity: sha256Schema,
  cacheKey: safeIdSchema.optional(),
  timeoutMs: timeoutSchema
}).strict().superRefine((node, context) => {
  const outputPaths = node.outputPaths ?? []
  if (node.sideEffectClass === 'read_only' && (outputPaths.length > 0 || node.artifactIsolationKey)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sideEffectClass'],
      message: 'read_only nodes cannot declare outputPaths or artifactIsolationKey'
    })
  }
  if (node.sideEffectClass === 'isolated_output' && !node.artifactIsolationKey) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['artifactIsolationKey'],
      message: 'isolated_output nodes require artifactIsolationKey'
    })
  }
  if (node.sideEffectClass === 'shared_output' && outputPaths.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['outputPaths'],
      message: 'shared_output nodes require at least one outputPath'
    })
  }
  if (new Set(outputPaths).size !== outputPaths.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['outputPaths'],
      message: 'outputPaths must not contain duplicates'
    })
  }
})

const validationPlanBaseSchema = z.object({
  version: z.literal(WORKBENCH_VALIDATION_PLAN_VERSION),
  planId: safeIdSchema,
  sourceId: workbenchSourceIdSchema,
  runId: safeIdSchema.optional(),
  packetId: safeIdSchema.optional(),
  taskId: safeIdSchema.optional(),
  expectedHead: gitHeadSchema,
  createdAt: z.string().datetime({ offset: true }),
  timeoutMs: timeoutSchema.optional(),
  evidenceOrder: z.literal(WORKBENCH_VALIDATION_EVIDENCE_ORDER),
  nodes: z.array(validationPlanNodeSchema).min(1).max(WORKBENCH_VALIDATION_PLAN_MAX_NODES)
}).strict()

export type ValidationPlanCommand = z.infer<typeof validationPlanCommandSchema>
export type ValidationPlanNode = z.infer<typeof validationPlanNodeSchema>
export type ValidationPlanV1 = z.infer<typeof validationPlanBaseSchema>

function stableCanonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableCanonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableCanonicalize(child)])
  )
}

function commandFingerprint(command: ValidationPlanCommand): string {
  const canonical = JSON.stringify(stableCanonicalize(command))
  return crypto.createHash('sha256').update(canonical).digest('hex')
}

export function validationCommandFingerprint(command: ValidationPlanCommand): string {
  return commandFingerprint(validationPlanCommandSchema.parse(command))
}

export function validationNodeExecutionKey(input: {
  planId: string
  nodeId: string
  expectedHead: string
  command: ValidationPlanCommand
}): string {
  const planId = safeIdSchema.parse(input.planId)
  const nodeId = safeIdSchema.parse(input.nodeId)
  const expectedHead = gitHeadSchema.parse(input.expectedHead)
  const payload = [planId, nodeId, expectedHead, commandFingerprint(input.command)].join('\0')
  return crypto.createHash('sha256').update(payload).digest('hex')
}

function canonicalNodeOrderUnchecked(nodes: ValidationPlanNode[]): string[] | null {
  const byId = new Map(nodes.map(node => [node.nodeId, node]))
  const indegree = new Map(nodes.map(node => [node.nodeId, 0]))
  const dependents = new Map(nodes.map(node => [node.nodeId, [] as string[]]))

  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!byId.has(dependency)) return null
      indegree.set(node.nodeId, (indegree.get(node.nodeId) ?? 0) + 1)
      dependents.get(dependency)?.push(node.nodeId)
    }
  }

  const ready = nodes
    .filter(node => (indegree.get(node.nodeId) ?? 0) === 0)
    .map(node => node.nodeId)
    .sort((left, right) => left.localeCompare(right))
  const result: string[] = []

  while (ready.length > 0) {
    const nodeId = ready.shift() as string
    result.push(nodeId)
    const nextIds = [...(dependents.get(nodeId) ?? [])].sort((left, right) => left.localeCompare(right))
    for (const dependentId of nextIds) {
      const nextIndegree = (indegree.get(dependentId) ?? 0) - 1
      indegree.set(dependentId, nextIndegree)
      if (nextIndegree === 0) {
        ready.push(dependentId)
        ready.sort((left, right) => left.localeCompare(right))
      }
    }
  }

  return result.length === nodes.length ? result : null
}

function dependencyClosure(nodes: ValidationPlanNode[]): Map<string, Set<string>> {
  const byId = new Map(nodes.map(node => [node.nodeId, node]))
  const result = new Map<string, Set<string>>()

  const visit = (nodeId: string, seen: Set<string>): Set<string> => {
    if (result.has(nodeId)) return result.get(nodeId) as Set<string>
    if (seen.has(nodeId)) return new Set()
    const nextSeen = new Set(seen).add(nodeId)
    const dependencies = new Set<string>()
    for (const dependency of byId.get(nodeId)?.dependsOn ?? []) {
      dependencies.add(dependency)
      for (const transitive of visit(dependency, nextSeen)) dependencies.add(transitive)
    }
    result.set(nodeId, dependencies)
    return dependencies
  }

  for (const node of nodes) visit(node.nodeId, new Set())
  return result
}

function outputPathsConflict(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

function nodesHaveProvableOutputConflict(
  left: ValidationPlanNode,
  right: ValidationPlanNode,
  closure: Map<string, Set<string>>
): boolean {
  const leftDependencies = closure.get(left.nodeId) ?? new Set()
  const rightDependencies = closure.get(right.nodeId) ?? new Set()
  if (leftDependencies.has(right.nodeId) || rightDependencies.has(left.nodeId)) return false

  if (left.artifactIsolationKey && right.artifactIsolationKey && left.artifactIsolationKey === right.artifactIsolationKey) {
    return true
  }
  for (const leftPath of left.outputPaths ?? []) {
    for (const rightPath of right.outputPaths ?? []) {
      if (outputPathsConflict(leftPath, rightPath)) return true
    }
  }
  return false
}

function validateCommandAgainstPersistedContract(plan: ValidationPlanV1, node: ValidationPlanNode): string | null {
  const parsed = validationJobSubmitRequestSchema.safeParse({
    sourceId: plan.sourceId,
    validationJobOperation: 'submit',
    idempotencyKey: 'validation-plan-contract',
    validationJobTimeoutMs: node.timeoutMs,
    ...(plan.runId ? { runId: plan.runId } : {}),
    ...(plan.packetId ? { packetId: plan.packetId } : {}),
    ...(plan.taskId ? { taskId: plan.taskId } : {}),
    networkAccess: false,
    ...node.command
  })
  if (parsed.success) return null
  return parsed.error.issues.map(issue => issue.message).join('; ')
}

export const validationPlanV1Schema = validationPlanBaseSchema.superRefine((plan, context) => {
  const nodeIds = plan.nodes.map(node => node.nodeId)
  const seenIds = new Set<string>()
  for (let index = 0; index < nodeIds.length; index += 1) {
    const nodeId = nodeIds[index]
    if (seenIds.has(nodeId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nodes', index, 'nodeId'],
        message: `duplicate nodeId: ${nodeId}`
      })
    }
    seenIds.add(nodeId)
  }

  let edgeCount = 0
  for (let index = 0; index < plan.nodes.length; index += 1) {
    const node = plan.nodes[index]
    edgeCount += node.dependsOn.length
    const uniqueDependencies = new Set(node.dependsOn)
    if (uniqueDependencies.size !== node.dependsOn.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nodes', index, 'dependsOn'],
        message: 'dependsOn must not contain duplicate edges'
      })
    }
    if (node.dependsOn.includes(node.nodeId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nodes', index, 'dependsOn'],
        message: 'node cannot depend on itself'
      })
    }
    for (const dependency of node.dependsOn) {
      if (!seenIds.has(dependency) && !nodeIds.includes(dependency)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodes', index, 'dependsOn'],
          message: `unknown dependency target: ${dependency}`
        })
      }
    }
    const commandError = validateCommandAgainstPersistedContract(plan, node)
    if (commandError) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nodes', index, 'command'],
        message: `command violates persisted validation contract: ${commandError}`
      })
    }
  }

  if (edgeCount > WORKBENCH_VALIDATION_PLAN_MAX_EDGES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['nodes'],
      message: `validation plan may contain at most ${WORKBENCH_VALIDATION_PLAN_MAX_EDGES} dependency edges`
    })
  }

  if (plan.timeoutMs !== undefined) {
    const longestNodeTimeout = Math.max(...plan.nodes.map(node => node.timeoutMs))
    if (plan.timeoutMs < longestNodeTimeout) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['timeoutMs'],
        message: 'plan timeoutMs cannot be shorter than an individual node timeoutMs'
      })
    }
  }

  const order = canonicalNodeOrderUnchecked(plan.nodes)
  if (!order) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['nodes'], message: 'validation dependency graph contains a cycle' })
    return
  }

  const closure = dependencyClosure(plan.nodes)
  for (let leftIndex = 0; leftIndex < plan.nodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < plan.nodes.length; rightIndex += 1) {
      const left = plan.nodes[leftIndex]
      const right = plan.nodes[rightIndex]
      if (nodesHaveProvableOutputConflict(left, right, closure)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodes', rightIndex],
          message: `independent nodes ${left.nodeId} and ${right.nodeId} declare conflicting output identity`
        })
      }
    }
  }
})

export function parseValidationPlanV1(input: unknown): ValidationPlanV1 {
  return validationPlanV1Schema.parse(input)
}

export function canonicalValidationPlanNodeIds(input: ValidationPlanV1 | unknown): string[] {
  const plan = validationPlanV1Schema.parse(input)
  const order = canonicalNodeOrderUnchecked(plan.nodes)
  if (!order) throw new Error('validation dependency graph contains a cycle')
  return order
}

export function canonicalValidationPlanNodes(input: ValidationPlanV1 | unknown): ValidationPlanNode[] {
  const plan = validationPlanV1Schema.parse(input)
  const byId = new Map(plan.nodes.map(node => [node.nodeId, node]))
  return canonicalValidationPlanNodeIds(plan).map(nodeId => byId.get(nodeId) as ValidationPlanNode)
}
