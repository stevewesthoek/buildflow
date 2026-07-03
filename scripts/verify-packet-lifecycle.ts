import assert from 'node:assert/strict'
import fs from 'fs'
import {
  reserveWorkbenchPacket,
  claimNextWorkbenchPacket,
  compactWorkbenchPacketLeaseRecord,
  getWorkbenchPacketRecord,
  renewWorkbenchPacketLease,
  releaseWorkbenchPacketLease,
  finalizeWorkbenchPacketExecution,
  recoverStaleWorkbenchPacketLeases,
  controlWorkbenchPacketsForRun
} from '../packages/cli/src/agent/workbench-packet-store'
import { startAgentJob, getAgentJob } from '../packages/cli/src/agent/agent-jobs'
import { closeWorkbenchRun } from '../packages/cli/src/agent/workbench-run-close'

const testConfigDir = String(process.env.WORKBENCH_CONFIG_DIR || '')
if (!testConfigDir || !fs.existsSync(testConfigDir)) {
  console.error('WORKBENCH_CONFIG_DIR must be set to an existing temp directory')
  process.exit(1)
}

function makePacket(packetId: string, runId = 'run-test-001', sourceId = 'source-test') {
  return {
    version: 1 as const,
    runId,
    packetId,
    idempotencyKey: `${runId}:${packetId}`,
    sourceId,
    taskId: 'task-001',
    goalSummary: 'test packet',
    expectedHead: 'abc1234',
    steps: [{ type: 'overwrite' as const, path: 'test.md', content: 'hello' }],
    createdAt: new Date().toISOString()
  }
}

function assertLeaseRedacted(output: string) {
  assert(!output.includes('lease-'), `Lease token found in output that should be redacted: ${output.slice(0, 200)}`)
}

async function testClaimTransitionsQueuedToRunning() {
  const packet = makePacket('pkt-claim-001')
  const reservation = reserveWorkbenchPacket({ packet, exactPaths: ['test.md'] })
  assert.equal(reservation.ok, true)
  if (!reservation.ok) return

  const record = getWorkbenchPacketRecord('pkt-claim-001')
  assert.equal(record?.status, 'queued')
  assert.equal(record?.claimAttempt, 0)

  const claim = claimNextWorkbenchPacket({ workerId: 'worker-a', packetId: 'pkt-claim-001' })
  assert.equal(claim.ok, true)
  if (!claim.ok) return
  assert.equal(claim.claimed, true)
  assert.equal(claim.record.status, 'running')
  assert.equal(claim.record.claimAttempt, 1)
  assert.equal(claim.record.leaseOwner, 'worker-a')
  assert(claim.record.leaseToken?.startsWith('lease-'))
  assert(claim.record.leaseExpiresAt)
  assert(new Date(claim.record.leaseExpiresAt!).getTime() > Date.now())
  console.log('  ✓ claim transitions queued to running with lease')
}

async function testClaimIncrementAttempt() {
  const packet = makePacket('pkt-claim-incr')
  reserveWorkbenchPacket({ packet, exactPaths: ['test.md'] })
  const claim = claimNextWorkbenchPacket({ workerId: 'worker-b', packetId: 'pkt-claim-incr' })
  assert.equal(claim.ok, true)
  if (!claim.ok) return
  assert.equal(claim.record.claimAttempt, 1)
  console.log('  ✓ claimAttempt incremented')
}

async function testSameOwnerClaimRetryIsIdempotent() {
  const packet = makePacket('pkt-claim-idempotent')
  reserveWorkbenchPacket({ packet, exactPaths: ['test.md'] })
  const first = claimNextWorkbenchPacket({ workerId: 'worker-c', packetId: 'pkt-claim-idempotent' })
  assert.equal(first.ok, true)
  if (!first.ok) return

  const retry = claimNextWorkbenchPacket({ workerId: 'worker-c', packetId: 'pkt-claim-idempotent' })
  assert.equal(retry.ok, true)
  if (!retry.ok) return
  assert.equal(retry.claimed, false)
  assert.equal(retry.record.claimAttempt, 1)
  assert.equal(retry.record.leaseToken, first.record.leaseToken)
  assert.equal(retry.record.leaseExpiresAt, first.record.leaseExpiresAt)
  console.log('  ✓ same-owner claim retry is idempotent')
}

