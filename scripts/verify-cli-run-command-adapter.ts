import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  parseRunCommandRequest,
  toSafeCommandRequest
} from '../packages/cli/src/agent/run-command-request'
import { runControlledWorkflowMigrationCommand } from '../packages/cli/src/agent/n8n-workflow-migration-command-adapter'

const invalid = parseRunCommandRequest({
  sourceId: 'brain',
  commandKind: 'git_status_short',
  args: ['status']
})
assert.equal(invalid.ok, false)
if (!invalid.ok) {
  assert.equal(invalid.error.code, 'INVALID_WORKBENCH_COMMAND_REQUEST')
  assert.ok(invalid.error.issues.length > 0)
  assert.ok(invalid.error.issues.length <= 10)
}

const direct = parseRunCommandRequest({
  sourceId: 'workbench-example-source',
  commandKind: 'git_diff',
  paths: ['packages/cli/src/agent/server.ts'],
  timeoutMs: 5000
})
assert.equal(direct.ok, true)
if (direct.ok && direct.kind === 'direct') {
  const safe = toSafeCommandRequest(direct.request, '/srv/workbench')
  assert.equal(safe.sourceId, 'workbench-example-source')
  assert.equal(safe.sourceRoot, '/srv/workbench')
  assert.equal(safe.commandKind, 'git_diff')
  assert.deepEqual(safe.paths, ['packages/cli/src/agent/server.ts'])
  assert.equal(safe.timeoutMs, 5000)
}

const exportRequest = parseRunCommandRequest({
  sourceId: 'brain',
  commandKind: 'n8n_workflow_export',
  workflowId: 'workflow-id',
  outputPath: 'operations/reports/rollback.json',
  networkAccess: true,
  protectedPaths: ['tools/n8n-api.sh'],
  confirmedByUser: true
})
assert.equal(exportRequest.ok, true)
if (exportRequest.ok && exportRequest.kind === 'direct') {
  const safe = toSafeCommandRequest(exportRequest.request, '/srv/brain')
  assert.equal(safe.commandKind, 'n8n_workflow_export')
  assert.equal(safe.workflowId, 'workflow-id')
  assert.equal(safe.outputPath, 'operations/reports/rollback.json')
  assert.equal(safe.networkAccess, true)
  assert.equal(safe.confirmedByUser, true)
}

const submit = parseRunCommandRequest({
  sourceId: 'workbench-example-source',
  commandKind: 'run_exact_command',
  validationJobOperation: 'submit',
  idempotencyKey: 'adapter-test',
  validationJobTimeoutMs: 45000,
  executable: 'rg',
  args: ['-n', 'parseRunCommandRequest', 'packages/cli/src'],
  networkAccess: false,
  policy: { denyNetworkCommands: true },
  protectedPaths: ['AGENTS.md']
})
assert.equal(submit.ok, true)
if (submit.ok && submit.kind === 'validation_submit') {
  assert.equal(submit.request.commandKind, 'run_exact_command')
  assert.equal(submit.request.timeoutMs, 45000)
  assert.equal(submit.request.networkAccess, false)
  assert.deepEqual(submit.request.protectedPaths, ['AGENTS.md'])
}

const status = parseRunCommandRequest({
  sourceId: 'workbench-example-source',
  commandKind: 'type_check_cli',
  validationJobOperation: 'status',
  validationJobId: 'job-id'
})
assert.equal(status.ok, true)
if (status.ok && status.kind === 'validation_status') {
  assert.equal(status.validationJobId, 'job-id')
  assert.equal(status.commandKind, 'type_check_cli')
}

