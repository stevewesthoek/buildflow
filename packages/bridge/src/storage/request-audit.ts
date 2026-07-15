import fs from 'fs'
import path from 'path'
import type { RequestRecord } from './types'
import { getDataPath } from './data-dir'

let REQUESTS_FILE = ''

function initFile(): string {
  if (!REQUESTS_FILE) {
    REQUESTS_FILE = getDataPath('relay-requests.json')
  }
  return REQUESTS_FILE
}
const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB

let requestLog: RequestRecord[] = []

function ensureDir(): void {
  const dir = path.dirname(initFile())
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function replaceLogAtomically(content: string): void {
  const temporary = `${initFile()}.tmp-${process.pid}`
  fs.writeFileSync(temporary, content, { mode: 0o600 })
  fs.renameSync(temporary, initFile())
  fs.chmodSync(initFile(), 0o600)
}

function loadFromDisk(): RequestRecord[] | null {
  ensureDir()
  if (!fs.existsSync(initFile())) {
    return []
  }
  try {
    const content = fs.readFileSync(initFile(), 'utf-8')
    const data = JSON.parse(content)
    if (!Array.isArray(data)) throw new Error('Request audit root must be an array.')
    return data
  } catch (err) {
    console.error(`Failed to load request log: ${err}`)
    return null
  }
}

function saveToDisk(): boolean {
  ensureDir()
  try {
    const content = JSON.stringify(requestLog, null, 2)
    replaceLogAtomically(content)

    // Check size and rotate if needed
    const stats = fs.statSync(initFile())
    if (stats.size > MAX_FILE_SIZE) {
      rotateLog()
    }
    return true
  } catch (err) {
    console.error(`Failed to save request log: ${err}`)
    return false
  }
}

function rotateLog(): void {
  ensureDir()
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const archivePath = path.join(
      path.dirname(initFile()),
      `relay-requests-archive-${timestamp}.json`
    )
    fs.copyFileSync(initFile(), archivePath)
    requestLog = []
    replaceLogAtomically(JSON.stringify([], null, 2))
    console.log(`[RequestAudit] Rotated log to ${archivePath}`)
  } catch (err) {
    console.error(`Failed to rotate request log: ${err}`)
  }
}

export function loadRequests(): RequestRecord[] {
  const loaded = loadFromDisk()
  if (loaded === null) return []
  requestLog = loaded
  return requestLog
}

export function logRequest(record: RequestRecord): boolean {
  const loaded = loadFromDisk()
  if (loaded === null) return false
  requestLog = loaded
  requestLog.push(record)
  return saveToDisk()
}

export function getRecentRequests(limit: number = 50): RequestRecord[] {
  const start = Math.max(0, requestLog.length - limit)
  return requestLog.slice(start)
}

export function getAllRequests(): RequestRecord[] {
  return [...requestLog]
}
