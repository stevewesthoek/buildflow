#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..')
const DEFAULT_RUN_DIR = path.join(os.userInfo().homedir, '.config', 'workbench', 'runtime-state')
const DEFAULT_MAX_LOG_BYTES = 2 * 1024 * 1024
const DEFAULT_STOP_TIMEOUT_MS = 5_000
const OWNER_CONFIG_MODULE = path.join(REPO_ROOT, 'packages', 'shared', 'dist', 'workbench-owner-config.js')
const TRANSPORT_CONFIG_MODULE = path.join(REPO_ROOT, 'packages', 'shared', 'dist', 'workbench-transport-config.js')

const COMMON_ENV_KEYS = [
  'HOME',
  'LANG',
  'LC_ALL',
  'LOGNAME',
  'NODE_ENV',
  'NVM_DIR',
  'PATH',
  'PNPM_HOME',
  'TMPDIR',
  'USER',
  'npm_package_version',
  'WORKBENCH_PACKAGE_VERSION',
  'WORKBENCH_BUILD_SHA',
  'WORKBENCH_BUILD_TIMESTAMP'
]

const AGENT_ENV_KEYS = [
  ...COMMON_ENV_KEYS,
  'BRIDGE_URL',
  'BUILDFLOW_CONFIG_DIR',
  'DEBUG',
  'DEVICE_TOKEN',
  'N8N_API_KEY',
  'N8N_CONFIG_FILE',
  'WORKBENCH_CONFIG_DIR',
  'WORKBENCH_JSON'
]

const WEB_ENV_KEYS = [
  ...COMMON_ENV_KEYS,
  'LOCAL_AGENT_URL',
  'LOCAL_DASHBOARD_BASE_URL',
  'LOCAL_RELAY_URL',
  'NEXT_PUBLIC_WORKBENCH_SOURCE_URL',
  'PUBLIC_BASE_URL',
  'WORKBENCH_WEB_BUILD_ID'
]

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function inheritedEnv(keys, overrides = {}) {
  const env = {}
  for (const key of keys) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return { ...env, ...overrides }
}

export function injectOwnerActionToken(environment, actionToken) {
  const env = { ...environment }
  delete env.WORKBENCH_ACTION_TOKEN
  delete env.BUILDFLOW_ACTION_TOKEN
  return { ...env, WORKBENCH_ACTION_TOKEN: actionToken }
}

export function injectOwnerTransport(environment, transport) {
  const env = { ...environment }
  delete env.WORKBENCH_TRANSPORT
  return { ...env, WORKBENCH_TRANSPORT: transport }
}

async function loadOwnerActionConfig() {
  try {
    const module = await import(pathToFileURL(OWNER_CONFIG_MODULE).href)
    return module.loadWorkbenchOwnerConfig()
  } catch {
    throw new Error('Workbench owner-local action authentication is unavailable or invalid.')
  }
}

async function loadOwnerTransportConfig() {
  try {
    const module = await import(pathToFileURL(TRANSPORT_CONFIG_MODULE).href)
    return module.loadWorkbenchTransportConfig()
  } catch {
    throw new Error('Workbench owner-local transport configuration is unavailable or invalid.')
  }
}

function statePaths(runDir, service) {
  return {
    statePath: path.join(runDir, `${service}.state.json`),
    pidPath: path.join(runDir, `${service}.pid`),
    lockPath: path.join(runDir, `${service}.launch.lock`),
    stdoutPath: path.join(runDir, `${service}.log`),
    stderrPath: path.join(runDir, `${service}.err.log`)
  }
}

function atomicWrite(filePath, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporaryPath, value, { mode })
    fs.renameSync(temporaryPath, filePath)
  } finally {
    fs.rmSync(temporaryPath, { force: true })
  }
}

function atomicWriteJson(filePath, value) {
  atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function capture(executable, args) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'ignore']
  })
  return result.status === 0 ? result.stdout.trim() : ''
}

function repositoryOwnershipScope() {
  const commonDirectory = capture('git', ['-C', REPO_ROOT, 'rev-parse', '--git-common-dir'])
  if (!commonDirectory) throw new Error('Could not establish Workbench repository ownership scope')
  return fs.realpathSync(path.resolve(REPO_ROOT, commonDirectory))
}

