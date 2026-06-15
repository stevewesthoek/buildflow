#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const args = new Set(process.argv.slice(2))
const expectedCommitArgIndex = process.argv.indexOf('--expected-commit')
const expectedCommit = expectedCommitArgIndex >= 0 ? process.argv[expectedCommitArgIndex + 1] : undefined
const freshCheck = args.has('--fresh-check')
const benchmark = args.has('--benchmark')
const jsonOnly = args.has('--json')

const LOCAL_WEB = process.env.LOCAL_DASHBOARD_BASE_URL || 'http://127.0.0.1:3054'
const LOCAL_AGENT = process.env.LOCAL_AGENT_URL || 'http://127.0.0.1:3052'
const LOCAL_RELAY = process.env.LOCAL_RELAY_URL || 'http://127.0.0.1:3053'
const PUBLIC_WORKBENCH = process.env.PUBLIC_WORKBENCH_BASE_URL || 'https://workbench.prochat.tools'
const PUBLIC_BUILDFLOW = process.env.PUBLIC_BUILDFLOW_BASE_URL || 'https://buildflow.prochat.tools'
const token = process.env.WORKBENCH_ACTION_TOKEN || process.env.BUILDFLOW_ACTION_TOKEN || ''

function redactProcessLine(line) {
  return line
    .replace(/eyJ[A-Za-z0-9._-]+/g, '[REDACTED_TOKEN]')
    .replace(/--token[= ]+[^ ]+/g, '--token [REDACTED]')
    .replace(/credentials-file[= ]+[^ ]+/g, 'credentials-file [REDACTED_PATH]')
}

async function run(command, args, options = {}) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: options.timeoutMs || 5000,
      maxBuffer: options.maxBuffer || 256 * 1024
    })
    return stdout
  } catch (error) {
    return error.stdout || ''
  }
}

async function cloudflaredProcesses() {
  const stdout = await run('ps', ['-axo', 'pid,ppid,lstart,command'])
  return stdout
    .split('\n')
    .filter(line => /cloudflared/.test(line) && !/diagnose-workbench-path/.test(line))
    .map(redactProcessLine)
}

async function listeners() {
  const stdout = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'])
  return stdout
    .split('\n')
    .filter(line => /:(3052|3053|3054)\b/.test(line))
}

async function relayContainer() {
  const stdout = await run('docker', [
    'inspect',
    'workbench-relay',
    '--format',
    'id={{.Id}} image={{.Image}} name={{.Name}} created={{.Created}} started={{.State.StartedAt}} status={{.State.Status}} project={{index .Config.Labels "com.docker.compose.project"}} service={{index .Config.Labels "com.docker.compose.service"}}'
  ])
  return stdout.trim() || null
}

function classifyHttp(result) {
  if (result.error) {
    if (/ECONNREFUSED|Connection refused|fetch failed/i.test(result.error)) return 'connection_refused'
    if (/timed out|AbortError/i.test(result.error)) return 'socket_timeout'
    return 'network_error'
  }
  const contentType = result.headers['content-type'] || ''
  const server = result.headers.server || ''
  if (result.status === 504 && /text\/html/i.test(contentType) && /cloudflare/i.test(server + result.bodyPreview)) {
    return 'cloudflare_html_504'
  }
  if (/application\/json/i.test(contentType)) {
    const status = result.json?.status
    const code = result.json?.error?.code || result.json?.code
    if (status === 'timeout') return 'workbench_structured_timeout'
    if (status === 'needs_narrower_scope') return 'workbench_needs_narrower_scope'
    if (code === 'LOCAL_STACK_UNAVAILABLE') return 'origin_unavailable'
    if (result.status === 401) return 'unauthorized_json'
    if (result.status >= 500) return 'json_server_error'
    return 'structured_json'
  }
  if (result.status >= 500) return 'origin_or_proxy_error'
  return 'other'
}

async function fetchProbe(name, url, options = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 10000)
  const started = performance.now()
  try {
    const headers = {}
    if (options.auth && token) headers.Authorization = `Bearer ${token}`
    if (options.body) headers['Content-Type'] = 'application/json'
    const response = await fetch(url, {
      method: options.method || (options.body ? 'POST' : 'GET'),
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    })
    const text = await response.text()
    const headerObject = Object.fromEntries(response.headers.entries())
    let json
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    const result = {
      name,
      url,
      status: response.status,
      durationMs: Math.round(performance.now() - started),
      headers: {
        'content-type': headerObject['content-type'],
        server: headerObject.server,
        'cf-ray': headerObject['cf-ray'],
        'x-workbench-request-id': headerObject['x-workbench-request-id'],
        'x-workbench-deadline-phase': headerObject['x-workbench-deadline-phase']
      },
      json,
      bodyPreview: text.slice(0, 220)
    }
    return { ...result, classification: classifyHttp(result) }
  } catch (error) {
    const result = {
      name,
      url,
      status: 0,
      durationMs: Math.round(performance.now() - started),
      headers: {},
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      bodyPreview: ''
    }
    return { ...result, classification: classifyHttp(result) }
  } finally {
    clearTimeout(timeout)
  }
}

