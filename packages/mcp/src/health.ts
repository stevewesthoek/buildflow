#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { validateNodeContract } from './configure-core.js'
import { inspectCodexRegistration, type CodexRegistrationStatus } from './configure-codex.js'
import { assessClaudeRegistration, inspectClaudeRegistration, type ClaudeRegistrationStatus } from './configure-claude.js'

export type HealthArguments = {
  expectedSourceCount?: number
}

export type HealthResult = {
  nodeVersion: string
  codexRegistration: 'valid'
  claudeRegistration: 'valid'
  connected: true
  sourceCount: number
  elapsedMs: number
  warnings: string[]
}

export type HealthToolResponse = {
  isError?: boolean
  content?: Array<{ type?: string; text?: string }>
}

export type HealthClient = {
  connect(): Promise<void>
  callStatus(): Promise<HealthToolResponse>
  close(): Promise<void>
}

export type HealthDependencies = {
  nodeVersion: string
  executablePath: string
  repositoryRoot: string
  inspectCodex(): CodexRegistrationStatus
  inspectClaude(): ClaudeRegistrationStatus
  createClient(input: {
    executablePath: string
    serverEntrypoint: string
    repositoryRoot: string
    credentialFile: string
  }): HealthClient
  now(): number
  timeoutMs: number
}

function positiveInteger(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${flag} must be a positive integer.`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer.`)
  return parsed
}

export function parseHealthArguments(argv: string[]): HealthArguments {
  const args = argv[0] === '--' ? argv.slice(1) : argv
  const result: HealthArguments = {}
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument !== '--expected-source-count') throw new Error(`Unknown argument: ${argument}`)
    const value = args[index + 1]
    if (value === undefined) throw new Error('--expected-source-count requires a value.')
    result.expectedSourceCount = positiveInteger(value, '--expected-source-count')
    index += 1
  }
  return result
}

function assertCodexRegistration(status: CodexRegistrationStatus): void {
  const oneUnambiguousScope =
    (status.globalMatchCount === 1 && status.projectMatchCount === 0)
    || (status.globalMatchCount === 0 && status.projectMatchCount === 1)
  const valid = status.configured &&
    status.configMode === '0600' &&
    status.credentialMode === '0600' &&
    status.duplicateCount === 1 &&
    oneUnambiguousScope
  if (!valid) throw new Error('Codex Workbench MCP registration is invalid.')
}

function assertClaudeRegistration(status: ClaudeRegistrationStatus): string[] {
  const assessment = assessClaudeRegistration(status)
  if (!assessment.operational) {
    throw new Error(`Claude Code Workbench MCP registration is invalid: ${assessment.failures.join(' ')}`)
  }
  return assessment.warnings
}

export function parseWorkbenchStatusResponse(response: HealthToolResponse, expectedSourceCount?: number): {
  connected: true
  sourceCount: number
} {
  if (response.isError === true) throw new Error('Workbench MCP health request failed.')
  const text = response.content?.find(item => item.type === 'text' && typeof item.text === 'string')?.text
  if (!text) throw new Error('Workbench MCP health response did not contain a text payload.')

  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error('Workbench MCP health response was not valid JSON.')
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Workbench MCP health payload must be an object.')
  }

  const record = payload as Record<string, unknown>
  if (record.connected !== true) throw new Error('Workbench backend reported connected=false.')
  if (!Array.isArray(record.sources)) throw new Error('Workbench health payload omitted sources.')
  if (!Number.isSafeInteger(record.sourceCount) || (record.sourceCount as number) <= 0) {
    throw new Error('Workbench health payload contained an invalid sourceCount.')
  }
  const sourceCount = record.sourceCount as number
  const sourcesTruncated = record.sourcesTruncated === true
  if (sourceCount !== record.sources.length && !sourcesTruncated) {
    throw new Error('Workbench health sourceCount did not match sources.length.')
  }
  if (sourcesTruncated && record.sources.length > sourceCount) {
    throw new Error('Workbench health truncated sources exceeded sourceCount.')
  }
  if (expectedSourceCount !== undefined && sourceCount !== expectedSourceCount) {
    throw new Error(`Workbench health expected ${expectedSourceCount} sources but received ${sourceCount}.`)
  }
  return { connected: true, sourceCount }
}

