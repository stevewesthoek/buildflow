import crypto from 'crypto'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { finalizeWorkbenchPacketExecution, getWorkbenchPacketRecord } from './workbench-packet-store'
import { advanceWorkbenchRunAfterPacket, getAgentJob, updateAgentJob } from './agent-jobs'
import { loadConfig } from './config'
import { runSafeCommand, type SafeCommandResult } from './command-runner'
import { completeWorkbenchExecutionJournal, markWorkbenchExecutionJournalStep, prepareWorkbenchExecutionJournal, restoreWorkbenchExecutionJournal, type WorkbenchExecutionJournal } from './workbench-execution-journal'
import { planWorkbenchPacketExecution } from './workbench-packet-plan'

export type WorkbenchPacketExecutionResult = {
  status: 'completed' | 'failed' | 'rejected' | 'paused' | 'cancelled'
  packetId: string
  writesPerformed: boolean
  rolledBack: boolean
  planHash?: string
  completedSteps: number
  failedStep?: number
  validationResults?: Array<Pick<SafeCommandResult, 'commandKind' | 'status' | 'exitCode' | 'durationMs' | 'stdout' | 'stderr'>>
  commitResult?: Pick<SafeCommandResult, 'status' | 'exitCode' | 'stdout' | 'stderr'>
  commitHash?: string
  errors: Array<{ code: string; message: string; path?: string }>
}

type FileSnapshot = {
  path: string
  existed: boolean
  content?: Buffer
  mode?: number
}

class PacketControlSignal extends Error {
  constructor(readonly action: 'pause' | 'cancel', message: string) {
    super(message)
  }
}

function assertPacketControlAllowsExecution(packetId: string): void {
  const current = getWorkbenchPacketRecord(packetId)
  if (!current) throw new Error('packet disappeared during execution')
  if (current.controlRequested === 'pause') {
    throw new PacketControlSignal('pause', current.controlReason || 'Packet execution paused by run control.')
  }
  if (current.controlRequested === 'cancel') {
    throw new PacketControlSignal('cancel', current.controlReason || 'Packet execution cancelled by run control.')
  }
}

