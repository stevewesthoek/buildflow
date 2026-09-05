import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ContextIntelligenceDoctor } from './context-intelligence-doctor'
import { recordMcpContextConsumption } from './mcp-context-observability'

test('projects bounded knowledge runtime status into doctor output deterministically', () => {
  const status = { initialized: true, readiness: 'warning' as const, enabledProviders: ['z-provider', 'a-provider'], availableProviders: ['a-provider'], providerCount: 2, providers: [{ providerId: 'a-provider', registryHealth: 'healthy', available: true, indexReady: true, indexGeneration: 2 }, { providerId: 'z-provider', registryHealth: 'unavailable', available: false, indexReady: false, indexGeneration: 0, failure: 'offline' }], retrievalReady: true, lastInitializedAt: '2026-01-01T00:00:00.000Z', retrievalFailures: 1, warnings: ['z-provider: offline'], failedProviders: [{ providerId: 'z-provider', reason: 'offline' }] }
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-doctor-context-'))
  try {
    const mcpObservability = { storePath: path.join(rootDir, 'metrics.json') }
    recordMcpContextConsumption({ outcome: 'success', sessionId: 'session-1', sourceIds: ['repo'], providerIds: ['a-provider'], packageId: 'package-1', freshnessWarnings: 0, packageBytes: 20, retrievalLatencyMs: 1, preparationLatencyMs: 2 }, mcpObservability)
    const report = new ContextIntelligenceDoctor({ sources: [], knowledgeRuntimeLoader: () => status, mcpObservability }).report()
    assert.equal(report.knowledgeRuntime?.readiness, 'warning'); assert.deepEqual(report.knowledgeRuntime?.providers.map(item => item.providerId), ['a-provider', 'z-provider']); assert.equal(report.mcpContext?.status, 'ready'); assert.equal(report.mcpContext?.metrics.successfulDeliveries, 1); assert.equal(JSON.stringify(report).includes('document content'), false)
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }) }
})
