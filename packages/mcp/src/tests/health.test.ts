import assert from 'node:assert/strict'
import test from 'node:test'
import type { CodexRegistrationStatus } from '../configure-codex.js'
import type { ClaudeRegistrationStatus } from '../configure-claude.js'
import { validateNodeContract } from '../configure-core.js'
import {
  parseHealthArguments,
  parseWorkbenchStatusResponse,
  runHealthCheck,
  type HealthClient,
  type HealthDependencies,
  type HealthToolResponse
} from '../health.js'

const credentialFile = '/tmp/workbench-mcp-health/credential.token'

function codex(overrides: Partial<CodexRegistrationStatus> = {}): CodexRegistrationStatus {
  return {
    configured: true,
    serverName: 'workbench',
    globalConfigPath: '/tmp/codex/global.toml',
    projectConfigPath: '/tmp/project/.codex/config.toml',
    credentialFile,
    configMode: '0600',
    credentialMode: '0600',
    command: '/node20/bin/node',
    args: ['/repo/packages/mcp/dist/server.js'],
    cwd: '/repo',
    globalConfigUnchanged: true,
    duplicateCount: 1,
    globalMatchCount: 0,
    projectMatchCount: 1,
    profile: 'workbench',
    availability: 'required',
    ...overrides
  }
}

function claude(overrides: Partial<ClaudeRegistrationStatus> = {}): ClaudeRegistrationStatus {
  return {
    configured: true,
    serverName: 'workbench',
    claudeJsonPath: '/tmp/claude.json',
    credentialFile,
    claudeJsonMode: '0600',
    credentialMode: '0600',
    command: '/node20/bin/node',
    args: ['/repo/packages/mcp/dist/server.js'],
    commandMatchesExpected: true,
    commandExecutableValid: true,
    argsMatchExpected: true,
    environmentMatchesExpected: true,
    unexpectedEnvironmentKeys: [],
    missingEnvironmentKeys: [],
    duplicateCount: 1,
    userMatchCount: 0,
    localMatchCount: 1,
    profile: 'workbench',
    availability: 'required',
    scope: 'local',
    targetProjectRoot: '/repo',
    ...overrides
  }
}

function statusResponse(count = 17): HealthToolResponse {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        connected: true,
        sourceCount: count,
        sources: Array.from({ length: count }, (_value, index) => ({ id: `source-${index}`, path: `/private/${index}` }))
      })
    }]
  }
}

class MockHealthClient implements HealthClient {
  connectCalls = 0
  callCalls = 0
  closeCalls = 0
  connectError?: Error
  callError?: Error
  response: HealthToolResponse = statusResponse()
  pendingCall = false

  async connect(): Promise<void> {
    this.connectCalls += 1
    if (this.connectError) throw this.connectError
  }

  async callStatus(): Promise<HealthToolResponse> {
    this.callCalls += 1
    if (this.callError) throw this.callError
    if (this.pendingCall) return await new Promise<HealthToolResponse>(() => undefined)
    return this.response
  }

  async close(): Promise<void> {
    this.closeCalls += 1
  }
}

function dependencies(client: MockHealthClient, overrides: Partial<HealthDependencies> = {}): HealthDependencies {
  let clock = 100
  return {
    nodeVersion: 'v20.20.2',
    executablePath: '/node20/bin/node',
    repositoryRoot: '/repo',
    inspectCodex: () => codex(),
    inspectClaude: () => claude(),
    createClient: () => client,
    now: () => {
      clock += 5
      return clock
    },
    timeoutMs: 50,
    ...overrides
  }
}

test('accepts Node 20.20.2', () => assert.deepEqual(validateNodeContract('v20.20.2'), { valid: true }))
test('accepts a later Node 20 patch', () => assert.deepEqual(validateNodeContract('20.21.0'), { valid: true }))
test('rejects an older Node 20 minor', () => assert.equal(validateNodeContract('v20.19.9').valid, false))
test('rejects Node 19', () => assert.equal(validateNodeContract('v19.20.2').valid, false))
test('rejects Node 21', () => assert.equal(validateNodeContract('v21.0.0').valid, false))
test('rejects Node 25', () => assert.equal(validateNodeContract('v25.9.0').valid, false))
test('rejects malformed Node versions', () => assert.equal(validateNodeContract('twenty').valid, false))

test('parses an expected source count', () => assert.deepEqual(parseHealthArguments(['--expected-source-count', '17']), { expectedSourceCount: 17 }))
test('rejects an unknown health argument', () => assert.throws(() => parseHealthArguments(['--verbose']), /Unknown argument/))
test('rejects a missing expected count', () => assert.throws(() => parseHealthArguments(['--expected-source-count']), /requires a value/))
test('rejects zero expected count', () => assert.throws(() => parseHealthArguments(['--expected-source-count', '0']), /positive integer/))
test('rejects negative expected count', () => assert.throws(() => parseHealthArguments(['--expected-source-count', '-1']), /positive integer/))
test('rejects fractional expected count', () => assert.throws(() => parseHealthArguments(['--expected-source-count', '1.5']), /positive integer/))
test('rejects malformed expected count', () => assert.throws(() => parseHealthArguments(['--expected-source-count', 'abc']), /positive integer/))

test('parses a healthy Workbench status response', () => assert.deepEqual(parseWorkbenchStatusResponse(statusResponse(17), 17), { connected: true, sourceCount: 17 }))
test('rejects connected false', () => assert.throws(() => parseWorkbenchStatusResponse({ content: [{ type: 'text', text: JSON.stringify({ connected: false, sourceCount: 1, sources: [{}] }) }] }), /connected=false/))
test('rejects missing sources', () => assert.throws(() => parseWorkbenchStatusResponse({ content: [{ type: 'text', text: JSON.stringify({ connected: true, sourceCount: 1 }) }] }), /omitted sources/))
test('rejects malformed source count', () => assert.throws(() => parseWorkbenchStatusResponse({ content: [{ type: 'text', text: JSON.stringify({ connected: true, sourceCount: '1', sources: [{}] }) }] }), /invalid sourceCount/))
test('rejects mismatched source count', () => assert.throws(() => parseWorkbenchStatusResponse({ content: [{ type: 'text', text: JSON.stringify({ connected: true, sourceCount: 2, sources: [{}] }) }] }), /did not match/))
test('accepts an explicitly truncated source list', () => assert.deepEqual(parseWorkbenchStatusResponse({ content: [{ type: 'text', text: JSON.stringify({ connected: true, sourceCount: 40, sources: [{}], sourcesTruncated: true }) }] }), { connected: true, sourceCount: 40 }))
test('rejects a truncated source list larger than sourceCount', () => assert.throws(() => parseWorkbenchStatusResponse({ content: [{ type: 'text', text: JSON.stringify({ connected: true, sourceCount: 1, sources: [{}, {}], sourcesTruncated: true }) }] }), /exceeded sourceCount/))
test('rejects tool-level errors without leaking payload text', () => assert.throws(() => parseWorkbenchStatusResponse({ isError: true, content: [{ type: 'text', text: 'Bearer private-token' }] }), error => error instanceof Error && error.message === 'Workbench MCP health request failed.'))
test('rejects invalid JSON', () => assert.throws(() => parseWorkbenchStatusResponse({ content: [{ type: 'text', text: '{' }] }), /not valid JSON/))
test('rejects non-object payloads', () => assert.throws(() => parseWorkbenchStatusResponse({ content: [{ type: 'text', text: '[]' }] }), /must be an object/))
test('rejects an unexpected positive source count', () => assert.throws(() => parseWorkbenchStatusResponse(statusResponse(16), 17), /expected 17 sources/))

test('runs a complete health check and closes the client', async () => {
  const client = new MockHealthClient()
  const result = await runHealthCheck({ expectedSourceCount: 17 }, dependencies(client))
  assert.equal(result.connected, true)
  assert.equal(result.sourceCount, 17)
  assert.deepEqual(result.warnings, [])
  assert.equal(client.connectCalls, 1)
  assert.equal(client.callCalls, 1)
  assert.equal(client.closeCalls, 1)
  assert(!JSON.stringify(result).includes('/private/'))
})

test('accepts one valid owner-global Codex registration', async () => {
  const client = new MockHealthClient()
  const result = await runHealthCheck({}, dependencies(client, {
    inspectCodex: () => codex({ globalMatchCount: 1, projectMatchCount: 0, scope: 'global' })
  }))
  assert.equal(result.codexRegistration, 'valid')
  assert.equal(result.connected, true)
})

