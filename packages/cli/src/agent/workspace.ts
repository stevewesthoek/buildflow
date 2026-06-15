import fs from 'fs'
import path from 'path'
import { readdirSync, statSync } from 'fs'
import { getWorkspace } from './config'
import { logToFile } from '../utils/logger'
import type { Workspace, TreeNode } from '@workbench/shared'

export function resolveWorkspacePath(workspace: Workspace, relativePath: string = ''): string {
  const normalized = path.normalize(relativePath)
  const fullPath = path.join(workspace.root, normalized)
  const resolved = path.resolve(fullPath)
  const workspaceRoot = path.resolve(workspace.root)

  if (!resolved.startsWith(workspaceRoot)) {
    throw new Error(`Access denied. Path outside workspace: ${workspace.name}`)
  }

  return resolved
}

export function validateWorkspacePath(workspace: Workspace, relativePath: string): { valid: boolean; error?: string } {
  if (!relativePath) {
    return { valid: true }
  }

  if (relativePath.includes('..') || relativePath.startsWith('/')) {
    return { valid: false, error: 'Path traversal not allowed' }
  }

  const parts = relativePath.split('/')
  if (parts.some(part => part.startsWith('.'))) {
    return { valid: false, error: 'Hidden files not allowed' }
  }

  if (workspace.excludePatterns) {
    for (const pattern of workspace.excludePatterns) {
      const normalized = pattern.replace('/**', '').replace('/**/', '/')
      if (relativePath.includes(normalized)) {
        return { valid: false, error: `Path matches exclude pattern: ${pattern}` }
      }
    }
  }

  return { valid: true }
}

export function getWorkspaceInfo(workspaceName: string): Workspace {
  const workspace = getWorkspace(workspaceName)
  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceName}`)
  }

  if (!fs.existsSync(workspace.root)) {
    throw new Error(`Workspace root does not exist: ${workspace.root}`)
  }

  return workspace
}

export function listWorkspaceTree(
  workspaceName: string,
  relativePath: string = '',
  maxDepth: number = 3,
  currentDepth: number = 0,
  maxEntries: number = 100
): TreeNode[] {
  if (currentDepth >= maxDepth || maxEntries <= 0) {
    return []
  }

  const workspace = getWorkspaceInfo(workspaceName)
  const validation = validateWorkspacePath(workspace, relativePath)

  if (!validation.valid) {
    throw new Error(validation.error)
  }

  const fullPath = resolveWorkspacePath(workspace, relativePath)

  if (!fs.existsSync(fullPath)) {
    throw new Error(`Path not found: ${relativePath}`)
  }

  const stat = statSync(fullPath)
  if (!stat.isDirectory()) {
    return []
  }

  const items: TreeNode[] = []
  const entries = readdirSync(fullPath, { withFileTypes: true })

  for (const entry of entries) {
    if (maxEntries <= 0) break

    if (entry.name.startsWith('.')) {
      continue
    }

    const entryRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name
    const entryFullPath = path.join(fullPath, entry.name)

    // Check exclude patterns BEFORE adding to tree
    const validation = validateWorkspacePath(workspace, entryRelativePath)
    if (!validation.valid) {
      continue
    }

    try {
      const entryStat = statSync(entryFullPath)
      const node: TreeNode = {
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
        path: entryRelativePath,
        size: entryStat.size,
        modifiedAt: entryStat.mtime.toISOString()
      }

      items.push(node)
      maxEntries--

      if (entry.isDirectory() && currentDepth + 1 < maxDepth) {
        const childItems = listWorkspaceTree(
          workspaceName,
          entryRelativePath,
          maxDepth,
          currentDepth + 1,
          maxEntries
        )
        maxEntries -= childItems.length
      }
    } catch (err) {
      logToFile({
        timestamp: new Date().toISOString(),
        tool: 'workspace_tree',
        status: 'error',
        path: entryRelativePath,
        error: String(err)
      })
    }
  }

  return items
}

export function grepWorkspace(
  workspaceName: string,
  pattern: string,
  options: {
    includeGlobs?: string[]
    excludeGlobs?: string[]
    maxResults?: number
    maxLineLength?: number
  } = {}
): Array<{ file: string; line: number; content: string }> {
  const workspace = getWorkspaceInfo(workspaceName)
  const maxResults = options.maxResults ?? 100
  const maxLineLength = options.maxLineLength ?? 500
  const results: Array<{ file: string; line: number; content: string }> = []

  function walkDir(dir: string, relativePrefix: string = ''): void {
    if (results.length >= maxResults) return

    try {
      const entries = readdirSync(dir, { withFileTypes: true })

      for (const entry of entries) {
        if (results.length >= maxResults) break
        if (entry.name.startsWith('.')) continue

        const fullPath = path.join(dir, entry.name)
        const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name

        // Check exclude patterns
        const validation = validateWorkspacePath(workspace, relativePath)
        if (!validation.valid) continue

        if (entry.isDirectory()) {
          walkDir(fullPath, relativePath)
        } else if (entry.isFile() && entry.name.match(/\.(md|txt|ts|tsx|js|jsx|json|yaml|yml)$/)) {
          try {
            const content = fs.readFileSync(fullPath, 'utf-8')
            const lines = content.split('\n')

            lines.forEach((line, index) => {
              if (results.length >= maxResults) return
              if (line.match(new RegExp(pattern, 'i'))) {
                results.push({
                  file: relativePath,
                  line: index + 1,
                  content: line.slice(0, maxLineLength)
                })
              }
            })
          } catch (err) {
            logToFile({
              timestamp: new Date().toISOString(),
              tool: 'workspace_grep',
              status: 'error',
              file: relativePath,
              error: String(err)
            })
          }
        }
      }
    } catch (err) {
      logToFile({
        timestamp: new Date().toISOString(),
        tool: 'workspace_grep',
        status: 'error',
        path: relativePrefix,
        error: String(err)
      })
    }
  }

  walkDir(workspace.root)
  return results
}
