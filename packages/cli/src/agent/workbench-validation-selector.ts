import crypto from 'node:crypto'
import {
  validationSelectionCommandSchema,
  validationSelectionInputDigest,
  validationSelectionNodeInputIdentity,
  validationSelectionV1Schema,
  WORKBENCH_VALIDATION_SELECTION_MAX_SELECTED,
  WORKBENCH_VALIDATION_SELECTOR_VERSION,
  type ValidationSelectionCommand,
  type ValidationSelectionNode,
  type ValidationSelectionSkipped,
  type ValidationSelectionV1
} from '@workbench/shared'

type ValidationDeclaration = {
  commandKind?: unknown
  timeoutMs?: unknown
  paths?: unknown
  packageDir?: unknown
  scriptName?: unknown
  marker?: unknown
  patternSet?: unknown
}

export type ValidationSelectorInput = {
  sourceId: string
  runId: string
  packetId: string
  taskId: string
  expectedHead: string
  exactPaths: string[]
  capabilities: string[]
  declaredValidation?: unknown[]
}

export type ValidationSelectorFailure = {
  ok: false
  code: 'VALIDATION_SELECTION_INVALID' | 'VALIDATION_SELECTION_TOO_BROAD'
  message: string
  field?: string
}

export type ValidationSelectorResult =
  | { ok: true; selection: ValidationSelectionV1 }
  | ValidationSelectorFailure

import type { WorkbenchPacketValidation } from './workbench-packets'

export type ValidationSelectionPacketValidation = WorkbenchPacketValidation

type Candidate = {
  candidateId: string
  command: ValidationSelectionCommand
  reason: ValidationSelectionNode['reason']
  required: boolean
  escalation: ValidationSelectionNode['escalation']
  priority: number
  dependencyCandidateId?: string
}

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

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right))
}

function safePath(value: unknown): string | undefined {
  const normalized = text(value)
  if (!normalized || normalized.startsWith('/') || normalized.includes('\\')) return undefined
  const parts = normalized.split('/')
  if (parts.some(part => !part || part === '.' || part === '..')) return undefined
  return normalized
}

function normalizePaths(value: unknown, fallback: string[]): string[] | undefined {
  const values = value === undefined ? fallback : Array.isArray(value) ? value : undefined
  if (!values || values.length === 0) return undefined
  const normalized = values.map(safePath)
  return normalized.every(Boolean) ? sortedUnique(normalized as string[]) : undefined
}

function packageDir(value: unknown): string | undefined {
  const normalized = text(value)
  if (normalized === '.') return normalized
  return safePath(normalized)
}

function commandIdentity(command: ValidationSelectionCommand): string {
  return digest(command)
}

function commandLabel(command: ValidationSelectionCommand): string {
  if (command.commandKind === 'run_package_script') return `${command.commandKind}:${command.packageDir}:${command.scriptName}`
  if (command.commandKind === 'run_package_test') return `${command.commandKind}:${command.packageDir}`
  if (command.commandKind === 'run_package_test_marker') return `${command.commandKind}:${command.packageDir}:${command.marker}`
  return command.commandKind
}

function pathOwner(paths: string[]): string | undefined {
  const owners = sortedUnique(paths
    .map(item => item.split('/').slice(0, 2).join('/'))
    .filter(item => item === 'packages/cli' || item === 'packages/shared' || item === 'apps/web' || item.startsWith('packages/')))
  return owners.length === 1 ? owners[0] : undefined
}

function hasAny(values: string[], patterns: RegExp[]): boolean {
  return values.some(value => patterns.some(pattern => pattern.test(value)))
}

function isDocsOnly(paths: string[], capabilities: string[]): boolean {
  return paths.every(item => /\.(?:md|mdx|txt)$/i.test(item)) && !hasAny(capabilities, [/security/i, /contract/i, /write/i, /git/i, /auth/i])
}

function isJsonConfig(paths: string[]): boolean {
  return paths.length > 0 && paths.every(item => item.endsWith('.json') || item.endsWith('.jsonc'))
}

