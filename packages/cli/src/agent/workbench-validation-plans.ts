import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  canonicalValidationPlanNodeIds,
  parseValidationPlanV1,
  validationNodeExecutionKey,
  type ValidationPlanNode,
  type ValidationPlanV1
} from '@workbench/shared'
import { getConfigDir } from '../utils/paths'
import {
  acquireWorkbenchAdmission,
  releaseWorkbenchAdmission,
  type WorkbenchAdmissionLease,
  type WorkbenchAdmissionOperation,
  type WorkbenchAdmissionOptions
} from './workbench-admission-orchestrator'
import {
  cancelWorkbenchValidationJob,
  getCompactWorkbenchValidationJob,
  scheduleWorkbenchValidationJob,
  submitWorkbenchValidationJob,
  type CompactWorkbenchValidationJob,
  type WorkbenchValidationJobRequest
} from './workbench-validation-jobs'

export const WORKBENCH_VALIDATION_PLAN_STORE_VERSION = 1 as const

export type WorkbenchValidationPlanNodeStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'cancel_requested'
  | 'cancelled'
  | 'dependency_blocked'

export type WorkbenchValidationPlanStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'cancel_requested'
  | 'cancelled'

export type WorkbenchValidationPlanNodeEvidence = {
  exitCode: number | null
  signal: string | null
  durationMs: number
  stdout: string
  stderr: string
  outputTruncated: boolean
  changedPaths: string[]
  terminationReason?: string
}

export type WorkbenchValidationPlanNodeRecord = {
  nodeId: string
  status: WorkbenchValidationPlanNodeStatus
  executionKey: string
  validationJobId?: string
  admissionLease?: WorkbenchAdmissionLease
  createdAt: string
  startedAt?: string
  completedAt?: string
  cancelRequestedAt?: string
  cancelledAt?: string
  dependencyBlockedReason?: string
  cancellationReason?: string
  evidence?: WorkbenchValidationPlanNodeEvidence
}

export type WorkbenchValidationPlanRecord = {
  version: typeof WORKBENCH_VALIDATION_PLAN_STORE_VERSION
  planId: string
  planFingerprint: string
  sourceId: string
  expectedHead: string
  runId?: string
  packetId?: string
  taskId?: string
  status: WorkbenchValidationPlanStatus
  canonicalNodeOrder: string[]
  plan: ValidationPlanV1
  nodes: WorkbenchValidationPlanNodeRecord[]
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
  cancelRequestedAt?: string
  cancelledAt?: string
  cancellationReason?: string
  failureReason?: string
}

type WorkbenchValidationPlanStore = {
  version: typeof WORKBENCH_VALIDATION_PLAN_STORE_VERSION
  plans: WorkbenchValidationPlanRecord[]
}

export type WorkbenchValidationPlanStoreOptions = {
  storePath?: string
  now?: () => string
}

export type WorkbenchValidationResourcePressure = 'normal' | 'warning' | 'critical' | 'unknown' | 'stale' | 'missing'

export type WorkbenchValidationPlanCoordinatorOptions = WorkbenchValidationPlanStoreOptions & {
  maxConcurrentNodes?: number
  resourcePressure?: WorkbenchValidationResourcePressure
  admissionOptions?: WorkbenchAdmissionOptions
}

export type WorkbenchValidationPlanCoordinatorDependencies = {
  readHead?: (sourceRoot: string) => string
  acquireAdmission?: typeof acquireWorkbenchAdmission
  releaseAdmission?: typeof releaseWorkbenchAdmission
  resourcePressure?: () => WorkbenchValidationResourcePressure
  submitJob?: typeof submitWorkbenchValidationJob
  getJob?: typeof getCompactWorkbenchValidationJob
  scheduleJob?: typeof scheduleWorkbenchValidationJob
  cancelJob?: typeof cancelWorkbenchValidationJob
}

export type SubmitWorkbenchValidationPlanResult =
  | { ok: true; created: boolean; plan: WorkbenchValidationPlanRecord }
  | { ok: false; code: 'VALIDATION_PLAN_INVALID' | 'VALIDATION_PLAN_CONFLICT' | 'VALIDATION_PLAN_STORE_BUSY' | 'VALIDATION_PLAN_STORE_CORRUPT'; message: string }

export type AdvanceWorkbenchValidationPlanResult =
  | {
      ok: true
      plan: WorkbenchValidationPlanRecord
      admittedNodeId?: string
      waitingForJob?: string
      admittedNodeIds?: string[]
      waitingForJobs?: string[]
    }
  | { ok: false; code: string; message: string; plan?: WorkbenchValidationPlanRecord }

function now(options: WorkbenchValidationPlanStoreOptions): string {
  return options.now?.() ?? new Date().toISOString()
}

function storePath(options: WorkbenchValidationPlanStoreOptions): string {
  return options.storePath ?? path.join(getConfigDir(), 'workbench-validation-plans.json')
}

function lockPath(options: WorkbenchValidationPlanStoreOptions): string {
  return `${storePath(options)}.lock`
}

function emptyStore(): WorkbenchValidationPlanStore {
  return { version: WORKBENCH_VALIDATION_PLAN_STORE_VERSION, plans: [] }
}

function readStore(options: WorkbenchValidationPlanStoreOptions): WorkbenchValidationPlanStore {
  const file = storePath(options)
  if (!fs.existsSync(file)) return emptyStore()
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`Validation plan store is unreadable: ${String(error)}`)
  }
  if (!parsed || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== WORKBENCH_VALIDATION_PLAN_STORE_VERSION || !Array.isArray((parsed as { plans?: unknown }).plans)) {
    throw new Error('Validation plan store has an unsupported or corrupt schema.')
  }
  return {
    version: WORKBENCH_VALIDATION_PLAN_STORE_VERSION,
    plans: (parsed as { plans: unknown[] }).plans.map(validatePersistedPlanRecord)
  }
}

function persistStore(store: WorkbenchValidationPlanStore, options: WorkbenchValidationPlanStoreOptions): void {
  const file = storePath(options)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temp, file)
  try { fs.chmodSync(file, 0o600) } catch {}
}

function withStoreLock<T>(options: WorkbenchValidationPlanStoreOptions, operation: () => T): T | undefined {
  const lock = lockPath(options)
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 })
  let fd: number | undefined
  try {
    fd = fs.openSync(lock, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined
    throw error
  }
  try {
    return operation()
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    try { fs.unlinkSync(lock) } catch {}
  }
}

