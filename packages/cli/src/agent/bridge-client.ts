import WebSocket from 'ws'
import { ToolCallMessage, ToolResponseMessage } from '@buildflow/shared'
import { readFile, createFile, appendFile } from './vault'
import { Indexer } from './indexer'
import { VaultSearcher } from './search'
import { createExportPlan } from './export'
import { listWorkspaceTree, grepWorkspace, getWorkspaceInfo, resolveWorkspacePath, validateWorkspacePath } from './workspace'
import { getActiveSourceContext, getSourcesSafe, getWriteMode, setActiveSourceContext } from './config'
import { getResolvedActiveSources, getSourceRoot, isAllowedArtifactRoot, isAllowedSafeWriteRoot, isBlockedWritePath, redactSecrets, resolveTargetSourceId, resolveWithinSource, shouldIncludeEntry, truncateContent } from './safe-access'
import { debug, log } from '../utils/logger'
import { logToFile } from '../utils/logger'
import fs from 'fs'
import path from 'path'

export class BridgeClient {
  private ws: WebSocket | null = null
  private url: string
  private deviceToken: string
  private indexer: Indexer
  private searcher: VaultSearcher

  constructor(apiBaseUrl: string, deviceToken: string) {
    this.url = apiBaseUrl.replace('http://', 'ws://').replace('https://', 'wss://')
    this.deviceToken = deviceToken
    this.indexer = new Indexer()
    this.searcher = new VaultSearcher(this.indexer.getDocs())
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(`${this.url}/api/bridge/ws`)

        this.ws.on('open', () => {
          log('Connected to relay')

          // Authenticate
          this.ws?.send(JSON.stringify({
            type: 'auth',
            deviceToken: this.deviceToken
          }))

          resolve()
        })

        this.ws.on('message', (data: string) => {
          this.handleMessage(data)
        })

        this.ws.on('error', (err) => {
          console.error('WebSocket error:', err)
          reject(err)
        })

        this.ws.on('close', () => {
          log('Disconnected from relay')
        })
      } catch (err) {
        reject(err)
      }
    })
  }

  private async handleMessage(data: string): Promise<void> {
    try {
      const message = JSON.parse(data)

      // Handle command requests from relay transport
      if (message.type === 'command_request') {
        await this.handleCommandRequest(message)
        return
      }

      // Handle auth response
      if (message.type === 'auth_response') {
        if (message.status === 'ok') {
          log(`Device authenticated: ${message.deviceId}`)
        } else {
          console.error(`Auth failed: ${message.error}`)
        }
        return
      }

      // Handle ping (heartbeat)
      if (message.type === 'ping') {
        this.ws?.send(JSON.stringify({ type: 'pong' }))
        return
      }

      // Legacy tool call handling (for backward compatibility)
      const toolMessage = message as ToolCallMessage
      if (toolMessage.tool) {
        debug(`Received tool call: ${toolMessage.tool}`)

        let result: Record<string, unknown> | undefined
        let error: string | undefined

        try {
          switch (toolMessage.tool) {
            case 'search_plan':
              const searchInput = toolMessage.input as { query: string; limit?: number }
              const searchResults = this.searcher.search(searchInput.query, searchInput.limit)
              result = { results: searchResults }
              break

            case 'read_file':
              const readInput = toolMessage.input as { path: string }
              result = await readFile(readInput.path)
              break

            case 'create_note':
              const createInput = toolMessage.input as { path?: string; content: string }
              result = await createFile(createInput.path || '', createInput.content)
              await this.indexer.buildIndex()
              this.searcher.rebuild(this.indexer.getDocs())
              break

            case 'append_note':
              const appendInput = toolMessage.input as { path: string; content: string }
              result = await appendFile(appendInput.path, appendInput.content)
              break

            case 'export_claude_plan':
              result = await createExportPlan(toolMessage.input)
              await this.indexer.buildIndex()
              this.searcher.rebuild(this.indexer.getDocs())
              break

            default:
              error = `Unknown tool: ${toolMessage.tool}`
          }
        } catch (err) {
          error = String(err)
        }

        // Send response
        const response: ToolResponseMessage = {
          id: toolMessage.id,
          status: error ? 'error' : 'success',
          result: error ? undefined : result,
          error
        }

        this.ws?.send(JSON.stringify(response))
      }
    } catch (err) {
      console.error('Failed to handle message:', err)
    }
  }

  private async handleCommandRequest(message: any): Promise<void> {
    const { requestId, command, params } = message

    debug(`Received command from relay: ${command} (request ${requestId})`)

    let result: any = undefined
    let error: string | undefined

    try {
      switch (command) {
        case 'health':
        case 'action_proxy:status':
          result = {
            status: 'ok',
            deviceConnected: this.ws?.readyState === WebSocket.OPEN
          }
          break

        case 'workspaces': {
          const { getWorkspaces } = await import('./config')
          const workspaces = getWorkspaces()
          result = { workspaces }
          break
        }

        case 'tree': {
          const workspace = params.workspace || 'vault'
          const path = params.path || ''
          const maxDepth = params.maxDepth || 3
          const maxEntries = params.maxEntries || 100

          try {
            // Validate workspace exists
            getWorkspaceInfo(workspace)
            const tree = listWorkspaceTree(workspace, path, maxDepth, 0, maxEntries)
            result = { tree, count: tree.length }
          } catch (err) {
            error = String(err)
          }
          break
        }

        case 'grep': {
          const workspace = params.workspace || 'vault'
          const pattern = params.pattern
          if (!pattern) {
            error = 'Pattern required for grep'
            break
          }
          const maxResults = params.maxResults || 100
          const maxLineLength = params.maxLineLength || 500

          try {
            // Validate workspace exists
            getWorkspaceInfo(workspace)
            const results = grepWorkspace(workspace, pattern, { maxResults, maxLineLength })
            result = { results, count: results.length }
          } catch (err) {
            error = String(err)
          }
          break
        }

        case 'context': {
          const workspace = params.workspace || 'vault'
          const query = params.query || ''
          const maxDepth = params.maxDepth || 2
          const maxResults = params.maxResults || 20

          try {
            const ws = getWorkspaceInfo(workspace)
            const tree = listWorkspaceTree(workspace, '', maxDepth, 0, 50)
            let matches = []
            if (query) {
              matches = grepWorkspace(workspace, query, { maxResults })
            }
            const summary = `Workspace: ${ws.name}\nRoot: ${ws.root}\nMode: ${ws.mode}\nTree items: ${tree.length}`
            const entrypointNames = ['README.md', 'index.md', 'MANIFEST.md', 'package.json', 'tsconfig.json']
            const entrypoints = entrypointNames.filter(
              name => tree.some(n => n.name === name && n.type === 'file')
            )

            // Extract key files: read first 3 entrypoints
            const keyFiles = []
            for (const ep of entrypoints.slice(0, 3)) {
              try {
                const epPath = tree.find(n => n.name === ep && n.type === 'file')?.path
                if (epPath) {
                  const fullPath = resolveWorkspacePath(ws, epPath)
                  const stat = fs.statSync(fullPath)
                  // Skip if > 50KB
                  if (stat.size > 50000) continue
                  const content = fs.readFileSync(fullPath, 'utf-8')
                  keyFiles.push({
                    path: epPath,
                    content: content.slice(0, 2000),
                    size: stat.size
                  })
                }
              } catch (err) {
                // Skip if can't read
              }
            }

            result = { workspace, summary, tree, matches, entrypoints, keyFiles }
          } catch (err) {
            error = String(err)
          }
          break
        }

        case 'read': {
          const path = params.path
          if (!path) {
            error = 'Path required for read'
            break
          }
          const workspace = params.workspace || 'vault'

          try {
            // Validate workspace and path
            const ws = getWorkspaceInfo(workspace)
            const validation = validateWorkspacePath(ws, path)
            if (!validation.valid) {
              error = validation.error || 'Invalid path'
              break
            }

            // Resolve and read with guardrails
            const fullPath = resolveWorkspacePath(ws, path)

            if (!fs.existsSync(fullPath)) {
              error = 'File not found'
              break
            }

            const stat = fs.statSync(fullPath)
            if (!stat.isFile()) {
              error = 'Not a file'
              break
            }

            // Enforce 1MB size limit
            const maxSize = 1024 * 1024
            if (stat.size > maxSize) {
              error = `File too large (${stat.size} bytes, max ${maxSize})`
              break
            }

            const content = fs.readFileSync(fullPath, 'utf-8')
            result = { path, content, workspace, size: stat.size }
          } catch (err) {
            error = String(err)
          }
          break
        }

        case 'get-active-sources':
        case 'action_proxy:get-active-sources': {
          const active = getActiveSourceContext()
          const sources = getSourcesSafe().map(source => ({ id: source.id, label: source.label, enabled: source.enabled, active: active.activeSourceIds.includes(source.id), type: (source as { type?: string }).type || 'unknown' }))
          result = {
            mode: active.mode,
            activeSourceIds: active.activeSourceIds,
            sources
          }
          break
        }

        case 'set-active-sources': {
          const mode = params.mode
          const activeSourceIds = params.activeSourceIds || []
          const updated = setActiveSourceContext(mode, activeSourceIds)
          result = { status: 'ok', mode: updated.mode, activeSourceIds: updated.activeSourceIds }
          break
        }

        case 'list-files': {
          const sourceIds = params.sourceIds || (params.sourceId ? [params.sourceId] : undefined)
          const relPath = params.path || ''
          const depth = params.depth || 3
          const limit = params.limit || 100
          const targets = getResolvedActiveSources(sourceIds)
          const entries: Array<Record<string, unknown>> = []
          for (const source of targets) {
            try {
              const fullPath = path.resolve(path.join(source.path, path.normalize(relPath)))
              if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isDirectory()) continue
              const walk = (dir: string, currentRel: string, currentDepth: number): void => {
                if (entries.length >= limit || currentDepth > depth) return
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                  if (entries.length >= limit) break
                  if (!shouldIncludeEntry(entry.name)) continue
                  const nextRel = currentRel ? `${currentRel}/${entry.name}` : entry.name
                  const nextFull = path.join(dir, entry.name)
                  const stat = fs.statSync(nextFull)
                  entries.push({ sourceId: source.id, path: nextRel, type: entry.isDirectory() ? 'directory' : 'file', sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() })
                  if (entry.isDirectory() && currentDepth + 1 < depth) walk(nextFull, nextRel, currentDepth + 1)
                }
              }
              walk(fullPath, relPath, 0)
            } catch (err) {
              error = String(err)
            }
          }
          result = { sourceId: targets[0]?.id, path: relPath, entries }
          break
        }

        case 'read-files': {
          const sourceIds = params.sourceIds || (params.sourceId ? [params.sourceId] : undefined)
          const paths = Array.isArray(params.paths) ? params.paths : []
          const maxBytesPerFile = params.maxBytesPerFile || 30000
          const targets = getResolvedActiveSources(sourceIds)
          const files = []
          for (const relPath of paths.slice(0, 10)) {
            let found = false
            for (const source of targets) {
              try {
                const result = await readFile(relPath, source.id)
                const safe = redactSecrets(result.content)
                const truncated = truncateContent(safe, maxBytesPerFile)
                const fullPath = path.join(source.path, path.normalize(relPath))
                const stat = fs.statSync(fullPath)
                files.push({ sourceId: source.id, path: relPath, content: truncated.content, truncated: truncated.truncated, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() })
                found = true
                break
              } catch {}
            }
            if (!found) files.push({ path: relPath, error: 'File not found in active sources' })
          }
          result = { files }
          break
        }

        case 'create-artifact': {
          const artifactType = params.artifactType
          const title = params.title
          const content = params.content
          const folderMap: Record<string, string> = {
            implementation_plan: 'docs/product/plans',
            codex_prompt: 'docs/product/prompts/codex',
            claude_prompt: 'docs/product/prompts/claude',
            architecture_note: 'docs/product',
            research_summary: 'docs/product',
            test_plan: 'docs/product/testing',
            migration_plan: 'docs/product',
            task_brief: 'docs/product/tasks',
            general_doc: 'docs/product/notes'
          }
          const targetFolder = params.folder || folderMap[artifactType]
          const sourceId = resolveTargetSourceId(params.sourceId)
          if (!sourceId) throw new Error('Target sourceId required')
          const slug = (params.filename || title).toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-')
          const relPath = `${targetFolder.replace(/\/$/, '')}/${Date.now()}-${slug}.md`
          const resolved = resolveWithinSource(relPath, sourceId)
          fs.mkdirSync(path.dirname(resolved.fullPath), { recursive: true })
          if (fs.existsSync(resolved.fullPath)) throw new Error('Artifact already exists')
          fs.writeFileSync(resolved.fullPath, content, 'utf-8')
          result = { status: 'created', sourceId: resolved.sourceId, path: relPath, artifactType, created: true }
          break
        }

        case 'append-file': {
          const sourceId = resolveTargetSourceId(params.sourceId)
          const relPath = params.path
          const content = params.content
          const separator = params.separator ?? '\n\n'
          if (!sourceId) throw new Error('Target sourceId required')
          if (!relPath || !content) throw new Error('Path and content required')
          if (isBlockedWritePath(relPath) || !isAllowedSafeWriteRoot(relPath)) throw new Error('Append path blocked by safe write policy')
          if (getWriteMode() === 'readOnly') throw new Error('Write mode is readOnly')
          const resolved = resolveWithinSource(relPath, sourceId)
          if (!fs.existsSync(resolved.fullPath)) throw new Error('File not found')
          const appended = `${separator}${content}`
          fs.appendFileSync(resolved.fullPath, appended, 'utf-8')
          result = { status: 'ok', sourceId: resolved.sourceId, path: relPath, bytesAppended: Buffer.byteLength(appended, 'utf8') }
          break
        }

        case 'write-file': {
          const sourceId = resolveTargetSourceId(params.sourceId)
          const relPath = params.path
          const content = params.content
          const mode = params.mode || 'createOnly'
          if (!sourceId) throw new Error('Target sourceId required')
          if (getWriteMode() === 'readOnly') throw new Error('Write mode is readOnly')
          if (!relPath || !content) throw new Error('Path and content required')
          if (isBlockedWritePath(relPath) || !isAllowedSafeWriteRoot(relPath)) throw new Error('Write path blocked by safe write policy')
          const resolved = resolveWithinSource(relPath, sourceId)
          if (mode === 'createOnly' && fs.existsSync(resolved.fullPath)) throw new Error('File already exists')
          fs.mkdirSync(path.dirname(resolved.fullPath), { recursive: true })
          fs.writeFileSync(resolved.fullPath, content, 'utf-8')
          result = { status: 'ok', sourceId: resolved.sourceId, path: relPath, bytesWritten: Buffer.byteLength(content, 'utf8'), created: mode === 'createOnly', overwritten: mode === 'overwrite' }
          break
        }

        case 'patch-file': {
          const sourceId = resolveTargetSourceId(params.sourceId)
          const relPath = params.path
          const find = params.find
          const replace = params.replace || ''
          const allowMultiple = params.allowMultiple || false
          if (!sourceId) throw new Error('Target sourceId required')
          if (getWriteMode() === 'readOnly') throw new Error('Write mode is readOnly')
          if (!relPath || !find) throw new Error('Path and find required')
          if (isBlockedWritePath(relPath) || !isAllowedSafeWriteRoot(relPath)) throw new Error('Patch path blocked by safe write policy')
          const resolved = resolveWithinSource(relPath, sourceId)
          if (!fs.existsSync(resolved.fullPath)) throw new Error('File not found')
          const original = fs.readFileSync(resolved.fullPath, 'utf-8')
          const matches = original.split(find).length - 1
          if (matches === 0) throw new Error('Find text not found')
          if (matches > 1 && !allowMultiple) throw new Error('Find text matched multiple times')
          fs.writeFileSync(resolved.fullPath, original.replace(find, replace), 'utf-8')
          result = { status: 'ok', sourceId: resolved.sourceId, path: relPath, replacements: allowMultiple ? matches : 1 }
          break
        }

        case 'create-plan': {
          const title = params.title
          const content = params.content
          const folder = params.folder || 'docs/plans'
          if (!title || !content) {
            error = 'Title and content required'
            break
          }
          if (isBlockedWritePath(folder) || !isAllowedArtifactRoot(folder)) {
            error = 'Plan folder blocked'
            break
          }
          try {
            const slug = title.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-')
            const relPath = `${folder.replace(/\/$/, '')}/${Date.now()}-${slug}.md`
            const resolved = resolveWithinSource(relPath, params.sourceId)
            fs.mkdirSync(path.dirname(resolved.fullPath), { recursive: true })
            if (fs.existsSync(resolved.fullPath)) throw new Error('Plan already exists')
            fs.writeFileSync(resolved.fullPath, content, 'utf-8')
            result = { status: 'created', sourceId: resolved.sourceId, path: relPath }
          } catch (err) {
            error = String(err)
          }
          break
        }

        case 'action_proxy:search': {
          const query = params.query
          const limit = params.limit || 10
          if (!query) {
            error = 'Query required for search'
            break
          }
          try {
            const searchResults = this.searcher.search(query, limit)
            result = { results: searchResults }
          } catch (err) {
            error = String(err)
          }
          break
        }

        case 'action_proxy:read': {
          const path = params.path
          if (!path) {
            error = 'Path required for read'
            break
          }
          const workspace = params.workspace || 'vault'
          try {
            const ws = getWorkspaceInfo(workspace)
            const validation = validateWorkspacePath(ws, path)
            if (!validation.valid) {
              error = validation.error || 'Invalid path'
              break
            }
            const fullPath = resolveWorkspacePath(ws, path)
            if (!fs.existsSync(fullPath)) {
              error = 'File not found'
              break
            }
            const stat = fs.statSync(fullPath)
            if (!stat.isFile()) {
              error = 'Not a file'
              break
            }
            const maxSize = 1024 * 1024
            if (stat.size > maxSize) {
              error = `File too large (${stat.size} bytes, max ${maxSize})`
              break
            }
            const content = fs.readFileSync(fullPath, 'utf-8')
            result = { path, content }
          } catch (err) {
            error = String(err)
          }
          break
        }

        case 'action_proxy:create': {
          const content = params.content
          if (!content) {
            error = 'Content required for create'
            break
          }
          try {
            const path = params.path || `BuildFlow/Inbox/${new Date().toISOString().split('T')[0]}-note.md`
            const frontmatter = `---\ncreated: ${new Date().toISOString()}\nsource: buildflow\ntype: note\n---\n\n`
            const fullContent = frontmatter + content
            result = await createFile(path, fullContent)
            await this.indexer.buildIndex()
            this.searcher = new VaultSearcher(this.indexer.getDocs())
          } catch (err) {
            error = String(err)
          }
          break
        }

        case 'action_proxy:append': {
          const path = params.path
          const content = params.content
          if (!path || !content) {
            error = 'Path and content required for append'
            break
          }
          try {
            result = await appendFile(path, content)
            await this.indexer.buildIndex()
            this.searcher = new VaultSearcher(this.indexer.getDocs())
          } catch (err) {
            error = String(err)
          }
          break
        }

        default:
          error = `Unknown command: ${command}`
      }
    } catch (err) {
      error = String(err)
    }

    // Send response back to relay
    this.ws?.send(JSON.stringify({
      type: 'command_response',
      requestId,
      error: error || undefined,
      result: error ? undefined : result
    }))

    logToFile({
      timestamp: new Date().toISOString(),
      tool: 'relay_client_command',
      status: error ? 'error' : 'success',
      command,
      requestId,
      error
    })
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }
}
