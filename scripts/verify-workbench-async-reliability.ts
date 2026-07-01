import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-async-reliability-'))
const configDir = path.join(root, 'config')
const repoRoot = path.join(root, 'repo')
process.env.WORKBENCH_CONFIG_DIR = configDir

function run(command: string, args: string[], cwd = repoRoot): string {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function write(relativePath: string, content: string): void {
  const target = path.join(repoRoot, relativePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content, 'utf8')
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 8_000): Promise<T> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const value = read()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out after ${timeoutMs}ms`)
}

async function main(): Promise<void> {
  fs.mkdirSync(repoRoot, { recursive: true })
  run('git', ['init'])
  run('git', ['config', 'user.email', 'workbench@example.test'])
  run('git', ['config', 'user.name', 'Workbench Reliability Test'])
  write('package.json', JSON.stringify({
    private: true,
    scripts: {
      slow: 'node -e "setTimeout(() => process.exit(0), 500)"',
      'inject-secret': 'node -e "require(\'fs\').writeFileSync(\'phase-seven-post-write-secret.txt\', \'g\' + \'hp_\' + \'B\'.repeat(24) + \'\\n\')"'
    }
  }, null, 2))
  write('README.md', '# Async reliability fixture\n')
  run('git', ['add', '--', 'package.json', 'README.md'])
  run('git', ['commit', '-m', 'test: initialize async fixture'])

  const [{ createWorkbenchRun, getAgentJob }, packetStore, coordinator, results, repairState] = await Promise.all([
    import('../packages/cli/src/agent/agent-jobs'),
    import('../packages/cli/src/agent/workbench-packet-store'),
    import('../packages/cli/src/agent/workbench-packet-coordinator'),
    import('../packages/cli/src/agent/workbench-packet-results'),
    import('../packages/cli/src/agent/workbench-repair-state')
  ])

  const repairRunId = 'repair-state-runtime-run'
  const repairTaskId = 'repair-state-runtime-task'
  const firstFailedPacketId = 'repair-state-failed-0001'
  const repairPacketId = 'repair-state-packet-0001'
  const eligibleRepair = repairState.recordWorkbenchRepairEligibility({
    runId: repairRunId,
    taskId: repairTaskId,
    failedPacketId: firstFailedPacketId
  })
  assert.equal(eligibleRepair.status, 'eligible')
  assert.equal(eligibleRepair.attemptCount, 0)
  assert.equal(repairState.getWorkbenchRepairState(repairRunId, repairTaskId)?.failedPacketId, firstFailedPacketId)

  const acceptedRepair = repairState.acceptWorkbenchRepairAttempt({
    runId: repairRunId,
    taskId: repairTaskId,
    failedPacketId: firstFailedPacketId,
    repairPacketId
  })
  assert.equal(acceptedRepair.status, 'accepted')
  assert.equal(acceptedRepair.attemptCount, 1)
  assert.equal(repairState.getWorkbenchRepairState(repairRunId, repairTaskId)?.acceptedRepairPacketId, repairPacketId)
  assert.throws(() => repairState.acceptWorkbenchRepairAttempt({
    runId: repairRunId,
    taskId: repairTaskId,
    failedPacketId: firstFailedPacketId,
    repairPacketId: 'repair-state-packet-duplicate'
  }), /not eligible/)

  const secondFailedPacketId = 'repair-state-failed-0002'
  const exhaustedRepair = repairState.recordWorkbenchRepairEligibility({
    runId: repairRunId,
    taskId: repairTaskId,
    failedPacketId: secondFailedPacketId
  })
  assert.equal(exhaustedRepair.status, 'exhausted')
  assert.equal(exhaustedRepair.attemptCount, 1)
  assert.equal(exhaustedRepair.failedPacketId, secondFailedPacketId)
  const repairStorePath = path.join(configDir, 'workbench-repair-state.json')
  assert.equal(fs.existsSync(repairStorePath), true)
  const persistedRepairStore = JSON.parse(fs.readFileSync(repairStorePath, 'utf8')) as {
    version?: number
    states?: Array<{ runId?: string; taskId?: string; status?: string; attemptCount?: number }>
  }
  assert.equal(persistedRepairStore.version, repairState.WORKBENCH_REPAIR_STATE_VERSION)
  assert(persistedRepairStore.states?.some(state => state.runId === repairRunId
    && state.taskId === repairTaskId
    && state.status === 'exhausted'
    && state.attemptCount === 1))
  assert.equal(repairState.clearWorkbenchRepairState(repairRunId, repairTaskId)?.status, 'cleared')
  assert.equal(repairState.getWorkbenchRepairState(repairRunId, repairTaskId)?.status, 'cleared')

  const repairDispatchSourceId = 'repair-dispatch-source'
  const repairDispatchRun = createWorkbenchRun({
    sourceId: repairDispatchSourceId,
    goal: 'Verify one bounded automatic repair dispatch.',
    autoCommit: false,
    reviewEveryStep: false
  })
  const repairDispatchTaskId = repairDispatchRun.run.activeTaskId
  assert(repairDispatchTaskId, 'repair dispatch run must have an active task')
  const repairDispatchHead = run('git', ['rev-parse', 'HEAD'])
  const repairFailurePacketId = 'packet-repair-dispatch-failed-0001'
  const repairSuccessPacketId = 'packet-repair-dispatch-success-0002'
  assert.equal(packetStore.reserveWorkbenchPacket({
    packet: {
      version: 1 as const,
      runId: repairDispatchRun.run.id,
      packetId: repairFailurePacketId,
      idempotencyKey: `${repairDispatchRun.run.id}:${repairFailurePacketId}`,
      sourceId: repairDispatchSourceId,
      taskId: repairDispatchTaskId,
      goalSummary: 'Create invalid JSON to trigger one repair.',
      expectedHead: repairDispatchHead,
      steps: [{ type: 'create' as const, path: 'repair-dispatch.json', content: '{\n' }],
      validation: [{ commandKind: 'validate_json_files' as const, paths: ['repair-dispatch.json'] }],
      commit: { enabled: false },
      createdAt: new Date().toISOString()
    },
    exactPaths: ['repair-dispatch.json']
  }).ok, true)
  assert.equal(packetStore.reserveWorkbenchPacket({
    packet: {
      version: 1 as const,
      runId: repairDispatchRun.run.id,
      packetId: repairSuccessPacketId,
      idempotencyKey: `${repairDispatchRun.run.id}:${repairSuccessPacketId}`,
      sourceId: repairDispatchSourceId,
      taskId: repairDispatchTaskId,
      goalSummary: 'Repair the invalid JSON.',
      expectedHead: repairDispatchHead,
      steps: [{ type: 'create' as const, path: 'repair-dispatch.json', content: '{"repaired":true}\n' }],
      validation: [{ commandKind: 'validate_json_files' as const, paths: ['repair-dispatch.json'] }],
      commit: { enabled: false },
      createdAt: new Date().toISOString()
    },
    exactPaths: ['repair-dispatch.json']
  }).ok, true)
  assert.equal(coordinator.scheduleWorkbenchPacket({
    packetId: repairFailurePacketId,
    sourceId: repairDispatchSourceId,
    sourceRootFor: requested => requested === repairDispatchSourceId ? repoRoot : undefined
  }).status, 'scheduled')
  const repairFailureResult = await waitFor(() => {
    const result = results.getWorkbenchPacketResult(repairFailurePacketId)
    return result?.status === 'failed' ? result : undefined
  })
  assert.equal(repairFailureResult.status, 'failed')
  const repairSuccessResult = await waitFor(() => {
    const result = results.getWorkbenchPacketResult(repairSuccessPacketId)
    return result?.status === 'completed' ? result : undefined
  })
  assert.equal(repairSuccessResult.status, 'completed')
  assert.equal(fs.readFileSync(path.join(repoRoot, 'repair-dispatch.json'), 'utf8'), '{"repaired":true}\n')
  const acceptedAutomaticRepair = repairState.getWorkbenchRepairState(repairDispatchRun.run.id, repairDispatchTaskId)
  assert.equal(acceptedAutomaticRepair?.status, 'accepted')
  assert.equal(acceptedAutomaticRepair?.attemptCount, 1)
  assert.equal(acceptedAutomaticRepair?.acceptedRepairPacketId, repairSuccessPacketId)

  const repairStopSourceId = 'repair-stop-source'
  const repairStopRun = createWorkbenchRun({
    sourceId: repairStopSourceId,
    goal: 'Verify a second failure stops automatic repair.',
    autoCommit: false,
    reviewEveryStep: false
  })
  const repairStopTaskId = repairStopRun.run.activeTaskId
  assert(repairStopTaskId, 'repair stop run must have an active task')
  const repairStopHead = run('git', ['rev-parse', 'HEAD'])
  const repairStopFirstPacketId = 'packet-repair-stop-failed-0001'
  const repairStopSecondPacketId = 'packet-repair-stop-failed-0002'
  const repairStopThirdPacketId = 'packet-repair-stop-unscheduled-0003'
  for (const [packetId, content] of [
    [repairStopFirstPacketId, '{\n'],
    [repairStopSecondPacketId, '{"still":\n'],
    [repairStopThirdPacketId, '{"mustRemainQueued":true}\n']
  ] as const) {
    assert.equal(packetStore.reserveWorkbenchPacket({
      packet: {
        version: 1 as const,
        runId: repairStopRun.run.id,
        packetId,
        idempotencyKey: `${repairStopRun.run.id}:${packetId}`,
        sourceId: repairStopSourceId,
        taskId: repairStopTaskId,
        goalSummary: `Repair-stop fixture ${packetId}.`,
        expectedHead: repairStopHead,
        steps: [{ type: 'create' as const, path: 'repair-stop.json', content }],
        validation: [{ commandKind: 'validate_json_files' as const, paths: ['repair-stop.json'] }],
        commit: { enabled: false },
        createdAt: new Date().toISOString()
      },
      exactPaths: ['repair-stop.json']
    }).ok, true)
  }
  assert.equal(coordinator.scheduleWorkbenchPacket({
    packetId: repairStopFirstPacketId,
    sourceId: repairStopSourceId,
    sourceRootFor: requested => requested === repairStopSourceId ? repoRoot : undefined
  }).status, 'scheduled')
  const secondFailureResult = await waitFor(() => {
    const result = results.getWorkbenchPacketResult(repairStopSecondPacketId)
    return result?.status === 'failed' ? result : undefined
  })
  assert.equal(secondFailureResult.status, 'failed')
  await new Promise(resolve => setTimeout(resolve, 100))
  const exhaustedAutomaticRepair = repairState.getWorkbenchRepairState(repairStopRun.run.id, repairStopTaskId)
  assert.equal(exhaustedAutomaticRepair?.status, 'exhausted')
  assert.equal(exhaustedAutomaticRepair?.attemptCount, 1)
  assert.equal(exhaustedAutomaticRepair?.failedPacketId, repairStopSecondPacketId)
  const exhaustedRepairRun = await waitFor(() => {
    const current = getAgentJob(repairStopRun.run.id)
    return current?.resumeState.instructions.some(instruction => instruction.includes('repairAttempts=1'))
      ? current
      : undefined
  })
  assert.equal(exhaustedRepairRun.metrics.repairAttempts, 1)
  assert.equal(exhaustedRepairRun.resumeState.nextTaskId, repairStopTaskId)
  assert.deepEqual(exhaustedRepairRun.resumeState.nextFiles, ['repair-stop.json'])
  assert(exhaustedRepairRun.resumeState.instructions.some(instruction => instruction.includes('repairAttempts=1')))
  assert(exhaustedRepairRun.resumeState.instructions.some(instruction => instruction.includes(`Review failed packet ${repairStopSecondPacketId}`)))
  assert(exhaustedRepairRun.resumeState.instructions.some(instruction => instruction.includes('Manual resume:')))
  assert(exhaustedRepairRun.summary.includes('automatic continuation stopped'))
  assert.equal(packetStore.getWorkbenchPacketRecord(repairStopThirdPacketId)?.status, 'queued')
  assert.equal(coordinator.isWorkbenchPacketScheduled(repairStopThirdPacketId), false)
  assert.equal(fs.existsSync(path.join(repoRoot, 'repair-stop.json')), false)

  const acceptedRestartDuplicatePacketId = 'packet-repair-dispatch-restart-duplicate-0003'
  assert.equal(packetStore.reserveWorkbenchPacket({
    packet: {
      version: 1 as const,
      runId: repairDispatchRun.run.id,
      packetId: acceptedRestartDuplicatePacketId,
      idempotencyKey: `${repairDispatchRun.run.id}:${acceptedRestartDuplicatePacketId}`,
      sourceId: repairDispatchSourceId,
      taskId: repairDispatchTaskId,
      goalSummary: 'Restart must not dispatch a second repair after acceptance.',
      expectedHead: repairDispatchHead,
      steps: [{ type: 'create' as const, path: 'repair-dispatch-restart-duplicate.json', content: '{"duplicate":true}\n' }],
      validation: [{ commandKind: 'validate_json_files' as const, paths: ['repair-dispatch-restart-duplicate.json'] }],
      commit: { enabled: false },
      createdAt: new Date().toISOString()
    },
    exactPaths: ['repair-dispatch-restart-duplicate.json']
  }).ok, true)
  const acceptedRestartDrain = coordinator.drainQueuedWorkbenchPackets({
    sourceId: repairDispatchSourceId,
    runId: repairDispatchRun.run.id,
    sourceRootFor: requested => requested === repairDispatchSourceId ? repoRoot : undefined
  })
  assert.equal(acceptedRestartDrain.scheduled, 0)
  assert.equal(packetStore.getWorkbenchPacketRecord(acceptedRestartDuplicatePacketId)?.status, 'queued')
  assert.equal(coordinator.isWorkbenchPacketScheduled(acceptedRestartDuplicatePacketId), false)

  const exhaustedRestartDrain = coordinator.drainQueuedWorkbenchPackets({
    sourceId: repairStopSourceId,
    runId: repairStopRun.run.id,
    sourceRootFor: requested => requested === repairStopSourceId ? repoRoot : undefined
  })
  assert.equal(exhaustedRestartDrain.scheduled, 0)
  assert.equal(packetStore.getWorkbenchPacketRecord(repairStopThirdPacketId)?.status, 'queued')
  assert.equal(coordinator.isWorkbenchPacketScheduled(repairStopThirdPacketId), false)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(results.getWorkbenchPacketResult(acceptedRestartDuplicatePacketId), undefined)
  assert.equal(results.getWorkbenchPacketResult(repairStopThirdPacketId), undefined)

  const sourceId = 'async-reliability-source'
  const created = createWorkbenchRun({
    sourceId,
    goal: 'Verify asynchronous packet submission and restart recovery.',
    autoCommit: false,
    reviewEveryStep: false
  })
  const runId = created.run.id
  const firstTaskId = created.run.activeTaskId
  assert(firstTaskId, 'created run must have an active task')
  const head = run('git', ['rev-parse', 'HEAD'])
  const firstPacketId = 'packet-async-reliability-0001'
  const firstPacket = {
    version: 1 as const,
    runId,
    packetId: firstPacketId,
    idempotencyKey: `${runId}:${firstPacketId}`,
    sourceId,
    taskId: firstTaskId,
    goalSummary: 'Create the first asynchronous fixture file.',
    expectedHead: head,
    steps: [{ type: 'create' as const, path: 'async-one.txt', content: 'one\n' }],
    validation: [{ commandKind: 'run_package_script' as const, packageDir: '.', scriptName: 'slow', timeoutMs: 5_000 }],
    commit: { enabled: false },
    createdAt: new Date().toISOString()
  }
  const reservedFirst = packetStore.reserveWorkbenchPacket({ packet: firstPacket, exactPaths: ['async-one.txt'] })
  assert.equal(reservedFirst.ok, true)

  const submitStartedAt = Date.now()
  const scheduled = coordinator.scheduleWorkbenchPacket({
    packetId: firstPacketId,
    sourceId,
    sourceRootFor: requested => requested === sourceId ? repoRoot : undefined
  })
  const submitDurationMs = Date.now() - submitStartedAt
  assert.equal(scheduled.status, 'scheduled')
  assert(submitDurationMs < 250, `submission took ${submitDurationMs}ms and did not return promptly`)
  assert.notEqual(packetStore.getWorkbenchPacketRecord(firstPacketId)?.status, 'completed', 'packet completed before deferred submission returned')

  const firstResult = await waitFor(() => {
    const result = results.getWorkbenchPacketResult(firstPacketId)
    return result?.status === 'completed' ? result : undefined
  })
  assert.equal(firstResult.completedSteps, 1)
  assert.equal(fs.readFileSync(path.join(repoRoot, 'async-one.txt'), 'utf8'), 'one\n')

  const progressedRun = getAgentJob(runId)
  assert(progressedRun?.activeTaskId, 'run must advance to its next task')
  const secondPacketId = 'packet-async-reliability-0002'
  const secondPacket = {
    version: 1 as const,
    runId,
    packetId: secondPacketId,
    idempotencyKey: `${runId}:${secondPacketId}`,
    sourceId,
    taskId: progressedRun.activeTaskId,
    goalSummary: 'Verify stale lease recovery and restart-safe drain.',
    expectedHead: head,
    steps: [{ type: 'create' as const, path: 'async-two.txt', content: 'two\n' }],
    commit: { enabled: false },
    createdAt: new Date().toISOString()
  }
  const reservedSecond = packetStore.reserveWorkbenchPacket({ packet: secondPacket, exactPaths: ['async-two.txt'] })
  assert.equal(reservedSecond.ok, true)

  const claimed = packetStore.claimNextWorkbenchPacket({
    workerId: 'simulated-crashed-worker',
    packetId: secondPacketId,
    sourceId,
    runId,
    leaseMs: 5_000
  })
  assert.equal(claimed.ok, true)
  const recovered = packetStore.recoverStaleWorkbenchPacketLeases(Date.now() + 6_000)
  assert(recovered.packetIds.includes(secondPacketId), 'stale running packet must be requeued after simulated restart')

  const drained = coordinator.drainQueuedWorkbenchPackets({
    sourceId,
    runId,
    limit: 5,
    sourceRootFor: requested => requested === sourceId ? repoRoot : undefined
  })
  assert.equal(drained.status, 'completed')
  assert(drained.packetIds.includes(secondPacketId))
  assert.equal(drained.scheduled, 1)

  const secondResult = await waitFor(() => {
    const result = results.getWorkbenchPacketResult(secondPacketId)
    return result?.status === 'completed' ? result : undefined
  })
  assert.equal(secondResult.completedSteps, 1)
  assert.equal(fs.readFileSync(path.join(repoRoot, 'async-two.txt'), 'utf8'), 'two\n')

  const persistedRestartPacket = packetStore.getWorkbenchPacketRecord(secondPacketId)
  assert(persistedRestartPacket, 'restart-recovered packet record must remain persisted')
  assert.equal(persistedRestartPacket.status, 'completed')
  assert.deepEqual(persistedRestartPacket.exactPaths, ['async-two.txt'])
  assert.equal(persistedRestartPacket.packet.runId, runId)
  assert.equal(persistedRestartPacket.packet.taskId, progressedRun.activeTaskId)
  assert.equal(typeof persistedRestartPacket.updatedAt, 'string')

  const persistedRestartResult = results.getWorkbenchPacketResult(secondPacketId)
  assert(persistedRestartResult, 'restart-recovered packet result must remain persisted')
  assert.equal(persistedRestartResult.status, 'completed')
  assert.equal(persistedRestartResult.completedSteps, 1)
  assert.equal(persistedRestartResult.rolledBack, false)
  assert.deepEqual(persistedRestartResult.errors, [])
  assert(Array.isArray(persistedRestartResult.validation))
  assert.equal(typeof persistedRestartResult.recordedAt, 'string')

  const packetStorePath = path.join(configDir, 'workbench-packets.json')
  const packetResultStorePath = path.join(configDir, 'workbench-packet-results.json')
  assert.equal(fs.existsSync(packetStorePath), true)
  assert.equal(fs.existsSync(packetResultStorePath), true)
  const persistedPacketStoreText = fs.readFileSync(packetStorePath, 'utf8')
  const persistedPacketResultText = fs.readFileSync(packetResultStorePath, 'utf8')
  assert(persistedPacketStoreText.includes(secondPacketId), 'packet observability identity must survive restart persistence')
  assert(persistedPacketStoreText.includes('async-two.txt'), 'packet observability exact paths must survive restart persistence')
  assert(persistedPacketResultText.includes(secondPacketId), 'packet result observability identity must survive restart persistence')
  assert(persistedPacketResultText.includes('completedSteps'), 'packet result observability step evidence must survive restart persistence')
  assert(persistedPacketResultText.includes('validation'), 'packet result observability validation evidence must survive restart persistence')

  const pausedRun = getAgentJob(runId)
  assert(pausedRun?.activeTaskId, 'run must have another active task for control testing')
  const pausedPacketId = 'packet-async-reliability-0003'
  const pausedPacket = {
    version: 1 as const,
    runId,
    packetId: pausedPacketId,
    idempotencyKey: `${runId}:${pausedPacketId}`,
    sourceId,
    taskId: pausedRun.activeTaskId,
    goalSummary: 'Verify cooperative pause and deterministic resume.',
    expectedHead: head,
    steps: [{ type: 'create' as const, path: 'async-paused.txt', content: 'paused then resumed\n' }],
    validation: [{ commandKind: 'run_package_script' as const, packageDir: '.', scriptName: 'slow', timeoutMs: 5_000 }],
    commit: { enabled: false },
    createdAt: new Date().toISOString()
  }
  assert.equal(packetStore.reserveWorkbenchPacket({ packet: pausedPacket, exactPaths: ['async-paused.txt'] }).ok, true)
  assert.equal(coordinator.scheduleWorkbenchPacket({
    packetId: pausedPacketId,
    sourceId,
    sourceRootFor: requested => requested === sourceId ? repoRoot : undefined
  }).status, 'scheduled')
  await waitFor(() => packetStore.getWorkbenchPacketRecord(pausedPacketId)?.status === 'running' ? true : undefined)
  await waitFor(() => getAgentJob(runId)?.activePacketId === pausedPacketId ? true : undefined)
  const pauseControl = packetStore.controlWorkbenchPacketsForRun({ runId, action: 'pause', reason: 'reliability pause' })
  assert(pauseControl.packetIds.includes(pausedPacketId))
  await waitFor(() => packetStore.getWorkbenchPacketRecord(pausedPacketId)?.status === 'paused' ? true : undefined)
  await waitFor(() => getAgentJob(runId)?.activePacketId === undefined ? true : undefined)
  assert.equal(fs.existsSync(path.join(repoRoot, 'async-paused.txt')), false, 'paused packet must roll back its mutation')
  const resumeControl = packetStore.controlWorkbenchPacketsForRun({ runId, action: 'resume' })
  assert(resumeControl.packetIds.includes(pausedPacketId))
  const resumedDrain = coordinator.drainQueuedWorkbenchPackets({
    sourceId,
    runId,
    limit: 5,
    sourceRootFor: requested => requested === sourceId ? repoRoot : undefined
  })
  assert(resumedDrain.packetIds.includes(pausedPacketId))
  const resumedResult = await waitFor(() => {
    const result = results.getWorkbenchPacketResult(pausedPacketId)
    return result?.status === 'completed' ? result : undefined
  })
  assert.equal(fs.readFileSync(path.join(repoRoot, 'async-paused.txt'), 'utf8'), 'paused then resumed\n')

  const cancelledRun = getAgentJob(runId)
  assert(cancelledRun?.activeTaskId, 'run must have another active task for cancel testing')
  const cancelledPacketId = 'packet-async-reliability-0004'
  const cancelledPacket = {
    version: 1 as const,
    runId,
    packetId: cancelledPacketId,
    idempotencyKey: `${runId}:${cancelledPacketId}`,
    sourceId,
    taskId: cancelledRun.activeTaskId,
    goalSummary: 'Verify queued packet cancellation.',
    expectedHead: head,
    steps: [{ type: 'create' as const, path: 'async-cancelled.txt', content: 'must not exist\n' }],
    commit: { enabled: false },
    createdAt: new Date().toISOString()
  }
  assert.equal(packetStore.reserveWorkbenchPacket({ packet: cancelledPacket, exactPaths: ['async-cancelled.txt'] }).ok, true)
  const cancelControl = packetStore.controlWorkbenchPacketsForRun({ runId, action: 'cancel', reason: 'reliability cancel' })
  assert(cancelControl.packetIds.includes(cancelledPacketId))
  assert.equal(packetStore.getWorkbenchPacketRecord(cancelledPacketId)?.status, 'cancelled')
  assert.equal(fs.existsSync(path.join(repoRoot, 'async-cancelled.txt')), false)

  const continuationSourceId = 'async-continuation-source'
  const continuationCreated = createWorkbenchRun({
    sourceId: continuationSourceId,
    goal: 'Verify one initial packet dispatch automatically continues to the next reserved task packet.',
    autoCommit: false,
    reviewEveryStep: false
  })
  const continuationRunId = continuationCreated.run.id
  const continuationTasks = continuationCreated.run.roadmapPhases.flatMap(phase => phase.tasks)
  const continuationFirstTaskId = continuationCreated.run.activeTaskId
  assert(continuationFirstTaskId, 'continuation run must have an active task')
  const continuationFirstIndex = continuationTasks.findIndex(task => task.id === continuationFirstTaskId)
  const continuationSecondTaskId = continuationTasks[continuationFirstIndex + 1]?.id
  assert(continuationSecondTaskId, 'continuation run must have a second task')

  const continuationFirstPacketId = 'packet-auto-continuation-0001'
  const continuationSecondPacketId = 'packet-auto-continuation-0002'
  assert.equal(packetStore.reserveWorkbenchPacket({
    packet: {
      version: 1 as const,
      runId: continuationRunId,
      packetId: continuationFirstPacketId,
      idempotencyKey: `${continuationRunId}:${continuationFirstPacketId}`,
      sourceId: continuationSourceId,
      taskId: continuationFirstTaskId,
      goalSummary: 'Complete the first task and trigger automatic continuation.',
      expectedHead: head,
      steps: [{ type: 'create' as const, path: 'auto-continuation-one.txt', content: 'one\n' }],
      commit: { enabled: false },
      createdAt: new Date().toISOString()
    },
    exactPaths: ['auto-continuation-one.txt']
  }).ok, true)
  assert.equal(packetStore.reserveWorkbenchPacket({
    packet: {
      version: 1 as const,
      runId: continuationRunId,
      packetId: continuationSecondPacketId,
      idempotencyKey: `${continuationRunId}:${continuationSecondPacketId}`,
      sourceId: continuationSourceId,
      taskId: continuationSecondTaskId,
      goalSummary: 'Complete automatically after the first task advances the run.',
      expectedHead: head,
      steps: [{ type: 'create' as const, path: 'auto-continuation-two.txt', content: 'two\n' }],
      commit: { enabled: false },
      createdAt: new Date().toISOString()
    },
    exactPaths: ['auto-continuation-two.txt']
  }).ok, true)

  assert.equal(coordinator.scheduleWorkbenchPacket({
    packetId: continuationFirstPacketId,
    sourceId: continuationSourceId,
    sourceRootFor: requested => requested === continuationSourceId ? repoRoot : undefined
  }).status, 'scheduled')
  const continuationSecondResult = await waitFor(() => {
    const result = results.getWorkbenchPacketResult(continuationSecondPacketId)
    return result?.status === 'completed' ? result : undefined
  })
  assert.equal(continuationSecondResult.status, 'completed')
  assert.equal(fs.readFileSync(path.join(repoRoot, 'auto-continuation-one.txt'), 'utf8'), 'one\n')
  assert.equal(fs.readFileSync(path.join(repoRoot, 'auto-continuation-two.txt'), 'utf8'), 'two\n')

  const autoCommitSourceId = 'async-auto-commit-source'
  const { saveConfig } = await import('../packages/cli/src/agent/config')
  saveConfig({
    userId: 'async-reliability-user',
    deviceId: 'async-reliability-device',
    deviceToken: 'async-reliability-token',
    apiBaseUrl: 'http://127.0.0.1',
    mode: 'read_create_append',
    allowedExtensions: ['.json', '.txt'],
    ignorePatterns: [],
    autoCommitSourceIds: [autoCommitSourceId]
  })
  const autoCommitCreated = createWorkbenchRun({
    sourceId: autoCommitSourceId,
    goal: 'Verify validated exact-path automatic commit behavior.',
    autoCommit: true,
    reviewEveryStep: false
  })
  const autoCommitTaskId = autoCommitCreated.run.activeTaskId
  assert(autoCommitTaskId, 'auto-commit run must have an active task')
  const autoCommitPacketId = 'packet-auto-commit-0001'
  const autoCommitHead = run('git', ['rev-parse', 'HEAD'])
  write('unrelated-local.txt', 'leave uncommitted\n')
  assert.equal(packetStore.reserveWorkbenchPacket({
    packet: {
      version: 1 as const,
      runId: autoCommitCreated.run.id,
      packetId: autoCommitPacketId,
      idempotencyKey: `${autoCommitCreated.run.id}:${autoCommitPacketId}`,
      sourceId: autoCommitSourceId,
      taskId: autoCommitTaskId,
      goalSummary: 'Create and validate the Phase 7 automatic commit fixture.',
      expectedHead: autoCommitHead,
      steps: [{ type: 'create' as const, path: 'phase-seven-auto-commit.json', content: '{"phase":7}\n' }],
      validation: [{ commandKind: 'validate_json_files' as const, paths: ['phase-seven-auto-commit.json'] }],
      createdAt: new Date().toISOString()
    },
    exactPaths: ['phase-seven-auto-commit.json']
  }).ok, true)
  assert.equal(coordinator.scheduleWorkbenchPacket({
    packetId: autoCommitPacketId,
    sourceId: autoCommitSourceId,
    sourceRootFor: requested => requested === autoCommitSourceId ? repoRoot : undefined
  }).status, 'scheduled')
  const autoCommitResult = await waitFor(() => {
    const result = results.getWorkbenchPacketResult(autoCommitPacketId)
    return result?.status === 'completed' ? result : undefined
  })
  assert(autoCommitResult.commitHash, 'automatic commit must persist its commit hash')
  assert.equal(run('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']), 'phase-seven-auto-commit.json')
  assert(run('git', ['status', '--short', '--untracked-files=all']).includes('?? unrelated-local.txt'))
  const autoCommitMessage = run('git', ['show', '-s', '--format=%B', 'HEAD'])
  assert(autoCommitMessage.startsWith('workbench: '), 'automatic commit must derive a Workbench task message')
  assert(autoCommitMessage.includes(`Workbench-Run: ${autoCommitCreated.run.id}`))
  assert(autoCommitMessage.includes(`Workbench-Packet: ${autoCommitPacketId}`))

  const secretBlockedRun = getAgentJob(autoCommitCreated.run.id)
  const secretBlockedTaskId = secretBlockedRun?.activeTaskId
  assert(secretBlockedTaskId, 'auto-commit run must advance to a task for secret blocking')
  const { runNextWorkbenchPacket } = await import('../packages/cli/src/agent/workbench-packet-worker')

  const preflightSecretPacketId = 'packet-auto-commit-secret-preflight-0002'
  const preflightSecretHead = run('git', ['rev-parse', 'HEAD'])
  const blockedSecret = 'g' + 'hp_' + 'A'.repeat(24)
  assert.equal(packetStore.reserveWorkbenchPacket({
    packet: {
      version: 1 as const,
      runId: autoCommitCreated.run.id,
      packetId: preflightSecretPacketId,
      idempotencyKey: `${autoCommitCreated.run.id}:${preflightSecretPacketId}`,
      sourceId: autoCommitSourceId,
      taskId: secretBlockedTaskId,
      goalSummary: 'Verify secret material is rejected before mutation.',
      expectedHead: preflightSecretHead,
      steps: [{ type: 'create' as const, path: 'phase-seven-secret.txt', content: `${blockedSecret}\n` }],
      validation: [{ commandKind: 'run_package_script' as const, packageDir: '.', scriptName: 'slow', timeoutMs: 5_000 }],
      createdAt: new Date().toISOString()
    },
    exactPaths: ['phase-seven-secret.txt']
  }).ok, true)
  const preflightSecretWorker = await runNextWorkbenchPacket({
    packetId: preflightSecretPacketId,
    sourceId: autoCommitSourceId,
    runId: autoCommitCreated.run.id,
    sourceRootFor: requested => requested === autoCommitSourceId ? repoRoot : undefined
  })
  assert.equal(preflightSecretWorker.status, 'requeued')
  assert.equal(preflightSecretWorker.execution?.status, 'rejected')
  assert.equal(packetStore.getWorkbenchPacketRecord(preflightSecretPacketId)?.status, 'queued')
  assert.equal(results.getWorkbenchPacketResult(preflightSecretPacketId)?.status, 'requeued')
  assert.equal(run('git', ['rev-parse', 'HEAD']), preflightSecretHead)
  assert.equal(fs.existsSync(path.join(repoRoot, 'phase-seven-secret.txt')), false)

  const postWriteSecretPacketId = 'packet-auto-commit-secret-postwrite-0003'
  const postWriteSecretHead = run('git', ['rev-parse', 'HEAD'])
  assert.equal(packetStore.reserveWorkbenchPacket({
    packet: {
      version: 1 as const,
      runId: autoCommitCreated.run.id,
      packetId: postWriteSecretPacketId,
      idempotencyKey: `${autoCommitCreated.run.id}:${postWriteSecretPacketId}`,
      sourceId: autoCommitSourceId,
      taskId: secretBlockedTaskId,
      goalSummary: 'Verify post-write secret scanning blocks automatic commit.',
      expectedHead: postWriteSecretHead,
      steps: [{ type: 'create' as const, path: 'phase-seven-post-write-secret.txt', content: 'safe before validation\n' }],
      validation: [{ commandKind: 'run_package_script' as const, packageDir: '.', scriptName: 'inject-secret', timeoutMs: 5_000 }],
      createdAt: new Date().toISOString()
    },
    exactPaths: ['phase-seven-post-write-secret.txt']
  }).ok, true)
  const postWriteSecretWorker = await runNextWorkbenchPacket({
    packetId: postWriteSecretPacketId,
    sourceId: autoCommitSourceId,
    runId: autoCommitCreated.run.id,
    sourceRootFor: requested => requested === autoCommitSourceId ? repoRoot : undefined
  })
  assert.equal(postWriteSecretWorker.status, 'failed')
  assert.equal(packetStore.getWorkbenchPacketRecord(postWriteSecretPacketId)?.status, 'failed')
  assert.equal(results.getWorkbenchPacketResult(postWriteSecretPacketId)?.status, 'failed')
  assert.equal(results.getWorkbenchPacketResult(postWriteSecretPacketId)?.commitHash, undefined)
  assert.equal(run('git', ['rev-parse', 'HEAD']), postWriteSecretHead)
  assert.equal(fs.existsSync(path.join(repoRoot, 'phase-seven-post-write-secret.txt')), false)
  const persistedFailedPacketRepair = repairState.getWorkbenchRepairState(autoCommitCreated.run.id, secretBlockedTaskId)
  assert.equal(persistedFailedPacketRepair?.status, 'eligible')
  assert.equal(persistedFailedPacketRepair?.attemptCount, 0)
  assert.equal(persistedFailedPacketRepair?.failedPacketId, postWriteSecretPacketId)

  const { undoWorkbenchPacketCommit } = await import('../packages/cli/src/agent/workbench-packet-executor')
  const undoResult = undoWorkbenchPacketCommit({
    packetId: autoCommitPacketId,
    sourceId: autoCommitSourceId,
    sourceRoot: repoRoot
  })
  assert.equal(undoResult.status, 'reverted')
  assert.equal(undoResult.originalCommitHash, autoCommitResult.commitHash)
  assert(undoResult.revertCommitHash, 'safe undo must persist the revert commit hash')
  assert.equal(run('git', ['rev-parse', 'HEAD']), undoResult.revertCommitHash)
  assert.equal(run('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']), 'phase-seven-auto-commit.json')
  assert.equal(fs.existsSync(path.join(repoRoot, 'phase-seven-auto-commit.json')), false)
  assert(run('git', ['status', '--short', '--untracked-files=all']).includes('?? unrelated-local.txt'))

  console.log(JSON.stringify({
    status: 'ok',
    submitDurationMs,
    firstPacketStatus: firstResult.status,
    restartRecoveredPacketIds: recovered.packetIds,
    drainedPacketIds: drained.packetIds,
    secondPacketStatus: secondResult.status,
    automaticContinuationPacketIds: [continuationFirstPacketId, continuationSecondPacketId],
    automaticContinuationVerified: true,
    automaticCommitPacketId: autoCommitPacketId,
    automaticCommitHash: autoCommitResult.commitHash,
    automaticCommitVerified: true,
    unrelatedFilePreserved: true,
    isolatedConfigDir: configDir
  }, null, 2))
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
  .finally(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })
