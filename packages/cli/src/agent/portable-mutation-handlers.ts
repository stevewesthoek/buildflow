import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getSourcesSafe, getWriteMode, loadConfig } from './config'
import { buildWriteConfirmationToken, hasValidWriteConfirmation, normalizeRepoRelativePath, validateWriteTarget, type WriteChangeType } from './safe-access'
import { getAllowedCommandKinds, runSafeCommand } from './command-runner'
import { classifyParsedRunCommandRequest, parseRunCommandRouteRequest, toSafeCommandRequest } from './run-command-request'
import { executeWithWorkbenchAdmission } from './workbench-admission-orchestrator'
import { getCompactWorkbenchValidationJob, scheduleWorkbenchValidationJob, submitWorkbenchValidationJob } from './workbench-validation-jobs'
import { runControlledWorkflowMigrationCommand } from './n8n-workflow-migration-command-adapter'
import { createWorkbenchRun, getActiveWorkbenchRun, resumeWorkbenchRun } from './agent-jobs'
import { appendAgentEvent, findOpenApprovalActivity } from './agent-events'
import { getWorkbenchSession } from './workbench-session-store'
import { closeWorkbenchRun } from './workbench-run-close'
import { projectPortableActiveRunActivity } from './portable-read-handlers'
import { preflightWorkbenchPacket, type WorkbenchPacket } from './workbench-packets'
import { reserveWorkbenchPacket, claimNextWorkbenchPacket, compactWorkbenchPacketLeaseRecord } from './workbench-packet-store'
import { planWorkbenchPacketExecution } from './workbench-packet-plan'
import { executeWorkbenchPacket } from './workbench-packet-executor'
import { buildApprovalRequestDigest, consumeApprovedApprovalIntent, consumeMatchingApprovalIntentAfterConfirmedSuccess, ensurePendingApprovalIntent } from './workbench-approval-intents'
import type { PortableOperationHandlers, PortableExecutionContext } from '../../../../apps/web/src/lib/actions/portable-operation-dispatcher'
import { PortableOperationError } from '../../../../apps/web/src/lib/actions/portable-operation-errors'
import { authorizeContextOperation } from './context-broker'

type Payload = Record<string, unknown>
type RouteResult = { statusCode: number; body: Record<string, unknown> }
type PortableFileChangeType = WriteChangeType

function asPayload(value: unknown): Payload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PortableOperationError('invalid_request', 'Mutation payload must be an object.')
  }
  return value as Payload
}

function requiredString(body: Payload, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new PortableOperationError('invalid_request', `${key} is required.`)
  }
  return value
}

function sourceFor(body: Payload, context: PortableExecutionContext): string {
  const nestedCommand = body.command && typeof body.command === 'object' && !Array.isArray(body.command)
    ? body.command as Payload
    : undefined
  const payloadSourceId = typeof body.sourceId === 'string'
    ? body.sourceId
    : typeof nestedCommand?.sourceId === 'string' ? nestedCommand.sourceId : undefined
  if (context.sourceId && payloadSourceId && context.sourceId !== payloadSourceId) {
    throw new PortableOperationError('source_mismatch', 'The payload sourceId does not match the canonical request sourceId.')
  }
  const sourceId = context.sourceId || payloadSourceId
  if (!sourceId) throw new PortableOperationError('invalid_request', 'sourceId is required.')
  return sourceId
}

function sessionFor(body: Payload, context: PortableExecutionContext): string {
  const payloadSessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined
  if (context.sessionId && payloadSessionId && context.sessionId !== payloadSessionId) {
    throw new PortableOperationError('session_invalid', 'The payload sessionId does not match the canonical request sessionId.')
  }
  const sessionId = context.sessionId || payloadSessionId
  if (!sessionId) throw new PortableOperationError('session_invalid', 'sessionId is required.')
  return sessionId
}

function requireEnabledSource(sourceId: string): { id: string; path: string } {
  const source = getSourcesSafe({ refreshGitMetadata: false }).find(item => item.id === sourceId && item.enabled)
  if (!source) throw new PortableOperationError('source_mismatch', `Source not found or disabled: ${sourceId}`)
  return source
}

function contextSessionId(body: Payload): string | undefined {
  return typeof body.contextIntelligenceSessionId === 'string' && body.contextIntelligenceSessionId.trim()
    ? body.contextIntelligenceSessionId.trim()
    : undefined
}

function requireBrokerMutationAuthorization(body: Payload, sourceId: string, operation: 'mutation' | 'command'): Record<string, unknown> | undefined {
  const sessionId = contextSessionId(body)
  if (!sessionId) return undefined
  const result = authorizeContextOperation(sourceId, operation, sessionId, body.confirmedByUser === true, {
    storeOptions: undefined
  })
  if (!result.ok) throw new PortableOperationError('policy_rejected', 'message' in result ? result.message : 'Context Broker authorization failed.', { details: 'policy' in result ? result.policy : undefined })
  return { ...result.metadata, freshnessPolicy: result.policy }
}

function resolveActivityRun(sourceId: string, context: PortableExecutionContext): { id: string } | undefined {
  const activeRun = getActiveWorkbenchRun(sourceId)
  if (!activeRun || typeof activeRun.id !== 'string') return undefined
  if (context.sessionId) {
    const session = getWorkbenchSession(context.sessionId)
    if (!session || 'ok' in session || session.activeRunId !== activeRun.id || !session.lockedSourceIds.includes(sourceId)) return undefined
  }
  return { id: activeRun.id }
}