async function testCompetingClaimRejected() {
  const packet = makePacket('pkt-compete-001')
  reserveWorkbenchPacket({ packet, exactPaths: ['test.md'] })
  claimNextWorkbenchPacket({ workerId: 'worker-d', packetId: 'pkt-compete-001' })

  const competing = claimNextWorkbenchPacket({ workerId: 'worker-e', packetId: 'pkt-compete-001' })
  assert.equal(competing.ok, false)
  if (competing.ok) return
  assert.equal(competing.code, 'PACKET_NOT_QUEUED')
  console.log('  ✓ competing claimant rejected')
}

async function testExpiredLeaseRecovery() {
  const packet = makePacket('pkt-expire-001')
  reserveWorkbenchPacket({ packet, exactPaths: ['test.md'] })
  const claim = claimNextWorkbenchPacket({ workerId: 'worker-e', packetId: 'pkt-expire-001', leaseMs: 5000 })
  assert.equal(claim.ok, true)
  if (!claim.ok) return

  const futureMs = Date.now() + 60_000
  const recovered = recoverStaleWorkbenchPacketLeases(futureMs)
  assert(recovered.recovered >= 1)
  assert(recovered.packetIds.includes('pkt-expire-001'))

  const record = getWorkbenchPacketRecord('pkt-expire-001')
  assert.equal(record?.status, 'queued')
  assert.equal(record?.leaseToken, undefined)
  assert.equal(record?.leaseOwner, undefined)

  const reClaim = claimNextWorkbenchPacket({ workerId: 'worker-f', packetId: 'pkt-expire-001' })
  assert.equal(reClaim.ok, true)
  if (!reClaim.ok) return
  assert.equal(reClaim.record.claimAttempt, 2)
  console.log('  ✓ expired lease recovered and re-claimed')
}

async function testCompletedPacketCannotBeReclaimed() {
  const packet = makePacket('pkt-completed-001')
  reserveWorkbenchPacket({ packet, exactPaths: ['test.md'] })
  const claim = claimNextWorkbenchPacket({ workerId: 'worker-g', packetId: 'pkt-completed-001' })
  assert.equal(claim.ok, true)
  if (!claim.ok) return

  finalizeWorkbenchPacketExecution({
    packetId: 'pkt-completed-001',
    leaseToken: claim.record.leaseToken!,
    status: 'completed',
    commitHash: 'deadbeef1234'
  })

  const record = getWorkbenchPacketRecord('pkt-completed-001')
  assert.equal(record?.status, 'completed')

  const reClaim = claimNextWorkbenchPacket({ workerId: 'worker-h', packetId: 'pkt-completed-001' })
  assert.equal(reClaim.ok, false)
  console.log('  ✓ completed packet cannot be reclaimed')
}

async function testLeaseRenewal() {
  const packet = makePacket('pkt-renew-001')
  reserveWorkbenchPacket({ packet, exactPaths: ['test.md'] })
  const claim = claimNextWorkbenchPacket({ workerId: 'worker-i', packetId: 'pkt-renew-001' })
  assert.equal(claim.ok, true)
  if (!claim.ok) return

  const originalExpiry = claim.record.leaseExpiresAt!
  const renewed = renewWorkbenchPacketLease({
    packetId: 'pkt-renew-001',
    leaseToken: claim.record.leaseToken!,
    leaseMs: 120_000
  })
  assert.equal(renewed.ok, true)
  if (!renewed.ok) return
  assert(new Date(renewed.record.leaseExpiresAt!).getTime() > new Date(originalExpiry).getTime())
  console.log('  ✓ lease renewal extends expiry')
}