async function verifyMigrationAdapter() {
const migration = parseRunCommandRequest({
  sourceId: 'brain',
  commandKind: 'n8n_workflow_migration',
  migration: {
    mode: 'apply',
    phase: 'prepare',
    workflowId: 'workflow-id',
    candidatePath: 'artifacts/candidate.json',
    rollbackPath: 'artifacts/rollback.json',
    manifestPath: 'artifacts/manifest.json',
    networkAccess: true
  }
})
assert.equal(migration.ok, true)
if (migration.ok && migration.kind === 'migration') {
  let executorCreated = false
  const result = await runControlledWorkflowMigrationCommand(migration.request, {
    getSources: () => [{ id: 'brain', label: 'Brain', path: '/srv/brain', enabled: true }],
    getConfiguredGrants: () => undefined,
    realpath: value => value,
    createExecutor: () => {
      executorCreated = true
      return async () => { throw new Error('executor must not run without a grant') }
    }
  })
  assert.equal(result.statusCode, 503)
  assert.equal(result.body.error?.code, 'capability_not_configured')
  assert.equal(result.body.migrationMode, 'apply')
  assert.equal(result.body.migrationPhase, 'prepare')
  assert.equal(executorCreated, false, 'missing grants must not construct or invoke an executor')

  let mixedGrantPrepareCalled = false
  const invalidMixedGrant = await runControlledWorkflowMigrationCommand(migration.request, {
    getSources: () => [{ id: 'brain', label: 'Brain', path: '/srv/brain', enabled: true }],
    getConfiguredGrants: () => [{
      grantId: 'valid-looking-grant',
      version: 1,
      enabled: true,
      sourceId: 'brain',
      workflowId: 'workflow-id',
      wrapperPath: 'tools/n8n-api.sh',
      wrapperSha256: 'a'.repeat(64),
      allowedCandidateRoots: ['artifacts'],
      allowedRollbackRoots: ['artifacts'],
      allowedManifestRoots: ['artifacts'],
      canonicalizationVersion: 1,
      confirmationTtlSeconds: 600,
      operationTimeoutMs: 120000,
      maxArtifactBytes: 1048576,
      maximumPolicy: {
        activation: 'unchanged', settings: 'unchanged', tags: 'unchanged', sharing: 'unchanged',
        credentials: 'unchanged', webhooks: 'unchanged', schedules: 'unchanged'
      }
    }, { grantId: 'malformed-neighbor' }],
    realpath: value => value,
    prepare: (async () => {
      mixedGrantPrepareCalled = true
      throw new Error('prepare must not run for a partially invalid grant set')
    }) as never
  })
  assert.equal(invalidMixedGrant.statusCode, 503)
  assert.deepEqual(invalidMixedGrant.body.error, {
    code: 'capability_not_configured', message: 'Controlled workflow migration grants are invalid.'
  })
  assert.equal(mixedGrantPrepareCalled, false, 'any grant parse issue must disable the entire capability')
}

  const phaseSource = () => [{ id: 'migration-source', label: 'Migration source', path: '/srv/migration-source', enabled: true }]
  const projectedOperation = {
    operationId: 'cap-op-example',
    status: 'prepared',
    revision: 0,
    binding: {
      sourceId: 'migration-source',
      workflowId: 'workflow-id',
      mode: 'apply',
      candidatePath: 'artifacts/candidate.json',
      candidateSha256: 'a'.repeat(64),
      rollbackPath: 'artifacts/rollback.json',
      rollbackSha256: 'b'.repeat(64),
      manifestPath: 'artifacts/manifest.json',
      manifestSha256: 'c'.repeat(64),
      wrapperSha256: 'd'.repeat(64)
    },
    confirmationExpiresAt: '2026-07-19T19:30:00.000Z',
    rollbackReady: true
  }
  const phaseDependencies = {
    getSources: phaseSource,
    getConfiguredGrants: () => undefined,
    realpath: (value: string) => value,
    prepare: (async (request: { sourceId: string }) => ({
      ok: true as const, status: 'needs_confirmation' as const, confirmationToken: 'opaque-confirmation-token', operation: { ...projectedOperation, sourceId: request.sourceId }
    })) as never,
    execute: (async (request: { operationId: string }) => ({
      ok: true as const, status: 'completed' as const, operation: { ...projectedOperation, operationId: request.operationId, status: 'completed' }
    })) as never,
    status: ((request: { operationId: string }) => ({
      ok: true as const, status: 'prepared' as const, operation: { ...projectedOperation, operationId: request.operationId }
    })) as never
  }
  const prepare = parseRunCommandRequest({
    sourceId: 'migration-source', commandKind: 'n8n_workflow_migration',
    migration: { mode: 'apply', phase: 'prepare', workflowId: 'workflow-id', candidatePath: 'artifacts/candidate.json', rollbackPath: 'artifacts/rollback.json', manifestPath: 'artifacts/manifest.json', networkAccess: true }
  })
  const execute = parseRunCommandRequest({
    sourceId: 'migration-source', commandKind: 'n8n_workflow_migration',
    migration: { mode: 'apply', phase: 'execute', operationId: 'cap-op-execute', confirmationToken: 'opaque-confirmation-token' }
  })
  const status = parseRunCommandRequest({
    sourceId: 'migration-source', commandKind: 'n8n_workflow_migration',
    migration: { mode: 'apply', phase: 'status', operationId: 'cap-op-status' }
  })
  for (const parsed of [prepare, execute, status]) {
    assert.equal(parsed.ok, true)
    if (!parsed.ok || parsed.kind !== 'migration') continue
    const response = await runControlledWorkflowMigrationCommand(parsed.request, phaseDependencies)
    assert.equal(response.statusCode, 200)
    assert.equal(response.body.migrationPhase, parsed.request.migration.phase)
    assert.equal(response.body.commandKind, 'n8n_workflow_migration')
    if (parsed.request.migration.phase === 'prepare') {
      assert.equal(response.body.confirmationToken, 'opaque-confirmation-token')
      const operation = response.body.operation as typeof projectedOperation
      assert.equal(operation.operationId, 'cap-op-example')
      assert.equal(operation.status, 'prepared')
      assert.equal(operation.revision, 0)
      assert.equal(operation.binding.sourceId, 'migration-source')
      assert.equal(operation.binding.workflowId, 'workflow-id')
      assert.equal(operation.binding.candidateSha256, 'a'.repeat(64))
      assert.equal(operation.binding.rollbackSha256, 'b'.repeat(64))
      assert.equal(operation.binding.manifestSha256, 'c'.repeat(64))
      assert.equal(operation.binding.wrapperSha256, 'd'.repeat(64))
      assert.equal(operation.confirmationExpiresAt, '2026-07-19T19:30:00.000Z')
      assert.equal(operation.rollbackReady, true)
      assert.equal(Object.hasOwn(response.body, 'operationRecord'), false)
    }
  }
  if (execute.ok && execute.kind === 'migration') {
    const consumeMutationDispatch = () => ({ ok: true as const })
    let capturedHost: Record<string, unknown> | undefined
    let capturedInvocation: Record<string, unknown> | undefined
    const response = await runControlledWorkflowMigrationCommand(execute.request, {
      getSources: phaseSource,
      getConfiguredGrants: () => [],
      realpath: (value: string) => value,
      createExecutor: ((host: Record<string, unknown>) => {
        capturedHost = host
        return async (invocation: Record<string, unknown>) => {
          capturedInvocation = invocation
          return {
            operationId: 'cap-op-execute', workflowId: 'workflow-id', effect: 'apply_candidate',
            classification: 'blocked', reasonCode: 'EFFECT_NOT_LEGAL'
          }
        }
      }) as never,
      execute: (async (_request: unknown, dependencies: { executor: (input: Record<string, unknown>) => Promise<unknown> }) => {
        await dependencies.executor({
          effect: { type: 'apply_candidate' }, operation: {}, grant: {}, consumeMutationDispatch
        })
        return {
          ok: true as const, status: 'completed' as const,
          operation: { ...projectedOperation, operationId: 'cap-op-execute', status: 'completed' }
        }
      }) as never
    })
    assert.equal(response.statusCode, 200)
    assert.equal(capturedHost?.consumeMutationDispatch, consumeMutationDispatch)
    assert.equal(Object.hasOwn(capturedInvocation ?? {}, 'consumeMutationDispatch'), false)
    assert.deepEqual(capturedInvocation, { effect: { type: 'apply_candidate' }, operation: {}, grant: {} })
  }
  if (status.ok && status.kind === 'migration') {
    const mismatch = await runControlledWorkflowMigrationCommand(status.request, {
      ...phaseDependencies,
      status: ((request: { operationId: string }) => ({
        ok: true as const,
        status: 'failed' as const,
        operation: {
          ...projectedOperation,
          operationId: request.operationId,
          status: 'failed',
          reasonCode: 'PRECONDITION_UNAVAILABLE',
          protectedDomains: 'unverified',
          protectedDomainMismatches: ['activation', 'settings']
        }
      })) as never
    })
    assert.equal(mismatch.statusCode, 200)
    const operation = mismatch.body.operation as {
      protectedDomains: string
      protectedDomainMismatches: string[]
    }
    assert.equal(operation.protectedDomains, 'unverified')
    assert.deepEqual(operation.protectedDomainMismatches, ['activation', 'settings'])
  }
  if (prepare.ok && prepare.kind === 'migration') {
    const blocked = await runControlledWorkflowMigrationCommand(prepare.request, {
      ...phaseDependencies,
      prepare: (async () => { throw new Error('/private/path/and-secret must not be exposed') }) as never
    })
    assert.equal(blocked.statusCode, 409)
    assert.deepEqual(blocked.body.error, {
      code: 'mutation_blocked', message: 'Controlled workflow migration could not be completed safely.'
    })
  }
}