function sha256Buffer(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function snapshotFile(fullPath: string): FileSnapshot {
  if (!fs.existsSync(fullPath)) return { path: fullPath, existed: false }
  const stat = fs.lstatSync(fullPath)
  if (!stat.isFile()) throw new Error(`Only regular files are supported: ${fullPath}`)
  return { path: fullPath, existed: true, content: fs.readFileSync(fullPath), mode: stat.mode }
}

function restoreSnapshots(snapshots: FileSnapshot[]): void {
  for (const snapshot of [...snapshots].reverse()) {
    if (snapshot.existed) {
      fs.mkdirSync(path.dirname(snapshot.path), { recursive: true })
      fs.writeFileSync(snapshot.path, snapshot.content || Buffer.alloc(0))
      if (typeof snapshot.mode === 'number') fs.chmodSync(snapshot.path, snapshot.mode)
    } else if (fs.existsSync(snapshot.path)) {
      const stat = fs.lstatSync(snapshot.path)
      if (stat.isFile()) fs.unlinkSync(snapshot.path)
      else throw new Error(`Rollback refused non-file path: ${snapshot.path}`)
    }
  }
}

function verifyFileHash(fullPath: string, expectedHash: string): void {
  if (!fs.existsSync(fullPath)) throw new Error(`Expected file to exist: ${fullPath}`)
  const actual = sha256Buffer(fs.readFileSync(fullPath))
  if (actual !== expectedHash) throw new Error(`Verification hash mismatch: ${fullPath}`)
}

function gitLines(sourceRoot: string, args: string[]): string[] {
  const output = execFileSync('git', args, {
    cwd: sourceRoot,
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
  return output ? output.split(/\r?\n/).filter(Boolean) : []
}

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort()
}

function assertCleanPacketPaths(sourceRoot: string, exactPaths: string[], requireEmptyIndex: boolean): void {
  const dirtyPacketPaths = gitLines(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all', '--', ...exactPaths])
  if (dirtyPacketPaths.length > 0) throw new Error(`Packet paths already contain staged or unstaged changes: ${dirtyPacketPaths.join(', ')}`)
  if (requireEmptyIndex) {
    const stagedPaths = gitLines(sourceRoot, ['diff', '--cached', '--name-only'])
    if (stagedPaths.length > 0) throw new Error(`Git index already contains unrelated staged changes: ${stagedPaths.join(', ')}`)
  }
}

function verifyExactPathSet(actual: string[], expected: string[], label: string): void {
  const actualSorted = sortedUnique(actual)
  const expectedSorted = sortedUnique(expected)
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    throw new Error(`${label} paths differ from packet exact paths; actual=${actualSorted.join(',')} expected=${expectedSorted.join(',')}`)
  }
}

function syncRunOutcome(runId: string, packetId: string, status: 'completed' | 'failed', summary: string, commitHash?: string): void {
  const run = getAgentJob(runId)
  if (!run) return
  const completedPacketIds = status === 'completed'
    ? Array.from(new Set([...run.completedPacketIds, packetId]))
    : run.completedPacketIds
  updateAgentJob(runId, {
    completedPacketIds,
    currentCommit: commitHash || run.currentCommit,
    metrics: {
      ...run.metrics,
      completedPackets: completedPacketIds.length,
      failedPackets: run.metrics.failedPackets + (status === 'failed' ? 1 : 0)
    },
    summary
  })
}

export async function executeWorkbenchPacket(params: {
  packetId: string
  leaseToken: string
  sourceId: string
  sourceRoot: string
}): Promise<WorkbenchPacketExecutionResult> {
  const planResult = planWorkbenchPacketExecution(params)
  if (!planResult.ready) {
    return {
      status: 'rejected',
      packetId: params.packetId,
      writesPerformed: false,
      rolledBack: false,
      completedSteps: 0,
      errors: planResult.errors
    }
  }

  const record = getWorkbenchPacketRecord(params.packetId)
  if (!record) {
    return {
      status: 'rejected',
      packetId: params.packetId,
      writesPerformed: false,
      rolledBack: false,
      completedSteps: 0,
      errors: [{ code: 'PACKET_NOT_FOUND', message: 'packet disappeared after planning' }]
    }
  }

  const run = getAgentJob(record.packet.runId)
  const config = loadConfig()
  const sourceAllowsAutoCommit = (config?.autoCommitSourceIds || []).includes(params.sourceId)
  const automaticCommit = run?.autoCommit === true && sourceAllowsAutoCommit
  const explicitCommit = record.packet.commit?.enabled === true
  const shouldCommit = explicitCommit || automaticCommit
  const task = run?.roadmapPhases
    .flatMap(phase => phase.tasks)
    .find(candidate => candidate.id === record.packet.taskId)

  try {
    assertCleanPacketPaths(params.sourceRoot, record.exactPaths, shouldCommit)
  } catch (error) {
    return {
      status: 'rejected',
      packetId: params.packetId,
      writesPerformed: false,
      rolledBack: false,
      planHash: planResult.plan.planHash,
      completedSteps: 0,
      errors: [{ code: 'PACKET_GIT_STATE_NOT_ISOLATED', message: error instanceof Error ? error.message : String(error) }]
    }
  }

  const snapshots: FileSnapshot[] = []
  const snapshotPaths = Array.from(new Set(planResult.plan.exactPaths.map(relative => path.resolve(params.sourceRoot, relative))))
  let journal: WorkbenchExecutionJournal | undefined
  let completedSteps = 0
  let writesPerformed = false
  const validationResults: NonNullable<WorkbenchPacketExecutionResult['validationResults']> = []
  let commitResult: WorkbenchPacketExecutionResult['commitResult']
  let commitHash: string | undefined

  try {
    for (const fullPath of snapshotPaths) snapshots.push(snapshotFile(fullPath))
    journal = prepareWorkbenchExecutionJournal({
      record,
      sourceRoot: params.sourceRoot,
      planHash: planResult.plan.planHash
    })

    for (const [index, step] of record.packet.steps.entries()) {
      assertPacketControlAllowsExecution(params.packetId)
      const fullPath = path.resolve(params.sourceRoot, step.path)
      const targetPath = step.to ? path.resolve(params.sourceRoot, step.to) : undefined

      switch (step.type) {
        case 'create': {
          if (fs.existsSync(fullPath)) throw new Error(`Create target already exists: ${step.path}`)
          fs.mkdirSync(path.dirname(fullPath), { recursive: true })
          fs.writeFileSync(fullPath, step.content || '', 'utf8')
          verifyFileHash(fullPath, sha256Buffer(Buffer.from(step.content || '', 'utf8')))
          break
        }
        case 'overwrite': {
          if (!fs.existsSync(fullPath)) throw new Error(`Overwrite target does not exist: ${step.path}`)
          fs.writeFileSync(fullPath, step.content || '', 'utf8')
          verifyFileHash(fullPath, sha256Buffer(Buffer.from(step.content || '', 'utf8')))
          break
        }
        case 'append': {
          if (!fs.existsSync(fullPath)) throw new Error(`Append target does not exist: ${step.path}`)
          const before = fs.readFileSync(fullPath)
          const appended = Buffer.from(step.content || '', 'utf8')
          fs.appendFileSync(fullPath, appended)
          verifyFileHash(fullPath, sha256Buffer(Buffer.concat([before, appended])))
          break
        }
        case 'patch': {
          if (!fs.existsSync(fullPath)) throw new Error(`Patch target does not exist: ${step.path}`)
          const original = fs.readFileSync(fullPath, 'utf8')
          const find = step.find || ''
          if (!find) throw new Error(`Patch find text is required: ${step.path}`)
          const matches = original.split(find).length - 1
          if (matches !== 1) throw new Error(`Patch must match exactly once (${matches} matches): ${step.path}`)
          const updated = original.replace(find, step.replace || '')
          fs.writeFileSync(fullPath, updated, 'utf8')
          verifyFileHash(fullPath, sha256Buffer(Buffer.from(updated, 'utf8')))
          break
        }
        case 'delete_file': {
          if (!fs.existsSync(fullPath)) throw new Error(`Delete target does not exist: ${step.path}`)
          fs.unlinkSync(fullPath)
          if (fs.existsSync(fullPath)) throw new Error(`Delete verification failed: ${step.path}`)
          break
        }
        case 'move': {
          if (!targetPath) throw new Error(`Move target is required: ${step.path}`)
          if (!fs.existsSync(fullPath)) throw new Error(`Move source does not exist: ${step.path}`)
          if (fs.existsSync(targetPath)) throw new Error(`Move target already exists: ${step.to}`)
          const sourceHash = sha256Buffer(fs.readFileSync(fullPath))
          fs.mkdirSync(path.dirname(targetPath), { recursive: true })
          fs.renameSync(fullPath, targetPath)
          if (fs.existsSync(fullPath)) throw new Error(`Move source still exists: ${step.path}`)
          verifyFileHash(targetPath, sourceHash)
          break
        }
      }

      writesPerformed = true
      completedSteps = index + 1
      markWorkbenchExecutionJournalStep(params.packetId, completedSteps)
    }

    for (const validation of record.packet.validation || []) {
      assertPacketControlAllowsExecution(params.packetId)
      const result = await runSafeCommand({
        sourceId: params.sourceId,
        sourceRoot: params.sourceRoot,
        commandKind: validation.commandKind,
        timeoutMs: validation.timeoutMs,
        paths: validation.paths,
        packageDir: validation.packageDir,
        scriptName: validation.scriptName,
        marker: validation.marker,
        patternSet: validation.patternSet
      })
      validationResults.push({
        commandKind: result.commandKind,
        status: result.status,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stdout: result.stdout.slice(0, 2000),
        stderr: result.stderr.slice(0, 1000)
      })
      if (result.status !== 'completed') throw new Error(`Validation ${result.commandKind} failed`)
      assertPacketControlAllowsExecution(params.packetId)
    }

    if (shouldCommit) {
      assertPacketControlAllowsExecution(params.packetId)
      if (automaticCommit && (record.packet.validation || []).length === 0) {
        throw new Error('Automatic commit requires at least one targeted validation.')
      }
      if (automaticCommit && validationResults.some(result => result.status !== 'completed')) {
        throw new Error('Automatic commit requires all targeted validations to pass.')
      }

      const securityScan = await runSafeCommand({
        sourceId: params.sourceId,
        sourceRoot: params.sourceRoot,
        commandKind: 'security_scan_paths',
        paths: record.exactPaths,
        patternSet: 'forbidden_secret_material'
      })
      validationResults.push({
        commandKind: securityScan.commandKind,
        status: securityScan.status,
        exitCode: securityScan.exitCode,
        durationMs: securityScan.durationMs,
        stdout: securityScan.stdout.slice(0, 2000),
        stderr: securityScan.stderr.slice(0, 1000)
      })
      if (securityScan.status !== 'completed') throw new Error(`Exact-path secret scan failed: ${securityScan.stderr || securityScan.stdout}`)
      assertPacketControlAllowsExecution(params.packetId)

      const staged = await runSafeCommand({
        sourceId: params.sourceId,
        sourceRoot: params.sourceRoot,
        commandKind: 'git_add_paths',
        paths: record.exactPaths
      })
      if (staged.status !== 'completed') throw new Error(`Exact-path staging failed: ${staged.stderr || staged.stdout}`)
      verifyExactPathSet(
        gitLines(params.sourceRoot, ['diff', '--cached', '--name-only']),
        record.exactPaths,
        'Staged'
      )

      const derivedTitle = String(task?.title || record.packet.goalSummary || 'complete packet')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 180)
      const commitMessage = record.packet.commit?.message?.trim() || `workbench: ${derivedTitle}`
      const existingBody = record.packet.commit?.body?.trim()
      const trailer = `Workbench-Run: ${record.packet.runId}\nWorkbench-Packet: ${record.packet.packetId}`
      const commitBody = existingBody ? `${existingBody}\n\n${trailer}` : trailer
      const committed = await runSafeCommand({
        sourceId: params.sourceId,
        sourceRoot: params.sourceRoot,
        commandKind: 'git_commit',
        message: commitMessage,
        body: commitBody
      })
      commitResult = {
        status: committed.status,
        exitCode: committed.exitCode,
        stdout: committed.stdout.slice(0, 2000),
        stderr: committed.stderr.slice(0, 1000)
      }
      if (committed.status !== 'completed') throw new Error(`Packet commit failed: ${committed.stderr || committed.stdout}`)
      commitHash = gitLines(params.sourceRoot, ['rev-parse', 'HEAD'])[0]
      if (!commitHash) throw new Error('Packet commit hash could not be resolved')
      verifyExactPathSet(
        gitLines(params.sourceRoot, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']),
        record.exactPaths,
        'Committed'
      )
    }

    assertPacketControlAllowsExecution(params.packetId)
    const finalized = finalizeWorkbenchPacketExecution({
      packetId: params.packetId,
      leaseToken: params.leaseToken,
      status: 'completed',
      commitHash
    })
    if (finalized.ok === false) throw new Error(`Packet finalization failed: ${finalized.message}`)
    completeWorkbenchExecutionJournal(params.packetId)
    advanceWorkbenchRunAfterPacket({
      runId: record.packet.runId,
      taskId: record.packet.taskId,
      packetId: params.packetId,
      commitHash
    })

    return {
      status: 'completed',
      packetId: params.packetId,
      writesPerformed,
      rolledBack: false,
      planHash: planResult.plan.planHash,
      completedSteps,
      validationResults,
      commitResult,
      commitHash,
      errors: []
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const controlAction = error instanceof PacketControlSignal ? error.action : undefined
    let rolledBack = false
    try {
      if (journal) restoreWorkbenchExecutionJournal({ journal, sourceRoot: params.sourceRoot })
      else restoreSnapshots(snapshots)
      if (shouldCommit) {
        execFileSync('git', ['reset', '--quiet', '--', ...record.exactPaths], {
          cwd: params.sourceRoot,
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'pipe']
        })
      }
      rolledBack = true
    } catch (rollbackError) {
      const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
      finalizeWorkbenchPacketExecution({
        packetId: params.packetId,
        leaseToken: params.leaseToken,
        status: 'failed',
        failureReason: `${message}; rollback failed: ${rollbackMessage}`
      })
      syncRunOutcome(record.packet.runId, params.packetId, 'failed', `Packet ${params.packetId} failed and rollback also failed.`)
      return {
        status: 'failed',
        packetId: params.packetId,
        writesPerformed,
        rolledBack: false,
        planHash: planResult.plan.planHash,
        completedSteps,
        failedStep: completedSteps,
        errors: [
          { code: 'PACKET_EXECUTION_FAILED', message },
          { code: 'ROLLBACK_FAILED', message: rollbackMessage }
        ]
      }
    }

    if (controlAction) {
      const controlledStatus = controlAction === 'pause' ? 'paused' : 'cancelled'
      finalizeWorkbenchPacketExecution({
        packetId: params.packetId,
        leaseToken: params.leaseToken,
        status: controlledStatus
      })
      if (journal) completeWorkbenchExecutionJournal(params.packetId)
      return {
        status: controlledStatus,
        packetId: params.packetId,
        writesPerformed,
        rolledBack,
        planHash: planResult.plan.planHash,
        completedSteps,
        errors: [{ code: controlAction === 'pause' ? 'PACKET_PAUSED' : 'PACKET_CANCELLED', message }]
      }
    }

    finalizeWorkbenchPacketExecution({
      packetId: params.packetId,
      leaseToken: params.leaseToken,
      status: 'failed',
      failureReason: message
    })
    if (journal) completeWorkbenchExecutionJournal(params.packetId)
    syncRunOutcome(record.packet.runId, params.packetId, 'failed', `Packet ${params.packetId} failed and was rolled back.`)
    return {
      status: 'failed',
      packetId: params.packetId,
      writesPerformed,
      rolledBack,
      planHash: planResult.plan.planHash,
      completedSteps,
      failedStep: completedSteps,
      errors: [{ code: 'PACKET_EXECUTION_FAILED', message }]
    }
  }
}




export type WorkbenchPacketCommitUndoResult = {
  status: 'reverted' | 'rejected'
  packetId: string
  originalCommitHash?: string
  revertCommitHash?: string
  exactPaths: string[]
  errors: Array<{ code: string; message: string }>
}

export function undoWorkbenchPacketCommit(params: {
  packetId: string
  sourceId: string
  sourceRoot: string
}): WorkbenchPacketCommitUndoResult {
  const record = getWorkbenchPacketRecord(params.packetId)
  const reject = (code: string, message: string): WorkbenchPacketCommitUndoResult => ({
    status: 'rejected',
    packetId: params.packetId,
    originalCommitHash: record?.commitHash,
    exactPaths: record?.exactPaths || [],
    errors: [{ code, message }]
  })

  if (!record || record.packet.sourceId !== params.sourceId) {
    return reject('UNDO_PACKET_NOT_FOUND', 'Packet was not found for the selected source.')
  }
  if (!record.commitHash) {
    return reject('UNDO_COMMIT_MISSING', 'Packet does not have a persisted commit hash.')
  }

  const head = gitLines(params.sourceRoot, ['rev-parse', 'HEAD'])[0]
  if (head !== record.commitHash) {
    return reject('UNDO_HEAD_MISMATCH', 'Safe undo requires the Workbench-created commit to be the current HEAD.')
  }

  const commitMessage = execFileSync('git', ['show', '-s', '--format=%B', head], {
    cwd: params.sourceRoot,
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (!commitMessage.includes(`Workbench-Run: ${record.packet.runId}`)
    || !commitMessage.includes(`Workbench-Packet: ${record.packet.packetId}`)) {
    return reject('UNDO_TRAILER_MISMATCH', 'Current HEAD is missing the expected Workbench commit trailers.')
  }

  try {
    verifyExactPathSet(
      gitLines(params.sourceRoot, ['diff-tree', '--no-commit-id', '--name-only', '-r', head]),
      record.exactPaths,
      'Undo target'
    )
  } catch (error) {
    return reject('UNDO_PATH_MISMATCH', error instanceof Error ? error.message : String(error))
  }

  if (gitLines(params.sourceRoot, ['diff', '--cached', '--name-only']).length > 0) {
    return reject('UNDO_INDEX_NOT_CLEAN', 'Safe undo requires an empty Git index.')
  }
  if (gitLines(params.sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all', '--', ...record.exactPaths]).length > 0) {
    return reject('UNDO_PACKET_PATHS_DIRTY', 'Safe undo requires the committed packet paths to be clean.')
  }

  try {
    execFileSync('git', ['revert', '--no-edit', head], {
      cwd: params.sourceRoot,
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const revertCommitHash = gitLines(params.sourceRoot, ['rev-parse', 'HEAD'])[0]
    if (!revertCommitHash || revertCommitHash === head) {
      return reject('UNDO_REVERT_HASH_MISSING', 'Safe undo did not produce a new revert commit.')
    }
    verifyExactPathSet(
      gitLines(params.sourceRoot, ['diff-tree', '--no-commit-id', '--name-only', '-r', revertCommitHash]),
      record.exactPaths,
      'Undo commit'
    )
    return {
      status: 'reverted',
      packetId: params.packetId,
      originalCommitHash: head,
      revertCommitHash,
      exactPaths: record.exactPaths,
      errors: []
    }
  } catch (error) {
    return reject('UNDO_REVERT_FAILED', error instanceof Error ? error.message : String(error))
  }
}
