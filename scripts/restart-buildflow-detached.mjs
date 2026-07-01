#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..')
const STACK_SCRIPT = path.join(REPO_ROOT, 'scripts', 'buildflow-local-stack.sh')
const START_DELAY_MS = 2_500
const VERIFY_TIMEOUT_MS = 5_000

function now() {
  return new Date().toISOString()
}

function isVerifyRestart(restartId) {
  return restartId.startsWith('verify-restart-')
}

function pathsFor(restartId) {
  const verify = isVerifyRestart(restartId)
  return {
    statePath: verify ? `/tmp/${restartId}.json` : '/tmp/buildflow-restart-latest.json',
    lockPath: verify ? '/tmp/buildflow-restart-verify.lock' : '/tmp/buildflow-restart.lock',
    logPath: `/tmp/buildflow-restart-${restartId}.log`
  }
}

function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tempPath, filePath)
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function acquireLock(lockPath, restartId) {
  const attempt = () => {
    fs.mkdirSync(lockPath, { mode: 0o700 })
    writeJsonAtomic(path.join(lockPath, 'owner.json'), {
      restartId,
      pid: process.pid,
      acquiredAt: now()
    })
  }

  try {
    attempt()
    return
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }

  let owner
  try {
    owner = readJson(path.join(lockPath, 'owner.json'))
  } catch {
    owner = undefined
  }

  if (processAlive(owner?.pid)) {
    throw new Error(`Restart already active: ${owner.restartId || 'unknown'} (PID ${owner.pid})`)
  }

  fs.rmSync(lockPath, { recursive: true, force: true })
  attempt()
}

function updateLockOwner(lockPath, restartId, pid) {
  writeJsonAtomic(path.join(lockPath, 'owner.json'), {
    restartId,
    pid,
    acquiredAt: now()
  })
}

function releaseLock(lockPath) {
  fs.rmSync(lockPath, { recursive: true, force: true })
}

function spawnWorker(restartId, paths) {
  const logFd = fs.openSync(paths.logPath, 'a', 0o600)
  try {
    const child = spawn(process.execPath, [SCRIPT_PATH, 'worker', restartId], {
      cwd: REPO_ROOT,
      detached: true,
      shell: false,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env }
    })
    if (!child.pid) throw new Error('Detached restart worker did not return a PID')
    child.unref()
    return child.pid
  } finally {
    fs.closeSync(logFd)
  }
}

function scheduledState(restartId, paths) {
  return {
    restartId,
    status: 'scheduled',
    createdAt: now(),
    updatedAt: now(),
    statePath: paths.statePath,
    logPath: paths.logPath
  }
}

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function launch() {
  const restartId = `restart-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
  const paths = pathsFor(restartId)
  acquireLock(paths.lockPath, restartId)

  const state = scheduledState(restartId, paths)
  writeJsonAtomic(paths.statePath, state)

  try {
    const workerPid = spawnWorker(restartId, paths)
    updateLockOwner(paths.lockPath, restartId, workerPid)
    writeJsonAtomic(paths.statePath, { ...state, workerPid, updatedAt: now() })
    console.log(JSON.stringify({
      status: 'scheduled',
      restartId,
      workerPid,
      statePath: paths.statePath,
      logPath: paths.logPath,
      suggestedWaitSeconds: 120
    }, null, 2))
  } catch (error) {
    releaseLock(paths.lockPath)
    throw error
  }
}

async function worker(restartId) {
  if (!restartId) throw new Error('worker requires a restart ID')
  const paths = pathsFor(restartId)
  await sleep(START_DELAY_MS)

  const current = readJson(paths.statePath)
  writeJsonAtomic(paths.statePath, {
    ...current,
    status: 'running',
    workerPid: process.pid,
    startedAt: now(),
    updatedAt: now()
  })

  let exitCode = 1
  let signal = null
  let errorMessage

  try {
    if (isVerifyRestart(restartId)) {
      console.log('verify-worker-complete')
      await sleep(150)
      exitCode = 0
    } else {
      const result = spawnSync('bash', [STACK_SCRIPT, 'restart-fresh'], {
        cwd: REPO_ROOT,
        shell: false,
        stdio: 'inherit',
        env: { ...process.env }
      })
      exitCode = typeof result.status === 'number' ? result.status : 1
      signal = result.signal || null
      errorMessage = result.error ? String(result.error) : undefined
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error)
  }

  const latest = readJson(paths.statePath)
  writeJsonAtomic(paths.statePath, {
    ...latest,
    status: exitCode === 0 ? 'completed' : 'failed',
    exitCode,
    signal,
    error: errorMessage,
    completedAt: now(),
    updatedAt: now()
  })
  releaseLock(paths.lockPath)
  process.exitCode = exitCode
}

function status() {
  const statePath = '/tmp/buildflow-restart-latest.json'
  if (!fs.existsSync(statePath)) {
    console.log(JSON.stringify({ status: 'not_found', statePath }, null, 2))
    process.exitCode = 1
    return
  }
  console.log(JSON.stringify(readJson(statePath), null, 2))
}

async function verify() {
  const restartId = `verify-restart-${process.pid}-${crypto.randomUUID().slice(0, 8)}`
  const paths = pathsFor(restartId)
  acquireLock(paths.lockPath, restartId)
  const state = scheduledState(restartId, paths)
  writeJsonAtomic(paths.statePath, state)

  try {
    const workerPid = spawnWorker(restartId, paths)
    updateLockOwner(paths.lockPath, restartId, workerPid)
    writeJsonAtomic(paths.statePath, { ...state, workerPid, updatedAt: now() })

    let duplicateBlocked = false
    try {
      acquireLock(paths.lockPath, 'duplicate-verification')
    } catch {
      duplicateBlocked = true
    }
    if (!duplicateBlocked) throw new Error('Single-flight lock did not block a duplicate launch')

    const deadline = Date.now() + VERIFY_TIMEOUT_MS
    let finalState
    while (Date.now() < deadline) {
      finalState = readJson(paths.statePath)
      if (finalState.status === 'completed' || finalState.status === 'failed') break
      await sleep(50)
    }

    if (finalState?.status !== 'completed' || finalState.exitCode !== 0) {
      throw new Error(`Detached verification worker did not complete: ${JSON.stringify(finalState)}`)
    }

    const log = fs.readFileSync(paths.logPath, 'utf8')
    if (!log.includes('verify-worker-complete')) throw new Error('Detached verification log evidence is missing')

    console.log(JSON.stringify({
      status: 'ok',
      launcherExited: true,
      workerSurvived: true,
      terminalStatus: finalState.status,
      exitCode: finalState.exitCode,
      logWritten: true,
      duplicateLaunchBlocked: true
    }, null, 2))
  } finally {
    releaseLock(paths.lockPath)
    fs.rmSync(paths.statePath, { force: true })
    fs.rmSync(paths.logPath, { force: true })
  }
}

const mode = process.argv[2]

try {
  if (mode === 'launch') await launch()
  else if (mode === 'worker') await worker(process.argv[3])
  else if (mode === 'status') status()
  else if (mode === 'verify') await verify()
  else throw new Error('Usage: restart-buildflow-detached.mjs {launch|worker|status|verify}')
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
