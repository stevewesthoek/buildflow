import { getSourcesSafe } from './config'
import { handleGraphContext } from './graph-context'
import {
  CbmTransportUnavailableError,
  CbmUnsafeChangedPathError,
  createCodebaseMemoryTransport,
  validateCbmResult,
  type CbmGraphContextTransport
} from './cbm-graph-context'
import {
  recordGraphBackendTelemetry,
  type GraphBackend,
  type GraphFallbackReason,
  type GraphFreshnessState
} from './graph-backend-telemetry'

export type GraphContextBody = { sourceId: string; query?: string; limit?: number }
export type GraphContextResult = { statusCode: number; payload: Record<string, unknown> }

type RouterDependencies = {
  backendValue?: string
  cbmTransport?: CbmGraphContextTransport | null
  graphifyHandler?: typeof handleGraphContext
  timeoutMs?: number
  sourceResolver?: () => Array<{ id: string; path: string; enabled: boolean }>
  telemetryRecorder?: typeof recordGraphBackendTelemetry
}

function backendFrom(value: string | undefined): { backend: GraphBackend; invalid: boolean; requested: string } {
  const requested = String(value || '').trim().toLowerCase()
  if (!requested) return { backend: 'disabled', invalid: false, requested: 'disabled' }
  if (requested === 'disabled' || requested === 'graphify' || requested === 'cbm') {
    return { backend: requested, invalid: false, requested }
  }
  return { backend: 'disabled', invalid: true, requested }
}

function boundedLimit(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return 8
  return Math.max(1, Math.min(10, Math.floor(numeric)))
}

