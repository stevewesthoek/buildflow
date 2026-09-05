import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareTaskContext } from './prepare-task-context'

const searcher = { searchBounded: () => ({ results: [], sourceWarnings: [], partial: false }) } as never
const packageValue = { packageId: 'knowledge-context-1', auditReferences: ['knowledge-context-1'], sourceIds: ['knowledge.docs'], files: 1, bytes: 20, tokens: 5, queries: 1, warnings: ['stale knowledge'], documents: [{ providerId: 'knowledge.docs', documentId: 'guide.md', reasons: ['keyword-match'], score: 100, bytes: 20, truncated: false }], sources: [{ providerId: 'knowledge.docs', freshness: 'rev-2', indexGeneration: 3, freshnessState: 'stale' }], diagnostics: { available: true, latencyMs: 2, packageBytes: 400, failures: 0 } }

test('attaches additive knowledge context to confirmed-session task preparation', async () => {
  let calls = 0
  const result = await prepareTaskContext({ query: 'authentication', sourceIds: ['repo'], searcher, knowledgeContext: { sessionId: 'session-1', sourceIds: ['knowledge.docs'], prepare: async input => { calls += 1; assert.equal(input.sessionId, 'session-1'); return { ok: true, package: packageValue } } } })
  assert.equal(calls, 1); assert.equal(result.knowledgeContext?.packageId, 'knowledge-context-1'); assert.deepEqual(result.knowledgeContext?.auditReferences, ['knowledge-context-1']); assert.deepEqual(result.sourceIds, ['knowledge.docs', 'repo']); assert.deepEqual(result.uncertainty, ['No matching files found from the current index.', 'Exact-source verification is incomplete; do not treat navigation or ranking evidence as patch authority.', 'stale knowledge'])
})

test('does not retrieve knowledge without a confirmed-session preparer and fails closed on retrieval failure', async () => {
  const noSession = await prepareTaskContext({ query: 'plain', sourceIds: ['repo'], searcher }); assert.equal(noSession.knowledgeContext, undefined)
  await assert.rejects(() => prepareTaskContext({ query: 'blocked', sourceIds: ['repo'], searcher, knowledgeContext: { sessionId: 'session-2', sourceIds: ['knowledge.docs'], prepare: async () => ({ ok: false as const, code: 'source_not_authorized', message: 'not authorized' }) } }), /source_not_authorized/)
})

test('returns exact evidence and optional CBM navigation in one bounded packet', async () => {
  const readPaths: string[] = []
  const searcher = {
    searchBounded: () => ({
      results: [{ sourceId: 'repo', path: 'src/auth.ts', title: 'auth', score: 0.1, snippet: 'authentication boundary', sizeBytes: 120, modifiedAt: '2026-08-28T00:00:00.000Z' }],
      sourceWarnings: [],
      partial: false
    })
  } as never
  const result = await prepareTaskContext({
    query: 'MCP authentication architecture',
    sourceIds: ['repo'],
    searcher,
    structuralContext: {
      resolve: async () => ({
        graphAvailable: true,
        freshness: { status: 'fresh', basis: 'codebase_memory' },
        suggestedFiles: ['src/auth.ts'],
        suggestedSymbols: ['authorizeRequest'],
        matches: ['authorizeRequest -> readWorkbenchContext'],
        diagnostics: { backend: 'cbm', providerId: 'codebase-memory-mcp', providerVersion: '0.9.0' }
      })
    },
    readExactFile: async (path, sourceId) => {
      readPaths.push(`${sourceId}:${path}`)
      return { path, content: 'export function authorizeRequest() { return true }' }
    }
  })

  assert.deepEqual(readPaths, ['repo:src/auth.ts'])
  assert.equal(result.exactVerification, true)
  assert.equal(result.exactEvidence.length, 1)
  assert.equal(result.exactEvidence[0]?.verification, 'exact_source_read')
  assert.equal(result.exactEvidence[0]?.content.includes('authorizeRequest'), true)
  assert.equal(result.exactReadPlan.length, 0)
  assert.equal(result.topFiles[0]?.exactVerified, true)
  assert.equal(result.navigationEvidence?.graphAvailable, true)
  assert.equal(result.navigationEvidence?.provider, 'codebase-memory-mcp')
  assert.equal(result.navigationEvidence?.relationships[0], 'authorizeRequest -> readWorkbenchContext')
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 8 * 1024)
})

test('fails closed when exact source verification is incomplete', async () => {
  let readCalls = 0
  const result = await prepareTaskContext({
    query: 'provider architecture',
    sourceIds: ['repo'],
    searcher: {
      searchBounded: () => ({ results: [{ sourceId: 'repo', path: 'docs/provider.md', score: 0.2, snippet: 'provider', sizeBytes: 120 * 1024 }], sourceWarnings: [], partial: false })
    } as never,
    structuralContext: { resolve: async () => ({ graphAvailable: false, freshness: { status: 'stale', basis: 'commit' }, suggestedFiles: [], suggestedSymbols: [], matches: [] }) },
    readExactFile: async () => { readCalls += 1; return { path: 'docs/provider.md', content: 'should not be read' } }
  })

  assert.equal(readCalls, 0)
  assert.equal(result.exactVerification, false)
  assert.equal(result.exactEvidence.length, 0)
  assert.equal(result.exactReadPlan[0]?.suggestedMode, 'grep_context')
  assert.ok(result.uncertainty.some(item => item.includes('Exact-source verification is incomplete')))
})

test('keeps a five-file packet within the 8 KiB public budget', async () => {
  const results = Array.from({ length: 5 }, (_, index) => ({ sourceId: 'repo', path: `src/file-${index}.ts`, score: index / 10, snippet: 'candidate '.repeat(80), sizeBytes: 9000 }))
  const result = await prepareTaskContext({
    query: 'plain investigation',
    sourceIds: ['repo'],
    limit: 5,
    maxBytesPerFile: 4000,
    searcher: { searchBounded: () => ({ results, sourceWarnings: [], partial: false }) } as never,
    readExactFile: async path => ({ path, content: 'x'.repeat(4_000) })
  })

  assert.equal(result.exactVerification, true)
  assert.equal(result.exactEvidence.length, 5)
  assert.ok(result.exactEvidence.every(item => item.truncated))
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 8 * 1024)
})