export function readProcessMetadata(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null

  const stat = capture('ps', ['-p', String(pid), '-o', 'stat='])
  if (!stat) return null

  return {
    pid,
    stat,
    zombie: stat.trim().startsWith('Z'),
    pgid: Number.parseInt(capture('ps', ['-p', String(pid), '-o', 'pgid=']), 10),
    startIdentity: capture('ps', ['-p', String(pid), '-o', 'lstart=']),
    command: capture('ps', ['-p', String(pid), '-o', 'command=']),
    cwd: capture('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
      .split('\n')
      .find(line => line.startsWith('n'))
      ?.slice(1) || ''
  }
}

function removeStateFiles(spec) {
  const paths = statePaths(spec.runDir, spec.service)
  fs.rmSync(paths.statePath, { force: true })
  fs.rmSync(paths.pidPath, { force: true })
}

async function acquireLaunchLock(spec) {
  const { lockPath } = statePaths(spec.runDir, spec.service)
  const startIdentity = readProcessMetadata(process.pid)?.startIdentity
  if (!startIdentity) throw new Error('Could not establish launcher process identity')

  const create = () => {
    fs.mkdirSync(lockPath, { mode: 0o700 })
    atomicWriteJson(path.join(lockPath, 'owner.json'), {
      pid: process.pid,
      startIdentity,
      acquiredAt: new Date().toISOString()
    })
  }

  try {
    create()
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error

    const observedLockIdentity = fs.statSync(lockPath).ino
    let owner
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        owner = readJson(path.join(lockPath, 'owner.json'))
        break
      } catch {
        await sleep(10)
      }
    }
    if (!owner) throw new Error(`${spec.service} launch lock has no verifiable owner`)

    const ownerMetadata = readProcessMetadata(owner.pid)
    if (ownerMetadata && !ownerMetadata.zombie && ownerMetadata.startIdentity === owner.startIdentity) {
      throw new Error(`${spec.service} launch is already active`)
    }

    let currentLockIdentity
    try {
      currentLockIdentity = fs.statSync(lockPath).ino
    } catch {
      throw new Error(`${spec.service} launch lock changed during stale-owner validation`)
    }
    if (currentLockIdentity !== observedLockIdentity) {
      throw new Error(`${spec.service} launch is already active`)
    }

    const staleLockPath = `${lockPath}.stale-${crypto.randomUUID()}`
    try {
      fs.renameSync(lockPath, staleLockPath)
    } catch {
      throw new Error(`${spec.service} launch lock changed during stale-owner validation`)
    }
    fs.rmSync(staleLockPath, { recursive: true, force: true })
    try {
      create()
    } catch (retryError) {
      if (retryError?.code === 'EEXIST') throw new Error(`${spec.service} launch is already active`)
      throw retryError
    }
  }

  return () => {
    let owner
    try {
      owner = readJson(path.join(lockPath, 'owner.json'))
    } catch {
      return
    }
    if (owner.pid === process.pid && owner.startIdentity === startIdentity) {
      fs.rmSync(lockPath, { recursive: true, force: true })
    }
  }
}

function readLegacyPid(pidPath) {
  if (!fs.existsSync(pidPath)) return null
  const value = Number.parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10)
  return Number.isInteger(value) && value > 0 ? value : null
}

export function inspectDetachedService(spec) {
  const paths = statePaths(spec.runDir, spec.service)
  if (!fs.existsSync(paths.statePath)) {
    const legacyPid = readLegacyPid(paths.pidPath)
    if (!legacyPid) return { service: spec.service, status: 'missing', live: false }
    const metadata = readProcessMetadata(legacyPid)
    return {
      service: spec.service,
      status: metadata && !metadata.zombie ? 'legacy_unowned' : 'legacy_stale',
      live: false,
      pid: legacyPid
    }
  }

  let state
  try {
    state = readJson(paths.statePath)
  } catch {
    return { service: spec.service, status: 'invalid_state', live: false }
  }

  if (
    state?.version !== 2 ||
    state?.service !== spec.service ||
    !Number.isInteger(state?.pid) ||
    state.pid <= 0 ||
    state.pgid !== state.pid ||
    typeof state.startIdentity !== 'string' ||
    !state.startIdentity ||
    typeof state.cwd !== 'string' ||
    !path.isAbsolute(state.cwd) ||
    typeof state.ownershipScope !== 'string' ||
    state.ownershipScope !== spec.ownershipScope
  ) {
    return { service: spec.service, status: 'invalid_state', live: false, pid: state?.pid }
  }

  const metadata = readProcessMetadata(state.pid)
  if (!metadata || metadata.zombie) {
    return { service: spec.service, status: 'dead', live: false, pid: state.pid, state }
  }
  if (metadata.startIdentity !== state.startIdentity) {
    return { service: spec.service, status: 'pid_reused', live: false, pid: state.pid, state }
  }
  if (metadata.pgid !== state.pgid || metadata.pgid !== metadata.pid) {
    return { service: spec.service, status: 'process_group_mismatch', live: false, pid: state.pid, state }
  }
  if (metadata.cwd !== state.cwd) {
    return { service: spec.service, status: 'cwd_mismatch', live: false, pid: state.pid, state }
  }
  if (!spec.commandMarkers.some(marker => metadata.command.includes(marker))) {
    return { service: spec.service, status: 'command_mismatch', live: false, pid: state.pid, state }
  }

  return {
    service: spec.service,
    status: 'live',
    live: true,
    pid: state.pid,
    pgid: state.pgid,
    startIdentity: state.startIdentity,
    launchId: state.launchId,
    startedAt: state.startedAt,
    state
  }
}

