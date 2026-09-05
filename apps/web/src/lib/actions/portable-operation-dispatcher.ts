import {
  WORKBENCH_OPERATION_IDS,
  WORKBENCH_OPERATION_MUTATION_CLASS,
  type WorkbenchOperationId,
  type WorkbenchOperationRequest,
  type WorkbenchOperationResponse
} from './portable-operation-contract'
import { classifyPortableOperationError } from './portable-operation-errors'

export type PortableExecutionContext = {
  signal?: AbortSignal
  now?: () => Date
  /** Canonical envelope metadata, supplied by the dispatcher and never trusted from the payload. */
  requestId?: string
  sourceId?: string
  sessionId?: string
  /** Existing actor/capability bindings; never inferred from display text. */
  actorId?: string
  capabilityId?: string
  caller?: WorkbenchOperationRequest['caller']
  cancellationId?: string
  /** Internal composition flag: the higher-level mutation handler owns approval activity projection. */
  suppressFileApprovalActivity?: boolean
  telemetry?: (event: { operationId: WorkbenchOperationId; sourceId?: string; mutationClass: string; outcome: 'success' | 'error' }) => void
  sourceResolver?: (sourceId: string) => unknown
  sessionResolver?: (sessionId: string, sourceId?: string) => unknown
}

export type PortableOperationHandler<TPayload = unknown, TResult = unknown> =
  (payload: TPayload, context: PortableExecutionContext) => Promise<TResult> | TResult

export type PortableOperationHandlers = Partial<Record<WorkbenchOperationId, PortableOperationHandler>>

function requestId(): string {
  return `portable-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export function createPortableOperationRequest<TPayload>(input: Omit<WorkbenchOperationRequest<TPayload>, 'protocolVersion' | 'requestId'> & Partial<Pick<WorkbenchOperationRequest<TPayload>, 'requestId'>>): WorkbenchOperationRequest<TPayload> {
  return { protocolVersion: 1, requestId: input.requestId || requestId(), ...input }
}

export async function dispatchPortableOperation<TPayload = unknown, TResult = unknown>(
  request: WorkbenchOperationRequest<TPayload>,
  handlers: PortableOperationHandlers,
  context: PortableExecutionContext = {}
): Promise<WorkbenchOperationResponse<TResult>> {
  const operationId = request.operationId
  const handler = handlers[operationId]
  const mutationClass = WORKBENCH_OPERATION_MUTATION_CLASS[operationId]
  const now = context.now || (() => new Date())
  if (request.protocolVersion !== 1) {
    return errorResponse<TPayload, TResult>(request, 'invalid_request', 'Unsupported portable operation protocol version.')
  }
  if (context.signal?.aborted) return errorResponse<TPayload, TResult>(request, 'cancelled', 'Operation was cancelled before dispatch.')
  if (Date.parse(request.deadlineAt) <= now().getTime()) return errorResponse<TPayload, TResult>(request, 'deadline_exceeded', 'Operation deadline has expired.')
  if (!handler) return errorResponse<TPayload, TResult>(request, 'unknown_operation', `Unknown operation: ${operationId}`)
  try {
    const payload = await handler(request.payload, {
      ...context,
      requestId: request.requestId,
      sourceId: request.sourceId,
      sessionId: request.sessionId,
      cancellationId: request.cancellationId,
      caller: request.caller,
      actorId: context.actorId,
      capabilityId: context.capabilityId
    })
    context.telemetry?.({ operationId, sourceId: request.sourceId, mutationClass, outcome: 'success' })
    return { protocolVersion: 1, requestId: request.requestId, operationId, ok: true, sourceId: request.sourceId, sessionId: request.sessionId, payload: payload as TResult }
  } catch (error) {
    const classified = classifyPortableOperationError(error)
    context.telemetry?.({ operationId, sourceId: request.sourceId, mutationClass, outcome: 'error' })
    return errorResponse<TPayload, TResult>(request, classified.code, classified.message, classified)
  }
}

function errorResponse<TPayload, TResult = never>(request: WorkbenchOperationRequest<TPayload>, code: string, message: string, classified?: ReturnType<typeof classifyPortableOperationError>): WorkbenchOperationResponse<TResult> {
  return {
    protocolVersion: 1,
    requestId: request.requestId,
    operationId: request.operationId,
    ok: false,
    sourceId: request.sourceId,
    sessionId: request.sessionId,
    error: {
      code,
      message,
      retryable: classified?.retryable,
      requiresConfirmation: classified?.requiresConfirmation,
      confirmationToken: classified?.confirmationToken,
      details: classified?.details
    }
  }
}

export function isMutationCapable(operationId: WorkbenchOperationId): boolean {
  return WORKBENCH_OPERATION_MUTATION_CLASS[operationId] === 'mutation_capable'
}

export { WORKBENCH_OPERATION_IDS }
