import {
  cancelCapabilityJob,
  findCapabilityJobByIdempotency,
  getCapabilityJob,
  listCapabilityJobProjections,
  retrieveCapabilityArtifact,
  submitCapabilityJob,
  type CapabilityJobLookup,
  type CapabilityJobProjection,
  type CapabilityJobRequest,
  type CapabilityJobSubmitResult,
  type ExecutionCoordinatorOptions,
  type ExecutionRecord,
  type CapabilityJobExecution
} from './capability-execution-coordinator.js'
import { cleanupBrokerOwnedOutputRoot, createBrokerOwnedOutputRoot } from './capability-output-artifact.js'
import type { CapabilityArtifactRetrieval } from './capability-execution-coordinator.js'
import { CapabilityRegistry, type CapabilityRegistryInspection, type CapabilityRegistryListItem, type CapabilityRegistryResult } from './capability-registry.js'
import { authorizeCapabilityExecution, type CapabilityPhase16Context, type CapabilityRuntimeContext } from './capability-runtime-enforcement.js'

export type CapabilityBrokerOptions = Pick<ExecutionCoordinatorOptions, 'rootDir' | 'now' | 'artifactRetentionMs'> & {
  phase16?: CapabilityPhase16Context
  capabilityContext?: Omit<CapabilityRuntimeContext, 'provider' | 'validationVerifiers'>
  validationVerifiers?: CapabilityRuntimeContext['validationVerifiers']
  sourceRoots?: readonly string[]
  protectedRoots?: readonly string[]
}
export type CapabilityBrokerRunRequest = Omit<CapabilityJobRequest, 'capabilityVersion'> & {
  capabilityVersion?: string
  phase16?: CapabilityPhase16Context
  capabilityContext?: Omit<CapabilityRuntimeContext, 'provider' | 'validationVerifiers'>
}
export type CapabilityBrokerIdentity = Omit<CapabilityJobLookup, 'jobId'>
export type CapabilityBrokerFailure = { ok: false; code: string; message: string; trace?: readonly string[]; issues?: readonly { path: string; code: string; message: string }[] }
export type CapabilityBrokerResult<T> = { ok: true; value: T } | CapabilityBrokerFailure

function jobOptions(options: CapabilityBrokerOptions): ExecutionCoordinatorOptions { return { ...options, adapters: [] } }

function projectionFor(record: ExecutionRecord, options: CapabilityBrokerOptions): CapabilityBrokerResult<CapabilityJobProjection> {
  const job = record.job
  if (!job) return { ok: false, code: 'job_store_corrupt', message: 'Capability job did not contain its durable identity.' }
  return getCapabilityJob(job.jobId, { sourceId: job.sourceId, sessionId: job.sessionId, runId: job.runId, requestId: job.requestId }, jobOptions(options))
}

export class CapabilityBroker {
  readonly registryPath: string
  constructor(readonly registry: CapabilityRegistry, private readonly options: CapabilityBrokerOptions = {}) { this.registryPath = registry.storePath }

  listCapabilities(): CapabilityRegistryListItem[] { return this.registry.list() }
  inspectCapability(id: string, version?: string): CapabilityRegistryResult<CapabilityRegistryInspection> { return this.registry.inspect(id, version) }

  run(request: CapabilityBrokerRunRequest): CapabilityBrokerResult<CapabilityJobProjection> {
    const version = request.capabilityVersion
    const resolved = this.registry.resolve(request.capabilityId, version)
    if (!resolved.ok) return resolved
    const identity = {
      sourceId: request.sourceId,
      sessionId: request.sessionId,
      runId: request.runId,
      requestId: request.requestId,
      capabilityId: request.capabilityId,
      capabilityVersion: resolved.value.manifest.version,
      providerId: resolved.value.provider.providerId,
      bindingId: resolved.value.bindingId
    }
    const isolated = resolved.value.executionMode === 'isolated-output-cli'
    const configuredContext = { ...(this.options.capabilityContext ?? {}), ...(request.capabilityContext ?? {}) }
    if (isolated && Object.prototype.hasOwnProperty.call(configuredContext, 'artifactRoot')) return { ok: false, code: 'artifact_root_caller_supplied', message: 'Rejected: isolated-output execution owns its output root; callers cannot supply artifactRoot.' }
    let ownedOutput: ReturnType<typeof createBrokerOwnedOutputRoot> | undefined
    if (isolated) {
      try {
        ownedOutput = createBrokerOwnedOutputRoot({ sourceRoot: configuredContext.sourceRoot, sourceRoots: this.options.sourceRoots, protectedRoots: this.options.protectedRoots })
      } catch { return { ok: false, code: 'artifact_root_unavailable', message: 'Rejected: the broker could not create a private isolated output root.' } }
    }
    const authorization = authorizeCapabilityExecution({
      manifest: resolved.value.manifest,
      arguments: request.input ?? null,
      identity,
      phase16: request.phase16 ?? this.options.phase16,
      capability: { ...configuredContext, ...(ownedOutput ? { artifactRoot: ownedOutput.root } : {}), provider: resolved.value.provider, validationVerifiers: this.options.validationVerifiers },
      now: this.options.now,
      requestedTimeoutMs: request.timeoutMs
    })
    if (!authorization.ok) {
      if (ownedOutput) cleanupBrokerOwnedOutputRoot(ownedOutput.root)
      return { ok: false, code: authorization.code, message: authorization.message, trace: authorization.trace }
    }
    const { phase16: _phase16, capabilityContext: _capabilityContext, ...requestFields } = request
    const boundedRequest: CapabilityJobRequest = {
      ...requestFields,
      capabilityVersion: resolved.value.manifest.version,
      input: authorization.value.input,
      timeoutMs: authorization.value.timeoutMs
    }
    const prior = findCapabilityJobByIdempotency(boundedRequest, jobOptions(this.options))
    if (prior) {
      if (ownedOutput) cleanupBrokerOwnedOutputRoot(ownedOutput.root)
      return { ok: true, value: prior }
    }
    const execution: CapabilityJobExecution = { manifest: resolved.value.manifest, authorized: authorization.value, identity, validationVerifiers: this.options.validationVerifiers, ...(ownedOutput ? { artifact: ownedOutput } : {}) }
    const submitted = submitCapabilityJob(boundedRequest, resolved.value.handler, execution, jobOptions(this.options))
    if (!submitted.ok) {
      if (ownedOutput) cleanupBrokerOwnedOutputRoot(ownedOutput.root)
      return submitted
    }
    return projectionFor(submitted.value, this.options)
  }

  status(jobId: string, identity: CapabilityBrokerIdentity): CapabilityBrokerResult<CapabilityJobProjection> {
    return getCapabilityJob(jobId, identity, jobOptions(this.options))
  }

  cancel(jobId: string, identity: CapabilityBrokerIdentity, reason = 'cancelled by requesting owner'): CapabilityBrokerResult<CapabilityJobProjection> {
    return cancelCapabilityJob(jobId, identity, reason, jobOptions(this.options))
  }

  listJobs(identity?: CapabilityBrokerIdentity): CapabilityJobProjection[] { return listCapabilityJobProjections(jobOptions(this.options), identity) }

  retrieveArtifact(jobId: string, identity: CapabilityBrokerIdentity, relativePath: string, maxBytes?: number): CapabilityBrokerResult<CapabilityArtifactRetrieval> {
    return retrieveCapabilityArtifact(jobId, identity, relativePath, maxBytes, jobOptions(this.options))
  }
}

export function createCapabilityBroker(registry: CapabilityRegistry, options: CapabilityBrokerOptions = {}): CapabilityBroker { return new CapabilityBroker(registry, options) }
