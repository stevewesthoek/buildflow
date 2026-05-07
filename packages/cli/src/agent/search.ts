import Fuse from 'fuse.js'
import { IndexedDoc, SearchResult } from '@buildflow/shared'

export class VaultSearcher {
  private fuse: Fuse<IndexedDoc>

  constructor(docs: IndexedDoc[]) {
    this.fuse = new Fuse(docs, {
      keys: ['path', 'title', 'tags', 'content'],
      threshold: 0.3,
      includeScore: true
    })
  }

  search(query: string, limit: number = 10, sourceIds?: string[]): SearchResult[] {
    const searchLimit = sourceIds && sourceIds.length > 0 ? limit * 3 : limit
    const results = this.fuse.search(query, { limit: searchLimit })
    const filtered = sourceIds && sourceIds.length > 0
      ? results.filter(result => sourceIds.includes(result.item.sourceId)).slice(0, limit)
      : results.slice(0, limit)

    return filtered.map(result => ({
      sourceId: result.item.sourceId,
      path: result.item.path,
      title: result.item.title,
      score: result.score || 0,
      snippet: this.extractSnippet(result.item.content, query),
      modifiedAt: result.item.modifiedAt
    }))
  }

  private extractSnippet(content: string, query: string, contextLength: number = 100): string {
    const queryWords = query.toLowerCase().split(/\s+/)
    const lowerContent = content.toLowerCase()

    for (const word of queryWords) {
      const idx = lowerContent.indexOf(word)
      if (idx !== -1) {
        const start = Math.max(0, idx - contextLength)
        const end = Math.min(content.length, idx + contextLength + word.length)
        return content.slice(start, end) + '...'
      }
    }

    return content.slice(0, 200) + '...'
  }
}
