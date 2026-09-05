import {
  createWriteCapableCliCapabilityHandler,
  validateWriteCapableCliCapabilityManifest,
  type WriteCapableCliExecutionInput
} from '../../../mcp/dist/capability-write-capable-cli.js'
import { CapabilityBroker, type CapabilityBrokerResult } from '../../../mcp/dist/capability-broker.js'
import type { CapabilityJobHandler, CapabilityJobHandlerResult, CapabilityJobProjection } from '../../../mcp/dist/capability-execution-coordinator.js'
import type { CapabilityRuntimeIdentity, CapabilityPhase16Context } from '../../../mcp/dist/capability-runtime-enforcement.js'
import type { CliCapabilityManifest, AutonomyDecisionEvidenceReference, AutonomyPermissionCategory, AutonomyPolicyEvaluationInput } from '@workbench/shared'
import {
  buildAutonomyDecisionPolicyInput,
  prepareAutonomyDecisionAuthorization,
  resolveWorkbenchActorId,
  type AutonomyDecisionAuthorization
} from './autonomy-decision-authorization'
import {
  buildApprovalRequestDigest,
  ensurePendingApprovalIntent,
  consumeMatchingApprovalIntentAfterConfirmedSuccess,
  type WorkbenchApprovalIntentRecord,
  type WorkbenchApprovalIntentStoreOptions
} from './workbench-approval-intents'
import { attachWorkbenchEvidence } from './workbench-evidence-producers'
import { normalizeRepoRelativePath } from './safe-access'
import { preflightWorkbenchPacket, type WorkbenchPacket } from './workbench-packets'
import {
  controlWorkbenchPacketsForRun,
  getWorkbenchPacketRecord,
  reserveWorkbenchPacket
} from './workbench-packet-store'
import { scheduleWorkbenchPacket } from './workbench-packet-coordinator'
import { getWorkbenchPacketResult } from './workbench-packet-results'

export const WRITE_CAPABLE_CLI_OPERATION = 'approved_capability' as const
export const WRITE_CAPABLE_CLI_OPERATION_KIND = 'capability:workbench.cli.write-capable-packet' as const

type WriteCapableCliRequest = Readonly<{
  packet: WorkbenchPacket
  writePaths: readonly string[]
}>

export type WriteCapableCliPreview = Readonly<{
  capabilityId: string
  capabilityVersion: string
  sourceId: string
  runId: string
  sessionId: string
  requestId?: string
  packetId: string
  operation: typeof WRITE_CAPABLE_CLI_OPERATION
  exactPaths: readonly string[]
  validationCommands: readonly string[]
  commitRequested: boolean
  risk: CliCapabilityManifest['risk']
  confirmation: 'required' | 'persisted-approved'
  reason: string
}>

export type WriteCapableCliPreparedExecution = Readonly<{
  status: 'ready' | 'needs_confirmation' | 'blocked'
  request: WriteCapableCliRequest
  preview: WriteCapableCliPreview
  preflight: ReturnType<typeof preflightWorkbenchPacket>
  authorization?: AutonomyDecisionAuthorization
  approval?: WorkbenchApprovalIntentRecord
  error?: { code: string; message: string }
}>

export type PrepareWriteCapableCliExecutionParams = Readonly<{
  manifest: CliCapabilityManifest
  packet: WorkbenchPacket
  writePaths: readonly string[]
  sourceId: string
  sourceRoot: string
  sessionId: string
  actorId?: string
  requestId?: string
  storeOptions?: Parameters<typeof prepareAutonomyDecisionAuthorization>[0]['storeOptions']
  approvalOptions?: WorkbenchApprovalIntentStoreOptions
}>

export type CreateWriteCapableCliBindingParams = Readonly<{
  manifest: CliCapabilityManifest
  providerId: string
  bindingId: string
  sourceRootFor: (sourceId: string) => string | undefined
  approvalOptions?: WorkbenchApprovalIntentStoreOptions
}>

