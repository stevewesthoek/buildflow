import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createWorkbenchMcpServer } from '../mcp-server.js'
import { loadWorkbenchMcpScope } from '../scope.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

async function connectedPair(invoke?: Parameters<typeof createWorkbenchMcpServer>[0]['invoke']) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createWorkbenchMcpServer({
    repoRoot,
    invoke: invoke ?? (async (_contract, input) => ({ ok: true, result: { status: 'ok', input } }))
  })
  const client = new Client({ name: 'workbench-mcp-test', version: '1.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return { client, server }
}

test('initializes, advertises instructions, and lists exactly five bounded tools', async () => {
  const { client, server } = await connectedPair()
  try {
    assert(client.getInstructions()?.includes('admitted bounded Workbench actions'))
    const listed = await client.listTools()
    assert.deepEqual(listed.tools.map(tool => tool.name), [
      'getWorkbenchStatus',
      'readWorkbenchContext',
      'applyWorkbenchFileChange',
      'commitWorkbenchChanges',
      'runWorkbenchCommand'
    ])
    assert.equal(listed.tools[0].annotations?.readOnlyHint, true)
    assert.equal(listed.tools[2].annotations?.destructiveHint, true)
  } finally {
    await client.close()
    await server.close()
  }
})

test('advertises and enforces an installation-admitted tool and nested-command scope', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createWorkbenchMcpServer({
    repoRoot,
    scope: loadWorkbenchMcpScope({
      WORKBENCH_MCP_ALLOWED_TOOLS: 'getWorkbenchStatus,readWorkbenchContext,runWorkbenchCommand',
      WORKBENCH_MCP_ALLOWED_COMMAND_KINDS: 'n8n_workflow_migration'
    }),
    invoke: async (_contract, input) => ({ ok: true, result: { status: 'ok', input } })
  })
  const client = new Client({ name: 'workbench-mcp-scope-test', version: '1.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    const listed = await client.listTools()
    assert.deepEqual(listed.tools.map(tool => tool.name), [
      'getWorkbenchStatus', 'readWorkbenchContext', 'runWorkbenchCommand'
    ])
    await assert.rejects(
      client.callTool({ name: 'applyWorkbenchFileChange', arguments: {} }),
      /Unknown or unadmitted Workbench MCP tool/
    )
    const denied = await client.callTool({
      name: 'runWorkbenchCommand',
      arguments: { sourceId: 'brain', commandKind: 'git_status_short' }
    })
    assert.equal(denied.isError, true)
    assert(JSON.stringify(denied).includes('mcp_scope_denied'))
  } finally {
    await client.close()
    await server.close()
  }
})

test('rejects unknown or incoherent admitted scope values', () => {
  assert.throws(() => loadWorkbenchMcpScope({ WORKBENCH_MCP_ALLOWED_TOOLS: 'unknown' }), /unknown values/)
  assert.throws(() => loadWorkbenchMcpScope({
    WORKBENCH_MCP_ALLOWED_TOOLS: 'getWorkbenchStatus',
    WORKBENCH_MCP_ALLOWED_COMMAND_KINDS: 'n8n_workflow_migration'
  }), /requires runWorkbenchCommand/)
})

test('invokes a validated tool and returns structured content', async () => {
  const { client, server } = await connectedPair()
  try {
    const result = await client.callTool({
      name: 'runWorkbenchCommand',
      arguments: { sourceId: 'workbench-example-source', commandKind: 'git_status_short' }
    })
    assert.equal(result.isError, false)
    assert.deepEqual(result.structuredContent, {
      status: 'ok',
      input: { sourceId: 'workbench-example-source', commandKind: 'git_status_short' }
    })
  } finally {
    await client.close()
    await server.close()
  }
})

test('rejects malformed, unknown, and oversized tool calls', async () => {
  const { client, server } = await connectedPair()
  try {
    const malformed = await client.callTool({
      name: 'runWorkbenchCommand',
      arguments: { sourceId: 'workbench-example-source', commandKind: 'git_status_short', shell: 'bash' }
    })
    assert.equal(malformed.isError, true)
    assert(JSON.stringify(malformed).includes('invalid_mcp_request'))

    const oversized = await client.callTool({
      name: 'readWorkbenchContext',
      arguments: { mode: 'search', sourceId: 'source', query: 'x'.repeat(70_000) }
    })
    assert.equal(oversized.isError, true)
    assert(JSON.stringify(oversized).includes('exceeded the allowed size'))

    await assert.rejects(
      client.callTool({ name: 'unknownWorkbenchTool', arguments: {} }),
      /Unknown or unadmitted Workbench MCP tool/
    )
  } finally {
    await client.close()
    await server.close()
  }
})

test('propagates cancellation to an in-flight Workbench client', async () => {
  let observedAbort = false
  const { client, server } = await connectedPair(async (_contract, _input, signal) => {
    await new Promise<void>(resolve => {
      if (signal?.aborted) {
        observedAbort = true
        resolve()
        return
      }
      signal?.addEventListener('abort', () => { observedAbort = true; resolve() }, { once: true })
    })
    return { ok: false, code: 'bridge_internal_error', message: 'Workbench MCP request was cancelled.' }
  })
  try {
    const controller = new AbortController()
    const pending = client.callTool({
      name: 'getWorkbenchStatus',
      arguments: {}
    }, undefined, { signal: controller.signal })
    controller.abort()
    await assert.rejects(pending)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(observedAbort, true)
  } finally {
    await client.close()
    await server.close()
  }
})

test('runs the fixed stdio entrypoint, lists tools, and closes cleanly', async () => {
  const transport = new StdioClientTransport({
    command: '/opt/homebrew/bin/node',
    args: [path.join(repoRoot, 'packages', 'mcp', 'dist', 'server.js')],
    cwd: repoRoot
  })
  const client = new Client({ name: 'workbench-stdio-test', version: '1.0.0' })
  await client.connect(transport)
  const listed = await client.listTools()
  assert.deepEqual(listed.tools.map(tool => tool.name), [
    'getWorkbenchStatus',
    'readWorkbenchContext',
    'applyWorkbenchFileChange',
    'commitWorkbenchChanges',
    'runWorkbenchCommand'
  ])
  await client.close()
})

test('rejects an oversized newline-delimited stdio message', async () => {
  const child = spawn('/opt/homebrew/bin/node', [path.join(repoRoot, 'packages', 'mcp', 'dist', 'server.js')], {
    cwd: repoRoot,
    stdio: ['pipe', 'ignore', 'pipe']
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdin.end(`${'x'.repeat(70_000)}\n`)
  const [code] = await once(child, 'exit') as [number | null]
  assert.notEqual(code, 0)
  assert(stderr.includes('MCP stdin message exceeded the allowed size'))
})
