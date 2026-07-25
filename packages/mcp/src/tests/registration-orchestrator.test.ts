import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { installWorkbenchOwnerConfig } from '@workbench/shared/workbench-owner-config'
import {
  WORKBENCH_MCP_ADAPTER_CONTRACT_VERSION,
  createWorkbenchMcpAdapterResult,
  defaultWorkbenchMcpExecutableAdapterCapabilities,
  type WorkbenchMcpAdapterResult,
  type WorkbenchMcpAuditRequest,
  type WorkbenchMcpClientAdapter,
  type WorkbenchMcpConfigureRequest,
  type WorkbenchMcpRemoveRequest,
  type WorkbenchMcpStatusRequest
} from '../adapter-contract.js'
import { CLAUDE_MCP_ADAPTER_ID, CLAUDE_MCP_CLIENT_ID, ClaudeCodeMcpAdapter } from '../claude-adapter.js'
import { CODEX_MCP_ADAPTER_ID, CODEX_MCP_CLIENT_ID, CodexProjectMcpAdapter } from '../codex-adapter.js'
import {
  WORKBENCH_MCP_ORCHESTRATION_VERSION,
  WORKBENCH_MCP_REGISTER_COMMAND,
  WorkbenchMcpAdapterRegistry,
  executeWorkbenchMcpRegisterCommand
} from '../registration-orchestrator.js'
import {
  WORKBENCH_MCP_REGISTRATION_API_VERSION,
  createWorkbenchMcpRegistrationManifest,
  type WorkbenchMcpRegistrationManifest
} from '../registration-manifest.js'

class MemoryAdapter implements WorkbenchMcpClientAdapter {
  readonly adapterId: string
  readonly clientId: string
  private readonly registrations = new Map<string, WorkbenchMcpRegistrationManifest>()

  constructor(adapterId: string, clientId: string) {
    this.adapterId = adapterId
    this.clientId = clientId
  }

  inspectCapabilities() {
    return defaultWorkbenchMcpExecutableAdapterCapabilities({ adapterId: this.adapterId, clientId: this.clientId })
  }

  configure(request: WorkbenchMcpConfigureRequest): WorkbenchMcpAdapterResult<'configure'> {
    if (!request.dryRun) this.registrations.set(request.manifest.registrationId, structuredClone(request.manifest))
    return createWorkbenchMcpAdapterResult({
      adapterId: this.adapterId,
      clientId: this.clientId,
      operation: 'configure',
      requestId: request.requestId,
      registrationId: request.manifest.registrationId,
      profile: request.manifest.target.profile,
      outcome: 'configured',
      dryRun: request.dryRun,
      mutation: request.dryRun
        ? { state: 'planned', changedPaths: [], rollback: { supported: true, attempted: false, status: 'not_required', restoredPaths: [] } }
        : { state: 'complete', changedPaths: [`memory://${request.manifest.registrationId}`], rollback: { supported: true, attempted: false, status: 'not_attempted', restoredPaths: [] } }
    })
  }

  remove(request: WorkbenchMcpRemoveRequest): WorkbenchMcpAdapterResult<'remove'> {
    const existed = this.registrations.has(request.selector.registrationId)
    if (!request.dryRun) this.registrations.delete(request.selector.registrationId)
    return createWorkbenchMcpAdapterResult({
      adapterId: this.adapterId,
      clientId: this.clientId,
      operation: 'remove',
      requestId: request.requestId,
      registrationId: request.selector.registrationId,
      profile: request.selector.profile,
      outcome: existed ? 'removed' : 'not_found',
      dryRun: request.dryRun,
      mutation: request.dryRun && existed
        ? { state: 'planned', changedPaths: [], rollback: { supported: true, attempted: false, status: 'not_required', restoredPaths: [] } }
        : { state: 'none', changedPaths: [], rollback: { supported: true, attempted: false, status: 'not_required', restoredPaths: [] } }
    })
  }

  status(request: WorkbenchMcpStatusRequest): WorkbenchMcpAdapterResult<'status'> {
    return createWorkbenchMcpAdapterResult({
      adapterId: this.adapterId,
      clientId: this.clientId,
      operation: 'status',
      requestId: request.requestId,
      registrationId: request.selector.registrationId,
      profile: request.selector.profile,
      outcome: this.registrations.has(request.selector.registrationId) ? 'present' : 'absent',
      mutation: { state: 'none', changedPaths: [], rollback: { supported: true, attempted: false, status: 'not_required', restoredPaths: [] } }
    })
  }

