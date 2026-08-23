import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  advanceControlledWorkflowMigration,
  projectControlledWorkflowMigrationStatus,
  type ControlledWorkflowMigrationOperation
} from '../packages/shared/src/controlled-workflow-migration-state'
import {
  canonicalizeN8nWorkflow,
  hashCanonicalWorkflowTopology
} from '../packages/shared/src/controlled-workflow-canonicalization'
import type { ControlledWorkflowTopologyManifest } from '../packages/shared/src/controlled-workflow-topology'
import type { ControlledN8nWorkflowGrant } from '../packages/cli/src/agent/capability-grants'
import {
  createN8nWorkflowMigrationExecutor,
  N8N_WORKFLOW_MIGRATION_EXECUTOR_LIMITS,
  toControlledWorkflowMigrationEvent,
  type N8nWorkflowMigrationExecutorResult
} from '../packages/cli/src/agent/n8n-workflow-migration-executor'

const sha256Text = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')
const hash = (character: string): string => character.repeat(64)

function canonicalHash(value: unknown, canonicalizationVersion: 1 | 2 = 1): string {
  const canonical = canonicalizeN8nWorkflow(value, canonicalizationVersion)
  assert.equal(canonical.ok, true)
  if (!canonical.ok) throw new Error(canonical.issues[0]?.code)
  return hashCanonicalWorkflowTopology(canonical.topology, sha256Text)
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-migration-executor-'))
const write = (relativePath: string, content: string, mode = 0o600): string => {
  const target = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content, { mode })
  return target
}

const workflowId = 'workflow-1'
const sourceId = 'example-source'
const operationId = 'operation-1'
const sourceRootFingerprint = hash('f')
const apiOriginFingerprint = hash('a')
const wrapperRelativePath = 'tools/n8n-api.sh'
const candidateRelativePath = 'operations/workflows/candidate.json'
const rollbackRelativePath = 'operations/artifacts/rollback.json'
const manifestRelativePath = 'operations/manifests/migration.json'

const preMutationWorkflow = {
  id: workflowId,
  active: false,
  settings: {},
  tags: [],
  nodes: [{ id: 'node-1', name: 'Node', type: 'n8n-nodes-base.set', parameters: { value: 'before' } }],
  connections: {}
}
const candidateWorkflow = {
  ...preMutationWorkflow,
  nodes: [{ id: 'node-1', name: 'Node', type: 'n8n-nodes-base.set', parameters: { value: 'candidate' } }]
}
const rollbackWorkflow = {
  ...preMutationWorkflow,
  nodes: [{ id: 'node-1', name: 'Node', type: 'n8n-nodes-base.set', parameters: { value: 'rollback' } }]
}
const unexpectedWorkflow = {
  ...preMutationWorkflow,
  nodes: [{ id: 'node-1', name: 'Node', type: 'n8n-nodes-base.set', parameters: { value: 'unexpected' } }]
}

const wrapperContent = '#!/usr/bin/env bash\nexit 99\n'
const candidateContent = JSON.stringify(candidateWorkflow)
const rollbackContent = JSON.stringify(rollbackWorkflow)
write(wrapperRelativePath, wrapperContent, 0o700)
write(candidateRelativePath, candidateContent)
write(rollbackRelativePath, rollbackContent)

const manifest: ControlledWorkflowTopologyManifest = {
  schemaVersion: 1,
  kind: 'n8n-controlled-topology-migration',
  workflow: {
    id: workflowId,
    canonicalizationVersion: 1,
    expectedLiveCanonicalSha256: canonicalHash(preMutationWorkflow),
    candidateCanonicalSha256: canonicalHash(candidateWorkflow),
    rollbackCanonicalSha256: canonicalHash(rollbackWorkflow)
  },
  artifacts: {
    candidatePath: candidateRelativePath,
    candidateSha256: sha256Text(candidateContent),
    rollbackPath: rollbackRelativePath,
    rollbackSha256: sha256Text(rollbackContent)
  },
  invariants: {
    activation: 'unchanged',
    settings: 'unchanged',
    tags: 'unchanged',
    sharing: 'unchanged',
    credentials: 'unchanged',
    webhooks: 'unchanged',
    schedules: 'unchanged'
  },
  nodes: { add: [], remove: [], modify: [] },
  connections: { add: [], remove: [] },
  routes: { required: [], forbidden: [] }
}
const manifestContent = JSON.stringify(manifest)
write(manifestRelativePath, manifestContent)

const wrapperSha256 = sha256Text(wrapperContent)
const manifestSha256 = sha256Text(manifestContent)

const grant: ControlledN8nWorkflowGrant = {
  grantId: 'grant-1',
  version: 3,
  enabled: true,
  sourceId,
  workflowId,
  wrapperPath: wrapperRelativePath,
  wrapperSha256,
  allowedCandidateRoots: ['operations/workflows'],
  allowedRollbackRoots: ['operations/artifacts'],
  allowedManifestRoots: ['operations/manifests'],
  canonicalizationVersion: 1,
  confirmationTtlSeconds: 600,
  operationTimeoutMs: 12_000,
  maxArtifactBytes: 600_000,
  maximumPolicy: {
    activation: 'unchanged',
    settings: 'unchanged',
    tags: 'unchanged',
    sharing: 'unchanged',
    credentials: 'unchanged',
    webhooks: 'unchanged',
    schedules: 'unchanged'
  },
  apiOriginFingerprint
}

const baseOperation: ControlledWorkflowMigrationOperation = {
  storeVersion: 1,
  operationId,
  status: 'running',
  binding: {
    sourceId,
    sourceRootFingerprint,
    grantId: grant.grantId,
    grantVersion: grant.version,
    workflowId,
    mode: 'apply',
    candidatePath: candidateRelativePath,
    candidateSha256: manifest.artifacts.candidateSha256,
    rollbackPath: rollbackRelativePath,
    rollbackSha256: manifest.artifacts.rollbackSha256,
    manifestPath: manifestRelativePath,
    manifestSha256,
    wrapperPath: wrapperRelativePath,
    wrapperSha256,
    canonicalizationVersion: 1,
    candidateCanonicalSha256: manifest.workflow.candidateCanonicalSha256,
    rollbackCanonicalSha256: manifest.workflow.rollbackCanonicalSha256,
    expectedLiveCanonicalSha256: manifest.workflow.expectedLiveCanonicalSha256,
    apiOriginFingerprint
  },
  confirmationExpiresAt: '2026-07-14T12:00:00.000Z',
  confirmationConsumedAt: '2026-07-14T11:00:00.000Z',
  createdAt: '2026-07-14T10:00:00.000Z',
  updatedAt: '2026-07-14T11:00:00.000Z',
  candidateUpdateRequests: 0,
  rollbackUpdateRequests: 0,
  readbackRequests: 1,
  evidence: { protectedDomains: 'unchanged' }
}

