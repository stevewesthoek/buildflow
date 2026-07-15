import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  advanceControlledWorkflowMigration,
  prepareControlledWorkflowMigration as decidePreparation,
  projectControlledWorkflowMigrationStatus,
  type ControlledWorkflowMigrationAdvanceDecision,
  type ControlledWorkflowMigrationEffect,
  type ControlledWorkflowMigrationEvent,
  type ControlledWorkflowMigrationMode,
  type ControlledWorkflowMigrationOperation,
  type ControlledWorkflowMigrationStatusProjection,
  parseControlledN8nWrapperContract,
  CONTROLLED_N8N_WRAPPER_CONTRACT_V1,
  validateControlledWorkflowTopologyManifest,
  canonicalizeN8nWorkflow,
  compareControlledWorkflowCandidate,
  hashCanonicalWorkflowTopology
} from '@workbench/shared'
import { findControlledN8nWorkflowGrant, type ControlledN8nWorkflowGrant } from './capability-grants'
import {
  acquireCapabilityOperationLease,
  consumeCapabilityOperationConfirmation,
  getCapabilityOperationRecord,
  persistPreparedCapabilityOperation,
  releaseCapabilityOperationLease,
  renewCapabilityOperationLease,
  transitionCapabilityOperation,
  type CapabilityOperationRecord,
  type CapabilityOperationStoreOptions,
  type CapabilityStoreFailure
} from './capability-operation-store'
import {
  createCapabilityMutationDispatchConsumer,
  findCapabilityMutationDispatchRecord,
  recordCapabilityMutationDispatchOutcome,
  requireMutationDispatchReconciliation,
  reserveCapabilityMutationDispatch,
  type CapabilityMutationDispatchStoreOptions,
  type DispatchFailure,
  type MutationDispatchKind
} from './capability-mutation-dispatch-store'
import {
  toControlledWorkflowMigrationEvent,
  type N8nWorkflowMigrationExecutorResult
} from './n8n-workflow-migration-executor'

export const N8N_WORKFLOW_MIGRATION_MAX_ITERATIONS = 16

export type ControlledMigrationSource = { sourceId: string; rootPath: string; rootFingerprint: string; enabled: boolean }
export type ControlledMigrationPrepareRequest = {
  sourceId: string; workflowId: string; mode: ControlledWorkflowMigrationMode
  candidatePath: string; rollbackPath: string; manifestPath: string
}
export type ControlledMigrationExecuteRequest = {
  sourceId: string; operationId: string; mode: ControlledWorkflowMigrationMode; confirmationToken?: string
}
export type ControlledMigrationStatusRequest = { sourceId: string; operationId: string; mode?: ControlledWorkflowMigrationMode }

export type ControlledMigrationFailureCode =
  | 'capability_not_configured' | 'grant_not_found' | 'grant_mismatch' | 'source_not_found'
  | 'artifact_invalid' | 'manifest_invalid' | 'canonicalization_failed' | 'operation_not_found'
  | 'operation_conflict' | 'confirmation_required' | 'confirmation_invalid' | 'confirmation_expired'
  | 'confirmation_replayed' | 'lease_conflict' | 'dispatch_conflict' | 'reconciliation_required'
  | 'manual_intervention_required' | 'operation_store_corrupt' | 'dispatch_store_corrupt' | 'iteration_limit'

export type ControlledMigrationFailure = { ok: false; status: 'blocked'; error: { code: ControlledMigrationFailureCode; message: string } }
export type ControlledMigrationPrepareResult = ControlledMigrationFailure | {
  ok: true; status: 'needs_confirmation'; confirmationToken: string; operation: ControlledWorkflowMigrationStatusProjection
}
export type ControlledMigrationExecutionResult = ControlledMigrationFailure | {
  ok: true; status: ControlledWorkflowMigrationStatusProjection['status']; operation: ControlledWorkflowMigrationStatusProjection
}
export type ControlledMigrationStatusResult = ControlledMigrationFailure | {
  ok: true; status: ControlledWorkflowMigrationStatusProjection['status']; operation: ControlledWorkflowMigrationStatusProjection
}

