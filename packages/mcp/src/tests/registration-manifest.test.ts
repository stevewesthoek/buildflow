import assert from 'node:assert/strict'
import test from 'node:test'
import { RUN_WORKBENCH_DIRECT_COMMAND_KINDS } from '@workbench/shared'
import { WORKBENCH_TOOL_NAMES } from '../contracts.js'
import {
  WORKBENCH_MCP_REGISTRATION_API_VERSION,
  WORKBENCH_MCP_REGISTRATION_KIND,
  WORKBENCH_MCP_REGISTRATION_MANIFEST_JSON_SCHEMA,
  WORKBENCH_MCP_REGISTRATION_OPERATIONS,
  WORKBENCH_MCP_REGISTRATION_REQUEST_JSON_SCHEMA,
  WORKBENCH_MCP_REGISTRATION_SCHEMA_VERSION,
  createWorkbenchMcpRegistrationManifest,
  parseWorkbenchMcpAdapterCapabilities,
  parseWorkbenchMcpRegistrationManifest,
  parseWorkbenchMcpRegistrationRequest,
  validateWorkbenchMcpRegistrationManifest,
  type WorkbenchMcpRegistrationManifest
} from '../registration-manifest.js'

const baseInput = {
  registrationId: 'workbench-main',
  clientId: 'codex',
  adapterId: 'codex-project-v1',
  projectRoot: '/workspace/project',
  command: '/usr/bin/node',
  args: ['/workspace/workbench/packages/mcp/dist/server.js'],
  cwd: '/workspace/workbench',
  credentialFile: '/home/user/.buildflow/codex-workbench-mcp.token',
  minimumWorkbenchVersion: '1.3.3-beta',
  adapterApiVersion: '1.0.0'
} as const

test('builds a strict full-surface workbench registration manifest', () => {
  const manifest = createWorkbenchMcpRegistrationManifest({ ...baseInput, profile: 'workbench' })
  assert.equal(manifest.schemaVersion, WORKBENCH_MCP_REGISTRATION_SCHEMA_VERSION)
  assert.equal(manifest.kind, WORKBENCH_MCP_REGISTRATION_KIND)
  assert.equal(manifest.availability.startup, 'required')
  assert.equal(manifest.availability.onUnavailable, 'block_startup')
  assert.deepEqual(manifest.admission.tools, [...WORKBENCH_TOOL_NAMES])
  assert.deepEqual(manifest.admission.commandKinds, [...RUN_WORKBENCH_DIRECT_COMMAND_KINDS])
  assert.deepEqual(manifest.server.credentialReferences, [{
    id: 'workbench-action',
    kind: 'file',
    path: baseInput.credentialFile,
    inject: { kind: 'environment', name: 'WORKBENCH_MCP_CREDENTIAL_FILE' }
  }])
  assert.equal(validateWorkbenchMcpRegistrationManifest(manifest), true)
  assert.deepEqual(parseWorkbenchMcpRegistrationManifest(JSON.parse(JSON.stringify(manifest))), manifest)
})

test('builds the restricted optional Brain profile without duplicating the server or credential', () => {
  const manifest = createWorkbenchMcpRegistrationManifest({
    ...baseInput,
    registrationId: 'brain-main',
    clientId: 'brain-codex',
    adapterId: 'codex-project-v1',
    profile: 'brain'
  })
  assert.equal(manifest.server.id, 'workbench')
  assert.equal(manifest.availability.startup, 'optional')
  assert.equal(manifest.availability.onUnavailable, 'continue_without_workbench')
  assert.deepEqual(manifest.admission.tools, ['getWorkbenchStatus', 'readWorkbenchContext', 'runWorkbenchCommand'])
  assert.deepEqual(manifest.admission.commandKinds, ['n8n_workflow_migration'])
  assert.equal(manifest.server.credentialReferences.length, 1)
  assert.equal(validateWorkbenchMcpRegistrationManifest(manifest), true)
})

