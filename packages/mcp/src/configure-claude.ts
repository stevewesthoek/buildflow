#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deriveWorkbenchMcpCredential } from '@workbench/shared/workbench-mcp-auth'
import { loadWorkbenchOwnerConfig } from '@workbench/shared/workbench-owner-config'
import {
  WORKBENCH_MCP_PROFILES,
  WORKBENCH_CREDENTIAL_FILE_NAME,
  PROFILE_AVAILABILITY,
  buildWorkbenchMcpServerSpec,
  canonicalProjectRoot,
  canonicalNodeExecutable,
  parseConfigureCliArgs,
  validateNodeContract,
  type WorkbenchMcpProfile
} from './configure-core.js'

export { WORKBENCH_MCP_PROFILES, PROFILE_AVAILABILITY, parseConfigureCliArgs, type WorkbenchMcpProfile }

const SERVER_NAME = 'workbench'

type ClaudeJsonDocument = Record<string, unknown>
type ClaudeMcpEntry = {
  command: string
  args?: string[]
  env?: Record<string, string>
  type?: string
}
type ClaudeMcpServers = Record<string, ClaudeMcpEntry>

export type ClaudeConfigureOptions = {
  workbenchRepoRoot: string
  targetProjectRoot?: string
  homeDir?: string
  now?: Date
  nodeExecutable?: string
  profile?: WorkbenchMcpProfile
  claudeBin?: string
  checkProcesses?: () => string[]
}

export type ClaudeConfigureHooks = {
  afterCredentialWrite?: () => void
  afterCliAdd?: () => void
}

export type ClaudeRegistrationAssessment = {
  operational: boolean
  failures: string[]
  warnings: string[]
}

export type ClaudeRegistrationStatus = {
  configured: boolean
  serverName: string
  claudeJsonPath: string
  credentialFile: string
  claudeJsonMode?: string
  credentialMode?: string
  command?: string
  args?: string[]
  commandMatchesExpected: boolean
  commandExecutableValid: boolean
  argsMatchExpected: boolean
  environmentMatchesExpected: boolean
  unexpectedEnvironmentKeys: string[]
  missingEnvironmentKeys: string[]
  duplicateCount: number
  userMatchCount: number
  localMatchCount: number
  profile: WorkbenchMcpProfile
  availability: 'required' | 'optional'
  scope: 'local'
  targetProjectRoot: string
}

function mode(file: string): string | undefined {
  try {
    return (fs.statSync(file).mode & 0o777).toString(8).padStart(4, '0')
  } catch {
    return undefined
  }
}

function registeredNodeCommandIsExecutable(command: string | undefined): boolean {
  if (!command || !path.isAbsolute(command)) return false
  try {
    return path.basename(canonicalNodeExecutable(command)) === 'node'
  } catch {
    return false
  }
}

function atomicWrite(file: string, content: string, fileMode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.tmp-${process.pid}`
  fs.writeFileSync(temporary, content, { encoding: 'utf8', mode: fileMode })
  fs.chmodSync(temporary, fileMode)
  fs.renameSync(temporary, file)
  fs.chmodSync(file, fileMode)
}

function readClaudeJson(file: string): ClaudeJsonDocument {
  if (!fs.existsSync(file)) return {}
  const text = fs.readFileSync(file, 'utf8')
  const parsed = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid ~/.claude.json object: ${file}`)
  }
  return parsed as ClaudeJsonDocument
}

function safeReadClaudeJson(file: string): ClaudeJsonDocument | null {
  try {
    return readClaudeJson(file)
  } catch {
    return null
  }
}

function configPaths(options: ClaudeConfigureOptions) {
  const workbenchRepoRoot = canonicalProjectRoot(options.workbenchRepoRoot, 'Workbench repository root')
  const targetProjectRoot = canonicalProjectRoot(options.targetProjectRoot ?? options.workbenchRepoRoot, 'Target project root')
  const homeDir = options.homeDir ?? os.userInfo().homedir
  const claudeJsonPath = path.join(homeDir, '.claude.json')
  const nodeExecutable = canonicalNodeExecutable(options.nodeExecutable ?? process.execPath)
  return {
    workbenchRepoRoot,
    targetProjectRoot,
    homeDir,
    claudeJsonPath,
    credentialFile: path.join(homeDir, '.buildflow', WORKBENCH_CREDENTIAL_FILE_NAME),
    nodeExecutable
  }
}