function failPrepared(
  request: WriteCapableCliRequest,
  preview: WriteCapableCliPreview,
  preflight: ReturnType<typeof preflightWorkbenchPacket>,
  code: string,
  message: string,
  authorization?: AutonomyDecisionAuthorization
): WriteCapableCliPreparedExecution {
  return { status: 'blocked', request, preview, preflight, ...(authorization ? { authorization } : {}), error: { code, message: message.slice(0, 1_000) } }
}

function sortedUnique(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort()
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(sortedUnique(left)) === JSON.stringify(sortedUnique(right))
}

function withinDeclaredRoot(relativePath: string, root: string): boolean {
  const normalizedRoot = normalizeRepoRelativePath(root)
  return normalizedRoot === relativePath || relativePath.startsWith(`${normalizedRoot}/`)
}

function packetBytes(request: WriteCapableCliRequest): number | undefined {
  try {
    const value = JSON.stringify(request)
    return value === undefined ? undefined : Buffer.byteLength(value, 'utf8')
  } catch {
    return undefined
  }
}

function previewFor(params: PrepareWriteCapableCliExecutionParams, exactPaths: string[], confirmation: WriteCapableCliPreview['confirmation']): WriteCapableCliPreview {
  return {
    capabilityId: params.manifest.id,
    capabilityVersion: params.manifest.version,
    sourceId: params.sourceId,
    runId: params.packet.runId,
    sessionId: params.sessionId,
    ...(params.requestId ? { requestId: params.requestId } : {}),
    packetId: params.packet.packetId,
    operation: WRITE_CAPABLE_CLI_OPERATION,
    exactPaths,
    validationCommands: (params.packet.validation || []).map(item => item.commandKind),
    commitRequested: params.packet.commit?.enabled === true,
    risk: params.manifest.risk,
    confirmation,
    reason: params.manifest.confirmation.reason || 'This exact bounded source write requires explicit confirmation.'
  }
}

function capabilityDecisionInput(params: PrepareWriteCapableCliExecutionParams, request: WriteCapableCliRequest, exactPaths: string[]) {
  return {
    operation: WRITE_CAPABLE_CLI_OPERATION,
    category: 'capability' as AutonomyPermissionCategory,
    sourceId: params.sourceId,
    runId: params.packet.runId,
    sessionId: params.sessionId,
    actorId: resolveWorkbenchActorId(params.actorId),
    capabilityId: params.manifest.id,
    paths: exactPaths,
    arguments: request,
    storeOptions: params.storeOptions
  }
}

function approvalEvidence(params: PrepareWriteCapableCliExecutionParams, preview: WriteCapableCliPreview): AutonomyDecisionEvidenceReference | undefined {
  const attached = attachWorkbenchEvidence({
    entries: [{
      kind: 'capability_result',
      owner: {
        sourceId: params.sourceId,
        sessionId: params.sessionId,
        requestId: params.requestId,
        operationId: `${WRITE_CAPABLE_CLI_OPERATION}:${params.packet.packetId}`,
        providerId: params.manifest.id
      },
      retentionClass: 'active_run',
      content: JSON.stringify({
        mode: 'write-capable-cli',
        capabilityId: preview.capabilityId,
        capabilityVersion: preview.capabilityVersion,
        sourceId: preview.sourceId,
        runId: preview.runId,
        sessionId: preview.sessionId,
        packetId: preview.packetId,
        operation: preview.operation,
        exactPaths: preview.exactPaths,
        validationCommands: preview.validationCommands,
        commitRequested: preview.commitRequested,
        risk: preview.risk
      })
    }]
  })
  const evidence = attached.evidenceRefs?.[0]
  if (!evidence) return undefined
  return {
    evidenceId: evidence.evidenceId,
    kind: 'capability_result',
    reference: `workbench://evidence/${evidence.evidenceId}`,
    recordedAt: evidence.createdAt
  }
}