async function withinTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Workbench MCP health request timed out.')), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function runHealthCheck(arguments_: HealthArguments, dependencies: HealthDependencies): Promise<HealthResult> {
  const startedAt = dependencies.now()
  const nodeCheck = validateNodeContract(dependencies.nodeVersion)
  if (!nodeCheck.valid) throw new Error(nodeCheck.reason ?? 'Unsupported Node.js runtime.')

  const codexStatus = dependencies.inspectCodex()
  const claudeStatus = dependencies.inspectClaude()
  assertCodexRegistration(codexStatus)
  const warnings = assertClaudeRegistration(claudeStatus)
  if (codexStatus.credentialFile !== claudeStatus.credentialFile) {
    throw new Error('Claude Code and Codex registrations do not share the same credential file.')
  }

  const client = dependencies.createClient({
    executablePath: dependencies.executablePath,
    serverEntrypoint: path.join(dependencies.repositoryRoot, 'packages/mcp/dist/server.js'),
    repositoryRoot: dependencies.repositoryRoot,
    credentialFile: codexStatus.credentialFile
  })

  try {
    await withinTimeout(client.connect(), dependencies.timeoutMs)
    const response = await withinTimeout(client.callStatus(), dependencies.timeoutMs)
    const status = parseWorkbenchStatusResponse(response, arguments_.expectedSourceCount)
    return {
      nodeVersion: dependencies.nodeVersion,
      codexRegistration: 'valid',
      claudeRegistration: 'valid',
      connected: status.connected,
      sourceCount: status.sourceCount,
      elapsedMs: Math.max(0, dependencies.now() - startedAt),
      warnings
    }
  } finally {
    await client.close().catch(() => undefined)
  }
}

function environmentWithCredential(credentialFile: string): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') environment[key] = value
  }
  environment.WORKBENCH_MCP_CREDENTIAL_FILE = credentialFile
  return environment
}

function realDependencies(): HealthDependencies {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const repositoryRoot = path.resolve(here, '../../..')
  return {
    nodeVersion: process.version,
    executablePath: process.execPath,
    repositoryRoot,
    inspectCodex: () => inspectCodexRegistration({ workbenchRepoRoot: repositoryRoot }),
    inspectClaude: () => inspectClaudeRegistration({ workbenchRepoRoot: repositoryRoot }),
    createClient: input => {
      const transport = new StdioClientTransport({
        command: input.executablePath,
        args: [input.serverEntrypoint],
        cwd: input.repositoryRoot,
        env: environmentWithCredential(input.credentialFile),
        stderr: 'pipe'
      })
      const client = new Client({ name: 'workbench-mcp-health', version: '1.0.0' })
      return {
        connect: () => client.connect(transport),
        callStatus: () => client.callTool({
          name: 'getWorkbenchStatus',
          arguments: { include: 'sources' }
        }) as Promise<HealthToolResponse>,
        close: () => client.close()
      }
    },
    now: () => Date.now(),
    timeoutMs: 10_000
  }
}

async function main(): Promise<void> {
  const result = await runHealthCheck(parseHealthArguments(process.argv.slice(2)), realDependencies())
  process.stdout.write(`Node version: ${result.nodeVersion}\n`)
  process.stdout.write(`Codex registration: ${result.codexRegistration}\n`)
  process.stdout.write(`Claude Code registration: ${result.claudeRegistration}\n`)
  process.stdout.write(`Connected: ${result.connected}\n`)
  process.stdout.write(`Source count: ${result.sourceCount}\n`)
  process.stdout.write(`Elapsed ms: ${result.elapsedMs}\n`)
  for (const warning of result.warnings) process.stderr.write(`WARN: ${warning}\n`)
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main().catch(error => {
    process.stderr.write(`Workbench MCP health failed: ${error instanceof Error ? error.message : 'unknown error'}\n`)
    process.exitCode = 1
  })
}
