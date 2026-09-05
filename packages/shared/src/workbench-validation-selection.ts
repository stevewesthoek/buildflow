import crypto from 'node:crypto'
import { z } from 'zod'
import { securityPatternSetSchema, workbenchSourceIdSchema } from './workbench-command-contract'

export const WORKBENCH_VALIDATION_SELECTION_VERSION = 1 as const
export const WORKBENCH_VALIDATION_SELECTION_MODE = 'deterministic_smallest_meaningful' as const
export const WORKBENCH_VALIDATION_SELECTOR_VERSION = 'r19.4-v1' as const
export const WORKBENCH_VALIDATION_SELECTION_MAX_SELECTED = 3

const safeIdSchema = z.string().trim().min(1).max(160).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/,
  'identifier contains unsupported characters'
)
const gitHeadSchema = z.string().regex(/^[0-9a-f]{7,64}$/i, 'expectedHead must be a Git commit hash')
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'value must be a lowercase SHA-256 hex digest')
const repoPathSchema = z.string().trim().min(1).max(1_000).refine(
  value => !value.startsWith('/') && !value.includes('\\') && value.split('/').every(part => part && part !== '.' && part !== '..'),
  'path must be normalized and repo-relative'
)
const repoPathListSchema = z.array(repoPathSchema).min(1).max(50)
const packageDirSchema = z.string().trim().min(1).max(500).refine(
  value => !value.startsWith('/') && !value.includes('\\') && (value === '.' || value.split('/').every(part => part && part !== '.' && part !== '..')),
  'packageDir must be normalized and repo-relative'
)
const scriptNameSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9:_-]+$/)
const markerSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9 _:\-()|]+$/)
const timeoutSchema = z.number().int().min(1_000).max(900_000)

export const validationSelectionCommandSchema = z.discriminatedUnion('commandKind', [
  z.object({ commandKind: z.literal('git_diff_check'), paths: repoPathListSchema }).strict(),
  z.object({ commandKind: z.literal('type_check_web') }).strict(),
  z.object({ commandKind: z.literal('type_check_cli') }).strict(),
  z.object({ commandKind: z.literal('validate_json_files'), paths: repoPathListSchema }).strict(),
  z.object({
    commandKind: z.literal('security_scan_paths'),
    paths: repoPathListSchema,
    patternSet: securityPatternSetSchema
  }).strict(),
  z.object({
    commandKind: z.literal('run_package_script'),
    packageDir: packageDirSchema,
    scriptName: scriptNameSchema
  }).strict(),
  z.object({ commandKind: z.literal('run_package_test'), packageDir: packageDirSchema }).strict(),
  z.object({
    commandKind: z.literal('run_package_test_marker'),
    packageDir: packageDirSchema,
    marker: markerSchema
  }).strict()
])

export const validationSelectionChangeClassSchema = z.enum([
  'docs_only',
  'leaf_code',
  'shared_contract',
  'json_config',
  'public_contract',
  'security_runtime',
  'write_capable',
  'mixed'
])
export const validationSelectionRiskClassSchema = z.enum(['low', 'medium', 'high', 'critical'])
export const validationSelectionReasonSchema = z.enum([
  'changed_contract',
  'dependency_impact',
  'security_boundary',
  'required_roadmap_acceptance',
  'prior_regression_relationship',
  'minimum_structural_check'
])
export const validationSelectionEscalationSchema = z.enum([
  'focused_failure',
  'shared_type_boundary_changed',
  'unexpected_changed_path',
  'public_contract_changed',
  'security_signal'
])
export const validationSelectionSkipReasonSchema = z.enum([
  'unnecessary_scope',
  'not_applicable',
  'duplicate_identity',
  'bounded_selection_limit'
])

export const validationSelectionNodeSchema = z.object({
  nodeId: safeIdSchema,
  dependsOn: z.array(safeIdSchema).max(WORKBENCH_VALIDATION_SELECTION_MAX_SELECTED).default([]),
  command: validationSelectionCommandSchema,
  required: z.boolean(),
  reason: validationSelectionReasonSchema,
  escalation: z.array(validationSelectionEscalationSchema).max(5).default([]),
  stopOnFailure: z.boolean(),
  timeoutMs: timeoutSchema,
  inputIdentity: sha256Schema,
  evidenceIdentity: sha256Schema
}).strict()

export const validationSelectionSkippedSchema = z.object({
  candidateId: safeIdSchema,
  commandKind: z.string().trim().min(1).max(80),
  reason: validationSelectionSkipReasonSchema,
  detail: z.string().trim().min(1).max(240)
}).strict()