test('rejects inline credential material and profile widening', () => {
  const manifest = createWorkbenchMcpRegistrationManifest({ ...baseInput, profile: 'brain' })
  const inlineSecret = structuredClone(manifest) as WorkbenchMcpRegistrationManifest & {
    server: { credentialReferences: Array<Record<string, unknown>> }
  }
  inlineSecret.server.credentialReferences[0].value = 'not-allowed'
  assert.equal(validateWorkbenchMcpRegistrationManifest(inlineSecret), false)
  assert.throws(() => parseWorkbenchMcpRegistrationManifest(inlineSecret), /additional properties/)

  const widened = structuredClone(manifest)
  widened.admission.tools = [...WORKBENCH_TOOL_NAMES]
  assert.equal(validateWorkbenchMcpRegistrationManifest(widened), false)
  assert.throws(() => parseWorkbenchMcpRegistrationManifest(widened), /brain profile tools/)
})

test('rejects relative executable, project, and credential paths', () => {
  assert.throws(() => createWorkbenchMcpRegistrationManifest({
    ...baseInput,
    profile: 'workbench',
    command: 'node'
  }), /server executable command must be an absolute path/)
  assert.throws(() => createWorkbenchMcpRegistrationManifest({
    ...baseInput,
    profile: 'workbench',
    projectRoot: 'relative/project'
  }), /target project root must be an absolute path/)
  assert.throws(() => createWorkbenchMcpRegistrationManifest({
    ...baseInput,
    profile: 'workbench',
    credentialFile: 'relative/token'
  }), /credential reference workbench-action must be an absolute path/)
})

test('validates adapter capability inspection without binding to a client format', () => {
  const capabilities = parseWorkbenchMcpAdapterCapabilities({
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    adapterId: 'future-client-v1',
    clientId: 'future-client',
    operations: [...WORKBENCH_MCP_REGISTRATION_OPERATIONS],
    transports: ['stdio'],
    scopeDimensions: ['client', 'project', 'profile'],
    availabilityModes: ['required', 'optional'],
    credentialReferenceKinds: ['file'],
    supports: {
      capabilityInspection: true,
      atomicConfigure: true,
      rollback: true,
      dryRun: true
    }
  })
  assert.equal(capabilities.clientId, 'future-client')
  assert.deepEqual(capabilities.operations, [...WORKBENCH_MCP_REGISTRATION_OPERATIONS])
  assert.throws(() => parseWorkbenchMcpAdapterCapabilities({
    ...capabilities,
    credentialReferenceKinds: ['inline']
  }), /adapter capabilities/)
})

test('validates inspect, configure, remove, status, and audit requests', () => {
  const manifest = createWorkbenchMcpRegistrationManifest({ ...baseInput, profile: 'workbench' })
  const selector = {
    registrationId: manifest.registrationId,
    clientId: manifest.target.client.id,
    projectRoot: manifest.target.project.root,
    profile: manifest.target.profile
  }
  const requests = [
    {
      apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
      requestId: 'request-capabilities',
      operation: 'inspect_capabilities',
      adapterId: manifest.target.client.adapterId,
      clientId: manifest.target.client.id
    },
    {
      apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
      requestId: 'request-configure',
      operation: 'configure',
      manifest,
      dryRun: true
    },
    {
      apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
      requestId: 'request-remove',
      operation: 'remove',
      selector,
      dryRun: true
    },
    {
      apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
      requestId: 'request-status',
      operation: 'status',
      selector
    },
    {
      apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
      requestId: 'request-audit',
      operation: 'audit',
      selector
    }
  ]
  for (const request of requests) {
    assert.equal(parseWorkbenchMcpRegistrationRequest(request).operation, request.operation)
  }
  assert.throws(() => parseWorkbenchMcpRegistrationRequest({
    apiVersion: WORKBENCH_MCP_REGISTRATION_API_VERSION,
    requestId: 'request-configure',
    operation: 'configure'
  }), /registration request/)
})

test('exports JSON-serializable strict schemas for manifest and operation API', () => {
  const manifestSchema = JSON.parse(JSON.stringify(WORKBENCH_MCP_REGISTRATION_MANIFEST_JSON_SCHEMA))
  const requestSchema = JSON.parse(JSON.stringify(WORKBENCH_MCP_REGISTRATION_REQUEST_JSON_SCHEMA))
  assert.equal(manifestSchema.properties.schemaVersion.const, WORKBENCH_MCP_REGISTRATION_SCHEMA_VERSION)
  assert.equal(requestSchema.oneOf.length, 5)
  assert.equal(manifestSchema.additionalProperties, false)
})
