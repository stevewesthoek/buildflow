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

console.log('source-scoped search architecture checks passed')
