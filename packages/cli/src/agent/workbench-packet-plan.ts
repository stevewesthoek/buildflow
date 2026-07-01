import crypto from 'crypto'
import { execFileSync } from 'child_process'
import { getWorkbenchPacketRecord } from './workbench-packet-store'
import { normalizeRepoRelativePath, validateWriteTarget } from './safe-access'

export const WORKBENCH_EXECUTION_PLAN_VERSION = 1 as const

export type WorkbenchExecutionPlanStep = {
  index: number
  operation: 'create' | 'overwrite' | 'patch' | 'append' | 'delete_file' | 'move'
  path: string
  to?: string
  contentBytes?: number
  contentHash?: string
  findHash?: string
  replaceHash?: string
}

export type WorkbenchExecutionPlanResult =
  | {
      status: 'ready'
      ready: true
      writesPerformed: false
      plan: {
        version: typeof WORKBENCH_EXECUTION_PLAN_VERSION
        packetId: string
        runId: string
        sourceId: string
        taskId: string
        expectedHead: string
        currentHead: string
        leaseOwner: string
        leaseExpiresAt: string
        exactPaths: string[]
        steps: WorkbenchExecutionPlanStep[]
        planHash: string
        plannedAt: string
      }
      errors: []
    }
  | {
      status: 'rejected'
      ready: false
      writesPerformed: false
      packetId?: string
      errors: Array<{ code: string; message: string; path?: string }>
    }

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

function currentHead(sourceRoot: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: sourceRoot,
    encoding: 'utf8',
    timeout: 3000,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function reject(packetId: string | undefined, errors: Array<{ code: string; message: string; path?: string }>): WorkbenchExecutionPlanResult {
  return { status: 'rejected', ready: false, writesPerformed: false, packetId, errors }
}

export function planWorkbenchPacketExecution(params: {
  packetId: string
  leaseToken: string
  sourceId: string
  sourceRoot: string
  nowMs?: number
}): WorkbenchExecutionPlanResult {
  const packetId = String(params.packetId || '').trim()
  const leaseToken = String(params.leaseToken || '').trim()
  const record = getWorkbenchPacketRecord(packetId)
  const errors: Array<{ code: string; message: string; path?: string }> = []

  if (!record) return reject(packetId || undefined, [{ code: 'PACKET_NOT_FOUND', message: 'packet not found' }])
  if (record.packet.sourceId !== params.sourceId) errors.push({ code: 'PACKET_SOURCE_MISMATCH', message: 'packet source does not match the selected source' })
  if (record.status !== 'running') errors.push({ code: 'PACKET_NOT_RUNNING', message: `packet is ${record.status}` })
  if (!leaseToken || record.leaseToken !== leaseToken) errors.push({ code: 'LEASE_INVALID', message: 'lease token does not match the running packet' })
  if (!record.leaseOwner) errors.push({ code: 'LEASE_OWNER_MISSING', message: 'running packet has no lease owner' })

  const nowMs = params.nowMs ?? Date.now()
  const expiresAt = record.leaseExpiresAt ? Date.parse(record.leaseExpiresAt) : Number.NaN
  if (!Number.isFinite(expiresAt)) errors.push({ code: 'LEASE_EXPIRY_MISSING', message: 'running packet has no valid lease expiry' })
  else if (expiresAt <= nowMs) errors.push({ code: 'LEASE_EXPIRED', message: 'packet execution lease has expired' })

  let head = ''
  try {
    head = currentHead(params.sourceRoot)
    if (head !== record.packet.expectedHead) {
      errors.push({ code: 'STALE_EXPECTED_HEAD', message: `expected HEAD ${record.packet.expectedHead} but repository is ${head}` })
    }
  } catch {
    errors.push({ code: 'GIT_HEAD_UNAVAILABLE', message: 'unable to resolve repository HEAD' })
  }

  const steps: WorkbenchExecutionPlanStep[] = []
  const exactPaths: string[] = []
  for (const [index, step] of record.packet.steps.entries()) {
    const normalizedPath = normalizeRepoRelativePath(step.path)
    if (!normalizedPath) {
      errors.push({ code: 'STEP_PATH_INVALID', message: 'step path must be repo-relative', path: step.path })
      continue
    }

    const normalizedTarget = step.to ? normalizeRepoRelativePath(step.to) : undefined
    if (step.to && !normalizedTarget) {
      errors.push({ code: 'MOVE_TARGET_INVALID', message: 'move target must be repo-relative', path: step.to })
    }

    const validation = validateWriteTarget({
      sourceId: record.packet.sourceId,
      sourceRoot: params.sourceRoot,
      requestedPath: normalizedPath,
      changeType: step.type,
      content: step.content ?? step.replace,
      toPath: normalizedTarget
    })
    if (validation.ok === false) {
      errors.push({ code: validation.error.code, message: validation.error.message, path: normalizedPath })
    }

    exactPaths.push(normalizedPath)
    if (normalizedTarget) exactPaths.push(normalizedTarget)
    steps.push({
      index,
      operation: step.type,
      path: normalizedPath,
      to: normalizedTarget,
      contentBytes: typeof step.content === 'string' ? Buffer.byteLength(step.content, 'utf8') : undefined,
      contentHash: typeof step.content === 'string' ? sha256(step.content) : undefined,
      findHash: typeof step.find === 'string' ? sha256(step.find) : undefined,
      replaceHash: typeof step.replace === 'string' ? sha256(step.replace) : undefined
    })
  }

  const normalizedExactPaths = Array.from(new Set(exactPaths))
  if (JSON.stringify(normalizedExactPaths) !== JSON.stringify(record.exactPaths)) {
    errors.push({ code: 'RESERVED_PATHS_MISMATCH', message: 'fresh execution paths differ from the reserved exact paths' })
  }

  if (errors.length > 0) return reject(packetId, errors)

  const plannedAt = new Date(nowMs).toISOString()
  const canonical = JSON.stringify({
    version: WORKBENCH_EXECUTION_PLAN_VERSION,
    packetId: record.packet.packetId,
    runId: record.packet.runId,
    sourceId: record.packet.sourceId,
    taskId: record.packet.taskId,
    expectedHead: record.packet.expectedHead,
    currentHead: head,
    leaseOwner: record.leaseOwner,
    leaseExpiresAt: record.leaseExpiresAt,
    exactPaths: normalizedExactPaths,
    steps
  })

  return {
    status: 'ready',
    ready: true,
    writesPerformed: false,
    plan: {
      version: WORKBENCH_EXECUTION_PLAN_VERSION,
      packetId: record.packet.packetId,
      runId: record.packet.runId,
      sourceId: record.packet.sourceId,
      taskId: record.packet.taskId,
      expectedHead: record.packet.expectedHead,
      currentHead: head,
      leaseOwner: record.leaseOwner!,
      leaseExpiresAt: record.leaseExpiresAt!,
      exactPaths: normalizedExactPaths,
      steps,
      planHash: sha256(canonical),
      plannedAt
    },
    errors: []
  }
}