function getUserMcpServers(doc: ClaudeJsonDocument): ClaudeMcpServers {
  const servers = doc.mcpServers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return {}
  return servers as ClaudeMcpServers
}

function getLocalMcpServers(doc: ClaudeJsonDocument, projectRoot: string): ClaudeMcpServers {
  const projects = doc.projects
  if (!projects || typeof projects !== 'object' || Array.isArray(projects)) return {}
  const project = (projects as Record<string, unknown>)[projectRoot]
  if (!project || typeof project !== 'object' || Array.isArray(project)) return {}
  const servers = (project as Record<string, unknown>).mcpServers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return {}
  return servers as ClaudeMcpServers
}

function isWorkbenchEntry(name: string, entry: ClaudeMcpEntry, workbenchRepoRoot: string): boolean {
  if (name === SERVER_NAME) return true
  const entrypointSuffix = path.join('packages', 'mcp', 'dist', 'server.js')
  if (Array.isArray(entry.args)) {
    return entry.args.some(arg =>
      typeof arg === 'string' && (
        arg === path.join(workbenchRepoRoot, entrypointSuffix) ||
        path.normalize(arg).endsWith(entrypointSuffix)
      )
    )
  }
  return false
}

function buildExpectedEntry(spec: ReturnType<typeof buildWorkbenchMcpServerSpec>): ClaudeMcpEntry {
  return {
    command: spec.command,
    args: spec.args,
    env: spec.env
  }
}

function entryMatchDiagnostics(actual: ClaudeMcpEntry | undefined, expected: ClaudeMcpEntry): {
  commandMatchesExpected: boolean
  argsMatchExpected: boolean
  environmentMatchesExpected: boolean
  unexpectedEnvironmentKeys: string[]
  missingEnvironmentKeys: string[]
} {
  const actualEnv = actual?.env ?? {}
  const expectedEnv = expected.env ?? {}
  const unexpectedEnvironmentKeys = Object.keys(actualEnv).filter(key => !(key in expectedEnv)).sort()
  const missingEnvironmentKeys = Object.keys(expectedEnv).filter(key => !(key in actualEnv)).sort()
  const environmentMatchesExpected = unexpectedEnvironmentKeys.length === 0 &&
    missingEnvironmentKeys.length === 0 &&
    Object.keys(expectedEnv).every(key => actualEnv[key] === expectedEnv[key])
  return {
    commandMatchesExpected: actual?.command === expected.command,
    argsMatchExpected: JSON.stringify(actual?.args ?? []) === JSON.stringify(expected.args ?? []),
    environmentMatchesExpected,
    unexpectedEnvironmentKeys,
    missingEnvironmentKeys
  }
}

function entriesMatch(actual: ClaudeMcpEntry, expected: ClaudeMcpEntry): boolean {
  const diagnostics = entryMatchDiagnostics(actual, expected)
  return diagnostics.commandMatchesExpected && diagnostics.argsMatchExpected && diagnostics.environmentMatchesExpected
}

function credentialIsReferenced(doc: ClaudeJsonDocument, credentialFile: string): boolean {
  const userServers = getUserMcpServers(doc)
  for (const entry of Object.values(userServers)) {
    if (entry.env?.WORKBENCH_MCP_CREDENTIAL_FILE === credentialFile) return true
  }
  const projects = doc.projects
  if (projects && typeof projects === 'object' && !Array.isArray(projects)) {
    for (const project of Object.values(projects as Record<string, unknown>)) {
      if (!project || typeof project !== 'object' || Array.isArray(project)) continue
      const servers = (project as Record<string, unknown>).mcpServers
      if (!servers || typeof servers !== 'object' || Array.isArray(servers)) continue
      for (const entry of Object.values(servers as Record<string, unknown>)) {
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
          const env = (entry as Record<string, unknown>).env
          if (env && typeof env === 'object' && !Array.isArray(env)) {
            if ((env as Record<string, unknown>).WORKBENCH_MCP_CREDENTIAL_FILE === credentialFile) return true
          }
        }
      }
    }
  }
  return false
}

// Exported for unit testing — callers must not depend on this in production code.
export function probeProcessName(
  name: string,
  exec: (file: string, args: string[], opts: { encoding: 'utf8' }) => void
): 'running' | 'absent' | 'probe-error' {
  try {
    exec('/usr/bin/pgrep', ['-x', name], { encoding: 'utf8' })
    return 'running'
  } catch (err) {
    // pgrep exit 1 means no matching process — expected.
    // Any other failure (ENOENT, permission error, exit 2+) means quiescence was NOT proven.
    const status = (err as NodeJS.ErrnoException & { status?: number }).status
    if (status === 1) return 'absent'
    return 'probe-error'
  }
}

