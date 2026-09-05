import path from 'node:path'
import { getSourcesSafe } from './config'
import { getCodebaseMemoryProviderDiagnostics } from './cbm-graph-context'
import { getIndexedDocumentCountFromDisk } from './indexer'
import { collectIndexQueueDiagnostics } from './index-queue-observability'

export type LocalDiagnosticsRequestContext = {
  activeRequests: number
  peakActiveRequests: number
  sourceId?: string
}

let lastCpuUsage = process.cpuUsage()
let lastCpuSampleAt = Date.now()
let recentCpuPercent = 0
let recentCpuSampleWindowMs = 0

function sampleProcessCpu(): void {
  const sampledAt = Date.now()
  const elapsedMs = Math.max(1, sampledAt - lastCpuSampleAt)
  const usage = process.cpuUsage(lastCpuUsage)
  recentCpuPercent = Number((((usage.user + usage.system) / (elapsedMs * 1_000)) * 100).toFixed(2))
  recentCpuSampleWindowMs = elapsedMs
  lastCpuUsage = process.cpuUsage()
  lastCpuSampleAt = sampledAt
}

export function collectLocalDiagnostics(context: LocalDiagnosticsRequestContext = { activeRequests: 0, peakActiveRequests: 0 }): Record<string, unknown> {
  sampleProcessCpu()
  const sources = getSourcesSafe()
  const ordinaryIndex = {
    indexedFiles: getIndexedDocumentCountFromDisk(),
    sourceCount: sources.length,
    readySources: sources.filter(source => source.indexStatus === 'ready').length,
    pendingSources: sources.filter(source => source.indexStatus === 'pending').length,
    indexingSources: sources.filter(source => source.indexStatus === 'indexing').length,
    failedSources: sources.filter(source => source.indexStatus === 'failed').length,
    disabledSources: sources.filter(source => source.indexStatus === 'disabled').length,
    sourceIdsByStatus: {
      ready: sources.filter(source => source.indexStatus === 'ready').map(source => source.id),
      pending: sources.filter(source => source.indexStatus === 'pending').map(source => source.id),
      indexing: sources.filter(source => source.indexStatus === 'indexing').map(source => source.id),
      failed: sources.filter(source => source.indexStatus === 'failed').map(source => source.id)
    }
  }
  const queue = collectIndexQueueDiagnostics({ sources })
  const structuralRoot = path.resolve(process.env.WORKBENCH_REPOSITORY_ROOT || process.cwd())
  const requestedSourceId = context.sourceId?.trim()
  const structuralSource = requestedSourceId
    ? sources.find(source => source.id === requestedSourceId)
    : sources.find(source => path.resolve(source.path) === structuralRoot)
  const memory = process.memoryUsage()
  return {
    generatedAt: new Date().toISOString(),
    process: {
      pid: process.pid,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      activeRequests: context.activeRequests,
      peakActiveRequests: context.peakActiveRequests,
      recentCpuPercent,
      recentCpuSampleWindowMs
    },
    ordinaryIndex: {
      ...ordinaryIndex,
      activeReindexes: ordinaryIndex.indexingSources
    },
    queue: {
      ...queue.pressure,
      activeReindexes: ordinaryIndex.indexingSources,
      pendingSourceCount: ordinaryIndex.pendingSources + ordinaryIndex.indexingSources
    },
    ...(structuralSource ? { sourceId: structuralSource.id } : {}),
    cbm: getCodebaseMemoryProviderDiagnostics({
      sourceId: structuralSource?.id || path.basename(structuralRoot),
      sourceRoot: structuralSource?.path || structuralRoot
    })
  }
}
