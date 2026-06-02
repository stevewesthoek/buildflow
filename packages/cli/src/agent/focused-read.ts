import { promises as fsp } from 'fs'
import { resolveSafePath } from './vault'
import { redactSecrets } from './safe-access'

type FocusedReadMode = 'grep_context' | 'read_range' | 'read_symbol' | 'search_and_read'

type FocusedReadBody = {
  mode: FocusedReadMode
  sourceId: string
  path: string
  pattern?: string
  query?: string
  regex?: boolean
  before?: number
  after?: number
  maxMatches?: number
  startLine?: number
  endLine?: number
  symbol?: string
}

type FocusedReadResult = {
  statusCode: number
  payload: Record<string, unknown>
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(min, Math.min(max, Math.floor(numeric)))
}

function numberedLines(lines: string[], startLine: number, endLine: number) {
  const safeStart = Math.max(1, startLine)
  const safeEnd = Math.min(lines.length, endLine)
  return lines.slice(safeStart - 1, safeEnd).map((content, index) => ({
    line: safeStart + index,
    content
  }))
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildDiagnostics(params: {
  operation: string
  path: string
  fileSize?: number
  elapsedMs: number
  phase: string
  suggestedNarrowerMode: string
}) {
  return {
    operation: params.operation,
    path: params.path,
    fileSize: params.fileSize,
    elapsedMs: params.elapsedMs,
    phase: params.phase,
    suggestedNarrowerMode: params.suggestedNarrowerMode
  }
}

async function readFocusedFile(sourceId: string, relPath: string) {
  if (!sourceId || typeof sourceId !== 'string') throw new Error('sourceId is required')
  if (!relPath || typeof relPath !== 'string') throw new Error('path is required')
  const fullPath = await resolveSafePath(relPath, sourceId)
  const stat = await fsp.stat(fullPath)
  if (!stat.isFile()) throw new Error('Not a file')
  const raw = await fsp.readFile(fullPath, 'utf8')
  const content = redactSecrets(raw)
  return {
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    content,
    lines: content.split(/\r?\n/)
  }
}

function findSymbolRange(content: string, lines: string[], symbol: string) {
  const escaped = escapeRegExp(symbol)
  const declaration = new RegExp(`\\b(class|function|const|let|var)\\s+${escaped}\\b|\\b${escaped}\\s*[:=]\\s*|\\b${escaped}\\s*\\(`)
  const lineIndex = lines.findIndex(line => declaration.test(line))
  if (lineIndex < 0) return null

  const charOffsets: number[] = []
  let offset = 0
  for (const line of lines) {
    charOffsets.push(offset)
    offset += line.length + 1
  }

  const startOffset = charOffsets[lineIndex]
  const braceStart = content.indexOf('{', startOffset)
  if (braceStart < 0) {
    return { startLine: lineIndex + 1, endLine: Math.min(lines.length, lineIndex + 40) }
  }

  let depth = 0
  for (let index = braceStart; index < content.length; index += 1) {
    const char = content[index]
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        const endLine = content.slice(0, index + 1).split(/\r?\n/).length
        return { startLine: lineIndex + 1, endLine }
      }
    }
  }

  return { startLine: lineIndex + 1, endLine: Math.min(lines.length, lineIndex + 160) }
}

