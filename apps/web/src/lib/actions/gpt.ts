import { executeAction, ActionTransportError, executeActionGET, fetchWithTimeout } from './transport'
import { getBackendUrl, getBackendMode } from './config'
import { buildActionErrorEnvelope } from './action-response'
import { GPT_ACTION_DEFAULT_FILE_BYTES, GPT_ACTION_DEFAULT_INSPECT_LIMIT } from '@buildflow/shared'

type NormalizedSource = {
  id: string
  label: string
  enabled: boolean
  active: boolean
  type?: string
  indexStatus?: string
  indexedFileCount?: number
  autoIndexEnabled?: boolean
  autoIndexIntervalMinutes?: number
  lastAutoIndexedAt?: string
  writable?: boolean
  writeProfile?: string
  writePolicy?: Record<string, unknown>
}

type NormalizedContextResult = {
  status: 'ok'
  contextMode: 'single' | 'multi'
  activeSourceIds: string[]
  sources: NormalizedSource[]
}

type ActivityPhase =
  | 'starting'
  | 'checking'
  | 'reading'
  | 'planning'
  | 'preflight'
  | 'waiting_for_confirmation'
  | 'writing'
  | 'verifying'
  | 'completed'
  | 'blocked'
  | 'failed'

type ActivityRiskLevel = 'low' | 'medium' | 'high'

type ActionActivity = {
  version: '1.2.13-beta'
  operationId: string
  phase: ActivityPhase
  actionLabel: string
  userMessage: string
  sourceId?: string
  sourceLabel?: string
  targetPaths?: string[]
  readPaths?: string[]
  changedPaths?: string[]
  riskLevel: ActivityRiskLevel
  requiresConfirmation: boolean
  verified: boolean
  safeInputSummary?: string
  safeOutputSummary?: string
  whatHappened?: string[]
  whatRemains?: string[]
  provenFacts?: string[]
  nextActions?: string[]
  nextStep?: string
}

type VerifiedWriteResult = {
  verified: true
  verifiedAt: string
  bytesOnDisk: number
  contentHash: string
  contentPreview: string
}

type WritePolicy = {
  allowCreate?: boolean
  allowOverwrite?: boolean
  allowAppend?: boolean
  allowPatch?: boolean
  allowCreateParentDirectories?: boolean
  allowDelete?: boolean
  allowDeleteDirectory?: boolean
  allowMove?: boolean
  allowRename?: boolean
  allowMkdir?: boolean
  allowRmdir?: boolean
  recursiveDeleteRequiresConfirmation?: boolean
  maxRecursiveDeleteFilesWithoutConfirmation?: number
  allowedRoots?: string[]
  blockedGlobs?: string[]
  blockedWriteGlobs?: string[]
  generatedDeleteAllowedGlobs?: string[]
  confirmationRequiredGlobs?: string[]
  protectedWriteGlobs?: string[]
  protectedGlobs?: string[]
  blockedContentPatterns?: string[]
  binaryWriteBlocked?: boolean
  binaryDeleteAllowedWithConfirmation?: boolean
  maxWriteBytes?: number
  maxCreateBytes?: number
  maxOverwriteBytes?: number
  maxPatchTargetBytes?: number
}

type ActivityInput = Omit<ActionActivity, 'version'>

const ENV_TEMPLATE_FILES = new Set([
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.local.example',
  '.env.development.example',
  '.env.production.example'
])

// Enforce conversation isolation: repo-specific actions must pass an explicit sourceId.
// Do not fall back to global active context; it is shared across chats and can drift.
export async function requireExplicitSourceId(body: Record<string, unknown>, _userToken?: string) {
  if (typeof body.sourceId === 'string' && body.sourceId.length > 0) {
    return null
  }
  return { error: 'Target sourceId is required. BuildFlow does not fall back to global active context for repo-specific actions because other conversations may change it.', status: 400 }
}

function requireExplicitReadScope(body: Record<string, unknown>) {
  if (typeof body.sourceId === 'string' && body.sourceId.length > 0) return null
  if (Array.isArray(body.sourceIds) && body.sourceIds.length > 0 && body.sourceIds.every(id => typeof id === 'string' && id.length > 0)) return null
  return { error: 'sourceId or sourceIds is required. BuildFlow does not use global active context for inspect/read because other conversations may change it.', status: 400 }
}

function normalizePath(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/').trim()
}