  audit(request: WorkbenchMcpAuditRequest): WorkbenchMcpAdapterResult<'audit'> {
    const stored = this.registrations.get(request.selector.registrationId)
    return createWorkbenchMcpAdapterResult({
      adapterId: this.adapterId,
      clientId: this.clientId,
      operation: 'audit',
      requestId: request.requestId,
      registrationId: request.selector.registrationId,
      profile: request.selector.profile,
      outcome: stored?.target.profile === request.selector.profile ? 'compliant' : 'drifted',
      mutation: { state: 'none', changedPaths: [], rollback: { supported: true, attempted: false, status: 'not_required', restoredPaths: [] } }
    })
  }
}

function manifest(adapterId = 'memory-v1', clientId = 'memory', profile: 'workbench' | 'brain' = 'workbench') {
  return createWorkbenchMcpRegistrationManifest({
    registrationId: 'workbench',
    adapterId,
    clientId,
    projectRoot: '/workspace/project',
    profile,
    command: '/usr/bin/node',
    args: ['/workspace/workbench/packages/mcp/dist/server.js'],
    cwd: '/workspace/workbench',
    credentialFile: '/home/user/.buildflow/workbench-mcp.token',
    minimumWorkbenchVersion: '1.3.3-beta',
    adapterApiVersion: WORKBENCH_MCP_ADAPTER_CONTRACT_VERSION
  })
}

function single(request: unknown, adapterId?: string) {
  return {
    orchestrationVersion: WORKBENCH_MCP_ORCHESTRATION_VERSION,
    command: WORKBENCH_MCP_REGISTER_COMMAND,
    mode: 'single' as const,
    ...(adapterId ? { adapterId } : {}),
    request
  }
}

test('registers and lists stable identities deterministically', () => {
  const registry = new WorkbenchMcpAdapterRegistry([
    new MemoryAdapter('z-v1', 'z-client'),
    new MemoryAdapter('a-v1', 'a-client')
  ])
  assert.deepEqual(registry.list(), [
    { adapterId: 'a-v1', clientId: 'a-client' },
    { adapterId: 'z-v1', clientId: 'z-client' }
  ])
  assert.throws(() => registry.register(new MemoryAdapter('a-v1', 'a-client')), /already registered/)
})

test('routes configure, status, audit, remove, and capability inspection', async () => {
  const registry = new WorkbenchMcpAdapterRegistry([new MemoryAdapter('memory-v1', 'memory')])
  const configured = await executeWorkbenchMcpRegisterCommand(registry, single({
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'configure-1',
    operation: 'configure',
    manifest: manifest()
  }))
  assert.equal(configured.mode, 'single')
  assert.equal(configured.ok, true)

  const selector = { registrationId: 'workbench', clientId: 'memory', projectRoot: '/workspace/project', profile: 'workbench' as const }
  const status = await executeWorkbenchMcpRegisterCommand(registry, single({
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'status-1',
    operation: 'status',
    selector
  }))
  assert.equal(status.mode, 'single')
  assert.equal(status.ok, true)
  if (status.mode !== 'single' || !status.result || !('operation' in status.result)) throw new Error('Missing status result')
  assert.equal(status.result.outcome, 'present')

  const audit = await executeWorkbenchMcpRegisterCommand(registry, single({
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'audit-1',
    operation: 'audit',
    selector
  }))
  assert.equal(audit.ok, true)

  const capabilities = await executeWorkbenchMcpRegisterCommand(registry, single({
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'inspect-1',
    operation: 'inspect_capabilities',
    adapterId: 'memory-v1',
    clientId: 'memory'
  }))
  assert.equal(capabilities.ok, true)

  const removed = await executeWorkbenchMcpRegisterCommand(registry, single({
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'remove-preview',
    operation: 'remove',
    selector,
    dryRun: true
  }))
  assert.equal(removed.mode, 'single')
  if (removed.mode !== 'single' || !removed.result || !('operation' in removed.result)) throw new Error('Missing remove result')
  assert.equal(removed.result.mutation.state, 'planned')
})

test('preserves the restricted Brain profile', async () => {
  const registry = new WorkbenchMcpAdapterRegistry([new MemoryAdapter('memory-v1', 'memory')])
  const result = await executeWorkbenchMcpRegisterCommand(registry, single({
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'brain-configure',
    operation: 'configure',
    manifest: manifest('memory-v1', 'memory', 'brain')
  }))
  assert.equal(result.mode, 'single')
  if (result.mode !== 'single' || !result.result || !('operation' in result.result)) throw new Error('Missing Brain result')
  assert.equal(result.result.profile, 'brain')
})

