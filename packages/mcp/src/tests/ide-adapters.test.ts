import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  WORKBENCH_MCP_ADAPTER_CONTRACT_VERSION,
  WorkbenchMcpAdapterContractError,
  executeWorkbenchMcpAdapterRequest,
  type WorkbenchMcpAdapterResult
} from '../adapter-contract.js'
import {
  CURSOR_MCP_ADAPTER_ID,
  CURSOR_MCP_CLIENT_ID,
  CursorProjectMcpAdapter,
  IDE_MCP_REGISTRATION_ID,
  JETBRAINS_MCP_ADAPTER_ID,
  JETBRAINS_MCP_CLIENT_ID,
  JetBrainsProjectMcpAdapter,
  VSCODE_MCP_ADAPTER_ID,
  VSCODE_MCP_CLIENT_ID,
  VSCodeProjectMcpAdapter
} from '../ide-adapters.js'
import {
  WORKBENCH_MCP_REGISTRATION_API_VERSION,
  createWorkbenchMcpRegistrationManifest
} from '../registration-manifest.js'

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-ide-adapters-')))
  const projectRoot = path.join(root, 'project')
  const workbenchRoot = path.join(root, 'workbench')
  const credentialFile = path.join(root, 'home', '.buildflow', 'workbench-mcp.token')
  fs.mkdirSync(projectRoot, { recursive: true })
  fs.mkdirSync(path.join(workbenchRoot, 'packages', 'mcp', 'dist'), { recursive: true })
  fs.writeFileSync(path.join(workbenchRoot, 'packages', 'mcp', 'dist', 'server.js'), '#!/usr/bin/env node\n', { mode: 0o700 })
  fs.mkdirSync(path.dirname(credentialFile), { recursive: true })
  fs.writeFileSync(credentialFile, ['wbmcp', 'v1', 'fixture'].join('_') + '\n', { mode: 0o600 })
  return {
    root,
    projectRoot: fs.realpathSync(projectRoot),
    workbenchRoot: fs.realpathSync(workbenchRoot),
    credentialFile,
    configPath: path.join(projectRoot, '.vscode', 'mcp.json')
  }
}

function manifestFor(item: ReturnType<typeof fixture>, profile: 'workbench' | 'brain' = 'brain') {
  return createWorkbenchMcpRegistrationManifest({
    registrationId: IDE_MCP_REGISTRATION_ID,
    adapterId: VSCODE_MCP_ADAPTER_ID,
    clientId: VSCODE_MCP_CLIENT_ID,
    projectRoot: item.projectRoot,
    profile,
    command: fs.realpathSync(process.execPath),
    args: [path.join(item.workbenchRoot, 'packages', 'mcp', 'dist', 'server.js')],
    cwd: item.workbenchRoot,
    credentialFile: item.credentialFile,
    minimumWorkbenchVersion: '1.3.3-beta',
    adapterApiVersion: WORKBENCH_MCP_ADAPTER_CONTRACT_VERSION
  })
}

function selectorFor(item: ReturnType<typeof fixture>, profile: 'workbench' | 'brain' = 'brain') {
  return {
    registrationId: IDE_MCP_REGISTRATION_ID,
    clientId: VSCODE_MCP_CLIENT_ID,
    projectRoot: item.projectRoot,
    profile
  }
}

