import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { installWorkbenchOwnerConfig } from '@workbench/shared/workbench-owner-config'
import {
  WORKBENCH_MCP_ADAPTER_CONTRACT_VERSION,
  executeWorkbenchMcpAdapterRequest
} from '../adapter-contract.js'
import { ClaudeCodeMcpAdapter } from '../claude-adapter.js'
import { CodexProjectMcpAdapter } from '../codex-adapter.js'
import {
  CURSOR_MCP_ADAPTER_ID,
  CURSOR_MCP_CLIENT_ID,
  CursorProjectMcpAdapter,
  JETBRAINS_MCP_ADAPTER_ID,
  JETBRAINS_MCP_CLIENT_ID,
  JetBrainsProjectMcpAdapter,
  VSCODE_MCP_ADAPTER_ID,
  VSCODE_MCP_CLIENT_ID,
  VSCodeProjectMcpAdapter
} from '../ide-adapters.js'
import {
  WORKBENCH_MCP_ORCHESTRATION_VERSION,
  WORKBENCH_MCP_REGISTER_COMMAND,
  WorkbenchMcpAdapterRegistry,
  executeWorkbenchMcpRegisterCommand
} from '../registration-orchestrator.js'
import {
  WORKBENCH_MCP_POLICY_VERSION,
  evaluateWorkbenchMcpRegistrationPolicy
} from '../registration-policy.js'
import {
  WORKBENCH_MCP_REGISTRATION_API_VERSION,
  WORKBENCH_MCP_REGISTRATION_SCHEMA_VERSION,
  createWorkbenchMcpRegistrationManifest
} from '../registration-manifest.js'

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-phase-h-')))
  const homeDir = path.join(root, 'home')
  const projectRoot = path.join(root, 'project')
  const workbenchRoot = path.join(root, 'workbench')
  const codexHome = path.join(homeDir, '.codex')
  const credentialFile = path.join(homeDir, '.buildflow', 'workbench-mcp.token')
  fs.mkdirSync(projectRoot, { recursive: true })
  fs.mkdirSync(codexHome, { recursive: true })
  fs.mkdirSync(path.join(workbenchRoot, 'packages', 'mcp', 'dist'), { recursive: true })
  fs.writeFileSync(path.join(workbenchRoot, 'packages', 'mcp', 'dist', 'server.js'), '#!/usr/bin/env node\n', { mode: 0o700 })
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt"\n', { mode: 0o600 })
  installWorkbenchOwnerConfig({ actionToken: 'offline-action-token-for-tests', homeDir })
  fs.mkdirSync(path.dirname(credentialFile), { recursive: true })
  fs.writeFileSync(credentialFile, ['wbmcp', 'v1', 'fixture'].join('_') + '\n', { mode: 0o600 })
  return {
    root,
    homeDir,
    projectRoot: fs.realpathSync(projectRoot),
    workbenchRoot: fs.realpathSync(workbenchRoot),
    codexHome,
    credentialFile,
    vscodeConfig: path.join(projectRoot, '.vscode', 'mcp.json')
  }
}

test('keeps registration, adapter, orchestration, and policy versions in exact release parity', () => {
  assert.equal(WORKBENCH_MCP_REGISTRATION_API_VERSION, '1.0.0')
  assert.equal(WORKBENCH_MCP_REGISTRATION_SCHEMA_VERSION, '1.0.0')
  assert.equal(WORKBENCH_MCP_ADAPTER_CONTRACT_VERSION, '1.0.0')
  assert.equal(WORKBENCH_MCP_ORCHESTRATION_VERSION, '1.0.0')
  assert.equal(WORKBENCH_MCP_POLICY_VERSION, '1.0.0')
  assert.equal(WORKBENCH_MCP_REGISTER_COMMAND, 'mcp register')
})

