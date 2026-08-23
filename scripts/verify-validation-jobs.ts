import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

async function main() {
  const hostHome = process.env.HOME
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'buildflow-validation-jobs-'))
  if (!process.env.NVM_DIR && hostHome) process.env.NVM_DIR = path.join(hostHome, '.nvm')
  process.env.HOME = isolatedHome
  process.env.XDG_CONFIG_HOME = path.join(isolatedHome, '.config')

  const {
    cancelWorkbenchValidationJob,
    getCompactWorkbenchValidationJob,
    getWorkbenchValidationJob,
    listCompactWorkbenchValidationJobs,
    recordWorkbenchValidationJobResult,
    recoverExpiredWorkbenchValidationJobs,
    scheduleWorkbenchValidationJob,
    submitWorkbenchValidationJob,
    toSafeCommandRequest
  } = await import('../packages/cli/src/agent/workbench-validation-jobs')
  const { listWorkbenchActivity } = await import('../packages/cli/src/agent/agent-events')
  const validationJobStorePath = path.join(isolatedHome, '.buildflow', 'workbench-validation-jobs.json')
  const activityStorePath = path.join(isolatedHome, '.buildflow', 'agent-events.json')

  const request = {
    sourceId: 'source-a',
    idempotencyKey: 'validation:test:build',
    commandKind: 'run_package_script' as const,
    packageDir: 'apps/web',
    scriptName: 'build',
    timeoutMs: 300_000,
    runId: 'run-a',
    packetId: 'packet-a',
    taskId: 'task-a',
    nodeVersion: '20' as const
  }

  const submitted = submitWorkbenchValidationJob(request)
  assert.equal(submitted.ok, true)
  if (!submitted.ok) throw new Error(submitted.message)
  assert.equal(submitted.created, true)
  assert.equal(submitted.job.status, 'queued')
  assert.equal(submitted.job.sourceId, 'source-a')
  assert.equal(submitted.job.runId, 'run-a')
  assert.equal(submitted.job.commandKind, 'run_package_script')
  assert.equal(submitted.job.scriptName, 'build')
  let activity = listWorkbenchActivity({ runId: 'run-a', sourceId: 'source-a', limit: 40 }).projection
  assert.equal(activity.events.filter(event => event.kind === 'validation_started').length, 0)

  const persisted = getWorkbenchValidationJob(submitted.job.jobId, 'source-a')
  assert(persisted)
  assert.equal(persisted.idempotencyKey, request.idempotencyKey)
  assert.equal(persisted.command.timeoutMs, 300_000)

  const compact = getCompactWorkbenchValidationJob(submitted.job.jobId, 'source-a')
  assert(compact)
  assert.equal(compact.jobId, submitted.job.jobId)
  assert.equal(compact.status, 'queued')
  assert.equal(compact.packageDir, 'apps/web')

  assert.equal(getCompactWorkbenchValidationJob(submitted.job.jobId, 'source-b'), undefined)
  assert.equal(listCompactWorkbenchValidationJobs({ sourceId: 'source-b' }).length, 0)
  assert.equal(listCompactWorkbenchValidationJobs({ sourceId: 'source-a', runId: 'run-a' }).length, 1)

  const duplicate = submitWorkbenchValidationJob(request)
  assert.equal(duplicate.ok, true)
  if (!duplicate.ok) throw new Error(duplicate.message)
  assert.equal(duplicate.created, false)
  assert.equal(duplicate.job.jobId, submitted.job.jobId)

  const conflict = submitWorkbenchValidationJob({
    ...request,
    scriptName: 'type-check'
  })
  assert.equal(conflict.ok, false)
  if (conflict.ok) throw new Error('Expected an idempotency conflict')
  assert.equal(conflict.code, 'VALIDATION_JOB_IDEMPOTENCY_CONFLICT')

  const invalid = submitWorkbenchValidationJob({
    ...request,
    idempotencyKey: 'validation:test:invalid',
    commandKind: 'run_package_script',
    scriptName: ''
  })
  assert.equal(invalid.ok, false)
  if (invalid.ok) throw new Error('Expected an invalid validation job')
  assert.equal(invalid.code, 'VALIDATION_JOB_INVALID')
  assert.equal(invalid.field, 'scriptName')
  assert.match(invalid.reason || '', /required for run_package_script/)

  const invalidExact = submitWorkbenchValidationJob({
    sourceId: 'source-a',
    idempotencyKey: 'validation:test:invalid-exact',
    commandKind: 'run_exact_command',
    args: ['run', 'build'],
    nodeVersion: '20'
  })
  assert.equal(invalidExact.ok, false)
  if (invalidExact.ok) throw new Error('Expected an invalid exact validation job')
  assert.equal(invalidExact.code, 'VALIDATION_JOB_INVALID')
  assert.equal(invalidExact.field, 'executable')
  assert.deepEqual(invalidExact.allowedValues, ['node', 'pnpm', 'rg'])

  const wrongSourceCancel = cancelWorkbenchValidationJob({
    jobId: submitted.job.jobId,
    sourceId: 'source-b',
    reason: 'wrong source must not cancel'
  })
  assert.equal(wrongSourceCancel.ok, false)
  if (wrongSourceCancel.ok) throw new Error('Expected source-scoped cancellation failure')
  assert.equal(wrongSourceCancel.code, 'VALIDATION_JOB_NOT_FOUND')

  const queuedCancel = cancelWorkbenchValidationJob({
    jobId: submitted.job.jobId,
    sourceId: 'source-a',
    reason: 'queued cancellation test'
  })
  assert.equal(queuedCancel.ok, true)
  if (!queuedCancel.ok) throw new Error(queuedCancel.message)
  assert.equal(queuedCancel.cancellationRequested, true)
  assert.equal(queuedCancel.job.status, 'cancelled')
  assert.equal(queuedCancel.job.terminationReason, 'cancelled')
  activity = listWorkbenchActivity({ runId: 'run-a', sourceId: 'source-a', limit: 40 }).projection
  const queuedCancelEvents = activity.events.filter(event => event.validationJobId === submitted.job.jobId)
  assert.equal(queuedCancelEvents.filter(event => event.kind === 'validation_started').length, 0)
  assert.equal(queuedCancelEvents.filter(event => event.kind === 'validation_failed' && event.status === 'cancelled').length, 1)
  assert.equal(queuedCancelEvents.find(event => event.kind === 'validation_failed')?.packetId, 'packet-a')
  assert.equal(queuedCancelEvents.find(event => event.kind === 'validation_failed')?.taskId, 'task-a')

  const cancelledPersisted = getCompactWorkbenchValidationJob(submitted.job.jobId, 'source-a')
  assert(cancelledPersisted)
  assert.equal(cancelledPersisted.status, 'cancelled')
  assert.equal(cancelledPersisted.terminationReason, 'cancelled')
  const cancelledSchedule = scheduleWorkbenchValidationJob({
    jobId: submitted.job.jobId,
    sourceId: 'source-a',
    sourceRoot: process.cwd(),
    leaseMs: 60_000
  })
  assert.notEqual(cancelledSchedule.status, 'scheduled')
  activity = listWorkbenchActivity({ runId: 'run-a', sourceId: 'source-a', limit: 40 }).projection
  assert.equal(activity.events.filter(event => event.validationJobId === submitted.job.jobId && event.kind === 'validation_failed').length, 1)

  const workerRoot = path.join(isolatedHome, 'worker-repo')
  fs.mkdirSync(workerRoot, { recursive: true })
  fs.writeFileSync(path.join(workerRoot, 'package.json'), JSON.stringify({
    name: 'validation-worker-fixture',
    private: true,
    scripts: {
      'validate:worker': "node -e \"process.stdout.write('worker-ok')\"",
      'validate:fail': "node -e \"process.stderr.write('worker-fail'); process.exit(2)\"",
      'validate:slow': "node -e \"setTimeout(() => process.stdout.write('late'), 10000)\""
    }
  }, null, 2))

  const workerSubmission = submitWorkbenchValidationJob({
    sourceId: 'worker-source',
    idempotencyKey: 'validation:test:worker',
    runId: 'worker-run',
    packetId: 'worker-packet',
    taskId: 'worker-task',
    commandKind: 'run_package_script',
    packageDir: '.',
    scriptName: 'validate:worker',
    timeoutMs: 30_000
  })
  assert.equal(workerSubmission.ok, true)
  if (!workerSubmission.ok) throw new Error(workerSubmission.message)

  const scheduled = scheduleWorkbenchValidationJob({
    jobId: workerSubmission.job.jobId,
    sourceId: 'worker-source',
    sourceRoot: workerRoot,
    leaseMs: 60_000
  })
  assert.equal(scheduled.status, 'scheduled')

  let workerResult = getCompactWorkbenchValidationJob(workerSubmission.job.jobId, 'worker-source')
  for (let attempt = 0; attempt < 100 && (workerResult?.status === 'queued' || workerResult?.status === 'running'); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 25))
    workerResult = getCompactWorkbenchValidationJob(workerSubmission.job.jobId, 'worker-source')
  }
  assert(workerResult)
  assert.equal(workerResult.status, 'completed')
  assert.equal(workerResult.exitCode, 0)
  assert(workerResult.stdout?.includes('worker-ok'))
  assert(workerResult.stdoutTail?.includes('worker-ok'))
  const workerRecord = getWorkbenchValidationJob(workerSubmission.job.jobId, 'worker-source')
  assert(workerRecord?.startedAt)
  assert.equal(workerRecord?.status, 'completed')
  activity = listWorkbenchActivity({ runId: 'worker-run', sourceId: 'worker-source', limit: 40 }).projection
  const workerEvents = activity.events.filter(event => event.validationJobId === workerSubmission.job.jobId)
  assert.equal(workerEvents.filter(event => event.kind === 'validation_started').length, 1)
  assert.equal(workerEvents.filter(event => event.kind === 'validation_completed').length, 1)
  assert.equal(workerEvents.find(event => event.kind === 'validation_started')?.occurredAt, workerRecord.startedAt)
  assert.equal(workerEvents.find(event => event.kind === 'validation_started')?.packetId, 'worker-packet')
  assert.equal(workerEvents.find(event => event.kind === 'validation_started')?.taskId, 'worker-task')
  assert.equal(workerEvents.find(event => event.kind === 'validation_completed')?.status, 'completed')
  assert.equal(workerEvents.find(event => event.kind === 'validation_completed')?.telemetry?.durationMs, workerRecord.result?.durationMs)

  const failedSubmission = submitWorkbenchValidationJob({
    sourceId: 'worker-source',
    idempotencyKey: 'validation:test:worker-failed',
    runId: 'worker-run',
    commandKind: 'run_package_script',
    packageDir: '.',
    scriptName: 'validate:fail',
    timeoutMs: 30_000
  })
  assert.equal(failedSubmission.ok, true)
  if (!failedSubmission.ok) throw new Error(failedSubmission.message)
  assert.equal(scheduleWorkbenchValidationJob({ jobId: failedSubmission.job.jobId, sourceId: 'worker-source', sourceRoot: workerRoot, leaseMs: 60_000 }).status, 'scheduled')
  let failedResult = getCompactWorkbenchValidationJob(failedSubmission.job.jobId, 'worker-source')
  for (let attempt = 0; attempt < 100 && (failedResult?.status === 'queued' || failedResult?.status === 'running'); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 25))
    failedResult = getCompactWorkbenchValidationJob(failedSubmission.job.jobId, 'worker-source')
  }
  assert(failedResult)
  assert.equal(failedResult.status, 'failed')
  activity = listWorkbenchActivity({ runId: 'worker-run', sourceId: 'worker-source', limit: 40 }).projection
  const failedEvents = activity.events.filter(event => event.validationJobId === failedSubmission.job.jobId)
  assert.equal(failedEvents.filter(event => event.kind === 'validation_started').length, 1)
  assert.equal(failedEvents.filter(event => event.kind === 'validation_failed' && event.status === 'failed').length, 1)

  const timedOutSubmission = submitWorkbenchValidationJob({
    sourceId: 'worker-source',
    idempotencyKey: 'validation:test:worker-timeout',
    runId: 'worker-run',
    commandKind: 'run_package_script',
    packageDir: '.',
    scriptName: 'validate:slow',
    timeoutMs: 50
  })
  assert.equal(timedOutSubmission.ok, true)
  if (!timedOutSubmission.ok) throw new Error(timedOutSubmission.message)
  assert.equal(scheduleWorkbenchValidationJob({ jobId: timedOutSubmission.job.jobId, sourceId: 'worker-source', sourceRoot: workerRoot, leaseMs: 60_000 }).status, 'scheduled')
  let timedOutResult = getCompactWorkbenchValidationJob(timedOutSubmission.job.jobId, 'worker-source')
  for (let attempt = 0; attempt < 100 && (timedOutResult?.status === 'queued' || timedOutResult?.status === 'running'); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 25))
    timedOutResult = getCompactWorkbenchValidationJob(timedOutSubmission.job.jobId, 'worker-source')
  }
  assert(timedOutResult)
  assert.equal(timedOutResult.status, 'timed_out')
  activity = listWorkbenchActivity({ runId: 'worker-run', sourceId: 'worker-source', limit: 40 }).projection
  const timedOutEvents = activity.events.filter(event => event.validationJobId === timedOutSubmission.job.jobId)
  assert.equal(timedOutEvents.filter(event => event.kind === 'validation_started').length, 1)
  assert.equal(timedOutEvents.filter(event => event.kind === 'validation_failed' && event.status === 'timed_out').length, 1)

  const slowSubmission = submitWorkbenchValidationJob({
    sourceId: 'worker-source',
    idempotencyKey: 'validation:test:running-cancel',
    runId: 'worker-run',
    commandKind: 'run_package_script',
    packageDir: '.',
    scriptName: 'validate:slow',
    timeoutMs: 30_000
  })
  assert.equal(slowSubmission.ok, true)
  if (!slowSubmission.ok) throw new Error(slowSubmission.message)
  const slowScheduled = scheduleWorkbenchValidationJob({
    jobId: slowSubmission.job.jobId,
    sourceId: 'worker-source',
    sourceRoot: workerRoot,
    leaseMs: 60_000
  })
  assert.equal(slowScheduled.status, 'scheduled')

  let slowRunning = getCompactWorkbenchValidationJob(slowSubmission.job.jobId, 'worker-source')
  for (let attempt = 0; attempt < 100 && slowRunning?.status === 'queued'; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
    slowRunning = getCompactWorkbenchValidationJob(slowSubmission.job.jobId, 'worker-source')
  }
  assert(slowRunning)
  assert.equal(slowRunning.status, 'running')
  activity = listWorkbenchActivity({ runId: 'worker-run', sourceId: 'worker-source', limit: 40 }).projection
  let slowEvents = activity.events.filter(event => event.validationJobId === slowSubmission.job.jobId)
  assert.equal(slowEvents.filter(event => event.kind === 'validation_started').length, 1)
  assert.equal(slowEvents.filter(event => event.kind === 'validation_failed').length, 0)

  const runningCancel = cancelWorkbenchValidationJob({
    jobId: slowSubmission.job.jobId,
    sourceId: 'worker-source',
    reason: 'running cancellation test'
  })
  assert.equal(runningCancel.ok, true)
  if (!runningCancel.ok) throw new Error(runningCancel.message)
  assert.equal(runningCancel.cancellationRequested, true)
  activity = listWorkbenchActivity({ runId: 'worker-run', sourceId: 'worker-source', limit: 40 }).projection
  slowEvents = activity.events.filter(event => event.validationJobId === slowSubmission.job.jobId)
  assert.equal(slowEvents.filter(event => event.kind === 'validation_failed').length, 0)

  let slowCancelled = getCompactWorkbenchValidationJob(slowSubmission.job.jobId, 'worker-source')
  for (let attempt = 0; attempt < 200 && (slowCancelled?.status === 'queued' || slowCancelled?.status === 'running'); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 25))
    slowCancelled = getCompactWorkbenchValidationJob(slowSubmission.job.jobId, 'worker-source')
  }
  assert(slowCancelled)
  assert.equal(slowCancelled.status, 'cancelled')
  assert.equal(slowCancelled.terminationReason, 'cancelled')
  assert.equal(slowCancelled.terminatedByInfrastructure, false)
  activity = listWorkbenchActivity({ runId: 'worker-run', sourceId: 'worker-source', limit: 40 }).projection
  slowEvents = activity.events.filter(event => event.validationJobId === slowSubmission.job.jobId)
  assert.equal(slowEvents.filter(event => event.kind === 'validation_started').length, 1)
  assert.equal(slowEvents.filter(event => event.kind === 'validation_failed' && event.status === 'cancelled').length, 1)

  execFileSync('git', ['init'], { cwd: workerRoot, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'validation@example.test'], { cwd: workerRoot })
  execFileSync('git', ['config', 'user.name', 'Validation Job Test'], { cwd: workerRoot })
  execFileSync('git', ['checkout', '-b', 'feature/validation-job'], { cwd: workerRoot, stdio: 'ignore' })
  fs.writeFileSync(path.join(workerRoot, 'README.md'), '# Protected fixture\n', 'utf8')
  execFileSync('git', ['add', '--', 'package.json', 'README.md'], { cwd: workerRoot })
  execFileSync('git', ['commit', '-m', 'test: initialize exact validation fixture'], { cwd: workerRoot, stdio: 'ignore' })

  const exactSubmission = submitWorkbenchValidationJob({
    sourceId: 'worker-source',
    idempotencyKey: 'validation:test:exact-node20',
    commandKind: 'run_exact_command',
    packageDir: '.',
    executable: 'pnpm',
    args: ['run', 'validate:worker'],
    nodeVersion: '20',
    requiredBranch: 'feature/validation-job',
    protectedPaths: ['README.md'],
    policy: {
      denyDatabaseCommands: true,
      denyMigrationCommands: true,
      denyDeploymentCommands: true,
      denyNetworkCommands: true
    },
    networkAccess: false
  })
  assert.equal(exactSubmission.ok, true)
  if (!exactSubmission.ok) throw new Error(exactSubmission.message)
  assert.equal(exactSubmission.job.commandKind, 'run_exact_command')
  assert.equal(exactSubmission.job.executable, 'pnpm')
  assert.deepEqual(exactSubmission.job.args, ['run', 'validate:worker'])
  assert.equal(exactSubmission.job.nodeVersion, '20')
  assert.equal(exactSubmission.job.timeoutMs, 300_000)
  assert.equal(exactSubmission.job.requiredBranch, 'feature/validation-job')
  assert.deepEqual(exactSubmission.job.protectedPaths, ['README.md'])

  const exactRecord = getWorkbenchValidationJob(exactSubmission.job.jobId, 'worker-source')
  assert(exactRecord)
  const exactSafeRequest = toSafeCommandRequest(exactRecord, workerRoot)
  assert.equal(exactSafeRequest.persistedValidation, true)
  assert.equal(exactSafeRequest.timeoutMs, 300_000)
  assert.equal(exactSafeRequest.executable, 'pnpm')
  assert.deepEqual(exactSafeRequest.args, ['run', 'validate:worker'])

  const exactScheduled = scheduleWorkbenchValidationJob({
    jobId: exactSubmission.job.jobId,
    sourceId: 'worker-source',
    sourceRoot: workerRoot,
    leaseMs: 360_000
  })
  assert.equal(exactScheduled.status, 'scheduled')

  let exactResult = getCompactWorkbenchValidationJob(exactSubmission.job.jobId, 'worker-source')
  for (let attempt = 0; attempt < 200 && (exactResult?.status === 'queued' || exactResult?.status === 'running'); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 25))
    exactResult = getCompactWorkbenchValidationJob(exactSubmission.job.jobId, 'worker-source')
  }
  assert(exactResult)
  assert.equal(
    exactResult.status,
    'completed',
    exactResult.stderr || exactResult.reason || JSON.stringify(exactResult.protectedPathsChanged || [])
  )
  assert.equal(exactResult.exitCode, 0)
  assert.equal(exactResult.signal, null)
  assert(exactResult.stdout?.includes('worker-ok'))
  assert.equal(exactResult.outputTruncated, false)
  assert.equal(exactResult.terminatedByInfrastructure, false)

  const recoveryRequest = {
    sourceId: 'worker-source',
    idempotencyKey: 'validation:test:expired-worker-recovery',
    runId: 'worker-run',
    commandKind: 'run_package_script' as const,
    packageDir: '.',
    scriptName: 'validate:worker',
    timeoutMs: 30_000
  }
  const recoverySubmission = submitWorkbenchValidationJob(recoveryRequest)
  assert.equal(recoverySubmission.ok, true)
  if (!recoverySubmission.ok) throw new Error(recoverySubmission.message)

  const recoveryStore = JSON.parse(fs.readFileSync(validationJobStorePath, 'utf8')) as {
    updatedAt: string
    jobs: Array<Record<string, unknown>>
  }
  const recoveryNow = new Date()
  const recoveryStartedAt = new Date(recoveryNow.getTime() - 60_000).toISOString()
  const recoveryExpiredAt = new Date(recoveryNow.getTime() - 30_000).toISOString()
  const recoveryNowIso = recoveryNow.toISOString()
  const recoveryRecord = recoveryStore.jobs.find(job => job.jobId === recoverySubmission.job.jobId)
  assert(recoveryRecord)
  Object.assign(recoveryRecord, {
    status: 'running',
    startedAt: recoveryStartedAt,
    updatedAt: recoveryStartedAt,
    workerId: 'expired-worker-fixture',
    leaseToken: 'expired-worker-token',
    leaseAcquiredAt: recoveryStartedAt,
    leaseExpiresAt: recoveryExpiredAt
  })
  recoveryStore.updatedAt = recoveryStartedAt
  fs.writeFileSync(validationJobStorePath, JSON.stringify(recoveryStore), 'utf8')

  const recoveredWorker = recoverExpiredWorkbenchValidationJobs(recoveryNowIso)
  assert.equal(recoveredWorker.ok, true)
  if (!recoveredWorker.ok) throw new Error(recoveredWorker.message)
  assert.equal(recoveredWorker.recovered, 1)

  const recoveredJob = getCompactWorkbenchValidationJob(recoverySubmission.job.jobId, 'worker-source')
  assert(recoveredJob)
  assert.equal(recoveredJob.status, 'failed')
  assert.equal(recoveredJob.terminationReason, 'worker_failure')
  assert.equal(recoveredJob.terminatedByInfrastructure, true)
  const recoveredRecord = getWorkbenchValidationJob(recoverySubmission.job.jobId, 'worker-source')
  assert(recoveredRecord?.failedAt)
  activity = listWorkbenchActivity({ runId: 'worker-run', sourceId: 'worker-source', limit: 40 }).projection
  let recoveryEvents = activity.events.filter(event => event.validationJobId === recoverySubmission.job.jobId)
  assert.equal(recoveryEvents.filter(event => event.kind === 'validation_failed' && event.status === 'failed').length, 1)
  assert.equal(recoveryEvents.find(event => event.kind === 'validation_failed')?.occurredAt, recoveredRecord.failedAt)

  const lateTerminal = recordWorkbenchValidationJobResult({
    jobId: recoverySubmission.job.jobId,
    sourceId: 'worker-source',
    status: 'completed',
    result: {
      exitCode: 0,
      signal: null,
      durationMs: 100,
      stdout: 'late-success-must-not-overwrite',
      stderr: '',
      outputTruncated: false,
      changedPaths: [],
      terminatedByInfrastructure: false
    }
  })
  assert(lateTerminal)
  assert.equal(lateTerminal.status, 'failed')
  assert.equal(lateTerminal.terminationReason, 'worker_failure')
  assert.equal(lateTerminal.stdout?.includes('late-success-must-not-overwrite'), false)

  const recoveryDuplicate = submitWorkbenchValidationJob(recoveryRequest)
  assert.equal(recoveryDuplicate.ok, true)
  if (!recoveryDuplicate.ok) throw new Error(recoveryDuplicate.message)
  assert.equal(recoveryDuplicate.created, false)
  assert.equal(recoveryDuplicate.job.jobId, recoverySubmission.job.jobId)
  assert.equal(recoveryDuplicate.job.status, 'failed')
  const recoveryReschedule = scheduleWorkbenchValidationJob({
    jobId: recoverySubmission.job.jobId,
    sourceId: 'worker-source',
    sourceRoot: workerRoot,
    leaseMs: 60_000
  })
  assert.equal(recoveryReschedule.status, 'rejected')
  activity = listWorkbenchActivity({ runId: 'worker-run', sourceId: 'worker-source', limit: 40 }).projection
  recoveryEvents = activity.events.filter(event => event.validationJobId === recoverySubmission.job.jobId)
  assert.equal(recoveryEvents.filter(event => event.kind === 'validation_failed').length, 1)
  assert.notEqual(workerSubmission.job.jobId, failedSubmission.job.jobId)
  assert.notEqual(workerSubmission.job.jobId, timedOutSubmission.job.jobId)
  assert.equal(activity.events.filter(event => event.validationJobId === workerSubmission.job.jobId && event.kind === 'validation_completed').length, 1)
  assert.equal(activity.events.filter(event => event.validationJobId === failedSubmission.job.jobId && event.kind === 'validation_failed').length, 1)

  const rawActivityStore = fs.readFileSync(activityStorePath, 'utf8')
  assert.equal(rawActivityStore.includes('worker-ok'), false)
  assert.equal(rawActivityStore.includes('late-success-must-not-overwrite'), false)
  assert.equal(rawActivityStore.includes('stdoutTail'), false)
  assert.equal(rawActivityStore.includes('stderrTail'), false)
  assert.equal(rawActivityStore.includes(exactSubmission.job.jobId), false)

  const validStoreBackup = fs.readFileSync(validationJobStorePath, 'utf8')
  fs.writeFileSync(validationJobStorePath, '{broken', 'utf8')
  const corruptSubmit = submitWorkbenchValidationJob({
    sourceId: 'worker-source',
    idempotencyKey: 'validation:test:corrupt-store',
    commandKind: 'run_package_script',
    packageDir: '.',
    scriptName: 'validate:worker',
    timeoutMs: 30_000
  })
  assert.equal(corruptSubmit.ok, false)
  if (corruptSubmit.ok) throw new Error('Expected corrupt validation-job store rejection')
  assert.equal(corruptSubmit.code, 'VALIDATION_JOB_STORE_CORRUPT')
  const corruptCancel = cancelWorkbenchValidationJob({
    jobId: recoverySubmission.job.jobId,
    sourceId: 'worker-source',
    reason: 'corrupt store must fail closed'
  })
  assert.equal(corruptCancel.ok, false)
  if (corruptCancel.ok) throw new Error('Expected corrupt cancellation rejection')
  assert.equal(corruptCancel.code, 'VALIDATION_JOB_STORE_CORRUPT')
  const corruptRecovery = recoverExpiredWorkbenchValidationJobs('2026-08-15T07:02:00.000Z')
  assert.equal(corruptRecovery.ok, false)
  if (corruptRecovery.ok) throw new Error('Expected corrupt recovery rejection')
  assert.equal(corruptRecovery.code, 'VALIDATION_JOB_STORE_CORRUPT')
  const corruptSchedule = scheduleWorkbenchValidationJob({
    jobId: recoverySubmission.job.jobId,
    sourceId: 'worker-source',
    sourceRoot: workerRoot,
    leaseMs: 60_000
  })
  assert.equal(corruptSchedule.status, 'rejected')
  assert.match(corruptSchedule.reason || '', /corrupt/i)

  fs.writeFileSync(validationJobStorePath, validStoreBackup, 'utf8')
  const unsupportedStore = JSON.parse(validStoreBackup) as { version: number }
  unsupportedStore.version = 2
  fs.writeFileSync(validationJobStorePath, JSON.stringify(unsupportedStore), 'utf8')
  const unsupportedSubmit = submitWorkbenchValidationJob({
    sourceId: 'worker-source',
    idempotencyKey: 'validation:test:unsupported-store',
    commandKind: 'run_package_script',
    packageDir: '.',
    scriptName: 'validate:worker',
    timeoutMs: 30_000
  })
  assert.equal(unsupportedSubmit.ok, false)
  if (unsupportedSubmit.ok) throw new Error('Expected unsupported validation-job store rejection')
  assert.equal(unsupportedSubmit.code, 'VALIDATION_JOB_STORE_CORRUPT')
  fs.writeFileSync(validationJobStorePath, validStoreBackup, 'utf8')

  const responseRouteSource = fs.readFileSync(
    path.join(process.cwd(), 'apps/web/src/app/api/actions/run-command/route.ts'),
    'utf8'
  )
  assert.match(responseRouteSource, /clean\.status === 'timed_out' && validationJobOperation === undefined/)
  assert.match(responseRouteSource, /typeof job\?\.stdout === 'string'/)
  assert.match(responseRouteSource, /validationJobId:/)
  assert.match(responseRouteSource, /startedAt:/)
  assert.match(responseRouteSource, /completedAt:/)

  const openApiSource = fs.readFileSync(
    path.join(process.cwd(), 'apps/web/src/app/api/openapi/route.ts'),
    'utf8'
  )
  assert.match(openApiSource, /validationJobTimeoutMs/)
  assert.match(openApiSource, /maximum: 900000/)

  fs.rmSync(isolatedHome, { recursive: true, force: true })
  console.log('validation job persistence checks passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
