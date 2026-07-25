import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WORKBENCH_MCP_REGISTRATION_API_VERSION,
  createWorkbenchMcpRegistrationManifest,
  type WorkbenchMcpRegistrationManifest,
  type WorkbenchMcpRegistrationSelector
} from '../registration-manifest.js'
import {
  WORKBENCH_MCP_ADAPTER_CONTRACT_VERSION,
  WorkbenchMcpAdapterContractError,
  createWorkbenchMcpAdapterResult,
  defaultWorkbenchMcpExecutableAdapterCapabilities,
  executeWorkbenchMcpAdapterRequest,
  negotiateWorkbenchMcpAdapterCompatibility,
  normalizeMutationEvidence,
  parseWorkbenchMcpExecutableAdapterCapabilities,
  type WorkbenchMcpAdapterMutationEvidence,
  type WorkbenchMcpAdapterResult,
  type WorkbenchMcpAuditRequest,
  type WorkbenchMcpClientAdapter,
  type WorkbenchMcpConfigureRequest,
  type WorkbenchMcpExecutableAdapterCapabilities,
  type WorkbenchMcpRemoveRequest,
  type WorkbenchMcpStatusRequest
} from '../adapter-contract.js'

const baseManifestInput = {
  registrationId: 'workbench-main',
  clientId: 'neutral-client',
  adapterId: 'neutral-memory-v1',
  projectRoot: '/workspace/project',
  command: '/usr/bin/node',
  args: ['/workspace/workbench/packages/mcp/dist/server.js'],
  cwd: '/workspace/workbench',
  credentialFile: '/home/user/.buildflow/workbench-mcp.token',
  minimumWorkbenchVersion: '1.3.3-beta',
  adapterApiVersion: WORKBENCH_MCP_ADAPTER_CONTRACT_VERSION
} as const

function selectorFor(manifest: WorkbenchMcpRegistrationManifest): WorkbenchMcpRegistrationSelector {
  return {
    registrationId: manifest.registrationId,
    clientId: manifest.target.client.id,
    projectRoot: manifest.target.project.root,
    profile: manifest.target.profile
  }
}

function noMutation(supported = true): WorkbenchMcpAdapterMutationEvidence {
  return {
    state: 'none',
    changedPaths: [],
    rollback: {
      supported,
      attempted: false,
      status: 'not_required',
      restoredPaths: []
    }
  }
}

class InMemoryWorkbenchMcpAdapter implements WorkbenchMcpClientAdapter {
  readonly adapterId = 'neutral-memory-v1'
  readonly clientId = 'neutral-client'
  private readonly registrations = new Map<string, WorkbenchMcpRegistrationManifest>()
  private capabilitiesValue: WorkbenchMcpExecutableAdapterCapabilities

  constructor(overrides: Partial<WorkbenchMcpExecutableAdapterCapabilities['supports']> = {}) {
    this.capabilitiesValue = defaultWorkbenchMcpExecutableAdapterCapabilities({
      adapterId: this.adapterId,
      clientId: this.clientId,
      ...overrides
    })
  }

  inspectCapabilities(): WorkbenchMcpExecutableAdapterCapabilities {
    return structuredClone(this.capabilitiesValue)
  }

  setCapabilities(capabilities: WorkbenchMcpExecutableAdapterCapabilities): void {
    this.capabilitiesValue = structuredClone(capabilities)
  }

  get(registrationId: string): WorkbenchMcpRegistrationManifest | undefined {
    const value = this.registrations.get(registrationId)
    return value === undefined ? undefined : structuredClone(value)
  }