export type ControlledMigrationExecutor = (input: {
  effect: ControlledWorkflowMigrationEffect
  operation: ControlledWorkflowMigrationOperation
  grant: ControlledN8nWorkflowGrant
  consumeMutationDispatch?: (binding: {
    operationId: string; sourceId: string; workflowId: string; kind: MutationDispatchKind; artifactSha256: string; wrapperSha256: string
  }) => { ok: true } | { ok: false; code: string }
}) => Promise<N8nWorkflowMigrationExecutorResult>

export type ControlledMigrationCapabilityDependencies = {
  getSource: (sourceId: string) => ControlledMigrationSource | undefined
  getGrants: () => ControlledN8nWorkflowGrant[]
  executor: ControlledMigrationExecutor
  operationStore?: CapabilityOperationStoreOptions
  dispatchStore?: CapabilityMutationDispatchStoreOptions
  now?: () => Date
  randomBytes?: (size: number) => Buffer
  readFile?: (absolutePath: string) => Buffer
  lstat?: (absolutePath: string) => fs.Stats
  realpath?: (absolutePath: string) => string
  digest?: (value: Buffer | string) => string
  wrapperContract?: unknown
}

const terminal = new Set(['completed', 'rolled_back', 'failed', 'manual_intervention_required', 'expired'])
const fail = (code: ControlledMigrationFailureCode, message: string): ControlledMigrationFailure => ({ ok: false, status: 'blocked', error: { code, message } })
const isCapabilityFailure = (value: unknown): value is ControlledMigrationFailure => Boolean(value) && typeof value === 'object' && (value as { ok?: unknown }).ok === false
const isStoreFailure = (value: unknown): value is CapabilityStoreFailure => Boolean(value) && typeof value === 'object' && (value as { ok?: unknown }).ok === false
const isDispatchFailure = (value: unknown): value is DispatchFailure => Boolean(value) && typeof value === 'object' && (value as { ok?: unknown }).ok === false
const operationFailure = (failure: CapabilityStoreFailure): ControlledMigrationFailure => {
  const code = failure.code === 'CAPABILITY_OPERATION_STORE_CORRUPT' ? 'operation_store_corrupt'
    : failure.code.includes('CONFIRMATION_EXPIRED') ? 'confirmation_expired'
      : failure.code.includes('CONFIRMATION_REPLAYED') ? 'confirmation_replayed'
        : failure.code.includes('CONFIRMATION_INVALID') ? 'confirmation_invalid'
          : failure.code.includes('LEASE') ? 'lease_conflict' : 'operation_conflict'
  return fail(code, failure.message)
}

function environment(deps: ControlledMigrationCapabilityDependencies) {
  return {
    now: deps.now || (() => new Date()),
    randomBytes: deps.randomBytes || crypto.randomBytes,
    readFile: deps.readFile || fs.readFileSync,
    lstat: deps.lstat || fs.lstatSync,
    realpath: deps.realpath || fs.realpathSync,
    digest: deps.digest || ((value: Buffer | string) => crypto.createHash('sha256').update(value).digest('hex'))
  }
}

function normalizedRelative(value: string): string | undefined {
  if (!value || value.includes('\0') || path.isAbsolute(value)) return undefined
  const normalized = path.posix.normalize(value.replace(/\\/g, '/'))
  return normalized === '.' || normalized === '..' || normalized.startsWith('../') ? undefined : normalized
}

function underRoot(relativePath: string, roots: string[]): boolean {
  return roots.some(root => {
    const normalizedRoot = normalizedRelative(root)?.replace(/\/$/, '')
    return Boolean(normalizedRoot && (relativePath === normalizedRoot || relativePath.startsWith(`${normalizedRoot}/`)))
  })
}