test('returns deterministic bounded multi-client summaries', async () => {
  const alpha = new MemoryAdapter('alpha-v1', 'alpha')
  const beta = new MemoryAdapter('beta-v1', 'beta')
  const registry = new WorkbenchMcpAdapterRegistry([beta, alpha])
  alpha.configure({ apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION, requestId: 'a', operation: 'configure', manifest: manifest('alpha-v1', 'alpha') })
  beta.configure({ apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION, requestId: 'b', operation: 'configure', manifest: manifest('beta-v1', 'beta') })
  const result = await executeWorkbenchMcpRegisterCommand(registry, {
    orchestrationVersion: WORKBENCH_MCP_ORCHESTRATION_VERSION,
    command: WORKBENCH_MCP_REGISTER_COMMAND,
    mode: 'summary',
    operation: 'status',
    requestId: 'summary',
    targets: [
      { adapterId: 'beta-v1', clientId: 'beta', selector: { registrationId: 'workbench', clientId: 'beta', projectRoot: '/workspace/project', profile: 'workbench' } },
      { adapterId: 'alpha-v1', clientId: 'alpha', selector: { registrationId: 'workbench', clientId: 'alpha', projectRoot: '/workspace/project', profile: 'workbench' } }
    ]
  })
  assert.equal(result.mode, 'summary')
  if (result.mode !== 'summary') throw new Error('Missing summary')
  assert.deepEqual(result.items.map(item => item.clientId), ['alpha', 'beta'])
  assert.equal(result.succeeded, 2)
})

test('normalizes failures and never echoes secret-bearing input', async () => {
  const registry = new WorkbenchMcpAdapterRegistry([new MemoryAdapter('memory-v1', 'memory')])
  const sampleCredential = ['wbmcp', 'v1', 'do-not-echo'].join('_')
  const requestWithCredential = {
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'secret',
    operation: 'status',
    selector: { registrationId: 'workbench', clientId: 'memory', projectRoot: '/workspace/project', profile: 'workbench' }
  } as Record<string, unknown>
  requestWithCredential[['to', 'ken'].join('')] = sampleCredential
  const rejected = await executeWorkbenchMcpRegisterCommand(registry, single(requestWithCredential))
  assert.equal(rejected.ok, false)
  assert(!JSON.stringify(rejected).includes(sampleCredential))

  const missing = await executeWorkbenchMcpRegisterCommand(registry, single({
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'missing',
    operation: 'inspect_capabilities',
    adapterId: 'missing-v1',
    clientId: 'missing'
  }))
  assert.equal(missing.mode, 'single')
  if (missing.mode !== 'single') throw new Error('Missing failure')
  assert.equal(missing.error?.code, 'not_found')
})

test('routes accepted Claude and Codex adapters through one registry', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-orchestration-')))
  const homeDir = path.join(root, 'home')
  const workbenchRepoRoot = path.join(root, 'workbench')
  const targetProjectRoot = path.join(root, 'project')
  const codexHome = path.join(homeDir, '.codex')
  fs.mkdirSync(path.join(workbenchRepoRoot, 'packages', 'mcp', 'dist'), { recursive: true })
  fs.writeFileSync(path.join(workbenchRepoRoot, 'packages', 'mcp', 'dist', 'server.js'), '#!/usr/bin/env node\n', { mode: 0o700 })
  fs.mkdirSync(targetProjectRoot, { recursive: true })
  fs.mkdirSync(codexHome, { recursive: true })
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt"\n', { mode: 0o600 })
  installWorkbenchOwnerConfig({ actionToken: 'offline-action-token-for-tests', homeDir })
  const registry = new WorkbenchMcpAdapterRegistry([
    new ClaudeCodeMcpAdapter({ workbenchRepoRoot, targetProjectRoot, homeDir, nodeExecutable: fs.realpathSync(process.execPath), claudeBin: '/usr/bin/false', checkProcesses: () => [] }),
    new CodexProjectMcpAdapter({ workbenchRepoRoot, targetProjectRoot, homeDir, codexHome, nodeExecutable: fs.realpathSync(process.execPath) })
  ])
  for (const [adapterId, clientId] of [[CLAUDE_MCP_ADAPTER_ID, CLAUDE_MCP_CLIENT_ID], [CODEX_MCP_ADAPTER_ID, CODEX_MCP_CLIENT_ID]] as const) {
    const result = await executeWorkbenchMcpRegisterCommand(registry, single({
      apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
      requestId: `inspect-${clientId}`,
      operation: 'inspect_capabilities',
      adapterId,
      clientId
    }))
    assert.equal(result.mode, 'single')
    assert.equal(result.ok, true)
    if (result.mode !== 'single') throw new Error('Missing client result')
    assert.equal(result.adapterId, adapterId)
  }
})
