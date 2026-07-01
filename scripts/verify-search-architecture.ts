import assert from 'node:assert/strict'
import { VaultSearcher } from '../packages/cli/src/agent/search'
import type { IndexedDoc } from '../packages/shared/src/types'

function doc(sourceId: string, path: string, content: string): IndexedDoc {
  return {
    sourceId,
    id: `${sourceId}:${path}`,
    path,
    title: path.split('/').pop() || path,
    extension: path.includes('.') ? `.${path.split('.').pop()}` : '',
    modifiedAt: new Date(0).toISOString(),
    size: content.length,
    tags: [],
    contentPreview: content.slice(0, 200),
    content
  }
}

const searcher = new VaultSearcher([
  doc('brain', 'projects/brain-console-obsidian/src/index.ts', 'console bridge and obsidian plugin entrypoint'),
  doc('brain', 'docs/notes/architecture.md', 'brain local notes'),
  doc('buildflow', 'packages/cli/src/agent/search.ts', 'source scoped fuse search implementation'),
  doc('buildflow', 'docs/product/architecture.md', 'index architecture for BuildFlow')
])

const brainOnly = searcher.search('search', 10, ['brain'])
assert(brainOnly.every(result => result.sourceId === 'brain'), 'brain scoped search must not return buildflow results')

const buildflowOnly = searcher.search('search', 10, ['buildflow'])
assert(buildflowOnly.length > 0, 'buildflow scoped search should find buildflow search path')
assert(buildflowOnly.every(result => result.sourceId === 'buildflow'), 'scoped search must only return requested source results')

const contentScoped = searcher.search('content:obsidian', 10, ['brain'])
assert(contentScoped.length > 0, 'content-prefixed search should search file content')
assert(contentScoped.every(result => result.sourceId === 'brain'), 'content search must remain source-scoped')

const allSources = searcher.search('architecture', 10)
assert(allSources.some(result => result.sourceId === 'brain'), 'unscoped search may include brain results')
assert(allSources.some(result => result.sourceId === 'buildflow'), 'unscoped search may include buildflow results')

const largeSourceDocs = Array.from({ length: 120 }, (_, index) => (
  doc('brain-large', `types/module-${index}.md`, `module ${index} typed contract notes`)
))
const largeSearcher = new VaultSearcher(largeSourceDocs)

const boundedPathStartedAt = Date.now()
const boundedPath = largeSearcher.searchBounded('types', 5, ['brain-large'], {
  maxDocsPerSource: 15,
  maxContentDocsPerSource: 8,
  deadlineMs: 500
})
assert(Date.now() - boundedPathStartedAt < 500, 'bounded path search must return within its deadline budget')
assert.equal(boundedPath.partial, true, 'large source path search should report partial bounded results')
assert(boundedPath.searchedDocCount <= 15, 'large source path search must not search every indexed doc')
assert(boundedPath.sourceWarnings.some(warning => warning.reason === 'large_source_bounded'), 'large source path search must warn when bounded')
assert(boundedPath.results.length > 0, 'bounded large source path search should still return candidates')

const boundedContent = largeSearcher.searchBounded('content:contract', 5, ['brain-large'], {
  maxDocsPerSource: 15,
  maxContentDocsPerSource: 8,
  deadlineMs: 500
})
assert.equal(boundedContent.partial, true, 'large source content search should report partial bounded results')
assert(boundedContent.searchedDocCount <= 8, 'large source content search must use the smaller content cap')
assert(boundedContent.sourceWarnings.some(warning => warning.reason === 'content_search_bounded'), 'large source content search must warn when bounded')

const noFastCandidates = largeSearcher.searchBounded('definitely-not-indexed', 5, ['brain-large'], {
  maxDocsPerSource: 15,
  maxContentDocsPerSource: 8,
  deadlineMs: 500
})
assert.equal(noFastCandidates.results.length, 0, 'large source search with no fast candidates should fail closed')
assert(noFastCandidates.sourceWarnings.some(warning => warning.reason === 'no_fast_candidates'), 'large source search with no candidates must return a narrowing warning')

console.log('source-scoped search architecture checks passed')