function pinnedArtifact(params: {
  source: ControlledMigrationSource; relativePath: string; roots?: string[]; maxBytes: number
  env: ReturnType<typeof environment>
}): { path: string; bytes: Buffer; sha256: string } | ControlledMigrationFailure {
  const relativePath = normalizedRelative(params.relativePath)
  if (!relativePath || (params.roots && !underRoot(relativePath, params.roots))) return fail('artifact_invalid', 'Artifact path is outside the approved root.')
  try {
    const sourceRoot = params.env.realpath(path.resolve(params.source.rootPath))
    const absolute = path.resolve(sourceRoot, relativePath)
    if (absolute !== sourceRoot && !absolute.startsWith(`${sourceRoot}${path.sep}`)) return fail('artifact_invalid', 'Artifact path escapes the source root.')
    const stat = params.env.lstat(absolute)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > params.maxBytes) return fail('artifact_invalid', 'Artifact is not an approved bounded regular file.')
    const real = params.env.realpath(absolute)
    if (real !== absolute || (real !== sourceRoot && !real.startsWith(`${sourceRoot}${path.sep}`))) return fail('artifact_invalid', 'Artifact realpath escapes its source root.')
    const bytes = params.env.readFile(real)
    if (bytes.byteLength > params.maxBytes) return fail('artifact_invalid', 'Artifact exceeds the approved size limit.')
    return { path: relativePath, bytes, sha256: params.env.digest(bytes) }
  } catch {
    return fail('artifact_invalid', 'Artifact could not be read safely.')
  }
}

function exactGrant(sourceId: string, workflowId: string, deps: ControlledMigrationCapabilityDependencies): ControlledN8nWorkflowGrant | ControlledMigrationFailure {
  const grants = deps.getGrants()
  if (grants.length === 0) return fail('capability_not_configured', 'No controlled workflow migration grants are configured.')
  const grant = findControlledN8nWorkflowGrant(grants, sourceId, workflowId)
  return grant || fail('grant_not_found', 'No enabled grant matches the exact source and workflow.')
}

function asOperation(record: CapabilityOperationRecord): ControlledWorkflowMigrationOperation {
  return record
}