function exactSourceFallback(
  body: GraphContextBody,
  reason: GraphFallbackReason,
  warning: string,
  elapsedMs: number,
  providerDiagnostics: Record<string, unknown> = {}
): GraphContextResult {
  return {
    statusCode: 200,
    payload: {
      mode: 'graph_context',
      sourceId: body.sourceId,
      graphAvailable: false,
      freshness: { status: 'unknown', basis: reason },
      warning,
      nextActions: [
        { mode: 'prepare_task_context', query: body.query || 'Describe the concrete task goal.', limit: 5 }
      ],
      diagnostics: {
        operation: 'graph_context',
        backend: 'exact_source',
        phase: reason,
        elapsedMs,
        ...providerDiagnostics,
        suggestedNextAction: 'Continue with grep_context, read_range, read_symbol, or prepare_task_context.'
      }
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('CBM_TIMEOUT')), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function record(
  sourceId: string | undefined,
  requested: string,
  used: GraphBackend | 'exact_source',
  elapsedMs: number,
  freshnessState: GraphFreshnessState,
  fallbackReason?: GraphFallbackReason,
  recorder: typeof recordGraphBackendTelemetry = recordGraphBackendTelemetry
): void {
  recorder({
    sourceId,
    backendRequested: requested,
    backendUsed: used,
    providerLatencyMs: elapsedMs,
    freshnessState,
    fallbackReason
  })
}

export async function handleGraphContextRouted(
  body: GraphContextBody,
  dependencies: RouterDependencies = {}
): Promise<GraphContextResult> {
  const startedAt = Date.now()
  const selected = backendFrom(dependencies.backendValue ?? process.env.WORKBENCH_GRAPH_BACKEND)
  const sourceId = typeof body?.sourceId === 'string' ? body.sourceId.trim() : ''
  const sourceResolver = dependencies.sourceResolver || getSourcesSafe
  const telemetryRecorder = dependencies.telemetryRecorder || recordGraphBackendTelemetry

  if (!sourceId) return { statusCode: 400, payload: { error: 'sourceId is required' } }
  const source = sourceResolver().find(item => item.id === sourceId && item.enabled)
  if (!source) return { statusCode: 404, payload: { error: `Source not found or disabled: ${sourceId}` } }

  if (selected.invalid || selected.backend === 'disabled') {
    const reason: GraphFallbackReason = selected.invalid ? 'invalid_backend' : 'disabled'
    const elapsedMs = Date.now() - startedAt
    record(sourceId, selected.requested, 'exact_source', elapsedMs, 'not_applicable', reason, telemetryRecorder)
    return exactSourceFallback(body, reason, 'Structural graph backend is disabled. Continue with exact-source navigation.', elapsedMs)
  }

  if (selected.backend === 'graphify') {
    const result = await (dependencies.graphifyHandler || handleGraphContext)(body)
    record(sourceId, selected.requested, 'graphify', Date.now() - startedAt, 'unknown', undefined, telemetryRecorder)
    return result
  }

  const cbmTransport = dependencies.cbmTransport === undefined
    ? createCodebaseMemoryTransport()
    : dependencies.cbmTransport
  if (!cbmTransport) {
    const elapsedMs = Date.now() - startedAt
    record(sourceId, selected.requested, 'exact_source', elapsedMs, 'unknown', 'cbm_transport_unavailable', telemetryRecorder)
    return exactSourceFallback(body, 'cbm_transport_unavailable', 'Codebase Memory transport is not configured. Continue with exact-source navigation.', elapsedMs)
  }

  try {
    const result = validateCbmResult(
      await withTimeout(cbmTransport.resolveGraphContext({
        sourceId,
        sourceRoot: source.path,
        query: body.query,
        limit: boundedLimit(body.limit)
      }), dependencies.timeoutMs || 1500),
      sourceId
    )
    if (result.freshness !== 'fresh') {
      const elapsedMs = Date.now() - startedAt
      record(sourceId, selected.requested, 'exact_source', elapsedMs, result.freshness, 'cbm_stale', telemetryRecorder)
      // Propagate safe structured stale diagnostics from the transport.
      // Never forward: absolute paths, env values, raw changed-file lists, credentials, or stderr.
      const safeKeys = new Set([
        'stage', 'metadataVersion', 'expectedMetadataVersion', 'fingerprintAlgorithm',
        'indexedAtSha', 'currentSha', 'storedFingerprint', 'computedFingerprint',
        'mismatchReason', 'changedPathCountRaw', 'changedPathCountCanonical',
        'changedPathSetDigest', 'providerChangedCount', 'providerVersion',
        'indexedFileCount', 'phaseMs', 'elapsedMs', 'operations', 'expectedAlgorithm'
      ])
      const safeDiagnostics: Record<string, unknown> = {}
      if (result.diagnostics) {
        for (const [k, v] of Object.entries(result.diagnostics)) {
          if (safeKeys.has(k)) safeDiagnostics[k] = v
        }
      }
      if (!safeDiagnostics.stage) safeDiagnostics.stage = 'stale_index'
      return exactSourceFallback(
        body,
        'cbm_stale',
        'Codebase Memory result is stale or freshness is unknown. Continue with exact-source navigation.',
        elapsedMs,
        safeDiagnostics
      )
    }
    const elapsedMs = Date.now() - startedAt
    record(sourceId, selected.requested, 'cbm', elapsedMs, 'fresh', undefined, telemetryRecorder)
    return {
      statusCode: 200,
      payload: {
        mode: 'graph_context',
        sourceId,
        graphAvailable: true,
        freshness: { status: 'fresh', basis: 'codebase_memory' },
        matches: result.matches || [],
        communityHubs: result.communityHubs || [],
        godNodes: result.godNodes || [],
        suggestedFiles: result.suggestedFiles || [],
        suggestedSymbols: result.suggestedSymbols || [],
        warning: 'Codebase Memory is a navigation aid. Verify exact source before patching.',
        nextActions: result.nextActions || [],
        diagnostics: { operation: 'graph_context', backend: 'cbm', elapsedMs, ...(result.diagnostics || {}) }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    let reason: GraphFallbackReason = 'cbm_failed'
    if (error instanceof CbmUnsafeChangedPathError) reason = 'cbm_transport_unavailable'
    else if (error instanceof CbmTransportUnavailableError) reason = 'cbm_transport_unavailable'
    else if (message === 'CBM_TIMEOUT') reason = 'cbm_timeout'
    else if (message.includes('source mismatch')) reason = 'cbm_source_mismatch'
    else if (message.includes('Invalid Codebase Memory')) reason = 'cbm_invalid_response'
    const elapsedMs = Date.now() - startedAt
    const providerStage = error instanceof CbmTransportUnavailableError ? error.stage : undefined
    record(sourceId, selected.requested, 'exact_source', elapsedMs, 'unknown', reason, telemetryRecorder)
    return exactSourceFallback(
      body,
      reason,
      'Codebase Memory could not provide verified current context. Continue with exact-source navigation.',
      elapsedMs,
      providerStage ? { providerStage } : {}
    )
  }
}