function fileActivityPaths(changeType: string, body: Record<string, unknown>): string[] {
  if (changeType === 'move' || changeType === 'rename') {
    const values = [body.from, body.to]
      .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
      .map(value => normalizeRepoRelativePath(value))
      .filter(Boolean)
    return Array.from(new Set(values))
  }
  const candidate = typeof body.normalizedPath === 'string'
    ? body.normalizedPath
    : typeof body.path === 'string' ? normalizeRepoRelativePath(body.path) : ''
  return candidate ? [candidate] : []
}

type ApprovalRequirement = { operation: string; paths: string[]; reason: string }

function hasConfirmationAttempt(body: Payload): boolean {
  return body.confirmedByUser === true || (typeof body.confirmationToken === 'string' && Boolean(body.confirmationToken))
}

function fileApprovalRequirement(changeType: string, result: RouteResult): ApprovalRequirement | undefined {
  const body = result.body
  const error = body.error && typeof body.error === 'object' && !Array.isArray(body.error) ? body.error as Payload : undefined
  const requiresConfirmation = body.status === 'needs_confirmation' || body.requiresConfirmation === true || error?.requiresConfirmation === true
  if (!requiresConfirmation) return undefined
  const reason = typeof body.reason === 'string' ? body.reason : typeof error?.reason === 'string' ? error.reason : undefined
  if (!reason) return undefined
  const operation = typeof body.operation === 'string' ? body.operation : typeof body.changeType === 'string' ? body.changeType : changeType
  const values = [body.normalizedPath, body.from, body.to, body.path]
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    .map(value => normalizeRepoRelativePath(value))
    .filter(Boolean)
  return { operation, paths: Array.from(new Set(values)), reason }
}

function projectApprovalRequired(runId: string, sourceId: string, requirement: ApprovalRequirement, requestId?: string, approvalId?: string): void {
  if (findOpenApprovalActivity({ jobId: runId, sourceId, ...requirement })) return
  appendAgentEvent({
    jobId: runId,
    sourceId,
    type: 'approval_required',
    activityKind: 'approval_required',
    approvalOperation: requirement.operation,
    approvalReason: requirement.reason,
    message: `${requirement.operation} requires approval: ${requirement.reason}`,
    requestId,
    paths: requirement.paths,
    ...(approvalId ? { evidenceRefs: [{ kind: 'approval', ref: approvalId }] } : {}),
    status: 'required'
  })
}

function projectApprovalResolved(runId: string, sourceId: string, operation: string, paths: string[], requestId?: string, reason?: string): void {
  const open = findOpenApprovalActivity({ jobId: runId, sourceId, operation, paths, ...(reason ? { reason } : {}) })
  if (!open?.approvalReason) return
  appendAgentEvent({
    jobId: runId,
    sourceId,
    type: 'approval_resolved',
    activityKind: 'approval_resolved',
    approvalOperation: operation,
    approvalReason: open.approvalReason,
    message: `${operation} approval resolved: ${open.approvalReason}`,
    requestId,
    paths,
    status: 'resolved'
  })
}

function commandApprovalRequirements(result: { reason?: string; details?: unknown }, fallbackPaths: string[]): Array<{ reason: string; paths: string[] }> {
  const details = result.details && typeof result.details === 'object' && !Array.isArray(result.details)
    ? result.details as Record<string, unknown>
    : undefined
  const raw = details?.approvalRequirements
  if (Array.isArray(raw)) {
    const parsed = raw.flatMap(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return []
      const record = item as Record<string, unknown>
      if (typeof record.reason !== 'string' || !record.reason) return []
      const paths = Array.isArray(record.paths)
        ? record.paths.filter((value): value is string => typeof value === 'string').map(value => normalizeRepoRelativePath(value)).filter(Boolean)
        : []
      return paths.length > 0 ? [{ reason: record.reason, paths: Array.from(new Set(paths)) }] : []
    })
    if (parsed.length > 0) return parsed
  }
  return typeof result.reason === 'string' && result.reason
    ? [{ reason: result.reason, paths: fallbackPaths }]
    : []
}

function throwForRouteResult(result: RouteResult): never {
  const body = result.body
  const error = body.error && typeof body.error === 'object' && !Array.isArray(body.error)
    ? body.error as Record<string, unknown>
    : undefined
  const token = typeof body.confirmationToken === 'string'
    ? body.confirmationToken
    : typeof error?.confirmationToken === 'string' ? error.confirmationToken : undefined
  const requiresConfirmation = body.status === 'needs_confirmation'
    || body.requiresConfirmation === true
    || error?.requiresConfirmation === true
  const code = requiresConfirmation
    ? 'confirmation_required'
    : result.statusCode === 499 ? 'cancelled'
    : result.statusCode === 404 ? 'source_mismatch'
    : result.statusCode === 409 && String(error?.code || body.code || '').includes('STALE') ? 'stale_head'
    : result.statusCode === 403 ? 'policy_rejected'
    : result.statusCode === 400 ? 'invalid_request'
    : 'command_failed'
  const message = typeof error?.message === 'string'
    ? error.message
    : typeof body.message === 'string' ? body.message
    : typeof body.error === 'string' ? body.error
    : 'Workbench mutation failed.'
  throw new PortableOperationError(code, message, {
    details: body,
    requiresConfirmation,
    confirmationToken: token
  })
}

function writeModeAllowed(relPath?: string): void {
  const mode = getWriteMode()
  if (mode === 'readOnly') throw new PortableOperationError('policy_rejected', 'Write mode is readOnly')
  if (mode === 'artifactsOnly' && (!relPath || (!relPath.startsWith('docs/product') && !relPath.startsWith('.buildflow')))) {
    throw new PortableOperationError('policy_rejected', 'Write mode blocks non-artifact paths')
  }
}