const sourceRootInjection = parseRunCommandRequest({
  sourceId: 'workbench-example-source',
  commandKind: 'git_status_short',
  sourceRoot: '/attacker-controlled'
})
assert.equal(sourceRootInjection.ok, false, 'sourceRoot must never be accepted from public input')

const migrationExecutable = parseRunCommandRequest({
  sourceId: 'brain',
  commandKind: 'n8n_workflow_migration',
  executable: 'node',
  migration: {
    mode: 'apply',
    phase: 'status',
    operationId: 'operation-id'
  }
})
assert.equal(migrationExecutable.ok, false, 'migration must reject caller-selected executables')

const adapterSource = fs.readFileSync(path.resolve(__dirname, '../packages/cli/src/agent/n8n-workflow-migration-command-adapter.ts'), 'utf8')
assert.doesNotMatch(adapterSource, /spawn\(|child_process|update-workflow|wrapperOperation|confirmationDigest|dispatchAuthorization|leaseProof/)
assert.match(adapterSource, /const \{ consumeMutationDispatch, \.\.\.invocation \} = input/)
assert.match(adapterSource, /\}\)\(invocation\)/, 'host-only dispatch authority must not enter the strict executor invocation')

void verifyMigrationAdapter().then(() => {
  console.log('CLI runWorkbenchCommand adapter verification passed')
}).catch(error => {
  console.error(error)
  process.exitCode = 1
})
