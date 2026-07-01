import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'

const projectRoot = process.cwd()
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-live-async-'))
const configDir = path.join(root, 'config')
const repoRoot = path.join(root, 'repo')
const sourceId = 'live-async-source'
process.env.WORKBENCH_CONFIG_DIR = configDir

function runGit(command: string, args: string[], cwd = repoRoot): string {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function write(relativePath: string, content: string): void {
  const target = path.join(repoRoot, relativePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content, 'utf8')
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(error => error ? reject(error) : resolve(port))
    })
  })
}

async function waitFor<T>(read: () => Promise<T | undefined> | T | undefined, timeoutMs = 10_000): Promise<T> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out after ${timeoutMs}ms`)
}

async function postJson(baseUrl: string, route: string, body: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  return { status: response.status, json: await response.json() }
}

function startServer(port: number): ChildProcess {
  return spawn(
    path.join(projectRoot, 'packages/cli/node_modules/.bin/tsx'),
    ['packages/cli/src/index.ts', 'serve'],
    {
      cwd: projectRoot,
      detached: true,
      env: {
        ...process.env,
        WORKBENCH_CONFIG_DIR: configDir,
        BRIDGE_URL: '',
        DEVICE_TOKEN: ''
      },
      stdio: 'ignore'
    }
  )
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    if (child.pid) process.kill(-child.pid, 'SIGKILL')
    else child.kill('SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
  await new Promise<void>(resolve => child.once('exit', () => resolve()))
}

async function main(): Promise<void> {
  fs.mkdirSync(repoRoot, { recursive: true })
  runGit('git', ['init'])
  runGit('git', ['config', 'user.email', 'workbench@example.test'])
  runGit('git', ['config', 'user.name', 'Workbench Live Reliability'])
  write('package.json', JSON.stringify({
    private: true,
    scripts: {
      beyondActionDeadline: 'node -e "setTimeout(() => process.exit(0), 4500)"'
    }
  }, null, 2))
  write('README.md', '# Live async fixture\n')
  runGit('git', ['add', '--', 'package.json', 'README.md'])
  runGit('git', ['commit', '-m', 'test: initialize live async fixture'])

  const port = await freePort()
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    userId: 'live-test-user',
    deviceId: 'live-test-device',
    deviceToken: '',
    apiBaseUrl: 'http://127.0.0.1:1',
    vaultPath: repoRoot,
    sources: [{
      id: sourceId,
      label: 'Live async fixture',
      path: repoRoot,
      enabled: true,
      autoIndexEnabled: false,
      autoIndexIntervalMinutes: 5
    }],
    activeSourceIds: [sourceId],
    activeSourcesMode: 'explicit',
    writeMode: 'readCreateAppend',
    localPort: port,
    mode: 'read_create_append',
    allowedExtensions: ['.json', '.md', '.txt'],
    ignorePatterns: ['.git/**'],
    autoIndexDefaultMigratedAt: new Date().toISOString()
  }, null, 2), 'utf8')

  const [{ createWorkbenchRun }, packetStore] = await Promise.all([
    import('../packages/cli/src/agent/agent-jobs'),
    import('../packages/cli/src/agent/workbench-packet-store')
  ])
  const run = createWorkbenchRun({
    sourceId,
    goal: 'Verify live asynchronous submit, status, interruption recovery, and restart drain.',
    autoCommit: false,
    reviewEveryStep: false
  }).run
  assert(run.activeTaskId)
  const head = runCommandHead()
  const interruptedPacketId = 'packet-live-async-interrupted-0001'
  const interruptedPacket = {
    version: 1 as const,
    runId: run.id,
    packetId: interruptedPacketId,
    idempotencyKey: `${run.id}:${interruptedPacketId}`,
    sourceId,
    taskId: run.activeTaskId,
    goalSummary: 'Prove submit returns before a long validation and restart restores interrupted writes.',
    expectedHead: head,
    steps: [{ type: 'create' as const, path: 'live-interrupted.txt', content: 'restore me\n' }],
    validation: [{
      commandKind: 'run_package_script' as const,
      packageDir: '.',
      scriptName: 'beyondActionDeadline',
      timeoutMs: 10_000
    }],
    commit: { enabled: false },
    createdAt: new Date().toISOString()
  }
  assert.equal(packetStore.reserveWorkbenchPacket({
    packet: interruptedPacket,
    exactPaths: ['live-interrupted.txt']
  }).ok, true)

  const baseUrl = `http://127.0.0.1:${port}`
  let server = startServer(port)
  try {
    await waitFor(async () => {
      try {
        const result = await postJson(baseUrl, '/api/workbench-packets/status', { sourceId, packetId: interruptedPacketId })
        return result.status === 200 ? true : undefined
      } catch {
        return undefined
      }
    })

    const submitStartedAt = Date.now()
    const submitted = await postJson(baseUrl, '/api/workbench-packets/submit-async', {
      sourceId,
      packetId: interruptedPacketId
    })
    const submitDurationMs = Date.now() - submitStartedAt
    assert.equal(submitted.status, 202)
    assert(['scheduled', 'already_scheduled'].includes(submitted.json.status))
    assert(submitDurationMs < 1_000, `submit took ${submitDurationMs}ms instead of returning promptly`)

    const running = await waitFor(async () => {
      const status = await postJson(baseUrl, '/api/workbench-packets/status', { sourceId, packetId: interruptedPacketId })
      return status.json.status === 'running' ? status.json : undefined
    })
    assert.equal(running.status, 'running')
    await waitFor(() => fs.existsSync(path.join(repoRoot, 'live-interrupted.txt')) ? true : undefined)

    await stopServer(server)
    assert.equal(fs.existsSync(path.join(repoRoot, 'live-interrupted.txt')), true, 'interrupted write must exist before restart recovery')

    const restartPacketId = 'packet-live-async-restart-0002'
    const restartPacket = {
      version: 1 as const,
      runId: run.id,
      packetId: restartPacketId,
      idempotencyKey: `${run.id}:${restartPacketId}`,
      sourceId,
      taskId: run.activeTaskId,
      goalSummary: 'Prove queued work drains after a real server restart.',
      expectedHead: head,
      steps: [{ type: 'create' as const, path: 'live-restarted.txt', content: 'restarted\n' }],
      commit: { enabled: false },
      createdAt: new Date().toISOString()
    }
    assert.equal(packetStore.reserveWorkbenchPacket({
      packet: restartPacket,
      exactPaths: ['live-restarted.txt']
    }).ok, true)

    server = startServer(port)
    await waitFor(async () => {
      try {
        const status = await postJson(baseUrl, '/api/workbench-packets/status', { sourceId, packetId: interruptedPacketId })
        return status.status === 200 ? status.json : undefined
      } catch {
        return undefined
      }
    })

    const recovered = await waitFor(async () => {
      const status = await postJson(baseUrl, '/api/workbench-packets/status', { sourceId, packetId: interruptedPacketId })
      return status.json.status === 'failed' ? status.json : undefined
    })
    assert.match(String(recovered.failureReason || ''), /Recovered interrupted packet execution/)
    assert.equal(fs.existsSync(path.join(repoRoot, 'live-interrupted.txt')), false, 'restart recovery must restore interrupted packet paths')

    const restarted = await waitFor(async () => {
      const status = await postJson(baseUrl, '/api/workbench-packets/status', { sourceId, packetId: restartPacketId })
      return status.json.status === 'completed' ? status.json : undefined
    })
    assert.equal(restarted.result?.status, 'completed')
    assert.equal(fs.readFileSync(path.join(repoRoot, 'live-restarted.txt'), 'utf8'), 'restarted\n')

    console.log(JSON.stringify({
      status: 'ok',
      submitDurationMs,
      longValidationMs: 4500,
      interruptedPacketStatus: recovered.status,
      interruptedWriteRestored: !fs.existsSync(path.join(repoRoot, 'live-interrupted.txt')),
      restartedPacketStatus: restarted.status,
      submitEndpointVerified: true,
      statusEndpointVerified: true,
      realProcessRestartVerified: true,
      isolatedConfigDir: configDir
    }, null, 2))
  } finally {
    await stopServer(server)
  }
}

function runCommandHead(): string {
  return runGit('git', ['rev-parse', 'HEAD'])
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
  .finally(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })
