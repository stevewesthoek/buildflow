import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

async function main() {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'buildflow-validation-jobs-'))
  process.env.HOME = isolatedHome
  process.env.XDG_CONFIG_HOME = path.join(isolatedHome, '.config')

  const {
    getCompactWorkbenchValidationJob,
    getWorkbenchValidationJob,
    listCompactWorkbenchValidationJobs,
    scheduleWorkbenchValidationJob,
    submitWorkbenchValidationJob
  } = await import('../packages/cli/src/agent/workbench-validation-jobs')

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

  const workerRoot = path.join(isolatedHome, 'worker-repo')
  fs.mkdirSync(workerRoot, { recursive: true })
  fs.writeFileSync(path.join(workerRoot, 'package.json'), JSON.stringify({
    name: 'validation-worker-fixture',
    private: true,
    scripts: {
      'validate:worker': "node -e \"process.stdout.write('worker-ok')\""
    }
  }, null, 2))

  const workerSubmission = submitWorkbenchValidationJob({
    sourceId: 'worker-source',
    idempotencyKey: 'validation:test:worker',
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
  assert(workerResult.stdoutTail?.includes('worker-ok'))

  fs.rmSync(isolatedHome, { recursive: true, force: true })
  console.log('validation job persistence checks passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
