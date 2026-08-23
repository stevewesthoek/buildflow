import {
  inspectRepository,
  listSourceDetails,
  addRepository,
  removeSourceRegistration,
  setSourceEnabledSafe,
  refreshSourceMetadata,
  addBranchSource,
  registerExistingWorktree,
  removeBranchSource,
  SourceManagementError
} from './source-management'
import type { PortableOperationHandlers } from '../../../../apps/web/src/lib/actions/portable-operation-dispatcher'
import { PortableOperationError } from '../../../../apps/web/src/lib/actions/portable-operation-errors'

type Payload = Record<string, unknown>

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function requireString(payload: Payload, key: string): string {
  const v = asString(payload[key])
  if (!v) throw new PortableOperationError('invalid_request', `${key} is required`)
  return v
}

function toPortableError(err: unknown): never {
  if (err instanceof SourceManagementError) {
    const code = err.code === 'not_found' ? 'source_mismatch'
      : err.code === 'path_traversal' ? 'policy_rejected'
      : err.code === 'not_initialized' ? 'dependency_unavailable'
      : err.code === 'duplicate_path' || err.code === 'duplicate_id' || err.code === 'duplicate_branch_source' ? 'invalid_request'
      : 'command_failed'
    throw new PortableOperationError(code, err.message)
  }
  throw new PortableOperationError('command_failed', err instanceof Error ? err.message : String(err))
}

export function createSourceManagementHandlers(): PortableOperationHandlers {
  return {
    inspectRepository: (payload) => {
      const p = payload as Payload
      const dirPath = requireString(p, 'path')
      try { return inspectRepository(dirPath) } catch (err) { toPortableError(err) }
    },

    listSourceDetails: () => {
      try { return { sources: listSourceDetails() } } catch (err) { toPortableError(err) }
    },

    addRepository: (payload) => {
      const p = payload as Payload
      const dirPath = requireString(p, 'path')
      const label = asString(p.label)
      const id = asString(p.id)
      try { return addRepository(dirPath, label, id) } catch (err) { toPortableError(err) }
    },

    removeSource: (payload) => {
      const p = payload as Payload
      const sourceId = requireString(p, 'sourceId')
      try { return removeSourceRegistration(sourceId) } catch (err) { toPortableError(err) }
    },

    setSourceEnabled: (payload) => {
      const p = payload as Payload
      const sourceId = requireString(p, 'sourceId')
      if (typeof p.enabled !== 'boolean') throw new PortableOperationError('invalid_request', 'enabled (boolean) is required')
      try { return setSourceEnabledSafe(sourceId, p.enabled as boolean) } catch (err) { toPortableError(err) }
    },

    refreshSourceMetadata: (payload) => {
      const p = payload as Payload
      const sourceId = requireString(p, 'sourceId')
      try { return refreshSourceMetadata(sourceId) } catch (err) { toPortableError(err) }
    },

    addBranchSource: (payload) => {
      const p = payload as Payload
      const parentSourceId = requireString(p, 'parentSourceId')
      const branchName = requireString(p, 'branchName')
      try { return addBranchSource(parentSourceId, branchName) } catch (err) { toPortableError(err) }
    },

    registerExistingWorktree: (payload) => {
      const p = payload as Payload
      const dirPath = requireString(p, 'path')
      const parentSourceId = requireString(p, 'parentSourceId')
      const label = asString(p.label)
      try { return registerExistingWorktree(dirPath, parentSourceId, label) } catch (err) { toPortableError(err) }
    },

    removeBranchSource: (payload) => {
      const p = payload as Payload
      const sourceId = requireString(p, 'sourceId')
      try { return removeBranchSource(sourceId) } catch (err) { toPortableError(err) }
    }
  }
}