async function testStaleLeaseRejected() {
  const packet = makePacket('pkt-stale-001')
  reserveWorkbenchPacket({ packet, exactPaths: ['test.md'] })
  const claim = claimNextWorkbenchPacket({ workerId: 'worker-j', packetId: 'pkt-stale-001' })
  assert.equal(claim.ok, true)
  if (!claim.ok) return

  const staleRenew = renewWorkbenchPacketLease({
    packetId: 'pkt-stale-001',
    leaseToken: 'wrong-token'
  })
  assert.equal(staleRenew.ok, false)
  if (staleRenew.ok) return
  assert.equal(staleRenew.code, 'LEASE_INVALID')
  console.log('  ✓ stale/incorrect lease rejected')
}

async function testLeaseRelease() {
  const packet = makePacket('pkt-release-001')
  reserveWorkbenchPacket({ packet, exactPaths: ['test.md'] })
  const claim = claimNextWorkbenchPacket({ workerId: 'worker-k', packetId: 'pkt-release-001' })
  assert.equal(claim.ok, true)
  if (!claim.ok) return

  const released = releaseWorkbenchPacketLease({
    packetId: 'pkt-release-001',
    leaseToken: claim.record.leaseToken!,
    requeue: true
  })
  assert.equal(released.ok, true)
  if (!released.ok) return
  assert.equal(released.record.status, 'queued')
  assert.equal(released.record.leaseToken, undefined)
  console.log('  ✓ lease release requeues packet')
}

async function testFinalizationClearsLease() {
  const packet = makePacket('pkt-finalize-001')
  reserveWorkbenchPacket({ packet, exactPaths: ['test.md'] })
  const claim = claimNextWorkbenchPacket({ workerId: 'worker-l', packetId: 'pkt-finalize-001' })
  assert.equal(claim.ok, true)
  if (!claim.ok) return

  const finalized = finalizeWorkbenchPacketExecution({
    packetId: 'pkt-finalize-001',
    leaseToken: claim.record.leaseToken!,
    status: 'failed',
    failureReason: 'test failure'
  })
  assert.equal(finalized.ok, true)
  if (!finalized.ok) return
  assert.equal(finalized.record.status, 'failed')
  assert.equal(finalized.record.leaseToken, undefined)
  assert.equal(finalized.record.leaseOwner, undefined)
  assert.equal(finalized.record.failureReason, 'test failure')
  console.log('  ✓ finalization clears lease and records failure')
}

async function testTokenRedaction() {
  const packet = makePacket('pkt-redact-001')
  reserveWorkbenchPacket({ packet, exactPaths: ['test.md'] })
  const claim = claimNextWorkbenchPacket({ workerId: 'worker-m', packetId: 'pkt-redact-001' })
  assert.equal(claim.ok, true)
  if (!claim.ok) return

  const record = getWorkbenchPacketRecord('pkt-redact-001')!
  const statusOutput = JSON.stringify({
    status: record.status,
    packetId: record.packet.packetId,
    leaseOwner: record.leaseOwner,
    leaseExpiresAt: record.leaseExpiresAt,
    claimAttempt: record.claimAttempt
  })
  assertLeaseRedacted(statusOutput)
  console.log('  ✓ lease tokens not exposed in status output')
}

async function testCompactLeaseRecord() {
  const packet = makePacket('pkt-compact-001')
  reserveWorkbenchPacket({ packet, exactPaths: ['test.md'] })
  const claim = claimNextWorkbenchPacket({ workerId: 'worker-compact', packetId: 'pkt-compact-001' })
  assert.equal(claim.ok, true)
  if (!claim.ok) return

  const authorized = compactWorkbenchPacketLeaseRecord(claim.record, true)
  assert.equal(authorized.packet.packetId, 'pkt-compact-001')
  assert.equal(authorized.leaseToken, claim.record.leaseToken)
  assert.equal('steps' in authorized.packet, false)
  assert(JSON.stringify(authorized).length < 2_000)

  const redacted = compactWorkbenchPacketLeaseRecord(claim.record)
  assert.equal(redacted.leaseToken, undefined)
  assertLeaseRedacted(JSON.stringify(redacted))
  console.log('  ✓ compact lease responses exclude packet bodies and control token visibility')
}

