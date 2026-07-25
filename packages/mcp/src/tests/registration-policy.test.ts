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
  WorkbenchMcpAdapterRegistry
} from '../registration-orchestrator.js'
import {
  WORKBENCH_MCP_POLICY_VERSION,
  evaluateWorkbenchMcpRegistrationPolicy,
  executeWorkbenchMcpRegisterCommandWithPolicy,
  type WorkbenchMcpPolicyRequest
} from '../registration-policy.js'
import {
  WORKBENCH_MCP_REGISTRATION_API_VERSION,
  createWorkbenchMcpRegistrationManifest,
  type WorkbenchMcpRegistrationManifest
} from '../registration-manifest.js'

class PolicyMemoryAdapter implements WorkbenchMcpClientAdapter {
  readonly adapterId: string
  readonly clientId: string
  private readonly registrations = new Map<string, WorkbenchMcpRegistrationManifest>()
  private readonly options: { dryRun?: boolean; rollback?: boolean; projectScope?: boolean }

  constructor(adapterId = 'memory-v1', clientId = 'memory', options: { dryRun?: boolean; rollback?: boolean; projectScope?: boolean } = {}) {
    this.adapterId = adapterId
    this.clientId = clientId
    this.options = options
  }

  inspectCapabilities() {
    const capabilities = defaultWorkbenchMcpExecutableAdapterCapabilities({
      adapterId: this.adapterId,
      clientId: this.clientId,
      dryRun: this.options.dryRun ?? true,
      rollback: this.options.rollback ?? true
    })
    if (this.options.projectScope === false) capabilities.scopeDimensions = ['client', 'profile']
    return capabilities
  }

  configure(request: WorkbenchMcpConfigureRequest): WorkbenchMcpAdapterResult<'configure'> {
    if (!request.dryRun) this.registrations.set(request.manifest.registrationId, request.manifest)
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
        : { state: 'complete', changedPaths: ['memory://workbench'], rollback: { supported: true, attempted: false, status: 'not_attempted', restoredPaths: [] } }
    })
  }

  remove(request: WorkbenchMcpRemoveRequest): WorkbenchMcpAdapterResult<'remove'> {
    const existed = this.registrations.delete(request.selector.registrationId)
    return createWorkbenchMcpAdapterResult({
      adapterId: this.adapterId,
      clientId: this.clientId,
      operation: 'remove',
      requestId: request.requestId,
      registrationId: request.selector.registrationId,
      profile: request.selector.profile,
      outcome: existed ? 'removed' : 'not_found',
      dryRun: request.dryRun,
      mutation: { state: 'none', changedPaths: [], rollback: { supported: true, attempted: false, status: 'not_required', restoredPaths: [] } }
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
    return createWorkbenchMcpAdapterResult({
      adapterId: this.adapterId,
      clientId: this.clientId,
      operation: 'audit',
      requestId: request.requestId,
      registrationId: request.selector.registrationId,
      profile: request.selector.profile,
      outcome: this.registrations.has(request.selector.registrationId) ? 'compliant' : 'drifted',
      mutation: { state: 'none', changedPaths: [], rollback: { supported: true, attempted: false, status: 'not_required', restoredPaths: [] } }
    })
  }
}

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-registration-policy-')))
  const projectRoot = path.join(root, 'project')
  const workbenchRoot = path.join(root, 'workbench')
  const credentialFile = path.join(root, 'home', '.buildflow', 'codex-workbench-mcp.token')
  fs.mkdirSync(projectRoot, { recursive: true })
  fs.mkdirSync(path.join(workbenchRoot, 'packages', 'mcp', 'dist'), { recursive: true })
  fs.writeFileSync(path.join(workbenchRoot, 'packages', 'mcp', 'dist', 'server.js'), '#!/usr/bin/env node\n', { mode: 0o700 })
  fs.mkdirSync(path.dirname(credentialFile), { recursive: true })
  fs.writeFileSync(credentialFile, ['wbmcp', 'v1', 'fixture'].join('_') + '\n', { mode: 0o600 })
  return { root, projectRoot: fs.realpathSync(projectRoot), workbenchRoot: fs.realpathSync(workbenchRoot), credentialFile }
}