function verifiedWrite(fullPath: string): Record<string, unknown> {
  const content = fs.readFileSync(fullPath, 'utf8')
  return {
    verified: true,
    verifiedAt: new Date().toISOString(),
    bytesOnDisk: Buffer.byteLength(content, 'utf8'),
    contentHash: crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
    contentPreview: content.slice(0, 200)
  }
}

function validationFailure(statusCode: number, sourceId: string, changeType: string, validation: Exclude<ReturnType<typeof validateWriteTarget>, { ok: true }>): RouteResult {
  return {
    statusCode,
    body: {
      status: 'error', verified: false, sourceId, path: validation.requestedPath,
      requestedPath: validation.requestedPath, normalizedPath: validation.normalizedPath,
      sourceRootRelativePath: validation.sourceRootRelativePath, changeType,
      error: { ...validation.error, policy: validation.policy }
    }
  }
}

function confirmationRequired(sourceId: string, changeType: 'delete_file' | 'delete_directory' | 'move' | 'rename', requestedPath: string, normalizedPath: string, toPath?: string): RouteResult {
  return {
    statusCode: 403,
    body: {
      status: 'needs_confirmation', code: 'REQUIRES_EXPLICIT_CONFIRMATION', sourceId, operation: changeType,
      requestedPath, normalizedPath, ...(toPath ? { to: toPath } : {}),
      reason: changeType === 'delete_directory' ? 'recursive_delete_requires_confirmation' : 'confirmation_required_path',
      summary: changeType === 'delete_directory' ? 'This deletes a directory and its contents.' : 'This change requires explicit confirmation.',
      requiresConfirmation: true,
      confirmationToken: buildWriteConfirmationToken(sourceId, changeType, normalizedPath, toPath)
    }
  }
}