export function prepareWriteCapableCliExecution(params: PrepareWriteCapableCliExecutionParams): WriteCapableCliPreparedExecution {
  const request: WriteCapableCliRequest = { packet: params.packet, writePaths: [...params.writePaths] }
  const manifestValidation = validateWriteCapableCliCapabilityManifest(params.manifest)
  const emptyPreflight = { status: 'rejected' as const, accepted: false, errors: [{ code: 'MANIFEST_INVALID', message: manifestValidation.ok === false ? manifestValidation.message : 'unavailable' }] }
  const initialPreview = previewFor(params, [], 'required')
  if (manifestValidation.ok === false) return failPrepared(request, initialPreview, emptyPreflight, 'MANIFEST_INVALID', manifestValidation.message)
  if (!params.sourceId || params.packet.sourceId !== params.sourceId) return failPrepared(request, initialPreview, emptyPreflight, 'SOURCE_MISMATCH', 'The packet source does not match the selected source.')
  if (!Array.isArray(params.writePaths) || params.writePaths.length < 1 || params.writePaths.length > manifestValidation.value.writePolicy.maxFiles) return failPrepared(request, initialPreview, emptyPreflight, 'WRITE_SCOPE_INVALID', 'The requested write path list is outside the manifest file-count bound.')
  const normalizedWritePaths = params.writePaths.map(item => normalizeRepoRelativePath(String(item)))
  if (normalizedWritePaths.some(item => !item || item.includes('..'))) return failPrepared(request, initialPreview, emptyPreflight, 'WRITE_PATH_INVALID', 'Write paths must be exact source-relative paths without traversal segments.')

  let preflight: ReturnType<typeof preflightWorkbenchPacket>
  try {
    preflight = preflightWorkbenchPacket({ packet: params.packet, sourceRoot: params.sourceRoot })
  } catch (error) {
    return failPrepared(request, initialPreview, emptyPreflight, 'PACKET_PREFLIGHT_FAILED', error instanceof Error ? error.message : String(error))
  }
  const exactPaths = sortedUnique(preflight.exactPaths || [])
  const preview = previewFor(params, exactPaths, 'required')
  if (!preflight.accepted) return failPrepared(request, preview, preflight, 'PACKET_PREFLIGHT_REJECTED', preflight.errors.map(item => `${item.code}: ${item.message}`).join(' '))
  if (!samePaths(normalizedWritePaths, exactPaths)) return failPrepared(request, preview, preflight, 'UNDECLARED_WRITE_PATH', 'The request writePaths must exactly equal the packet’s declared primary and move-target paths.')
  if (exactPaths.some(item => !manifestValidation.value.pathPolicy.allowedRoots.some(root => withinDeclaredRoot(item, root)) || !manifestValidation.value.writePolicy.allowedPaths.some(root => withinDeclaredRoot(item, root)))) {
    return failPrepared(request, preview, preflight, 'CAPABILITY_PATH_SCOPE', 'One or more packet paths are outside the configured capability source roots.')
  }
  if ((packetBytes(request) || Number.POSITIVE_INFINITY) > 64 * 1024) return failPrepared(request, preview, preflight, 'PACKET_INPUT_TOO_LARGE', 'The bounded write-capable packet input exceeds 64 KiB.')
  if (!params.packet.validation || params.packet.validation.length === 0) return failPrepared(request, preview, preflight, 'PACKET_VALIDATION_REQUIRED', 'A write-capable packet must declare at least one canonical validation command before execution.')

  const decisionInput = capabilityDecisionInput(params, request, exactPaths)
  const authorization = prepareAutonomyDecisionAuthorization(decisionInput)
  if (authorization.status === 'denied' || authorization.status === 'unavailable') {
    return failPrepared(request, preview, preflight, authorization.reasonCode || 'AUTHORIZATION_UNAVAILABLE', authorization.message || 'The exact persisted autonomy decision is unavailable.', authorization)
  }
  if (authorization.status === 'allowed') {
    return { status: 'ready', request, preview: previewFor(params, exactPaths, 'persisted-approved'), preflight, authorization }
  }
  if (!authorization.request) return failPrepared(request, preview, preflight, 'AUTHORIZATION_REQUEST_MISSING', 'The exact confirmation request was not produced.', authorization)
  const evidenceRef = approvalEvidence(params, preview)
  if (!evidenceRef) return failPrepared(request, preview, preflight, 'APPROVAL_EVIDENCE_UNAVAILABLE', 'The bounded approval evidence could not be persisted; execution remains blocked.', authorization)
  const approval = ensurePendingApprovalIntent({
    sourceId: params.sourceId,
    runId: params.packet.runId,
    sessionId: params.sessionId,
    requestId: params.requestId,
    operationKind: WRITE_CAPABLE_CLI_OPERATION_KIND,
    paths: exactPaths,
    reason: preview.reason,
    requestDigest: buildApprovalRequestDigest(WRITE_CAPABLE_CLI_OPERATION_KIND, request),
    decisionRequest: authorization.request,
    evidenceRef,
    options: params.approvalOptions
  })
  if (approval.ok === false) return failPrepared(request, preview, preflight, approval.code, approval.message, authorization)
  return { status: 'needs_confirmation', request, preview, preflight, authorization, approval: approval.record }
}