export async function prepareControlledWorkflowMigration(
  request: ControlledMigrationPrepareRequest,
  deps: ControlledMigrationCapabilityDependencies
): Promise<ControlledMigrationPrepareResult> {
  const env = environment(deps)
  const source = deps.getSource(request.sourceId)
  if (!source?.enabled) return fail('source_not_found', 'Registered source is missing or disabled.')
  const grant = exactGrant(request.sourceId, request.workflowId, deps)
  if (isCapabilityFailure(grant)) return grant
  if (!parseControlledN8nWrapperContract(deps.wrapperContract ?? CONTROLLED_N8N_WRAPPER_CONTRACT_V1).ok) return fail('grant_mismatch', 'Approved wrapper contract is invalid.')
  const wrapper = pinnedArtifact({ source, relativePath: grant.wrapperPath, maxBytes: 1_000_000, env })
  if ('ok' in wrapper) return wrapper
  if (wrapper.sha256 !== grant.wrapperSha256) return fail('grant_mismatch', 'Approved wrapper digest does not match.')
  const candidate = pinnedArtifact({ source, relativePath: request.candidatePath, roots: grant.allowedCandidateRoots, maxBytes: grant.maxArtifactBytes, env })
  if ('ok' in candidate) return candidate
  const rollback = pinnedArtifact({ source, relativePath: request.rollbackPath, roots: grant.allowedRollbackRoots, maxBytes: grant.maxArtifactBytes, env })
  if ('ok' in rollback) return rollback
  const manifestArtifact = pinnedArtifact({ source, relativePath: request.manifestPath, roots: grant.allowedManifestRoots, maxBytes: grant.maxArtifactBytes, env })
  if ('ok' in manifestArtifact) return manifestArtifact
  let candidateJson: unknown; let rollbackJson: unknown; let manifestJson: unknown
  try {
    candidateJson = JSON.parse(candidate.bytes.toString('utf8')); rollbackJson = JSON.parse(rollback.bytes.toString('utf8')); manifestJson = JSON.parse(manifestArtifact.bytes.toString('utf8'))
  } catch { return fail('artifact_invalid', 'A migration JSON artifact is malformed.') }
  const validatedManifest = validateControlledWorkflowTopologyManifest(manifestJson)
  if (!validatedManifest.ok) return fail('manifest_invalid', 'Topology manifest failed strict validation.')
  const manifest = validatedManifest.manifest
  if (manifest.workflow.id !== request.workflowId || manifest.artifacts.candidatePath !== candidate.path || manifest.artifacts.rollbackPath !== rollback.path || manifest.artifacts.candidateSha256 !== candidate.sha256 || manifest.artifacts.rollbackSha256 !== rollback.sha256) return fail('manifest_invalid', 'Manifest artifact bindings do not match.')
  const canonicalCandidate = canonicalizeN8nWorkflow(candidateJson); const canonicalRollback = canonicalizeN8nWorkflow(rollbackJson)
  if (!canonicalCandidate.ok || !canonicalRollback.ok) return fail('canonicalization_failed', 'Candidate or rollback workflow cannot be canonicalized.')
  const candidateCanonicalSha256 = hashCanonicalWorkflowTopology(canonicalCandidate.topology, env.digest)
  const rollbackCanonicalSha256 = hashCanonicalWorkflowTopology(canonicalRollback.topology, env.digest)
  if (candidateCanonicalSha256 !== manifest.workflow.candidateCanonicalSha256 || rollbackCanonicalSha256 !== manifest.workflow.rollbackCanonicalSha256 || rollbackCanonicalSha256 !== manifest.workflow.expectedLiveCanonicalSha256) return fail('canonicalization_failed', 'Canonical workflow digests do not match the manifest.')
  const comparison = compareControlledWorkflowCandidate({ live: rollbackJson, candidate: candidateJson, manifest, digest: env.digest })
  if (!comparison.ok) return fail('manifest_invalid', 'Declared topology or protected-domain invariants do not match the artifacts.')
  if (grant.maximumPolicy.allowedNodeTypes && canonicalCandidate.topology.nodes.some(node => !grant.maximumPolicy.allowedNodeTypes?.includes(node.type))) return fail('grant_mismatch', 'Candidate contains a node type outside the grant maximum.')
  const now = env.now(); const confirmationExpiresAt = new Date(now.getTime() + grant.confirmationTtlSeconds * 1000).toISOString()
  const operationId = `cap-op-${env.randomBytes(16).toString('hex')}`; const confirmationToken = env.randomBytes(32).toString('base64url')
  const decision = decidePreparation({
    operationId, now: now.toISOString(), confirmationExpiresAt, sourceId: source.sourceId,
    sourceRootFingerprint: source.rootFingerprint, workflowId: request.workflowId, mode: request.mode,
    grant: { grantId: grant.grantId, version: grant.version, sourceId: grant.sourceId, workflowId: grant.workflowId, wrapperPath: grant.wrapperPath, wrapperSha256: grant.wrapperSha256, canonicalizationVersion: 1, ...(grant.apiOriginFingerprint ? { apiOriginFingerprint: grant.apiOriginFingerprint } : {}) },
    manifest, manifestArtifact: { path: manifestArtifact.path, sha256: manifestArtifact.sha256 },
    candidate: { path: candidate.path, sha256: candidate.sha256, canonicalSha256: candidateCanonicalSha256 },
    rollback: { path: rollback.path, sha256: rollback.sha256, canonicalSha256: rollbackCanonicalSha256 },
    wrapper: { path: grant.wrapperPath, sha256: wrapper.sha256 }, apiOriginFingerprint: grant.apiOriginFingerprint
  })
  if (decision.allowed === false) return fail('grant_mismatch', `Portable preparation rejected ${decision.reasonCode}.`)
  const persisted = persistPreparedCapabilityOperation({ operation: decision.operation, confirmationToken, store: deps.operationStore })
  if (persisted.ok === false) return operationFailure(persisted)
  return { ok: true, status: 'needs_confirmation', confirmationToken, operation: projectControlledWorkflowMigrationStatus(decision.operation) }
}