test('VS Code advertises exact optional project support and preserves unrelated configuration', async () => {
  const item = fixture()
  fs.mkdirSync(path.dirname(item.configPath), { recursive: true })
  fs.writeFileSync(item.configPath, JSON.stringify({
    inputs: [{ type: 'promptString', id: 'other', description: 'Other value' }],
    servers: { other: { type: 'stdio', command: '/usr/bin/true', args: [] } }
  }, null, 2) + '\n', { mode: 0o600 })

  const adapter = new VSCodeProjectMcpAdapter({
    workbenchRepoRoot: item.workbenchRoot,
    targetProjectRoot: item.projectRoot,
    nodeExecutable: fs.realpathSync(process.execPath)
  })
  const capabilities = adapter.inspectCapabilities()
  assert.equal(capabilities.adapterId, VSCODE_MCP_ADAPTER_ID)
  assert.equal(capabilities.clientId, VSCODE_MCP_CLIENT_ID)
  assert.deepEqual(capabilities.availabilityModes, ['optional'])
  assert.equal(capabilities.supports.dryRun, true)
  assert.equal(capabilities.supports.rollback, true)

  const manifest = manifestFor(item)
  const preview = await executeWorkbenchMcpAdapterRequest(adapter, {
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'vscode-preview',
    operation: 'configure',
    manifest,
    dryRun: true
  }) as WorkbenchMcpAdapterResult<'configure'>
  assert.equal(preview.mutation.state, 'planned')
  assert.equal((JSON.parse(fs.readFileSync(item.configPath, 'utf8')) as any).servers.workbench, undefined)

  const configured = await executeWorkbenchMcpAdapterRequest(adapter, {
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'vscode-configure',
    operation: 'configure',
    manifest
  }) as WorkbenchMcpAdapterResult<'configure'>
  assert.equal(configured.outcome, 'updated')
  const document = JSON.parse(fs.readFileSync(item.configPath, 'utf8')) as any
  assert.equal(document.inputs[0].id, 'other')
  assert.equal(document.servers.other.command, '/usr/bin/true')
  assert.equal(document.servers.workbench.type, 'stdio')
  assert.equal(document.servers.workbench.cwd, item.workbenchRoot)
  assert.equal(document.servers.workbench.env.WORKBENCH_MCP_CREDENTIAL_FILE, item.credentialFile)
  assert.equal(document.servers.workbench.env.WORKBENCH_MCP_ALLOWED_TOOLS, 'getWorkbenchStatus,readWorkbenchContext,runWorkbenchCommand')
  assert(!fs.readFileSync(item.configPath, 'utf8').includes('fixture'))
  assert.equal(fs.statSync(item.configPath).mode & 0o777, 0o600)

  const status = await executeWorkbenchMcpAdapterRequest(adapter, {
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'vscode-status',
    operation: 'status',
    selector: selectorFor(item)
  }) as WorkbenchMcpAdapterResult<'status'>
  assert.equal(status.outcome, 'present')

  const audit = await executeWorkbenchMcpAdapterRequest(adapter, {
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'vscode-audit',
    operation: 'audit',
    selector: selectorFor(item)
  }) as WorkbenchMcpAdapterResult<'audit'>
  assert.equal(audit.outcome, 'compliant')

  const removed = await executeWorkbenchMcpAdapterRequest(adapter, {
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'vscode-remove',
    operation: 'remove',
    selector: selectorFor(item)
  }) as WorkbenchMcpAdapterResult<'remove'>
  assert.equal(removed.outcome, 'removed')
  const afterRemove = JSON.parse(fs.readFileSync(item.configPath, 'utf8')) as any
  assert.equal(afterRemove.servers.workbench, undefined)
  assert.equal(afterRemove.servers.other.command, '/usr/bin/true')
  assert.equal(afterRemove.inputs[0].id, 'other')
})

test('VS Code rejects required Workbench availability without emulation', async () => {
  const item = fixture()
  const adapter = new VSCodeProjectMcpAdapter({
    workbenchRepoRoot: item.workbenchRoot,
    targetProjectRoot: item.projectRoot,
    nodeExecutable: fs.realpathSync(process.execPath)
  })
  await assert.rejects(() => executeWorkbenchMcpAdapterRequest(adapter, {
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'vscode-required',
    operation: 'configure',
    manifest: manifestFor(item, 'workbench')
  }), (error: unknown) => error instanceof WorkbenchMcpAdapterContractError && error.code === 'unsupported_capability')
})

test('VS Code detects conflicting project registrations before mutation', async () => {
  const item = fixture()
  fs.mkdirSync(path.dirname(item.configPath), { recursive: true })
  fs.writeFileSync(item.configPath, JSON.stringify({
    servers: {
      otherWorkbench: {
        type: 'stdio',
        command: fs.realpathSync(process.execPath),
        args: [path.join(item.workbenchRoot, 'packages', 'mcp', 'dist', 'server.js')]
      }
    }
  }, null, 2) + '\n', { mode: 0o600 })
  const before = fs.readFileSync(item.configPath, 'utf8')
  const adapter = new VSCodeProjectMcpAdapter({
    workbenchRepoRoot: item.workbenchRoot,
    targetProjectRoot: item.projectRoot,
    nodeExecutable: fs.realpathSync(process.execPath)
  })
  await assert.rejects(() => executeWorkbenchMcpAdapterRequest(adapter, {
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'vscode-conflict',
    operation: 'configure',
    manifest: manifestFor(item)
  }), (error: unknown) => error instanceof WorkbenchMcpAdapterContractError && error.code === 'conflict')
  assert.equal(fs.readFileSync(item.configPath, 'utf8'), before)
})

test('Cursor and JetBrains expose inspection-only fail-closed capabilities', async () => {
  const adapters = [
    new CursorProjectMcpAdapter(),
    new JetBrainsProjectMcpAdapter()
  ]
  const expected = [
    [CURSOR_MCP_ADAPTER_ID, CURSOR_MCP_CLIENT_ID],
    [JETBRAINS_MCP_ADAPTER_ID, JETBRAINS_MCP_CLIENT_ID]
  ] as const

  for (let index = 0; index < adapters.length; index += 1) {
    const adapter = adapters[index]
    const capabilities = adapter.inspectCapabilities()
    assert.equal(capabilities.adapterId, expected[index][0])
    assert.equal(capabilities.clientId, expected[index][1])
    assert.deepEqual(capabilities.operations, ['inspect_capabilities'])
    assert.equal(capabilities.supports.rollback, false)
    assert.equal(capabilities.supports.dryRun, false)
    assert.throws(() => adapter.status({
      apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
      requestId: `unsupported-${index}`,
      operation: 'status',
      selector: { registrationId: IDE_MCP_REGISTRATION_ID, clientId: expected[index][1], projectRoot: '/tmp/project', profile: 'brain' }
    }), (error: unknown) => error instanceof WorkbenchMcpAdapterContractError && error.code === 'unsupported_capability')
  }
})
