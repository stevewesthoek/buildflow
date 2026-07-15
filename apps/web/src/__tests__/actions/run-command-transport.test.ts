import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { dispatchWorkbenchCommand } from '../../lib/actions/gpt'
import { POST as runCommand } from '../../app/api/actions/run-command/route'

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

    const result = await dispatchWorkbenchCommand(exportRequest)
    assert.equal(result.commandKind, 'n8n_workflow_export')
    assert.equal(result.sourceId, 'brain')
    assert.equal(result.requiresConfirmation, true)
    assert.equal(result.confirmationToken, 'confirm:test-token')
    assert.equal(requestBody?.commandKind, 'n8n_workflow_export')
    assert.equal(requestBody?.sourceId, 'brain')
    assert.equal(requestBody?.networkAccess, true)
    assert.deepEqual(requestBody?.protectedPaths, exportRequest.protectedPaths)
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
        operation: { operationId: 'operation-example', status: 'prepared' }
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const result = await dispatchWorkbenchCommand(migrationRequest)
    assert.equal(result.commandKind, 'n8n_workflow_migration')
    assert.equal(result.status, 'needs_confirmation')
    assert.equal(result.confirmationToken, 'confirmation-example')
    assert.equal((result.activity as { phase?: string }).phase, 'waiting_for_confirmation')
    assert.equal((result.activity as { requiresConfirmation?: boolean }).requiresConfirmation, true)
    assert.deepEqual(requestBody, migrationRequest)
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
      () => dispatchWorkbenchCommand({ sourceId: 'brain', commandKind: 'unsupported_command' }),
      /Invalid runWorkbenchCommand request/
    )
    await assert.rejects(
      () => dispatchWorkbenchCommand({ sourceId: 'brain', commandKind: 'git_status_short', args: ['status'] }),
      /Invalid runWorkbenchCommand request/
    )

    const response = await runCommand(new NextRequest('http://127.0.0.1:3054/api/actions/run-command', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-action-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ sourceId: 'brain', commandKind: 'git_status_short', args: ['status'] })
    }))
    const payload = await response.json()
    assert.equal(response.status, 400)
    assert.equal(payload.error?.code, 'INVALID_WORKBENCH_COMMAND_REQUEST')
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
      body: JSON.stringify(exportRequest)
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

async function main() {
  await testN8nExportPassesTransportValidation()
  await testMigrationPassesStrictTransportAndPreservesConfirmationGate()
  await testUnsupportedCommandKindsRemainRejected()
  await testRunCommandRoutePreservesConfirmationGate()
  console.log('✓ n8n_workflow_export passes transport validation and preserves confirmation gating')
  console.log('✓ n8n_workflow_migration preserves strict nested transport and confirmation gating')
  console.log('✓ run-command preserves the backend confirmation token and source ID')
  console.log('✓ Unsupported command kinds remain rejected before transport')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
