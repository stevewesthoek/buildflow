#!/usr/bin/env node

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  inspectDetachedService,
  readProcessMetadata,
  requireSustainedHealth,
  startDetachedService,
  stopDetachedService
} from './workbench-detached-service.mjs'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const SCRIPT_DIR = path.dirname(SCRIPT_PATH)
const SECRET_SENTINEL = 'workbench-detached-secret-sentinel'

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(check, message, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await sleep(50)
  }
  throw new Error(message)
}

function fakeSpec(root, service, resultPath, maxLogBytes = 1024 * 1024) {
  return {
    service,
    runDir: path.join(root, 'run'),
    cwd: root,
    executable: process.execPath,
    args: [SCRIPT_PATH, 'fake-child'],
    commandMarkers: ['verify-workbench-detached-lifecycle.mjs fake-child'],
    maxLogBytes,
    env: {
      HOME: process.env.HOME || root,
      PATH: process.env.PATH || '/usr/bin:/bin',
      RESULT_PATH: resultPath,
      TEST_REQUIRED: 'required-value',
      WORKBENCH_ACTION_TOKEN: SECRET_SENTINEL,
      npm_package_version: '1.3.1-beta'
    }
  }
}

async function runFakeChild() {
  const resultPath = process.env.RESULT_PATH
  if (!resultPath) throw new Error('RESULT_PATH is required')
  fs.writeFileSync(resultPath, JSON.stringify({
    requiredEnv: process.env.TEST_REQUIRED === 'required-value',
    mcpAuthEnv: process.env.WORKBENCH_ACTION_TOKEN === SECRET_SENTINEL,
    runtimeVersion: process.env.npm_package_version
  }))
  console.log(`fake-child-started:${process.pid}`)
  console.error(`fake-child-stderr-started:${process.pid}`)
  const timer = setInterval(() => {
    console.log('fake-child-stdout-after-parent-exit')
    console.error('fake-child-stderr-after-parent-exit')
  }, 150)
  const stop = () => {
    clearInterval(timer)
    process.exit(0)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

async function runLauncher() {
  const root = process.env.TEST_ROOT
  const service = process.env.TEST_SERVICE
  const launchId = process.env.TEST_LAUNCH_ID
  const resultPath = process.env.RESULT_PATH
  if (!root || !service || !launchId || !resultPath) throw new Error('launcher test environment is incomplete')
  const state = await startDetachedService(fakeSpec(root, service, resultPath), { launchId })
  console.log(JSON.stringify(state))
}

function launchThroughParent(root, service, launchId, resultPath) {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, 'launcher'], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      HOME: process.env.HOME || root,
      PATH: process.env.PATH || '/usr/bin:/bin',
      RESULT_PATH: resultPath,
      TEST_LAUNCH_ID: launchId,
      TEST_ROOT: root,
      TEST_SERVICE: service
    }
  })
  assert.equal(result.status, 0, result.stderr)
  return { launcherPid: result.pid, state: JSON.parse(result.stdout.trim()) }
}

function launchThroughParentAsync(root, service, launchId, resultPath) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SCRIPT_PATH, 'launcher'], {
      cwd: root,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        HOME: process.env.HOME || root,
        PATH: process.env.PATH || '/usr/bin:/bin',
        RESULT_PATH: resultPath,
        TEST_LAUNCH_ID: launchId,
        TEST_ROOT: root,
        TEST_SERVICE: service
      }
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}

async function assertRejects(action, pattern) {
  let error
  try {
    await action()
  } catch (caught) {
    error = caught
  }
  assert(error instanceof Error, 'expected operation to reject')
  assert.match(error.message, pattern)
}

