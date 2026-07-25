import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { parse } from 'smol-toml'
import { installWorkbenchOwnerConfig } from '@workbench/shared/workbench-owner-config'
import { WORKBENCH_MCP_ADAPTER_CONTRACT_VERSION, WorkbenchMcpAdapterContractError, executeWorkbenchMcpAdapterRequest, type WorkbenchMcpAdapterResult } from '../adapter-contract.js'
import { CODEX_MCP_ADAPTER_ID, CODEX_MCP_CLIENT_ID, CODEX_MCP_REGISTRATION_ID, CodexProjectMcpAdapter } from '../codex-adapter.js'
import type { ConfigureHooks, RemoveHooks } from '../configure-codex.js'
import { WORKBENCH_CREDENTIAL_FILE_NAME, type WorkbenchMcpProfile } from '../configure-core.js'
import { WORKBENCH_MCP_REGISTRATION_API_VERSION, createWorkbenchMcpRegistrationManifest, type WorkbenchMcpRegistrationManifest } from '../registration-manifest.js'

function fixture(options: { configureHooks?: ConfigureHooks; removeHooks?: RemoveHooks } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-codex-adapter-')))
  const homeDir = path.join(root, 'home')
  const codexHome = path.join(homeDir, '.codex')
  const workbenchRepoRoot = path.join(root, 'workbench')
  const targetProjectRoot = path.join(root, 'target-project')
  fs.mkdirSync(codexHome, { recursive: true })
  fs.mkdirSync(path.join(workbenchRepoRoot, 'packages', 'mcp', 'dist'), { recursive: true })
  fs.writeFileSync(path.join(workbenchRepoRoot, 'packages', 'mcp', 'dist', 'server.js'), '#!/usr/bin/env node\n', { mode: 0o700 })
  fs.mkdirSync(targetProjectRoot, { recursive: true })
  const globalConfigPath = path.join(codexHome, 'config.toml')
  const globalText = ['model = "gpt-5.6"', '', '[mcp_servers.existing_server]', 'command = "/usr/bin/true"', 'args = []', 'enabled = true', ''].join('\n')
  fs.writeFileSync(globalConfigPath, globalText, { mode: 0o600 })
  installWorkbenchOwnerConfig({ actionToken: 'offline-action-token-123456789', homeDir })
  const now = new Date('2026-07-24T07:00:00.000Z')
  const adapter = new CodexProjectMcpAdapter({ workbenchRepoRoot, targetProjectRoot, homeDir, codexHome, now, nodeExecutable: fs.realpathSync(process.execPath), configureHooks: options.configureHooks, removeHooks: options.removeHooks })
  return { root, homeDir, codexHome, workbenchRepoRoot, targetProjectRoot, globalConfigPath, globalText, projectConfigPath: path.join(targetProjectRoot, '.codex', 'config.toml'), credentialFile: path.join(homeDir, '.buildflow', WORKBENCH_CREDENTIAL_FILE_NAME), backupPath: path.join(homeDir, '.buildflow', 'codex-config-backups', 'project-config.toml.2026-07-24T07-00-00-000Z.workbench-mcp.bak'), adapter }
}

function manifestFor(item: ReturnType<typeof fixture>, profile: WorkbenchMcpProfile): WorkbenchMcpRegistrationManifest {
  return createWorkbenchMcpRegistrationManifest({ registrationId: CODEX_MCP_REGISTRATION_ID, clientId: CODEX_MCP_CLIENT_ID, adapterId: CODEX_MCP_ADAPTER_ID, projectRoot: item.targetProjectRoot, profile, command: fs.realpathSync(process.execPath), args: [path.join(item.workbenchRepoRoot, 'packages', 'mcp', 'dist', 'server.js')], cwd: item.workbenchRepoRoot, credentialFile: item.credentialFile, minimumWorkbenchVersion: '1.3.3-beta', adapterApiVersion: WORKBENCH_MCP_ADAPTER_CONTRACT_VERSION })
}

function selectorFor(item: ReturnType<typeof fixture>, profile: WorkbenchMcpProfile) {
  return { registrationId: CODEX_MCP_REGISTRATION_ID, clientId: CODEX_MCP_CLIENT_ID, projectRoot: item.targetProjectRoot, profile }
}

test('advertises stable Codex identity with atomic rollback and dry-run support', () => {
  const capabilities = fixture().adapter.inspectCapabilities()
  assert.equal(capabilities.adapterId, CODEX_MCP_ADAPTER_ID)
  assert.equal(capabilities.clientId, CODEX_MCP_CLIENT_ID)
  assert.equal(capabilities.supports.atomicConfigure, true)
  assert.equal(capabilities.supports.rollback, true)
  assert.equal(capabilities.supports.dryRun, true)
})