function phase16For(params: {
  manifest: CliCapabilityManifest
  sourceId: string
  runId: string
  sessionId: string
  exactPaths: readonly string[]
  actorId?: string
  request: WriteCapableCliRequest
}): CapabilityPhase16Context {
  const input = {
    operation: WRITE_CAPABLE_CLI_OPERATION,
    category: 'capability' as AutonomyPermissionCategory,
    sourceId: params.sourceId,
    runId: params.runId,
    sessionId: params.sessionId,
    actorId: resolveWorkbenchActorId(params.actorId) || 'os-user:unknown',
    capabilityId: params.manifest.id,
    paths: params.exactPaths,
    arguments: params.request,
    storeOptions: undefined
  }
  const policyInput: AutonomyPolicyEvaluationInput = {
    ...buildAutonomyDecisionPolicyInput(input),
    confirmation: { state: 'confirmed' }
  }
  return {
    identity: { sourceId: params.sourceId, sessionId: params.sessionId, runId: params.runId },
    policyInput
  }
}

function packetOutput(record: NonNullable<ReturnType<typeof getWorkbenchPacketRecord>>, result: NonNullable<ReturnType<typeof getWorkbenchPacketResult>>) {
  const validationPassed = result.validation.length > 0 && result.validation.every(item => item.status === 'completed')
  return {
    status: 'completed' as const,
    packetId: record.packet.packetId,
    exactPaths: record.exactPaths,
    changedPaths: result.changedPaths || [],
    writesPerformed: result.writesPerformed,
    rolledBack: result.rolledBack,
    validationPassed,
    commitRequested: record.packet.commit?.enabled === true,
    committed: Boolean(record.commitHash),
    ...(record.commitHash ? { commitHash: record.commitHash } : {})
  }
}

function packetFailure(context: WriteCapableCliExecutionInput['context'], code: string, message: string): CapabilityJobHandlerResult {
  return {
    status: 'failed',
    resultRef: `workbench://capability-jobs/${context.job.jobId}/result`,
    evidenceRef: context.job.evidenceRef,
    failure: { code, message: message.slice(0, 1_000), retryable: false }
  }
}

