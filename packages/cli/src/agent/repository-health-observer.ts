import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { KnowledgeSource } from '@workbench/shared'
import { getSourcesSafe } from './config'
import { getIndexRecord, type SourceIndexRecord } from './index-state'
import {
  CONTEXT_INTELLIGENCE_MODEL_VERSION,
  isRepositoryHealth,
  type RepositoryFreshnessState,
  type RepositoryHealth
} from './context-intelligence-models'

const GIT_EXECUTABLE = '/usr/bin/git'
const GIT_TIMEOUT_MS = 2_000
const MAX_GIT_OUTPUT_BYTES = 1_024 * 1_024
const MAX_OBSERVED_SOURCES = 200

export type RepositoryHealthObservationFailureReason = 'source_missing' | 'repository_unavailable' | 'observation_failed'

export type RepositoryHealthObservationResult = {
  ok: true
  health: RepositoryHealth
} | {
  ok: false
  sourceId: string
  reason: RepositoryHealthObservationFailureReason
  health?: RepositoryHealth
}

export type RepositoryHealthObserverOptions = {
  sources?: KnowledgeSource[]
  sourceLoader?: () => KnowledgeSource[]
  indexRecordLoader?: (sourceId: string) => SourceIndexRecord | undefined
  now?: () => Date
}

type GitResult = { ok: true; output: string } | { ok: false; message: string }

type GitObservation = {
  canonicalRepositoryPath: string
  branchName?: string
  observedRevision: string
  gitStatus: 'clean' | 'dirty'
  trackedChangedFileCount: number
  untrackedFileCount: number
}

function runGit(cwd: string, args: string[]): GitResult {
  try {
    const output = execFileSync(GIT_EXECUTABLE, ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      shell: false,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        LC_ALL: 'C'
      }
    })
    return { ok: true, output }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Git observation failed.' }
  }
}

function candidateCanonicalPath(sourcePath: string): string {
  try {
    return fs.realpathSync(sourcePath)
  } catch {
    return path.resolve(sourcePath)
  }
}

function countStatusEntries(output: string): { trackedChangedFileCount: number; untrackedFileCount: number } {
  let trackedChangedFileCount = 0
  let untrackedFileCount = 0
  for (const entry of output.split('\0')) {
    if (entry.startsWith('? ')) untrackedFileCount += 1
    else if (/^(?:1|2|u) /.test(entry)) trackedChangedFileCount += 1
  }
  return { trackedChangedFileCount, untrackedFileCount }
}

function indexStatusFor(source: KnowledgeSource, record: SourceIndexRecord | undefined): SourceIndexRecord['indexStatus'] {
  if (source.enabled === false) return 'disabled'
  return record?.indexStatus || 'unknown'
}

function freshnessFor(indexStatus: SourceIndexRecord['indexStatus'], indexedRevision: string | undefined, observedRevision: string, gitStatus: 'clean' | 'dirty'): { state: RepositoryFreshnessState; score: number } {
  if (indexStatus === 'disabled') return { state: 'unavailable', score: 0 }
  if (indexStatus === 'indexing') return { state: 'indexing', score: 50 }
  if (indexStatus === 'failed' || indexStatus === 'unknown') return { state: 'failed', score: 0 }
  if (!indexedRevision || indexedRevision !== observedRevision) return { state: 'stale_revision', score: 25 }
  if (gitStatus === 'dirty' && indexStatus !== 'ready') return { state: 'stale_worktree', score: 50 }
  if (gitStatus === 'dirty') return { state: 'fresh_with_uncommitted_changes', score: 75 }
  if (indexStatus !== 'ready') return { state: 'stale_revision', score: 25 }
  return { state: 'fresh', score: 100 }
}

function unavailableHealth(source: KnowledgeSource, record: SourceIndexRecord | undefined, timestamp: string): RepositoryHealth {
  const health: RepositoryHealth = {
    schemaVersion: CONTEXT_INTELLIGENCE_MODEL_VERSION,
    sourceId: source.id,
    canonicalRepositoryPath: candidateCanonicalPath(source.path),
    branchName: source.branchName,
    gitStatus: 'unavailable',
    trackedChangedFileCount: 0,
    untrackedFileCount: 0,
    indexedRevision: record?.sourceRevision,
    indexGeneration: record?.lastIndexedAt,
    indexStatus: indexStatusFor(source, record),
    freshnessState: 'unavailable',
    freshnessScore: 0,
    runtimeAvailability: 'unavailable',
    lastCheckedAt: timestamp
  }
  if (!isRepositoryHealth(health)) throw new Error('Generated unavailable repository health failed validation.')
  return health
}

