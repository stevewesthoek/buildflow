import crypto from 'crypto'
import { getWorkbenchPacketRecord, listWorkbenchPacketRecords } from './workbench-packet-store'
import { getWorkbenchRepairState } from './workbench-repair-state'
import { runNextWorkbenchPacket } from './workbench-packet-worker'

export const WORKBENCH_PACKET_COORDINATOR_VERSION = 1 as const

export type WorkbenchPacketScheduleResult = {
  coordinatorVersion: typeof WORKBENCH_PACKET_COORDINATOR_VERSION
  status: 'scheduled' | 'already_scheduled' | 'rejected'
  packetId: string
  runId?: string
  sourceId?: string
  workerId?: string
  reason?: string
}

const scheduledPacketIds = new Set<string>()
let drainInProgress = false

export type WorkbenchPacketDrainResult = {
  coordinatorVersion: typeof WORKBENCH_PACKET_COORDINATOR_VERSION
  status: 'completed' | 'already_running'
  inspected: number
  scheduled: number
  alreadyScheduled: number
  rejected: number
  packetIds: string[]
}

export function scheduleWorkbenchPacket(params: {
  packetId: string
  sourceId: string
  sourceRootFor: (sourceId: string) => string | undefined
  leaseMs?: number
}): WorkbenchPacketScheduleResult {
  const packetId = String(params.packetId || '').trim()
  const sourceId = String(params.sourceId || '').trim()
  const record = getWorkbenchPacketRecord(packetId)

  if (!record || record.packet.sourceId !== sourceId) {
    return {
      coordinatorVersion: WORKBENCH_PACKET_COORDINATOR_VERSION,
      status: 'rejected',
      packetId,
      sourceId,
      reason: 'Packet was not found for the selected source.'
    }
  }
  if (record.status !== 'queued') {
    return {
      coordinatorVersion: WORKBENCH_PACKET_COORDINATOR_VERSION,
      status: 'rejected',
      packetId,
      runId: record.packet.runId,
      sourceId,
      reason: `Packet is ${record.status}; only queued packets can be scheduled.`
    }
  }
  if (scheduledPacketIds.has(packetId)) {
    return {
      coordinatorVersion: WORKBENCH_PACKET_COORDINATOR_VERSION,
      status: 'already_scheduled',
      packetId,
      runId: record.packet.runId,
      sourceId
    }
  }

  const workerId = `packet-worker-${process.pid}-${crypto.randomUUID()}`.slice(0, 160)
  scheduledPacketIds.add(packetId)
  setImmediate(() => {
    void runNextWorkbenchPacket({
      packetId,
      sourceId,
      runId: record.packet.runId,
      workerId,
      leaseMs: params.leaseMs,
      sourceRootFor: params.sourceRootFor
    }).then(async result => {
      if (!result.packetId || !result.runId) return

      const [
        { getAgentJob, evaluateWorkbenchRunBudget, recordWorkbenchRunRepairAttempt },
        { getWorkbenchContinuationDecision },
        { acceptWorkbenchRepairAttempt, getWorkbenchRepairState }
      ] = await Promise.all([
        import('./agent-jobs'),
        import('./workbench-continuation-decisions'),
        import('./workbench-repair-state')
      ])
      const decision = getWorkbenchContinuationDecision(result.packetId)
      const run = getAgentJob(result.runId)
      if (!decision || !run) return
      if (run.status !== 'running' || run.requiresConfirmation || run.activePacketId) return

      if (result.status === 'completed' && decision.outcome === 'continue' && decision.nextTaskId) {
        if (run.activeTaskId !== decision.nextTaskId) return
        const nextRecord = listWorkbenchPacketRecords({
          sourceId,
          runId: result.runId,
          limit: 100
        })
          .filter(candidate => candidate.status === 'queued' && candidate.packet.taskId === decision.nextTaskId)
          .sort((a, b) => a.reservedAt.localeCompare(b.reservedAt))[0]
        if (!nextRecord) return

        scheduleWorkbenchPacket({
          packetId: nextRecord.packet.packetId,
          sourceId,
          sourceRootFor: params.sourceRootFor,
          leaseMs: params.leaseMs
        })
        return
      }

      if (result.status !== 'failed' || decision.outcome !== 'repair') return
      const failedRecord = getWorkbenchPacketRecord(result.packetId)
      if (!failedRecord || failedRecord.packet.runId !== result.runId) return
      const taskId = failedRecord.packet.taskId
      if (run.activeTaskId !== taskId) return
      const repairState = getWorkbenchRepairState(result.runId, taskId)
      if (!repairState
        || repairState.status !== 'eligible'
        || repairState.failedPacketId !== result.packetId) return

      const repairRecord = listWorkbenchPacketRecords({
        sourceId,
        runId: result.runId,
        limit: 100
      })
        .filter(candidate => candidate.status === 'queued'
          && candidate.packet.taskId === taskId
          && candidate.packet.packetId !== result.packetId)
        .sort((a, b) => a.reservedAt.localeCompare(b.reservedAt))[0]
      if (!repairRecord || scheduledPacketIds.has(repairRecord.packet.packetId)) return

      const budgetDecision = evaluateWorkbenchRunBudget({
        runId: result.runId,
        now: new Date().toISOString(),
        operation: 'repair'
      })
      if (!budgetDecision.allowed) return

      acceptWorkbenchRepairAttempt({
        runId: result.runId,
        taskId,
        failedPacketId: result.packetId,
        repairPacketId: repairRecord.packet.packetId
      })
      recordWorkbenchRunRepairAttempt(result.runId, new Date().toISOString())
      scheduleWorkbenchPacket({
        packetId: repairRecord.packet.packetId,
        sourceId,
        sourceRootFor: params.sourceRootFor,
        leaseMs: params.leaseMs
      })
    }).finally(() => {
      scheduledPacketIds.delete(packetId)
    })
  })

  return {
    coordinatorVersion: WORKBENCH_PACKET_COORDINATOR_VERSION,
    status: 'scheduled',
    packetId,
    runId: record.packet.runId,
    sourceId,
    workerId
  }
}