function executeWorkbenchFileChangeMutationInternal(body: Payload, context: PortableExecutionContext = {}): RouteResult {
  const sourceId = sourceFor(body, context)
  const source = requireEnabledSource(sourceId)
  const changeType = requiredString(body, 'changeType') as PortableFileChangeType
  const relPath = typeof body.path === 'string' ? body.path : typeof body.from === 'string' ? body.from : ''
  writeModeAllowed(relPath)
  const confirmation = { confirmedByUser: body.confirmedByUser === true, confirmationToken: typeof body.confirmationToken === 'string' ? body.confirmationToken : undefined }
  // dryRun: perform all validation and return the preflight result without any filesystem mutation.
  const dryRun = body.dryRun === true || body.preflight === true

  if (!['create', 'overwrite', 'patch', 'append', 'delete_file', 'delete_directory', 'move', 'rename', 'mkdir', 'rmdir'].includes(changeType)) {
    return { statusCode: 400, body: { error: `Unsupported file changeType: ${changeType}` } }
  }
  if (!relPath) return { statusCode: 400, body: { error: 'Path required' } }
  const content = typeof body.content === 'string' ? body.content : undefined
  const validation = validateWriteTarget({
    sourceId,
    requestedPath: relPath,
    changeType,
    sourceRoot: source.path,
    content: changeType === 'patch' ? typeof body.replace === 'string' ? body.replace : undefined : content,
    toPath: typeof body.to === 'string' ? body.to : undefined,
    ...confirmation
  })
  if (validation.ok === false) return validationFailure(403, sourceId, changeType, validation)

  if (changeType === 'create' || changeType === 'overwrite') {
    if (typeof content !== 'string') return { statusCode: 400, body: { error: 'Path and content required' } }
    if (changeType === 'create' && fs.existsSync(validation.fullPath)) return { statusCode: 409, body: { error: 'File already exists' } }
    if (dryRun) {
      return { statusCode: 200, body: { status: 'updated', sourceId, requestedPath: relPath, normalizedPath: validation.normalizedPath, path: relPath, bytesWritten: Buffer.byteLength(content, 'utf8'), created: changeType === 'create', overwritten: changeType === 'overwrite', changeType, dryRun: true, preflight: true, verified: false } }
    }
    fs.mkdirSync(validation.parentPath, { recursive: true })
    fs.writeFileSync(validation.fullPath, content, 'utf8')
    return { statusCode: 200, body: { status: 'updated', sourceId, requestedPath: relPath, normalizedPath: validation.normalizedPath, path: relPath, bytesWritten: Buffer.byteLength(content, 'utf8'), created: changeType === 'create', overwritten: changeType === 'overwrite', changeType, ...verifiedWrite(validation.fullPath) } }
  }

  if (changeType === 'append') {
    if (typeof content !== 'string') return { statusCode: 400, body: { error: 'Path and content required' } }
    if (!fs.existsSync(validation.fullPath)) return { statusCode: 404, body: { error: 'File not found' } }
    const appended = `${typeof body.separator === 'string' ? body.separator : '\n\n'}${content}`
    if (dryRun) {
      return { statusCode: 200, body: { status: 'updated', sourceId, requestedPath: relPath, normalizedPath: validation.normalizedPath, path: relPath, changeType, bytesAppended: Buffer.byteLength(appended, 'utf8'), dryRun: true, preflight: true, verified: false } }
    }
    fs.appendFileSync(validation.fullPath, appended, 'utf8')
    return { statusCode: 200, body: { status: 'updated', sourceId, requestedPath: relPath, normalizedPath: validation.normalizedPath, path: relPath, changeType, bytesAppended: Buffer.byteLength(appended, 'utf8'), ...verifiedWrite(validation.fullPath) } }
  }

  if (changeType === 'patch') {
    const find = typeof body.find === 'string' ? body.find : ''
    const replace = typeof body.replace === 'string' ? body.replace : undefined
    if (!find || replace === undefined) return { statusCode: 400, body: { error: 'Path, find, and replace are required' } }
    if (!fs.existsSync(validation.fullPath)) return { statusCode: 404, body: { error: 'File not found' } }
    const original = fs.readFileSync(validation.fullPath, 'utf8')
    const matchCount = original.split(find).length - 1
    if (matchCount === 0) return { statusCode: 409, body: { status: 'error', verified: false, sourceId, path: relPath, requestedPath: relPath, normalizedPath: validation.normalizedPath, changeType, error: { code: 'PATCH_FIND_NOT_FOUND', message: 'The patch text was not found, so no file was changed.' } } }
    if (matchCount !== 1 && body.allowMultiple !== true) return { statusCode: 409, body: { status: 'error', verified: false, sourceId, path: relPath, requestedPath: relPath, normalizedPath: validation.normalizedPath, changeType, error: { code: 'PATCH_MULTIPLE_MATCHES', message: 'The patch text matched multiple places.' } } }
    const updated = body.allowMultiple === true ? original.split(find).join(replace) : original.replace(find, replace)
    if (dryRun) {
      return { statusCode: 200, body: { status: 'updated', sourceId, requestedPath: relPath, normalizedPath: validation.normalizedPath, path: relPath, changeType, replacements: body.allowMultiple === true ? matchCount : 1, matchCount, bytesBefore: Buffer.byteLength(original, 'utf8'), bytesAfter: Buffer.byteLength(updated, 'utf8'), dryRun: true, preflight: true, verified: false } }
    }
    fs.writeFileSync(validation.fullPath, updated, 'utf8')
    return { statusCode: 200, body: { status: 'updated', sourceId, requestedPath: relPath, normalizedPath: validation.normalizedPath, path: relPath, changeType, replacements: body.allowMultiple === true ? matchCount : 1, matchCount, bytesBefore: Buffer.byteLength(original, 'utf8'), bytesAfter: Buffer.byteLength(updated, 'utf8'), ...verifiedWrite(validation.fullPath) } }
  }

  if (changeType === 'delete_file' || changeType === 'delete_directory' || changeType === 'rmdir') {
    if (!fs.existsSync(validation.fullPath)) return { statusCode: 404, body: { error: 'File not found' } }
    if (fs.statSync(validation.fullPath).isDirectory()) {
      const directoryEmptyBefore = fs.readdirSync(validation.fullPath).length === 0
      const recursive = body.recursive === true || changeType === 'delete_directory'
      if (!recursive) {
        if (!directoryEmptyBefore) return { statusCode: 409, body: { status: 'error', verified: false, code: 'DIRECTORY_NOT_EMPTY', sourceId, path: relPath, requestedPath: relPath, normalizedPath: validation.normalizedPath, changeType: 'rmdir', reason: 'directory_not_empty', hint: 'Pass recursive:true with confirmation or empty the directory first.' } }
        if (dryRun) {
          return { statusCode: 200, body: { status: 'deleted', sourceId, requestedPath: relPath, normalizedPath: validation.normalizedPath, path: relPath, changeType: 'rmdir', operation: 'rmdir', verified: false, existsBefore: true, existsAfter: true, directoryEmptyBefore, dryRun: true, preflight: true } }
        }
        fs.rmdirSync(validation.fullPath)
        return { statusCode: 200, body: { status: 'deleted', sourceId, requestedPath: relPath, normalizedPath: validation.normalizedPath, path: relPath, changeType: 'rmdir', operation: 'rmdir', verified: true, existsBefore: true, existsAfter: false, directoryEmptyBefore } }
      }
      if (!hasValidWriteConfirmation({ sourceId, changeType: 'delete_directory', normalizedPath: validation.normalizedPath, ...confirmation })) return confirmationRequired(sourceId, 'delete_directory', relPath, validation.normalizedPath)
      if (dryRun) {
        return { statusCode: 200, body: { status: 'deleted', sourceId, requestedPath: relPath, normalizedPath: validation.normalizedPath, path: relPath, changeType: 'delete_directory', operation: 'delete_directory', verified: false, existsBefore: true, existsAfter: true, dryRun: true, preflight: true } }
      }
      fs.rmSync(validation.fullPath, { recursive: true, force: false })
      return { statusCode: 200, body: { status: 'deleted', sourceId, requestedPath: relPath, normalizedPath: validation.normalizedPath, path: relPath, changeType: 'delete_directory', operation: 'delete_directory', verified: true, existsBefore: true, existsAfter: false } }
    }
    if (changeType === 'delete_directory' || changeType === 'rmdir') return { statusCode: 400, body: { error: 'Not a directory' } }
    if (!hasValidWriteConfirmation({ sourceId, changeType: 'delete_file', normalizedPath: validation.normalizedPath, ...confirmation })) return confirmationRequired(sourceId, 'delete_file', relPath, validation.normalizedPath)
    if (dryRun) {
      return { statusCode: 200, body: { status: 'deleted', sourceId, requestedPath: relPath, normalizedPath: validation.normalizedPath, path: relPath, changeType, operation: changeType, verified: false, existsBefore: true, existsAfter: true, dryRun: true, preflight: true } }
    }
    fs.unlinkSync(validation.fullPath)
    return { statusCode: 200, body: { status: 'deleted', sourceId, requestedPath: relPath, normalizedPath: validation.normalizedPath, path: relPath, changeType, operation: changeType, verified: true, existsBefore: true, existsAfter: false } }
  }

  if (changeType === 'mkdir') {
    if (fs.existsSync(validation.fullPath)) return { statusCode: 409, body: { error: 'Target already exists' } }
    const createParents = body.createParents === true || body.createParentDirectories === true || validation.policy.allowCreateParentDirectories
    if (!fs.existsSync(validation.parentPath) && !createParents) return { statusCode: 409, body: { status: 'error', verified: false, code: 'PARENT_DIRECTORY_MISSING', sourceId, path: relPath, requestedPath: relPath, normalizedPath: validation.normalizedPath, changeType, reason: 'parent_directory_missing', hint: 'Pass createParents:true to create the missing parent directories.' } }
    if (dryRun) {
      return { statusCode: 200, body: { status: 'created', sourceId, requestedPath: relPath, normalizedPath: validation.normalizedPath, path: relPath, changeType, verified: false, existsAfter: false, dryRun: true, preflight: true } }
    }
    fs.mkdirSync(validation.fullPath, { recursive: createParents })
    return { statusCode: 200, body: { status: 'created', sourceId, requestedPath: relPath, normalizedPath: validation.normalizedPath, path: relPath, changeType, verified: true, existsAfter: true } }
  }

  const to = typeof body.to === 'string' ? body.to : ''
  if (!to) return { statusCode: 400, body: { error: 'From and to required' } }
  if (!fs.existsSync(validation.fullPath)) return { statusCode: 404, body: { error: 'Source path not found' } }
  const normalizedTarget = normalizeRepoRelativePath(to)
  const target = path.resolve(path.join(source.path, normalizedTarget))
  const targetRelative = path.relative(path.resolve(source.path), target)
  if (!normalizedTarget || targetRelative === '..' || targetRelative.startsWith(`..${path.sep}`) || path.isAbsolute(targetRelative)) return { statusCode: 403, body: { error: 'Target path blocked' } }
  if (fs.existsSync(target) && body.overwrite !== true) return { statusCode: 409, body: { error: 'Target already exists' } }
  if (!hasValidWriteConfirmation({ sourceId, changeType, normalizedPath: validation.normalizedPath, toPath: normalizedTarget, ...confirmation })) return confirmationRequired(sourceId, changeType, relPath, validation.normalizedPath, normalizedTarget)
  if (dryRun) {
    return { statusCode: 200, body: { status: 'moved', sourceId, from: relPath, to: normalizedTarget, verified: false, sourceExistsAfter: true, targetExistsAfter: false, dryRun: true, preflight: true } }
  }
  if (body.createParents === true || body.createParentDirectories === true) fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.renameSync(validation.fullPath, target)
  const hash = verifiedWrite(target).contentHash
  return { statusCode: 200, body: { status: 'moved', sourceId, from: relPath, to: normalizedTarget, verified: true, sourceExistsAfter: false, targetExistsAfter: true, contentHashBefore: hash, contentHashAfter: hash } }
}