  configure(request: WorkbenchMcpConfigureRequest): WorkbenchMcpAdapterResult<'configure'> {
    const existed = this.registrations.has(request.manifest.registrationId)
    if (!request.dryRun) this.registrations.set(request.manifest.registrationId, structuredClone(request.manifest))
    return createWorkbenchMcpAdapterResult({
      adapterId: this.adapterId,
      clientId: this.clientId,
      operation: 'configure',
      requestId: request.requestId,
      registrationId: request.manifest.registrationId,
      profile: request.manifest.target.profile,
      outcome: existed ? 'updated' : 'configured',
      dryRun: request.dryRun,
      mutation: request.dryRun
        ? {
            state: 'planned',
            changedPaths: [],
            rollback: { supported: true, attempted: false, status: 'not_required', restoredPaths: [] }
          }
        : {
            state: 'complete',
            changedPaths: [`memory://${request.manifest.registrationId}`],
            rollback: { supported: true, attempted: false, status: 'not_attempted', restoredPaths: [] }
          }
    })
  }

  remove(request: WorkbenchMcpRemoveRequest): WorkbenchMcpAdapterResult<'remove'> {
    const existed = this.registrations.has(request.selector.registrationId)
    if (existed && !request.dryRun) this.registrations.delete(request.selector.registrationId)
    return createWorkbenchMcpAdapterResult({
      adapterId: this.adapterId,
      clientId: this.clientId,
      operation: 'remove',
      requestId: request.requestId,
      registrationId: request.selector.registrationId,
      profile: request.selector.profile,
      outcome: existed ? 'removed' : 'not_found',
      dryRun: request.dryRun,
      mutation: existed
        ? request.dryRun
          ? {
              state: 'planned',
              changedPaths: [],
              rollback: { supported: true, attempted: false, status: 'not_required', restoredPaths: [] }
            }
          : {
              state: 'complete',
              changedPaths: [`memory://${request.selector.registrationId}`],
              rollback: { supported: true, attempted: false, status: 'not_attempted', restoredPaths: [] }
            }
        : noMutation()
    })
  }

  status(request: WorkbenchMcpStatusRequest): WorkbenchMcpAdapterResult<'status'> {
    const present = this.registrations.has(request.selector.registrationId)
    return createWorkbenchMcpAdapterResult({
      adapterId: this.adapterId,
      clientId: this.clientId,
      operation: 'status',
      requestId: request.requestId,
      registrationId: request.selector.registrationId,
      profile: request.selector.profile,
      outcome: present ? 'present' : 'absent',
      mutation: noMutation()
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
      mutation: noMutation(),
      diagnostics: stored === undefined
        ? [{ code: 'missing_registration', message: 'Registration is absent' }]
        : []
    })
  }
}

test('advertises stable identity and complete executable adapter capabilities', () => {
  const capabilities = defaultWorkbenchMcpExecutableAdapterCapabilities({
    adapterId: 'neutral-memory-v1',
    clientId: 'neutral-client'
  })
  assert.equal(capabilities.contractVersion, WORKBENCH_MCP_ADAPTER_CONTRACT_VERSION)
  assert.deepEqual(capabilities.registrationApiVersions, [WORKBENCH_MCP_REGISTRATION_API_VERSION])
  assert.deepEqual(capabilities.manifestSchemaVersions, ['1.0.0'])
  assert.deepEqual(capabilities.operations, ['inspect_capabilities', 'configure', 'remove', 'status', 'audit'])
  assert.deepEqual(capabilities.scopeDimensions, ['client', 'project', 'profile'])
  assert.deepEqual(capabilities.availabilityModes, ['required', 'optional'])
  assert.deepEqual(capabilities.credentialReferenceKinds, ['file'])
  assert.equal(parseWorkbenchMcpExecutableAdapterCapabilities(structuredClone(capabilities)).adapterId, 'neutral-memory-v1')
})

