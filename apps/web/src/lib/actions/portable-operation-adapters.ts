import {
  dispatchWorkbenchCommand as existingCommand,
  dispatchWorkbenchFileChange as existingFileChange,
  dispatchWorkbenchInspect as existingInspect,
  dispatchWorkbenchRead as existingRead,
  getWorkbenchActiveContext as existingActiveContext,
  listWorkbenchSources as existingSources
} from './gpt'
import type { ActionTransportOptions } from './transport'
import { dispatchPortableOperation, createPortableOperationRequest } from './portable-operation-dispatcher'
import type { WorkbenchOperationId } from './portable-operation-contract'

function deadlineFor(options?: ActionTransportOptions): string {
  const timeoutMs = typeof options?.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) ? options.timeoutMs : 30_000
  return new Date(Date.now() + Math.max(1, timeoutMs)).toISOString()
}

async function throughPortable<T>(operationId: WorkbenchOperationId, payload: unknown, handler: () => Promise<T>, options?: ActionTransportOptions): Promise<T> {
  let originalError: unknown
  const response = await dispatchPortableOperation(
    createPortableOperationRequest({ operationId, deadlineAt: deadlineFor(options), payload }),
    { [operationId]: async () => {
      try {
        return await handler()
      } catch (error) {
        originalError = error
        throw error
      }
    } },
    { signal: options?.signal }
  )
  if (!response.ok) throw originalError || new Error(response.error?.message || response.error?.code || 'Portable operation failed')
  return response.payload as T
}

export function listWorkbenchSources(userToken?: string, options?: ActionTransportOptions) {
  return throughPortable('getWorkbenchStatus', { include: 'sources' }, () => existingSources(userToken, options), options)
}

export function getWorkbenchActiveContext(userToken?: string, options?: ActionTransportOptions) {
  return throughPortable('getWorkbenchStatus', { include: 'active' }, () => existingActiveContext(userToken, options), options)
}

export function dispatchWorkbenchInspect(body: Record<string, unknown>, userToken?: string, options?: ActionTransportOptions) {
  return throughPortable('readWorkbenchContext', body, () => existingInspect(body, userToken, options), options)
}

export function dispatchWorkbenchRead(body: Record<string, unknown>, userToken?: string, options?: ActionTransportOptions) {
  return throughPortable('readWorkbenchContext', body, () => existingRead(body, userToken, options), options)
}

export function dispatchWorkbenchFileChange(body: Record<string, unknown>, userToken?: string, options?: ActionTransportOptions) {
  return throughPortable('applyWorkbenchFileChange', body, () => existingFileChange(body, userToken, options), options)
}

export function dispatchWorkbenchCommand(body: Record<string, unknown>, userToken?: string, options?: ActionTransportOptions) {
  return throughPortable('runWorkbenchCommand', body, () => existingCommand(body, userToken, options), options)
}
