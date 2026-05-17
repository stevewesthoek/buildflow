import fs from 'fs'
import { promises as fsp } from 'fs'
import path from 'path'
import { getVaultPath, getEnabledSources, getInboxSourceId } from './config'
import { validatePath } from './permissions'
import { logToFile } from '../utils/logger'
import { verifyWrittenFile } from './write-verification'

export async function resolveSafePath(relativePath: string, sourceId?: string): Promise<string> {
  const normalized = path.normalize(relativePath)

  // If sourceId provided, resolve against that source specifically
  if (sourceId) {
    const sources = getEnabledSources()
    const source = sources.find(s => s.id === sourceId)
    if (!source) {
      throw new Error(`Source not found: ${sourceId}`)
    }

    const fullPath = path.join(source.path, normalized)
    const resolved = path.resolve(fullPath)

    if (!resolved.startsWith(path.resolve(source.path))) {
      throw new Error('Access denied. Path outside source.')
    }

    return resolved
  }

  // Fallback: try each enabled source until file is found
  const sources = getEnabledSources()
  for (const source of sources) {
    const fullPath = path.join(source.path, normalized)
    const resolved = path.resolve(fullPath)

    if (!resolved.startsWith(path.resolve(source.path))) {
      continue
    }

    if (fs.existsSync(resolved)) {
      return resolved
    }
  }

  // No file found in any source; return first source for backward compatibility
  if (sources.length === 0) {
    const vaultPath = getVaultPath()
    const fullPath = path.join(vaultPath, normalized)
    const resolved = path.resolve(fullPath)
    if (!resolved.startsWith(path.resolve(vaultPath))) {
      throw new Error('Access denied. Path outside vault.')
    }
    return resolved
  }

  // If still not found, throw
  throw new Error(`File not found in any enabled knowledge source: ${relativePath}`)
}

export async function readFile(relativePath: string, sourceId?: string): Promise<{ path: string; content: string }> {
  const validation = validatePath(relativePath)
  if (!validation.valid) {
    throw new Error(validation.error)
  }

  try {
    const fullPath = await resolveSafePath(relativePath, sourceId)
    const content = await fsp.readFile(fullPath, 'utf-8')

    logToFile({
      timestamp: new Date().toISOString(),
      tool: 'read_file',
      path: relativePath,
      sourceId,
      status: 'success'
    })

    return { path: relativePath, content }
  } catch (err) {
    logToFile({
      timestamp: new Date().toISOString(),
      tool: 'read_file',
      path: relativePath,
      sourceId,
      status: 'error',
      error: String(err)
    })
    throw err
  }
}

export async function createFile(relativePath: string, content: string): Promise<{ path: string; created: boolean } & ReturnType<typeof verifyWrittenFile>> {
  const validation = validatePath(relativePath)
  if (!validation.valid) {
    throw new Error(validation.error)
  }

  try {
    const fullPath = await resolveSafePath(relativePath)

    // Check if file exists
    if (fs.existsSync(fullPath)) {
      throw new Error('File already exists. Use append-note or choose a new path.')
    }

    // Create directory structure
    const dir = path.dirname(fullPath)
    fs.mkdirSync(dir, { recursive: true })

    // Write file
    fs.writeFileSync(fullPath, content, 'utf-8')

    logToFile({
      timestamp: new Date().toISOString(),
      tool: 'create_file',
      path: relativePath,
      status: 'success'
    })

    const verification = verifyWrittenFile({ fullPath, expectedContent: content })
    return { path: relativePath, created: true, ...verification }
  } catch (err) {
    logToFile({
      timestamp: new Date().toISOString(),
      tool: 'create_file',
      path: relativePath,
      status: 'error',
      error: String(err)
    })
    throw err
  }
}

export async function createInboxNote(relativePath: string, content: string, sourceId?: string): Promise<{ path: string; created: boolean } & ReturnType<typeof verifyWrittenFile>> {
  const validation = validatePath(relativePath)
  if (!validation.valid) {
    throw new Error(validation.error)
  }

  const sources = getEnabledSources()
  if (sources.length === 0) {
    throw new Error('No enabled knowledge sources configured')
  }

  const targetSourceId = sourceId || getInboxSourceId()
  const targetSource = sources.find(source => source.id === targetSourceId)
  if (!targetSource) {
    throw new Error(`Inbox source not found or disabled: ${targetSourceId}`)
  }

  const normalizedPath = path.normalize(relativePath)
  const fullPath = path.resolve(path.join(targetSource.path, normalizedPath))
  const sourceRoot = path.resolve(targetSource.path)

  if (!fullPath.startsWith(sourceRoot)) {
    throw new Error('Access denied. Path outside source.')
  }

  try {
    if (fs.existsSync(fullPath)) {
      throw new Error('File already exists')
    }

    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, content, 'utf-8')

    logToFile({
      timestamp: new Date().toISOString(),
      tool: 'create_inbox_note',
      path: relativePath,
      sourceId: targetSource.id,
      status: 'success'
    })

    const verification = verifyWrittenFile({ fullPath, expectedContent: content })
    return { path: relativePath, created: true, ...verification }
  } catch (err) {
    logToFile({
      timestamp: new Date().toISOString(),
      tool: 'create_inbox_note',
      path: relativePath,
      sourceId: targetSource.id,
      status: 'error',
      error: String(err)
    })
    throw err
  }
}

export async function appendFile(relativePath: string, content: string): Promise<{ path: string; appended: boolean } & ReturnType<typeof verifyWrittenFile>> {
  const validation = validatePath(relativePath)
  if (!validation.valid) {
    throw new Error(validation.error)
  }

  try {
    const fullPath = await resolveSafePath(relativePath)

    // Check if file exists
    if (!fs.existsSync(fullPath)) {
      throw new Error('File not found.')
    }

    // Append to file
    fs.appendFileSync(fullPath, content, 'utf-8')

    logToFile({
      timestamp: new Date().toISOString(),
      tool: 'append_file',
      path: relativePath,
      status: 'success'
    })

    const verification = verifyWrittenFile({
      fullPath,
      expectedContains: [content]
    })
    return { path: relativePath, appended: true, ...verification }
  } catch (err) {
    logToFile({
      timestamp: new Date().toISOString(),
      tool: 'append_file',
      path: relativePath,
      status: 'error',
      error: String(err)
    })
    throw err
  }
}

export async function listFolder(relativePath?: string): Promise<Array<{ path: string; type: 'file' | 'folder' }>> {
  const vaultPath = getVaultPath()
  const fullPath = relativePath ? await resolveSafePath(relativePath) : vaultPath

  const entries = fs.readdirSync(fullPath, { withFileTypes: true })
  const results = []

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue

    results.push({
      path: relativePath ? `${relativePath}/${entry.name}` : entry.name,
      type: entry.isDirectory() ? ('folder' as const) : ('file' as const)
    })
  }

  return results
}
