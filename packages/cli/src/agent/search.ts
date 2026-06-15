import Fuse from 'fuse.js'
import type { FuseResult } from 'fuse.js'
import { IndexedDoc, SearchResult } from '@workbench/shared'

type SearchMode = 'path' | 'content'

type SourceIndex = {
  sourceId: string
  docs: IndexedDoc[]
  pathFuse: Fuse<IndexedDoc>
  contentFuse: Fuse<IndexedDoc>
}

const DEFAULT_LIMIT = 10
const CONTENT_QUERY_PREFIX = 'content:'
const FULL_TEXT_QUERY_PREFIX = 'full:'

function normalizeSourceIds(sourceIds?: string[]): string[] | undefined {
  if (!Array.isArray(sourceIds)) return undefined
  const normalized = Array.from(new Set(sourceIds.filter(id => typeof id === 'string' && id.trim().length > 0).map(id => id.trim())))
  return normalized.length > 0 ? normalized : undefined
}

function parseQueryMode(query: string): { mode: SearchMode; query: string } {
  const trimmed = query.trim()
  if (trimmed.toLowerCase().startsWith(CONTENT_QUERY_PREFIX)) {
    return { mode: 'content', query: trimmed.slice(CONTENT_QUERY_PREFIX.length).trim() }
  }
  if (trimmed.toLowerCase().startsWith(FULL_TEXT_QUERY_PREFIX)) {
    return { mode: 'content', query: trimmed.slice(FULL_TEXT_QUERY_PREFIX.length).trim() }
  }
  return { mode: 'path', query: trimmed }
}

function makePathFuse(docs: IndexedDoc[]): Fuse<IndexedDoc> {
  return new Fuse(docs, {
    keys: [
      { name: 'path', weight: 0.65 },
      { name: 'title', weight: 0.25 },
      { name: 'tags', weight: 0.1 }
    ],
    threshold: 0.35,
    ignoreLocation: true,
    includeScore: true
  })
}

function makeContentFuse(docs: IndexedDoc[]): Fuse<IndexedDoc> {
  return new Fuse(docs, {
    keys: [
      { name: 'path', weight: 0.25 },
      { name: 'title', weight: 0.15 },
      { name: 'tags', weight: 0.05 },
      { name: 'content', weight: 0.55 }
    ],
    threshold: 0.3,
    ignoreLocation: true,
    includeScore: true
  })
}

export class VaultSearcher {
  private indexesBySource = new Map<string, SourceIndex>()
  private sourceOrder: string[] = []

  constructor(docs: IndexedDoc[]) {
    this.rebuild(docs)
  }

  rebuild(docs: IndexedDoc[]): void {
    const grouped = new Map<string, IndexedDoc[]>()
    for (const doc of docs) {
      const sourceDocs = grouped.get(doc.sourceId) || []
      sourceDocs.push(doc)
      grouped.set(doc.sourceId, sourceDocs)
    }

    this.indexesBySource = new Map()
    this.sourceOrder = []
    for (const [sourceId, sourceDocs] of grouped.entries()) {
      this.sourceOrder.push(sourceId)
      this.indexesBySource.set(sourceId, {
        sourceId,
        docs: sourceDocs,
        pathFuse: makePathFuse(sourceDocs),
        contentFuse: makeContentFuse(sourceDocs)
      })
    }
  }

  search(query: string, limit: number = DEFAULT_LIMIT, sourceIds?: string[]): SearchResult[] {
    const parsed = parseQueryMode(query)
    if (!parsed.query) return []

    const normalizedSourceIds = normalizeSourceIds(sourceIds)
    const selectedSourceIds = normalizedSourceIds || this.sourceOrder
    const boundedLimit = Math.max(1, Math.min(50, Math.floor(limit || DEFAULT_LIMIT)))
    const perSourceLimit = Math.max(boundedLimit, Math.ceil(boundedLimit / Math.max(selectedSourceIds.length, 1)) + 3)
    const matches: Array<{ result: FuseResult<IndexedDoc>; sourceId: string }> = []

    for (const sourceId of selectedSourceIds) {
      const index = this.indexesBySource.get(sourceId)
      if (!index) continue
      const fuse = parsed.mode === 'content' ? index.contentFuse : index.pathFuse
      const sourceResults = fuse.search(parsed.query, { limit: perSourceLimit })
      for (const result of sourceResults) {
        matches.push({ result, sourceId })
      }
    }

    return matches
      .sort((a, b) => (a.result.score || 0) - (b.result.score || 0))
      .slice(0, boundedLimit)
      .map(({ result }) => ({
        sourceId: result.item.sourceId,
        path: result.item.path,
        title: result.item.title,
        score: result.score || 0,
        snippet: this.extractSnippet(result.item, parsed.query, parsed.mode),
        modifiedAt: result.item.modifiedAt,
        sizeBytes: result.item.size
      }))
  }

  private extractSnippet(doc: IndexedDoc, query: string, mode: SearchMode, contextLength: number = 100): string {
    if (mode === 'path') {
      return doc.contentPreview ? `${doc.contentPreview.slice(0, 200)}...` : `${doc.path}...`
    }

    const queryWords = query.toLowerCase().split(/\s+/).filter(Boolean)
    const lowerContent = doc.content.toLowerCase()

    for (const word of queryWords) {
      const idx = lowerContent.indexOf(word)
      if (idx !== -1) {
        const start = Math.max(0, idx - contextLength)
        const end = Math.min(doc.content.length, idx + contextLength + word.length)
        return doc.content.slice(start, end) + '...'
      }
    }

    return doc.contentPreview ? `${doc.contentPreview.slice(0, 200)}...` : doc.content.slice(0, 200) + '...'
  }
}