function stablePlanFingerprint(plan: ValidationPlanV1): string {
  const canonicalOrder = canonicalValidationPlanNodeIds(plan)
  const byId = new Map(plan.nodes.map(node => [node.nodeId, node]))
  const canonical = {
    ...plan,
    nodes: canonicalOrder.map(nodeId => {
      const node = byId.get(nodeId) as ValidationPlanNode
      return {
        ...node,
        dependsOn: [...node.dependsOn].sort((left, right) => left.localeCompare(right)),
        ...(node.outputPaths ? { outputPaths: [...node.outputPaths].sort((left, right) => left.localeCompare(right)) } : {})
      }
    })
  }
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

const PLAN_STATUSES = new Set<WorkbenchValidationPlanStatus>([
  'queued', 'running', 'completed', 'failed', 'timed_out', 'cancel_requested', 'cancelled'
])
const NODE_STATUSES = new Set<WorkbenchValidationPlanNodeStatus>([
  'queued', 'running', 'completed', 'failed', 'timed_out', 'cancel_requested', 'cancelled', 'dependency_blocked'
])

function validIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function validAdmissionLease(value: unknown): value is WorkbenchAdmissionLease {
  if (!value || typeof value !== 'object') return false
  const lease = value as Partial<WorkbenchAdmissionLease>
  const validId = (candidate: unknown) => typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 200
  const validProof = (candidate: unknown) => typeof candidate === 'string' && candidate.length >= 32 && candidate.length <= 256
  const repositoryPairValid = lease.repositoryRequestId === undefined && lease.repositoryLeaseProof === undefined
    || validId(lease.repositoryRequestId) && validProof(lease.repositoryLeaseProof)
  return validId(lease.requestId)
    && validId(lease.sessionId)
    && validId(lease.sourceId)
    && ['status', 'approval', 'read', 'git', 'install', 'index', 'write', 'migration_execute', 'destructive'].includes(String(lease.operation))
    && typeof lease.operationKind === 'string'
    && lease.operationKind.length > 0
    && lease.operationKind.length <= 120
    && ['status', 'approval', 'read', 'mutation'].includes(String(lease.workerClass))
    && (lease.repositoryClass === undefined || ['read_shared', 'mutation_exclusive'].includes(lease.repositoryClass))
    && validId(lease.budgetLeaseId)
    && validProof(lease.budgetLeaseProof)
    && repositoryPairValid
}

function validatePersistedPlanRecord(value: unknown): WorkbenchValidationPlanRecord {
  if (!value || typeof value !== 'object') throw new Error('Validation plan store contains a non-object plan record.')
  const record = value as WorkbenchValidationPlanRecord
  if (record.version !== WORKBENCH_VALIDATION_PLAN_STORE_VERSION) throw new Error('Validation plan record has an unsupported version.')
  const plan = parseValidationPlanV1(record.plan)
  if (record.planId !== plan.planId || record.sourceId !== plan.sourceId || record.expectedHead !== plan.expectedHead) {
    throw new Error(`Validation plan ${record.planId || '<unknown>'} identity does not match its persisted contract.`)
  }
  if (record.runId !== plan.runId || record.packetId !== plan.packetId || record.taskId !== plan.taskId) {
    throw new Error(`Validation plan ${record.planId} run/packet/task linkage does not match its persisted contract.`)
  }
  if (record.planFingerprint !== stablePlanFingerprint(plan)) throw new Error(`Validation plan ${record.planId} fingerprint mismatch.`)
  if (!PLAN_STATUSES.has(record.status)) throw new Error(`Validation plan ${record.planId} has invalid status ${String(record.status)}.`)
  if (!validIsoTimestamp(record.createdAt) || !validIsoTimestamp(record.updatedAt)) throw new Error(`Validation plan ${record.planId} has invalid timestamps.`)

  const canonicalNodeOrder = canonicalValidationPlanNodeIds(plan)
  if (JSON.stringify(record.canonicalNodeOrder) !== JSON.stringify(canonicalNodeOrder)) {
    throw new Error(`Validation plan ${record.planId} canonical node order is corrupt.`)
  }
  if (!Array.isArray(record.nodes) || record.nodes.length !== canonicalNodeOrder.length) {
    throw new Error(`Validation plan ${record.planId} node state count does not match its contract.`)
  }
  const nodeStateById = new Map(record.nodes.map(node => [node.nodeId, node]))
  if (nodeStateById.size !== record.nodes.length) throw new Error(`Validation plan ${record.planId} contains duplicate persisted node state.`)
  for (const nodeId of canonicalNodeOrder) {
    const persisted = nodeStateById.get(nodeId)
    const contractNode = plan.nodes.find(node => node.nodeId === nodeId)
    if (!persisted || !contractNode) throw new Error(`Validation plan ${record.planId} is missing persisted node ${nodeId}.`)
    if (!NODE_STATUSES.has(persisted.status)) throw new Error(`Validation plan ${record.planId} node ${nodeId} has invalid status.`)
    if (!validIsoTimestamp(persisted.createdAt)) throw new Error(`Validation plan ${record.planId} node ${nodeId} has invalid createdAt.`)
    const expectedExecutionKey = validationNodeExecutionKey({
      planId: plan.planId,
      nodeId,
      expectedHead: plan.expectedHead,
      command: contractNode.command
    })
    if (persisted.executionKey !== expectedExecutionKey) throw new Error(`Validation plan ${record.planId} node ${nodeId} execution key mismatch.`)
    if (persisted.validationJobId !== undefined && (typeof persisted.validationJobId !== 'string' || !persisted.validationJobId.trim())) {
      throw new Error(`Validation plan ${record.planId} node ${nodeId} has invalid validation job identity.`)
    }
    if (persisted.admissionLease !== undefined) {
      if (!validAdmissionLease(persisted.admissionLease)) throw new Error(`Validation plan ${record.planId} node ${nodeId} has invalid admission lease evidence.`)
      const expectedOperation = workbenchValidationPlanNodeAdmissionOperation(contractNode)
      const expectedRepositoryClass = expectedOperation === 'write' ? 'mutation_exclusive' : 'read_shared'
      const expectedAdmissionRequestId = `validation-plan-${expectedExecutionKey.slice(0, 48)}`
      if (persisted.admissionLease.sourceId !== record.sourceId
        || persisted.admissionLease.requestId !== expectedAdmissionRequestId
        || persisted.admissionLease.repositoryRequestId !== expectedAdmissionRequestId
        || persisted.admissionLease.operation !== expectedOperation
        || persisted.admissionLease.repositoryClass !== expectedRepositoryClass) {
        throw new Error(`Validation plan ${record.planId} node ${nodeId} admission lease does not match its contract.`)
      }
    }
  }
  return { ...record, plan }
}

function cloneRecord(record: WorkbenchValidationPlanRecord): WorkbenchValidationPlanRecord {
  return structuredClone(record)
}

function findNode(record: WorkbenchValidationPlanRecord, nodeId: string): WorkbenchValidationPlanNodeRecord {
  const node = record.nodes.find(candidate => candidate.nodeId === nodeId)
  if (!node) throw new Error(`Validation plan node ${nodeId} is missing from persisted state.`)
  return node
}

function planNode(record: WorkbenchValidationPlanRecord, nodeId: string): ValidationPlanNode {
  const node = record.plan.nodes.find(candidate => candidate.nodeId === nodeId)
  if (!node) throw new Error(`Validation plan node ${nodeId} is missing from the persisted contract.`)
  return node
}

function compactEvidence(job: CompactWorkbenchValidationJob): WorkbenchValidationPlanNodeEvidence | undefined {
  if (!['completed', 'failed', 'timed_out', 'cancelled'].includes(job.status)) return undefined
  return {
    exitCode: job.exitCode ?? null,
    signal: job.signal ?? null,
    durationMs: job.durationMs ?? 0,
    stdout: (job.stdout ?? '').slice(-8_000),
    stderr: (job.stderr ?? '').slice(-8_000),
    outputTruncated: job.outputTruncated ?? false,
    changedPaths: (job.changedPaths ?? []).slice(0, 100),
    ...(job.terminationReason ? { terminationReason: job.terminationReason } : {})
  }
}

function nodeStatusForJob(job: CompactWorkbenchValidationJob): WorkbenchValidationPlanNodeStatus {
  if (job.status === 'completed') return 'completed'
  if (job.status === 'timed_out') return 'timed_out'
  if (job.status === 'cancelled') return 'cancelled'
  if (job.status === 'failed') return 'failed'
  return 'running'
}

function isNodeTerminal(status: WorkbenchValidationPlanNodeStatus): boolean {
  return ['completed', 'failed', 'timed_out', 'cancelled', 'dependency_blocked'].includes(status)
}

function reconcileTerminalJob(
  record: WorkbenchValidationPlanRecord,
  nodeId: string,
  job: CompactWorkbenchValidationJob,
  timestamp: string
): void {
  if (!['completed', 'failed', 'timed_out', 'cancelled'].includes(job.status)) {
    throw new Error(`Validation job ${job.jobId} is not terminal.`)
  }
  const persisted = findNode(record, nodeId)
  persisted.status = nodeStatusForJob(job)
  persisted.completedAt = job.completedAt || timestamp
  persisted.evidence = compactEvidence(job)
  if (persisted.status !== 'completed') {
    blockDescendants(record, persisted.nodeId, `dependency ${persisted.nodeId} ended ${persisted.status}`, timestamp)
  }
}

function dependencyClosure(record: WorkbenchValidationPlanRecord, nodeId: string, memo = new Map<string, Set<string>>()): Set<string> {
  if (memo.has(nodeId)) return memo.get(nodeId) as Set<string>
  const node = planNode(record, nodeId)
  const dependencies = new Set<string>()
  for (const dependency of node.dependsOn) {
    dependencies.add(dependency)
    for (const transitive of dependencyClosure(record, dependency, memo)) dependencies.add(transitive)
  }
  memo.set(nodeId, dependencies)
  return dependencies
}

function blockDescendants(record: WorkbenchValidationPlanRecord, failedNodeId: string, reason: string, timestamp: string): void {
  const memo = new Map<string, Set<string>>()
  for (const nodeId of record.canonicalNodeOrder) {
    const persisted = findNode(record, nodeId)
    if (persisted.status !== 'queued') continue
    if (dependencyClosure(record, nodeId, memo).has(failedNodeId)) {
      persisted.status = 'dependency_blocked'
      persisted.dependencyBlockedReason = reason
      persisted.completedAt = timestamp
    }
  }
}

function finalizePlan(record: WorkbenchValidationPlanRecord, timestamp: string): void {
  const statuses = record.nodes.map(node => node.status)
  if (statuses.some(status => status === 'running' || status === 'queued' || status === 'cancel_requested')) {
    record.status = record.cancelRequestedAt ? 'cancel_requested' : 'running'
    return
  }
  if (record.cancelRequestedAt || statuses.some(status => status === 'cancelled')) {
    record.status = 'cancelled'
    record.cancelledAt = timestamp
    record.completedAt = timestamp
    return
  }
  if (statuses.some(status => status === 'timed_out')) {
    record.status = 'timed_out'
    record.completedAt = timestamp
    return
  }
  if (statuses.some(status => status === 'failed' || status === 'dependency_blocked')) {
    record.status = 'failed'
    record.completedAt = timestamp
    return
  }
  record.status = 'completed'
  record.completedAt = timestamp
}

function defaultReadHead(sourceRoot: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8', timeout: 5_000 }).trim()
}

const DEFAULT_VALIDATION_PLAN_CONCURRENCY = 2
const MAX_VALIDATION_PLAN_CONCURRENCY = 4

export function effectiveWorkbenchValidationPlanConcurrency(input: {
  maxConcurrentNodes?: number
  resourcePressure?: WorkbenchValidationResourcePressure
} = {}): number {
  const configured = Math.max(1, Math.min(input.maxConcurrentNodes ?? DEFAULT_VALIDATION_PLAN_CONCURRENCY, MAX_VALIDATION_PLAN_CONCURRENCY))
  switch (input.resourcePressure ?? 'unknown') {
    case 'critical':
      return 0
    case 'warning':
      return 1
    case 'unknown':
    case 'stale':
    case 'missing':
      return 1
    case 'normal':
      return configured
  }
}

function validationNodeAllowedByPressure(node: ValidationPlanNode, pressure: WorkbenchValidationResourcePressure): boolean {
  if (pressure === 'critical') return false
  if (pressure === 'warning' && (node.cpuClass === 'heavy' || node.memoryClass === 'large')) return false
  return true
}

function validationPathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

export function workbenchValidationPlanNodesCanOverlap(left: ValidationPlanNode, right: ValidationPlanNode): boolean {
  if (left.nodeId === right.nodeId) return false
  if (left.sideEffectClass === 'repository_mutating' || right.sideEffectClass === 'repository_mutating') return false
  if (left.artifactIsolationKey && right.artifactIsolationKey && left.artifactIsolationKey === right.artifactIsolationKey) return false
  for (const leftPath of left.outputPaths ?? []) {
    for (const rightPath of right.outputPaths ?? []) {
      if (validationPathsOverlap(leftPath, rightPath)) return false
    }
  }
  return true
}

export function workbenchValidationPlanNodeAdmissionOperation(node: ValidationPlanNode): WorkbenchAdmissionOperation {
  return node.sideEffectClass === 'repository_mutating' ? 'write' : 'read'
}

export function selectWorkbenchValidationPlanAdmissionCandidates(
  record: WorkbenchValidationPlanRecord,
  input: {
    maxConcurrentNodes?: number
    resourcePressure?: WorkbenchValidationResourcePressure
  } = {}
): string[] {
  if (record.cancelRequestedAt) return []
  const pressure = input.resourcePressure ?? 'unknown'
  const capacity = effectiveWorkbenchValidationPlanConcurrency({ maxConcurrentNodes: input.maxConcurrentNodes, resourcePressure: pressure })
  if (capacity <= 0) return []

  const activeIds = record.canonicalNodeOrder.filter(nodeId => {
    const status = findNode(record, nodeId).status
    return status === 'running' || status === 'cancel_requested'
  })
  if (activeIds.length >= capacity) return []

  const activeNodes = activeIds.map(nodeId => planNode(record, nodeId))
  const selected: ValidationPlanNode[] = []
  const remaining = capacity - activeNodes.length

  for (const nodeId of record.canonicalNodeOrder) {
    if (selected.length >= remaining) break
    const persisted = findNode(record, nodeId)
    if (persisted.status !== 'queued' || persisted.validationJobId) continue
    const node = planNode(record, nodeId)
    if (!node.dependsOn.every(dependency => findNode(record, dependency).status === 'completed')) continue
    if (!validationNodeAllowedByPressure(node, pressure)) continue
    if (!activeNodes.every(active => workbenchValidationPlanNodesCanOverlap(active, node))) continue
    if (!selected.every(candidate => workbenchValidationPlanNodesCanOverlap(candidate, node))) continue
    selected.push(node)
  }

  return selected.map(node => node.nodeId)
}

function toValidationJobRequest(record: WorkbenchValidationPlanRecord, node: ValidationPlanNode): WorkbenchValidationJobRequest {
  const common = {
    sourceId: record.sourceId,
    idempotencyKey: validationNodeExecutionKey({
      planId: record.planId,
      nodeId: node.nodeId,
      expectedHead: record.expectedHead,
      command: node.command
    }),
    timeoutMs: node.timeoutMs,
    ...(record.runId ? { runId: record.runId } : {}),
    ...(record.packetId ? { packetId: record.packetId } : {}),
    ...(record.taskId ? { taskId: record.taskId } : {}),
    networkAccess: false as const
  }
  switch (node.command.commandKind) {
    case 'type_check_web':
      return { ...common, commandKind: 'type_check_web' }
    case 'type_check_cli':
      return { ...common, commandKind: 'type_check_cli' }
    case 'run_package_script':
      return { ...common, commandKind: 'run_package_script', packageDir: node.command.packageDir, scriptName: node.command.scriptName }
    case 'run_package_test':
      return { ...common, commandKind: 'run_package_test', packageDir: node.command.packageDir }
    case 'run_package_test_marker':
      return { ...common, commandKind: 'run_package_test_marker', packageDir: node.command.packageDir, marker: node.command.marker }
    case 'run_exact_command':
      return {
        ...common,
        commandKind: 'run_exact_command',
        packageDir: node.command.packageDir,
        executable: node.command.executable,
        args: node.command.args,
        nodeVersion: node.command.nodeVersion,
        policy: node.command.policy,
        requiredBranch: node.command.requiredBranch,
        protectedPaths: node.command.protectedPaths
      }
  }
}

function resourcePressureForCoordinator(
  options: WorkbenchValidationPlanCoordinatorOptions,
  dependencies: WorkbenchValidationPlanCoordinatorDependencies
): WorkbenchValidationResourcePressure {
  return dependencies.resourcePressure?.() ?? options.resourcePressure ?? 'unknown'
}

function nodeAdmissionOptions(
  node: ValidationPlanNode,
  options: WorkbenchValidationPlanCoordinatorOptions
): WorkbenchAdmissionOptions {
  return {
    ...(options.admissionOptions ?? {}),
    leaseMs: Math.max(30_000, Math.min(node.timeoutMs + 60_000, 960_000))
  }
}

function acquireNodeAdmissionLease(params: {
  record: WorkbenchValidationPlanRecord
  nodeId: string
  sessionId: string
  options: WorkbenchValidationPlanCoordinatorOptions
  dependencies: WorkbenchValidationPlanCoordinatorDependencies
}): { ok: true; record: WorkbenchValidationPlanRecord; lease: WorkbenchAdmissionLease } | { ok: false; code: string; message: string; record?: WorkbenchValidationPlanRecord } {
  let workingRecord = params.record
  let currentNode = findNode(workingRecord, params.nodeId)
  if (currentNode.admissionLease) {
    if (currentNode.admissionLease.sessionId === params.sessionId) {
      return { ok: true, record: workingRecord, lease: currentNode.admissionLease }
    }
    const released = releaseNodeAdmissionLease({
      record: workingRecord,
      nodeId: params.nodeId,
      options: params.options,
      dependencies: params.dependencies,
      outcome: 'cancelled'
    })
    if (released.ok === false) return { ok: false, code: released.code, message: released.message, record: released.record }
    workingRecord = released.record
    currentNode = findNode(workingRecord, params.nodeId)
  }

  const contractNode = planNode(workingRecord, params.nodeId)
  const acquire = params.dependencies.acquireAdmission ?? acquireWorkbenchAdmission
  const acquired = acquire({
    requestId: `validation-plan-${currentNode.executionKey.slice(0, 48)}`,
    sessionId: params.sessionId,
    sourceId: workingRecord.sourceId,
    operation: workbenchValidationPlanNodeAdmissionOperation(contractNode),
    operationKind: 'validation_plan_node',
    cost: 1
  }, nodeAdmissionOptions(contractNode, params.options))
  if (acquired.ok === false) return { ok: false, code: acquired.code, message: acquired.message, record: workingRecord }

  let updated: WorkbenchValidationPlanRecord | null
  try {
    updated = updatePlan(workingRecord.planId, workingRecord.sourceId, params.options, planRecord => {
      const persisted = findNode(planRecord, params.nodeId)
      if (isNodeTerminal(persisted.status) || planRecord.cancelRequestedAt) return
      if (!persisted.admissionLease) persisted.admissionLease = acquired.lease
    })
  } catch (error) {
    ;(params.dependencies.releaseAdmission ?? releaseWorkbenchAdmission)(acquired.lease, nodeAdmissionOptions(contractNode, params.options), 'cancelled')
    return { ok: false, code: 'VALIDATION_PLAN_STORE_CORRUPT', message: error instanceof Error ? error.message : String(error), record: workingRecord }
  }
  if (!updated) {
    ;(params.dependencies.releaseAdmission ?? releaseWorkbenchAdmission)(acquired.lease, nodeAdmissionOptions(contractNode, params.options), 'cancelled')
    return { ok: false, code: 'VALIDATION_PLAN_STORE_BUSY', message: 'Validation plan store is busy.', record: workingRecord }
  }

  const persisted = findNode(updated, params.nodeId)
  if (!persisted.admissionLease) {
    ;(params.dependencies.releaseAdmission ?? releaseWorkbenchAdmission)(acquired.lease, nodeAdmissionOptions(contractNode, params.options), 'cancelled')
    return { ok: false, code: 'VALIDATION_PLAN_ADMISSION_CANCELLED', message: 'Validation plan no longer permits node admission.', record: updated }
  }
  if (persisted.admissionLease.requestId !== acquired.lease.requestId) {
    ;(params.dependencies.releaseAdmission ?? releaseWorkbenchAdmission)(acquired.lease, nodeAdmissionOptions(contractNode, params.options), 'cancelled')
  }
  return { ok: true, record: updated, lease: persisted.admissionLease }
}

function releaseNodeAdmissionLease(params: {
  record: WorkbenchValidationPlanRecord
  nodeId: string
  options: WorkbenchValidationPlanCoordinatorOptions
  dependencies: WorkbenchValidationPlanCoordinatorDependencies
  outcome: 'released' | 'cancelled'
}): { ok: true; record: WorkbenchValidationPlanRecord } | { ok: false; code: string; message: string; record: WorkbenchValidationPlanRecord } {
  const persisted = findNode(params.record, params.nodeId)
  if (!persisted.admissionLease) return { ok: true, record: params.record }
  const contractNode = planNode(params.record, params.nodeId)
  const released = (params.dependencies.releaseAdmission ?? releaseWorkbenchAdmission)(
    persisted.admissionLease,
    nodeAdmissionOptions(contractNode, params.options),
    params.outcome
  )
  if (released.ok === false) return { ok: false, code: released.code, message: released.message, record: params.record }

  let updated: WorkbenchValidationPlanRecord | null
  try {
    updated = updatePlan(params.record.planId, params.record.sourceId, params.options, planRecord => {
      findNode(planRecord, params.nodeId).admissionLease = undefined
    })
  } catch (error) {
    return { ok: false, code: 'VALIDATION_PLAN_STORE_CORRUPT', message: error instanceof Error ? error.message : String(error), record: params.record }
  }
  if (!updated) return { ok: false, code: 'VALIDATION_PLAN_STORE_BUSY', message: 'Validation plan store is busy.', record: params.record }
  return { ok: true, record: updated }
}

export function submitWorkbenchValidationPlan(input: unknown, options: WorkbenchValidationPlanStoreOptions = {}): SubmitWorkbenchValidationPlanResult {
  let plan: ValidationPlanV1
  try {
    plan = parseValidationPlanV1(input)
  } catch (error) {
    return { ok: false, code: 'VALIDATION_PLAN_INVALID', message: error instanceof Error ? error.message : String(error) }
  }

  const fingerprint = stablePlanFingerprint(plan)
  const timestamp = now(options)
  let transition:
    | { kind: 'conflict' }
    | { kind: 'existing'; plan: WorkbenchValidationPlanRecord }
    | { kind: 'created'; plan: WorkbenchValidationPlanRecord }
    | undefined

  try {
    transition = withStoreLock(options, () => {
      const store = readStore(options)
      const existing = store.plans.find(candidate => candidate.planId === plan.planId && candidate.sourceId === plan.sourceId)
      if (existing) {
        if (existing.planFingerprint !== fingerprint) return { kind: 'conflict' as const }
        return { kind: 'existing' as const, plan: cloneRecord(existing) }
      }

      const canonicalNodeOrder = canonicalValidationPlanNodeIds(plan)
      const byId = new Map(plan.nodes.map(node => [node.nodeId, node]))
      const record: WorkbenchValidationPlanRecord = {
        version: WORKBENCH_VALIDATION_PLAN_STORE_VERSION,
        planId: plan.planId,
        planFingerprint: fingerprint,
        sourceId: plan.sourceId,
        expectedHead: plan.expectedHead,
        ...(plan.runId ? { runId: plan.runId } : {}),
        ...(plan.packetId ? { packetId: plan.packetId } : {}),
        ...(plan.taskId ? { taskId: plan.taskId } : {}),
        status: 'queued',
        canonicalNodeOrder,
        plan,
        nodes: canonicalNodeOrder.map(nodeId => {
          const node = byId.get(nodeId)
          if (!node) throw new Error(`Validation plan ${plan.planId} is missing node ${nodeId}.`)
          return {
            nodeId,
            status: 'queued' as const,
            executionKey: validationNodeExecutionKey({ planId: plan.planId, nodeId, expectedHead: plan.expectedHead, command: node.command }),
            createdAt: timestamp
          }
        }),
        createdAt: timestamp,
        updatedAt: timestamp
      }
      store.plans.push(record)
      persistStore(store, options)
      return { kind: 'created' as const, plan: cloneRecord(record) }
    })
  } catch (error) {
    return { ok: false, code: 'VALIDATION_PLAN_STORE_CORRUPT', message: error instanceof Error ? error.message : String(error) }
  }

  if (!transition) return { ok: false, code: 'VALIDATION_PLAN_STORE_BUSY', message: 'Validation plan store is busy.' }
  if (transition.kind === 'conflict') return { ok: false, code: 'VALIDATION_PLAN_CONFLICT', message: 'Plan ID already exists with different content.' }
  return { ok: true, created: transition.kind === 'created', plan: transition.plan }
}

export function getWorkbenchValidationPlan(planId: string, sourceId: string, options: WorkbenchValidationPlanStoreOptions = {}): WorkbenchValidationPlanRecord | undefined {
  const store = readStore(options)
  const record = store.plans.find(candidate => candidate.planId === planId && candidate.sourceId === sourceId)
  return record ? cloneRecord(record) : undefined
}

function updatePlan(
  planId: string,
  sourceId: string,
  options: WorkbenchValidationPlanStoreOptions,
  mutate: (record: WorkbenchValidationPlanRecord, timestamp: string) => void
): WorkbenchValidationPlanRecord | undefined {
  const transition = withStoreLock(options, () => {
    const store = readStore(options)
    const record = store.plans.find(candidate => candidate.planId === planId && candidate.sourceId === sourceId)
    if (!record) return undefined
    const timestamp = now(options)
    mutate(record, timestamp)
    record.updatedAt = timestamp
    persistStore(store, options)
    return cloneRecord(record)
  })
  return transition
}

function isPlanTerminal(status: WorkbenchValidationPlanStatus): boolean {
  return ['completed', 'failed', 'timed_out', 'cancelled'].includes(status)
}

function markWorkbenchValidationPlanStaleHead(
  record: WorkbenchValidationPlanRecord,
  observedHead: string,
  options: WorkbenchValidationPlanStoreOptions
): WorkbenchValidationPlanRecord | null {
  return updatePlan(record.planId, record.sourceId, options, (planRecord, timestamp) => {
    planRecord.failureReason = `stale HEAD: expected ${planRecord.expectedHead}, observed ${observedHead}`
    for (const node of planRecord.nodes) {
      if (node.status !== 'queued') continue
      node.status = 'dependency_blocked'
      node.dependencyBlockedReason = planRecord.failureReason
      node.completedAt = timestamp
    }
    finalizePlan(planRecord, timestamp)
  })
}

export function cancelWorkbenchValidationPlan(params: {
  planId: string
  sourceId: string
  reason?: string
}, options: WorkbenchValidationPlanCoordinatorOptions = {}, dependencies: WorkbenchValidationPlanCoordinatorDependencies = {}): AdvanceWorkbenchValidationPlanResult {
  const reason = String(params.reason || 'validation plan cancellation requested').slice(0, 500)
  let record: WorkbenchValidationPlanRecord | null
  try {
    record = updatePlan(params.planId, params.sourceId, options, (planRecord, timestamp) => {
      if (['completed', 'failed', 'timed_out', 'cancelled'].includes(planRecord.status)) return
      planRecord.status = 'cancel_requested'
      planRecord.cancelRequestedAt ||= timestamp
      planRecord.cancellationReason = reason
      for (const node of planRecord.nodes) {
        if (node.status === 'queued') {
          node.status = 'cancelled'
          node.cancelRequestedAt = timestamp
          node.cancelledAt = timestamp
          node.cancellationReason = reason
          node.completedAt = timestamp
        } else if (node.status === 'running') {
          node.status = 'cancel_requested'
          node.cancelRequestedAt ||= timestamp
          node.cancellationReason = reason
        }
      }
      finalizePlan(planRecord, timestamp)
    })
  } catch (error) {
    return { ok: false, code: 'VALIDATION_PLAN_STORE_CORRUPT', message: error instanceof Error ? error.message : String(error) }
  }
  if (!record) return { ok: false, code: 'VALIDATION_PLAN_NOT_FOUND', message: 'Validation plan was not found.' }

  for (const nodeId of record.canonicalNodeOrder) {
    let persisted = findNode(record, nodeId)
    if (persisted.status === 'cancelled' && persisted.admissionLease) {
      const released = releaseNodeAdmissionLease({ record, nodeId, options, dependencies, outcome: 'cancelled' })
      if (released.ok === false) return { ok: false, code: released.code, message: released.message, plan: released.record }
      record = released.record
      persisted = findNode(record, nodeId)
    }

    if (persisted.status !== 'cancel_requested' || !persisted.validationJobId) continue
    const cancelled = (dependencies.cancelJob ?? cancelWorkbenchValidationJob)({
      jobId: persisted.validationJobId,
      sourceId: record.sourceId,
      reason
    })
    if (cancelled.ok === false) return { ok: false, code: cancelled.code, message: cancelled.message, plan: record }
    if (!['completed', 'failed', 'timed_out', 'cancelled'].includes(cancelled.job.status)) continue

    const released = releaseNodeAdmissionLease({
      record,
      nodeId,
      options,
      dependencies,
      outcome: cancelled.job.status === 'completed' ? 'released' : 'cancelled'
    })
    if (released.ok === false) return { ok: false, code: released.code, message: released.message, plan: released.record }
    record = released.record
    const reconciled = updatePlan(record.planId, record.sourceId, options, (planRecord, timestamp) => {
      reconcileTerminalJob(planRecord, nodeId, cancelled.job, timestamp)
      finalizePlan(planRecord, timestamp)
    })
    if (!reconciled) return { ok: false, code: 'VALIDATION_PLAN_STORE_BUSY', message: 'Validation plan store is busy.', plan: record }
    record = reconciled
  }

  return { ok: true, plan: getWorkbenchValidationPlan(record.planId, record.sourceId, options) ?? record }
}

export async function advanceWorkbenchValidationPlan(params: {
  planId: string
  sourceId: string
  sessionId: string
  sourceRoot: string
}, options: WorkbenchValidationPlanCoordinatorOptions = {}, dependencies: WorkbenchValidationPlanCoordinatorDependencies = {}): Promise<AdvanceWorkbenchValidationPlanResult> {
  const getJob = dependencies.getJob ?? getCompactWorkbenchValidationJob
  const submitJob = dependencies.submitJob ?? submitWorkbenchValidationJob
  const scheduleJob = dependencies.scheduleJob ?? scheduleWorkbenchValidationJob
  const cancelJob = dependencies.cancelJob ?? cancelWorkbenchValidationJob
  const readHead = dependencies.readHead ?? defaultReadHead
  const waitingForJobs: string[] = []
  const admittedNodeIds: string[] = []

  let record: WorkbenchValidationPlanRecord
  try {
    const current = getWorkbenchValidationPlan(params.planId, params.sourceId, options)
    if (!current) return { ok: false, code: 'VALIDATION_PLAN_NOT_FOUND', message: 'Validation plan was not found.' }
    record = current
  } catch (error) {
    return { ok: false, code: 'VALIDATION_PLAN_STORE_CORRUPT', message: String(error) }
  }

  for (const nodeId of record.canonicalNodeOrder) {
    const persisted = findNode(record, nodeId)
    if (!isNodeTerminal(persisted.status) || !persisted.admissionLease) continue
    const released = releaseNodeAdmissionLease({
      record,
      nodeId,
      options,
      dependencies,
      outcome: persisted.status === 'completed' ? 'released' : 'cancelled'
    })
    if (released.ok === false) return { ok: false, code: released.code, message: released.message, plan: released.record }
    record = released.record
  }

  if (isPlanTerminal(record.status)) return { ok: true, plan: record }

  for (const nodeId of record.canonicalNodeOrder) {
    let persisted = findNode(record, nodeId)
    if (persisted.status !== 'running' && persisted.status !== 'cancel_requested') continue
    if (!persisted.validationJobId) {
      return { ok: false, code: 'VALIDATION_PLAN_STATE_CORRUPT', message: `Active node ${nodeId} has no validation job ID.`, plan: record }
    }

    let job = getJob(persisted.validationJobId, record.sourceId)
    if (!job) return { ok: false, code: 'VALIDATION_PLAN_JOB_MISSING', message: `Validation job ${persisted.validationJobId} is missing.`, plan: record }

    if (persisted.status === 'cancel_requested' && (job.status === 'queued' || job.status === 'running')) {
      const cancelled = cancelJob({
        jobId: job.jobId,
        sourceId: record.sourceId,
        reason: persisted.cancellationReason || record.cancellationReason || 'validation plan cancellation requested'
      })
      if (cancelled.ok === false) return { ok: false, code: cancelled.code, message: cancelled.message, plan: record }
      job = cancelled.job
    }

    if (['completed', 'failed', 'timed_out', 'cancelled'].includes(job.status)) {
      const released = releaseNodeAdmissionLease({
        record,
        nodeId,
        options,
        dependencies,
        outcome: job.status === 'completed' ? 'released' : 'cancelled'
      })
      if (released.ok === false) return { ok: false, code: released.code, message: released.message, plan: released.record }
      record = released.record
      const reconciled = updatePlan(record.planId, record.sourceId, options, (planRecord, timestamp) => {
        reconcileTerminalJob(planRecord, nodeId, job, timestamp)
        finalizePlan(planRecord, timestamp)
      })
      if (!reconciled) return { ok: false, code: 'VALIDATION_PLAN_STORE_BUSY', message: 'Validation plan store is busy.', plan: record }
      record = reconciled
      continue
    }

    if (persisted.status === 'cancel_requested') {
      waitingForJobs.push(job.jobId)
      continue
    }

    if (persisted.admissionLease?.sessionId !== params.sessionId) {
      if (persisted.admissionLease) {
        const released = releaseNodeAdmissionLease({ record, nodeId, options, dependencies, outcome: 'cancelled' })
        if (released.ok === false) return { ok: false, code: released.code, message: released.message, plan: released.record }
        record = released.record
      }
      const acquired = acquireNodeAdmissionLease({ record, nodeId, sessionId: params.sessionId, options, dependencies })
      if (acquired.ok === false) return { ok: false, code: acquired.code, message: acquired.message, plan: acquired.record ?? record }
      record = acquired.record
      persisted = findNode(record, nodeId)
    } else if (!persisted.admissionLease) {
      const acquired = acquireNodeAdmissionLease({ record, nodeId, sessionId: params.sessionId, options, dependencies })
      if (acquired.ok === false) return { ok: false, code: acquired.code, message: acquired.message, plan: acquired.record ?? record }
      record = acquired.record
      persisted = findNode(record, nodeId)
    }

    if (job.status === 'queued') {
      const scheduled = scheduleJob({
        jobId: job.jobId,
        sourceId: record.sourceId,
        sourceRoot: params.sourceRoot,
        leaseMs: Math.max(30_000, Math.min((job.timeoutMs || 300_000) + 60_000, 960_000))
      })
      if (scheduled.status === 'rejected') {
        const released = releaseNodeAdmissionLease({ record, nodeId, options, dependencies, outcome: 'cancelled' })
        if (released.ok === false) return { ok: false, code: released.code, message: released.message, plan: released.record }
        return { ok: false, code: 'VALIDATION_PLAN_JOB_SCHEDULE_REJECTED', message: scheduled.reason || 'Queued validation job could not be scheduled.', plan: released.record }
      }
    }
    waitingForJobs.push(job.jobId)
  }

  const postReconcile = getWorkbenchValidationPlan(record.planId, record.sourceId, options)
  if (postReconcile) record = postReconcile
  if (isPlanTerminal(record.status)) {
    const waiting = [...new Set(waitingForJobs)]
    return { ok: true, plan: record, waitingForJob: waiting[0], waitingForJobs: waiting }
  }

  if (record.cancelRequestedAt) {
    const cancelled = updatePlan(record.planId, record.sourceId, options, (planRecord, timestamp) => finalizePlan(planRecord, timestamp))
    if (!cancelled) return { ok: false, code: 'VALIDATION_PLAN_STORE_BUSY', message: 'Validation plan store is busy.', plan: record }
    const waiting = [...new Set(waitingForJobs)]
    return { ok: true, plan: cancelled, waitingForJob: waiting[0], waitingForJobs: waiting }
  }

  let currentHead: string
  try {
    currentHead = readHead(params.sourceRoot)
  } catch (error) {
    return { ok: false, code: 'VALIDATION_PLAN_HEAD_UNAVAILABLE', message: `Unable to read source HEAD: ${String(error)}`, plan: record }
  }
  if (currentHead !== record.expectedHead) {
    const failed = markWorkbenchValidationPlanStaleHead(record, currentHead, options)
    return { ok: false, code: 'VALIDATION_PLAN_STALE_HEAD', message: `Expected HEAD ${record.expectedHead}, observed ${currentHead}.`, plan: failed ?? record }
  }

  const pressure = resourcePressureForCoordinator(options, dependencies)
  const candidateIds = selectWorkbenchValidationPlanAdmissionCandidates(record, {
    maxConcurrentNodes: options.maxConcurrentNodes,
    resourcePressure: pressure
  })

  if (candidateIds.length === 0) {
    const finalized = updatePlan(record.planId, record.sourceId, options, (planRecord, timestamp) => finalizePlan(planRecord, timestamp))
    if (!finalized) return { ok: false, code: 'VALIDATION_PLAN_STORE_BUSY', message: 'Validation plan store is busy.', plan: record }
    const waiting = [...new Set(waitingForJobs)]
    return { ok: true, plan: finalized, waitingForJob: waiting[0], waitingForJobs: waiting }
  }

  for (const nodeId of candidateIds) {
    const latest = getWorkbenchValidationPlan(record.planId, record.sourceId, options)
    if (!latest) return { ok: false, code: 'VALIDATION_PLAN_NOT_FOUND', message: 'Validation plan disappeared during admission.', plan: record }
    record = latest
    if (record.cancelRequestedAt || isPlanTerminal(record.status)) break

    try {
      currentHead = readHead(params.sourceRoot)
    } catch (error) {
      return { ok: false, code: 'VALIDATION_PLAN_HEAD_UNAVAILABLE', message: `Unable to read source HEAD: ${String(error)}`, plan: record }
    }
    if (currentHead !== record.expectedHead) {
      const failed = markWorkbenchValidationPlanStaleHead(record, currentHead, options)
      return { ok: false, code: 'VALIDATION_PLAN_STALE_HEAD', message: `Expected HEAD ${record.expectedHead}, observed ${currentHead}.`, plan: failed ?? record }
    }

    const stillEligible = selectWorkbenchValidationPlanAdmissionCandidates(record, {
      maxConcurrentNodes: options.maxConcurrentNodes,
      resourcePressure: pressure
    }).includes(nodeId)
    if (!stillEligible) continue

    const acquired = acquireNodeAdmissionLease({ record, nodeId, sessionId: params.sessionId, options, dependencies })
    if (acquired.ok === false) {
      if (admittedNodeIds.length > 0 && ['ADMISSION_BUDGET_REJECTED', 'ADMISSION_REPOSITORY_REJECTED'].includes(acquired.code)) break
      return { ok: false, code: acquired.code, message: acquired.message, plan: acquired.record ?? record }
    }
    record = acquired.record

    const node = planNode(record, nodeId)
    const submitted = submitJob(toValidationJobRequest(record, node))
    if ('code' in submitted) {
      const released = releaseNodeAdmissionLease({ record, nodeId, options, dependencies, outcome: 'cancelled' })
      if (released.ok === false) return { ok: false, code: released.code, message: released.message, plan: released.record }
      return { ok: false, code: submitted.code, message: submitted.message, plan: released.record }
    }

    if (['completed', 'failed', 'timed_out', 'cancelled'].includes(submitted.job.status)) {
      const released = releaseNodeAdmissionLease({
        record,
        nodeId,
        options,
        dependencies,
        outcome: submitted.job.status === 'completed' ? 'released' : 'cancelled'
      })
      if (released.ok === false) return { ok: false, code: released.code, message: released.message, plan: released.record }
      record = released.record
      const linkedTerminal = updatePlan(record.planId, record.sourceId, options, (planRecord, timestamp) => {
        const persisted = findNode(planRecord, nodeId)
        if (persisted.validationJobId && persisted.validationJobId !== submitted.job.jobId) throw new Error(`Node ${nodeId} is already linked to a different validation job.`)
        persisted.validationJobId = submitted.job.jobId
        persisted.startedAt ||= submitted.job.startedAt || timestamp
        planRecord.startedAt ||= timestamp
        reconcileTerminalJob(planRecord, nodeId, submitted.job, timestamp)
        finalizePlan(planRecord, timestamp)
      })
      if (!linkedTerminal) return { ok: false, code: 'VALIDATION_PLAN_STORE_BUSY', message: 'Validation plan store is busy.', plan: record }
      record = linkedTerminal
      admittedNodeIds.push(nodeId)
      continue
    }

    const linked = updatePlan(record.planId, record.sourceId, options, (planRecord, timestamp) => {
      const persisted = findNode(planRecord, nodeId)
      if (persisted.validationJobId && persisted.validationJobId !== submitted.job.jobId) throw new Error(`Node ${nodeId} is already linked to a different validation job.`)
      persisted.validationJobId = submitted.job.jobId
      persisted.startedAt ||= submitted.job.startedAt || timestamp
      persisted.status = 'running'
      planRecord.startedAt ||= timestamp
      planRecord.status = 'running'
    })
    if (!linked) return { ok: false, code: 'VALIDATION_PLAN_STORE_BUSY', message: 'Validation plan store is busy.', plan: record }
    record = linked

    if (submitted.job.status === 'queued') {
      const scheduled = scheduleJob({
        jobId: submitted.job.jobId,
        sourceId: record.sourceId,
        sourceRoot: params.sourceRoot,
        leaseMs: Math.max(30_000, Math.min((submitted.job.timeoutMs || 300_000) + 60_000, 960_000))
      })
      if (scheduled.status === 'rejected') {
        const released = releaseNodeAdmissionLease({ record, nodeId, options, dependencies, outcome: 'cancelled' })
        if (released.ok === false) return { ok: false, code: released.code, message: released.message, plan: released.record }
        return { ok: false, code: 'VALIDATION_PLAN_JOB_SCHEDULE_REJECTED', message: scheduled.reason || 'Validation job could not be scheduled.', plan: released.record }
      }
    }

    admittedNodeIds.push(nodeId)
    waitingForJobs.push(submitted.job.jobId)
  }

  const updated = getWorkbenchValidationPlan(record.planId, record.sourceId, options) ?? record
  const waiting = [...new Set(waitingForJobs)]
  return {
    ok: true,
    plan: updated,
    admittedNodeId: admittedNodeIds[0],
    admittedNodeIds,
    waitingForJob: waiting[0],
    waitingForJobs: waiting
  }
}

export function canonicalWorkbenchValidationPlanEvidence(record: WorkbenchValidationPlanRecord): WorkbenchValidationPlanNodeRecord[] {
  const byId = new Map(record.nodes.map(node => [node.nodeId, node]))
  return record.canonicalNodeOrder.map(nodeId => structuredClone(byId.get(nodeId) as WorkbenchValidationPlanNodeRecord))
}