test('inspects Claude, Codex, VS Code, Cursor, and JetBrains through one deterministic registry', async () => {
  const item = fixture()
  const adapters = [
    new ClaudeCodeMcpAdapter({
      workbenchRepoRoot: item.workbenchRoot,
      targetProjectRoot: item.projectRoot,
      homeDir: item.homeDir,
      nodeExecutable: fs.realpathSync(process.execPath),
      claudeBin: '/usr/bin/false',
      checkProcesses: () => []
    }),
    new CodexProjectMcpAdapter({
      workbenchRepoRoot: item.workbenchRoot,
      targetProjectRoot: item.projectRoot,
      homeDir: item.homeDir,
      codexHome: item.codexHome,
      nodeExecutable: fs.realpathSync(process.execPath)
    }),
    new VSCodeProjectMcpAdapter({
      workbenchRepoRoot: item.workbenchRoot,
      targetProjectRoot: item.projectRoot,
      nodeExecutable: fs.realpathSync(process.execPath)
    }),
    new CursorProjectMcpAdapter(),
    new JetBrainsProjectMcpAdapter()
  ]
  const registry = new WorkbenchMcpAdapterRegistry(adapters)
  assert.deepEqual(registry.list().map(entry => entry.clientId), ['claude-code', 'codex', 'cursor', 'jetbrains', 'vscode'])

  for (const adapter of adapters) {
    const result = await executeWorkbenchMcpRegisterCommand(registry, {
      orchestrationVersion: WORKBENCH_MCP_ORCHESTRATION_VERSION,
      command: WORKBENCH_MCP_REGISTER_COMMAND,
      mode: 'single',
      request: {
        apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
        requestId: `inspect-${adapter.clientId}`,
        operation: 'inspect_capabilities',
        adapterId: adapter.adapterId,
        clientId: adapter.clientId
      }
    })
    assert.equal(result.mode, 'single')
    assert.equal(result.ok, true)
    if (result.mode !== 'single' || !result.result || 'operation' in result.result) throw new Error('Missing capability result')
    assert.equal(result.result.adapterId, adapter.adapterId)
    assert.equal(result.result.clientId, adapter.clientId)
  }
})

test('fails closed for unsupported IDE lifecycle and required-startup requests', async () => {
  const item = fixture()
  const vscode = new VSCodeProjectMcpAdapter({
    workbenchRepoRoot: item.workbenchRoot,
    targetProjectRoot: item.projectRoot,
    nodeExecutable: fs.realpathSync(process.execPath)
  })
  const requiredManifest = createWorkbenchMcpRegistrationManifest({
    registrationId: 'workbench',
    adapterId: VSCODE_MCP_ADAPTER_ID,
    clientId: VSCODE_MCP_CLIENT_ID,
    projectRoot: item.projectRoot,
    profile: 'workbench',
    command: fs.realpathSync(process.execPath),
    args: [path.join(item.workbenchRoot, 'packages', 'mcp', 'dist', 'server.js')],
    cwd: item.workbenchRoot,
    credentialFile: item.credentialFile,
    minimumWorkbenchVersion: '1.3.3-beta',
    adapterApiVersion: WORKBENCH_MCP_ADAPTER_CONTRACT_VERSION
  })
  await assert.rejects(() => executeWorkbenchMcpAdapterRequest(vscode, {
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'vscode-required',
    operation: 'configure',
    manifest: requiredManifest
  }), (error: unknown) => (error as { code?: string }).code === 'unsupported_capability')

  for (const [adapter, adapterId, clientId] of [
    [new CursorProjectMcpAdapter(), CURSOR_MCP_ADAPTER_ID, CURSOR_MCP_CLIENT_ID],
    [new JetBrainsProjectMcpAdapter(), JETBRAINS_MCP_ADAPTER_ID, JETBRAINS_MCP_CLIENT_ID]
  ] as const) {
    assert.throws(() => adapter.status({
      apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
      requestId: `unsupported-${clientId}`,
      operation: 'status',
      selector: { registrationId: 'workbench', clientId, projectRoot: item.projectRoot, profile: 'brain' }
    }), (error: unknown) => (error as { code?: string }).code === 'unsupported_capability' && adapter.adapterId === adapterId)
  }
})