export function executeWorkbenchFileChangeMutation(body: Payload, context: PortableExecutionContext = {}): RouteResult {
  const sourceId = sourceFor(body, context)
  const contextMetadata = requireBrokerMutationAuthorization(body, sourceId, 'mutation')
  const result = executeWorkbenchFileChangeMutationInternal(body, context)
  return contextMetadata ? { ...result, body: { ...result.body, contextMetadata } } : result
}

export async function executeWorkbenchCommandMutation(body: Payload, context: PortableExecutionContext, options: { requireSession?: boolean } = {}): Promise<RouteResult> {
  if (context.signal?.aborted) return { statusCode: 499, body: { error: { code: 'CANCELLED', message: 'Operation was cancelled before command execution.' } } }
  const sourceId = sourceFor(body, context)
  const requireSession = options.requireSession !== false
  const sessionId = requireSession ? sessionFor(body, context) : undefined
  const routed = parseRunCommandRouteRequest(body)
  if (routed.ok === false) return { statusCode: 400, body: { error: routed.error } }
  if (requireSession && routed.mode !== 'session_aware') return { statusCode: 400, body: { error: 'version 2 session-aware command envelope is required' } }
  if (routed.mode === 'session_aware' && sessionId && routed.sessionId !== sessionId) return { statusCode: 400, body: { error: { code: 'SESSION_SOURCE_MISMATCH', message: 'sessionId does not match the canonical request sessionId.' } } }
  const parsed = routed.command
  if (parsed.sourceId !== sourceId) return { statusCode: 400, body: { error: { code: 'SESSION_SOURCE_MISMATCH', message: 'sourceId does not match the canonical request sourceId.' } } }
  const source = requireEnabledSource(sourceId)
  const contextMetadata = requireBrokerMutationAuthorization(body, sourceId, 'command')
  const attachCommandMetadata = (result: RouteResult): RouteResult => contextMetadata
    ? { ...result, body: { ...result.body, contextMetadata } }
    : result
  const commandSession = routed.mode === 'session_aware' ? getWorkbenchSession(routed.sessionId) : undefined
  const activityRun = routed.mode === 'session_aware'
    ? commandSession && !('ok' in commandSession) && commandSession.lockedSourceIds.includes(sourceId) && typeof commandSession.activeRunId === 'string'
      ? { id: commandSession.activeRunId }
      : undefined
    : resolveActivityRun(sourceId, context)
  const dispatch = async (): Promise<RouteResult> => {
    if (parsed.kind === 'validation_submit') {
      const sessionRunId = routed.mode === 'session_aware' && commandSession && !('ok' in commandSession) && typeof commandSession.activeRunId === 'string'
        ? commandSession.activeRunId
        : undefined
      if (sessionRunId && parsed.request.runId && parsed.request.runId !== sessionRunId) {
        return { statusCode: 400, body: { error: { code: 'SESSION_SOURCE_MISMATCH', message: 'runId does not match the canonical active run for this session.' } } }
      }
      const submitted = submitWorkbenchValidationJob(sessionRunId && !parsed.request.runId ? { ...parsed.request, runId: sessionRunId } : parsed.request)
      if ('code' in submitted) return { statusCode: submitted.code === 'VALIDATION_JOB_STORE_BUSY' ? 409 : 400, body: submitted }
      const schedule = submitted.job.status === 'queued'
        ? scheduleWorkbenchValidationJob({ jobId: submitted.job.jobId, sourceId, sourceRoot: source.path, leaseMs: Math.max(30_000, Math.min((submitted.job.timeoutMs || 300_000) + 60_000, 960_000)) })
        : undefined
      return { statusCode: 200, body: { status: schedule?.status === 'scheduled' ? 'running' : submitted.job.status, validationJobOperation: 'submit', created: submitted.created, job: schedule?.status === 'scheduled' ? { ...submitted.job, status: 'running', workerId: schedule.workerId } : submitted.job, schedule } }
    }
    if (parsed.kind === 'validation_status') {
      const job = getCompactWorkbenchValidationJob(parsed.validationJobId, sourceId)
      return job ? { statusCode: 200, body: { status: job.status, validationJobOperation: 'status', job } } : { statusCode: 404, body: { error: 'Validation job not found for the selected source.' } }
    }
    if (parsed.kind === 'migration') {
      const result = await runControlledWorkflowMigrationCommand(parsed.request, { getSources: getSourcesSafe, getConfiguredGrants: () => loadConfig()?.controlledN8nWorkflowGrants })
      return { statusCode: result.statusCode, body: result.body as Record<string, unknown> }
    }
    const commandOperationKind = parsed.kind === 'direct' ? `command:${parsed.request.commandKind}` : undefined
    const commandRequestDigest = activityRun && commandOperationKind ? buildApprovalRequestDigest(commandOperationKind, parsed.request) : undefined
    const explicitConfirmationAttempt = parsed.kind === 'direct' && (parsed.request.confirmedByUser === true
      || (typeof parsed.request.confirmationToken === 'string' && Boolean(parsed.request.confirmationToken)))
    let approvalIntentConsumed = false
    let effectiveRequest = parsed.request
    if (parsed.kind === 'direct' && activityRun && commandOperationKind && commandRequestDigest && !explicitConfirmationAttempt) {
      const consumed = consumeApprovedApprovalIntent({ sourceId, runId: activityRun.id, sessionId, operationKind: commandOperationKind, requestDigest: commandRequestDigest })
      if (consumed.ok === true && consumed.consumed) {
        approvalIntentConsumed = true
        effectiveRequest = { ...parsed.request, confirmedByUser: true }
      }
    }
    const safeRequest = toSafeCommandRequest(effectiveRequest, source.path)
    if (!getAllowedCommandKinds().includes(safeRequest.commandKind)) return { statusCode: 400, body: { error: 'commandKind is not allowlisted' } }
    const result = await runSafeCommand({ ...safeRequest, signal: context.signal })
    if (context.signal?.aborted || result.reason === 'cancelled') {
      return { statusCode: 499, body: { error: { code: 'CANCELLED', message: 'Operation was cancelled during command execution.' } } }
    }
    if (activityRun) {
      const fallbackPaths = Array.isArray(parsed.request.paths)
        ? parsed.request.paths.filter((value): value is string => typeof value === 'string').map(value => normalizeRepoRelativePath(value))
        : typeof parsed.request.outputPath === 'string' ? [normalizeRepoRelativePath(parsed.request.outputPath)].filter(Boolean) : []
      const approvalRequirements = commandApprovalRequirements(result, fallbackPaths)
      let approvalId: string | undefined
      if (result.status === 'needs_confirmation' && result.requiresConfirmation === true && commandOperationKind && commandRequestDigest && approvalRequirements.length > 0) {
        const paths = Array.from(new Set(approvalRequirements.flatMap(item => item.paths)))
        const reason = Array.from(new Set(approvalRequirements.map(item => item.reason))).sort().join('+')
        const pending = ensurePendingApprovalIntent({
          sourceId,
          runId: activityRun.id,
          sessionId,
          requestId: context.requestId,
          operationKind: commandOperationKind,
          paths,
          reason,
          requestDigest: commandRequestDigest
        })
        if (pending.ok === true) approvalId = pending.record.approvalId
        for (const requirement of approvalRequirements) {
          projectApprovalRequired(activityRun.id, sourceId, { operation: parsed.request.commandKind, paths: requirement.paths, reason: requirement.reason }, context.requestId, approvalId)
        }
      }
      const confirmationAttempt = explicitConfirmationAttempt || approvalIntentConsumed
      if (result.status === 'completed' && explicitConfirmationAttempt && commandOperationKind && commandRequestDigest && !approvalIntentConsumed) {
        consumeMatchingApprovalIntentAfterConfirmedSuccess({ sourceId, runId: activityRun.id, sessionId, operationKind: commandOperationKind, requestDigest: commandRequestDigest })
      }
      if (result.status === 'completed' && confirmationAttempt) {
        for (const requirement of approvalRequirements) {
          projectApprovalResolved(activityRun.id, sourceId, parsed.request.commandKind, requirement.paths, context.requestId, requirement.reason)
        }
      }
    }
    return { statusCode: 200, body: result as unknown as Record<string, unknown> }
  }
  const projectCommandActivity = (result: RouteResult): RouteResult => {
    if (parsed.kind !== 'direct' || result.statusCode !== 200 || result.body.status !== 'completed') return result
    const commandKind = parsed.request.commandKind
    if (!['git_diff', 'git_diff_name_only', 'git_diff_stat'].includes(commandKind)) return result
    if (!activityRun) return result
    const paths = Array.isArray(parsed.request.paths)
      ? parsed.request.paths.filter((value): value is string => typeof value === 'string').map(value => normalizeRepoRelativePath(value))
      : []
    appendAgentEvent({
      jobId: activityRun.id,
      sourceId,
      type: 'diff_ready',
      activityKind: 'diff_ready',
      message: paths.length > 0 ? `${commandKind} ready for ${paths.length} path${paths.length === 1 ? '' : 's'}` : `${commandKind} ready`,
      requestId: context.requestId,
      commandKind,
      paths,
      status: 'completed',
      ...(typeof result.body.durationMs === 'number' ? { telemetry: { durationMs: result.body.durationMs } } : {})
    })
    return result
  }
  if (routed.mode === 'legacy') return projectCommandActivity(await dispatch())
  const admitted = await executeWithWorkbenchAdmission({
    requestId: context.requestId,
    sessionId: sessionId || routed.sessionId,
    sourceId,
    operation: classifyParsedRunCommandRequest(parsed),
    operationKind: parsed.kind === 'direct' ? parsed.request.commandKind : parsed.kind,
    execute: dispatch
  })
  if (admitted.ok === false) return { statusCode: admitted.code === 'ADMISSION_BUDGET_REJECTED' || admitted.code === 'ADMISSION_REPOSITORY_REJECTED' ? 409 : 400, body: { ok: false, status: 'blocked', error: { code: admitted.code, message: admitted.message }, ...(contextMetadata ? { contextMetadata } : {}) } }
  return projectCommandActivity(attachCommandMetadata(admitted.result))
}