function rotateIfOversized(filePath, maxBytes) {
  let size = 0
  try {
    size = fs.statSync(filePath).size
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (size <= maxBytes) return

  const previousPath = `${filePath}.1`
  fs.rmSync(previousPath, { force: true })
  fs.renameSync(filePath, previousPath)
}

async function waitForSpawn(child) {
  await new Promise((resolve, reject) => {
    const onSpawn = () => {
      child.off('error', onError)
      resolve()
    }
    const onError = error => {
      child.off('spawn', onSpawn)
      reject(error)
    }
    child.once('spawn', onSpawn)
    child.once('error', onError)
  })
}

async function waitForProcessMetadata(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const metadata = readProcessMetadata(pid)
    if (metadata?.startIdentity && metadata.pgid) return metadata
    await sleep(25)
  }
  return null
}

function signalOwnedProcessGroup(pid, signal) {
  process.kill(-pid, signal)
}

async function waitForGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const metadata = readProcessMetadata(pid)
    if (!metadata || metadata.zombie) return true
    await sleep(50)
  }
  return false
}

export async function startDetachedService(spec, { launchId }) {
  if (!launchId || typeof launchId !== 'string') throw new Error('A launch ID is required')
  if (!path.isAbsolute(spec.executable)) throw new Error('Detached executable must be an absolute path')
  if (!Array.isArray(spec.args) || !spec.args.every(value => typeof value === 'string')) {
    throw new Error('Detached argv must be a fixed string array')
  }
  if (!spec.commandMarkers?.length) throw new Error('At least one command ownership marker is required')
  if (!path.isAbsolute(spec.ownershipScope)) throw new Error('An absolute repository ownership scope is required')

  fs.mkdirSync(spec.runDir, { recursive: true, mode: 0o700 })
  const releaseLaunchLock = await acquireLaunchLock(spec)
  const paths = statePaths(spec.runDir, spec.service)
  let stdoutFd
  let stderrFd
  let child
  let attemptStarted = false

  try {
    const existing = inspectDetachedService(spec)
    if (existing.live) throw new Error(`${spec.service} is already running as PID ${existing.pid}`)
    if (existing.status === 'legacy_unowned') {
      throw new Error(`${spec.service} has a live legacy PID without ownership metadata`)
    }
    if (['pid_reused', 'process_group_mismatch', 'cwd_mismatch', 'command_mismatch', 'invalid_state'].includes(existing.status)) {
      throw new Error(`${spec.service} has unsafe stale state: ${existing.status}`)
    }
    removeStateFiles(spec)

    const maxLogBytes = spec.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES
    rotateIfOversized(paths.stdoutPath, maxLogBytes)
    rotateIfOversized(paths.stderrPath, maxLogBytes)
    stdoutFd = fs.openSync(paths.stdoutPath, 'a', 0o600)
    stderrFd = fs.openSync(paths.stderrPath, 'a', 0o600)
    fs.fchmodSync(stdoutFd, 0o600)
    fs.fchmodSync(stderrFd, 0o600)

    attemptStarted = true
    child = spawn(spec.executable, spec.args, {
      cwd: spec.cwd,
      detached: true,
      shell: false,
      stdio: ['ignore', stdoutFd, stderrFd],
      env: { ...spec.env }
    })
    await waitForSpawn(child)
    if (!child.pid) throw new Error(`${spec.service} did not return a PID`)

    const metadata = await waitForProcessMetadata(child.pid)
    if (!metadata || metadata.zombie) throw new Error(`${spec.service} exited before ownership could be recorded`)
    if (metadata.pgid !== child.pid) {
      throw new Error(`${spec.service} did not start in an independent process group`)
    }
    if (metadata.cwd !== spec.cwd) throw new Error(`${spec.service} started in an unexpected working directory`)
    if (!spec.commandMarkers.some(marker => metadata.command.includes(marker))) {
      throw new Error(`${spec.service} command identity did not match the fixed launch specification`)
    }

    const state = {
      version: 2,
      service: spec.service,
      pid: child.pid,
      pgid: child.pid,
      startIdentity: metadata.startIdentity,
      cwd: metadata.cwd,
      ownershipScope: spec.ownershipScope,
      launchId,
      startedAt: new Date().toISOString()
    }
    atomicWriteJson(paths.statePath, state)
    atomicWrite(paths.pidPath, `${child.pid}\n`)
    child.unref()
    return state
  } catch (error) {
    if (attemptStarted && child?.pid) {
      try {
        signalOwnedProcessGroup(child.pid, 'SIGTERM')
        let exited = await waitForGroupExit(child.pid, 1_000)
        if (!exited) {
          signalOwnedProcessGroup(child.pid, 'SIGKILL')
          exited = await waitForGroupExit(child.pid, 1_000)
        }
      } catch {
        // The child may already have exited.
      }
    }
    if (attemptStarted) removeStateFiles(spec)
    throw error
  } finally {
    if (stdoutFd !== undefined) fs.closeSync(stdoutFd)
    if (stderrFd !== undefined) fs.closeSync(stderrFd)
    releaseLaunchLock()
  }
}