async function waitForPacket(context: WriteCapableCliExecutionInput['context'], packet: WorkbenchPacket, sourceRootFor: (sourceId: string) => string | undefined, exactPaths: readonly string[], approvalOptions?: WorkbenchApprovalIntentStoreOptions): Promise<CapabilityJobHandlerResult> {
  const sourceRoot = sourceRootFor(context.job.sourceId)
  if (!sourceRoot) return packetFailure(context, 'source_root_unavailable', 'The exact configured source root is unavailable.')
  if (packet.sourceId !== context.job.sourceId || packet.runId !== context.job.runId) return packetFailure(context, 'packet_identity_mismatch', 'The packet source and run do not match the authenticated capability job.')
  let preflight: ReturnType<typeof preflightWorkbenchPacket>
  try {
    preflight = preflightWorkbenchPacket({ packet, sourceRoot })
  } catch (error) {
    return packetFailure(context, 'packet_preflight_failed', error instanceof Error ? error.message : String(error))
  }
  if (!preflight.accepted || !samePaths(preflight.exactPaths || [], exactPaths)) return packetFailure(context, 'packet_preflight_rejected', preflight.errors.map(item => `${item.code}: ${item.message}`).join(' ') || 'Packet preflight no longer matches the authorized exact path set.')
  const reservation = reserveWorkbenchPacket({ packet, exactPaths: [...exactPaths] })
  if (reservation.ok === false) return packetFailure(context, reservation.code, reservation.message)
  if (!reservation.created && reservation.record.status !== 'queued') return packetFailure(context, 'packet_already_reserved', `Packet is already ${reservation.record.status}; no second mutation attempt is permitted.`)
  const scheduled = scheduleWorkbenchPacket({ packetId: packet.packetId, sourceId: packet.sourceId, sourceRootFor })
  if (scheduled.status === 'rejected') return packetFailure(context, 'packet_schedule_rejected', scheduled.reason || 'The canonical packet scheduler rejected the packet.')

  const cancellation = () => {
    controlWorkbenchPacketsForRun({ runId: packet.runId, action: 'cancel', reason: 'Capability job cancellation or timeout requested.' })
  }
  context.signal.addEventListener('abort', cancellation, { once: true })
  const deadline = Date.now() + Math.max(100, context.authorized.timeoutMs - 100)
  try {
    while (Date.now() < deadline) {
      if (context.signal.aborted) {
        cancellation()
        return { status: 'cancelled', failure: { code: 'cancelled', message: 'Write-capable packet execution was cancelled before completion.', retryable: false } }
      }
      const record = getWorkbenchPacketRecord(packet.packetId)
      const result = getWorkbenchPacketResult(packet.packetId)
      if (record?.status === 'completed' && result?.status === 'completed') {
        const output = packetOutput(record, result)
        if (!output.validationPassed) return packetFailure(context, 'packet_validation_failed', 'Packet execution completed without a passing canonical validation result.')
        consumeMatchingApprovalIntentAfterConfirmedSuccess({
          sourceId: packet.sourceId,
          runId: packet.runId,
          sessionId: context.job.sessionId,
          operationKind: WRITE_CAPABLE_CLI_OPERATION_KIND,
          requestDigest: buildApprovalRequestDigest(WRITE_CAPABLE_CLI_OPERATION_KIND, context.input),
          options: approvalOptions
        })
        return { status: 'succeeded', output }
      }
      if (record?.status === 'cancelled' || result?.status === 'cancelled') return { status: 'cancelled', failure: { code: 'packet_cancelled', message: 'Write-capable packet execution was cancelled and rolled back.', retryable: false } }
      if (record?.status === 'failed' || result?.status === 'failed') return packetFailure(context, 'packet_execution_failed', record?.failureReason || 'Write-capable packet execution failed and was rolled back.')
      if (result?.status === 'requeued') return packetFailure(context, 'packet_requeued', 'The canonical packet worker requeued the packet; no automatic capability retry was performed.')
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    cancellation()
    return packetFailure(context, 'packet_timeout', 'Write-capable packet execution exceeded its bounded capability timeout.')
  } finally {
    context.signal.removeEventListener('abort', cancellation)
  }
}

export function createWriteCapableCliBinding(params: CreateWriteCapableCliBindingParams) {
  const validation = validateWriteCapableCliCapabilityManifest(params.manifest)
  if (validation.ok === false) throw new Error(validation.message)
  const handler: CapabilityJobHandler = createWriteCapableCliCapabilityHandler(params.manifest, async input => waitForPacket(input.context, input.packet as WorkbenchPacket, params.sourceRootFor, input.authorizedPaths, params.approvalOptions))
  return {
    manifest: params.manifest,
    providerId: params.providerId,
    bindingId: params.bindingId,
    configured: true as const,
    handler,
    executionMode: 'write-capable-cli' as const
  }
}

export type ExecutePreparedWriteCapableCliParams = Readonly<{
  prepared: WriteCapableCliPreparedExecution
  broker: CapabilityBroker
  manifest: CliCapabilityManifest
  sourceRoot: string
  actorId?: string
  requestedBy: string
  timeoutMs?: number
  sourceRoots?: readonly string[]
  approvalOptions?: WorkbenchApprovalIntentStoreOptions
}>

export function executePreparedWriteCapableCli(params: ExecutePreparedWriteCapableCliParams): CapabilityBrokerResult<CapabilityJobProjection> {
  if (params.prepared.status !== 'ready') return { ok: false, code: params.prepared.error?.code || 'confirmation_required', message: params.prepared.error?.message || 'The exact write-capable CLI request is not ready for execution.' }
  const prepared = params.prepared
  const request = prepared.request
  const identity: CapabilityRuntimeIdentity = {
    sourceId: prepared.preview.sourceId,
    sessionId: prepared.preview.sessionId,
    runId: prepared.preview.runId,
    requestId: prepared.preview.requestId || `write-capable:${prepared.preview.packetId}`,
    capabilityId: params.manifest.id,
    capabilityVersion: params.manifest.version,
    providerId: params.manifest.id
  }
  return params.broker.run({
    capabilityId: params.manifest.id,
    capabilityVersion: params.manifest.version,
    sourceId: identity.sourceId,
    sessionId: identity.sessionId,
    runId: identity.runId,
    requestId: identity.requestId,
    idempotencyKey: request.packet.idempotencyKey,
    requestedBy: params.requestedBy,
    input: request,
    timeoutMs: params.timeoutMs,
    phase16: phase16For({ manifest: params.manifest, sourceId: identity.sourceId, runId: identity.runId, sessionId: identity.sessionId, exactPaths: prepared.preview.exactPaths, actorId: params.actorId, request }),
    capabilityContext: {
      sourceRoot: params.sourceRoot,
      hardWrite: { allowed: true, allowedPaths: prepared.preview.exactPaths, maxFiles: prepared.preview.exactPaths.length, maxBytes: params.manifest.writePolicy.maxBytes }
    }
  })
}

export function formatWriteCapableCliPreview(prepared: WriteCapableCliPreparedExecution): string {
  const preview = prepared.preview
  return [
    `Mode: write-capable-cli (${prepared.status})`,
    `Capability: ${preview.capabilityId}@${preview.capabilityVersion}`,
    `Source/run/session: ${preview.sourceId} / ${preview.runId} / ${preview.sessionId}`,
    `Packet: ${preview.packetId}`,
    `Operation: ${preview.operation}`,
    `Exact paths: ${preview.exactPaths.join(', ') || '(none)'}`,
    `Validation: ${preview.validationCommands.join(', ') || '(missing)'}`,
    `Commit requested: ${preview.commitRequested ? 'yes' : 'no'}`,
    `Risk: ${preview.risk}`,
    `Confirmation: ${preview.confirmation}`,
    `Reason: ${preview.reason}`,
    prepared.error ? `Result: ${prepared.error.code}: ${prepared.error.message}` : 'Result: ready for the single exact approval/execution step.'
  ].join('\n')
}