async function apply(body: Payload, context: PortableExecutionContext): Promise<RouteResult> {
  const changeType = requiredString(body, 'changeType')
  const sourceId = sourceFor(body, context)
  if (['create', 'overwrite', 'patch', 'append', 'delete_file', 'delete_directory', 'move', 'rename', 'mkdir', 'rmdir'].includes(changeType)) {
    const run = resolveActivityRun(sourceId, context)
    const operationKind = `file:${changeType}`
    const requestDigest = run ? buildApprovalRequestDigest(operationKind, body) : undefined
    let approvalIntentConsumed = false
    let effectiveBody = body
    if (run && requestDigest && !hasConfirmationAttempt(body)) {
      const consumed = consumeApprovedApprovalIntent({ sourceId, runId: run.id, sessionId: context.sessionId, operationKind, requestDigest })
      if (consumed.ok === true && consumed.consumed) {
        approvalIntentConsumed = true
        effectiveBody = { ...body, confirmedByUser: true }
      }
    }
    const result = executeWorkbenchFileChangeMutation(effectiveBody, context)
    const requirement = fileApprovalRequirement(changeType, result)
    if (run && requestDigest && requirement) {
      const pending = ensurePendingApprovalIntent({
        sourceId,
        runId: run.id,
        sessionId: context.sessionId,
        requestId: context.requestId,
        operationKind,
        paths: requirement.paths,
        reason: requirement.reason,
        requestDigest
      })
      projectApprovalRequired(run.id, sourceId, requirement, context.requestId, pending.ok === true ? pending.record.approvalId : undefined)
    }
    if (result.statusCode === 200 && result.body.verified === true && result.body.dryRun !== true && result.body.preflight !== true) {
      const paths = fileActivityPaths(changeType, result.body)
      const operation = typeof result.body.operation === 'string'
        ? result.body.operation
        : typeof result.body.changeType === 'string' ? result.body.changeType : changeType
      if (run && requestDigest && hasConfirmationAttempt(body) && !approvalIntentConsumed) {
        consumeMatchingApprovalIntentAfterConfirmedSuccess({ sourceId, runId: run.id, sessionId: context.sessionId, operationKind, requestDigest })
      }
      if (run && (hasConfirmationAttempt(body) || approvalIntentConsumed) && paths.length > 0) {
        projectApprovalResolved(run.id, sourceId, operation, paths, context.requestId)
      }
      if (run && paths.length > 0) {
        appendAgentEvent({
          jobId: run.id,
          sourceId,
          type: 'file_changed',
          activityKind: 'file_changed',
          message: `${changeType} changed ${paths.length === 1 ? paths[0] : `${paths.length} paths`}`,
          requestId: context.requestId,
          paths,
          status: 'completed'
        })
      }
    }
    return result
  }
  const source = requireEnabledSource(sourceId)
  if (changeType === 'create_run') {
    const result = createWorkbenchRun({ sourceId, goal: requiredString(body, 'goal'), documentationPath: typeof body.documentationPath === 'string' ? body.documentationPath : undefined, maxIterations: typeof body.maxIterations === 'number' ? body.maxIterations : undefined, autoCommit: body.autoCommit === true, autoPush: false, autonomyLevel: 'hands_off_safe' })
    return { statusCode: 200, body: { status: 'ok', created: result.created, verified: true, run: getActiveWorkbenchRun(sourceId) || result.run } }
  }
  if (changeType === 'resume_run') {
    resumeWorkbenchRun({ sourceId, runId: typeof body.runId === 'string' ? body.runId : undefined })
    return { statusCode: 200, body: { status: 'ok', resumed: true, verified: true, run: getActiveWorkbenchRun(sourceId) } }
  }
  if (changeType === 'close_run') {
    const run = closeWorkbenchRun({ sourceId, runId: requiredString(body, 'runId'), summary: requiredString(body, 'summary') })
    const activity = body.includeActivity === true
      ? projectPortableActiveRunActivity(sourceId, run.id)
      : undefined
    return {
      statusCode: 200,
      body: {
        status: 'ok',
        closed: true,
        verified: true,
        run,
        ...(activity ? { activity } : {})
      }
    }
  }
  if (changeType === 'packet_preflight') {
    const packet = body.packet as WorkbenchPacket
    if (!packet || packet.sourceId !== sourceId) return { statusCode: 400, body: { error: 'packet.sourceId must match sourceId' } }
    const result = preflightWorkbenchPacket({ packet, sourceRoot: source.path })
    if (!result.accepted) return { statusCode: 409, body: { ...result, verified: false, writesPerformed: false, reservationCreated: false } }
    const reservation = reserveWorkbenchPacket({ packet, exactPaths: result.exactPaths || [] })
    if (reservation.ok === false) return { statusCode: reservation.code === 'PACKET_STORE_BUSY' ? 503 : 409, body: { status: 'rejected', accepted: false, verified: false, writesPerformed: false, reservationCreated: false, packetId: packet.packetId, runId: packet.runId, sourceId, errors: [{ code: reservation.code, message: reservation.message }] } }
    return { statusCode: 200, body: { ...result, status: 'queued', accepted: true, verified: true, writesPerformed: false, reservationCreated: reservation.created, packetStatus: reservation.record.status, reservedAt: reservation.record.reservedAt } }
  }
  if (changeType === 'packet_claim') {
    const workerId = typeof body.workerId === 'string' && body.workerId.trim()
      ? body.workerId : `native-${crypto.createHash('sha256').update(`${context.requestId || ''}|${sourceId}|${String(body.packetId || '')}`).digest('hex').slice(0, 32)}`
    const result = claimNextWorkbenchPacket({ workerId, packetId: typeof body.packetId === 'string' ? body.packetId : undefined, sourceId, runId: typeof body.runId === 'string' ? body.runId : undefined, leaseMs: typeof body.leaseMs === 'number' ? body.leaseMs : undefined })
    if (result.ok === true) {
      return { statusCode: 200, body: { status: 'running', claimed: result.claimed, record: compactWorkbenchPacketLeaseRecord(result.record, true), writesPerformed: false } }
    }
    return { statusCode: result.code === 'PACKET_STORE_BUSY' ? 503 : 409, body: { status: 'rejected', ...result, writesPerformed: false } }
  }
  if (changeType === 'packet_plan') {
    const result = planWorkbenchPacketExecution({ sourceId, packetId: requiredString(body, 'packetId'), leaseToken: requiredString(body, 'leaseToken'), sourceRoot: source.path })
    return { statusCode: result.ready ? 200 : 409, body: result }
  }
  if (changeType === 'packet_execute') {
    const result = await executeWorkbenchPacket({ sourceId, packetId: requiredString(body, 'packetId'), leaseToken: requiredString(body, 'leaseToken'), sourceRoot: source.path })
    return { statusCode: result.status === 'completed' ? 200 : result.status === 'rejected' ? 409 : 500, body: result as unknown as Record<string, unknown> }
  }
  return { statusCode: 400, body: { error: `Unsupported changeType: ${changeType}` } }
}