const validationSelectionBaseSchema = z.object({
  version: z.literal(WORKBENCH_VALIDATION_SELECTION_VERSION),
  selectorVersion: z.literal(WORKBENCH_VALIDATION_SELECTOR_VERSION),
  mode: z.literal(WORKBENCH_VALIDATION_SELECTION_MODE),
  selectionId: safeIdSchema,
  sourceId: workbenchSourceIdSchema,
  runId: safeIdSchema,
  packetId: safeIdSchema,
  taskId: safeIdSchema,
  expectedHead: gitHeadSchema,
  changedPaths: repoPathListSchema,
  changedPathDigest: sha256Schema,
  declaredValidationDigest: sha256Schema,
  changeClass: validationSelectionChangeClassSchema,
  riskClass: validationSelectionRiskClassSchema,
  selected: z.array(validationSelectionNodeSchema).min(1).max(WORKBENCH_VALIDATION_SELECTION_MAX_SELECTED),
  skipped: z.array(validationSelectionSkippedSchema).max(32),
  modelDecisions: z.literal(0)
}).strict()

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

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(stableCanonicalize(value))).digest('hex')
}

export const validationSelectionV1Schema = validationSelectionBaseSchema.superRefine((selection, context) => {
  const nodeIds = selection.selected.map(node => node.nodeId)
  if (new Set(nodeIds).size !== nodeIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['selected'], message: 'selected node IDs must be unique' })
  }
  const selectedPaths = [...selection.changedPaths].sort((left, right) => left.localeCompare(right))
  if (digest(selectedPaths) !== selection.changedPathDigest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['changedPathDigest'], message: 'changedPathDigest does not match changedPaths' })
  }
  const selectedCommandIds = new Set<string>()
  for (const node of selection.selected) {
    const commandId = digest(node.command)
    if (selectedCommandIds.has(commandId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['selected'], message: 'selected validation commands must be unique' })
    }
    selectedCommandIds.add(commandId)
    for (const dependency of node.dependsOn) {
      if (!nodeIds.includes(dependency)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['selected'], message: `unknown validation dependency: ${dependency}` })
    }
  }
  const selectionId = `validation-selection-${digest({
    version: selection.version,
    selectorVersion: selection.selectorVersion,
    mode: selection.mode,
    sourceId: selection.sourceId,
    runId: selection.runId,
    packetId: selection.packetId,
    taskId: selection.taskId,
    expectedHead: selection.expectedHead,
    changedPaths: selectedPaths,
    changedPathDigest: selection.changedPathDigest,
    declaredValidationDigest: selection.declaredValidationDigest,
    changeClass: selection.changeClass,
    riskClass: selection.riskClass,
    selected: selection.selected,
    skipped: selection.skipped,
    modelDecisions: selection.modelDecisions
  }).slice(0, 32)}`
  if (selection.selectionId !== selectionId) context.addIssue({ code: z.ZodIssueCode.custom, path: ['selectionId'], message: 'selectionId does not match semantic selection inputs' })
})

export type ValidationSelectionCommand = z.infer<typeof validationSelectionCommandSchema>
export type ValidationSelectionNode = z.infer<typeof validationSelectionNodeSchema>
export type ValidationSelectionSkipped = z.infer<typeof validationSelectionSkippedSchema>
export type ValidationSelectionV1 = z.infer<typeof validationSelectionBaseSchema>

export function parseValidationSelectionV1(input: unknown): ValidationSelectionV1 {
  return validationSelectionV1Schema.parse(input)
}

export function validationSelectionDigest(input: unknown): string {
  return digest(validationSelectionV1Schema.parse(input))
}

export function validationSelectionInputDigest(input: {
  sourceId: string
  runId: string
  packetId: string
  taskId: string
  expectedHead: string
  changedPaths: string[]
  declaredValidation: unknown[]
  capabilities: string[]
}): string {
  return digest({
    sourceId: input.sourceId,
    runId: input.runId,
    packetId: input.packetId,
    taskId: input.taskId,
    expectedHead: input.expectedHead,
    changedPaths: [...input.changedPaths].sort((left, right) => left.localeCompare(right)),
    declaredValidation: input.declaredValidation,
    capabilities: [...input.capabilities].sort((left, right) => left.localeCompare(right))
  })
}

export function validationSelectionNodeInputIdentity(input: {
  selectionInputDigest: string
  command: ValidationSelectionCommand
  reason: z.infer<typeof validationSelectionReasonSchema>
  riskClass: z.infer<typeof validationSelectionRiskClassSchema>
}): string {
  return digest(input)
}
