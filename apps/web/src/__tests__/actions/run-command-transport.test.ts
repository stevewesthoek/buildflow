import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { dispatchWorkbenchCommand } from '../../lib/actions/gpt'
import { POST as runCommand } from '../../app/api/actions/run-command/route'

const sessionId = 'session-agent-example'
const sessionCommand = (command: Record<string, unknown>) => ({ version: 2, sessionId, command })

const exportRequest = {
  sourceId: 'brain',
  commandKind: 'n8n_workflow_export',
  workflowId: 'FwP5INe9qoo1OwGC',
  outputPath: 'operations/reports/artifacts/b1-0a-live-workflow-rollback.json',
  networkAccess: true,
  protectedPaths: [
    'tools/n8n-api.sh',
    'operations/automations/n8n/workflows/mind-inbox-fixed.json'
  ],
  timeoutMs: 12000
}

async function testN8nExportPassesTransportValidation() {
  const originalFetch = globalThis.fetch
  let requestBody: Record<string, unknown> | undefined

  try {
    globalThis.fetch = (async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({
        status: 'blocked',
        ok: false,
        sourceId: 'brain',
        commandKind: 'n8n_workflow_export',
        requiresConfirmation: true,
        confirmationToken: 'confirm:test-token'
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const result = await dispatchWorkbenchCommand(sessionCommand(exportRequest))
    assert.equal(result.commandKind, 'n8n_workflow_export')
    assert.equal(result.sourceId, 'brain')
    assert.equal(result.requiresConfirmation, true)
    assert.equal(result.confirmationToken, 'confirm:test-token')
    assert.equal(requestBody?.version, 2)
    assert.equal(requestBody?.sessionId, sessionId)
    const command = requestBody?.command as Record<string, unknown>
    assert.equal(command.commandKind, 'n8n_workflow_export')
    assert.equal(command.sourceId, 'brain')
    assert.equal(command.networkAccess, true)
    assert.deepEqual(command.protectedPaths, exportRequest.protectedPaths)
  } finally {
    globalThis.fetch = originalFetch
  }
}

async function testMigrationPassesStrictTransportAndPreservesConfirmationGate() {
  const originalFetch = globalThis.fetch
  let requestBody: Record<string, unknown> | undefined
  const migrationRequest = {
    sourceId: 'migration-example-source',
    commandKind: 'n8n_workflow_migration',
    migration: {
      mode: 'apply', phase: 'prepare', workflowId: 'workflow-example',
      candidatePath: 'artifacts/candidate.json', rollbackPath: 'artifacts/rollback.json',
      manifestPath: 'artifacts/manifest.json', networkAccess: true
    }
  }
  try {
    globalThis.fetch = (async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({
        status: 'needs_confirmation', sourceId: migrationRequest.sourceId,
        commandKind: 'n8n_workflow_migration', confirmationToken: 'confirmation-example',
        operation: {
          operationId: 'operation-example',
          status: 'prepared',
          revision: 0,
          binding: {
            sourceId: migrationRequest.sourceId,
            workflowId: 'workflow-example',
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
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const result = await dispatchWorkbenchCommand(sessionCommand(migrationRequest))
    assert.equal(result.commandKind, 'n8n_workflow_migration')
    assert.equal(result.status, 'needs_confirmation')
    assert.equal(result.confirmationToken, 'confirmation-example')
    const operation = result.operation as {
      operationId?: string
      status?: string
      revision?: number
      binding?: Record<string, unknown>
      confirmationExpiresAt?: string
      rollbackReady?: boolean
    }
    assert.equal(operation.operationId, 'operation-example')
    assert.equal(operation.status, 'prepared')
    assert.equal(operation.revision, 0)
    assert.equal(operation.binding?.sourceId, migrationRequest.sourceId)
    assert.equal(operation.binding?.workflowId, 'workflow-example')
    assert.equal(operation.binding?.candidateSha256, 'a'.repeat(64))
    assert.equal(operation.binding?.rollbackSha256, 'b'.repeat(64))
    assert.equal(operation.binding?.manifestSha256, 'c'.repeat(64))
    assert.equal(operation.binding?.wrapperSha256, 'd'.repeat(64))
    assert.equal(operation.confirmationExpiresAt, '2026-07-19T19:30:00.000Z')
    assert.equal(operation.rollbackReady, true)
    assert.equal((result.activity as { phase?: string }).phase, 'waiting_for_confirmation')
    assert.equal((result.activity as { requiresConfirmation?: boolean }).requiresConfirmation, true)
    assert.deepEqual(requestBody, sessionCommand(migrationRequest))
  } finally {
    globalThis.fetch = originalFetch
  }
}

async function testUnsupportedCommandKindsRemainRejected() {
  const originalFetch = globalThis.fetch
  const originalToken = process.env.WORKBENCH_ACTION_TOKEN
  const originalMode = process.env.WORKBENCH_BACKEND_MODE
  let fetchCalls = 0

  try {
    process.env.WORKBENCH_ACTION_TOKEN = 'test-action-token'
    process.env.WORKBENCH_BACKEND_MODE = 'direct-agent'
    globalThis.fetch = (async () => {
      fetchCalls += 1
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    await assert.rejects(
      () => dispatchWorkbenchCommand(sessionCommand({ sourceId: 'brain', commandKind: 'unsupported_command' })),
      /Invalid runWorkbenchCommand request/
    )
    await assert.rejects(
      () => dispatchWorkbenchCommand(sessionCommand({ sourceId: 'brain', commandKind: 'git_status_short', args: ['status'] })),
      /Invalid runWorkbenchCommand request/
    )
    await assert.rejects(
      () => dispatchWorkbenchCommand({ sourceId: 'brain', commandKind: 'git_status_short' }),
      /Invalid runWorkbenchCommand request/
    )

    const response = await runCommand(new NextRequest('http://127.0.0.1:3054/api/actions/run-command', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-action-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify(sessionCommand({ sourceId: 'brain', commandKind: 'git_status_short', args: ['status'] }))
    }))
    const payload = await response.json()
    assert.equal(response.status, 400)
    assert.equal(payload.error?.code, 'INVALID_WORKBENCH_COMMAND_REQUEST')

    const legacyResponse = await runCommand(new NextRequest('http://127.0.0.1:3054/api/actions/run-command', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-action-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ sourceId: 'brain', commandKind: 'git_status_short' })
    }))
    const legacyPayload = await legacyResponse.json()
    assert.equal(legacyResponse.status, 400)
    assert.equal(legacyPayload.error?.code, 'INVALID_WORKBENCH_COMMAND_REQUEST')
    assert.equal(fetchCalls, 0, 'invalid command shapes must be rejected before transport')
  } finally {
    globalThis.fetch = originalFetch
    if (originalToken === undefined) delete process.env.WORKBENCH_ACTION_TOKEN
    else process.env.WORKBENCH_ACTION_TOKEN = originalToken
    if (originalMode === undefined) delete process.env.WORKBENCH_BACKEND_MODE
    else process.env.WORKBENCH_BACKEND_MODE = originalMode
  }
}

async function testRunCommandRoutePreservesConfirmationGate() {
  const originalFetch = globalThis.fetch
  const originalToken = process.env.WORKBENCH_ACTION_TOKEN
  const originalMode = process.env.WORKBENCH_BACKEND_MODE

  try {
    process.env.WORKBENCH_ACTION_TOKEN = 'test-action-token'
    process.env.WORKBENCH_BACKEND_MODE = 'direct-agent'
    globalThis.fetch = (async () => new Response(JSON.stringify({
      status: 'needs_confirmation',
      commandKind: 'n8n_workflow_export',
      requiresConfirmation: true,
      confirmationToken: 'confirm:test-token',
      reason: 'confirmation_required_for_brain_n8n_workflow_export'
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch

    const response = await runCommand(new NextRequest('http://127.0.0.1:3054/api/actions/run-command', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-action-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify(sessionCommand(exportRequest))
    }))
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.sourceId, 'brain')
    assert.equal(payload.requiresConfirmation, true)
    assert.equal(payload.reason, 'confirmation_required_for_brain_n8n_workflow_export')
    assert.equal(payload.confirmationToken, 'confirm:test-token')
  } finally {
    globalThis.fetch = originalFetch
    if (originalToken === undefined) delete process.env.WORKBENCH_ACTION_TOKEN
    else process.env.WORKBENCH_ACTION_TOKEN = originalToken
    if (originalMode === undefined) delete process.env.WORKBENCH_BACKEND_MODE
    else process.env.WORKBENCH_BACKEND_MODE = originalMode
  }
}

async function testRunCommandRoutePreservesMigrationOperation() {
  const originalFetch = globalThis.fetch
  const originalToken = process.env.WORKBENCH_ACTION_TOKEN
  const originalMode = process.env.WORKBENCH_BACKEND_MODE
  const migrationRequest = {
    sourceId: 'migration-example-source',
    commandKind: 'n8n_workflow_migration',
    migration: {
      mode: 'apply', phase: 'prepare', workflowId: 'workflow-example',
      candidatePath: 'artifacts/candidate.json', rollbackPath: 'artifacts/rollback.json',
      manifestPath: 'artifacts/manifest.json', networkAccess: true
    }
  }

  try {
    process.env.WORKBENCH_ACTION_TOKEN = 'test-action-token'
    process.env.WORKBENCH_BACKEND_MODE = 'direct-agent'
    globalThis.fetch = (async () => new Response(JSON.stringify({
      status: 'needs_confirmation',
      sourceId: migrationRequest.sourceId,
      commandKind: migrationRequest.commandKind,
      migrationMode: 'apply',
      migrationPhase: 'prepare',
      confirmationToken: 'confirmation-example',
      operation: {
        operationId: 'operation-example',
        status: 'prepared',
        revision: 0,
        binding: {
          sourceId: migrationRequest.sourceId,
          workflowId: 'workflow-example',
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
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch

    const response = await runCommand(new NextRequest('http://127.0.0.1:3054/api/actions/run-command', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-action-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify(sessionCommand(migrationRequest))
    }))
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.sourceId, migrationRequest.sourceId)
    assert.equal(payload.commandKind, migrationRequest.commandKind)
    assert.equal(payload.migrationMode, 'apply')
    assert.equal(payload.migrationPhase, 'prepare')
    assert.equal(payload.confirmationToken, 'confirmation-example')
    assert.equal(payload.operation?.operationId, 'operation-example')
    assert.equal(payload.operation?.status, 'prepared')
    assert.equal(payload.operation?.revision, 0)
    assert.equal(payload.operation?.binding?.sourceId, migrationRequest.sourceId)
    assert.equal(payload.operation?.binding?.workflowId, 'workflow-example')
    assert.equal(payload.operation?.binding?.mode, 'apply')
    assert.equal(payload.operation?.binding?.candidatePath, 'artifacts/candidate.json')
    assert.equal(payload.operation?.binding?.candidateSha256, 'a'.repeat(64))
    assert.equal(payload.operation?.binding?.rollbackPath, 'artifacts/rollback.json')
    assert.equal(payload.operation?.binding?.rollbackSha256, 'b'.repeat(64))
    assert.equal(payload.operation?.binding?.manifestPath, 'artifacts/manifest.json')
    assert.equal(payload.operation?.binding?.manifestSha256, 'c'.repeat(64))
    assert.equal(payload.operation?.binding?.wrapperSha256, 'd'.repeat(64))
    assert.equal(payload.operation?.confirmationExpiresAt, '2026-07-19T19:30:00.000Z')
    assert.equal(payload.operation?.rollbackReady, true)
    assert.notEqual(payload.activity?.operationId, payload.operation?.operationId)
    assert.equal(payload.activity?.operationId, 'runWorkbenchCommand')
    assert.equal(payload.activity?.phase, 'waiting_for_confirmation')
  } finally {
    globalThis.fetch = originalFetch
    if (originalToken === undefined) delete process.env.WORKBENCH_ACTION_TOKEN
    else process.env.WORKBENCH_ACTION_TOKEN = originalToken
    if (originalMode === undefined) delete process.env.WORKBENCH_BACKEND_MODE
    else process.env.WORKBENCH_BACKEND_MODE = originalMode
  }
}

async function testRunCommandRoutePreservesProtectedDomainMismatchNames() {
  const originalFetch = globalThis.fetch
  const originalToken = process.env.WORKBENCH_ACTION_TOKEN
  const originalMode = process.env.WORKBENCH_BACKEND_MODE
  const migrationRequest = {
    sourceId: 'migration-example-source',
    commandKind: 'n8n_workflow_migration',
    migration: {
      mode: 'apply', phase: 'status', operationId: 'operation-example'
    }
  }

  try {
    process.env.WORKBENCH_ACTION_TOKEN = 'test-action-token'
    process.env.WORKBENCH_BACKEND_MODE = 'direct-agent'
    globalThis.fetch = (async () => new Response(JSON.stringify({
      status: 'completed',
      sourceId: migrationRequest.sourceId,
      commandKind: migrationRequest.commandKind,
      migrationMode: 'apply',
      migrationPhase: 'status',
      operation: {
        operationId: 'operation-example',
        status: 'failed',
        revision: 4,
        protectedDomains: 'unverified',
        protectedDomainMismatches: ['activation', 'settings'],
        executorReasonCode: 'PROTECTED_DOMAIN_MISMATCH',
        candidateUpdate: 0,
        rollbackUpdate: 0
      }
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch

    const response = await runCommand(new NextRequest('http://127.0.0.1:3054/api/actions/run-command', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-action-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify(sessionCommand(migrationRequest))
    }))
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.operation?.status, 'failed')
    assert.equal(payload.operation?.protectedDomains, 'unverified')
    assert.deepEqual(payload.operation?.protectedDomainMismatches, ['activation', 'settings'])
    assert.equal(payload.operation?.executorReasonCode, 'PROTECTED_DOMAIN_MISMATCH')
    assert.equal(payload.operation?.candidateUpdate, 0)
    assert.equal(payload.operation?.rollbackUpdate, 0)
  } finally {
    globalThis.fetch = originalFetch
    if (originalToken === undefined) delete process.env.WORKBENCH_ACTION_TOKEN
    else process.env.WORKBENCH_ACTION_TOKEN = originalToken
    if (originalMode === undefined) delete process.env.WORKBENCH_BACKEND_MODE
    else process.env.WORKBENCH_BACKEND_MODE = originalMode
  }
}

async function testRunCommandRouteBoundsCommandOutput() {
  const originalFetch = globalThis.fetch
  const originalToken = process.env.WORKBENCH_ACTION_TOKEN
  const originalMode = process.env.WORKBENCH_BACKEND_MODE

  try {
    process.env.WORKBENCH_ACTION_TOKEN = 'test-action-token'
    process.env.WORKBENCH_BACKEND_MODE = 'direct-agent'
    globalThis.fetch = (async () => new Response(JSON.stringify({
      status: 'completed',
      sourceId: 'brain',
      commandKind: 'git_status_short',
      exitCode: 0,
      stdout: `sensitive-prefix-${'x'.repeat(30_000)}`,
      stderr: `stderr-prefix-${'y'.repeat(30_000)}`,
      outputTruncated: false,
      durationMs: 42
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch

    const response = await runCommand(new NextRequest('http://127.0.0.1:3054/api/actions/run-command', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-action-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify(sessionCommand({ sourceId: 'brain', commandKind: 'git_status_short' }))
    }))
    const text = await response.text()
    const payload = JSON.parse(text) as Record<string, unknown>
    assert.equal(response.status, 200)
    assert(Buffer.byteLength(text, 'utf8') <= 8 * 1024)
    assert.equal(payload.outputTruncated, true)
    assert.equal(String(payload.stdout).includes('sensitive-prefix-'), false)
    assert.equal(String(payload.stderr).includes('stderr-prefix-'), false)
  } finally {
    globalThis.fetch = originalFetch
    if (originalToken === undefined) delete process.env.WORKBENCH_ACTION_TOKEN
    else process.env.WORKBENCH_ACTION_TOKEN = originalToken
    if (originalMode === undefined) delete process.env.WORKBENCH_BACKEND_MODE
    else process.env.WORKBENCH_BACKEND_MODE = originalMode
  }
}

async function main() {
  await testN8nExportPassesTransportValidation()
  await testMigrationPassesStrictTransportAndPreservesConfirmationGate()
  await testUnsupportedCommandKindsRemainRejected()
  await testRunCommandRoutePreservesConfirmationGate()
  await testRunCommandRoutePreservesMigrationOperation()
  await testRunCommandRoutePreservesProtectedDomainMismatchNames()
  await testRunCommandRouteBoundsCommandOutput()
  console.log('✓ n8n_workflow_export passes transport validation and preserves confirmation gating')
  console.log('✓ n8n_workflow_migration preserves strict nested transport and confirmation gating')
  console.log('✓ run-command route preserves the controlled migration operation separately from activity metadata')
  console.log('✓ run-command route preserves secret-safe protected-domain mismatch names')
  console.log('✓ run-command preserves the backend confirmation token and source ID')
  console.log('✓ run-command bounds public command output to the GPT response budget')
  console.log('✓ Unsupported command kinds remain rejected before transport')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