async function commit(body: Payload, context: PortableExecutionContext): Promise<RouteResult> {
  const sourceId = sourceFor(body, context)
  const sessionId = sessionFor(body, context)
  const paths = body.paths
  if (!Array.isArray(paths) || !paths.every(item => typeof item === 'string') || paths.length === 0) return { statusCode: 400, body: { error: 'paths is required and must not be empty' } }
  const message = requiredString(body, 'message')
  const shared = { version: 2, sessionId, command: { sourceId, timeoutMs: 4500 } }
  const diff = await executeWorkbenchCommandMutation({ ...shared, command: { ...shared.command, commandKind: 'git_diff_stat' } }, { ...context, requestId: `${context.requestId || 'native'}:diff` })
  if (diff.statusCode !== 200 || diff.body.exitCode !== 0) return { statusCode: diff.statusCode, body: { ok: false, step: 'diff', diff: diff.body } }
  const add = await executeWorkbenchCommandMutation({ ...shared, command: { ...shared.command, commandKind: 'git_add_paths', paths, confirmedByUser: body.confirmedByUser === true, confirmationToken: body.confirmationToken } }, { ...context, requestId: `${context.requestId || 'native'}:add` })
  if (add.statusCode !== 200 || add.body.exitCode !== 0) return { statusCode: add.statusCode, body: { ok: false, step: 'add', add: add.body } }
  const commitResult = await executeWorkbenchCommandMutation({ ...shared, command: { ...shared.command, commandKind: 'git_commit', paths, message, body: typeof body.body === 'string' ? body.body : undefined, confirmedByUser: body.confirmedByUser === true, confirmationToken: body.confirmationToken } }, { ...context, requestId: `${context.requestId || 'native'}:commit` })
  const committed = commitResult.statusCode === 200 && commitResult.body.exitCode === 0
  return { statusCode: commitResult.statusCode, body: { ok: committed, diffStat: diff.body.stdout, commitMessage: message, committed, staging: add.body.details, stdout: commitResult.body.stdout, ...(committed ? {} : { stderr: commitResult.body.stderr }) } }
}

/** The only mutation composition boundary used by the native portable host. */
export function createPortableMutationHandlers(): PortableOperationHandlers {
  return {
    applyWorkbenchFileChange: async (payload, context) => {
      const result = await apply(asPayload(payload), context)
      if (result.statusCode >= 400) throwForRouteResult(result)
      return result.body
    },
    commitWorkbenchChanges: async (payload, context) => {
      const result = await commit(asPayload(payload), context)
      if (result.statusCode >= 400 || result.body.ok === false) throwForRouteResult(result)
      return result.body
    },
    runWorkbenchCommand: async (payload, context) => {
      const result = await executeWorkbenchCommandMutation(asPayload(payload), context)
      if (result.statusCode >= 400) throwForRouteResult(result)
      return result.body
    }
  }
}