test('routes dry-run, configure, status, audit, dry-run remove, and remove through the neutral adapter', async () => {
  const item = fixture()
  fs.mkdirSync(path.dirname(item.projectConfigPath), { recursive: true })
  const projectBefore = ['project_note = "preserve me"', '', '[mcp_servers.existing_server]', 'command = "/usr/bin/true"', 'args = []', ''].join('\n')
  fs.writeFileSync(item.projectConfigPath, projectBefore, { mode: 0o600 })
  const manifest = manifestFor(item, 'workbench')
  const selector = selectorFor(item, 'workbench')
  const preview = await executeWorkbenchMcpAdapterRequest(item.adapter, { apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION, requestId: 'codex-configure-preview', operation: 'configure', manifest, dryRun: true }) as WorkbenchMcpAdapterResult<'configure'>
  assert.equal(preview.mutation.state, 'planned')
  assert.equal(fs.readFileSync(item.projectConfigPath, 'utf8'), projectBefore)
  assert.equal(fs.existsSync(item.credentialFile), false)
  const configured = await executeWorkbenchMcpAdapterRequest(item.adapter, { apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION, requestId: 'codex-configure', operation: 'configure', manifest }) as WorkbenchMcpAdapterResult<'configure'>
  assert.equal(configured.outcome, 'configured')
  assert(configured.mutation.changedPaths.includes(item.projectConfigPath))
  assert(configured.mutation.changedPaths.includes(item.credentialFile))
  assert(configured.mutation.changedPaths.includes(item.backupPath))
  assert.equal(fs.readFileSync(item.globalConfigPath, 'utf8'), item.globalText)
  const project = parse(fs.readFileSync(item.projectConfigPath, 'utf8')) as Record<string, any>
  assert.equal(project.project_note, 'preserve me')
  assert.equal(project.mcp_servers.existing_server.command, '/usr/bin/true')
  assert.equal(project.mcp_servers.workbench.env.WORKBENCH_MCP_CREDENTIAL_FILE, item.credentialFile)
  const status = await executeWorkbenchMcpAdapterRequest(item.adapter, { apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION, requestId: 'codex-status', operation: 'status', selector }) as WorkbenchMcpAdapterResult<'status'>
  assert.equal(status.outcome, 'present')
  const audit = await executeWorkbenchMcpAdapterRequest(item.adapter, { apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION, requestId: 'codex-audit', operation: 'audit', selector }) as WorkbenchMcpAdapterResult<'audit'>
  assert.equal(audit.outcome, 'compliant')
  const credentialBeforeRemove = fs.readFileSync(item.credentialFile, 'utf8')
  const removePreview = await executeWorkbenchMcpAdapterRequest(item.adapter, { apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION, requestId: 'codex-remove-preview', operation: 'remove', selector, dryRun: true }) as WorkbenchMcpAdapterResult<'remove'>
  assert.equal(removePreview.mutation.state, 'planned')
  const removed = await executeWorkbenchMcpAdapterRequest(item.adapter, { apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION, requestId: 'codex-remove', operation: 'remove', selector }) as WorkbenchMcpAdapterResult<'remove'>
  assert.equal(removed.outcome, 'removed')
  assert.equal(fs.readFileSync(item.credentialFile, 'utf8'), credentialBeforeRemove)
  const afterRemove = parse(fs.readFileSync(item.projectConfigPath, 'utf8')) as Record<string, any>
  assert.equal(afterRemove.project_note, 'preserve me')
  assert.equal(afterRemove.mcp_servers.existing_server.command, '/usr/bin/true')
  assert.equal(afterRemove.mcp_servers.workbench, undefined)
})

test('preserves the restricted optional Brain profile', async () => {
  const item = fixture()
  const manifest = manifestFor(item, 'brain')
  const configured = await executeWorkbenchMcpAdapterRequest(item.adapter, { apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION, requestId: 'codex-brain-configure', operation: 'configure', manifest }) as WorkbenchMcpAdapterResult<'configure'>
  assert.equal(configured.profile, 'brain')
  const entry = (parse(fs.readFileSync(item.projectConfigPath, 'utf8')) as Record<string, any>).mcp_servers.workbench
  assert.equal(entry.required, false)
  assert.equal(entry.env.WORKBENCH_MCP_ALLOWED_TOOLS, 'getWorkbenchStatus,readWorkbenchContext,runWorkbenchCommand')
  assert.equal(entry.env.WORKBENCH_MCP_ALLOWED_COMMAND_KINDS, 'n8n_workflow_migration')
})

