import fs from 'fs'
import path from 'path'
import { getConfigDir } from '../utils/paths'
import type { WorkbenchPacketRecord } from './workbench-packet-store'

export const WORKBENCH_EXECUTION_JOURNAL_VERSION = 1 as const

export type WorkbenchExecutionJournalSnapshot = {
  relativePath: string
  existed: boolean
  contentBase64?: string
  mode?: number
}

export type WorkbenchExecutionJournal = {
  version: typeof WORKBENCH_EXECUTION_JOURNAL_VERSION
  packetId: string
  runId: string
  sourceId: string
  planHash: string
  leaseToken: string
  status: 'prepared' | 'executing' | 'restoring'
  completedSteps: number
  createdAt: string
  updatedAt: string
  snapshots: WorkbenchExecutionJournalSnapshot[]
}

const JOURNAL_DIR = path.join(getConfigDir(), 'workbench-packet-journals')

function journalPath(packetId: string): string {
  const safePacketId = String(packetId || '').replace(/[^A-Za-z0-9._:-]/g, '_')
  return path.join(JOURNAL_DIR, `${safePacketId}.json`)
}

function writeJournal(journal: WorkbenchExecutionJournal): void {
  fs.mkdirSync(JOURNAL_DIR, { recursive: true })
  const target = journalPath(journal.packetId)
  const temporary = `${target}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(journal), 'utf8')
  fs.renameSync(temporary, target)
}

function readJournalFile(filePath: string): WorkbenchExecutionJournal | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<WorkbenchExecutionJournal>
    if (parsed.version !== WORKBENCH_EXECUTION_JOURNAL_VERSION) return undefined
    if (!parsed.packetId || !parsed.sourceId || !Array.isArray(parsed.snapshots)) return undefined
    return parsed as WorkbenchExecutionJournal
  } catch {
    return undefined
  }
}

export function prepareWorkbenchExecutionJournal(params: {
  record: WorkbenchPacketRecord
  sourceRoot: string
  planHash: string
}): WorkbenchExecutionJournal {
  if (!params.record.leaseToken) throw new Error('Cannot journal a packet without an active lease token')
  const sourceRoot = path.resolve(params.sourceRoot)
  const snapshots = params.record.exactPaths.map(relativePath => {
    const fullPath = path.resolve(sourceRoot, relativePath)
    if (!fullPath.startsWith(`${sourceRoot}${path.sep}`) && fullPath !== sourceRoot) {
      throw new Error(`Journal path escaped source root: ${relativePath}`)
    }
    if (!fs.existsSync(fullPath)) return { relativePath, existed: false }
    const stat = fs.lstatSync(fullPath)
    if (!stat.isFile()) throw new Error(`Journal only supports regular files: ${relativePath}`)
    return {
      relativePath,
      existed: true,
      contentBase64: fs.readFileSync(fullPath).toString('base64'),
      mode: stat.mode
    }
  })

  const now = new Date().toISOString()
  const journal: WorkbenchExecutionJournal = {
    version: WORKBENCH_EXECUTION_JOURNAL_VERSION,
    packetId: params.record.packet.packetId,
    runId: params.record.packet.runId,
    sourceId: params.record.packet.sourceId,
    planHash: params.planHash,
    leaseToken: params.record.leaseToken,
    status: 'prepared',
    completedSteps: 0,
    createdAt: now,
    updatedAt: now,
    snapshots
  }
  writeJournal(journal)
  return journal
}

export function markWorkbenchExecutionJournalStep(packetId: string, completedSteps: number): void {
  const target = journalPath(packetId)
  const journal = readJournalFile(target)
  if (!journal) throw new Error(`Execution journal not found: ${packetId}`)
  writeJournal({
    ...journal,
    status: 'executing',
    completedSteps,
    updatedAt: new Date().toISOString()
  })
}

export function restoreWorkbenchExecutionJournal(params: {
  journal: WorkbenchExecutionJournal
  sourceRoot: string
}): void {
  writeJournal({ ...params.journal, status: 'restoring', updatedAt: new Date().toISOString() })
  const sourceRoot = path.resolve(params.sourceRoot)
  for (const snapshot of [...params.journal.snapshots].reverse()) {
    const fullPath = path.resolve(sourceRoot, snapshot.relativePath)
    if (!fullPath.startsWith(`${sourceRoot}${path.sep}`) && fullPath !== sourceRoot) {
      throw new Error(`Recovery path escaped source root: ${snapshot.relativePath}`)
    }
    if (snapshot.existed) {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true })
      fs.writeFileSync(fullPath, Buffer.from(snapshot.contentBase64 || '', 'base64'))
      if (typeof snapshot.mode === 'number') fs.chmodSync(fullPath, snapshot.mode)
    } else if (fs.existsSync(fullPath)) {
      const stat = fs.lstatSync(fullPath)
      if (!stat.isFile()) throw new Error(`Recovery refused non-file path: ${snapshot.relativePath}`)
      fs.unlinkSync(fullPath)
    }
  }
}

export function completeWorkbenchExecutionJournal(packetId: string): void {
  const target = journalPath(packetId)
  if (fs.existsSync(target)) fs.unlinkSync(target)
}

export function listWorkbenchExecutionJournals(): WorkbenchExecutionJournal[] {
  if (!fs.existsSync(JOURNAL_DIR)) return []
  return fs.readdirSync(JOURNAL_DIR)
    .filter(name => name.endsWith('.json'))
    .map(name => readJournalFile(path.join(JOURNAL_DIR, name)))
    .filter((journal): journal is WorkbenchExecutionJournal => Boolean(journal))
}

export function recoverWorkbenchExecutionJournals(params: {
  sourceRootFor: (sourceId: string) => string | undefined
  onRecovered: (journal: WorkbenchExecutionJournal) => void
}): { recovered: number; failed: Array<{ packetId: string; error: string }> } {
  let recovered = 0
  const failed: Array<{ packetId: string; error: string }> = []
  for (const journal of listWorkbenchExecutionJournals()) {
    try {
      const sourceRoot = params.sourceRootFor(journal.sourceId)
      if (!sourceRoot) throw new Error(`Source root unavailable: ${journal.sourceId}`)
      restoreWorkbenchExecutionJournal({ journal, sourceRoot })
      params.onRecovered(journal)
      completeWorkbenchExecutionJournal(journal.packetId)
      recovered += 1
    } catch (error) {
      failed.push({ packetId: journal.packetId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { recovered, failed }
}