function selectionId(selection: Omit<ValidationSelectionV1, 'selectionId'>): string {
  return `validation-selection-${digest(selection).slice(0, 32)}`
}

function skipped(candidateId: string, commandKind: string, reason: ValidationSelectionSkipped['reason'], detail: string): ValidationSelectionSkipped {
  return { candidateId, commandKind, reason, detail }
}

function normalizeDeclaration(raw: unknown, exactPaths: string[], exactPathSet: Set<string>, index: number): { ok: true; command: ValidationSelectionCommand } | ValidationSelectorFailure {
  if (!raw || typeof raw !== 'object') return { ok: false, code: 'VALIDATION_SELECTION_INVALID', message: `Declared validation ${index} is not an object.`, field: `declaredValidation[${index}]` }
  const declaration = raw as ValidationDeclaration
  const commandKind = text(declaration.commandKind)
  let command: unknown
  if (commandKind === 'git_diff_check') {
    const paths = normalizePaths(declaration.paths, exactPaths)
    command = paths ? { commandKind, paths } : undefined
  } else if (commandKind === 'type_check_web' || commandKind === 'type_check_cli') {
    command = { commandKind }
  } else if (commandKind === 'validate_json_files') {
    const paths = normalizePaths(declaration.paths, exactPaths.filter(item => item.endsWith('.json')))
    command = paths ? { commandKind, paths } : undefined
  } else if (commandKind === 'security_scan_paths') {
    const paths = normalizePaths(declaration.paths, exactPaths)
    const patternSet = text(declaration.patternSet) || 'forbidden_secret_material'
    command = paths ? { commandKind, paths, patternSet } : undefined
  } else if (commandKind === 'run_package_script') {
    const packageValue = packageDir(declaration.packageDir === undefined ? '.' : declaration.packageDir)
    const scriptName = text(declaration.scriptName)
    command = packageValue && scriptName ? { commandKind, packageDir: packageValue, scriptName } : undefined
  } else if (commandKind === 'run_package_test') {
    const packageValue = packageDir(declaration.packageDir === undefined ? '.' : declaration.packageDir)
    command = packageValue ? { commandKind, packageDir: packageValue } : undefined
  } else if (commandKind === 'run_package_test_marker') {
    const packageValue = packageDir(declaration.packageDir === undefined ? '.' : declaration.packageDir)
    const marker = text(declaration.marker)
    command = packageValue && marker ? { commandKind, packageDir: packageValue, marker } : undefined
  } else {
    return { ok: false, code: 'VALIDATION_SELECTION_INVALID', message: `Unknown validation declaration: ${commandKind || '(missing commandKind)'}.`, field: `declaredValidation[${index}].commandKind` }
  }
  const parsed = validationSelectionCommandSchema.safeParse(command)
  if (!parsed.success) return { ok: false, code: 'VALIDATION_SELECTION_INVALID', message: `Declared validation ${index} is invalid: ${parsed.error.issues.map(issue => issue.message).join('; ')}`, field: `declaredValidation[${index}]` }
  if ('paths' in parsed.data && parsed.data.paths.some(item => !exactPathSet.has(item))) {
    return { ok: false, code: 'VALIDATION_SELECTION_INVALID', message: `Declared validation ${index} names a path outside the packet exact path set.`, field: `declaredValidation[${index}].paths` }
  }
  return { ok: true, command: parsed.data }
}

function reasonFor(command: ValidationSelectionCommand, explicit: boolean, shared: boolean, publicContract: boolean, security: boolean): ValidationSelectionNode['reason'] {
  if (command.commandKind === 'git_diff_check') return 'minimum_structural_check'
  if (security || command.commandKind === 'security_scan_paths') return 'security_boundary'
  if (shared || command.commandKind === 'type_check_web' || command.commandKind === 'type_check_cli') return 'dependency_impact'
  if (publicContract || command.commandKind === 'validate_json_files') return 'changed_contract'
  return explicit ? 'required_roadmap_acceptance' : 'prior_regression_relationship'
}