test('rejects malformed VS Code JSON without mutating the hostile file', async () => {
  const item = fixture()
  fs.mkdirSync(path.dirname(item.vscodeConfig), { recursive: true })
  const hostile = '{"servers": {"workbench": '
  fs.writeFileSync(item.vscodeConfig, hostile, { mode: 0o600 })
  const vscode = new VSCodeProjectMcpAdapter({
    workbenchRepoRoot: item.workbenchRoot,
    targetProjectRoot: item.projectRoot,
    nodeExecutable: fs.realpathSync(process.execPath)
  })
  await assert.rejects(() => executeWorkbenchMcpAdapterRequest(vscode, {
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'hostile-json',
    operation: 'status',
    selector: { registrationId: 'workbench', clientId: VSCODE_MCP_CLIENT_ID, projectRoot: item.projectRoot, profile: 'brain' }
  }))
  assert.equal(fs.readFileSync(item.vscodeConfig, 'utf8'), hostile)
})

test('bounds hostile summaries and denies global or foreign project ownership before execution', async () => {
  const item = fixture()
  const registry = new WorkbenchMcpAdapterRegistry([new CursorProjectMcpAdapter()])
  const targets = Array.from({ length: 17 }, (_, index) => ({
    adapterId: CURSOR_MCP_ADAPTER_ID,
    clientId: CURSOR_MCP_CLIENT_ID,
    selector: { registrationId: `workbench-${index}`, clientId: CURSOR_MCP_CLIENT_ID, projectRoot: item.projectRoot, profile: 'brain' as const }
  }))
  const summary = await executeWorkbenchMcpRegisterCommand(registry, {
    orchestrationVersion: WORKBENCH_MCP_ORCHESTRATION_VERSION,
    command: WORKBENCH_MCP_REGISTER_COMMAND,
    mode: 'summary',
    operation: 'status',
    requestId: 'oversized-summary',
    targets
  })
  assert.equal(summary.mode, 'summary')
  if (summary.mode !== 'summary') throw new Error('Missing summary')
  assert.equal(summary.ok, false)
  assert.equal(summary.total, 17)
  assert.equal(summary.items.length, 0)

  const globalDecision = await evaluateWorkbenchMcpRegistrationPolicy(registry, {
    policyVersion: WORKBENCH_MCP_POLICY_VERSION,
    scope: 'global',
    ownerProjectRoot: item.projectRoot,
    command: {
      orchestrationVersion: WORKBENCH_MCP_ORCHESTRATION_VERSION,
      command: WORKBENCH_MCP_REGISTER_COMMAND,
      mode: 'single',
      request: {
        apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
        requestId: 'global-denial',
        operation: 'inspect_capabilities',
        adapterId: CURSOR_MCP_ADAPTER_ID,
        clientId: CURSOR_MCP_CLIENT_ID
      }
    }
  })
  assert.equal(globalDecision.code, 'unsupported_scope')

  const foreign = path.join(item.root, 'foreign')
  fs.mkdirSync(foreign)
  const foreignDecision = await evaluateWorkbenchMcpRegistrationPolicy(registry, {
    policyVersion: WORKBENCH_MCP_POLICY_VERSION,
    scope: 'project',
    ownerProjectRoot: item.projectRoot,
    command: {
      orchestrationVersion: WORKBENCH_MCP_ORCHESTRATION_VERSION,
      command: WORKBENCH_MCP_REGISTER_COMMAND,
      mode: 'single',
      adapterId: CURSOR_MCP_ADAPTER_ID,
      request: {
        apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
        requestId: 'foreign-denial',
        operation: 'status',
        selector: { registrationId: 'workbench', clientId: CURSOR_MCP_CLIENT_ID, projectRoot: fs.realpathSync(foreign), profile: 'brain' }
      }
    }
  })
  assert.equal(foreignDecision.code, 'ownership_mismatch')
})