function defaultCheckProcesses(): string[] {
  const running: string[] = []
  for (const name of ['Claude', 'claude']) {
    const result = probeProcessName(name, (file, args, opts) => execFileSync(file, args, opts))
    if (result === 'running') {
      running.push(name)
    } else if (result === 'probe-error') {
      throw new Error(
        `Process probe for '${name}' failed unexpectedly. ` +
        `Cannot prove quiescence — aborting to avoid concurrent config mutation.`
      )
    }
  }
  return running
}

function posixQuote(s: string): string {
  // Wrap in single quotes; escape any embedded single quotes as '\''
  return `'${s.replace(/'/g, "'\\''")}'`
}

function applyCredentialRollback(
  credentialExisted: boolean,
  credentialBefore: string | undefined,
  credentialModeBefore: number,
  credentialFile: string
): void {
  if (credentialExisted && credentialBefore !== undefined) {
    atomicWrite(credentialFile, credentialBefore, credentialModeBefore)
  } else if (fs.existsSync(credentialFile)) {
    fs.unlinkSync(credentialFile)
  }
}

export function inspectClaudeRegistration(options: ClaudeConfigureOptions): ClaudeRegistrationStatus {
  const profile: WorkbenchMcpProfile = options.profile ?? 'workbench'
  const paths = configPaths(options)
  const doc = readClaudeJson(paths.claudeJsonPath)
  const userServers = getUserMcpServers(doc)
  const localServers = getLocalMcpServers(doc, paths.targetProjectRoot)
  const userMatches = Object.entries(userServers).filter(([n, e]) => isWorkbenchEntry(n, e, paths.workbenchRepoRoot))
  const localMatches = Object.entries(localServers).filter(([n, e]) => isWorkbenchEntry(n, e, paths.workbenchRepoRoot))
  const localEntry = localServers[SERVER_NAME]
  const spec = buildWorkbenchMcpServerSpec(paths.workbenchRepoRoot, paths.credentialFile, paths.nodeExecutable, profile)
  const expected = buildExpectedEntry(spec)
  const diagnostics = entryMatchDiagnostics(localEntry, expected)
  const configured = !!localEntry && diagnostics.commandMatchesExpected && diagnostics.argsMatchExpected && diagnostics.environmentMatchesExpected

  return {
    configured,
    serverName: SERVER_NAME,
    claudeJsonPath: paths.claudeJsonPath,
    credentialFile: paths.credentialFile,
    claudeJsonMode: mode(paths.claudeJsonPath),
    credentialMode: mode(paths.credentialFile),
    command: localEntry?.command,
    args: localEntry?.args,
    commandMatchesExpected: diagnostics.commandMatchesExpected,
    commandExecutableValid: registeredNodeCommandIsExecutable(localEntry?.command),
    argsMatchExpected: diagnostics.argsMatchExpected,
    environmentMatchesExpected: diagnostics.environmentMatchesExpected,
    unexpectedEnvironmentKeys: diagnostics.unexpectedEnvironmentKeys,
    missingEnvironmentKeys: diagnostics.missingEnvironmentKeys,
    duplicateCount: userMatches.length + localMatches.length,
    userMatchCount: userMatches.length,
    localMatchCount: localMatches.length,
    profile,
    availability: PROFILE_AVAILABILITY[profile],
    scope: 'local',
    targetProjectRoot: paths.targetProjectRoot
  }
}

