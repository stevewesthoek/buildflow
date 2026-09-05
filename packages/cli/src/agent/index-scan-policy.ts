import crypto from 'crypto'

/**
 * The source-index policy is deliberately separate from the traversal code so
 * policy changes have one durable identity and can invalidate old indexes.
 * Depth is measured in repository-relative path segments. The scanner may
 * visit the directory containing a file at the configured depth, but never
 * descends beyond the hard ceiling.
 */
export const INDEX_SCAN_POLICY_VERSION = 'source-index-v2'
export const INDEX_SCAN_EXCLUSION_VERSION = 'source-exclusions-v2'

// The deepest legitimate current Workbench path is depth 9. One segment of
// headroom covers the next normal route/module nesting without making the
// scanner unbounded.
export const DEFAULT_INDEX_SCAN_DEPTH = 10
export const MAX_INDEX_SCAN_HARD_DEPTH = 12

export const MAX_INDEX_SCAN_DEPTH = DEFAULT_INDEX_SCAN_DEPTH
export const MAX_INDEX_SCAN_ENTRIES_PER_DIRECTORY = 2000
export const MAX_INDEX_SCAN_DIRECTORIES = 10_000
export const MAX_INDEX_SCAN_FILES = 10_000
export const MAX_INDEX_SCAN_RESULTS = 2_000
export const MAX_INDEX_SCAN_BYTES = 64 * 1024 * 1024
export const MAX_INDEX_SCAN_WALL_TIME_MS = 15_000
export const MAX_INDEXABLE_FILE_BYTES = 1024 * 1024

/**
 * These names are repository content that is either runtime state or build /
 * package cache output. They are pruned before depth accounting so a deeply
 * nested generated tree cannot make an otherwise healthy source fail.
 */
export const DEFAULT_IGNORE_PATTERNS = [
  '**/.git/**',
  '**/.obsidian/**',
  '**/.next/**',
  '**/.build/**',
  '**/.buildflow/**',
  '**/.workbench-provider-state/**',
  '**/node_modules/**',
  '**/vendor/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/coverage/**',
  '**/.cache/**',
  '**/.turbo/**',
  '**/.vercel/**',
  '**/.npm/**',
  '**/.yarn/**',
  '**/.pnpm-store/**',
  '**/graphify-out/**',
  '**/runtime/**',
  '**/node-compile-cache/**',
  '**/.DS_Store',
  '**/.idea/**',
  '**/.vscode/**',
  '**/pnpm-lock.yaml',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/bun.lockb',
  '**/*.tsbuildinfo',
  '**/docs/openapi.chatgpt.json'
]

export type IndexScanFailureCode = 'FAILED_DEPTH' | 'FAILED_BUDGET' | 'FAILED_IO' | 'STALE_POLICY' | 'RECONCILIATION_REQUIRED'

export type IndexScanBudgetOptions = {
  maxDepth?: number
  maxDirectories?: number
  maxFiles?: number
  maxBytes?: number
  maxWallTimeMs?: number
}

export type IndexScanPolicy = {
  policyVersion: string
  exclusionVersion: string
  policyIdentity: string
  defaultDepth: number
  hardDepth: number
  maxDirectories: number
  maxFiles: number
  maxResults: number
  maxBytes: number
  maxWallTimeMs: number
  maxEntriesPerDirectory: number
  maxIndexableFileBytes: number
  ignorePatterns: readonly string[]
  symlinkPolicy: 'reject'
}

const policyDescriptor = JSON.stringify({
  policyVersion: INDEX_SCAN_POLICY_VERSION,
  exclusionVersion: INDEX_SCAN_EXCLUSION_VERSION,
  defaultDepth: DEFAULT_INDEX_SCAN_DEPTH,
  hardDepth: MAX_INDEX_SCAN_HARD_DEPTH,
  maxDirectories: MAX_INDEX_SCAN_DIRECTORIES,
  maxFiles: MAX_INDEX_SCAN_FILES,
  maxResults: MAX_INDEX_SCAN_RESULTS,
  maxBytes: MAX_INDEX_SCAN_BYTES,
  maxWallTimeMs: MAX_INDEX_SCAN_WALL_TIME_MS,
  maxEntriesPerDirectory: MAX_INDEX_SCAN_ENTRIES_PER_DIRECTORY,
  maxIndexableFileBytes: MAX_INDEXABLE_FILE_BYTES,
  ignorePatterns: DEFAULT_IGNORE_PATTERNS,
  symlinkPolicy: 'reject'
})

export const INDEX_SCAN_POLICY_ID = crypto.createHash('sha256').update(policyDescriptor).digest('hex').slice(0, 32)

export const INDEX_SCAN_POLICY: IndexScanPolicy = Object.freeze({
  policyVersion: INDEX_SCAN_POLICY_VERSION,
  exclusionVersion: INDEX_SCAN_EXCLUSION_VERSION,
  policyIdentity: INDEX_SCAN_POLICY_ID,
  defaultDepth: DEFAULT_INDEX_SCAN_DEPTH,
  hardDepth: MAX_INDEX_SCAN_HARD_DEPTH,
  maxDirectories: MAX_INDEX_SCAN_DIRECTORIES,
  maxFiles: MAX_INDEX_SCAN_FILES,
  maxResults: MAX_INDEX_SCAN_RESULTS,
  maxBytes: MAX_INDEX_SCAN_BYTES,
  maxWallTimeMs: MAX_INDEX_SCAN_WALL_TIME_MS,
  maxEntriesPerDirectory: MAX_INDEX_SCAN_ENTRIES_PER_DIRECTORY,
  maxIndexableFileBytes: MAX_INDEXABLE_FILE_BYTES,
  ignorePatterns: DEFAULT_IGNORE_PATTERNS,
  symlinkPolicy: 'reject'
})

export function boundedScanOptions(options: IndexScanBudgetOptions = {}): Required<IndexScanBudgetOptions> {
  const numberOrDefault = (value: number | undefined, fallback: number, minimum: number): number => {
    if (!Number.isFinite(value)) return fallback
    return Math.max(minimum, Math.floor(value as number))
  }
  return {
    maxDepth: Math.min(MAX_INDEX_SCAN_HARD_DEPTH, numberOrDefault(options.maxDepth, DEFAULT_INDEX_SCAN_DEPTH, 0)),
    maxDirectories: numberOrDefault(options.maxDirectories, MAX_INDEX_SCAN_DIRECTORIES, 1),
    maxFiles: numberOrDefault(options.maxFiles, MAX_INDEX_SCAN_FILES, 1),
    maxBytes: numberOrDefault(options.maxBytes, MAX_INDEX_SCAN_BYTES, 1),
    maxWallTimeMs: numberOrDefault(options.maxWallTimeMs, MAX_INDEX_SCAN_WALL_TIME_MS, 1)
  }
}

export function indexFailureCodeForTermination(reason: string): IndexScanFailureCode {
  if (reason === 'depth_limit') return 'FAILED_DEPTH'
  if (reason === 'entries_limit' || reason === 'directory_budget' || reason === 'file_budget' || reason === 'byte_budget' || reason === 'time_budget' || reason === 'result_limit') return 'FAILED_BUDGET'
  return 'FAILED_IO'
}
