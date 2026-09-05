import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FocusedWorkspaceRecord, KnowledgeSource } from '@workbench/shared'

const FOCUS_VERSION = 1 as const

export function getFocusedWorkspacePath(): string {
  return process.env.WORKBENCH_FOCUSED_WORKSPACE_PATH || path.join(os.homedir(), '.config', 'workbench', 'focused-workspace.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function getFocusedWorkspace(): FocusedWorkspaceRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(getFocusedWorkspacePath(), 'utf8'))
    if (!isRecord(parsed) || parsed.version !== FOCUS_VERSION) return undefined
    if (typeof parsed.sourceId !== 'string' || !parsed.sourceId.trim()) return undefined
    if (typeof parsed.sourcePath !== 'string' || !parsed.sourcePath.trim()) return undefined
    if (typeof parsed.updatedAt !== 'string' || !parsed.updatedAt.trim()) return undefined
    for (const key of ['repoGroupId', 'repoRoot', 'branchName']) {
      if (parsed[key] !== undefined && typeof parsed[key] !== 'string') return undefined
    }
    if (parsed.isGitWorktree !== undefined && typeof parsed.isGitWorktree !== 'boolean') return undefined
    return parsed as unknown as FocusedWorkspaceRecord
  } catch {
    return undefined
  }
}

export function focusedWorkspaceRecordForSource(source: KnowledgeSource, updatedAt = new Date().toISOString()): FocusedWorkspaceRecord {
  return {
    version: FOCUS_VERSION,
    sourceId: source.id,
    sourcePath: source.path,
    ...(source.repoGroupId ? { repoGroupId: source.repoGroupId } : {}),
    ...(source.repoRoot ? { repoRoot: source.repoRoot } : {}),
    ...(source.branchName ? { branchName: source.branchName } : {}),
    ...(source.isGitWorktree !== undefined ? { isGitWorktree: source.isGitWorktree } : {}),
    updatedAt
  }
}

export function setFocusedWorkspace(source: KnowledgeSource): FocusedWorkspaceRecord {
  const target = getFocusedWorkspacePath()
  const directory = path.dirname(target)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(directory, 0o700) } catch { /* best effort on supported filesystems */ }
  const record = focusedWorkspaceRecordForSource(source)
  const temporary = `${target}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(record, null, 2), { mode: 0o600 })
  try { fs.chmodSync(temporary, 0o600) } catch { /* best effort on supported filesystems */ }
  fs.renameSync(temporary, target)
  return record
}