export async function handleFocusedRead(body: FocusedReadBody): Promise<FocusedReadResult> {
  const startedAt = Date.now()
  const operation = body?.mode || 'grep_context'
  const relPath = body?.path || ''
  let fileSize: number | undefined
  let phase = 'resolve_file'

  try {
    const file = await readFocusedFile(body.sourceId, relPath)
    fileSize = file.sizeBytes

    if (operation === 'read_range') {
      phase = 'read_range'
      const startLine = boundedInt(body.startLine, 1, 1, file.lines.length || 1)
      const endLine = boundedInt(body.endLine, startLine, startLine, Math.min(file.lines.length || startLine, startLine + 400))
      return {
        statusCode: 200,
        payload: {
          mode: operation,
          sourceId: body.sourceId,
          path: relPath,
          startLine,
          endLine,
          totalLines: file.lines.length,
          sizeBytes: file.sizeBytes,
          modifiedAt: file.modifiedAt,
          lines: numberedLines(file.lines, startLine, endLine),
          diagnostics: buildDiagnostics({ operation, path: relPath, fileSize, elapsedMs: Date.now() - startedAt, phase: 'completed', suggestedNarrowerMode: 'grep_context' })
        }
      }
    }

    if (operation === 'read_symbol') {
      phase = 'read_symbol'
      const symbol = typeof body.symbol === 'string' ? body.symbol.trim() : ''
      if (!symbol) {
        return { statusCode: 400, payload: { error: 'symbol is required' } }
      }
      const range = findSymbolRange(file.content, file.lines, symbol)
      if (!range) {
        return {
          statusCode: 404,
          payload: {
            error: `Symbol not found: ${symbol}`,
            mode: operation,
            sourceId: body.sourceId,
            path: relPath,
            symbol,
            sizeBytes: file.sizeBytes,
            totalLines: file.lines.length,
            diagnostics: buildDiagnostics({ operation, path: relPath, fileSize, elapsedMs: Date.now() - startedAt, phase: 'symbol_not_found', suggestedNarrowerMode: 'grep_context' })
          }
        }
      }
      return {
        statusCode: 200,
        payload: {
          mode: operation,
          sourceId: body.sourceId,
          path: relPath,
          symbol,
          startLine: range.startLine,
          endLine: range.endLine,
          totalLines: file.lines.length,
          sizeBytes: file.sizeBytes,
          modifiedAt: file.modifiedAt,
          lines: numberedLines(file.lines, range.startLine, range.endLine),
          diagnostics: buildDiagnostics({ operation, path: relPath, fileSize, elapsedMs: Date.now() - startedAt, phase: 'completed', suggestedNarrowerMode: 'read_range' })
        }
      }
    }

    phase = operation === 'search_and_read' ? 'degrade_search_and_read_to_grep_context' : 'grep_context'
    const pattern = typeof body.pattern === 'string'
      ? body.pattern
      : typeof body.query === 'string'
        ? body.query.replace(/^(content|full):/i, '')
        : ''
    if (!pattern) {
      return { statusCode: 400, payload: { error: 'pattern or query is required' } }
    }

    const before = boundedInt(body.before, 5, 0, 80)
    const after = boundedInt(body.after, 5, 0, 80)
    const maxMatches = boundedInt(body.maxMatches, 5, 1, 25)
    const matcher = body.regex === true
      ? new RegExp(pattern)
      : new RegExp(escapeRegExp(pattern))
    const matches: Array<Record<string, unknown>> = []

    for (let index = 0; index < file.lines.length && matches.length < maxMatches; index += 1) {
      matcher.lastIndex = 0
      if (!matcher.test(file.lines[index])) continue
      const matchLine = index + 1
      const startLine = Math.max(1, matchLine - before)
      const endLine = Math.min(file.lines.length, matchLine + after)
      matches.push({
        matchLine,
        startLine,
        endLine,
        lines: numberedLines(file.lines, startLine, endLine)
      })
    }

    return {
      statusCode: 200,
      payload: {
        mode: operation === 'search_and_read' ? 'grep_context' : operation,
        degradedFrom: operation === 'search_and_read' ? 'search_and_read' : undefined,
        sourceId: body.sourceId,
        path: relPath,
        pattern,
        regex: body.regex === true,
        before,
        after,
        maxMatches,
        matchCount: matches.length,
        totalLines: file.lines.length,
        sizeBytes: file.sizeBytes,
        modifiedAt: file.modifiedAt,
        matches,
        suggestedNextMode: 'read_range',
        diagnostics: buildDiagnostics({ operation, path: relPath, fileSize, elapsedMs: Date.now() - startedAt, phase: 'completed', suggestedNarrowerMode: 'read_range' })
      }
    }
  } catch (err) {
    return {
      statusCode: 400,
      payload: {
        error: String(err),
        diagnostics: buildDiagnostics({
          operation,
          path: relPath,
          fileSize,
          elapsedMs: Date.now() - startedAt,
          phase,
          suggestedNarrowerMode: operation === 'read_range' ? 'grep_context' : 'read_range'
        })
      }
    }
  }
}