async function runBench(name, probeFactory, count = 20) {
  const samples = []
  for (let i = 0; i < count; i += 1) {
    const result = await probeFactory(i)
    samples.push(result.durationMs)
  }
  const sorted = [...samples].sort((a, b) => a - b)
  const pick = percentile => sorted[Math.min(sorted.length - 1, Math.ceil((percentile / 100) * sorted.length) - 1)]
  return {
    name,
    count,
    minMs: sorted[0],
    p50Ms: pick(50),
    p95Ms: pick(95),
    maxMs: sorted[sorted.length - 1]
  }
}

function assertFreshService(name, payload, expected) {
  const service = payload?.service || payload?.runtime?.service
  if (!service) throw new Error(`${name} did not return service freshness metadata`)
  if (expected && service.gitCommit !== expected) {
    throw new Error(`${name} commit mismatch: expected ${expected}, got ${service.gitCommit}`)
  }
  if (!service.processStartedAt || service.processStartedAt === 'unknown') {
    throw new Error(`${name} missing processStartedAt`)
  }
  if (!service.buildTimestamp || service.buildTimestamp === 'unknown') {
    throw new Error(`${name} missing buildTimestamp`)
  }
  return service
}

async function main() {
  const processLines = await cloudflaredProcesses()
  const portLines = await listeners()
  const container = await relayContainer()

  const probes = [
    await fetchProbe('local_web_openapi', `${LOCAL_WEB}/api/openapi`, { timeoutMs: 5000 }),
    await fetchProbe('local_agent_health', `${LOCAL_AGENT}/health`, { timeoutMs: 5000 }),
    await fetchProbe('local_relay_health', `${LOCAL_RELAY}/health`, { timeoutMs: 5000 }),
    await fetchProbe('local_unified_health', `${LOCAL_WEB}/api/unified-health`, { timeoutMs: 5000 }),
    await fetchProbe('local_status_unauth', `${LOCAL_WEB}/api/actions/status`, { timeoutMs: 5000 }),
    await fetchProbe('public_workbench_openapi', `${PUBLIC_WORKBENCH}/api/openapi`, { timeoutMs: 15000 }),
    await fetchProbe('public_workbench_status_unauth', `${PUBLIC_WORKBENCH}/api/actions/status`, { timeoutMs: 15000 }),
    await fetchProbe('public_buildflow_openapi', `${PUBLIC_BUILDFLOW}/api/openapi`, { timeoutMs: 15000 }),
    await fetchProbe('public_buildflow_status_unauth', `${PUBLIC_BUILDFLOW}/api/actions/status`, { timeoutMs: 15000 })
  ]

  if (token) {
    probes.push(await fetchProbe('local_status_auth', `${LOCAL_WEB}/api/actions/status`, { auth: true, timeoutMs: 5000 }))
    probes.push(await fetchProbe('public_workbench_status_auth', `${PUBLIC_WORKBENCH}/api/actions/status`, { auth: true, timeoutMs: 15000 }))
  }

  const output = {
    checkedAt: new Date().toISOString(),
    expected: {
      canonicalHostname: 'workbench.prochat.tools',
      compatibilityHostname: 'buildflow.prochat.tools',
      localOrigin: LOCAL_WEB,
      localAgent: LOCAL_AGENT,
      localRelay: LOCAL_RELAY
    },
    tokenAvailable: Boolean(token),
    cloudflared: {
      processCount: processLines.length,
      multipleTunnelProcessWarning: processLines.length > 1,
      processes: processLines
    },
    listeners: portLines,
    relayContainer: container,
    probes
  }

  if (freshCheck) {
    const agent = probes.find(item => item.name === 'local_agent_health')?.json
    const relay = probes.find(item => item.name === 'local_relay_health')?.json
    const web = probes.find(item => item.name === 'local_unified_health')?.json
    output.freshness = {
      agent: assertFreshService('agent', agent, expectedCommit),
      relay: assertFreshService('relay', relay, expectedCommit),
      web: assertFreshService('web', web, expectedCommit)
    }
    if (!/image=sha256:/.test(container || '') || !/project=workbench/.test(container || '') || !/name=\/workbench-relay/.test(container || '')) {
      throw new Error('Relay container metadata did not prove workbench project/name/image')
    }
  }

  if (benchmark) {
    output.benchmarks = [
      await runBench('local_openapi', () => fetchProbe('local_openapi', `${LOCAL_WEB}/api/openapi`, { timeoutMs: 5000 })),
      await runBench('local_status_unauth', () => fetchProbe('local_status_unauth', `${LOCAL_WEB}/api/actions/status`, { timeoutMs: 5000 })),
      await runBench('local_agent_health', () => fetchProbe('local_agent_health', `${LOCAL_AGENT}/health`, { timeoutMs: 5000 })),
      await runBench('local_relay_health', () => fetchProbe('local_relay_health', `${LOCAL_RELAY}/health`, { timeoutMs: 5000 })),
      await runBench('public_workbench_openapi', () => fetchProbe('public_workbench_openapi', `${PUBLIC_WORKBENCH}/api/openapi`, { timeoutMs: 15000 })),
      await runBench('public_workbench_status_unauth', () => fetchProbe('public_workbench_status_unauth', `${PUBLIC_WORKBENCH}/api/actions/status`, { timeoutMs: 15000 })),
      await runBench('public_buildflow_openapi', () => fetchProbe('public_buildflow_openapi', `${PUBLIC_BUILDFLOW}/api/openapi`, { timeoutMs: 15000 }))
    ]
  }

  if (jsonOnly) {
    console.log(JSON.stringify(output, null, 2))
    return
  }

  console.log(JSON.stringify(output, null, 2))
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
