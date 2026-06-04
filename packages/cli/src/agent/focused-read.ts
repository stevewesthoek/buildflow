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

const MAX_RESPONSE_BYTES = 24_000
const MAX_RANGE_LINES = 250
const DEFAULT_GREP_BEFORE = 8
const DEFAULT_GREP_AFTER = 12
const MAX_GREP_BEFORE = 40
const MAX_GREP_AFTER = 60
const MAX_GREP_MATCHES = 10
const DEFAULT_GREP_MATCHES = 5
const MAX_LINE_CHARS = 1000
const MAX_REGEX_PATTERN_CHARS = 160

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(min, Math.min(max, Math.floor(numeric)))
}

function clampLine(content: string): { content: string; truncated: boolean } {
  if (content.length <= MAX_LINE_CHARS) return { content, truncated: false }
  return { content: `${content.slice(0, MAX_LINE_CHARS)}...[line truncated]`, truncated: true }
}

function numberedLines(lines: string[], startLine: number, endLine: number) {
  const safeStart = Math.max(1, startLine)
  const safeEnd = Math.min(lines.length, endLine)
  return lines.slice(safeStart - 1, safeEnd).map((content, index) => {
    const clamped = clampLine(content)
    return {
      line: safeStart + index,
      content: clamped.content,
      ...(clamped.truncated ? { lineTruncated: true } : {})
    }
  })
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

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? {}), 'utf8')
}

function nextRangeFromPayload(payload: Record<string, unknown>): { startLine: number; endLine: number } | undefined {
  if (Array.isArray(payload.lines) && payload.lines.length > 0) {
    const last = payload.lines[payload.lines.length - 1] as Record<string, unknown>
    const line = typeof last.line === 'number' ? last.line : undefined
    if (line) return { startLine: line + 1, endLine: line + MAX_RANGE_LINES }
  }
  if (Array.isArray(payload.matches) && payload.matches.length > 0) {
    const last = payload.matches[payload.matches.length - 1] as Record<string, unknown>
    const line = typeof last.endLine === 'number' ? last.endLine : undefined
    if (line) return { startLine: line + 1, endLine: line + MAX_RANGE_LINES }
  }
  return undefined
}

function enforceResponseBudget(payload: Record<string, unknown>): Record<string, unknown> {
  let output: Record<string, unknown> = { ...payload, budgetBytes: MAX_RESPONSE_BYTES }
  let returnedBytes = jsonBytes(output)
  if (returnedBytes <= MAX_RESPONSE_BYTES) {
    return { ...output, truncated: false, returnedBytes }
  }

  if (Array.isArray(output.matches)) {
    let matches = output.matches as unknown[]
    while (matches.length > 0) {
      matches = matches.slice(0, -1)
      output = {
        ...output,
        matches,
        matchCount: matches.length,
        truncated: true,
        nextSuggestedRange: nextRangeFromPayload({ ...output, matches })
      }
      returnedBytes = jsonBytes(output)
      if (returnedBytes <= MAX_RESPONSE_BYTES) return { ...output, returnedBytes }
    }
  }

  if (Array.isArray(output.lines)) {
    let lines = output.lines as unknown[]
    while (lines.length > 1) {
      lines = lines.slice(0, Math.max(1, Math.floor(lines.length * 0.8)))
      output = {
        ...output,
        lines,
        endLine: typeof (lines[lines.length - 1] as Record<string, unknown>).line === 'number'
          ? (lines[lines.length - 1] as Record<string, unknown>).line
          : output.endLine,
        truncated: true,
        nextSuggestedRange: nextRangeFromPayload({ ...output, lines })
      }
      returnedBytes = jsonBytes(output)
      if (returnedBytes <= MAX_RESPONSE_BYTES) return { ...output, returnedBytes }
    }
  }

  return {
    ...output,
    lines: Array.isArray(output.lines) ? (output.lines as unknown[]).slice(0, 1) : output.lines,
    matches: Array.isArray(output.matches) ? [] : output.matches,
    matchCount: Array.isArray(output.matches) ? 0 : output.matchCount,
    truncated: true,
    returnedBytes: jsonBytes({
      ...output,
      lines: Array.isArray(output.lines) ? (output.lines as unknown[]).slice(0, 1) : output.lines,
      matches: Array.isArray(output.matches) ? [] : output.matches,
      matchCount: Array.isArray(output.matches) ? 0 : output.matchCount
    }),
    budgetBytes: MAX_RESPONSE_BYTES,
    nextSuggestedRange: nextRangeFromPayload(output)
  }
}

function buildMatcher(pattern: string, regex?: boolean): { matcher?: RegExp; error?: string } {
  if (regex !== true) return { matcher: new RegExp(escapeRegExp(pattern)) }
  if (pattern.length > MAX_REGEX_PATTERN_CHARS) return { error: `regex pattern is too long; maximum is ${MAX_REGEX_PATTERN_CHARS} characters` }
  if (/(\([^)]*[+*][^)]*\)[+*?]|\.\*.*\.\*)/.test(pattern)) {
    return { error: 'regex pattern looks too broad or backtracking-prone; use literal matching or a simpler regex' }
  }
  try {
    return { matcher: new RegExp(pattern) }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
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
      const endLine = boundedInt(body.endLine, startLine + MAX_RANGE_LINES - 1, startLine, Math.min(file.lines.length || startLine, startLine + MAX_RANGE_LINES - 1))
      return {
        statusCode: 200,
        payload: enforceResponseBudget({
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
        })
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
      const requestedRange = { ...range }
      if (range.endLine - range.startLine + 1 > MAX_RANGE_LINES) {
        range.endLine = range.startLine + MAX_RANGE_LINES - 1
      }
      return {
        statusCode: 200,
        payload: enforceResponseBudget({
          mode: operation,
          sourceId: body.sourceId,
          path: relPath,
          symbol,
          startLine: range.startLine,
          endLine: range.endLine,
          totalLines: file.lines.length,
          sizeBytes: file.sizeBytes,
          modifiedAt: file.modifiedAt,
          symbolRangeTruncated: requestedRange.endLine !== range.endLine,
          ...(requestedRange.endLine !== range.endLine ? { nextSuggestedRange: { startLine: range.endLine + 1, endLine: requestedRange.endLine } } : {}),
          lines: numberedLines(file.lines, range.startLine, range.endLine),
          diagnostics: buildDiagnostics({ operation, path: relPath, fileSize, elapsedMs: Date.now() - startedAt, phase: 'completed', suggestedNarrowerMode: 'read_range' })
        })
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

    const before = boundedInt(body.before, DEFAULT_GREP_BEFORE, 0, MAX_GREP_BEFORE)
    const after = boundedInt(body.after, DEFAULT_GREP_AFTER, 0, MAX_GREP_AFTER)
    const maxMatches = boundedInt(body.maxMatches, DEFAULT_GREP_MATCHES, 1, MAX_GREP_MATCHES)
    const matcherResult = buildMatcher(pattern, body.regex)
    if (!matcherResult.matcher) {
      return {
        statusCode: 400,
        payload: {
          error: matcherResult.error || 'Invalid pattern',
          mode: operation,
          sourceId: body.sourceId,
          path: relPath,
          regex: body.regex === true,
          diagnostics: buildDiagnostics({ operation, path: relPath, fileSize, elapsedMs: Date.now() - startedAt, phase: 'invalid_pattern', suggestedNarrowerMode: 'grep_context' })
        }
      }
    }
    const matcher = matcherResult.matcher
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
      payload: enforceResponseBudget({
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
      })
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