test('rejects conflicting global and project Codex registrations', async () => {
  const client = new MockHealthClient()
  await assert.rejects(
    runHealthCheck({}, dependencies(client, { inspectCodex: () => codex({ globalMatchCount: 1, projectMatchCount: 1, duplicateCount: 2 }) })),
    /Codex/
  )
  assert.equal(client.connectCalls, 0)
})

test('fails invalid Codex registration before starting a client', async () => {
  const client = new MockHealthClient()
  await assert.rejects(runHealthCheck({}, dependencies(client, { inspectCodex: () => codex({ configured: false }) })), /Codex/)
  assert.equal(client.connectCalls, 0)
})

test('fails structurally invalid Claude registration before starting a client', async () => {
  const client = new MockHealthClient()
  await assert.rejects(
    runHealthCheck({}, dependencies(client, { inspectClaude: () => claude({ configured: false, argsMatchExpected: false }) })),
    /arguments do not match/
  )
  assert.equal(client.connectCalls, 0)
})

test('accepts caller-node path drift when the registered Node command remains executable', async () => {
  const client = new MockHealthClient()
  const result = await runHealthCheck({}, dependencies(client, {
    inspectClaude: () => claude({ configured: false, commandMatchesExpected: false })
  }))
  assert.equal(result.connected, true)
  assert.equal(result.warnings.some(warning => /Registered Node executable differs/.test(warning)), true)
})

test('treats Claude config mode drift as a warning when the credential remains 0600', async () => {
  const client = new MockHealthClient()
  const result = await runHealthCheck({}, dependencies(client, {
    inspectClaude: () => claude({ claudeJsonMode: '0644' })
  }))
  assert.equal(result.connected, true)
  assert.equal(result.warnings.some(warning => /configuration-hardening debt/.test(warning)), true)
})

test('fails an unsafe Claude credential mode before starting a client', async () => {
  const client = new MockHealthClient()
  await assert.rejects(
    runHealthCheck({}, dependencies(client, { inspectClaude: () => claude({ credentialMode: '0644' }) })),
    /Credential file mode must be 0600/
  )
  assert.equal(client.connectCalls, 0)
})

test('fails a non-executable Claude registration command before starting a client', async () => {
  const client = new MockHealthClient()
  await assert.rejects(
    runHealthCheck({}, dependencies(client, { inspectClaude: () => claude({ configured: false, commandExecutableValid: false }) })),
    /not a valid executable Node binary/
  )
  assert.equal(client.connectCalls, 0)
})

test('fails duplicate Codex registration', async () => {
  const client = new MockHealthClient()
  await assert.rejects(runHealthCheck({}, dependencies(client, { inspectCodex: () => codex({ duplicateCount: 2, projectMatchCount: 2 }) })), /Codex/)
})

test('fails mismatched credential paths', async () => {
  const client = new MockHealthClient()
  await assert.rejects(runHealthCheck({}, dependencies(client, { inspectClaude: () => claude({ credentialFile: '/tmp/other.token' }) })), /same credential file/)
})

test('closes the client when connection fails', async () => {
  const client = new MockHealthClient()
  client.connectError = new Error('connect failed')
  await assert.rejects(runHealthCheck({}, dependencies(client)), /connect failed/)
  assert.equal(client.closeCalls, 1)
})

test('closes the client when a status call fails', async () => {
  const client = new MockHealthClient()
  client.callError = new Error('call failed')
  await assert.rejects(runHealthCheck({}, dependencies(client)), /call failed/)
  assert.equal(client.closeCalls, 1)
})

test('times out and closes the client', async () => {
  const client = new MockHealthClient()
  client.pendingCall = true
  await assert.rejects(runHealthCheck({}, dependencies(client, { timeoutMs: 5 })), /timed out/)
  assert.equal(client.closeCalls, 1)
})

test('passes process executable and fixed server entrypoint to the client factory', async () => {
  const client = new MockHealthClient()
  let captured: Parameters<HealthDependencies['createClient']>[0] | undefined
  await runHealthCheck({}, dependencies(client, {
    createClient: input => {
      captured = input
      return client
    }
  }))
  assert.equal(captured?.executablePath, '/node20/bin/node')
  assert.equal(captured?.serverEntrypoint, '/repo/packages/mcp/dist/server.js')
})