export function assessClaudeRegistration(status: ClaudeRegistrationStatus): ClaudeRegistrationAssessment {
  const failures: string[] = []
  const warnings: string[] = []

  if (status.userMatchCount > 0) failures.push(`Found ${status.userMatchCount} Workbench definition(s) at Claude user scope.`)
  if (status.localMatchCount !== 1) failures.push(`Expected exactly 1 local Workbench definition; found ${status.localMatchCount}.`)
  if (status.duplicateCount !== 1) failures.push(`Expected exactly 1 total Workbench definition; found ${status.duplicateCount}.`)
  if (!status.commandExecutableValid) failures.push('Registered Workbench command is not a valid executable Node binary.')
  if (!status.argsMatchExpected) failures.push('Registered Workbench arguments do not match the canonical server entrypoint.')
  if (!status.environmentMatchesExpected) {
    const details = [
      status.unexpectedEnvironmentKeys.length > 0 ? `unexpected keys: ${status.unexpectedEnvironmentKeys.join(', ')}` : '',
      status.missingEnvironmentKeys.length > 0 ? `missing keys: ${status.missingEnvironmentKeys.join(', ')}` : ''
    ].filter(Boolean).join('; ')
    failures.push(`Registered Workbench environment does not match the canonical credential/profile contract${details ? ` (${details})` : ''}.`)
  }
  if (status.credentialMode !== '0600') failures.push(`Credential file mode must be 0600 (found: ${status.credentialMode ?? 'missing'}).`)

  if (!status.commandMatchesExpected && status.commandExecutableValid) {
    warnings.push(`Registered Node executable differs from the Node executable running this inspection (${status.command ?? 'missing'}). Strict configure/audit may report drift; operational health must be validated under the supported Node 20 runtime.`)
  }
  if (status.claudeJsonMode !== '0600') {
    warnings.push(`~/.claude.json mode is ${status.claudeJsonMode ?? 'missing'} rather than 0600. The credential remains separately protected by its required 0600 file; treat this as configuration-hardening debt, not a runtime connectivity failure.`)
  }

  return { operational: failures.length === 0, failures, warnings }
}

function resolveClaudeBin(options: ClaudeConfigureOptions): string {
  if (options.claudeBin) return options.claudeBin
  const which = (() => {
    try { return execFileSync('/usr/bin/which', ['claude'], { encoding: 'utf8' }).trim() } catch { return '' }
  })()
  if (which && fs.existsSync(which)) return which
  throw new Error(
    'Claude CLI not found. Install Claude Code (https://docs.anthropic.com/en/docs/claude-code) ' +
    'or pass claudeBin option with the path to the claude binary.'
  )
}