function loadBoundOperation(request: ControlledMigrationExecuteRequest | ControlledMigrationStatusRequest, deps: ControlledMigrationCapabilityDependencies): CapabilityOperationRecord | ControlledMigrationFailure {
  const record = getCapabilityOperationRecord(request.operationId, deps.operationStore)
  if (!record) return fail('operation_not_found', 'Migration operation was not found.')
  if ('ok' in record) return operationFailure(record)
  if (record.binding.sourceId !== request.sourceId || ('mode' in request && request.mode && record.binding.mode !== request.mode)) return fail('grant_mismatch', 'Operation binding does not match the request.')
  return record
}

export function getControlledWorkflowMigrationStatus(request: ControlledMigrationStatusRequest, deps: ControlledMigrationCapabilityDependencies): ControlledMigrationStatusResult {
  const record = loadBoundOperation(request, deps)
  if (isCapabilityFailure(record)) return record
  const source = deps.getSource(request.sourceId)
  if (!source?.enabled || source.rootFingerprint !== record.binding.sourceRootFingerprint) return fail('grant_mismatch', 'Registered source no longer matches the operation binding.')
  return { ok: true, status: record.status, operation: projectControlledWorkflowMigrationStatus(asOperation(record)) }
}

function dispatchEvent(type: 'candidate_dispatch_reserved' | 'rollback_dispatch_reserved', result: 'reserved' | 'conflict' | 'replayed' | 'store_corrupt', at: string): ControlledWorkflowMigrationEvent {
  return type === 'candidate_dispatch_reserved' ? { type, result, at } : { type, result, at }
}