test('executes configure, status, audit, dry-run remove, and remove through a neutral adapter', async () => {
  const adapter = new InMemoryWorkbenchMcpAdapter()
  const manifest = createWorkbenchMcpRegistrationManifest({ ...baseManifestInput, profile: 'workbench' })
  const selector = selectorFor(manifest)

  const inspected = await executeWorkbenchMcpAdapterRequest(adapter, {
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'inspect-1',
    operation: 'inspect_capabilities',
    adapterId: adapter.adapterId,
    clientId: adapter.clientId
  })
  assert.equal('contractVersion' in inspected, true)

  const configured = await executeWorkbenchMcpAdapterRequest(adapter, {
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'configure-1',
    operation: 'configure',
    manifest
  }) as WorkbenchMcpAdapterResult<'configure'>
  assert.equal(configured.outcome, 'configured')
  assert.equal(configured.changed, true)

  const status = await executeWorkbenchMcpAdapterRequest(adapter, {
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'status-1',
    operation: 'status',
    selector
  }) as WorkbenchMcpAdapterResult<'status'>
  assert.equal(status.outcome, 'present')

  const audit = await executeWorkbenchMcpAdapterRequest(adapter, {
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'audit-1',
    operation: 'audit',
    selector
  }) as WorkbenchMcpAdapterResult<'audit'>
  assert.equal(audit.outcome, 'compliant')

  const preview = await executeWorkbenchMcpAdapterRequest(adapter, {
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'remove-preview',
    operation: 'remove',
    selector,
    dryRun: true
  }) as WorkbenchMcpAdapterResult<'remove'>
  assert.equal(preview.changed, false)
  assert.equal(preview.mutation.state, 'planned')
  assert.notEqual(adapter.get(manifest.registrationId), undefined)

  const removed = await executeWorkbenchMcpAdapterRequest(adapter, {
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'remove-1',
    operation: 'remove',
    selector
  }) as WorkbenchMcpAdapterResult<'remove'>
  assert.equal(removed.outcome, 'removed')
  assert.equal(adapter.get(manifest.registrationId), undefined)
})

test('preserves the restricted Brain profile through adapter execution', async () => {
  const adapter = new InMemoryWorkbenchMcpAdapter()
  const manifest = createWorkbenchMcpRegistrationManifest({
    ...baseManifestInput,
    registrationId: 'brain-main',
    profile: 'brain'
  })
  const configured = await executeWorkbenchMcpAdapterRequest(adapter, {
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'configure-brain',
    operation: 'configure',
    manifest
  }) as WorkbenchMcpAdapterResult<'configure'>
  assert.equal(configured.profile, 'brain')
  const stored = adapter.get(manifest.registrationId)
  assert.deepEqual(stored?.admission.tools, ['getWorkbenchStatus', 'readWorkbenchContext', 'runWorkbenchCommand'])
  assert.deepEqual(stored?.admission.commandKinds, ['n8n_workflow_migration'])
  assert.equal(stored?.availability.startup, 'optional')
})

test('fails compatibility negotiation for unsupported versions and capabilities', () => {
  const adapter = new InMemoryWorkbenchMcpAdapter({ dryRun: false, atomicConfigure: false, rollback: false })
  const capabilities = adapter.inspectCapabilities()
  const manifest = createWorkbenchMcpRegistrationManifest({ ...baseManifestInput, profile: 'workbench' })

  assert.throws(() => negotiateWorkbenchMcpAdapterCompatibility(capabilities, {
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'configure-unsupported',
    operation: 'configure',
    manifest
  }), (error: unknown) => error instanceof WorkbenchMcpAdapterContractError && error.code === 'unsupported_capability')

  const dryRunCapabilities = defaultWorkbenchMcpExecutableAdapterCapabilities({
    adapterId: adapter.adapterId,
    clientId: adapter.clientId,
    dryRun: false
  })
  assert.throws(() => negotiateWorkbenchMcpAdapterCompatibility(dryRunCapabilities, {
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'remove-preview',
    operation: 'remove',
    selector: selectorFor(manifest),
    dryRun: true
  }), (error: unknown) => error instanceof WorkbenchMcpAdapterContractError && error.code === 'unsupported_capability')

  const incompatible = structuredClone(capabilities)
  incompatible.manifestSchemaVersions = ['2.0.0']
  assert.throws(() => negotiateWorkbenchMcpAdapterCompatibility(incompatible, {
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'configure-version',
    operation: 'configure',
    manifest
  }), (error: unknown) => error instanceof WorkbenchMcpAdapterContractError && error.code === 'incompatible_version')
})