async function testCloseRunRetiresPackets() {
  const sourceId = 'source-close-run'
  const run = startAgentJob({ sourceId, goal: 'verify close_run packet retirement', autoCommit: false, autoPush: false })
  const queuedPacket = makePacket('pkt-close-queued', run.id, sourceId)
  const pausedPacket = makePacket('pkt-close-paused', run.id, sourceId)
  const runningPacket = makePacket('pkt-close-running', run.id, sourceId)

  reserveWorkbenchPacket({ packet: pausedPacket, exactPaths: ['paused.md'] })
  controlWorkbenchPacketsForRun({ runId: run.id, action: 'pause', reason: 'test pause' })
  reserveWorkbenchPacket({ packet: queuedPacket, exactPaths: ['queued.md'] })
  reserveWorkbenchPacket({ packet: runningPacket, exactPaths: ['running.md'] })
  const runningClaim = claimNextWorkbenchPacket({ workerId: 'worker-close-run', packetId: runningPacket.packetId })
  assert.equal(runningClaim.ok, true)
  if (!runningClaim.ok) return

  const closed = closeWorkbenchRun({ sourceId, runId: run.id, summary: 'All intended work is complete.' })
  assert.equal(closed.status, 'completed')
  assert.equal(getAgentJob(run.id)?.status, 'completed')
  assert.equal(getWorkbenchPacketRecord(queuedPacket.packetId)?.status, 'cancelled')
  assert.equal(getWorkbenchPacketRecord(pausedPacket.packetId)?.status, 'cancelled')
  assert.equal(getWorkbenchPacketRecord(runningPacket.packetId)?.status, 'running')
  assert.equal(getWorkbenchPacketRecord(runningPacket.packetId)?.controlRequested, 'cancel')

  const expiry = Date.parse(runningClaim.record.leaseExpiresAt || '')
  assert(Number.isFinite(expiry))
  recoverStaleWorkbenchPacketLeases(expiry + 1)
  const retired = getWorkbenchPacketRecord(runningPacket.packetId)
  assert.equal(retired?.status, 'cancelled')
  assert.equal(retired?.leaseToken, undefined)
  assert.equal(retired?.leaseOwner, undefined)
  assert.equal(retired?.controlRequested, undefined)
  console.log('  ✓ close_run retires queued, paused, and expired running packets')
}

async function testIdempotentReservation() {
  const packet = makePacket('pkt-idempotent-001')
  const first = reserveWorkbenchPacket({ packet, exactPaths: ['test.md'] })
  assert.equal(first.ok, true)
  if (!first.ok) return
  assert.equal(first.created, true)

  const second = reserveWorkbenchPacket({ packet, exactPaths: ['test.md'] })
  assert.equal(second.ok, true)
  if (!second.ok) return
  assert.equal(second.created, false)
  console.log('  ✓ idempotent same-packet reservation')
}

async function main() {
  console.log('Packet lifecycle tests:')
  await testClaimTransitionsQueuedToRunning()
  await testClaimIncrementAttempt()
  await testSameOwnerClaimRetryIsIdempotent()
  await testCompetingClaimRejected()
  await testExpiredLeaseRecovery()
  await testCompletedPacketCannotBeReclaimed()
  await testLeaseRenewal()
  await testStaleLeaseRejected()
  await testLeaseRelease()
  await testFinalizationClearsLease()
  await testTokenRedaction()
  await testCompactLeaseRecord()
  await testCloseRunRetiresPackets()
  await testIdempotentReservation()
  console.log('All packet lifecycle tests passed.')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