export async function stopDetachedService(spec, { launchId, timeoutMs = DEFAULT_STOP_TIMEOUT_MS } = {}) {
  const status = inspectDetachedService(spec)
  if (status.status === 'missing') return { service: spec.service, status: 'not_running' }
  if (status.status === 'legacy_stale' || status.status === 'dead') {
    removeStateFiles(spec)
    return { service: spec.service, status: 'stale_removed', pid: status.pid }
  }
  if (!status.live) {
    throw new Error(`${spec.service} ownership validation failed: ${status.status}`)
  }
  if (launchId && status.launchId !== launchId) {
    return { service: spec.service, status: 'not_owned_by_attempt', pid: status.pid }
  }

  signalOwnedProcessGroup(status.pid, 'SIGTERM')
  let exited = await waitForGroupExit(status.pid, timeoutMs)
  if (!exited) {
    signalOwnedProcessGroup(status.pid, 'SIGKILL')
    exited = await waitForGroupExit(status.pid, 1_000)
  }
  if (!exited) throw new Error(`${spec.service} process group did not exit`)

  removeStateFiles(spec)
  return { service: spec.service, status: 'stopped', pid: status.pid }
}

export async function requireSustainedHealth({ durationMs, intervalMs, probe }) {
  if (durationMs < intervalMs * 2) throw new Error('Sustained health requires at least three checks')
  const startedAt = Date.now()
  let checks = 0

  while (true) {
    checks += 1
    if (!(await probe())) throw new Error(`Sustained health failed on check ${checks}`)
    const elapsedMs = Date.now() - startedAt
    if (elapsedMs >= durationMs) return { checks, elapsedMs }
    await sleep(Math.min(intervalMs, durationMs - elapsedMs))
  }
}

function serviceSpec(service, port, runDir = DEFAULT_RUN_DIR) {
  const ownershipScope = repositoryOwnershipScope()
  if (service === 'agent') {
    return {
      service,
      runDir,
      cwd: path.join(REPO_ROOT, 'packages', 'cli'),
      executable: process.execPath,
      args: ['dist/index.js', 'serve'],
      commandMarkers: ['dist/index.js serve'],
      ownershipScope,
      env: inheritedEnv(AGENT_ENV_KEYS, {
        PORT: String(port),
        HOST: '127.0.0.1',
        WORKBENCH_AGENT_PORT: String(port),
        WORKBENCH_AGENT_HOST: '127.0.0.1',
        BUILDFLOW_AGENT_PORT: String(port),
        BUILDFLOW_AGENT_HOST: '127.0.0.1'
      })
    }
  }
  if (service === 'web') {
    const nextEntrypoint = path.join(REPO_ROOT, 'apps', 'web', 'node_modules', 'next', 'dist', 'bin', 'next')
    return {
      service,
      runDir,
      cwd: path.join(REPO_ROOT, 'apps', 'web'),
      executable: process.execPath,
      args: [nextEntrypoint, 'start', '-H', '127.0.0.1', '-p', String(port)],
      commandMarkers: ['next/dist/bin/next', 'next-server'],
      ownershipScope,
      env: inheritedEnv(WEB_ENV_KEYS, {
        PORT: String(port),
        HOSTNAME: '127.0.0.1'
      })
    }
  }
  throw new Error(`Unsupported Workbench service: ${service}`)
}