const readEffect = {
  type: 'read_live_workflow' as const,
  operationId,
  workflowId,
  purpose: 'precondition' as const,
  expectedLiveCanonicalSha256: manifest.workflow.expectedLiveCanonicalSha256
}
const candidateEffect = {
  type: 'apply_candidate' as const,
  operationId,
  workflowId,
  artifactPath: candidateRelativePath,
  artifactSha256: manifest.artifacts.candidateSha256
}
const rollbackEffect = {
  type: 'apply_rollback' as const,
  operationId,
  workflowId,
  artifactPath: rollbackRelativePath,
  artifactSha256: manifest.artifacts.rollbackSha256,
  automatic: false
}

let nextProcessResult: any = {
  outcome: 'succeeded',
  exitCode: 0,
  signal: null,
  stdout: JSON.stringify(preMutationWorkflow),
  stderr: '',
  stdoutTruncated: false,
  stderrTruncated: false
}
const processSpecifications: any[] = []
const runtimeApiUrl = 'https://automation.example.test/api/v1'
const runtimeApiKey = ['synthetic', 'runtime', 'credential'].join('-')
const runtimeConfiguration = () => ({
  environment: {
    PATH: '/usr/bin:/bin', HOME: root, CI: '1', NO_COLOR: '1',
    N8N_API_URL: runtimeApiUrl, N8N_API_KEY: runtimeApiKey
  },
  credentialValues: [runtimeApiKey]
})

function createExecutor(overrides: Record<string, unknown> = {}) {
  return createN8nWorkflowMigrationExecutor({
    sourceRoot: root,
    sourceId,
    sourceRootFingerprint,
    apiOriginFingerprint,
    executeFixedProcess: async specification => {
      processSpecifications.push(specification)
      return nextProcessResult
    },
    readConfiguredCredentialValues: () => [],
    nowMs: (() => {
      let value = 1_000
      return () => { value += 5; return value }
    })(),
    ...overrides
  } as any)
}

const invocation = (
  effect: unknown = readEffect,
  operation: ControlledWorkflowMigrationOperation = baseOperation,
  selectedGrant: ControlledN8nWorkflowGrant = grant
) => ({ effect, operation, grant: selectedGrant })

async function expectBlocked(
  label: string,
  value: unknown,
  reasonCode: N8nWorkflowMigrationExecutorResult['reasonCode'],
  executor = createExecutor()
) {
  const before = processSpecifications.length
  const result = await executor(value)
  assert.equal(result.classification, 'blocked', label)
  assert.equal(result.reasonCode, reasonCode, label)
  assert.equal(processSpecifications.length, before, `${label} must not execute a process`)
  assert.ok(result.issues.length <= N8N_WORKFLOW_MIGRATION_EXECUTOR_LIMITS.maxIssues)
  assert.ok(result.issues.every(issue => issue.message.length <= N8N_WORKFLOW_MIGRATION_EXECUTOR_LIMITS.maxIssueMessageLength))
}