test('rejects global duplicates before mutation', async () => {
  const item = fixture()
  fs.appendFileSync(item.globalConfigPath, ['', '[mcp_servers.workbench]', `command = "${fs.realpathSync(process.execPath)}"`, `args = ["${path.join(item.workbenchRepoRoot, 'packages', 'mcp', 'dist', 'server.js')}"]`, `cwd = "${item.workbenchRepoRoot}"`, ''].join('\n'))
  await assert.rejects(() => executeWorkbenchMcpAdapterRequest(item.adapter, { apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION, requestId: 'codex-global-duplicate', operation: 'configure', manifest: manifestFor(item, 'workbench') }), (error: unknown) => error instanceof WorkbenchMcpAdapterContractError && error.code === 'conflict')
  assert.equal(fs.existsSync(item.credentialFile), false)
})

test('reports exact successful rollback after a credential-stage fault', async () => {
  const item = fixture({ configureHooks: { afterCredentialWrite: () => { throw new Error('injected-after-credential') } } })
  await assert.rejects(() => executeWorkbenchMcpAdapterRequest(item.adapter, { apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION, requestId: 'codex-rollback-credential', operation: 'configure', manifest: manifestFor(item, 'workbench') }), (error: unknown) => {
    assert(error instanceof WorkbenchMcpAdapterContractError)
    assert.equal(error.code, 'partial_mutation')
    assert.equal(error.mutation?.rollback.status, 'succeeded')
    assert(error.mutation?.rollback.restoredPaths.includes(item.credentialFile))
    assert(error.mutation?.changedPaths.includes(item.backupPath))
    return true
  })
  assert.equal(fs.existsSync(item.credentialFile), false)
  assert.equal(fs.existsSync(item.projectConfigPath), false)
})

test('restores exact prior TOML, modes, and credential after a project-stage fault', async () => {
  const item = fixture({ configureHooks: { afterProjectConfigWrite: () => { throw new Error('injected-after-project') } } })
  fs.mkdirSync(path.dirname(item.projectConfigPath), { recursive: true })
  const projectBefore = 'project_note = "original"\n'
  const credentialBefore = 'wbmcp_v1_original-credential\n'
  fs.writeFileSync(item.projectConfigPath, projectBefore, { mode: 0o640 })
  fs.mkdirSync(path.dirname(item.credentialFile), { recursive: true })
  fs.writeFileSync(item.credentialFile, credentialBefore, { mode: 0o600 })
  await assert.rejects(() => executeWorkbenchMcpAdapterRequest(item.adapter, { apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION, requestId: 'codex-rollback-project', operation: 'configure', manifest: manifestFor(item, 'workbench') }), (error: unknown) => {
    assert(error instanceof WorkbenchMcpAdapterContractError)
    assert.equal(error.code, 'partial_mutation')
    assert.equal(error.mutation?.rollback.status, 'succeeded')
    assert.deepEqual(error.mutation?.rollback.restoredPaths.sort(), [item.credentialFile, item.projectConfigPath].sort())
    assert(error.mutation?.changedPaths.includes(item.backupPath))
    return true
  })
  assert.equal(fs.readFileSync(item.projectConfigPath, 'utf8'), projectBefore)
  assert.equal(fs.statSync(item.projectConfigPath).mode & 0o777, 0o640)
  assert.equal(fs.readFileSync(item.credentialFile, 'utf8'), credentialBefore)
  assert.equal(fs.statSync(item.credentialFile).mode & 0o777, 0o600)
})

test('status and audit classify deterministic drift', async () => {
  const item = fixture()
  fs.mkdirSync(path.dirname(item.projectConfigPath), { recursive: true })
  fs.writeFileSync(item.projectConfigPath, ['[mcp_servers.workbench]', 'command = "/wrong/node"', 'args = ["/wrong/server.js"]', 'cwd = "/wrong"', ''].join('\n'), { mode: 0o644 })
  const selector = selectorFor(item, 'workbench')
  const status = await executeWorkbenchMcpAdapterRequest(item.adapter, { apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION, requestId: 'codex-drift-status', operation: 'status', selector }) as WorkbenchMcpAdapterResult<'status'>
  assert.equal(status.outcome, 'present')
  assert.deepEqual(status.diagnostics.map(value => value.code), ['codex_credential_mode', 'codex_project_config_mode', 'codex_registration_mismatch'])
  const audit = await executeWorkbenchMcpAdapterRequest(item.adapter, { apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION, requestId: 'codex-drift-audit', operation: 'audit', selector }) as WorkbenchMcpAdapterResult<'audit'>
  assert.equal(audit.outcome, 'drifted')
  assert.deepEqual(audit.diagnostics, status.diagnostics)
})