export function isWorkbenchPacketScheduled(packetId: string): boolean {
  return scheduledPacketIds.has(packetId)
}




export function drainQueuedWorkbenchPackets(params: {
  sourceRootFor: (sourceId: string) => string | undefined
  sourceId?: string
  runId?: string
  limit?: number
  leaseMs?: number
}): WorkbenchPacketDrainResult {
  if (drainInProgress) {
    return {
      coordinatorVersion: WORKBENCH_PACKET_COORDINATOR_VERSION,
      status: 'already_running',
      inspected: 0,
      scheduled: 0,
      alreadyScheduled: 0,
      rejected: 0,
      packetIds: []
    }
  }

  drainInProgress = true
  try {
    const limit = Math.max(1, Math.min(20, Number(params.limit || 5)))
    const queued = listWorkbenchPacketRecords({
      sourceId: params.sourceId,
      runId: params.runId,
      limit: 100
    })
      .filter(record => {
        if (record.status !== 'queued') return false
        const repairState = getWorkbenchRepairState(record.packet.runId, record.packet.taskId)
        if (!repairState || repairState.status === 'cleared') return true
        if (repairState.status === 'accepted') {
          return repairState.acceptedRepairPacketId === record.packet.packetId
        }
        return false
      })
      .sort((a, b) => a.reservedAt.localeCompare(b.reservedAt))
      .slice(0, limit)

    let scheduled = 0
    let alreadyScheduled = 0
    let rejected = 0
    const packetIds: string[] = []

    for (const record of queued) {
      const result = scheduleWorkbenchPacket({
        packetId: record.packet.packetId,
        sourceId: record.packet.sourceId,
        sourceRootFor: params.sourceRootFor,
        leaseMs: params.leaseMs
      })
      packetIds.push(record.packet.packetId)
      if (result.status === 'scheduled') scheduled += 1
      else if (result.status === 'already_scheduled') alreadyScheduled += 1
      else rejected += 1
    }

    return {
      coordinatorVersion: WORKBENCH_PACKET_COORDINATOR_VERSION,
      status: 'completed',
      inspected: queued.length,
      scheduled,
      alreadyScheduled,
      rejected,
      packetIds
    }
  } finally {
    drainInProgress = false
  }
}