async function main() {
  try {
    processSpecifications.length = 0
    nextProcessResult = {
      outcome: 'succeeded', exitCode: 0, signal: null,
      stdout: JSON.stringify(preMutationWorkflow), stderr: '',
      stdoutTruncated: false, stderrTruncated: false
    }
    const executor = createExecutor()
    let result = await executor(invocation())
    assert.equal(result.classification, 'succeeded')
    assert.equal(result.reasonCode, 'READ_SUCCEEDED')
    assert.equal(result.workflowId, workflowId)
    assert.equal(result.operationId, operationId)
    assert.equal(result.readbackResult, 'matches_pre_mutation')
    assert.equal(result.observedCanonicalSha256, manifest.workflow.expectedLiveCanonicalSha256)
    assert.equal(result.responseParsed, true)
    assert.equal(result.issues.length, 0)
    assert.equal(processSpecifications.length, 1)
    const approvedRead = processSpecifications[0]
    const realRoot = fs.realpathSync(root)
    assert.equal(approvedRead.executable, path.join(realRoot, wrapperRelativePath))
    assert.equal(approvedRead.executableSha256, wrapperSha256)
    assert.deepEqual(approvedRead.args, ['get-workflow', workflowId])
    assert.equal(approvedRead.cwd, realRoot)
    assert.equal(approvedRead.shell, false)
    assert.equal(approvedRead.mayMutate, false)
    assert.equal(approvedRead.terminateProcessTree, true)
    assert.equal(approvedRead.terminationGraceMs, 500)
    assert.equal(approvedRead.timeoutMs, grant.operationTimeoutMs)
    assert.equal(approvedRead.stdoutLimitBytes, N8N_WORKFLOW_MIGRATION_EXECUTOR_LIMITS.maxStdoutBytes)
    assert.equal(approvedRead.stderrLimitBytes, N8N_WORKFLOW_MIGRATION_EXECUTOR_LIMITS.maxStderrBytes)
    assert.deepEqual(
      Object.keys(approvedRead.env).sort(),
      Object.keys(approvedRead.env).filter((key: string) => [
        'PATH', 'HOME', 'CI', 'NO_COLOR', 'N8N_CONFIG_FILE', 'N8N_API_URL', 'N8N_API_KEY'
      ].includes(key)).sort(),
      'the child environment must contain only the fixed allowlist'
    )

    processSpecifications.length = 0
    result = await createExecutor({ loadRuntimeConfiguration: runtimeConfiguration })(invocation())
    assert.equal(result.classification, 'succeeded')
    assert.equal(processSpecifications.length, 1)
    assert.equal(processSpecifications[0].env.N8N_API_URL, runtimeApiUrl)
    assert.equal(processSpecifications[0].env.N8N_API_KEY, runtimeApiKey)
    assert.equal(JSON.stringify(result).includes(runtimeApiKey), false)

    await expectBlocked(
      'runtime configuration unavailable',
      invocation(),
      'RUNTIME_CONFIGURATION_UNAVAILABLE',
      createExecutor({ loadRuntimeConfiguration: () => { throw new Error('private fixture failure') } })
    )
    await expectBlocked(
      'runtime credential missing from redaction values',
      invocation(),
      'RUNTIME_CONFIGURATION_UNAVAILABLE',
      createExecutor({
        loadRuntimeConfiguration: () => ({
          environment: runtimeConfiguration().environment,
          credentialValues: []
        })
      })
    )

    const mutableOperation = structuredClone(baseOperation)
    const mutableEffect = { ...readEffect }
    result = await createExecutor({
      executeFixedProcess: async () => {
        mutableOperation.binding.workflowId = 'mutated-after-validation'
        mutableEffect.purpose = 'reconciliation'
        return {
          outcome: 'succeeded', exitCode: 0, signal: null,
          stdout: JSON.stringify(preMutationWorkflow), stderr: '',
          stdoutTruncated: false, stderrTruncated: false
        }
      }
    })(invocation(mutableEffect, mutableOperation))
    assert.equal(result.classification, 'succeeded')
    assert.equal(result.workflowId, workflowId)
    assert.equal(result.readPurpose, 'precondition')

    const serializedSuccess = JSON.stringify(result)
    for (const forbidden of [
      JSON.stringify(preMutationWorkflow),
      approvedRead.executable,
      '"stdout":', '"stderr":', '"env":', '"environment":', 'N8N_API_KEY'
    ]) {
      assert.equal(serializedSuccess.includes(forbidden), false, `public evidence must omit ${forbidden.slice(0, 40)}`)
    }

    await expectBlocked('wrong host source', invocation(), 'SOURCE_ID_MISMATCH', createExecutor({ sourceId: 'wrong-source' }))
    await expectBlocked('wrong workflow', invocation({ ...readEffect, workflowId: 'wrong-workflow' }), 'WORKFLOW_BINDING_MISMATCH')
    await expectBlocked('wrong grant', invocation(readEffect, baseOperation, { ...grant, grantId: 'wrong-grant' }), 'GRANT_IDENTITY_MISMATCH')
    await expectBlocked('wrong grant version', invocation(readEffect, baseOperation, { ...grant, version: 4 }), 'GRANT_IDENTITY_MISMATCH')
    await expectBlocked('disabled grant', invocation(readEffect, baseOperation, { ...grant, enabled: false }), 'GRANT_DISABLED')
    await expectBlocked('wrapper path mismatch', invocation(readEffect, baseOperation, { ...grant, wrapperPath: 'tools/other.sh' }), 'WRAPPER_BINDING_MISMATCH')
    await expectBlocked('wrapper binding hash mismatch', invocation(readEffect, baseOperation, { ...grant, wrapperSha256: hash('9') }), 'WRAPPER_BINDING_MISMATCH')
    await expectBlocked('API-origin mismatch', invocation(), 'API_ORIGIN_MISMATCH', createExecutor({ apiOriginFingerprint: hash('9') }))
    await expectBlocked('source-root fingerprint mismatch', invocation(), 'SOURCE_ROOT_FINGERPRINT_MISMATCH', createExecutor({ sourceRootFingerprint: hash('9') }))
    await expectBlocked(
      'unknown operation mode',
      invocation(readEffect, {
        ...baseOperation,
        binding: { ...baseOperation.binding, mode: 'unknown' as any }
      }),
      'INVALID_INVOCATION'
    )

    write(wrapperRelativePath, `${wrapperContent}# changed\n`, 0o700)
    await expectBlocked('changed wrapper digest', invocation(), 'ARTIFACT_HASH_MISMATCH')
    write(wrapperRelativePath, wrapperContent, 0o700)

    fs.truncateSync(
      path.join(root, wrapperRelativePath),
      N8N_WORKFLOW_MIGRATION_EXECUTOR_LIMITS.maxWrapperBytes + 1
    )
    await expectBlocked('oversized wrapper', invocation(), 'ARTIFACT_INVALID')
    write(wrapperRelativePath, wrapperContent, 0o700)

    write(candidateRelativePath, `${candidateContent}\n`)
    await expectBlocked('changed candidate digest', invocation(), 'ARTIFACT_HASH_MISMATCH')
    write(candidateRelativePath, candidateContent)

    const mismatchedManifest = { ...manifest, workflow: { ...manifest.workflow, id: 'wrong-workflow' } }
    const mismatchedManifestContent = JSON.stringify(mismatchedManifest)
    write(manifestRelativePath, mismatchedManifestContent)
    await expectBlocked(
      'manifest content mismatch',
      invocation(readEffect, {
        ...baseOperation,
        binding: { ...baseOperation.binding, manifestSha256: sha256Text(mismatchedManifestContent) }
      }),
      'MANIFEST_BINDING_MISMATCH'
    )
    write(manifestRelativePath, manifestContent)

    await expectBlocked(
      'artifact path mismatch',
      invocation({ ...candidateEffect, artifactPath: rollbackRelativePath }),
      'EFFECT_NOT_LEGAL'
    )
    await expectBlocked(
      'artifact hash mismatch',
      invocation({ ...candidateEffect, artifactSha256: hash('9') }),
      'EFFECT_NOT_LEGAL'
    )

    for (const [field, value] of [
      ['executable', 'sh'],
      ['argv', ['anything']],
      ['shell', true],
      ['environment', { PATH: '/tmp' }]
    ] as const) {
      await expectBlocked(
        `caller ${field} rejected`,
        { ...invocation(), [field]: value },
        'CALLER_PROCESS_CONFIGURATION_REJECTED'
      )
    }
    await expectBlocked(
      'effect process field rejected',
      invocation({ ...readEffect, env: { PATH: '/tmp' } }),
      'CALLER_PROCESS_CONFIGURATION_REJECTED'
    )
    await expectBlocked(
      'nested operation process field rejected',
      invocation(readEffect, {
        ...baseOperation,
        evidence: {
          ...baseOperation.evidence,
          nested: [{ environment: { PATH: '/tmp' } }]
        }
      } as any),
      'CALLER_PROCESS_CONFIGURATION_REJECTED'
    )
    const untrustedEvidenceMarker = ['untrusted', 'evidence', 'marker'].join('-')
    result = await createExecutor()({
      ...invocation(),
      [untrustedEvidenceMarker]: true,
      operation: { ...baseOperation, operationId: untrustedEvidenceMarker }
    })
    assert.equal(result.reasonCode, 'INVALID_INVOCATION')
    assert.equal(result.operationId, 'unknown')
    assert.equal(result.workflowId, 'unknown')
    assert.equal(JSON.stringify(result).includes(untrustedEvidenceMarker), false)
    const oversizedOperationId = 'o'.repeat(201)
    result = await createExecutor()(invocation(
      { ...readEffect, operationId: oversizedOperationId },
      { ...baseOperation, operationId: oversizedOperationId }
    ))
    assert.equal(result.reasonCode, 'INVALID_INVOCATION')
    assert.equal(result.operationId, 'unknown')
    assert.equal(JSON.stringify(result).includes(oversizedOperationId), false)
    await expectBlocked(
      'unknown effect rejected',
      invocation({ type: 'delete_workflow', operationId, workflowId }),
      'EFFECT_NOT_SUPPORTED'
    )
    for (const inheritedType of ['__proto__', 'constructor', 'toString']) {
      await expectBlocked(
        `inherited effect type ${inheritedType} rejected`,
        invocation({ type: inheritedType, operationId, workflowId }),
        'EFFECT_NOT_SUPPORTED'
      )
    }
    await expectBlocked(
      'prototype-inherited effect rejected',
      invocation(Object.create(readEffect)),
      'EFFECT_NOT_SUPPORTED'
    )
    await expectBlocked(
      'prototype-inherited invocation rejected',
      Object.create(invocation()),
      'INVALID_INVOCATION'
    )

    await expectBlocked('candidate needs a reservation', invocation(candidateEffect), 'MUTATION_DISPATCH_NOT_RESERVED')
    await expectBlocked(
      'second candidate mutation rejected',
      invocation(candidateEffect, { ...baseOperation, candidateUpdateRequests: 1 }),
      'MUTATION_DISPATCH_NOT_RESERVED'
    )
    const rollbackOperation: ControlledWorkflowMigrationOperation = {
      ...baseOperation,
      binding: { ...baseOperation.binding, mode: 'rollback' }
    }
    await expectBlocked('rollback needs a reservation', invocation(rollbackEffect, rollbackOperation), 'MUTATION_DISPATCH_NOT_RESERVED')
    await expectBlocked(
      'standalone rollback cannot claim automatic mode',
      invocation({ ...rollbackEffect, automatic: true }, rollbackOperation),
      'EFFECT_NOT_LEGAL'
    )
    await expectBlocked(
      'automatic rollback requires rolling-back apply state',
      invocation({ ...rollbackEffect, automatic: true }, baseOperation),
      'EFFECT_NOT_LEGAL'
    )
    await expectBlocked(
      'automatic rollback command unproven',
      invocation(
        { ...rollbackEffect, automatic: true },
        { ...baseOperation, status: 'rolling_back' }
      ),
      'MUTATION_DISPATCH_NOT_RESERVED'
    )
    await expectBlocked(
      'second rollback mutation rejected',
      invocation(rollbackEffect, { ...rollbackOperation, rollbackUpdateRequests: 1 }),
      'MUTATION_DISPATCH_NOT_RESERVED'
    )

    processSpecifications.length = 0
    nextProcessResult = {
      outcome: 'succeeded', exitCode: 0, signal: null,
      stdout: JSON.stringify({ contractVersion: 1, workflowId, classification: 'succeeded' }), stderr: '',
      stdoutTruncated: false, stderrTruncated: false
    }
    const mutationResult = await createExecutor({
      consumeMutationDispatch: () => ({ ok: true as const }),
      loadRuntimeConfiguration: runtimeConfiguration
    })(invocation(
      candidateEffect,
      { ...baseOperation, candidateUpdateRequests: 1 }
    ))
    assert.equal(mutationResult.classification, 'succeeded')
    assert.equal(processSpecifications.length, 1)
    assert.deepEqual(processSpecifications[0].args, ['update-workflow', workflowId, '-'])
    assert.equal(processSpecifications[0].shell, false)
    assert.equal(processSpecifications[0].stdin, candidateContent)
    assert.equal(processSpecifications[0].env.N8N_API_URL, runtimeApiUrl)
    assert.equal(processSpecifications[0].env.N8N_API_KEY, runtimeApiKey)
    assert.equal(JSON.stringify(mutationResult).includes(runtimeApiKey), false)
    const replayBlocked = await createExecutor({ consumeMutationDispatch: () => ({ ok: false as const, code: 'MUTATION_DISPATCH_REPLAYED' }) })(invocation(
      candidateEffect,
      { ...baseOperation, candidateUpdateRequests: 1 }
    ))
    assert.equal(replayBlocked.reasonCode, 'MUTATION_DISPATCH_REPLAYED')
    assert.equal(processSpecifications.length, 1)

    nextProcessResult = {
      outcome: 'definitively_failed', exitCode: 7, signal: null,
      stdout: 'bounded failure', stderr: 'bounded failure',
      stdoutTruncated: false, stderrTruncated: false
    }
    result = await createExecutor()(invocation())
    assert.equal(result.classification, 'definitively_failed')
    assert.equal(result.reasonCode, 'PROCESS_DEFINITIVE_FAILURE')
    assert.equal(result.exitCode, 7)
    assert.equal(result.operationId, operationId)
    assert.equal(result.workflowId, workflowId)
    const definitiveFailureEvent = toControlledWorkflowMigrationEvent(result, '2026-07-14T10:30:00.000Z')
    assert.equal(definitiveFailureEvent.type, 'precondition_readback')
    if (definitiveFailureEvent.type !== 'precondition_readback') throw new Error('expected precondition readback event')
    assert.equal(definitiveFailureEvent.executorClassification, 'definitively_failed')
    assert.equal(definitiveFailureEvent.executorReasonCode, 'PROCESS_DEFINITIVE_FAILURE')
    assert.equal(definitiveFailureEvent.executorExitCode, 7)
    assert.equal(definitiveFailureEvent.executorOperationId, operationId)
    assert.equal(definitiveFailureEvent.executorWorkflowId, workflowId)
    const definitiveFailureTransition = advanceControlledWorkflowMigration({ operation: baseOperation, event: definitiveFailureEvent })
    assert.equal(definitiveFailureTransition.reasonCode, 'PRECONDITION_UNAVAILABLE')
    assert.equal(definitiveFailureTransition.operation.evidence?.executorReasonCode, 'PROCESS_DEFINITIVE_FAILURE')
    assert.equal(definitiveFailureTransition.operation.evidence?.executorExitCode, 7)
    assert.equal(JSON.stringify(result).includes('bounded failure'), false)

    nextProcessResult = {
      outcome: 'ambiguous', exitCode: null, signal: 'SIGTERM',
      stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false
    }
    result = await createExecutor()(invocation())
    assert.equal(result.classification, 'ambiguous')
    assert.equal(result.reasonCode, 'PROCESS_AMBIGUOUS')

    nextProcessResult = {
      outcome: 'timed_out', exitCode: null, signal: 'SIGKILL',
      stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false
    }
    result = await createExecutor()(invocation())
    assert.equal(result.classification, 'timed_out')
    assert.equal(result.reasonCode, 'PROCESS_TIMED_OUT')
    const timeoutSpec = processSpecifications.at(-1)
    assert.equal(timeoutSpec.terminateProcessTree, true)
    assert.equal(timeoutSpec.terminationGraceMs, N8N_WORKFLOW_MIGRATION_EXECUTOR_LIMITS.terminationGraceMs)

    nextProcessResult = {
      outcome: 'definitively_failed', exitCode: null, signal: 'SIGTERM',
      stdout: 'x'.repeat(N8N_WORKFLOW_MIGRATION_EXECUTOR_LIMITS.maxStdoutBytes + 100),
      stderr: 'y'.repeat(N8N_WORKFLOW_MIGRATION_EXECUTOR_LIMITS.maxStderrBytes + 100),
      stdoutTruncated: true, stderrTruncated: true
    }
    result = await createExecutor()(invocation())
    assert.equal(result.reasonCode, 'PROCESS_OUTPUT_TRUNCATED')
    assert.equal(result.outputTruncated, true)
    assert.ok(result.stdoutBytes <= N8N_WORKFLOW_MIGRATION_EXECUTOR_LIMITS.maxStdoutBytes)
    assert.ok(result.stderrBytes <= N8N_WORKFLOW_MIGRATION_EXECUTOR_LIMITS.maxStderrBytes)

    nextProcessResult = {
      outcome: 'succeeded', exitCode: 0, signal: null,
      stdout: JSON.stringify(preMutationWorkflow),
      stderr: 'z'.repeat(N8N_WORKFLOW_MIGRATION_EXECUTOR_LIMITS.maxStderrBytes + 1),
      stdoutTruncated: false, stderrTruncated: false
    }
    result = await createExecutor()(invocation())
    assert.equal(result.reasonCode, 'PROCESS_OUTPUT_TRUNCATED')
    assert.equal(result.outputTruncated, true)

    nextProcessResult = {
      outcome: 'succeeded', exitCode: 0, signal: null,
      stdout: '{malformed', stderr: '', stdoutTruncated: false, stderrTruncated: false
    }
    result = await createExecutor()(invocation())
    assert.equal(result.classification, 'definitively_failed')
    assert.equal(result.reasonCode, 'MALFORMED_RESPONSE')

    nextProcessResult = {
      outcome: 'succeeded', exitCode: 0, signal: null,
      stdout: JSON.stringify({ ...preMutationWorkflow, id: 'wrong-workflow' }),
      stderr: '', stdoutTruncated: false, stderrTruncated: false
    }
    result = await createExecutor()(invocation())
    assert.equal(result.reasonCode, 'RESPONSE_WORKFLOW_ID_MISMATCH')

    nextProcessResult = {
      outcome: 'succeeded', exitCode: 0, signal: null,
      stdout: JSON.stringify({ ...preMutationWorkflow, active: true }),
      stderr: '', stdoutTruncated: false, stderrTruncated: false
    }
    result = await createExecutor()(invocation())
    assert.equal(result.classification, 'definitively_failed')
    assert.equal(result.reasonCode, 'PROTECTED_DOMAIN_MISMATCH')
    assert.equal(result.observedCanonicalSha256, undefined)
    assert.equal(result.protectedDomains, 'unverified')
    assert.deepEqual(result.protectedDomainMismatches, ['activation'])
    const protectedMismatchEvent = toControlledWorkflowMigrationEvent(
      result,
      '2026-07-14T11:00:30.000Z'
    )
    assert.equal(protectedMismatchEvent.type, 'precondition_readback')
    assert.equal(
      protectedMismatchEvent.type === 'precondition_readback'
        ? protectedMismatchEvent.protectedDomains
        : undefined,
      'unverified'
    )
    assert.deepEqual(
      protectedMismatchEvent.type === 'precondition_readback'
        ? protectedMismatchEvent.protectedDomainMismatches
        : undefined,
      ['activation']
    )
    const protectedMismatchTransition = advanceControlledWorkflowMigration({
      operation: baseOperation,
      event: protectedMismatchEvent
    })
    assert.equal(
      projectControlledWorkflowMigrationStatus(protectedMismatchTransition.operation).protectedDomains,
      'unverified'
    )
    assert.deepEqual(
      projectControlledWorkflowMigrationStatus(protectedMismatchTransition.operation).protectedDomainMismatches,
      ['activation']
    )

    const privateSettingValue = 'private-setting-value'
    nextProcessResult = {
      outcome: 'succeeded', exitCode: 0, signal: null,
      stdout: JSON.stringify({
        ...preMutationWorkflow,
        active: true,
        settings: { executionOrder: privateSettingValue },
        tags: [{ id: 'tag-1', name: 'private-tag-name' }]
      }),
      stderr: '', stdoutTruncated: false, stderrTruncated: false
    }
    result = await createExecutor()(invocation())
    assert.equal(result.reasonCode, 'PROTECTED_DOMAIN_MISMATCH')
    assert.deepEqual(result.protectedDomainMismatches, ['activation', 'settings', 'tags'])
    assert.equal(JSON.stringify(result).includes(privateSettingValue), false)

    const versionTwoCandidate = {
      ...candidateWorkflow,
      shared: [{
        workflowId,
        projectId: 'project-1',
        role: 'workflow:owner',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        project: { id: 'project-1', name: 'Candidate project label', type: 'personal' }
      }]
    }
    const versionTwoRollback = {
      ...rollbackWorkflow,
      shared: [{
        workflowId,
        projectId: 'project-1',
        role: 'workflow:owner',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
        project: { id: 'project-1', name: 'Rollback project label', type: 'team' }
      }]
    }
    const versionTwoLive = {
      ...preMutationWorkflow,
      shared: [{
        workflowId,
        projectId: 'project-1',
        role: 'workflow:owner',
        createdAt: '2026-07-14T10:59:00.000Z',
        updatedAt: '2026-07-14T10:59:30.000Z',
        project: { id: 'project-1', name: 'Live project label', type: 'team' },
        projectRelations: [{ projectId: 'project-1', userId: 'user-1', role: 'project:admin' }]
      }]
    }
    const versionTwoCandidateContent = JSON.stringify(versionTwoCandidate)
    const versionTwoRollbackContent = JSON.stringify(versionTwoRollback)
    const versionTwoManifest: ControlledWorkflowTopologyManifest = {
      ...manifest,
      workflow: {
        id: workflowId,
        canonicalizationVersion: 2,
        expectedLiveCanonicalSha256: canonicalHash(versionTwoLive, 2),
        candidateCanonicalSha256: canonicalHash(versionTwoCandidate, 2),
        rollbackCanonicalSha256: canonicalHash(versionTwoRollback, 2)
      },
      artifacts: {
        candidatePath: candidateRelativePath,
        candidateSha256: sha256Text(versionTwoCandidateContent),
        rollbackPath: rollbackRelativePath,
        rollbackSha256: sha256Text(versionTwoRollbackContent)
      }
    }
    const versionTwoManifestContent = JSON.stringify(versionTwoManifest)
    write(candidateRelativePath, versionTwoCandidateContent)
    write(rollbackRelativePath, versionTwoRollbackContent)
    write(manifestRelativePath, versionTwoManifestContent)
    const versionTwoGrant: ControlledN8nWorkflowGrant = {
      ...grant,
      canonicalizationVersion: 2
    }
    const versionTwoOperation: ControlledWorkflowMigrationOperation = {
      ...baseOperation,
      operationId: 'operation-v2-sharing',
      binding: {
        ...baseOperation.binding,
        canonicalizationVersion: 2,
        candidateSha256: versionTwoManifest.artifacts.candidateSha256,
        rollbackSha256: versionTwoManifest.artifacts.rollbackSha256,
        manifestSha256: sha256Text(versionTwoManifestContent),
        candidateCanonicalSha256: versionTwoManifest.workflow.candidateCanonicalSha256,
        rollbackCanonicalSha256: versionTwoManifest.workflow.rollbackCanonicalSha256,
        expectedLiveCanonicalSha256: versionTwoManifest.workflow.expectedLiveCanonicalSha256
      }
    }
    const versionTwoReadEffect = {
      ...readEffect,
      operationId: versionTwoOperation.operationId,
      expectedLiveCanonicalSha256: versionTwoManifest.workflow.expectedLiveCanonicalSha256
    }
    nextProcessResult = {
      outcome: 'succeeded', exitCode: 0, signal: null,
      stdout: JSON.stringify(versionTwoLive), stderr: '',
      stdoutTruncated: false, stderrTruncated: false
    }
    const beforeVersionTwoRead = processSpecifications.length
    result = await createExecutor()(invocation(versionTwoReadEffect, versionTwoOperation, versionTwoGrant))
    assert.equal(result.classification, 'succeeded')
    assert.equal(result.reasonCode, 'READ_SUCCEEDED')
    assert.equal(result.protectedDomains, 'unchanged')
    assert.equal(result.protectedDomainMismatches, undefined)
    assert.equal(processSpecifications.length, beforeVersionTwoRead + 1)

    nextProcessResult = {
      outcome: 'succeeded', exitCode: 0, signal: null,
      stdout: JSON.stringify({
        ...versionTwoLive,
        shared: [{ ...versionTwoLive.shared[0], role: 'workflow:editor' }]
      }),
      stderr: '', stdoutTruncated: false, stderrTruncated: false
    }
    const beforeVersionTwoMismatch = processSpecifications.length
    result = await createExecutor()(invocation(versionTwoReadEffect, versionTwoOperation, versionTwoGrant))
    assert.equal(result.classification, 'definitively_failed')
    assert.equal(result.reasonCode, 'PROTECTED_DOMAIN_MISMATCH')
    assert.deepEqual(result.protectedDomainMismatches, ['sharing'])
    assert.equal(result.observedCanonicalSha256, undefined)
    assert.equal(JSON.stringify(result).includes('workflow:editor'), false)
    assert.equal(processSpecifications.length, beforeVersionTwoMismatch + 1)
    const versionTwoMismatchSpec = processSpecifications.at(-1)
    assert.deepEqual(versionTwoMismatchSpec.args, ['get-workflow', workflowId])
    assert.equal(versionTwoMismatchSpec.mayMutate, false)
    assert.equal(versionTwoOperation.candidateUpdateRequests, 0)
    assert.equal(versionTwoOperation.rollbackUpdateRequests, 0)
    write(candidateRelativePath, candidateContent)
    write(rollbackRelativePath, rollbackContent)
    write(manifestRelativePath, manifestContent)

    nextProcessResult = {
      outcome: 'succeeded', exitCode: 0, signal: null,
      stdout: JSON.stringify({ ...preMutationWorkflow, [['api', 'Key'].join('')]: 'fixture-sensitive-value' }),
      stderr: '', stdoutTruncated: false, stderrTruncated: false
    }
    result = await createExecutor()(invocation())
    assert.equal(result.reasonCode, 'CREDENTIAL_MATERIAL_DETECTED')
    assert.equal(JSON.stringify(result).includes('fixture-sensitive-value'), false)

    const credentialFieldNames = [
      ['access', 'token'].join('_'),
      ['refresh', 'token'].join('-'),
      ['client', 'Secret'].join(''),
      ['api', 'key'].join('_'),
      ['PASS', 'WORD'].join(''),
      ['auth', 'Token'].join(''),
      ['to', 'ken'].join('')
    ]
    for (const [index, field] of credentialFieldNames.entries()) {
      const marker = `fixture-sensitive-${index}-value`
      nextProcessResult = {
        outcome: 'succeeded', exitCode: 0, signal: null,
        stdout: JSON.stringify({ ...preMutationWorkflow, metadata: { [field]: marker } }),
        stderr: '', stdoutTruncated: false, stderrTruncated: false
      }
      result = await createExecutor()(invocation())
      assert.equal(result.reasonCode, 'CREDENTIAL_MATERIAL_DETECTED', `JSON credential field ${field}`)
      assert.equal(JSON.stringify(result).includes(marker), false)

      nextProcessResult = {
        outcome: 'succeeded', exitCode: 0, signal: null,
        stdout: JSON.stringify(preMutationWorkflow),
        stderr: `${field.toUpperCase()}=${marker}`,
        stdoutTruncated: false, stderrTruncated: false
      }
      result = await createExecutor()(invocation())
      assert.equal(result.reasonCode, 'CREDENTIAL_MATERIAL_DETECTED', `environment credential field ${field}`)
      assert.equal(JSON.stringify(result).includes(marker), false)
    }

    nextProcessResult = {
      outcome: 'succeeded', exitCode: 0, signal: null,
      stdout: JSON.stringify({ ...preMutationWorkflow, note: 'configured-value-sentinel' }),
      stderr: '', stdoutTruncated: false, stderrTruncated: false
    }
    result = await createExecutor({ readConfiguredCredentialValues: () => ['configured-value-sentinel'] })(invocation())
    assert.equal(result.reasonCode, 'CREDENTIAL_MATERIAL_DETECTED')
    assert.equal(JSON.stringify(result).includes('configured-value-sentinel'), false)

    await expectBlocked(
      'configured credential source failure',
      invocation(),
      'CREDENTIAL_SOURCE_UNAVAILABLE',
      createExecutor({ readConfiguredCredentialValues: () => { throw new Error('private fixture failure') } })
    )

    nextProcessResult = {
      outcome: 'succeeded', exitCode: 0, signal: null,
      stdout: JSON.stringify(preMutationWorkflow),
      stderr: `${['Author', 'ization'].join('')}: Bearer fixture-value-12345`,
      stdoutTruncated: false, stderrTruncated: false
    }
    result = await createExecutor()(invocation())
    assert.equal(result.reasonCode, 'CREDENTIAL_MATERIAL_DETECTED')
    assert.equal(JSON.stringify(result).includes('fixture-value-12345'), false)

    nextProcessResult = {
      outcome: 'succeeded', exitCode: 0, signal: null,
      stdout: JSON.stringify({
        ...preMutationWorkflow,
        metadata: { [["author", "ization"].join('')]: 'Basic fixture-value-67890' }
      }),
      stderr: '', stdoutTruncated: false, stderrTruncated: false
    }
    result = await createExecutor()(invocation())
    assert.equal(result.reasonCode, 'CREDENTIAL_MATERIAL_DETECTED')
    assert.equal(JSON.stringify(result).includes('fixture-value-67890'), false)

    nextProcessResult = {
      outcome: 'succeeded', exitCode: 0, signal: null,
      stdout: JSON.stringify(candidateWorkflow), stderr: '',
      stdoutTruncated: false, stderrTruncated: false
    }
    const reconcilingOperation: ControlledWorkflowMigrationOperation = {
      ...baseOperation,
      status: 'reconciling',
      candidateUpdateRequests: 1
    }
    const readbackEffect = {
      type: 'readback_workflow' as const,
      operationId,
      workflowId,
      expected: 'candidate' as const
    }
    await expectBlocked(
      'rolling-back readback must expect rollback',
      invocation(readbackEffect, { ...reconcilingOperation, status: 'rolling_back' }),
      'EFFECT_NOT_LEGAL'
    )
    await expectBlocked(
      'reconciling readback without successful rollback evidence must not expect rollback',
      invocation({ ...readbackEffect, expected: 'rollback' }, reconcilingOperation),
      'EFFECT_NOT_LEGAL'
    )
    await expectBlocked(
      'rollback reconciliation must request approved state',
      invocation(readbackEffect, {
        ...reconcilingOperation,
        binding: { ...reconcilingOperation.binding, mode: 'rollback' },
        candidateUpdateRequests: 0,
        rollbackUpdateRequests: 1
      }),
      'EFFECT_NOT_LEGAL'
    )
    result = await createExecutor()(invocation(readbackEffect, reconcilingOperation))
    assert.equal(result.classification, 'succeeded')
    assert.equal(result.readbackResult, 'matches_candidate')
    const readbackEvent = toControlledWorkflowMigrationEvent(result, '2026-07-14T11:01:00.000Z')
    const completed = advanceControlledWorkflowMigration({ operation: reconcilingOperation, event: readbackEvent })
    assert.equal(completed.operation.status, 'completed')

    const recoveredRollbackOperation: ControlledWorkflowMigrationOperation = {
      ...reconcilingOperation,
      rollbackUpdateRequests: 1,
      evidence: { protectedDomains: 'unchanged', rollbackResult: 'succeeded' }
    }
    const recoveredRollbackEffect = { ...readbackEffect, expected: 'rollback' as const }
    nextProcessResult = {
      outcome: 'succeeded', exitCode: 0, signal: null,
      stdout: JSON.stringify(rollbackWorkflow), stderr: '',
      stdoutTruncated: false, stderrTruncated: false
    }
    result = await createExecutor()(invocation(recoveredRollbackEffect, recoveredRollbackOperation))
    assert.equal(result.classification, 'succeeded')
    assert.equal(result.readbackResult, 'matches_rollback')
    const recoveredRollbackEvent = toControlledWorkflowMigrationEvent(result, '2026-07-14T11:02:00.000Z')
    const recoveredRollbackTerminal = advanceControlledWorkflowMigration({ operation: recoveredRollbackOperation, event: recoveredRollbackEvent })
    assert.equal(recoveredRollbackTerminal.operation.status, 'rolled_back')

    nextProcessResult = {
      outcome: 'succeeded', exitCode: 0, signal: null,
      stdout: JSON.stringify(unexpectedWorkflow), stderr: '',
      stdoutTruncated: false, stderrTruncated: false
    }
    result = await createExecutor()(invocation(recoveredRollbackEffect, recoveredRollbackOperation))
    assert.equal(result.classification, 'succeeded')
    assert.equal(result.readbackResult, 'unexpected_state')
    const recoveredRollbackMismatchEvent = toControlledWorkflowMigrationEvent(result, '2026-07-14T11:03:00.000Z')
    const recoveredRollbackMismatch = advanceControlledWorkflowMigration({ operation: recoveredRollbackOperation, event: recoveredRollbackMismatchEvent })
    assert.equal(recoveredRollbackMismatch.operation.status, 'manual_intervention_required')

    const equalCandidateContent = rollbackContent
    const equalManifest: ControlledWorkflowTopologyManifest = {
      ...manifest,
      workflow: {
        ...manifest.workflow,
        candidateCanonicalSha256: manifest.workflow.rollbackCanonicalSha256
      },
      artifacts: {
        ...manifest.artifacts,
        candidateSha256: sha256Text(equalCandidateContent)
      }
    }
    const equalManifestContent = JSON.stringify(equalManifest)
    write(candidateRelativePath, equalCandidateContent)
    write(manifestRelativePath, equalManifestContent)
    const equalRollbackOperation: ControlledWorkflowMigrationOperation = {
      ...reconcilingOperation,
      binding: {
        ...reconcilingOperation.binding,
        mode: 'rollback',
        candidateSha256: equalManifest.artifacts.candidateSha256,
        candidateCanonicalSha256: equalManifest.workflow.candidateCanonicalSha256,
        manifestSha256: sha256Text(equalManifestContent)
      },
      candidateUpdateRequests: 0,
      rollbackUpdateRequests: 1
    }
    nextProcessResult = {
      outcome: 'succeeded', exitCode: 0, signal: null,
      stdout: JSON.stringify(rollbackWorkflow), stderr: '',
      stdoutTruncated: false, stderrTruncated: false
    }
    result = await createExecutor()(invocation(
      { ...readbackEffect, expected: 'approved_state' },
      equalRollbackOperation
    ))
    assert.equal(result.readbackResult, 'matches_rollback')
    result = await createExecutor()(invocation(
      { ...readEffect, purpose: 'reconciliation' },
      equalRollbackOperation
    ))
    assert.equal(result.readbackResult, 'matches_rollback')
    write(candidateRelativePath, candidateContent)
    write(manifestRelativePath, manifestContent)

    nextProcessResult = {
      outcome: 'succeeded', exitCode: 0, signal: null,
      stdout: JSON.stringify(unexpectedWorkflow), stderr: '',
      stdoutTruncated: false, stderrTruncated: false
    }
    result = await createExecutor()(invocation(readbackEffect, reconcilingOperation))
    assert.equal(result.readbackResult, 'unexpected_state')

    nextProcessResult = {
      outcome: 'succeeded', exitCode: 0, signal: null,
      stdout: JSON.stringify(preMutationWorkflow), stderr: '',
      stdoutTruncated: false, stderrTruncated: false
    }
    const preconditionResult = await createExecutor()(invocation())
    assert.equal(preconditionResult.protectedDomains, 'unchanged')
    assert.equal(preconditionResult.protectedDomainMismatches, undefined)
    const preconditionEvent = toControlledWorkflowMigrationEvent(preconditionResult, '2026-07-14T11:01:00.000Z')
    const mutationRequested = advanceControlledWorkflowMigration({ operation: baseOperation, event: preconditionEvent })
    assert.equal(mutationRequested.operation.candidateUpdateRequests, 0)
    assert.deepEqual(mutationRequested.effects.map(effect => effect.type), ['persist_operation', 'reserve_candidate_dispatch'])
    const reservedCandidate = advanceControlledWorkflowMigration({ operation: mutationRequested.operation, event: { type: 'candidate_dispatch_reserved', result: 'reserved', at: '2026-07-14T11:01:10.000Z' } })
    assert.equal(reservedCandidate.operation.candidateUpdateRequests, 1)
    const emittedCandidateEffect = reservedCandidate.effects.find(effect => effect.type === 'apply_candidate')
    assert.ok(emittedCandidateEffect && emittedCandidateEffect.type === 'apply_candidate')
    const beforeBlockedHandoff = processSpecifications.length
    const blockedMutationHandoff = await createExecutor()(invocation(
      emittedCandidateEffect,
      reservedCandidate.operation
    ))
    assert.equal(blockedMutationHandoff.reasonCode, 'MUTATION_DISPATCH_NOT_RESERVED')
    assert.equal(processSpecifications.length, beforeBlockedHandoff)
    const blockedMutationEvent = toControlledWorkflowMigrationEvent(
      blockedMutationHandoff,
      '2026-07-14T11:01:15.000Z'
    )
    const blockedMutationTransition = advanceControlledWorkflowMigration({
      operation: reservedCandidate.operation,
      event: blockedMutationEvent
    })
    assert.equal(blockedMutationTransition.operation.status, 'failed')
    assert.deepEqual(
      blockedMutationTransition.effects.map(effect => effect.type),
      ['persist_operation', 'release_lease']
    )

    const blockedPrecondition = await createExecutor({ sourceId: 'wrong-source' })(invocation())
    const blockedPreconditionEvent = toControlledWorkflowMigrationEvent(
      blockedPrecondition,
      '2026-07-14T11:01:30.000Z'
    )
    assert.equal(blockedPreconditionEvent.type, 'precondition_readback')
    if (blockedPreconditionEvent.type !== 'precondition_readback') throw new Error('expected precondition readback event')
    assert.equal(blockedPreconditionEvent.executorClassification, 'blocked')
    assert.equal(blockedPreconditionEvent.executorReasonCode, 'SOURCE_ID_MISMATCH')
    assert.equal(blockedPreconditionEvent.executorExitCode, null)
    assert.equal(blockedPreconditionEvent.readPurpose, 'precondition')
    assert.equal(blockedPreconditionEvent.executorOperationId, undefined)
    assert.equal(blockedPreconditionEvent.executorWorkflowId, undefined)
    const blockedPreconditionTransition = advanceControlledWorkflowMigration({
      operation: baseOperation,
      event: blockedPreconditionEvent
    })
    assert.equal(blockedPreconditionTransition.operation.status, 'failed')
    assert.equal(blockedPreconditionTransition.reasonCode, 'PRECONDITION_UNAVAILABLE')
    assert.equal(blockedPreconditionTransition.operation.reasonCode, 'PRECONDITION_UNAVAILABLE')
    assert.equal(blockedPreconditionTransition.operation.evidence?.executorClassification, 'blocked')
    assert.equal(blockedPreconditionTransition.operation.evidence?.executorReasonCode, 'SOURCE_ID_MISMATCH')
    assert.equal(blockedPreconditionTransition.operation.evidence?.executorExitCode, null)
    assert.equal(blockedPreconditionTransition.operation.evidence?.readPurpose, 'precondition')
    assert.equal(blockedPreconditionTransition.operation.evidence?.executorOperationId, undefined)
    assert.equal(blockedPreconditionTransition.operation.evidence?.executorWorkflowId, undefined)
    assert.deepEqual(
      blockedPreconditionTransition.effects.map(effect => effect.type),
      ['persist_operation', 'release_lease']
    )

    const ambiguousEvidence: N8nWorkflowMigrationExecutorResult = {
      effect: 'apply_candidate',
      classification: 'ambiguous',
      workflowId,
      operationId,
      durationMs: 10,
      stdoutBytes: 0,
      stderrBytes: 0,
      outputTruncated: false,
      responseParsed: false,
      reasonCode: 'PROCESS_AMBIGUOUS',
      reason: 'The host cannot prove the fixed wrapper process outcome.',
      issues: []
    }
    const ambiguousEvent = toControlledWorkflowMigrationEvent(ambiguousEvidence, '2026-07-14T11:02:00.000Z')
    const reconciliation = advanceControlledWorkflowMigration({
      operation: reservedCandidate.operation,
      event: ambiguousEvent
    })
    assert.equal(reconciliation.operation.status, 'reconciling')
    assert.deepEqual(reconciliation.effects.map(effect => effect.type), ['persist_operation', 'readback_workflow'])
    assert.equal(reconciliation.effects.some(effect => effect.type === 'apply_candidate'), false)

    const executorSource = fs.readFileSync(path.resolve('packages/cli/src/agent/n8n-workflow-migration-executor.ts'), 'utf8')
    assert.ok(executorSource.includes("args: ['get-workflow', invocation.operation.binding.workflowId]"))
    assert.ok(executorSource.includes('N8N_WORKFLOW_MIGRATION_EXECUTOR_LIMITS.maxWrapperBytes'))
    assert.ok(executorSource.includes(').sha256 !== specification.executableSha256'))
    assert.ok(executorSource.includes('fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK'))
    assert.equal(executorSource.includes('readBoundedUtf8'), false)
    assert.ok(executorSource.includes('shell: false'))
    assert.ok(executorSource.includes("signalProcessTree('SIGTERM')"))
    assert.ok(executorSource.includes("signalProcessTree('SIGKILL')"))
    assert.ok(executorSource.includes('if (terminationStarted) return'))
    assert.ok(executorSource.includes("args: ['update-workflow', invocation.operation.binding.workflowId, '-']"))
    assert.equal(executorSource.includes('curl '), false)

    const commandRunnerSource = fs.readFileSync(path.resolve('packages/cli/src/agent/command-runner.ts'), 'utf8')
    const runRequestSource = fs.readFileSync(path.resolve('packages/cli/src/agent/run-command-request.ts'), 'utf8')
    const migrationAdapterSource = fs.readFileSync(path.resolve('packages/cli/src/agent/n8n-workflow-migration-command-adapter.ts'), 'utf8')
    assert.equal(commandRunnerSource.includes('n8n-workflow-migration-executor'), false)
    assert.equal(runRequestSource.includes('migrationCapabilityUnavailable'), false)
    assert.ok(migrationAdapterSource.includes('createNodeN8nWorkflowMigrationExecutor'))
    assert.equal(migrationAdapterSource.includes('update-workflow'), false)
    assert.equal(migrationAdapterSource.includes('spawn('), false)

    console.log('n8n workflow migration executor verification passed')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch(error => {
  fs.rmSync(root, { recursive: true, force: true })
  console.error(error)
  process.exit(1)
})