// Compose a normalized, safe artifact path from title, folder, and filename params; sanitizes input and applies .md extension.
export function composeArtifactRelativePath(params: {
  title: string
  folder?: string
  filename?: string
}): string {
  const folder = typeof params.folder === 'string' ? normalizePath(params.folder) : ''
  const filenameSource = typeof params.filename === 'string' && params.filename.trim() ? params.filename : params.title
  const filename = normalizePath(filenameSource)
    .replace(/(\.md)+$/i, '')
    .replace(/[.]+$/g, '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || 'artifact'
  const safeFolder = folder || '.buildflow'
  return `${safeFolder.replace(/\/$/, '')}/${filename}.md`
}

function compactList(values: Array<string | undefined | null>, limit = 6): string[] {
  return values
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map(value => value.trim())
    .slice(0, limit)
}

function summarizeActivityInput(input: ActivityInput): string | undefined {
  const parts = compactList([
    input.sourceId ? `sourceId=${input.sourceId}` : undefined,
    input.targetPaths && input.targetPaths.length > 0 ? `targets=${summaryList(input.targetPaths)}` : undefined,
    input.readPaths && input.readPaths.length > 0 ? `reads=${summaryList(input.readPaths)}` : undefined
  ])
  return parts.length > 0 ? parts.join('; ') : undefined
}

function summarizeActivityOutput(input: ActivityInput): string {
  const parts = compactList([
    input.userMessage,
    input.changedPaths && input.changedPaths.length > 0 ? `changed=${summaryList(input.changedPaths)}` : undefined,
    input.requiresConfirmation ? 'requires confirmation' : undefined,
    input.verified ? 'verified=true' : 'verified=false'
  ], 4)
  return parts.join('; ')
}

// Build a compact structured activity object for ChatGPT narration.
// Keep this intentionally small: action payload size directly affects GPT latency.
export function makeActivity(input: ActivityInput): ActionActivity {
  return {
    version: '1.2.13-beta',
    operationId: input.operationId,
    phase: input.phase,
    actionLabel: input.actionLabel,
    userMessage: input.userMessage,
    ...(input.sourceId ? { sourceId: input.sourceId } : {}),
    ...(input.sourceLabel ? { sourceLabel: input.sourceLabel } : {}),
    ...(input.targetPaths && input.targetPaths.length > 0 ? { targetPaths: input.targetPaths.slice(0, 5) } : {}),
    ...(input.readPaths && input.readPaths.length > 0 ? { readPaths: input.readPaths.slice(0, 5) } : {}),
    ...(input.changedPaths && input.changedPaths.length > 0 ? { changedPaths: input.changedPaths.slice(0, 5) } : {}),
    riskLevel: input.riskLevel,
    requiresConfirmation: input.requiresConfirmation,
    verified: input.verified,
    ...(input.safeOutputSummary ? { safeOutputSummary: input.safeOutputSummary } : {}),
    ...(input.nextStep ? { nextStep: input.nextStep } : {})
  }
}

// Attach an activity object to an operation result for ChatGPT to narrate what happened.
export function withActivity<T extends Record<string, unknown>>(result: T, activity: ActionActivity): T & { activity: ActionActivity } {
  return { ...result, activity }
}

export function withActionRouteDiagnostics<T extends Record<string, unknown>>(result: T, params: { route: string; startedAt: number; requestBytes?: number }): T & { diagnostics?: Record<string, unknown> } {
  if (process.env.BUILDFLOW_ACTION_DIAGNOSTICS !== '1') {
    return result
  }
  const existingDiagnostics = result.diagnostics && typeof result.diagnostics === 'object' && !Array.isArray(result.diagnostics)
    ? result.diagnostics as Record<string, unknown>
    : {}
  const base = {
    ...result,
    diagnostics: {
      ...existingDiagnostics,
      actionRoute: {
        route: params.route,
        totalMs: Date.now() - params.startedAt,
        requestBytes: params.requestBytes || 0,
        responseBytesBeforeDiagnostics: Buffer.byteLength(JSON.stringify(result), 'utf8')
      }
    }
  }
  return base
}

function summaryList(items: string[], limit = 3): string {
  if (items.length === 0) return 'none'
  const trimmed = items.slice(0, limit)
  const suffix = items.length > limit ? ` and ${items.length - limit} more` : ''
  return `${trimmed.join(', ')}${suffix}`
}

function countLabel(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : plural || `${singular}s`}`
}

type SearchAttemptResult = {
  result: Record<string, unknown>
  results: Array<Record<string, unknown>>
  timings?: Record<string, unknown>
  queryUsed: string
  fallbackUsed: boolean
  fallbackAttempted: boolean
}

function hasExplicitSearchMode(query: string): boolean {
  return /^(content|full):/i.test(query.trim())
}

async function executeSearchWithContentFallback(payload: Record<string, unknown>, userToken?: string): Promise<SearchAttemptResult> {
  const query = typeof payload.query === 'string' ? payload.query : ''
  const firstResult = await executeAction('/api/search', payload, userToken) as Record<string, unknown>
  const firstResults = Array.isArray(firstResult.results) ? firstResult.results as Array<Record<string, unknown>> : []
  const firstTimings = firstResult.timings && typeof firstResult.timings === 'object' && !Array.isArray(firstResult.timings)
    ? firstResult.timings as Record<string, unknown>
    : undefined

  if (firstResults.length > 0 || hasExplicitSearchMode(query)) {
    return {
      result: firstResult,
      results: firstResults,
      timings: firstTimings,
      queryUsed: query,
      fallbackUsed: false,
      fallbackAttempted: false
    }
  }

  const fallbackQuery = `content:${query}`
  const fallbackResult = await executeAction('/api/search', { ...payload, query: fallbackQuery }, userToken) as Record<string, unknown>
  const fallbackResults = Array.isArray(fallbackResult.results) ? fallbackResult.results as Array<Record<string, unknown>> : []
  const fallbackTimings = fallbackResult.timings && typeof fallbackResult.timings === 'object' && !Array.isArray(fallbackResult.timings)
    ? fallbackResult.timings as Record<string, unknown>
    : undefined

  return {
    result: {
      ...fallbackResult,
      originalQuery: query,
      query: fallbackQuery,
      searchFallback: 'content'
    },
    results: fallbackResults,
    timings: {
      fallback: 'content',
      ...(firstTimings ? { path: firstTimings } : {}),
      ...(fallbackTimings ? { content: fallbackTimings } : {})
    },
    queryUsed: fallbackQuery,
    fallbackUsed: fallbackResults.length > 0,
    fallbackAttempted: true
  }
}

function createArtifactBlockedResponse(params: {
  sourceId?: string
  artifactPath: string
  blocked: { code: string; message: string; userMessage: string; reason: string; hint: string }
}) {
  return {
    status: 'error' as const,
    resultStatus: 'error' as const,
    allowed: false,
    verified: false,
    sourceId: params.sourceId || '',
    path: params.artifactPath,
    requestedPath: params.artifactPath,
    normalizedPath: params.artifactPath,
    sourceRootRelativePath: params.artifactPath,
    changeType: 'create' as const,
    requiresConfirmation: false,
    matchedAllowGlob: undefined,
    matchedBlockGlob: undefined,
    matchedConfirmationGlob: undefined,
    error: params.blocked
  }
}

function matchesWildcard(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLESTAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DOUBLESTAR::/g, '.*')
  return new RegExp(`^${escaped}$`, 'i').test(value)
}

function matchesAny(patterns: unknown, value: string): boolean {
  if (!Array.isArray(patterns)) return false
  return patterns.some(pattern => typeof pattern === 'string' && pattern.length > 0 && matchesWildcard(pattern, value))
}

function findMatchingGlob(patterns: unknown, value: string): string | undefined {
  if (!Array.isArray(patterns)) return undefined
  return patterns.find(pattern => typeof pattern === 'string' && pattern.length > 0 && matchesWildcard(pattern, value)) as string | undefined
}

function isDependencyChange(content?: string): boolean {
  if (typeof content !== 'string' || !content.trim()) return false
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    return Boolean(parsed.dependencies || parsed.devDependencies || parsed.peerDependencies || parsed.optionalDependencies)
  } catch {
    return false
  }
}

// Classify a write operation to determine if it's blocked or requires confirmation; checks path safety, content patterns, dependency changes, and policy globs.
function classifyBlockedWrite(path: string, policy?: WritePolicy, content?: string, changeType?: string) {
  const normalized = normalizePath(path)
  if (!normalized) {
    return { code: 'WRITE_PATH_BLOCKED', message: 'This path is blocked by the source write policy.', userMessage: 'BuildFlow can read this file, but it needs a valid repo-relative path to write it.', reason: 'empty_path', hint: 'Provide a repo-relative path like docs/README.md.' }
  }
  if (normalized.startsWith('..') || normalized.includes('/../') || normalized === '..') {
    return { code: 'PATH_TRAVERSAL_BLOCKED', message: 'Path traversal outside the repo is blocked.', userMessage: 'BuildFlow can only write inside the connected source root.', reason: 'path_traversal', hint: 'Use a repo-relative path inside the source root.' }
  }
  if (path.startsWith('/')) {
    return { code: 'ABSOLUTE_PATH_BLOCKED', message: 'Absolute paths outside the repo are blocked.', userMessage: 'BuildFlow can only write inside the connected source root.', reason: 'absolute_path', hint: 'Use a repo-relative path inside the source root.' }
  }
  if (ENV_TEMPLATE_FILES.has(normalized.split('/').pop() || '')) {
    return null
  }
  if (normalized.split('/').some(part => part === '.git' || part === 'node_modules' || part === '.next' || part === 'dist' || part === 'build' || part === 'coverage')) {
    return { code: 'PROTECTED_PATH', message: 'This file or directory is protected by policy.', userMessage: 'BuildFlow is not allowed to write to protected runtime or dependency directories.', reason: 'protected_directory', hint: 'Choose a docs path or update the source policy if intentional.' }
  }
  if (typeof content === 'string' && Array.isArray(policy?.blockedContentPatterns)) {
    const matchedPattern = policy.blockedContentPatterns.find(pattern => typeof pattern === 'string' && pattern.length > 0 && content.includes(pattern))
    if (matchedPattern) {
      return {
        code: 'SECRET_PATTERN_BLOCKED',
        message: 'This content is blocked because it looks like it may contain a secret.',
        userMessage: 'BuildFlow will not write content that looks like a token, credential, or private key.',
        reason: 'blocked_content_pattern',
        hint: 'Use redacted placeholders such as [REDACTED], <token>, or your-key-here instead.'
      }
    }
  }
  if (matchesAny(policy?.confirmationRequiredGlobs, normalized)) {
    return { code: 'REQUIRES_EXPLICIT_CONFIRMATION', message: 'This change requires explicit confirmation.', userMessage: 'BuildFlow needs explicit confirmation before making this change.', reason: 'confirmation_required_path', hint: 'Explicitly confirm before editing lockfiles, GitHub workflows, LICENSE, or Prisma migrations.' }
  }
  if (matchesAny(policy?.protectedWriteGlobs, normalized)) {
    return { code: 'REQUIRES_EXPLICIT_CONFIRMATION', message: 'This change requires explicit confirmation.', userMessage: 'BuildFlow needs explicit confirmation before making this change.', reason: 'protected_write_path', hint: 'Explicitly confirm before editing this protected maintenance path.' }
  }
  if (matchesAny(policy?.blockedGlobs, normalized)) {
    return { code: 'SECRET_PATH_BLOCKED', message: 'This path is blocked because it may contain secrets.', userMessage: 'BuildFlow will not write to secret-like files such as .env or private key paths.', reason: 'blocked_glob', hint: 'Use a docs or project note path instead.' }
  }
  if (matchesAny(policy?.blockedWriteGlobs, normalized)) {
    if ((changeType === 'delete_file' || changeType === 'delete_directory' || changeType === 'rmdir') && matchesAny(policy?.generatedDeleteAllowedGlobs, normalized)) {
      return null
    }
    return { code: 'GENERATED_WRITE_BLOCKED', message: 'This path is blocked because it is generated output.', userMessage: 'BuildFlow will not write generated or build output files.', reason: 'generated_write_blocked', hint: 'Write to the source file or a repo note instead.' }
  }
  if (matchesAny(policy?.protectedGlobs, normalized)) {
    return { code: 'PROTECTED_PATH', message: 'This file is protected by policy.', userMessage: 'BuildFlow is not allowed to write to this protected file.', reason: 'protected_glob', hint: 'Choose a docs path or update the source policy if intentional.' }
  }
  const allowedRoots = Array.isArray(policy?.allowedRoots) ? policy!.allowedRoots! : []
  const allowRoot = allowedRoots.some(root => typeof root === 'string' && root.length > 0 && (
    root === '*.md' ? normalized.endsWith('.md') : root.endsWith('/**') ? normalized === root.slice(0, -3) || normalized.startsWith(root.slice(0, -3) + '/') : normalized === root || normalized.startsWith(`${root}/`)
  ))
  if (!allowRoot) {
    return { code: 'WRITE_PATH_BLOCKED', message: 'This path is blocked by the source write policy.', userMessage: 'BuildFlow can read this file, but the current write policy blocks changes to this path.', reason: 'path_not_allowed', hint: 'Choose an allowed docs path or update the source write policy.' }
  }
  return null
}

function normalizeSourceRecord(source: Record<string, unknown>): NormalizedSource & {
  indexed?: boolean
  indexStatus?: string
  indexedFileCount?: number
  lastIndexedAt?: string
  searchable?: boolean
} {
  const id = typeof source.id === 'string' ? source.id : ''
  const label = typeof source.label === 'string' && source.label.trim() ? source.label : id
  const enabled = source.enabled !== false
  const active = source.active === true
  const type = typeof source.type === 'string' && source.type.trim() ? source.type : undefined
  const writable = typeof source.writable === 'boolean' ? source.writable : undefined
  const writeProfile = typeof source.writeProfile === 'string' && source.writeProfile.trim() ? source.writeProfile : undefined
  const writePolicy = source.writePolicy && typeof source.writePolicy === 'object' ? source.writePolicy as Record<string, unknown> : undefined
  const indexed = source.indexed === true
  const indexStatus = typeof source.indexStatus === 'string' && source.indexStatus.trim() ? source.indexStatus : undefined
  const indexedFileCount = typeof source.indexedFileCount === 'number' ? source.indexedFileCount : undefined
  const lastIndexedAt = typeof source.lastIndexedAt === 'string' && source.lastIndexedAt.trim() ? source.lastIndexedAt : undefined
  const searchable = typeof source.searchable === 'boolean' ? source.searchable : (indexStatus ?? (indexed ? 'ready' : 'pending')) === 'ready'
  const autoIndexEnabled = typeof source.autoIndexEnabled === 'boolean' ? source.autoIndexEnabled : undefined
  const autoIndexIntervalMinutes = typeof source.autoIndexIntervalMinutes === 'number' ? source.autoIndexIntervalMinutes : undefined
  const lastAutoIndexedAt = typeof source.lastAutoIndexedAt === 'string' && source.lastAutoIndexedAt.trim() ? source.lastAutoIndexedAt : undefined
  return { id, label, enabled, active, ...(type ? { type } : {}), ...(writable !== undefined ? { writable } : {}), ...(writeProfile ? { writeProfile } : {}), ...(writePolicy ? { writePolicy } : {}), ...(indexed !== undefined ? { indexed } : {}), ...(indexStatus ? { indexStatus } : {}), ...(indexedFileCount !== undefined ? { indexedFileCount } : {}), ...(lastIndexedAt ? { lastIndexedAt } : {}), ...(searchable !== undefined ? { searchable } : {}), ...(autoIndexEnabled !== undefined ? { autoIndexEnabled } : {}), ...(autoIndexIntervalMinutes !== undefined ? { autoIndexIntervalMinutes } : {}), ...(lastAutoIndexedAt ? { lastAutoIndexedAt } : {}) }
}

function normalizeSourcesList(sourcesPayload: unknown) {
  const listedSources = Array.isArray((sourcesPayload as { sources?: unknown }).sources)
    ? ((sourcesPayload as { sources: Array<Record<string, unknown>> }).sources || [])
    : []
  return listedSources.map((source) => normalizeSourceRecord(source))
}

function normalizeActiveContext(activePayload: unknown): NormalizedContextResult {
  const activeSourceIds = Array.isArray((activePayload as { activeSourceIds?: unknown }).activeSourceIds)
    ? (((activePayload as { activeSourceIds: string[] }).activeSourceIds || []).filter(id => typeof id === 'string'))
    : []
  const mode = (activePayload as { mode?: unknown }).mode
  const contextMode = mode === 'single' || mode === 'multi' ? mode : activeSourceIds.length === 1 ? 'single' : 'multi'
  return {
    status: 'ok',
    contextMode,
    activeSourceIds,
    sources: []
  }
}

function normalizeContextResult(sourcesPayload: unknown, activePayload: unknown, fallbackStatus: 'ok' = 'ok'): NormalizedContextResult {
  const listedSources = normalizeSourcesList(sourcesPayload)
  const activeSourceIds = Array.isArray((activePayload as { activeSourceIds?: unknown }).activeSourceIds)
    ? (((activePayload as { activeSourceIds: string[] }).activeSourceIds || []).filter(id => typeof id === 'string'))
    : []
  const mode = (activePayload as { mode?: unknown }).mode
  const contextMode = mode === 'single' || mode === 'multi' ? mode : activeSourceIds.length === 1 ? 'single' : 'multi'
  const activeIds = new Set(activeSourceIds)

  const sources: NormalizedSource[] = listedSources.map(source => ({
    id: source.id,
    label: source.label,
    enabled: source.enabled,
    active: activeIds.has(source.id) || source.active === true,
    ...(source.type ? { type: source.type } : {}),
    ...(source.writable !== undefined ? { writable: source.writable } : {}),
    ...(source.writeProfile ? { writeProfile: source.writeProfile } : {})
  }))

  return {
    status: fallbackStatus,
    contextMode,
    activeSourceIds,
    sources
  }
}

function assertVerifiedWriteResult(result: unknown, fallback: string): VerifiedWriteResult {
  if (!result || typeof result !== 'object') {
    throw new ActionTransportError(`${fallback}: write response missing`, 502)
  }

  const raw = result as Record<string, unknown>
  const verified = raw.verified
  if (verified !== true) {
    throw new ActionTransportError(`${fallback}: write was not verified`, 502)
  }

  const verifiedAt = raw.verifiedAt
  const bytesOnDisk = raw.bytesOnDisk
  const contentHash = raw.contentHash
  const contentPreview = raw.contentPreview

  if (typeof verifiedAt !== 'string' || !verifiedAt) throw new ActionTransportError(`${fallback}: verifiedAt missing`, 502)
  if (typeof bytesOnDisk !== 'number' || !Number.isFinite(bytesOnDisk) || bytesOnDisk <= 0) throw new ActionTransportError(`${fallback}: bytesOnDisk invalid`, 502)
  if (typeof contentHash !== 'string' || !contentHash) throw new ActionTransportError(`${fallback}: contentHash missing`, 502)
  if (typeof contentPreview !== 'string') throw new ActionTransportError(`${fallback}: contentPreview missing`, 502)

  return {
    verified: true,
    verifiedAt,
    bytesOnDisk,
    contentHash,
    contentPreview
  }
}

async function fetchJson(endpoint: string, init?: RequestInit): Promise<unknown> {
  const response = await fetchWithTimeout(`${getBackendUrl()}${endpoint}`, init ?? {}, 10000)
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}))
    throw new ActionTransportError(
      (errorData as Record<string, unknown>).error as string || `Action failed: ${response.status}`,
      response.status
    )
  }
  return response.json()
}

// Normalize action errors into consistent error envelope format with proper HTTP status code extraction.
export function unwrapActionError(err: unknown, fallback: string) {
  if (err instanceof ActionTransportError) {
    return {
      error: err.payload || buildActionErrorEnvelope({
        code: 'ACTION_TRANSPORT_ERROR',
        message: err.message,
        details: `Status ${err.statusCode}`,
        status: err.statusCode === 504 ? 'unavailable' : 'error'
      }),
      status: err.statusCode
    }
  }
  return {
    error: buildActionErrorEnvelope({
      code: 'BUILDFLOW_STATUS_ERROR',
      message: fallback,
      details: err instanceof Error ? err.message : String(err)
    }),
    status: 500
  }
}

function validateContextSelection(body: Record<string, unknown>) {
  const contextMode = body.contextMode
  const sourceIds = body.sourceIds
  if (contextMode !== 'single' && contextMode !== 'multi') {
    throw new ActionTransportError('contextMode is required and must be single or multi', 400)
  }
  if (!Array.isArray(sourceIds) || sourceIds.length === 0 || sourceIds.some(id => typeof id !== 'string' || !id)) {
    throw new ActionTransportError('sourceIds is required and must be a non-empty string array', 400)
  }
  if (contextMode === 'single' && sourceIds.length !== 1) {
    throw new ActionTransportError('single mode requires exactly one sourceId', 400)
  }
}

async function loadSourceMap(userToken?: string) {
  const mode = getBackendMode()
  const headers: Record<string, string> = { method: 'GET' }
  if (mode === 'relay-agent' && userToken) {
    headers['Authorization'] = `Bearer ${userToken}`
  }
  const sourcesPayload = await fetchJson('/api/sources/list', { method: 'GET', headers })
  const sources = normalizeSourcesList(sourcesPayload)
  const map = new Map(sources.map(source => [source.id, source]))
  return { sourcesPayload, sources, map }
}

async function ensureContextSourcesAllowed(sourceIds: string[], userToken?: string) {
  const { map } = await loadSourceMap(userToken)
  for (const id of sourceIds) {
    const source = map.get(id)
    if (!source) {
      throw new ActionTransportError(`Unknown sourceId: ${id}`, 400)
    }
    if (source.enabled === false) {
      throw new ActionTransportError(`Source not enabled: ${id}`, 400)
    }
  }
}

// Copy user confirmation signals (confirmedByUser, confirmationToken) from request body to write payload.
export function attachWriteConfirmation(payload: Record<string, unknown>, body: Record<string, unknown>) {
  payload.confirmedByUser = body.confirmedByUser === true
  if (typeof body.confirmationToken === 'string' && body.confirmationToken.length > 0) {
    payload.confirmationToken = body.confirmationToken
  }
}

async function preflightWrite(body: Record<string, unknown>, userToken?: string) {
  const sourceError = await requireExplicitSourceId(body, userToken)
  if (sourceError) return sourceError
  const sourceId = typeof body.sourceId === 'string' ? body.sourceId : undefined
  const path = typeof body.path === 'string' ? body.path : typeof body.from === 'string' ? body.from : ''
  const changeType = body.changeType === 'append' || body.changeType === 'overwrite' || body.changeType === 'patch' || body.changeType === 'delete_file' || body.changeType === 'delete_directory' || body.changeType === 'move' || body.changeType === 'rename' || body.changeType === 'mkdir' || body.changeType === 'rmdir' ? body.changeType : 'create'
  const sourceMap = await loadSourceMap(userToken)
  const source = sourceId ? sourceMap.map.get(sourceId) : sourceMap.sources[0]
  const policy = (source?.writePolicy || {}) as WritePolicy
  const normalizedPath = normalizePath(path)
  const blocked = classifyBlockedWrite(path, policy, typeof body.content === 'string' ? body.content : undefined, changeType)
  const matchedAllowGlob = findMatchingGlob(policy?.allowedRoots, normalizedPath)
  const matchedBlockGlob = findMatchingGlob(policy?.blockedGlobs, normalizedPath) || findMatchingGlob(policy?.confirmationRequiredGlobs, normalizedPath) || findMatchingGlob(policy?.protectedGlobs, normalizedPath)
  if (blocked) {
    return {
      status: blocked.code === 'REQUIRES_EXPLICIT_CONFIRMATION' ? 'needs_confirmation' as const : 'error' as const,
      resultStatus: 'error' as const,
      allowed: false,
      verified: false,
      sourceId: source?.id || sourceId || '',
      path,
      requestedPath: path,
      normalizedPath,
      sourceRootRelativePath: normalizedPath,
      changeType,
      matchedAllowGlob,
      matchedBlockGlob,
      requiresConfirmation: blocked.code === 'REQUIRES_EXPLICIT_CONFIRMATION',
      matchedConfirmationGlob: findMatchingGlob(policy?.confirmationRequiredGlobs, normalizedPath),
      confirmationToken: blocked.code === 'REQUIRES_EXPLICIT_CONFIRMATION' ? `confirm:${source?.id || sourceId || ''}:${changeType}:${normalizedPath}` : undefined,
      error: { ...blocked, policy }
    }
  }
  return {
    status: 'allowed' as const,
    allowed: true,
    verified: false,
    sourceId: source?.id || sourceId || '',
    requestedPath: path,
    normalizedPath,
    sourceRootRelativePath: normalizedPath,
    changeType,
    wouldCreateParentDirectories: true,
    wouldWrite: ['create', 'append', 'overwrite', 'patch', 'mkdir'].includes(changeType),
    wouldDelete: ['delete_file', 'delete_directory', 'rmdir'].includes(changeType),
    wouldMove: ['move', 'rename'].includes(changeType),
    wouldCreateDirectory: changeType === 'mkdir',
    matchedAllowGlob,
    matchedConfirmationGlob: findMatchingGlob(policy?.confirmationRequiredGlobs, normalizedPath),
    policy
  }
}

// List all connected sources with their indexed/writable status and write policy; returns activity narration.
export async function listBuildFlowSources(userToken?: string) {
  const mode = getBackendMode()
  const headers: Record<string, string> = { method: 'GET' }
  if (mode === 'relay-agent' && userToken) {
    headers['Authorization'] = `Bearer ${userToken}`
  }
  const sourcesPayload = await fetchJson('/api/sources/list?lite=1', { method: 'GET', headers })
  const sources = normalizeSourcesList(sourcesPayload).map(source => ({
    id: source.id,
    label: source.label,
    enabled: source.enabled,
    active: source.active,
    indexStatus: source.indexStatus ?? (source.searchable ? 'ready' : 'pending'),
    searchable: source.searchable === true,
    indexedFileCount: source.indexedFileCount,
    autoIndexEnabled: source.autoIndexEnabled,
    autoIndexIntervalMinutes: source.autoIndexIntervalMinutes,
    writable: source.writable === true,
    writeProfile: source.writeProfile,
    operations: ['create', 'patch', 'overwrite', 'append', 'deleteFile', 'deleteDirectory', 'move', 'rename', 'mkdir', 'rmdir']
  }))
  return withActivity({
    status: 'ok' as const,
    sources
  }, makeActivity({
    operationId: 'listBuildFlowSources',
    phase: 'completed',
    actionLabel: 'Listed connected sources',
    userMessage: `Found ${countLabel(sources.length, 'source')}. ${countLabel(sources.filter(source => source.enabled).length, 'source')} enabled; ${countLabel(sources.filter(source => source.searchable).length, 'source')} searchable; ${countLabel(sources.filter(source => source.writable).length, 'source')} writable.`,
    riskLevel: 'low',
    requiresConfirmation: false,
    verified: true,
    nextStep: 'Select a source and continue.'
  }))
}

// Get the currently active source context (single or multi-mode); returns activity narration.
export async function getBuildFlowActiveContext(userToken?: string) {
  const activePayload = await executeAction('/api/get-active-sources?lite=1', {}, userToken)
  const context = normalizeActiveContext(activePayload)
  return withActivity(context, makeActivity({
    operationId: 'getBuildFlowActiveContext',
    phase: 'completed',
    actionLabel: 'Checked active source context',
    userMessage: context.activeSourceIds.length > 0
      ? `Active context is ${context.contextMode}-source: ${summaryList(context.activeSourceIds)}.`
      : 'No active source context is selected.',
    sourceId: context.activeSourceIds[0],
    targetPaths: context.activeSourceIds,
    riskLevel: 'low',
    requiresConfirmation: false,
    verified: true,
    nextStep: context.activeSourceIds.length > 0 ? 'Read or inspect the active source.' : 'Select one or more active sources.'
  }))
}

// Change the active source context to single or multi-mode; validates selection and returns updated context with activity narration.
export async function setBuildFlowActiveContext(body: Record<string, unknown>, userToken?: string) {
  validateContextSelection(body)
  await ensureContextSourcesAllowed(body.sourceIds as string[], userToken)
  const result = await executeAction('/api/set-active-sources', {
    mode: body.contextMode,
    activeSourceIds: body.sourceIds
  }, userToken)
  const context = normalizeContextResult(result, result)
  return withActivity(context, makeActivity({
    operationId: 'setBuildFlowActiveContext',
    phase: 'completed',
    actionLabel: 'Updated active source context',
    userMessage: `Active context is now ${context.contextMode}-source with ${countLabel(context.activeSourceIds.length, 'source')}.`,
    sourceId: context.activeSourceIds[0],
    targetPaths: context.activeSourceIds,
    riskLevel: 'low',
    requiresConfirmation: false,
    verified: true,
    nextStep: 'Inspect or read the selected sources.'
  }))
}

// Route context operations (list, get, set) to specialized handlers; dispatches based on action field.
export async function dispatchBuildFlowContext(body: Record<string, unknown>, userToken?: string) {
  const action = body.action
  if (action === 'list_sources') {
    return listBuildFlowSources(userToken)
  }
  if (action === 'get_active') {
    return getBuildFlowActiveContext(userToken)
  }
  if (action === 'set_active') {
    return setBuildFlowActiveContext(body, userToken)
  }
  throw new Error('Invalid action')
}

// Inspect vault structure or search; supports list_files and search modes; returns results with activity narration.
export async function dispatchBuildFlowInspect(body: Record<string, unknown>, userToken?: string) {
  const scopeError = requireExplicitReadScope(body)
  if (scopeError) return scopeError
  const mode = body.mode
  if (mode === 'list_files') {
    const payload: Record<string, unknown> = {
      path: typeof body.path === 'string' ? body.path : '',
      depth: typeof body.depth === 'number' ? body.depth : 3,
      limit: typeof body.limit === 'number' ? body.limit : GPT_ACTION_DEFAULT_INSPECT_LIMIT
    }
    if (Array.isArray(body.sourceIds)) payload.sourceIds = body.sourceIds
    if (typeof body.sourceId === 'string') payload.sourceId = body.sourceId
    const result = await executeAction('/api/list-files', payload, userToken)
    const entries = Array.isArray((result as { entries?: unknown }).entries) ? (result as { entries: unknown[] }).entries : []
    const pathList = entries
      .map(entry => typeof entry === 'object' && entry !== null && typeof (entry as Record<string, unknown>).path === 'string' ? (entry as Record<string, unknown>).path as string : '')
      .filter(Boolean)
    return withActivity(result as Record<string, unknown>, makeActivity({
      operationId: 'inspectBuildFlowContext',
      phase: 'completed',
      actionLabel: 'Inspected repository structure',
      userMessage: `Found ${countLabel(entries.length, 'path')} under ${payload.path || 'the selected root'}.`,
      sourceId: typeof body.sourceId === 'string' ? body.sourceId : undefined,
      targetPaths: pathList.slice(0, 10),
      riskLevel: 'low',
      requiresConfirmation: false,
      verified: true,
      nextStep: 'Read the most relevant files.'
    }))
  }
  if (mode === 'search') {
    if (typeof body.query !== 'string' || !body.query) throw new Error('Missing query parameter')
    const payload: Record<string, unknown> = {
      query: body.query,
      limit: typeof body.limit === 'number' ? body.limit : GPT_ACTION_DEFAULT_INSPECT_LIMIT
    }
    if (Array.isArray(body.sourceIds)) payload.sourceIds = body.sourceIds
    if (typeof body.sourceId === 'string') payload.sourceId = body.sourceId
    const search = await executeSearchWithContentFallback(payload, userToken)
    const result = search.result
    const results = search.results
    const paths = results
      .map(entry => typeof entry === 'object' && entry !== null && typeof (entry as Record<string, unknown>).path === 'string' ? (entry as Record<string, unknown>).path as string : '')
      .filter(Boolean)
    return withActivity(result as Record<string, unknown>, makeActivity({
      operationId: 'inspectBuildFlowContext',
      phase: 'completed',
      actionLabel: 'Searched connected source',
      userMessage: search.fallbackUsed
        ? `Found ${countLabel(results.length, 'match')} for "${body.query}" using content search.`
        : `Found ${countLabel(results.length, 'match')} for "${body.query}".`,
      sourceId: typeof body.sourceId === 'string' ? body.sourceId : undefined,
      readPaths: paths.slice(0, 10),
      targetPaths: paths.slice(0, 10),
      riskLevel: 'low',
      requiresConfirmation: false,
      verified: true,
      nextStep: 'Read the matching files.'
    }))
  }
  throw new Error('Invalid mode')
}

// Read files from vault; supports read_paths and search_and_read modes; handles source routing and truncation; returns activity narration.
export async function dispatchBuildFlowRead(body: Record<string, unknown>, userToken?: string) {
  const scopeError = requireExplicitReadScope(body)
  if (scopeError) return scopeError
  const mode = body.mode
  if (mode === 'read_paths') {
    if (!Array.isArray(body.paths) || body.paths.length === 0) throw new Error('Missing paths parameter')
    const payload: Record<string, unknown> = {
      paths: body.paths,
      maxBytesPerFile: typeof body.maxBytesPerFile === 'number' ? body.maxBytesPerFile : GPT_ACTION_DEFAULT_FILE_BYTES
    }
    if (Array.isArray(body.sourceIds)) payload.sourceIds = body.sourceIds
    if (typeof body.sourceId === 'string') payload.sourceId = body.sourceId
    const result = await executeAction('/api/read-files', payload, userToken)
    const files = Array.isArray((result as { files?: unknown }).files) ? (result as { files: Array<Record<string, unknown>> }).files : []
    const skipped = Array.isArray((result as { skipped?: unknown }).skipped) ? (result as { skipped: Array<Record<string, unknown>> }).skipped : []
    const nextBatch = (result as { nextBatch?: Record<string, unknown> }).nextBatch
    const budgetBytes = typeof (result as { budgetBytes?: unknown }).budgetBytes === 'number' ? (result as { budgetBytes: number }).budgetBytes : undefined
    const returnedBytes = typeof (result as { returnedBytes?: unknown }).returnedBytes === 'number' ? (result as { returnedBytes: number }).returnedBytes : undefined
    const timings = (result as { timings?: Record<string, unknown> }).timings
    const truncatedCount = files.filter(file => typeof file.truncated === 'boolean' && file.truncated).length
    const budgeted = skipped.length > 0 || (typeof budgetBytes === 'number' && typeof returnedBytes === 'number' && returnedBytes < budgetBytes)
    return withActivity({
      mode: 'read_paths',
      files,
      ...(skipped.length > 0 ? { skipped } : {}),
      ...(nextBatch ? { nextBatch } : {}),
      ...(typeof budgetBytes === 'number' ? { budgetBytes } : {}),
      ...(typeof returnedBytes === 'number' ? { returnedBytes } : {}),
      ...(timings ? { timings } : {})
    }, makeActivity({
      operationId: 'readBuildFlowContext',
      phase: 'completed',
      actionLabel: 'Read repo files',
      userMessage: budgeted
        ? `Read ${countLabel(files.length, 'file')}${skipped.length > 0 ? `; split ${countLabel(skipped.length, 'file')} into nextBatch` : ''}${truncatedCount > 0 ? `; ${countLabel(truncatedCount, 'file')} truncated` : ''}.`
        : `Read ${countLabel(files.length, 'file')}${truncatedCount > 0 ? `; ${countLabel(truncatedCount, 'file')} truncated` : ''}.`,
      sourceId: typeof body.sourceId === 'string' ? body.sourceId : undefined,
      readPaths: files.map(file => typeof file.path === 'string' ? file.path : '').filter(Boolean).slice(0, 10),
      targetPaths: files.map(file => typeof file.path === 'string' ? file.path : '').filter(Boolean).slice(0, 10),
      riskLevel: 'low',
      requiresConfirmation: false,
      verified: true,
      whatRemains: skipped.length > 0 ? ['Continue with nextBatch.', 'Review the returned file contents.'] : undefined,
      nextActions: nextBatch ? ['Continue with nextBatch.', 'Review the returned file contents.'] : undefined,
      nextStep: nextBatch ? 'Continue with nextBatch.' : 'Review the returned file contents.'
    }))
  }
  if (mode === 'search_and_read') {
    if (typeof body.query !== 'string' || !body.query) throw new Error('Missing query parameter')
    const searchPayload: Record<string, unknown> = {
      query: body.query,
      limit: typeof body.limit === 'number' ? body.limit : 3
    }
    if (Array.isArray(body.sourceIds)) searchPayload.sourceIds = body.sourceIds
    if (typeof body.sourceId === 'string') searchPayload.sourceId = body.sourceId

    const search = await executeSearchWithContentFallback(searchPayload, userToken)
    const searchTimings = search.timings
    const results = search.results

    if (results.length === 0) {
      return withActivity({
        mode: 'search_and_read',
        timings: searchTimings ? { search: searchTimings } : undefined,
        results: [],
        noMatches: true,
        query: body.query,
        ...(search.fallbackAttempted ? { fallbackAttempted: 'content' } : {})
      }, makeActivity({
        operationId: 'readBuildFlowContext',
        phase: 'completed',
        actionLabel: 'Searched repo files',
        userMessage: search.fallbackAttempted
          ? `No matching files found for "${body.query}" after path and content search.`
          : `No matching files found for "${body.query}".`,
        sourceId: typeof body.sourceId === 'string' ? body.sourceId : undefined,
        riskLevel: 'low',
        requiresConfirmation: false,
        verified: true,
        nextStep: 'Try a more specific query or list files to choose exact paths.'
      }))
    }

    const pathEntries = results
      .map(result => {
        const path = typeof result.path === 'string' ? result.path : ''
        const sourceId = typeof result.sourceId === 'string' ? result.sourceId : undefined
        return path ? { path, sourceId } : null
      })
      .filter((entry): entry is { path: string; sourceId: string | undefined } => entry !== null)
      .slice(0, typeof body.limit === 'number' ? body.limit : 3)

    const sourceIds = Array.from(new Set(pathEntries.map(entry => entry.sourceId).filter((id): id is string => typeof id === 'string' && id.length > 0)))
    const readPayload: Record<string, unknown> = {
      paths: pathEntries.map(entry => entry.path),
      maxBytesPerFile: typeof body.maxBytesPerFile === 'number' ? body.maxBytesPerFile : GPT_ACTION_DEFAULT_FILE_BYTES
    }
    if (sourceIds.length > 0) {
      readPayload.sourceIds = sourceIds
    } else if (typeof body.sourceId === 'string') {
      readPayload.sourceId = body.sourceId
    }

    const readResult = await executeAction('/api/read-files', readPayload, userToken)
    const readTimings = (readResult as { timings?: Record<string, unknown> }).timings
    const files = Array.isArray((readResult as { files?: unknown }).files)
      ? ((readResult as { files: Array<Record<string, unknown>> }).files || [])
      : []
    const skipped = Array.isArray((readResult as { skipped?: unknown }).skipped) ? (readResult as { skipped: Array<Record<string, unknown>> }).skipped : []
    const nextBatch = (readResult as { nextBatch?: Record<string, unknown> }).nextBatch

    const fileMap = new Map<string, Record<string, unknown>>()
    for (const file of files) {
      const key = `${typeof file.sourceId === 'string' ? file.sourceId : ''}::${typeof file.path === 'string' ? file.path : ''}`
      if (key !== '::') fileMap.set(key, file)
    }

    return withActivity({
      mode: 'search_and_read',
      ...(search.fallbackUsed ? { searchFallback: 'content', originalQuery: body.query, queryUsed: search.queryUsed } : {}),
      timings: {
        ...(searchTimings ? { search: searchTimings } : {}),
        ...(readTimings ? { read: readTimings } : {})
      },
      results: pathEntries.map(entry => {
        const candidates = [
          entry.sourceId ? `${entry.sourceId}::${entry.path}` : '',
          ...Array.from(fileMap.keys()).filter(key => key.endsWith(`::${entry.path}`))
        ].filter(Boolean)
        const match = candidates.map(key => fileMap.get(key)).find(Boolean)
        return {
          sourceId: entry.sourceId || (match && typeof match.sourceId === 'string' ? match.sourceId : undefined),
          path: entry.path,
          title: typeof (results.find(result => result.path === entry.path && (!entry.sourceId || result.sourceId === entry.sourceId))?.title) === 'string'
            ? (results.find(result => result.path === entry.path && (!entry.sourceId || result.sourceId === entry.sourceId))?.title as string)
            : undefined,
          snippet: typeof (results.find(result => result.path === entry.path && (!entry.sourceId || result.sourceId === entry.sourceId))?.snippet) === 'string'
            ? (results.find(result => result.path === entry.path && (!entry.sourceId || result.sourceId === entry.sourceId))?.snippet as string)
            : undefined,
          content: typeof match?.content === 'string' ? match.content : undefined,
          truncated: typeof match?.truncated === 'boolean' ? match.truncated : undefined,
          sizeBytes: typeof match?.sizeBytes === 'number' ? match.sizeBytes : undefined,
          modifiedAt: typeof match?.modifiedAt === 'string' ? match.modifiedAt : undefined
        }
      })
    }, makeActivity({
      operationId: 'readBuildFlowContext',
      phase: 'completed',
      actionLabel: 'Read repo files',
      userMessage: skipped.length > 0
        ? `Found ${countLabel(pathEntries.length, 'matching file')}${search.fallbackUsed ? ' using content search' : ''} and read a budgeted subset; continue with nextBatch.`
        : `Found ${countLabel(pathEntries.length, 'matching file')}${search.fallbackUsed ? ' using content search' : ''} and read the available contents.`,
      sourceId: typeof body.sourceId === 'string' ? body.sourceId : undefined,
      readPaths: pathEntries.map(entry => entry.path).slice(0, 10),
      targetPaths: pathEntries.map(entry => entry.path).slice(0, 10),
      riskLevel: 'low',
      requiresConfirmation: false,
      verified: true,
      whatRemains: skipped.length > 0 ? ['Continue with nextBatch.', 'Summarize the matching files.'] : undefined,
      nextActions: nextBatch ? ['Continue with nextBatch.', 'Summarize the matching files.'] : undefined,
      nextStep: nextBatch ? 'Continue with nextBatch.' : 'Summarize the matching files.'
    }))
  }
  if (mode === 'prepare_task_context') {
    if (typeof body.query !== 'string' || !body.query) throw new Error('Missing query parameter')
    const payload: Record<string, unknown> = {
      query: body.query,
      limit: typeof body.limit === 'number' ? body.limit : 8
    }
    if (Array.isArray(body.paths)) payload.paths = body.paths
    if (typeof body.maxBytesPerFile === 'number') payload.maxBytesPerFile = body.maxBytesPerFile
    if (Array.isArray(body.sourceIds)) payload.sourceIds = body.sourceIds
    if (typeof body.sourceId === 'string') payload.sourceId = body.sourceId
    const result = await executeAction('/api/prepare-task-context', payload, userToken)
    const exactReadPlan = Array.isArray((result as { exactReadPlan?: unknown }).exactReadPlan)
      ? (result as { exactReadPlan: Array<Record<string, unknown>> }).exactReadPlan
      : []
    const topFiles = Array.isArray((result as { topFiles?: unknown }).topFiles)
      ? (result as { topFiles: Array<Record<string, unknown>> }).topFiles
      : []
    return withActivity(result as Record<string, unknown>, makeActivity({
      operationId: 'readBuildFlowContext',
      phase: 'completed',
      actionLabel: 'Prepared focused task context',
      userMessage: `Prepared context with ${countLabel(topFiles.length, 'ranked file')} and ${countLabel(exactReadPlan.length, 'planned read')}.`,
      sourceId: typeof body.sourceId === 'string' ? body.sourceId : undefined,
      readPaths: exactReadPlan.map(item => typeof item.path === 'string' ? item.path : '').filter(Boolean).slice(0, 10),
      targetPaths: topFiles.map(item => typeof item.path === 'string' ? item.path : '').filter(Boolean).slice(0, 10),
      riskLevel: 'low',
      requiresConfirmation: false,
      verified: true,
      nextStep: exactReadPlan.length > 0 ? 'Read the planned paths before editing.' : 'Refine the task query or provide exact paths.'
    }))
  }
  throw new Error('Invalid mode')
}

const SAFE_COMMAND_KINDS = new Set([
  'git_status_short',
  'git_diff_stat',
  'git_diff_name_only',
  'git_diff',
  'git_log_latest',
  'git_branch_current',
  'verify_public_scope',
  'type_check_web',
  'type_check_cli',
  'verify_write_policy',
  'verify_source_reindex_resilience',
  'git_diff_cached_stat',
  'git_diff_cached_name_only',
  'git_add_paths',
  'git_commit',
  'git_push',
  'validate_json_files',
  'run_package_script',
  'run_package_test',
  'run_package_test_marker',
  'security_scan_paths',
  'diagnose_performance',
  'local_cli_github_auth_status',
  'local_cli_github_repo_view'
])

// Run a narrow allowlisted git/status or validation command inside a selected source root; returns redacted bounded output with activity narration.
export async function dispatchBuildFlowCommand(body: Record<string, unknown>, userToken?: string) {
  const sourceId = typeof body.sourceId === 'string' ? body.sourceId : ''
  const commandKind = typeof body.commandKind === 'string' ? body.commandKind : ''
  if (!sourceId) throw new Error('sourceId is required')
  if (!SAFE_COMMAND_KINDS.has(commandKind)) throw new Error('commandKind is not allowlisted')
  const result = await executeAction('/api/commands/run', {
    sourceId,
    commandKind,
    timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
    paths: Array.isArray(body.paths) ? body.paths : undefined,
    packageDir: typeof body.packageDir === 'string' ? body.packageDir : undefined,
    scriptName: typeof body.scriptName === 'string' ? body.scriptName : undefined,
    marker: typeof body.marker === 'string' ? body.marker : undefined,
    message: typeof body.message === 'string' ? body.message : undefined,
    body: typeof body.body === 'string' ? body.body : undefined,
    remote: typeof body.remote === 'string' ? body.remote : undefined,
    branch: typeof body.branch === 'string' ? body.branch : undefined,
    patternSet: typeof body.patternSet === 'string' ? body.patternSet : undefined,
    confirmedByUser: typeof body.confirmedByUser === 'boolean' ? body.confirmedByUser : undefined,
    confirmationToken: typeof body.confirmationToken === 'string' ? body.confirmationToken : undefined
  }, userToken)
  const status = typeof (result as Record<string, unknown>).status === 'string' ? (result as Record<string, unknown>).status : 'failed'
  const exitCode = typeof (result as Record<string, unknown>).exitCode === 'number' ? (result as Record<string, unknown>).exitCode : null
  const outputTruncated = (result as Record<string, unknown>).outputTruncated === true
  return withActivity(result as Record<string, unknown>, makeActivity({
    operationId: 'runBuildFlowCommand',
    phase: status === 'completed' ? 'completed' : 'failed',
    actionLabel: 'Ran safe validation command',
    userMessage: `BuildFlow ran ${commandKind} in ${sourceId} and finished with ${status}${exitCode !== null ? ` (exit ${exitCode})` : ''}.`,
    sourceId,
    riskLevel: 'medium',
    requiresConfirmation: false,
    verified: status === 'completed',
    provenFacts: compactList([
      `Command kind: ${commandKind}`,
      `Status: ${status}`,
      exitCode !== null ? `Exit code: ${exitCode}` : undefined,
      outputTruncated ? 'Output was truncated.' : undefined
    ]),
    nextStep: status === 'completed' ? 'Use the command result as validation evidence.' : 'Inspect stderr/stdout and decide the next repair step.'
  }))
}

// Create an artifact (personal note) in vault; supports preflight and dry-run; enforces write policy; returns activity narration.
export async function dispatchBuildFlowArtifact(body: Record<string, unknown>, userToken?: string) {
  const artifactPath = composeArtifactRelativePath({
    title: typeof body.title === 'string' ? body.title : 'artifact',
    folder: typeof body.folder === 'string' ? body.folder : undefined,
    filename: typeof body.filename === 'string' ? body.filename : undefined
  })
  if (body.dryRun === true || body.preflight === true) {
    const sourceError = await requireExplicitSourceId(body, userToken)
    if (sourceError) return sourceError
    const sourceMap = await loadSourceMap(userToken)
    const sourceId = typeof body.sourceId === 'string' ? body.sourceId : undefined
    const source = sourceId ? sourceMap.map.get(sourceId) : sourceMap.sources[0]
    const policy = (source?.writePolicy || {}) as WritePolicy
    const content = typeof body.content === 'string' ? body.content : undefined
    const contentRisk = classifyBlockedWrite(artifactPath, policy, content, 'create')
    if (contentRisk && ['SECRET_PATTERN_BLOCKED', 'BINARY_WRITE_BLOCKED', 'FILE_TOO_LARGE'].includes(contentRisk.code)) {
      return withActivity(createArtifactBlockedResponse({
        sourceId: source?.id || sourceId || '',
        artifactPath,
        blocked: contentRisk
      }), makeActivity({
        operationId: 'writeBuildFlowArtifact',
        phase: 'blocked',
        actionLabel: 'Blocked unsafe artifact write',
        userMessage: contentRisk.userMessage,
        sourceId: source?.id || sourceId,
        targetPaths: artifactPath ? [artifactPath] : [],
        changedPaths: [],
        readPaths: [],
        riskLevel: 'high',
        requiresConfirmation: false,
        verified: false,
        nextStep: contentRisk.hint || 'Use redacted placeholders or choose another file.'
      }))
    }
    const result = await preflightWrite({ ...body, path: artifactPath, changeType: 'create' }, userToken) as {
      status: 'allowed' | 'needs_confirmation' | 'error'
      allowed?: boolean
      verified: boolean
      sourceId?: string
      requestedPath?: string
      normalizedPath?: string
      requiresConfirmation?: boolean
      error?: unknown
    }
    const isBlocked = result.status === 'error'
    const isNeedsConfirmation = result.status === 'needs_confirmation'
    return withActivity(result, makeActivity({
      operationId: 'writeBuildFlowArtifact',
      phase: isBlocked ? 'blocked' : isNeedsConfirmation ? 'waiting_for_confirmation' : 'preflight',
      actionLabel: isBlocked ? 'Blocked unsafe artifact write' : isNeedsConfirmation ? 'Needs confirmation' : 'Preflighted repo artifact',
      userMessage: isBlocked
        ? String((result.error as Record<string, unknown>)?.userMessage || 'BuildFlow blocked this artifact write.')
        : isNeedsConfirmation
          ? 'BuildFlow needs confirmation before creating this artifact.'
          : `BuildFlow verified that ${artifactPath} is allowed.`,
      sourceId: typeof result.sourceId === 'string' ? result.sourceId : undefined,
      targetPaths: artifactPath ? [artifactPath] : [],
      changedPaths: [],
      readPaths: [],
      riskLevel: isBlocked ? 'high' : 'medium',
      requiresConfirmation: Boolean(result.requiresConfirmation),
      verified: false,
      nextStep: isNeedsConfirmation ? 'Confirm the action and retry.' : isBlocked ? 'Choose an allowed path.' : 'Proceed if the preflight looks correct.'
    }))
  }
  const sourceError = await requireExplicitSourceId(body, userToken)
  if (sourceError) return sourceError
  const result = await executeAction('/api/create-artifact', { ...body, path: artifactPath }, userToken)
  const verified = assertVerifiedWriteResult(result, 'writeBuildFlowArtifact')
  const sourceId = typeof (result as Record<string, unknown>).sourceId === 'string' ? (result as Record<string, unknown>).sourceId as string : typeof body.sourceId === 'string' ? body.sourceId : undefined
  const path = typeof (result as Record<string, unknown>).path === 'string' ? (result as Record<string, unknown>).path as string : artifactPath
  return withActivity({ ...result as Record<string, unknown>, ...verified }, makeActivity({
    operationId: 'writeBuildFlowArtifact',
    phase: 'completed',
    actionLabel: 'Verified repo artifact',
    userMessage: `BuildFlow created ${path || 'the artifact'} and verified it on disk.`,
    sourceId,
    targetPaths: path ? [path] : [],
    changedPaths: path ? [path] : [],
    riskLevel: 'low',
    requiresConfirmation: false,
    verified: true,
    nextStep: 'Review the artifact or continue.'
  }))
}

// Apply file operations (create, append, overwrite, patch, delete, move, mkdir); supports preflight, dry-run, and confirmation tokens; enforces write policy; returns activity narration.
export async function dispatchBuildFlowFileChange(body: Record<string, unknown>, userToken?: string) {
  if (body.dryRun === true || body.preflight === true) {
    const result = await preflightWrite(body, userToken) as {
      status: 'allowed' | 'needs_confirmation' | 'error'
      allowed?: boolean
      verified: boolean
      sourceId?: string
      requestedPath?: string
      normalizedPath?: string
      requiresConfirmation?: boolean
      error?: unknown
    }
    const isBlocked = result.status === 'error'
    const isNeedsConfirmation = result.status === 'needs_confirmation'
    return withActivity(result, makeActivity({
      operationId: 'applyBuildFlowFileChange',
      phase: isBlocked ? 'blocked' : isNeedsConfirmation ? 'waiting_for_confirmation' : 'preflight',
      actionLabel: isBlocked
        ? 'Blocked unsafe write'
        : isNeedsConfirmation
          ? 'Needs confirmation'
          : 'Preflighted repo file change',
      userMessage: isBlocked
        ? String((result.error as Record<string, unknown>)?.userMessage || 'BuildFlow blocked this file change.')
        : isNeedsConfirmation
          ? 'BuildFlow needs confirmation before making this change.'
          : `BuildFlow verified that ${typeof result.requestedPath === 'string' ? result.requestedPath : 'this change'} is allowed.`,
      sourceId: typeof result.sourceId === 'string' ? result.sourceId : undefined,
      targetPaths: typeof result.normalizedPath === 'string' && result.normalizedPath ? [result.normalizedPath] : [],
      changedPaths: [],
      riskLevel: isBlocked ? 'high' : 'medium',
      requiresConfirmation: Boolean(result.requiresConfirmation),
      verified: false,
      nextStep: isNeedsConfirmation ? 'Confirm the action and retry.' : isBlocked ? 'Choose an allowed path.' : 'Proceed if the preflight looks correct.'
    }))
  }
  const sourceError = await requireExplicitSourceId(body, userToken)
  if (sourceError) return sourceError

  const changeType = body.changeType
  const payload: Record<string, unknown> = {
    sourceId: body.sourceId,
    path: typeof body.path === 'string' ? body.path : body.from,
    reason: body.reason
  }
  attachWriteConfirmation(payload, body)

  if (changeType === 'append') {
    payload.content = body.content
    payload.separator = body.separator ?? '\n\n'
    attachWriteConfirmation(payload, body)
    const result = await executeAction('/api/append-file', payload, userToken)
    const verified = assertVerifiedWriteResult(result, 'applyBuildFlowFileChange append')
    const path = typeof (result as Record<string, unknown>).path === 'string' ? (result as Record<string, unknown>).path as string : typeof body.path === 'string' ? body.path : undefined
    return withActivity({ ...(result as Record<string, unknown>), ...verified }, makeActivity({
      operationId: 'applyBuildFlowFileChange',
      phase: 'completed',
      actionLabel: 'Verified repo file change',
      userMessage: `BuildFlow appended to ${path || 'the file'} and verified it on disk.`,
      sourceId: typeof body.sourceId === 'string' ? body.sourceId : undefined,
      targetPaths: path ? [path] : [],
      changedPaths: path ? [path] : [],
      riskLevel: 'low',
      requiresConfirmation: false,
      verified: true,
      nextStep: 'Review the file or continue.'
    }))
  }

  if (changeType === 'create') {
    payload.content = body.content
    payload.mode = 'createOnly'
    attachWriteConfirmation(payload, body)
    const result = await executeAction('/api/write-file', payload, userToken)
    const verified = assertVerifiedWriteResult(result, 'applyBuildFlowFileChange create')
    const path = typeof (result as Record<string, unknown>).path === 'string' ? (result as Record<string, unknown>).path as string : typeof body.path === 'string' ? body.path : undefined
    return withActivity({ ...(result as Record<string, unknown>), ...verified }, makeActivity({
      operationId: 'applyBuildFlowFileChange',
      phase: 'completed',
      actionLabel: 'Verified repo file change',
      userMessage: `BuildFlow created ${path || 'the file'} and verified it on disk.`,
      sourceId: typeof body.sourceId === 'string' ? body.sourceId : undefined,
      targetPaths: path ? [path] : [],
      changedPaths: path ? [path] : [],
      riskLevel: 'low',
      requiresConfirmation: false,
      verified: true,
      nextStep: 'Review the file or continue.'
    }))
  }

  if (changeType === 'overwrite') {
    payload.content = body.content
    payload.mode = 'overwrite'
    attachWriteConfirmation(payload, body)
    const result = await executeAction('/api/write-file', payload, userToken)
    const verified = assertVerifiedWriteResult(result, 'applyBuildFlowFileChange overwrite')
    const path = typeof (result as Record<string, unknown>).path === 'string' ? (result as Record<string, unknown>).path as string : typeof body.path === 'string' ? body.path : undefined
    return withActivity({ ...(result as Record<string, unknown>), ...verified }, makeActivity({
      operationId: 'applyBuildFlowFileChange',
      phase: 'completed',
      actionLabel: 'Verified repo file change',
      userMessage: `BuildFlow overwrote ${path || 'the file'} and verified it on disk.`,
      sourceId: typeof body.sourceId === 'string' ? body.sourceId : undefined,
      targetPaths: path ? [path] : [],
      changedPaths: path ? [path] : [],
      riskLevel: 'low',
      requiresConfirmation: false,
      verified: true,
      nextStep: 'Review the file or continue.'
    }))
  }

  if (changeType === 'patch') {
    payload.find = body.find
    payload.replace = body.replace
    payload.allowMultiple = body.allowMultiple ?? false
    attachWriteConfirmation(payload, body)
    const result = await executeAction('/api/patch-file', payload, userToken)
    const verified = assertVerifiedWriteResult(result, 'applyBuildFlowFileChange patch')
    const path = typeof (result as Record<string, unknown>).path === 'string' ? (result as Record<string, unknown>).path as string : typeof body.path === 'string' ? body.path : undefined
    return withActivity({ ...(result as Record<string, unknown>), ...verified }, makeActivity({
      operationId: 'applyBuildFlowFileChange',
      phase: 'completed',
      actionLabel: 'Verified repo file change',
      userMessage: `BuildFlow patched ${path || 'the file'} and verified it on disk.`,
      sourceId: typeof body.sourceId === 'string' ? body.sourceId : undefined,
      targetPaths: path ? [path] : [],
      changedPaths: path ? [path] : [],
      riskLevel: 'low',
      requiresConfirmation: false,
      verified: true,
      nextStep: 'Review the file or continue.'
    }))
  }

  if (changeType === 'delete_file' || changeType === 'delete_directory' || changeType === 'rmdir') {
    payload.recursive = body.recursive === true
    payload.onlyIfEmpty = body.onlyIfEmpty !== false
    payload.confirmedByUser = body.confirmedByUser === true
    payload.confirmationToken = typeof body.confirmationToken === 'string' ? body.confirmationToken : undefined
    const result = await executeAction('/api/delete-file', payload, userToken)
    const deletedPath = typeof (result as Record<string, unknown>).path === 'string' ? (result as Record<string, unknown>).path as string : typeof body.path === 'string' ? body.path : undefined
    return withActivity(result as Record<string, unknown>, makeActivity({
      operationId: 'applyBuildFlowFileChange',
      phase: 'completed',
      actionLabel: changeType === 'rmdir'
        ? 'Deleted empty directory'
        : changeType === 'delete_directory'
          ? 'Deleted directory'
          : 'Deleted file',
      userMessage: changeType === 'rmdir'
        ? `BuildFlow deleted the empty directory ${deletedPath || 'target'} and verified it on disk.`
        : changeType === 'delete_directory'
          ? `BuildFlow deleted ${deletedPath || 'the directory'} and verified it on disk.`
          : `BuildFlow deleted ${deletedPath || 'the file'} and verified it on disk.`,
      sourceId: typeof body.sourceId === 'string' ? body.sourceId : undefined,
      targetPaths: deletedPath ? [deletedPath] : [],
      changedPaths: deletedPath ? [deletedPath] : [],
      riskLevel: changeType === 'delete_file' ? 'medium' : 'high',
      requiresConfirmation: false,
      verified: true,
      nextStep: 'Review the repo state or continue.'
    }))
  }

  if (changeType === 'move' || changeType === 'rename') {
    payload.to = body.to
    payload.overwrite = body.overwrite === true
    payload.createParents = body.createParents === true || body.createParentDirectories === true
    payload.confirmedByUser = body.confirmedByUser === true
    payload.confirmationToken = typeof body.confirmationToken === 'string' ? body.confirmationToken : undefined
    const result = await executeAction('/api/move-file', payload, userToken)
    const from = typeof (result as Record<string, unknown>).from === 'string' ? (result as Record<string, unknown>).from as string : typeof body.path === 'string' ? body.path : typeof body.from === 'string' ? body.from : undefined
    const to = typeof (result as Record<string, unknown>).to === 'string' ? (result as Record<string, unknown>).to as string : typeof body.to === 'string' ? body.to : undefined
    return withActivity(result as Record<string, unknown>, makeActivity({
      operationId: 'applyBuildFlowFileChange',
      phase: 'completed',
      actionLabel: changeType === 'rename' ? 'Renamed repo file' : 'Moved repo file',
      userMessage: `${changeType === 'rename' ? 'BuildFlow renamed' : 'BuildFlow moved'} ${from || 'the file'}${to ? ` to ${to}` : ''} and verified it on disk.`,
      sourceId: typeof body.sourceId === 'string' ? body.sourceId : undefined,
      targetPaths: [from, to].filter((path): path is string => typeof path === 'string' && path.length > 0),
      changedPaths: [from, to].filter((path): path is string => typeof path === 'string' && path.length > 0),
      riskLevel: 'medium',
      requiresConfirmation: false,
      verified: true,
      nextStep: 'Review the moved file or continue.'
    }))
  }

  if (changeType === 'mkdir') {
    payload.createParents = body.createParents === true || body.createParentDirectories === true
    attachWriteConfirmation(payload, body)
    const result = await executeAction('/api/mkdir', payload, userToken)
    const path = typeof (result as Record<string, unknown>).path === 'string' ? (result as Record<string, unknown>).path as string : typeof body.path === 'string' ? body.path : undefined
    return withActivity(result as Record<string, unknown>, makeActivity({
      operationId: 'applyBuildFlowFileChange',
      phase: 'completed',
      actionLabel: 'Created directory',
      userMessage: `BuildFlow created ${path || 'the directory'} and verified it on disk.`,
      sourceId: typeof body.sourceId === 'string' ? body.sourceId : undefined,
      targetPaths: path ? [path] : [],
      changedPaths: path ? [path] : [],
      riskLevel: 'low',
      requiresConfirmation: false,
      verified: true,
      nextStep: 'Review the directory or continue.'
    }))
  }

  throw new Error('Invalid changeType')
}


export async function startBuildFlowAgentJob(body: Record<string, unknown>, userToken?: string) {
  const sourceId = typeof body.sourceId === 'string' ? body.sourceId : ''
  const goal = typeof body.goal === 'string' ? body.goal : ''
  if (!sourceId) throw new ActionTransportError('sourceId is required', 400)
  if (!goal.trim()) throw new ActionTransportError('goal is required', 400)
  const result = await executeAction('/api/agent-jobs/start', {
    sourceId,
    goal,
    maxIterations: typeof body.maxIterations === 'number' ? body.maxIterations : undefined,
    autonomyLevel: body.autonomyLevel === 'supervised' ? 'supervised' : body.autonomyLevel === 'hands_off_safe' ? 'hands_off_safe' : undefined,
    documentationPath: typeof body.documentationPath === 'string' ? body.documentationPath : undefined,
    reviewEveryStep: typeof body.reviewEveryStep === 'boolean' ? body.reviewEveryStep : undefined,
    autoCommit: typeof body.autoCommit === 'boolean' ? body.autoCommit : undefined,
    autoPush: typeof body.autoPush === 'boolean' ? body.autoPush : undefined,
    full: body.full === true
  }, userToken)
  const job = (result as { job?: { id?: string; sourceId?: string; requiresConfirmation?: boolean } }).job
  return withActivity(result as Record<string, unknown>, makeActivity({
    operationId: 'startBuildFlowAgentJob',
    phase: job?.requiresConfirmation ? 'waiting_for_confirmation' : 'planning',
    actionLabel: 'Started sequential job',
    userMessage: job?.id ? `Sequential job started for ${job.sourceId || sourceId}.` : 'Sequential job start returned no job id.',
    sourceId,
    riskLevel: job?.requiresConfirmation ? 'medium' : 'low',
    requiresConfirmation: job?.requiresConfirmation === true,
    verified: Boolean(job?.id),
    nextStep: 'Continue the bounded loop: inspect, plan, write, validate, commit, and stop with a resume point when needed.'
  }))
}

export async function getBuildFlowAgentJob(body: Record<string, unknown>, userToken?: string) {
  const payload: Record<string, unknown> = {}
  if (typeof body.jobId === 'string') payload.jobId = body.jobId
  if (typeof body.status === 'string') payload.status = body.status
  if (typeof body.currentIteration === 'number') payload.currentIteration = body.currentIteration
  if (typeof body.blockedReason === 'string') payload.blockedReason = body.blockedReason
  if (typeof body.requiresConfirmation === 'boolean') payload.requiresConfirmation = body.requiresConfirmation
  if (typeof body.confirmationReason === 'string') payload.confirmationReason = body.confirmationReason
  if (Array.isArray(body.nextActions)) payload.nextActions = body.nextActions
  if (typeof body.summary === 'string') payload.summary = body.summary
  if (typeof body.lastKnownGitStatus === 'string') payload.lastKnownGitStatus = body.lastKnownGitStatus
  if (Array.isArray(body.roadmapPhases)) payload.roadmapPhases = body.roadmapPhases
  if (typeof body.activeTaskId === 'string') payload.activeTaskId = body.activeTaskId
  if (typeof body.completedTaskCount === 'number') payload.completedTaskCount = body.completedTaskCount
  if (body.full === true) payload.full = true
  if (typeof body.limit === 'number') payload.limit = body.limit
  const result = await executeAction('/api/agent-jobs/status', payload, userToken)
  const job = (result as { job?: { id?: string; sourceId?: string; status?: string; requiresConfirmation?: boolean } }).job
  return withActivity(result as Record<string, unknown>, makeActivity({
    operationId: 'getBuildFlowAgentJob',
    phase: job?.status === 'completed' ? 'completed' : job?.requiresConfirmation ? 'waiting_for_confirmation' : 'checking',
    actionLabel: 'Checked sequential job',
    userMessage: job?.id ? `Sequential job ${job.id} is ${job.status || 'active'}.` : 'Returned sequential jobs.',
    sourceId: job?.sourceId,
    riskLevel: job?.requiresConfirmation ? 'medium' : 'low',
    requiresConfirmation: job?.requiresConfirmation === true,
    verified: true,
    nextStep: job?.requiresConfirmation ? 'Stop only for the explicit blocker.' : 'Continue the bounded loop through validation, commit, and the next task.'
  }))
}


export async function controlBuildFlowAgentRun(body: Record<string, unknown>, userToken?: string) {
  return executeAction('/api/agent-jobs/control', body, userToken)
}