export function configureClaude(options: ClaudeConfigureOptions, hooks?: ClaudeConfigureHooks): ClaudeRegistrationStatus {
  const profile: WorkbenchMcpProfile = options.profile ?? 'workbench'
  const nodeCheck = validateNodeContract()
  if (!nodeCheck.valid) throw new Error(`Cannot configure MCP: ${nodeCheck.reason}`)

  const paths = configPaths(options)

  const preDoc = readClaudeJson(paths.claudeJsonPath)
  const userServers = getUserMcpServers(preDoc)
  const userMatches = Object.entries(userServers).filter(([n, e]) => isWorkbenchEntry(n, e, paths.workbenchRepoRoot))
  if (userMatches.length > 0) {
    throw new Error(
      'A Workbench MCP definition already exists at user scope in ~/.claude.json. ' +
      'Remove it with `claude mcp remove workbench -s user` before writing a local-scope registration.'
    )
  }

  const spec = buildWorkbenchMcpServerSpec(paths.workbenchRepoRoot, paths.credentialFile, paths.nodeExecutable, profile)
  const expected = buildExpectedEntry(spec)

  const localServers = getLocalMcpServers(preDoc, paths.targetProjectRoot)
  const localMatches = Object.entries(localServers).filter(([n, e]) => isWorkbenchEntry(n, e, paths.workbenchRepoRoot))
  if (localMatches.length > 1 || (localMatches.length === 1 && localMatches[0][0] !== SERVER_NAME)) {
    throw new Error('Duplicate or conflicting Workbench MCP definitions found in local scope.')
  }

  const credentialExisted = fs.existsSync(paths.credentialFile)
  const credentialBefore = credentialExisted ? fs.readFileSync(paths.credentialFile, 'utf8') : undefined
  const credentialModeBefore = credentialExisted ? fs.statSync(paths.credentialFile).mode & 0o777 : 0o600

  const bearerValue = deriveWorkbenchMcpCredential(
    loadWorkbenchOwnerConfig({ homeDir: paths.homeDir }).actionToken
  )

  atomicWrite(paths.credentialFile, `${bearerValue}\n`, 0o600)

  let cliStarted = false
  try {
    hooks?.afterCredentialWrite?.()
    const claudeBin = resolveClaudeBin(options)
    const entryJson = JSON.stringify(expected)
    const env: Record<string, string | undefined> = { ...process.env, HOME: paths.homeDir }
    delete env.CLAUDE_CONFIG_DIR

    const checkProcesses = options.checkProcesses ?? defaultCheckProcesses
    const running = checkProcesses()
    if (running.length > 0) {
      throw new Error(
        `Cannot configure Workbench MCP: the following Claude processes are running: ${running.join(', ')}. ` +
        `Close Claude Code completely and re-run from a plain terminal or Codex session.`
      )
    }

    cliStarted = true
    execFileSync(claudeBin, ['mcp', 'add-json', '--scope', 'local', SERVER_NAME, entryJson], {
      encoding: 'utf8',
      cwd: paths.targetProjectRoot,
      env,
      timeout: 15000
    })
    hooks?.afterCliAdd?.()

    if (paths.claudeJsonPath && fs.existsSync(paths.claudeJsonPath)) {
      const currentMode = fs.statSync(paths.claudeJsonPath).mode & 0o777
      if (currentMode !== 0o600) fs.chmodSync(paths.claudeJsonPath, 0o600)
    }

    const status = inspectClaudeRegistration(options)
    if (!status.configured) {
      throw new Error(`Workbench MCP Claude Code registration validation failed: not configured (profile: ${profile}).`)
    }
    if (status.userMatchCount !== 0) {
      throw new Error(`Workbench MCP Claude Code registration validation failed: ${status.userMatchCount} user-scope duplicate(s).`)
    }
    if (status.localMatchCount !== 1) {
      throw new Error(`Workbench MCP Claude Code registration validation failed: expected 1 local entry, found ${status.localMatchCount}.`)
    }
    if (status.claudeJsonMode !== '0600') {
      throw new Error(`Workbench MCP Claude Code registration validation failed: ~/.claude.json mode ${status.claudeJsonMode ?? 'missing'} (expected 0600).`)
    }
    if (status.credentialMode !== '0600') {
      throw new Error(`Workbench MCP Claude Code registration validation failed: credential mode ${status.credentialMode ?? 'missing'} (expected 0600).`)
    }
    return status
  } catch (error) {
    if (!cliStarted) {
      // Definitively pre-mutation: exact rollback is safe
      applyCredentialRollback(credentialExisted, credentialBefore, credentialModeBefore, paths.credentialFile)
      throw error
    }
    // CLI was invoked. Inspect effective state before deciding whether credential can be removed.
    const postDoc = safeReadClaudeJson(paths.claudeJsonPath)
    const localEntry = postDoc ? getLocalMcpServers(postDoc, paths.targetProjectRoot)[SERVER_NAME] : null
    const expectedEntryPresent = !!localEntry && entriesMatch(localEntry, expected)
    const referenced = postDoc !== null && credentialIsReferenced(postDoc, paths.credentialFile)
    if (postDoc === null || expectedEntryPresent || referenced) {
      const reason = postDoc === null ? '~/.claude.json is unreadable'
        : expectedEntryPresent ? 'the expected entry is present'
        : 'an entry references the credential'
      const profileArgs = profile !== 'workbench' ? ` --profile ${profile}` : ''
      const recoveryStatus = `pnpm mcp:claude:status -- --project-root ${posixQuote(paths.targetProjectRoot)}${profileArgs}`
      const recoveryConfigure = `pnpm mcp:claude:configure -- --project-root ${posixQuote(paths.targetProjectRoot)}${profileArgs}`
      const wrapped = new Error(
        `Workbench MCP configuration did not complete cleanly (${reason}). ` +
        `Credential preserved at ${paths.credentialFile}. ` +
        `Check state: ${recoveryStatus} — then re-run if needed: ${recoveryConfigure}. ` +
        `Underlying error: ${(error as Error).message ?? String(error)}`
      )
      ;(wrapped as any).credentialPreserved = true
      ;(wrapped as any).phase = 'post-cli'
      throw wrapped
    }
    // Nothing references our credential — safe to roll back.
    applyCredentialRollback(credentialExisted, credentialBefore, credentialModeBefore, paths.credentialFile)
    throw error
  }
}