function candidate(
  command: ValidationSelectionCommand,
  options: Omit<Candidate, 'candidateId' | 'command'> & { candidateId?: string }
): Candidate {
  return { candidateId: options.candidateId || commandLabel(command), command, ...options }
}

export function selectSmallestMeaningfulValidation(input: ValidationSelectorInput): ValidationSelectorResult {
  const exactPaths = sortedUnique(input.exactPaths.map(safePath).filter(Boolean) as string[])
  if (exactPaths.length === 0) return { ok: false, code: 'VALIDATION_SELECTION_INVALID', message: 'Validation selection requires at least one exact changed path.', field: 'exactPaths' }
  if (exactPaths.length !== input.exactPaths.length) return { ok: false, code: 'VALIDATION_SELECTION_INVALID', message: 'Validation selection received an unsafe or duplicate exact path.', field: 'exactPaths' }
  const capabilities = sortedUnique(input.capabilities.map(text).filter(Boolean))
  const declaredValidation = Array.isArray(input.declaredValidation) ? input.declaredValidation : []
  const exactPathSet = new Set(exactPaths)
  const changeDocs = isDocsOnly(exactPaths, capabilities)
  const changeJson = isJsonConfig(exactPaths)
  const shared = exactPaths.some(item => item.startsWith('packages/shared/'))
  const publicContract = hasAny([...exactPaths, ...capabilities], [/openapi/i, /public-export/i, /public.*action/i, /gpt/i, /contract/i])
  const security = hasAny([...exactPaths, ...capabilities], [/security/i, /secret/i, /auth/i, /safe-access/i, /command-runner/i, /evidence/i, /server/i, /lifecycle/i, /policy/i, /protected_mutation/i, /network/i])
  const writeCapable = hasAny(capabilities, [/write/i, /git_add/i, /git_commit/i, /protected_mutation/i, /overwrite/i, /delete/i, /move/i])
  const changeClass: ValidationSelectionV1['changeClass'] = changeDocs ? 'docs_only' : changeJson ? 'json_config' : shared ? 'shared_contract' : publicContract ? 'public_contract' : security ? 'security_runtime' : writeCapable ? 'write_capable' : exactPaths.some(item => /\.(?:ts|tsx|js|mjs|cjs)$/i.test(item)) ? 'leaf_code' : 'mixed'
  const riskClass: ValidationSelectionV1['riskClass'] = writeCapable || security ? 'high' : publicContract || shared ? 'medium' : 'low'
  const selectionInputDigest = validationSelectionInputDigest({
    sourceId: input.sourceId,
    runId: input.runId,
    packetId: input.packetId,
    taskId: input.taskId,
    expectedHead: input.expectedHead,
    changedPaths: exactPaths,
    declaredValidation,
    capabilities
  })
  const candidates: Candidate[] = []
  const candidateKeys = new Set<string>()
  const add = (value: Candidate) => {
    const key = commandIdentity(value.command)
    if (candidateKeys.has(key)) return
    candidateKeys.add(key)
    candidates.push(value)
  }

  add(candidate({ commandKind: 'git_diff_check', paths: exactPaths }, {
    required: true,
    reason: 'minimum_structural_check',
    escalation: ['unexpected_changed_path'],
    priority: 10
  }))

  const normalizedDeclared: Array<{ command: ValidationSelectionCommand; index: number }> = []
  for (let index = 0; index < declaredValidation.length; index += 1) {
    const normalized = normalizeDeclaration(declaredValidation[index], exactPaths, exactPathSet, index)
    if (normalized.ok === false) return normalized
    normalizedDeclared.push({ command: normalized.command, index })
    add(candidate(normalized.command, {
      candidateId: `declared-${index}-${commandLabel(normalized.command)}`,
      required: true,
      reason: reasonFor(normalized.command, true, shared, publicContract, security),
      escalation: normalized.command.commandKind === 'security_scan_paths' ? ['security_signal'] : normalized.command.commandKind === 'type_check_cli' || normalized.command.commandKind === 'type_check_web' ? ['focused_failure'] : [],
      priority: normalized.command.commandKind === 'git_diff_check' ? 10 : normalized.command.commandKind === 'security_scan_paths' ? 40 : normalized.command.commandKind === 'run_package_test' ? 35 : 20
    }))
  }

  const owner = pathOwner(exactPaths)
  if (!changeDocs && !changeJson && !publicContract && owner === 'apps/web') {
    add(candidate({ commandKind: 'type_check_web' }, { required: true, reason: 'changed_contract', escalation: ['focused_failure'], priority: 20 }))
  } else if (!changeDocs && !changeJson && !publicContract && owner === 'packages/cli') {
    add(candidate({ commandKind: 'type_check_cli' }, { required: true, reason: 'changed_contract', escalation: ['focused_failure'], priority: 20 }))
  } else if (!changeDocs && !changeJson && !publicContract && owner && owner.startsWith('packages/')) {
    const sharedPackage = owner === 'packages/shared'
    add(candidate({ commandKind: 'run_package_script', packageDir: owner, scriptName: 'type-check' }, {
      required: true,
      reason: 'dependency_impact',
      escalation: ['focused_failure', ...(sharedPackage ? ['shared_type_boundary_changed' as const] : [])],
      priority: 20
    }))
  }
  if (shared) {
    add(candidate({ commandKind: 'type_check_cli' }, {
      required: true,
      reason: 'dependency_impact',
      escalation: ['shared_type_boundary_changed', 'focused_failure'],
      priority: 25,
      dependencyCandidateId: 'run_package_script:packages/shared:type-check'
    }))
  }
  if (changeJson) {
    const jsonPaths = exactPaths.filter(item => item.endsWith('.json'))
    add(candidate({ commandKind: 'validate_json_files', paths: jsonPaths }, {
      required: true,
      reason: 'changed_contract',
      escalation: ['focused_failure'],
      priority: 20
    }))
  }
  if (publicContract) {
    add(candidate({ commandKind: 'run_package_script', packageDir: '.', scriptName: 'verify:gpt-actions' }, {
      required: true,
      reason: 'changed_contract',
      escalation: ['public_contract_changed', 'focused_failure'],
      priority: 20
    }))
    add(candidate({ commandKind: 'run_package_script', packageDir: '.', scriptName: 'verify:run-command-contract' }, {
      required: true,
      reason: 'changed_contract',
      escalation: ['public_contract_changed', 'focused_failure'],
      priority: 25
    }))
  }
  if (security || writeCapable) {
    add(candidate({ commandKind: 'security_scan_paths', paths: exactPaths, patternSet: security ? 'forbidden_all_high_risk' : 'forbidden_secret_material' }, {
      required: true,
      reason: 'security_boundary',
      escalation: ['security_signal', 'unexpected_changed_path'],
      priority: 40
    }))
  }
  if (writeCapable) {
    add(candidate({ commandKind: 'run_package_script', packageDir: '.', scriptName: 'verify:write-policy' }, {
      required: true,
      reason: 'security_boundary',
      escalation: ['security_signal', 'focused_failure'],
      priority: 35
    }))
  }

  const explicitIdentities = new Set(normalizedDeclared.map(item => commandIdentity(item.command)))
  const duplicateSkipped: ValidationSelectionSkipped[] = []
  const seenDeclarations = new Set<string>()
  for (const item of normalizedDeclared) {
    const identity = commandIdentity(item.command)
    if (seenDeclarations.has(identity)) duplicateSkipped.push(skipped(`declared-${item.index}`, item.command.commandKind, 'duplicate_identity', 'The same declared command has already been selected.'))
    seenDeclarations.add(identity)
  }
  const broadSkipped = [
    skipped('full-repo-test-suite', 'run_package_test', 'unnecessary_scope', 'The packet does not justify a full repository test suite.'),
    skipped('full-mcp-suite', 'run_package_test', 'unnecessary_scope', 'The packet does not justify a broad MCP suite.')
  ]
  const ordered = [...candidates].sort((left, right) => left.priority - right.priority || left.candidateId.localeCompare(right.candidateId))
  const selectedCandidates = ordered.filter((item, index, list) => list.findIndex(candidateItem => commandIdentity(candidateItem.command) === commandIdentity(item.command)) === index)
  const requiredExplicit = selectedCandidates.filter(item => explicitIdentities.has(commandIdentity(item.command)))
  if (requiredExplicit.length > WORKBENCH_VALIDATION_SELECTION_MAX_SELECTED) return { ok: false, code: 'VALIDATION_SELECTION_TOO_BROAD', message: 'Explicit validation declarations exceed the bounded smallest-meaningful selection limit.', field: 'declaredValidation' }
  const selected = selectedCandidates.slice(0, WORKBENCH_VALIDATION_SELECTION_MAX_SELECTED)
  const omittedRequired = selectedCandidates.slice(WORKBENCH_VALIDATION_SELECTION_MAX_SELECTED).filter(item => item.required && explicitIdentities.has(commandIdentity(item.command)))
  if (omittedRequired.length > 0) return { ok: false, code: 'VALIDATION_SELECTION_TOO_BROAD', message: 'Required validation declarations could not fit the bounded selection.', field: 'declaredValidation' }
  const selectedCommandIds = new Set(selected.map(item => commandIdentity(item.command)))
  const skippedSelections = [
    ...duplicateSkipped,
    ...broadSkipped,
    ...ordered.filter(item => !selectedCommandIds.has(commandIdentity(item.command))).map(item => skipped(item.candidateId, item.command.commandKind, 'bounded_selection_limit', 'This candidate was outside the bounded smallest-meaningful selection.'))
  ]
  const selectedNodesWithoutIds = selected.map((item, index) => ({ item, index }))
  const selectedNodes: ValidationSelectionNode[] = selectedNodesWithoutIds.map(({ item, index }) => {
    const nodeId = `validation-${String(index + 1).padStart(2, '0')}-${item.command.commandKind.replace(/_/g, '-')}`
    const inputIdentity = validationSelectionNodeInputIdentity({ selectionInputDigest, command: item.command, reason: item.reason, riskClass })
    return {
      nodeId,
      dependsOn: [],
      command: item.command,
      required: item.required,
      reason: item.reason,
      escalation: item.escalation,
      stopOnFailure: item.required,
      timeoutMs: item.command.commandKind === 'security_scan_paths' ? 120_000 : item.command.commandKind === 'run_package_test' ? 300_000 : 120_000,
      inputIdentity,
      evidenceIdentity: digest({ selectionInputDigest, inputIdentity, nodeId })
    }
  })
  const selectionWithoutId: Omit<ValidationSelectionV1, 'selectionId'> = {
    version: 1,
    selectorVersion: WORKBENCH_VALIDATION_SELECTOR_VERSION,
    mode: 'deterministic_smallest_meaningful',
    sourceId: input.sourceId,
    runId: input.runId,
    packetId: input.packetId,
    taskId: input.taskId,
    expectedHead: input.expectedHead,
    changedPaths: exactPaths,
    changedPathDigest: digest(exactPaths),
    declaredValidationDigest: digest(declaredValidation),
    changeClass,
    riskClass,
    selected: selectedNodes,
    skipped: skippedSelections.slice(0, 32),
    modelDecisions: 0
  }
  const selection = validationSelectionV1Schema.parse({ ...selectionWithoutId, selectionId: selectionId(selectionWithoutId) })
  return { ok: true, selection }
}

export function selectionCommandToPacketValidation(node: ValidationSelectionNode): ValidationSelectionPacketValidation {
  return { ...node.command, timeoutMs: node.timeoutMs } as ValidationSelectionPacketValidation
}