function observeGit(source: KnowledgeSource): GitObservation | undefined {
  const sourcePath = candidateCanonicalPath(source.path)
  try {
    if (!fs.statSync(sourcePath).isDirectory()) return undefined
  } catch {
    return undefined
  }

  const root = runGit(sourcePath, ['rev-parse', '--show-toplevel'])
  const status = runGit(sourcePath, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--branch'])
  if (!root.ok || !status.ok) return undefined

  const records = status.output.split('\0')
  const branchName = records.find(record => record.startsWith('# branch.head '))?.slice('# branch.head '.length).trim()
  const observedRevision = records.find(record => record.startsWith('# branch.oid '))?.slice('# branch.oid '.length).trim()
  if (!observedRevision || observedRevision === '(initial)') return undefined

  const canonicalRepositoryPath = candidateCanonicalPath(root.output.trim())
  const counts = countStatusEntries(records.join('\0'))
  return {
    canonicalRepositoryPath,
    branchName: branchName && branchName !== '(detached)' ? branchName : undefined,
    observedRevision,
    gitStatus: counts.trackedChangedFileCount + counts.untrackedFileCount > 0 ? 'dirty' : 'clean',
    ...counts
  }
}

function observeSource(source: KnowledgeSource, options: RepositoryHealthObserverOptions): RepositoryHealthObservationResult {
  const timestamp = (options.now || (() => new Date()))().toISOString()
  let indexRecordFailed = false
  const record = (() => {
    try {
      return (options.indexRecordLoader || getIndexRecord)(source.id)
    } catch {
      indexRecordFailed = true
      return undefined
    }
  })()
  const git = observeGit(source)
  if (!git) {
    return {
      ok: false,
      sourceId: source.id,
      reason: 'repository_unavailable',
      health: unavailableHealth(source, record, timestamp)
    }
  }

  const indexStatus = indexRecordFailed ? 'failed' : indexStatusFor(source, record)
  const indexedRevision = record?.sourceRevision
  const freshness = freshnessFor(indexStatus, indexedRevision, git.observedRevision, git.gitStatus)
  const health: RepositoryHealth = {
    schemaVersion: CONTEXT_INTELLIGENCE_MODEL_VERSION,
    sourceId: source.id,
    canonicalRepositoryPath: git.canonicalRepositoryPath,
    branchName: git.branchName,
    gitStatus: git.gitStatus,
    trackedChangedFileCount: git.trackedChangedFileCount,
    untrackedFileCount: git.untrackedFileCount,
    indexedRevision,
    indexGeneration: record?.lastIndexedAt,
    observedRevision: git.observedRevision,
    indexStatus,
    freshnessState: freshness.state,
    freshnessScore: freshness.score,
    runtimeAvailability: 'available',
    lastCheckedAt: timestamp
  }
  if (!isRepositoryHealth(health)) {
    return { ok: false, sourceId: source.id, reason: 'observation_failed' }
  }
  if (indexRecordFailed) return { ok: false, sourceId: source.id, reason: 'observation_failed', health }
  return { ok: true, health }
}

export class RepositoryHealthObserver {
  constructor(private readonly options: RepositoryHealthObserverOptions = {}) {}

  observe(sourceId: string): RepositoryHealthObservationResult {
    let sources: KnowledgeSource[]
    try {
      sources = this.options.sources ? [...this.options.sources] : (this.options.sourceLoader || (() => getSourcesSafe({ refreshGitMetadata: false })))()
    } catch {
      return { ok: false, sourceId, reason: 'source_missing' }
    }
    const source = sources.find(candidate => candidate.id === sourceId)
    if (!source) return { ok: false, sourceId, reason: 'source_missing' }
    return observeSource(source, this.options)
  }

  observeAll(): RepositoryHealthObservationResult[] {
    let sources: KnowledgeSource[]
    try {
      sources = this.options.sources ? [...this.options.sources] : (this.options.sourceLoader || (() => getSourcesSafe({ refreshGitMetadata: false })))()
    } catch {
      return []
    }
    if (!Array.isArray(sources)) return []
    return sources.slice(0, MAX_OBSERVED_SOURCES).map(source => observeSource(source, this.options))
  }
}

export function observeRepositoryHealth(sourceId: string, options: RepositoryHealthObserverOptions = {}): RepositoryHealthObservationResult {
  return new RepositoryHealthObserver(options).observe(sourceId)
}