export function removeClaude(
  options: ClaudeConfigureOptions,
  hooks?: { afterCliRemove?: () => void }
): ClaudeRegistrationStatus {
  const profile: WorkbenchMcpProfile = options.profile ?? 'workbench'
  const paths = configPaths(options)
  const preDoc = readClaudeJson(paths.claudeJsonPath)
  const userServers = getUserMcpServers(preDoc)
  const localServers = getLocalMcpServers(preDoc, paths.targetProjectRoot)
  const userMatches = Object.entries(userServers).filter(([name, entry]) =>
    isWorkbenchEntry(name, entry, paths.workbenchRepoRoot)
  )
  if (userMatches.length > 0) {
    throw new Error(
      'A Workbench MCP definition exists at user scope in ~/.claude.json. ' +
      'Remove it with `claude mcp remove workbench -s user` before removing the local-scope registration.'
    )
  }
  const localMatches = Object.entries(localServers).filter(([name, entry]) =>
    isWorkbenchEntry(name, entry, paths.workbenchRepoRoot)
  )
  if (localMatches.length > 1 || (localMatches.length === 1 && localMatches[0][0] !== SERVER_NAME)) {
    throw new Error('Duplicate or conflicting Workbench MCP definitions found in local scope.')
  }
  if (localMatches.length === 0) return inspectClaudeRegistration(options)

  const claudeBin = resolveClaudeBin(options)
  const checkProcesses = options.checkProcesses ?? defaultCheckProcesses
  const running = checkProcesses()
  if (running.length > 0) {
    throw new Error(
      `Cannot remove Workbench MCP: the following Claude processes are running: ${running.join(', ')}. ` +
      'Close Claude Code completely and re-run from a plain terminal or Codex session.'
    )
  }

  const env: Record<string, string | undefined> = { ...process.env, HOME: paths.homeDir }
  delete env.CLAUDE_CONFIG_DIR
  let cliStarted = false
  try {
    cliStarted = true
    execFileSync(claudeBin, ['mcp', 'remove', SERVER_NAME, '-s', 'local'], {
      encoding: 'utf8',
      cwd: paths.targetProjectRoot,
      env,
      timeout: 15000
    })
    hooks?.afterCliRemove?.()

    if (fs.existsSync(paths.claudeJsonPath)) {
      const currentMode = fs.statSync(paths.claudeJsonPath).mode & 0o777
      if (currentMode !== 0o600) fs.chmodSync(paths.claudeJsonPath, 0o600)
    }

    const status = inspectClaudeRegistration(options)
    if (status.localMatchCount !== 0 || status.configured) {
      throw new Error(
        `Workbench MCP Claude Code removal validation failed: expected 0 local entries, found ${status.localMatchCount}.`
      )
    }
    if (status.userMatchCount !== 0) {
      throw new Error(
        `Workbench MCP Claude Code removal validation failed: ${status.userMatchCount} user-scope duplicate(s).`
      )
    }
    // The credential file is client-neutral and may still be referenced by Codex or future clients.
    // Claude removal therefore never deletes or rewrites the shared credential.
    return status
  } catch (error) {
    if (!cliStarted) throw error
    const postDoc = safeReadClaudeJson(paths.claudeJsonPath)
    const localEntry = postDoc ? getLocalMcpServers(postDoc, paths.targetProjectRoot)[SERVER_NAME] : null
    const reason = postDoc === null
      ? '~/.claude.json is unreadable'
      : localEntry
        ? 'the local entry remains'
        : 'the local entry may have been removed'
    const profileArgs = profile !== 'workbench' ? ` --profile ${profile}` : ''
    const recoveryStatus = `pnpm mcp:claude:status -- --project-root ${posixQuote(paths.targetProjectRoot)}${profileArgs}`
    const recoveryConfigure = `pnpm mcp:claude:configure -- --project-root ${posixQuote(paths.targetProjectRoot)}${profileArgs}`
    const wrapped = new Error(
      `Workbench MCP removal did not complete cleanly (${reason}). ` +
      `Shared credential preserved at ${paths.credentialFile}. ` +
      `Check state: ${recoveryStatus} — then re-run configuration if needed: ${recoveryConfigure}. ` +
      `Underlying error: ${(error as Error).message ?? String(error)}`
    )
    ;(wrapped as any).credentialPreserved = true
    ;(wrapped as any).phase = 'post-cli'
    throw wrapped
  }
}

function defaultWorkbenchRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, '../../..')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { projectRoot, profile } = parseConfigureCliArgs(process.argv.slice(2))
    const result = configureClaude({
      workbenchRepoRoot: defaultWorkbenchRepoRoot(),
      targetProjectRoot: projectRoot,
      profile
    })
    process.stdout.write(`${JSON.stringify({
      configured: result.configured,
      serverName: result.serverName,
      claudeJsonPath: result.claudeJsonPath,
      scope: result.scope,
      targetProjectRoot: result.targetProjectRoot,
      credentialMode: result.credentialMode,
      duplicateCount: result.duplicateCount,
      userMatchCount: result.userMatchCount,
      localMatchCount: result.localMatchCount,
      profile: result.profile,
      availability: result.availability
    }, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`Workbench MCP Claude Code configuration failed: ${error instanceof Error ? error.message : 'unknown error'}\n`)
    process.exitCode = 1
  }
}
