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
    getCompactWorkbenchValidationJob,
    getWorkbenchValidationJob,
    listCompactWorkbenchValidationJobs,
    scheduleWorkbenchValidationJob,
    submitWorkbenchValidationJob,
    toSafeCommandRequest
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
  assert.deepEqual(invalidExact.allowedValues, ['node', 'pnpm'])

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
  assert(workerResult.stdout?.includes('worker-ok'))
  assert(workerResult.stdoutTail?.includes('worker-ok'))

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
