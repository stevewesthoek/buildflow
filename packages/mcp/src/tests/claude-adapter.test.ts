import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { installWorkbenchOwnerConfig } from '@workbench/shared/workbench-owner-config'
import {
  WORKBENCH_MCP_ADAPTER_CONTRACT_VERSION,
  WorkbenchMcpAdapterContractError,
  executeWorkbenchMcpAdapterRequest,
  type WorkbenchMcpAdapterResult
} from '../adapter-contract.js'
import {
  CLAUDE_MCP_ADAPTER_ID,
  CLAUDE_MCP_CLIENT_ID,
  CLAUDE_MCP_REGISTRATION_ID,
  ClaudeCodeMcpAdapter
} from '../claude-adapter.js'
import {
  WORKBENCH_CREDENTIAL_FILE_NAME,
  type WorkbenchMcpProfile
} from '../configure-core.js'
import {
  WORKBENCH_MCP_REGISTRATION_API_VERSION,
  createWorkbenchMcpRegistrationManifest,
  type WorkbenchMcpRegistrationManifest
} from '../registration-manifest.js'

function createMockClaudeBin(homeDir: string, writeAndFail = false): string {
  const binDir = path.join(homeDir, '.local', 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  const binPath = path.join(binDir, writeAndFail ? 'claude-write-and-fail' : 'claude')
  fs.writeFileSync(binPath, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const home = process.env.HOME || require('os').homedir();
const claudeJsonPath = path.join(home, '.claude.json');
let doc = {};
if (fs.existsSync(claudeJsonPath)) doc = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
const cwd = process.cwd();
if (args[0] === 'mcp' && args[1] === 'add-json' && args.includes('--scope') && args.includes('local')) {
  const nameIdx = args.indexOf('local') + 1;
  const name = args[nameIdx];
  const entry = JSON.parse(args[nameIdx + 1]);
  if (!doc.projects) doc.projects = {};
  if (!doc.projects[cwd]) doc.projects[cwd] = {};
  if (!doc.projects[cwd].mcpServers) doc.projects[cwd].mcpServers = {};
  doc.projects[cwd].mcpServers[name] = entry;
  fs.writeFileSync(claudeJsonPath, JSON.stringify(doc, null, 2) + '\\n', { mode: 0o600 });
  if (${writeAndFail ? 'true' : 'false'}) {
    process.stderr.write('mock-claude: wrote entry then failed\\n');
    process.exit(1);
  }
  process.exit(0);
}
if (args[0] === 'mcp' && args[1] === 'remove' && args[2] === 'workbench' && args.includes('local')) {
  if (doc.projects && doc.projects[cwd] && doc.projects[cwd].mcpServers) {
    delete doc.projects[cwd].mcpServers.workbench;
  }
  fs.writeFileSync(claudeJsonPath, JSON.stringify(doc, null, 2) + '\\n', { mode: 0o600 });
  process.exit(0);
}
process.stderr.write('mock-claude: unsupported command\\n');
process.exit(1);
`, { mode: 0o755 })
  return binPath
}

function fixture(writeAndFail = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-claude-adapter-')))
  const homeDir = path.join(root, 'home')
  const workbenchRepoRoot = path.join(root, 'workbench')
  const targetProjectRoot = path.join(root, 'target-project')
  fs.mkdirSync(homeDir, { recursive: true })
  fs.mkdirSync(path.join(workbenchRepoRoot, 'packages', 'mcp', 'dist'), { recursive: true })
  fs.writeFileSync(
    path.join(workbenchRepoRoot, 'packages', 'mcp', 'dist', 'server.js'),
    '#!/usr/bin/env node\n',
    { mode: 0o700 }
  )
  fs.mkdirSync(targetProjectRoot, { recursive: true })
  installWorkbenchOwnerConfig({ actionToken: 'offline-action-token', homeDir })
  const claudeBin = createMockClaudeBin(homeDir, writeAndFail)
  const adapter = new ClaudeCodeMcpAdapter({
    workbenchRepoRoot,
    targetProjectRoot,
    homeDir,
    claudeBin,
    nodeExecutable: fs.realpathSync(process.execPath),
    checkProcesses: () => []
  })
  return {
    root,
    homeDir,
    workbenchRepoRoot,
    targetProjectRoot,
    claudeJsonPath: path.join(homeDir, '.claude.json'),
    credentialFile: path.join(homeDir, '.buildflow', WORKBENCH_CREDENTIAL_FILE_NAME),
    claudeBin,
    adapter
  }
}

function manifestFor(item: ReturnType<typeof fixture>, profile: WorkbenchMcpProfile): WorkbenchMcpRegistrationManifest {
  return createWorkbenchMcpRegistrationManifest({
    registrationId: CLAUDE_MCP_REGISTRATION_ID,
    clientId: CLAUDE_MCP_CLIENT_ID,
    adapterId: CLAUDE_MCP_ADAPTER_ID,
    projectRoot: item.targetProjectRoot,
    profile,
    command: fs.realpathSync(process.execPath),
    args: [path.join(item.workbenchRepoRoot, 'packages', 'mcp', 'dist', 'server.js')],
    cwd: item.workbenchRepoRoot,
    credentialFile: item.credentialFile,
    minimumWorkbenchVersion: '1.3.3-beta',
    adapterApiVersion: WORKBENCH_MCP_ADAPTER_CONTRACT_VERSION
  })
}

function selectorFor(item: ReturnType<typeof fixture>, profile: WorkbenchMcpProfile) {
  return {
    registrationId: CLAUDE_MCP_REGISTRATION_ID,
    clientId: CLAUDE_MCP_CLIENT_ID,
    projectRoot: item.targetProjectRoot,
    profile
  }
}

test('advertises stable Claude identity and conservative mutation capabilities', () => {
  const item = fixture()
  const capabilities = item.adapter.inspectCapabilities()
  assert.equal(capabilities.adapterId, CLAUDE_MCP_ADAPTER_ID)
  assert.equal(capabilities.clientId, CLAUDE_MCP_CLIENT_ID)
  assert.equal(capabilities.supports.atomicConfigure, false)
  assert.equal(capabilities.supports.rollback, true)
  assert.equal(capabilities.supports.dryRun, false)
  assert.deepEqual(capabilities.operations, ['inspect_capabilities', 'configure', 'remove', 'status', 'audit'])
})

test('routes configure, status, audit, and remove through the neutral adapter', async () => {
  const item = fixture()
  fs.writeFileSync(item.claudeJsonPath, JSON.stringify({ unrelated: { preserved: true } }), { mode: 0o600 })
  const manifest = manifestFor(item, 'workbench')
  const selector = selectorFor(item, 'workbench')

  const configured = await executeWorkbenchMcpAdapterRequest(item.adapter, {
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'claude-configure',
    operation: 'configure',
    manifest
  }) as WorkbenchMcpAdapterResult<'configure'>
  assert.equal(configured.outcome, 'configured')
  assert.equal(configured.changed, true)
  const document = JSON.parse(fs.readFileSync(item.claudeJsonPath, 'utf8'))
  assert.deepEqual(document.unrelated, { preserved: true })
  assert.equal(document.projects[item.targetProjectRoot].mcpServers.workbench.env.WORKBENCH_MCP_CREDENTIAL_FILE, item.credentialFile)
  assert(!fs.readFileSync(item.claudeJsonPath, 'utf8').includes('offline-action-token'))

  const status = await executeWorkbenchMcpAdapterRequest(item.adapter, {
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'claude-status',
    operation: 'status',
    selector
  }) as WorkbenchMcpAdapterResult<'status'>
  assert.equal(status.outcome, 'present')

  const audit = await executeWorkbenchMcpAdapterRequest(item.adapter, {
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'claude-audit',
    operation: 'audit',
    selector
  }) as WorkbenchMcpAdapterResult<'audit'>
  assert.equal(audit.outcome, 'compliant')
  assert.deepEqual(audit.diagnostics, [])

  const credentialBeforeRemove = fs.readFileSync(item.credentialFile, 'utf8')
  const removed = await executeWorkbenchMcpAdapterRequest(item.adapter, {
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'claude-remove',
    operation: 'remove',
    selector
  }) as WorkbenchMcpAdapterResult<'remove'>
  assert.equal(removed.outcome, 'removed')
  assert.equal(removed.changed, true)
  assert.equal(fs.readFileSync(item.credentialFile, 'utf8'), credentialBeforeRemove)
  const afterRemove = JSON.parse(fs.readFileSync(item.claudeJsonPath, 'utf8'))
  assert.deepEqual(afterRemove.unrelated, { preserved: true })
  assert.equal(afterRemove.projects[item.targetProjectRoot].mcpServers.workbench, undefined)
})

test('preserves the restricted optional Brain profile', async () => {
  const item = fixture()
  const manifest = manifestFor(item, 'brain')
  const configured = await executeWorkbenchMcpAdapterRequest(item.adapter, {
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'claude-brain-configure',
    operation: 'configure',
    manifest
  }) as WorkbenchMcpAdapterResult<'configure'>
  assert.equal(configured.profile, 'brain')
  const entry = JSON.parse(fs.readFileSync(item.claudeJsonPath, 'utf8'))
    .projects[item.targetProjectRoot].mcpServers.workbench
  assert.equal(entry.env.WORKBENCH_MCP_ALLOWED_TOOLS, 'getWorkbenchStatus,readWorkbenchContext,runWorkbenchCommand')
  assert.equal(entry.env.WORKBENCH_MCP_ALLOWED_COMMAND_KINDS, 'n8n_workflow_migration')

  const audit = await executeWorkbenchMcpAdapterRequest(item.adapter, {
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'claude-brain-audit',
    operation: 'audit',
    selector: selectorFor(item, 'brain')
  }) as WorkbenchMcpAdapterResult<'audit'>
  assert.equal(audit.outcome, 'compliant')
  assert.equal(audit.profile, 'brain')
})

test('rejects dry-run and user-scope duplicates before mutation', async () => {
  const item = fixture()
  const manifest = manifestFor(item, 'workbench')
  await assert.rejects(() => executeWorkbenchMcpAdapterRequest(item.adapter, {
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'claude-dry-run',
    operation: 'configure',
    manifest,
    dryRun: true
  }), (error: unknown) => error instanceof WorkbenchMcpAdapterContractError && error.code === 'unsupported_capability')
  assert.equal(fs.existsSync(item.claudeJsonPath), false)
  assert.equal(fs.existsSync(item.credentialFile), false)

  fs.writeFileSync(item.claudeJsonPath, JSON.stringify({
    mcpServers: { workbench: { command: '/other/node', args: ['/other/server.js'] } }
  }), { mode: 0o600 })
  await assert.rejects(() => executeWorkbenchMcpAdapterRequest(item.adapter, {
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'claude-duplicate',
    operation: 'configure',
    manifest
  }), (error: unknown) => error instanceof WorkbenchMcpAdapterContractError && error.code === 'conflict')
  assert.equal(fs.existsSync(item.credentialFile), false)
})

test('preserves fail-closed process guards without credential mutation', async () => {
  const item = fixture()
  const guarded = new ClaudeCodeMcpAdapter({
    workbenchRepoRoot: item.workbenchRepoRoot,
    targetProjectRoot: item.targetProjectRoot,
    homeDir: item.homeDir,
    claudeBin: item.claudeBin,
    nodeExecutable: fs.realpathSync(process.execPath),
    checkProcesses: () => { throw new Error("Process probe for 'Claude' failed unexpectedly. Cannot prove quiescence.") }
  })
  await assert.rejects(() => executeWorkbenchMcpAdapterRequest(guarded, {
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'claude-process-guard',
    operation: 'configure',
    manifest: manifestFor(item, 'workbench')
  }), (error: unknown) => error instanceof WorkbenchMcpAdapterContractError && error.code === 'conflict')
  assert.equal(fs.existsSync(item.credentialFile), false)
})

test('reports post-CLI failures as partial mutation with safe recovery commands', async () => {
  const item = fixture(true)
  await assert.rejects(() => executeWorkbenchMcpAdapterRequest(item.adapter, {
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'claude-partial',
    operation: 'configure',
    manifest: manifestFor(item, 'workbench')
  }), (error: unknown) => {
    assert(error instanceof WorkbenchMcpAdapterContractError)
    assert.equal(error.code, 'partial_mutation')
    assert.equal(error.mutation?.state, 'partial')
    assert(error.mutation?.changedPaths.includes(item.claudeJsonPath))
    assert(error.message.includes('pnpm mcp:claude:status'))
    assert(error.message.includes('pnpm mcp:claude:configure'))
    return true
  })
  assert.equal(fs.existsSync(item.credentialFile), true)
})

test('status and audit classify drift deterministically', async () => {
  const item = fixture()
  fs.writeFileSync(item.claudeJsonPath, JSON.stringify({
    projects: {
      [item.targetProjectRoot]: {
        mcpServers: { workbench: { command: '/wrong/node', args: ['/wrong/server.js'] } }
      }
    }
  }), { mode: 0o644 })
  const selector = selectorFor(item, 'workbench')
  const status = await executeWorkbenchMcpAdapterRequest(item.adapter, {
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'claude-drift-status',
    operation: 'status',
    selector
  }) as WorkbenchMcpAdapterResult<'status'>
  assert.equal(status.outcome, 'present')
  assert.deepEqual(status.diagnostics.map(value => value.code), [
    'claude_config_mode',
    'claude_credential_mode',
    'claude_registration_mismatch'
  ])

  const audit = await executeWorkbenchMcpAdapterRequest(item.adapter, {
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'claude-drift-audit',
    operation: 'audit',
    selector
  }) as WorkbenchMcpAdapterResult<'audit'>
  assert.equal(audit.outcome, 'drifted')
  assert.deepEqual(audit.diagnostics, status.diagnostics)
})