async function verify() {
  const stackScript = fs.readFileSync(path.join(SCRIPT_DIR, 'workbench-local-stack.sh'), 'utf8')
  assert(!stackScript.includes('nohup'), 'active launcher must not use shell background detachment')
  assert(!stackScript.includes('kill_workbench_port'), 'active launcher must not terminate by port ownership heuristics')
  assert.match(stackScript, /if ! node "\$SERVICE_MANAGER" start agent/, 'agent manager failure must stop restart')
  assert.match(stackScript, /if ! node "\$SERVICE_MANAGER" start web/, 'web manager failure must stop restart')
  assert.match(stackScript, /if ! node "\$SERVICE_MANAGER" status-all/, 'ownership status failure must stop restart')
  assert.match(stackScript, /if ! node "\$SERVICE_MANAGER" sustain/, 'sustained health failure must stop restart')

  const createdRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-detached-lifecycle-'))
  const root = fs.realpathSync(createdRoot)
  const agentResult = path.join(root, 'agent-result.json')
  const webResult = path.join(root, 'web-result.json')
  const agentSpec = fakeSpec(root, 'agent', agentResult)
  const webSpec = fakeSpec(root, 'web', webResult, 64)

  try {
    const agentLaunch = launchThroughParent(root, 'agent', 'attempt-agent', agentResult)
    const agentLive = await waitFor(
      () => inspectDetachedService(agentSpec).live && inspectDetachedService(agentSpec),
      'agent fake child did not survive launcher exit'
    )
    assert.equal(agentLive.pid, agentLaunch.state.pid)
    assert.notEqual(agentLive.pid, agentLaunch.launcherPid, 'service PID must not track the launcher process')
    assert.equal(agentLive.pid, agentLive.pgid, 'detached service must lead its own process group')

    fs.mkdirSync(webSpec.runDir, { recursive: true })
    fs.writeFileSync(path.join(webSpec.runDir, 'web.log'), 'x'.repeat(1024 * 1024 + 1))
    const webLaunch = launchThroughParent(root, 'web', 'attempt-web', webResult)
    const webLive = await waitFor(
      () => inspectDetachedService(webSpec).live && inspectDetachedService(webSpec),
      'web fake child did not survive launcher exit'
    )
    assert.equal(webLive.pid, webLaunch.state.pid)
    assert.notEqual(webLive.pid, webLaunch.launcherPid, 'web PID must not track the launcher process')

    await sleep(500)
    for (const service of ['agent', 'web']) {
      const stdout = fs.readFileSync(path.join(root, 'run', `${service}.log`), 'utf8')
      const stderr = fs.readFileSync(path.join(root, 'run', `${service}.err.log`), 'utf8')
      assert.match(stdout, /stdout-after-parent-exit/, `${service} stdout must remain writable after launcher exit`)
      assert.match(stderr, /stderr-after-parent-exit/, `${service} stderr must remain writable after launcher exit`)
      assert(!stdout.includes(SECRET_SENTINEL), `${service} stdout must not expose inherited secrets`)
      assert(!stderr.includes(SECRET_SENTINEL), `${service} stderr must not expose inherited secrets`)
      const envEvidence = JSON.parse(fs.readFileSync(path.join(root, `${service}-result.json`), 'utf8'))
      assert.deepEqual(envEvidence, { requiredEnv: true, mcpAuthEnv: true, runtimeVersion: '1.3.1-beta' })
      const metadata = fs.readFileSync(path.join(root, 'run', `${service}.state.json`), 'utf8')
      assert(!metadata.includes(SECRET_SENTINEL), `${service} state must not expose inherited secrets`)
    }
    assert(fs.existsSync(path.join(root, 'run', 'web.log.1')), 'oversized logs must be rotated before append')

    await assertRejects(
      () => startDetachedService(agentSpec, { launchId: 'duplicate' }),
      /already running/
    )

    const raceResultPath = path.join(root, 'race-result.json')
    const raceSpec = fakeSpec(root, 'race', raceResultPath)
    const raceResults = await Promise.all([
      launchThroughParentAsync(root, 'race', 'attempt-race-a', raceResultPath),
      launchThroughParentAsync(root, 'race', 'attempt-race-b', raceResultPath)
    ])
    assert.deepEqual(raceResults.map(result => result.code).sort(), [0, 1], 'exactly one concurrent launch must succeed')
    const raceLive = await waitFor(
      () => inspectDetachedService(raceSpec).live && inspectDetachedService(raceSpec),
      'concurrent launch winner did not remain live'
    )
    await stopDetachedService(raceSpec, { launchId: raceLive.launchId })

    const wrongAttempt = await stopDetachedService(agentSpec, { launchId: 'not-the-owner' })
    assert.equal(wrongAttempt.status, 'not_owned_by_attempt')
    assert(inspectDetachedService(agentSpec).live, 'failed-attempt cleanup must not stop another attempt')
    assert(inspectDetachedService(webSpec).live, 'one service cleanup must not stop another process group')

    const agentStop = await stopDetachedService(agentSpec, { launchId: 'attempt-agent' })
    assert.equal(agentStop.status, 'stopped')
    assert(!readProcessMetadata(agentLive.pid) || readProcessMetadata(agentLive.pid).zombie, 'recorded agent process group must stop')
    assert(inspectDetachedService(webSpec).live, 'stopping agent must not stop web')

    const webStop = await stopDetachedService(webSpec, { launchId: 'attempt-web' })
    assert.equal(webStop.status, 'stopped')
    assert(!readProcessMetadata(webLive.pid) || readProcessMetadata(webLive.pid).zombie, 'recorded web process group must stop')

    const deadSpec = fakeSpec(root, 'dead', path.join(root, 'dead-result.json'))
    const deadState = await startDetachedService(deadSpec, { launchId: 'attempt-dead' })
    process.kill(-deadState.pid, 'SIGTERM')
    await waitFor(() => {
      const metadata = readProcessMetadata(deadState.pid)
      return !metadata || metadata.zombie
    }, 'fake dead service did not exit')
    assert.equal(inspectDetachedService(deadSpec).status, 'dead')
    assert.equal((await stopDetachedService(deadSpec)).status, 'stale_removed')

    const agentStatePath = path.join(root, 'run', 'agent.state.json')
    const agentPidPath = path.join(root, 'run', 'agent.pid')
    fs.writeFileSync(agentStatePath, JSON.stringify({
      version: 1,
      service: 'agent',
      pid: process.pid,
      pgid: process.pid,
      startIdentity: 'not-the-current-process-start',
      launchId: 'stale'
    }))
    fs.writeFileSync(agentPidPath, `${process.pid}\n`)
    assert.equal(inspectDetachedService(agentSpec).status, 'pid_reused')
    await assertRejects(() => stopDetachedService(agentSpec), /pid_reused/)
    fs.rmSync(agentStatePath, { force: true })
    fs.rmSync(agentPidPath, { force: true })

    fs.writeFileSync(agentStatePath, JSON.stringify({
      version: 1,
      service: 'agent',
      pid: 999999,
      pgid: 999999,
      startIdentity: 'dead-process',
      launchId: 'stale'
    }))
    fs.writeFileSync(agentPidPath, '999999\n')
    assert.equal(inspectDetachedService(agentSpec).status, 'dead')
    assert.equal((await stopDetachedService(agentSpec)).status, 'stale_removed')

    let failingChecks = 0
    await assertRejects(
      () => requireSustainedHealth({
        durationMs: 30,
        intervalMs: 10,
        probe: async () => ++failingChecks === 1
      }),
      /failed on check 2/
    )
    const sustained = await requireSustainedHealth({
      durationMs: 30,
      intervalMs: 10,
      probe: async () => true
    })
    assert(sustained.checks >= 3, 'sustained health must require repeated checks')

    console.log(JSON.stringify({
      status: 'ok',
      detachedChildrenSurvivedParentExit: true,
      stdoutAndStderrStayedWritable: true,
      actualPidAndProcessGroupRecorded: true,
      staleAndReusedPidsRejected: true,
      duplicateStartRejected: true,
      concurrentDuplicateStartRejected: true,
      cleanupScopedToLaunchAttempt: true,
      stopScopedToRecordedProcessGroup: true,
      boundedAppendLogs: true,
      requiredAndMcpAuthEnvironmentPreserved: true,
      runtimeVersionEnvironmentPreserved: true,
      secretValuesAbsentFromStateAndLogs: true,
      sustainedHealthRequired: true,
      criticalLauncherFailuresPropagate: true
    }, null, 2))
  } finally {
    for (const spec of [
      agentSpec,
      webSpec,
      fakeSpec(root, 'dead', path.join(root, 'dead-result.json')),
      fakeSpec(root, 'race', path.join(root, 'race-result.json'))
    ]) {
      try {
        await stopDetachedService(spec)
      } catch {
        // Verification assertions report the primary failure; cleanup remains bounded to test state.
      }
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
}

const mode = process.argv[2]
if (mode === 'fake-child') await runFakeChild()
else if (mode === 'launcher') await runLauncher()
else await verify()