export async function executeControlledWorkflowMigration(
  request: ControlledMigrationExecuteRequest,
  deps: ControlledMigrationCapabilityDependencies
): Promise<ControlledMigrationExecutionResult> {
  const env = environment(deps); const source = deps.getSource(request.sourceId)
  if (!source?.enabled) return fail('source_not_found', 'Registered source is missing or disabled.')
  const loaded = loadBoundOperation(request, deps)
  if (isCapabilityFailure(loaded)) return loaded
  let current: CapabilityOperationRecord = loaded
  if (source.rootFingerprint !== current.binding.sourceRootFingerprint) return fail('grant_mismatch', 'Registered source no longer matches the operation binding.')
  const grant = exactGrant(current.binding.sourceId, current.binding.workflowId, deps)
  if (isCapabilityFailure(grant)) return grant
  if (grant.grantId !== current.binding.grantId || grant.version !== current.binding.grantVersion || grant.wrapperSha256 !== current.binding.wrapperSha256) return fail('grant_mismatch', 'Current grant no longer matches the operation authority.')
  if (current.confirmationConsumedAt && request.confirmationToken) return fail('confirmation_replayed', 'Confirmation was already consumed and cannot be replayed.')
  if (terminal.has(current.status)) return fail(current.status === 'manual_intervention_required' ? 'manual_intervention_required' : 'operation_conflict', 'Terminal operation cannot be executed again.')
  const dispatchProbe = findCapabilityMutationDispatchRecord(
    current.operationId,
    current.binding.mode === 'rollback' ? 'rollback' : 'candidate',
    deps.dispatchStore
  )
  if (isDispatchFailure(dispatchProbe)) return fail('dispatch_store_corrupt', dispatchProbe.message)

  let leaseProof: string | undefined
  let pendingDispatch: { dispatchId: string; authorization: string; kind: MutationDispatchKind } | undefined
  let decision: ControlledWorkflowMigrationAdvanceDecision | undefined
  let queuedForLease: ControlledWorkflowMigrationOperation | undefined

  if (current.status === 'prepared') {
    if (!request.confirmationToken) return fail('confirmation_required', 'A confirmation token is required.')
    const portable = advanceControlledWorkflowMigration({ operation: asOperation(current), event: { type: 'confirmation_result', result: 'consumed', at: env.now().toISOString() } })
    const consumed = consumeCapabilityOperationConfirmation({ operationId: current.operationId, confirmationToken: request.confirmationToken, now: env.now(), store: deps.operationStore })
    if (consumed.ok === false) return operationFailure(consumed)
    const reloaded = getCapabilityOperationRecord(current.operationId, deps.operationStore)
    if (!reloaded || isStoreFailure(reloaded)) return fail('operation_store_corrupt', 'Operation could not be reloaded after confirmation consumption.')
    current = reloaded
    queuedForLease = asOperation(current)
    decision = portable
  }

  const leaseExpired = Boolean(current.lease && Date.parse(current.lease.expiresAt) <= env.now().getTime())
  if ((current.status === 'running' || current.status === 'reconciling' || current.status === 'rolling_back') && current.lease && !leaseExpired) {
    return fail('lease_conflict', 'Another invocation still owns the active workflow lease.')
  }
  if (current.status === 'queued' && !queuedForLease) queuedForLease = asOperation(current)
  if (current.status === 'queued' || current.status === 'reconciling' || ((current.status === 'running' || current.status === 'rolling_back') && leaseExpired)) {
    const acquired = acquireCapabilityOperationLease({ operationId: current.operationId, owner: `migration-${process.pid}`, leaseMs: grant.operationTimeoutMs + 30_000, now: env.now(), store: deps.operationStore })
    if (acquired.ok === false) return operationFailure(acquired)
    leaseProof = acquired.leaseProof
    const reloaded = getCapabilityOperationRecord(current.operationId, deps.operationStore)
    if (!reloaded || isStoreFailure(reloaded)) return fail('operation_store_corrupt', 'Operation could not be reloaded after lease acquisition.')
    current = reloaded
    if (current.status === 'running' && current.readbackRequests === 0 && queuedForLease) {
      decision = advanceControlledWorkflowMigration({ operation: queuedForLease, event: { type: 'lease_result', result: 'acquired', at: env.now().toISOString() } })
    }
  }
  if (!leaseProof) return fail('reconciliation_required', 'Execution ownership cannot be proven; readback reconciliation is required.')

  const persist = (next: ControlledWorkflowMigrationOperation): ControlledMigrationFailure | undefined => {
    const result = transitionCapabilityOperation({ operationId: current.operationId, sourceId: current.binding.sourceId, workflowId: current.binding.workflowId, expectedStatus: current.status, expectedRevision: current.revision, next: next as CapabilityOperationRecord, leaseProof, now: env.now(), store: deps.operationStore })
    if (result.ok === false) return operationFailure(result)
    const reloaded = getCapabilityOperationRecord(current.operationId, deps.operationStore)
    if (!reloaded || isStoreFailure(reloaded)) return fail('operation_store_corrupt', 'Operation could not be reloaded after persistence.')
    current = reloaded
  }

  let recoveryFailure: ControlledMigrationFailure | undefined
  const leaseMs = grant.operationTimeoutMs + 30_000
  const renewLease = (): ControlledMigrationFailure | undefined => {
    const renewed = renewCapabilityOperationLease({
      operationId: current.operationId,
      sourceId: current.binding.sourceId,
      workflowId: current.binding.workflowId,
      expectedRevision: current.revision,
      leaseProof: leaseProof!,
      leaseMs,
      now: env.now(),
      store: deps.operationStore
    })
    if (renewed.ok === false) return operationFailure(renewed)
    const reloaded = getCapabilityOperationRecord(current.operationId, deps.operationStore)
    if (!reloaded || isStoreFailure(reloaded)) return fail('operation_store_corrupt', 'Operation could not be reloaded after lease renewal.')
    current = reloaded
  }
  const recoverDecision = (): ControlledWorkflowMigrationAdvanceDecision | undefined => {
    const kind: MutationDispatchKind | undefined = current.rollbackUpdateRequests === 1 && current.evidence?.rollbackResult === undefined
      ? 'rollback'
      : current.candidateUpdateRequests === 1 && current.evidence?.mutationResult === undefined
        ? 'candidate'
        : undefined
    if (!kind) return undefined
    const dispatch = findCapabilityMutationDispatchRecord(current.operationId, kind, deps.dispatchStore)
    if (isDispatchFailure(dispatch)) return advanceControlledWorkflowMigration({ operation: asOperation(current), event: dispatchEvent(kind === 'candidate' ? 'candidate_dispatch_reserved' : 'rollback_dispatch_reserved', 'store_corrupt', env.now().toISOString()) })
    if (!dispatch) return undefined
    if (dispatch.status === 'outcome_recorded' && dispatch.outcome) {
      return advanceControlledWorkflowMigration({ operation: asOperation(current), event: { type: 'recovered_mutation_result', kind, result: dispatch.outcome, at: env.now().toISOString() } })
    }
    if (dispatch.status === 'reserved' || dispatch.status === 'dispatched' || dispatch.status === 'reconciliation_required') {
      if (dispatch.status !== 'reconciliation_required') {
        const marked = requireMutationDispatchReconciliation(dispatch.dispatchId, deps.dispatchStore)
        if (marked.ok === false) {
          recoveryFailure = fail(marked.code === 'MUTATION_DISPATCH_STORE_CORRUPT' ? 'dispatch_store_corrupt' : 'dispatch_conflict', marked.message)
          return undefined
        }
      }
      return advanceControlledWorkflowMigration({ operation: asOperation(current), event: { type: 'recovered_mutation_result', kind, result: 'ambiguous', at: env.now().toISOString() } })
    }
    return undefined
  }
  decision ||= recoverDecision()
  if (recoveryFailure) return recoveryFailure
  if (!decision) {
    decision = advanceControlledWorkflowMigration({ operation: asOperation(current), event: { type: 'recovery_resume', at: env.now().toISOString() } })
  }

  for (let iteration = 0; iteration < N8N_WORKFLOW_MIGRATION_MAX_ITERATIONS; iteration += 1) {
    if (!decision) break
    let nextDecision: ControlledWorkflowMigrationAdvanceDecision | undefined
    for (const effect of decision.effects) {
      if (effect.type === 'none' || effect.type === 'acquire_lease') continue
      if (effect.type === 'persist_operation') {
        const failure = persist(effect.operation); if (failure) return failure
        continue
      }
      if (effect.type === 'release_lease') {
        const released = releaseCapabilityOperationLease({ operationId: current.operationId, sourceId: current.binding.sourceId, workflowId: current.binding.workflowId, expectedRevision: current.revision, leaseProof, now: env.now(), store: deps.operationStore })
        if (released.ok === false) return operationFailure(released)
        const reloaded = getCapabilityOperationRecord(current.operationId, deps.operationStore)
        if (!reloaded || isStoreFailure(reloaded)) return fail('operation_store_corrupt', 'Operation could not be reloaded after lease release.')
        current = reloaded
        continue
      }
      if (effect.type === 'reserve_candidate_dispatch' || effect.type === 'reserve_rollback_dispatch') {
        const kind = effect.type === 'reserve_candidate_dispatch' ? 'candidate' : 'rollback'
        const reserved = reserveCapabilityMutationDispatch({ operationId: effect.operationId, sourceId: current.binding.sourceId, workflowId: effect.workflowId, kind, artifactSha256: effect.artifactSha256, wrapperSha256: effect.wrapperSha256, store: deps.dispatchStore })
        const result = reserved.ok === true ? 'reserved' : reserved.code === 'MUTATION_DISPATCH_STORE_CORRUPT' ? 'store_corrupt' : reserved.code.includes('REPLAY') ? 'replayed' : 'conflict'
        if (reserved.ok) pendingDispatch = { dispatchId: reserved.dispatch.dispatchId, authorization: reserved.authorization, kind }
        nextDecision = advanceControlledWorkflowMigration({ operation: asOperation(current), event: dispatchEvent(kind === 'candidate' ? 'candidate_dispatch_reserved' : 'rollback_dispatch_reserved', result, env.now().toISOString()) })
        continue
      }
      let consumer: ReturnType<typeof createCapabilityMutationDispatchConsumer> | undefined
      if (effect.type === 'apply_candidate' || effect.type === 'apply_rollback') {
        const kind = effect.type === 'apply_candidate' ? 'candidate' : 'rollback'
        if (!pendingDispatch || pendingDispatch.kind !== kind) {
          nextDecision = advanceControlledWorkflowMigration({ operation: asOperation(current), event: kind === 'candidate' ? { type: 'mutation_result', result: 'ambiguous', at: env.now().toISOString() } : { type: 'rollback_result', result: 'ambiguous', at: env.now().toISOString() } })
          continue
        }
        consumer = createCapabilityMutationDispatchConsumer({ dispatchId: pendingDispatch.dispatchId, authorization: pendingDispatch.authorization, store: deps.dispatchStore })
      }
      const renewalFailure = renewLease()
      if (renewalFailure) return renewalFailure
      const result = await deps.executor({ effect, operation: asOperation(current), grant, ...(consumer ? { consumeMutationDispatch: consumer } : {}) })
      const resultMatchesInvocation = result.operationId === current.operationId
        && result.workflowId === current.binding.workflowId
        && result.effect === effect.type
      if ((effect.type === 'apply_candidate' || effect.type === 'apply_rollback') && pendingDispatch) {
        const outcome = !resultMatchesInvocation || result.classification === 'blocked' ? 'ambiguous' : result.classification
        const recorded = recordCapabilityMutationDispatchOutcome({ dispatchId: pendingDispatch.dispatchId, operationId: current.operationId, sourceId: current.binding.sourceId, workflowId: current.binding.workflowId, kind: pendingDispatch.kind, artifactSha256: effect.artifactSha256, wrapperSha256: current.binding.wrapperSha256, outcome, store: deps.dispatchStore })
        if (recorded.ok === false) return fail(recorded.code === 'MUTATION_DISPATCH_STORE_CORRUPT' ? 'dispatch_store_corrupt' : 'dispatch_conflict', recorded.message)
      }
      const event = resultMatchesInvocation
        ? toControlledWorkflowMigrationEvent(result, env.now().toISOString())
        : effect.type === 'apply_candidate'
          ? { type: 'mutation_result', result: 'ambiguous', at: env.now().toISOString() } as const
          : effect.type === 'apply_rollback'
            ? { type: 'rollback_result', result: 'ambiguous', at: env.now().toISOString() } as const
            : { type: effect.type === 'read_live_workflow' && effect.purpose === 'precondition' ? 'precondition_readback' : 'readback_result', result: 'unavailable', at: env.now().toISOString() } as const
      nextDecision = advanceControlledWorkflowMigration({ operation: asOperation(current), event })
    }
    decision = nextDecision
    if (terminal.has(current.status)) break
  }
  const finalRecord = getCapabilityOperationRecord(current.operationId, deps.operationStore)
  if (!finalRecord || 'ok' in finalRecord) return fail('operation_store_corrupt', 'Final operation state is unavailable.')
  if (!terminal.has(finalRecord.status) && decision) return fail('iteration_limit', 'Migration orchestration reached its bounded iteration limit.')
  return { ok: true, status: finalRecord.status, operation: projectControlledWorkflowMigrationStatus(asOperation(finalRecord)) }
}