function manifestFor(item: ReturnType<typeof fixture>, adapterId = 'memory-v1', clientId = 'memory', profile: 'workbench' | 'brain' = 'workbench') {
  return createWorkbenchMcpRegistrationManifest({
    registrationId: 'workbench',
    adapterId,
    clientId,
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

function configurePolicy(item: ReturnType<typeof fixture>, manifest = manifestFor(item), overrides: Partial<WorkbenchMcpPolicyRequest> = {}): WorkbenchMcpPolicyRequest {
  return {
    policyVersion: WORKBENCH_MCP_POLICY_VERSION,
    scope: 'project',
    ownerProjectRoot: item.projectRoot,
    command: {
      orchestrationVersion: WORKBENCH_MCP_ORCHESTRATION_VERSION,
      command: WORKBENCH_MCP_REGISTER_COMMAND,
      mode: 'single',
      request: {
        apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
        requestId: 'configure-policy',
        operation: 'configure',
        manifest
      }
    },
    ...overrides
  }
}

test('admits project-local workbench and restricted Brain manifests', async () => {
  const item = fixture()
  const registry = new WorkbenchMcpAdapterRegistry([new PolicyMemoryAdapter()])
  const workbench = await evaluateWorkbenchMcpRegistrationPolicy(registry, configurePolicy(item))
  assert.equal(workbench.allowed, true)
  assert.equal(workbench.profile, 'workbench')

  const brain = await evaluateWorkbenchMcpRegistrationPolicy(registry, configurePolicy(item, manifestFor(item, 'memory-v1', 'memory', 'brain')))
  assert.equal(brain.allowed, true)
  assert.equal(brain.profile, 'brain')
})

test('denies global scope, ownership mismatch, unknown adapter, and incompatible policy versions', async () => {
  const item = fixture()
  const registry = new WorkbenchMcpAdapterRegistry([new PolicyMemoryAdapter()])
  assert.equal((await evaluateWorkbenchMcpRegistrationPolicy(registry, configurePolicy(item, manifestFor(item), { scope: 'global' }))).code, 'unsupported_scope')

  const other = path.join(item.root, 'other')
  fs.mkdirSync(other)
  const foreign = manifestFor({ ...item, projectRoot: fs.realpathSync(other) })
  assert.equal((await evaluateWorkbenchMcpRegistrationPolicy(registry, configurePolicy(item, foreign))).code, 'ownership_mismatch')

  const unknown = manifestFor(item, 'missing-v1', 'missing')
  assert.equal((await evaluateWorkbenchMcpRegistrationPolicy(registry, configurePolicy(item, unknown))).code, 'unknown_adapter')

  const invalidVersion = { ...configurePolicy(item), policyVersion: '2.0.0' } as unknown as WorkbenchMcpPolicyRequest
  assert.equal((await evaluateWorkbenchMcpRegistrationPolicy(registry, invalidVersion)).code, 'invalid_policy_version')
})

test('denies duplicate, conflicting, and capability-incomplete registrations', async () => {
  const item = fixture()
  const registry = new WorkbenchMcpAdapterRegistry([new PolicyMemoryAdapter()])
  const exact = { registrationId: 'workbench', adapterId: 'memory-v1', clientId: 'memory', projectRoot: item.projectRoot, profile: 'workbench' as const }
  assert.equal((await evaluateWorkbenchMcpRegistrationPolicy(registry, configurePolicy(item, manifestFor(item), { observedRegistrations: [exact, exact] }))).code, 'duplicate_registration')
  assert.equal((await evaluateWorkbenchMcpRegistrationPolicy(registry, configurePolicy(item, manifestFor(item), { observedRegistrations: [{ ...exact, profile: 'brain' }] }))).code, 'conflicting_registration')

  const incomplete = new WorkbenchMcpAdapterRegistry([new PolicyMemoryAdapter('limited-v1', 'limited', { projectScope: false })])
  assert.equal((await evaluateWorkbenchMcpRegistrationPolicy(incomplete, configurePolicy(item, manifestFor(item, 'limited-v1', 'limited')))).code, 'capability_mismatch')
})

test('fails closed for widened admission, credential references, availability, and dry-run capability', async () => {
  const item = fixture()
  const registry = new WorkbenchMcpAdapterRegistry([new PolicyMemoryAdapter()])
  const widened = structuredClone(manifestFor(item, 'memory-v1', 'memory', 'brain')) as any
  widened.admission.tools.push('applyWorkbenchFileChange')
  assert.equal((await evaluateWorkbenchMcpRegistrationPolicy(registry, configurePolicy(item, widened))).code, 'invalid_request')

  const missingCredential = structuredClone(manifestFor(item))
  missingCredential.server.credentialReferences[0].path = path.join(item.root, 'missing.token')
  assert.equal((await evaluateWorkbenchMcpRegistrationPolicy(registry, configurePolicy(item, missingCredential))).code, 'credential_reference_mismatch')

  const wrongAvailability = structuredClone(manifestFor(item)) as any
  wrongAvailability.availability.startup = 'optional'
  assert.equal((await evaluateWorkbenchMcpRegistrationPolicy(registry, configurePolicy(item, wrongAvailability))).code, 'invalid_request')

  const noDryRun = new WorkbenchMcpAdapterRegistry([new PolicyMemoryAdapter('memory-v1', 'memory', { dryRun: false })])
  const dryRunInput = configurePolicy(item)
  ;(dryRunInput.command as any).request.dryRun = true
  assert.equal((await evaluateWorkbenchMcpRegistrationPolicy(noDryRun, dryRunInput)).code, 'capability_mismatch')
})

test('evaluates status, audit, remove, and deterministic multi-client summaries', async () => {
  const item = fixture()
  const alpha = new PolicyMemoryAdapter('alpha-v1', 'alpha')
  const beta = new PolicyMemoryAdapter('beta-v1', 'beta')
  const registry = new WorkbenchMcpAdapterRegistry([beta, alpha])
  const selector = (clientId: string) => ({ registrationId: 'workbench', clientId, projectRoot: item.projectRoot, profile: 'workbench' as const })

  for (const operation of ['status', 'audit', 'remove'] as const) {
    const input: WorkbenchMcpPolicyRequest = {
      policyVersion: WORKBENCH_MCP_POLICY_VERSION,
      scope: 'project',
      ownerProjectRoot: item.projectRoot,
      command: {
        orchestrationVersion: WORKBENCH_MCP_ORCHESTRATION_VERSION,
        command: WORKBENCH_MCP_REGISTER_COMMAND,
        mode: 'single',
        adapterId: 'alpha-v1',
        request: { apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION, requestId: operation, operation, selector: selector('alpha') }
      }
    }
    assert.equal((await evaluateWorkbenchMcpRegistrationPolicy(registry, input)).allowed, true)
  }

  const summaryInput: WorkbenchMcpPolicyRequest = {
    policyVersion: WORKBENCH_MCP_POLICY_VERSION,
    scope: 'project',
    ownerProjectRoot: item.projectRoot,
    command: {
      orchestrationVersion: WORKBENCH_MCP_ORCHESTRATION_VERSION,
      command: WORKBENCH_MCP_REGISTER_COMMAND,
      mode: 'summary',
      operation: 'status',
      requestId: 'summary',
      targets: [
        { adapterId: 'beta-v1', clientId: 'beta', selector: selector('beta') },
        { adapterId: 'alpha-v1', clientId: 'alpha', selector: selector('alpha') }
      ]
    }
  }
  const executed = await executeWorkbenchMcpRegisterCommandWithPolicy(registry, summaryInput)
  assert.equal(executed.decision.allowed, true)
  assert.equal(executed.result?.mode, 'summary')
  if (executed.result?.mode !== 'summary') throw new Error('Missing summary result')
  assert.deepEqual(executed.result.items.map(entry => entry.clientId), ['alpha', 'beta'])
})

test('admits accepted Claude and Codex adapters without changing client semantics', async () => {
  const item = fixture()
  const homeDir = path.join(item.root, 'home')
  const codexHome = path.join(homeDir, '.codex')
  fs.mkdirSync(codexHome, { recursive: true })
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt"\n', { mode: 0o600 })
  installWorkbenchOwnerConfig({ actionToken: 'offline-action-token-for-tests', homeDir })
  const registry = new WorkbenchMcpAdapterRegistry([
    new ClaudeCodeMcpAdapter({ workbenchRepoRoot: item.workbenchRoot, targetProjectRoot: item.projectRoot, homeDir, nodeExecutable: fs.realpathSync(process.execPath), claudeBin: '/usr/bin/false', checkProcesses: () => [] }),
    new CodexProjectMcpAdapter({ workbenchRepoRoot: item.workbenchRoot, targetProjectRoot: item.projectRoot, homeDir, codexHome, nodeExecutable: fs.realpathSync(process.execPath) })
  ])
  for (const [adapterId, clientId] of [[CLAUDE_MCP_ADAPTER_ID, CLAUDE_MCP_CLIENT_ID], [CODEX_MCP_ADAPTER_ID, CODEX_MCP_CLIENT_ID]] as const) {
    const input: WorkbenchMcpPolicyRequest = {
      policyVersion: WORKBENCH_MCP_POLICY_VERSION,
      scope: 'project',
      ownerProjectRoot: item.projectRoot,
      command: {
        orchestrationVersion: WORKBENCH_MCP_ORCHESTRATION_VERSION,
        command: WORKBENCH_MCP_REGISTER_COMMAND,
        mode: 'single',
        request: { apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION, requestId: `inspect-${clientId}`, operation: 'inspect_capabilities', adapterId, clientId }
      }
    }
    const result = await evaluateWorkbenchMcpRegistrationPolicy(registry, input)
    assert.equal(result.allowed, true)
    assert.equal(result.adapterId, adapterId)
  }
})