function parseOptions(args) {
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument.startsWith('--') || index + 1 >= args.length) throw new Error(`Invalid option: ${argument}`)
    options[argument.slice(2)] = args[index + 1]
    index += 1
  }
  return options
}

async function httpOk(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(4_000) })
    return response.ok
  } catch {
    return false
  }
}

async function main() {
  const args = process.argv.slice(2)
  const command = args[0]
  const serviceCommand = command === 'start' || command === 'stop' || command === 'status'
  const service = serviceCommand ? args[1] : undefined
  const optionArgs = serviceCommand ? args.slice(2) : args.slice(1)
  const options = parseOptions(optionArgs)
  const runDir = options['run-dir'] || DEFAULT_RUN_DIR

  if (command === 'validate-auth') {
    const configured = await loadOwnerActionConfig()
    console.log(JSON.stringify({ configured: true, source: 'owner_local', mode: configured.mode }))
    return
  }

  if (command === 'validate-transport') {
    const configured = await loadOwnerTransportConfig()
    console.log(JSON.stringify({ configured: true, source: 'owner_local', transport: configured.transport, mode: configured.mode }))
    return
  }

  if (command === 'verify-auth') {
    const configured = await loadOwnerActionConfig()
    const webPort = Number.parseInt(options['web-port'] || '3054', 10)
    const response = await fetch(`http://127.0.0.1:${webPort}/api/actions/status?include=sources`, {
      headers: { Authorization: `Bearer ${configured.actionToken}` },
      signal: AbortSignal.timeout(5_000)
    })
    if (!response.ok) throw new Error(`Workbench authenticated status verification failed with status ${response.status}.`)
    const payload = await response.json()
    const connected = !!payload && typeof payload === 'object' && payload.connected === true
    if (!connected) throw new Error('Workbench authenticated status verification did not report connected=true.')
    console.log(JSON.stringify({ authenticated: true, statusCode: response.status, connected }))
    return
  }

  if (command === 'start' || command === 'stop' || command === 'status') {
    const defaultPort = service === 'agent' ? 3052 : 3054
    const port = Number.parseInt(options.port || String(defaultPort), 10)
    const spec = serviceSpec(service, port, runDir)
    if (command === 'start') {
      const transport = await loadOwnerTransportConfig()
      spec.env = injectOwnerTransport(spec.env, transport.transport)
      if (service === 'web') {
        const configured = await loadOwnerActionConfig()
        spec.env = injectOwnerActionToken(spec.env, configured.actionToken)
      }
    }
    let result
    if (command === 'start') result = await startDetachedService(spec, { launchId: options['launch-id'] })
    else if (command === 'stop') result = await stopDetachedService(spec, { launchId: options['launch-id'] })
    else result = inspectDetachedService(spec)
    console.log(JSON.stringify(result))
    if (command === 'status' && !result.live) process.exitCode = 1
    return
  }

  if (command === 'status-all') {
    const agent = inspectDetachedService(serviceSpec('agent', Number.parseInt(options['agent-port'] || '3052', 10), runDir))
    const web = inspectDetachedService(serviceSpec('web', Number.parseInt(options['web-port'] || '3054', 10), runDir))
    console.log(JSON.stringify({ agent, web }))
    if (!agent.live || !web.live) process.exitCode = 1
    return
  }

  if (command === 'sustain') {
    const agentPort = Number.parseInt(options['agent-port'] || '3052', 10)
    const relayPort = Number.parseInt(options['relay-port'] || '3053', 10)
    const webPort = Number.parseInt(options['web-port'] || '3054', 10)
    const durationMs = Number.parseInt(options['duration-ms'] || '8000', 10)
    const intervalMs = Number.parseInt(options['interval-ms'] || '2000', 10)
    const agentSpec = serviceSpec('agent', agentPort, runDir)
    const webSpec = serviceSpec('web', webPort, runDir)
    const result = await requireSustainedHealth({
      durationMs,
      intervalMs,
      probe: async () => {
        if (!inspectDetachedService(agentSpec).live || !inspectDetachedService(webSpec).live) return false
        const checks = await Promise.all([
          httpOk(`http://127.0.0.1:${agentPort}/health`),
          httpOk(`http://127.0.0.1:${relayPort}/health`),
          httpOk(`http://127.0.0.1:${webPort}/api/unified-health`)
        ])
        return checks.every(Boolean)
      }
    })
    console.log(JSON.stringify({ status: 'sustained', ...result }))
    return
  }

  throw new Error('Usage: workbench-detached-service.mjs {start|stop|status} {agent|web} [options] | status-all [options] | sustain [options] | validate-auth | verify-auth [options]')
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