test('rejects adapter identity mismatches and widened Brain requests', async () => {
  const adapter = new InMemoryWorkbenchMcpAdapter()
  const mismatched = defaultWorkbenchMcpExecutableAdapterCapabilities({
    adapterId: 'other-adapter',
    clientId: adapter.clientId
  })
  adapter.setCapabilities(mismatched)
  await assert.rejects(() => executeWorkbenchMcpAdapterRequest(adapter, {
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'inspect-mismatch',
    operation: 'inspect_capabilities',
    adapterId: adapter.adapterId,
    clientId: adapter.clientId
  }), (error: unknown) => error instanceof WorkbenchMcpAdapterContractError && error.code === 'identity_mismatch')

  const validAdapter = new InMemoryWorkbenchMcpAdapter()
  const brain = createWorkbenchMcpRegistrationManifest({
    ...baseManifestInput,
    registrationId: 'brain-widened',
    profile: 'brain'
  })
  const widened = structuredClone(brain) as WorkbenchMcpRegistrationManifest
  widened.admission.tools = ['getWorkbenchStatus', 'readWorkbenchContext', 'runWorkbenchCommand', 'applyWorkbenchFileChange']
  await assert.rejects(() => executeWorkbenchMcpAdapterRequest(validAdapter, {
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'configure-widened',
    operation: 'configure',
    manifest: widened
  }), (error: unknown) => error instanceof WorkbenchMcpAdapterContractError && error.code === 'invalid_request')
})

test('normalizes deterministic results, rollback evidence, and partial-mutation errors', () => {
  const mutation = normalizeMutationEvidence({
    state: 'partial',
    changedPaths: ['/z', '/a', '/z'],
    rollback: {
      supported: true,
      attempted: true,
      status: 'failed',
      restoredPaths: ['/b', '/a', '/b'],
      message: 'restore failed'
    }
  })
  assert.deepEqual(mutation.changedPaths, ['/a', '/z'])
  assert.deepEqual(mutation.rollback.restoredPaths, ['/a', '/b'])

  const result = createWorkbenchMcpAdapterResult({
    adapterId: 'neutral-memory-v1',
    clientId: 'neutral-client',
    operation: 'configure',
    requestId: 'normalize-1',
    registrationId: 'workbench-main',
    profile: 'workbench',
    outcome: 'updated',
    mutation,
    diagnostics: [
      { code: 'z', message: 'last' },
      { code: 'a', message: 'first' }
    ]
  })
  assert.equal(result.changed, true)
  assert.deepEqual(result.diagnostics.map(value => value.code), ['a', 'z'])

  const error = new WorkbenchMcpAdapterContractError('rollback_failed', 'Rollback failed', {
    retryable: false,
    adapterId: result.adapterId,
    clientId: result.clientId,
    operation: result.operation,
    mutation
  })
  assert.deepEqual(error.toJSON(), {
    name: 'WorkbenchMcpAdapterContractError',
    code: 'rollback_failed',
    message: 'Rollback failed',
    retryable: false,
    adapterId: 'neutral-memory-v1',
    clientId: 'neutral-client',
    operation: 'configure',
    mutation
  })
})

test('exports JSON-serializable strict executable capability schema', async () => {
  const schema = await import('../adapter-contract.js').then(module =>
    JSON.parse(JSON.stringify(module.WORKBENCH_MCP_EXECUTABLE_ADAPTER_CAPABILITIES_JSON_SCHEMA))
  )
  assert.equal(schema.additionalProperties, false)
  assert.equal(schema.properties.contractVersion.const, WORKBENCH_MCP_ADAPTER_CONTRACT_VERSION)
  assert.equal(schema.properties.credentialReferenceKinds.items.const, 'file')
})
