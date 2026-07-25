#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from 'smol-toml'
import { deriveWorkbenchMcpCredential } from '@workbench/shared/workbench-mcp-auth'
import { loadWorkbenchOwnerConfig } from '@workbench/shared/workbench-owner-config'
import {
  WORKBENCH_MCP_PROFILES,
  WORKBENCH_CREDENTIAL_FILE_NAME,
  WORKBENCH_ENTRYPOINT_SUFFIX,
  BRAIN_PROFILE_ALLOWED_TOOLS,
  BRAIN_PROFILE_ALLOWED_COMMAND_KINDS,
  PROFILE_AVAILABILITY,
  buildWorkbenchMcpServerSpec,
  canonicalProjectRoot,
  canonicalNodeExecutable,
  parseConfigureCliArgs,
  type WorkbenchMcpProfile
} from './configure-core.js'

export {
  WORKBENCH_MCP_PROFILES,
  BRAIN_PROFILE_ALLOWED_TOOLS,
  BRAIN_PROFILE_ALLOWED_COMMAND_KINDS,
  PROFILE_AVAILABILITY,
  parseConfigureCliArgs,
  type WorkbenchMcpProfile
}

const SERVER_NAME = 'workbench'
const TOKEN_FILE_NAME = WORKBENCH_CREDENTIAL_FILE_NAME

type TomlDocument = Record<string, any>

export type ConfigureOptions = {
  workbenchRepoRoot: string
  targetProjectRoot?: string
  codexHome?: string
  homeDir?: string
  now?: Date
  nodeExecutable?: string
  profile?: WorkbenchMcpProfile
}

export type ConfigureHooks = {
  afterCredentialWrite?: () => void
  afterProjectConfigWrite?: () => void
}

export type CodexRegistrationStatus = {
  configured: boolean
  serverName: string
  globalConfigPath: string
  projectConfigPath: string
  credentialFile: string
  configMode?: string
  credentialMode?: string
  command?: string
  args?: string[]
  cwd?: string
  globalConfigUnchanged: boolean
  duplicateCount: number
  globalMatchCount: number
  projectMatchCount: number
  profile: WorkbenchMcpProfile
  availability: 'required' | 'optional'
}

function mode(file: string): string | undefined {
  try {
    return (fs.statSync(file).mode & 0o777).toString(8).padStart(4, '0')
  } catch {
    return undefined
  }
}

function readToml(file: string): TomlDocument {
  const text = fs.readFileSync(file, 'utf8')
  const parsed = parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Invalid TOML object: ${file}`)
  return parsed as TomlDocument
}

function atomicWrite(file: string, content: string, fileMode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.tmp-${process.pid}`
  fs.writeFileSync(temporary, content, { encoding: 'utf8', mode: fileMode })
  fs.chmodSync(temporary, fileMode)
  fs.renameSync(temporary, file)
  fs.chmodSync(file, fileMode)
}

function expectedServer(repoRoot: string, credentialFile: string, nodeExecutable: string, profile: WorkbenchMcpProfile = 'workbench'): TomlDocument {
  const spec = buildWorkbenchMcpServerSpec(repoRoot, credentialFile, nodeExecutable, profile)
  return {
    command: spec.command,
    args: spec.args,
    cwd: spec.cwd,
    enabled: true,
    required: spec.availability === 'required',
    startup_timeout_sec: 10,
    tool_timeout_sec: 30,
    default_tools_approval_mode: 'writes',
    env: spec.env
  }
}

function serverEntries(document: TomlDocument): Array<[string, TomlDocument]> {
  const servers = document.mcp_servers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return []
  return Object.entries(servers).filter((entry): entry is [string, TomlDocument] =>
    !!entry[1] && typeof entry[1] === 'object' && !Array.isArray(entry[1]))
}

function canonicalExistingPath(value: string, label: string): string {
  const resolved = path.resolve(value)
  try {
    const stat = fs.lstatSync(resolved)
    if (stat.isSymbolicLink()) {
      try {
        return fs.realpathSync(resolved)
      } catch {
        throw new Error(`${label} uses an unresolved symlink.`)
      }
    }
    return fs.realpathSync(resolved)
  } catch (error) {
    if (error instanceof Error && error.message.includes('unresolved symlink')) throw error
    return resolved
  }
}

function canonicalDefinitionCwd(definition: TomlDocument): string | undefined {
  if (typeof definition.cwd !== 'string') return undefined
  if (!path.isAbsolute(definition.cwd)) throw new Error('Workbench MCP definition cwd must be absolute.')
  return canonicalExistingPath(definition.cwd, 'Workbench MCP definition cwd')
}

function canonicalDefinitionArg(value: string, definition: TomlDocument): string {
  const pathLike = path.isAbsolute(value) || value.includes('/') || value.includes('\\')
  if (!pathLike || value.startsWith('-')) return value
  const cwd = canonicalDefinitionCwd(definition)
  if (!path.isAbsolute(value) && !cwd) {
    throw new Error('Relative Workbench MCP entrypoints require an absolute cwd.')
  }
  return canonicalExistingPath(path.isAbsolute(value) ? value : path.join(cwd!, value), 'Workbench MCP entrypoint')
}

function canonicalWorkbenchEntrypoint(value: string, definition: TomlDocument): string | undefined {
  const lexical = path.normalize(value)
  const lexicalWorkbench = lexical.endsWith(WORKBENCH_ENTRYPOINT_SUFFIX)
  const pathLike = path.isAbsolute(value) || value.includes('/') || value.includes('\\')
  if (!pathLike || value.startsWith('-')) return undefined
  if (!path.isAbsolute(value) && (typeof definition.cwd !== 'string' || !path.isAbsolute(definition.cwd))) {
    if (lexicalWorkbench) throw new Error('Relative Workbench MCP entrypoints require an absolute cwd.')
    return undefined
  }
  const candidate = path.isAbsolute(value) ? path.resolve(value) : path.resolve(definition.cwd, value)
  const underMcpDist = candidate.includes(`${path.sep}packages${path.sep}mcp${path.sep}dist${path.sep}`)
  try {
    const canonical = canonicalDefinitionArg(value, definition)
    return canonical.endsWith(WORKBENCH_ENTRYPOINT_SUFFIX) ? canonical : undefined
  } catch (error) {
    if (lexicalWorkbench || underMcpDist) throw error
    return undefined
  }
}

function isWorkbenchDefinition(name: string, definition: TomlDocument): boolean {
  const args = Array.isArray(definition.args) ? definition.args.filter((value: unknown): value is string => typeof value === 'string') : []
  if (name === SERVER_NAME) return true
  return args.some(value => canonicalWorkbenchEntrypoint(value, definition) !== undefined)
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${key}:${stable(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function normalizeServerDefinition(definition: TomlDocument): TomlDocument {
  const normalized = { ...definition }
  const cwd = canonicalDefinitionCwd(definition)
  if (cwd) normalized.cwd = cwd
  if (typeof normalized.command === 'string' && path.isAbsolute(normalized.command)) {
    normalized.command = canonicalExistingPath(normalized.command, 'Workbench MCP command')
  }
  if (Array.isArray(normalized.args)) {
    normalized.args = normalized.args.map((value: unknown) => typeof value === 'string'
      ? canonicalDefinitionArg(value, definition)
      : value)
  }
  return normalized
}

function definitionsMatch(actual: TomlDocument, expected: TomlDocument): boolean {
  return stable(normalizeServerDefinition(actual)) === stable(normalizeServerDefinition(expected))
}

function requireSafeProjectRoot(value: string, description: string): string {
  return canonicalProjectRoot(value, description)
}

function requireSafeNodeExecutable(value: string): string {
  return canonicalNodeExecutable(value)
}

function projectConfigPath(targetProjectRoot: string): string {
  const codexDirectory = path.join(targetProjectRoot, '.codex')
  if (fs.existsSync(codexDirectory)) {
    const stat = fs.lstatSync(codexDirectory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Target project .codex directory must be a non-symlink directory.')
    }
  }
  const configPath = path.join(codexDirectory, 'config.toml')
  if (fs.existsSync(configPath)) {
    const stat = fs.lstatSync(configPath)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Target project Codex config must be a regular non-symlink file.')
    }
  }
  return configPath
}

function resolveRoots(options: ConfigureOptions) {
  const workbenchRepoRoot = requireSafeProjectRoot(options.workbenchRepoRoot, 'Workbench repository root')
  const targetProjectRoot = requireSafeProjectRoot(options.targetProjectRoot ?? workbenchRepoRoot, 'Target project root')
  return { workbenchRepoRoot, targetProjectRoot }
}

function configPaths(options: ConfigureOptions) {
  const roots = resolveRoots(options)
  const homeDir = options.homeDir ?? os.userInfo().homedir
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? path.join(homeDir, '.codex')
  return {
    ...roots,
    homeDir,
    codexHome,
    globalConfigPath: path.join(codexHome, 'config.toml'),
    projectConfigPath: projectConfigPath(roots.targetProjectRoot),
    credentialFile: path.join(homeDir, '.buildflow', TOKEN_FILE_NAME),
    backupDir: path.join(homeDir, '.buildflow', 'codex-config-backups'),
    nodeExecutable: requireSafeNodeExecutable(options.nodeExecutable ?? process.execPath)
  }
}

export function inspectCodexRegistration(options: ConfigureOptions): CodexRegistrationStatus {
  const profile: WorkbenchMcpProfile = options.profile ?? 'workbench'
  const paths = configPaths(options)
  const globalDocument = readToml(paths.globalConfigPath)
  const projectDocument = fs.existsSync(paths.projectConfigPath) ? readToml(paths.projectConfigPath) : {}
  const globalDefinitions = serverEntries(globalDocument).filter(([name, value]) => isWorkbenchDefinition(name, value))
  const projectDefinitions = serverEntries(projectDocument).filter(([name, value]) => isWorkbenchDefinition(name, value))
  const definition = projectDefinitions.find(([name]) => name === SERVER_NAME)?.[1]
  const expected = expectedServer(paths.workbenchRepoRoot, paths.credentialFile, paths.nodeExecutable, profile)
  const configured = !!definition && definitionsMatch(definition, expected)
  return {
    configured,
    serverName: SERVER_NAME,
    globalConfigPath: paths.globalConfigPath,
    projectConfigPath: paths.projectConfigPath,
    credentialFile: paths.credentialFile,
    configMode: mode(paths.projectConfigPath),
    credentialMode: mode(paths.credentialFile),
    command: typeof definition?.command === 'string' ? definition.command : undefined,
    args: Array.isArray(definition?.args) ? definition.args : undefined,
    cwd: typeof definition?.cwd === 'string' ? definition.cwd : undefined,
    globalConfigUnchanged: true,
    duplicateCount: globalDefinitions.length + projectDefinitions.length,
    globalMatchCount: globalDefinitions.length,
    projectMatchCount: projectDefinitions.length,
    profile,
    availability: PROFILE_AVAILABILITY[profile]
  }
}

export function configureCodex(options: ConfigureOptions, hooks?: ConfigureHooks): CodexRegistrationStatus & { backupPath: string } {
  const profile: WorkbenchMcpProfile = options.profile ?? 'workbench'
  const paths = configPaths(options)
  if (!fs.existsSync(paths.globalConfigPath)) throw new Error(`Codex global config not found: ${paths.globalConfigPath}`)
  if (mode(paths.globalConfigPath) !== '0600') throw new Error('Codex global config must have mode 0600 before registration.')

  const globalBeforeText = fs.readFileSync(paths.globalConfigPath, 'utf8')
  const globalDocument = readToml(paths.globalConfigPath)
  const globalDefinitions = serverEntries(globalDocument).filter(([name, value]) => isWorkbenchDefinition(name, value))
  if (globalDefinitions.length > 0) throw new Error('A Workbench MCP definition already exists in the global Codex config.')

  const projectConfigExisted = fs.existsSync(paths.projectConfigPath)
  const projectBeforeText = projectConfigExisted ? fs.readFileSync(paths.projectConfigPath, 'utf8') : ''
  const projectModeBefore = projectConfigExisted ? fs.statSync(paths.projectConfigPath).mode & 0o777 : 0o600
  const projectDocument = projectConfigExisted ? readToml(paths.projectConfigPath) : {}
  const projectDefinitions = serverEntries(projectDocument).filter(([name, value]) => isWorkbenchDefinition(name, value))
  if (projectDefinitions.length > 1 || (projectDefinitions.length === 1 && projectDefinitions[0][0] !== SERVER_NAME)) {
    throw new Error('Duplicate or conflicting Workbench MCP definitions found in project config.')
  }

  const expected = expectedServer(paths.workbenchRepoRoot, paths.credentialFile, paths.nodeExecutable, profile)
  if (projectDefinitions.length === 1 && !definitionsMatch(projectDefinitions[0][1], expected)) {
    throw new Error('Existing Workbench MCP definition does not match the repository-supported configuration.')
  }
  const credentialExisted = fs.existsSync(paths.credentialFile)
  const credentialBefore = credentialExisted ? fs.readFileSync(paths.credentialFile) : undefined
  const credentialModeBefore = credentialExisted ? fs.statSync(paths.credentialFile).mode & 0o777 : 0o600
  const bearerValue = deriveWorkbenchMcpCredential(
    loadWorkbenchOwnerConfig({ homeDir: paths.homeDir }).actionToken
  )

  projectDocument.mcp_servers = projectDocument.mcp_servers && typeof projectDocument.mcp_servers === 'object'
    ? projectDocument.mcp_servers
    : {}
  projectDocument.mcp_servers[SERVER_NAME] = expected

  const serialized = stringify(projectDocument)
  parse(serialized)

  const timestamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-')
  const backupPath = path.join(paths.backupDir, `project-config.toml.${timestamp}.workbench-mcp.bak`)
  atomicWrite(backupPath, projectBeforeText, 0o600)
  try {
    atomicWrite(paths.credentialFile, `${bearerValue}\n`, 0o600)
    hooks?.afterCredentialWrite?.()
    atomicWrite(paths.projectConfigPath, serialized, 0o600)
    hooks?.afterProjectConfigWrite?.()

    if (fs.readFileSync(paths.globalConfigPath, 'utf8') !== globalBeforeText) {
      throw new Error('Global Codex config changed unexpectedly.')
    }
    const status = inspectCodexRegistration(options)
    if (!status.configured || status.duplicateCount !== 1 || status.configMode !== '0600' || status.credentialMode !== '0600') {
      throw new Error(`Workbench MCP registration validation failed (profile: ${profile}).`)
    }
    return { ...status, backupPath }
  } catch (error) {
    if (projectConfigExisted) atomicWrite(paths.projectConfigPath, projectBeforeText, projectModeBefore)
    else if (fs.existsSync(paths.projectConfigPath)) fs.unlinkSync(paths.projectConfigPath)
    if (credentialExisted && credentialBefore) atomicWrite(paths.credentialFile, credentialBefore.toString('utf8'), credentialModeBefore)
    else if (fs.existsSync(paths.credentialFile)) fs.unlinkSync(paths.credentialFile)
    throw error
  }
}

export type CodexConfigurePreview = CodexRegistrationStatus & {
  backupPath: string
  changed: boolean
}

export type CodexRemovePreview = CodexRegistrationStatus & {
  backupPath?: string
  changed: boolean
}

export type RemoveHooks = {
  afterProjectConfigWrite?: () => void
}

export function resolveCodexRegistrationPaths(options: ConfigureOptions): ReturnType<typeof configPaths> {
  return configPaths(options)
}

function codexBackupPath(options: ConfigureOptions, backupDir: string): string {
  const timestamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-')
  return path.join(backupDir, `project-config.toml.${timestamp}.workbench-mcp.bak`)
}

export function previewCodexConfiguration(options: ConfigureOptions): CodexConfigurePreview {
  const profile: WorkbenchMcpProfile = options.profile ?? 'workbench'
  const paths = configPaths(options)
  if (!fs.existsSync(paths.globalConfigPath)) throw new Error(`Codex global config not found: ${paths.globalConfigPath}`)
  if (mode(paths.globalConfigPath) !== '0600') throw new Error('Codex global config must have mode 0600 before registration.')

  const globalDocument = readToml(paths.globalConfigPath)
  const globalDefinitions = serverEntries(globalDocument).filter(([name, value]) => isWorkbenchDefinition(name, value))
  if (globalDefinitions.length > 0) throw new Error('A Workbench MCP definition already exists in the global Codex config.')

  const projectConfigExisted = fs.existsSync(paths.projectConfigPath)
  const projectDocument = projectConfigExisted ? readToml(paths.projectConfigPath) : {}
  const projectDefinitions = serverEntries(projectDocument).filter(([name, value]) => isWorkbenchDefinition(name, value))
  if (projectDefinitions.length > 1 || (projectDefinitions.length === 1 && projectDefinitions[0][0] !== SERVER_NAME)) {
    throw new Error('Duplicate or conflicting Workbench MCP definitions found in project config.')
  }
  const expected = expectedServer(paths.workbenchRepoRoot, paths.credentialFile, paths.nodeExecutable, profile)
  if (projectDefinitions.length === 1 && !definitionsMatch(projectDefinitions[0][1], expected)) {
    throw new Error('Existing Workbench MCP definition does not match the repository-supported configuration.')
  }

  deriveWorkbenchMcpCredential(loadWorkbenchOwnerConfig({ homeDir: paths.homeDir }).actionToken)
  projectDocument.mcp_servers = projectDocument.mcp_servers && typeof projectDocument.mcp_servers === 'object'
    ? projectDocument.mcp_servers
    : {}
  projectDocument.mcp_servers[SERVER_NAME] = expected
  parse(stringify(projectDocument))

  const status = inspectCodexRegistration(options)
  return {
    ...status,
    backupPath: codexBackupPath(options, paths.backupDir),
    changed: !status.configured || status.duplicateCount !== 1 || status.configMode !== '0600' || status.credentialMode !== '0600'
  }
}

export function previewCodexRemoval(options: ConfigureOptions): CodexRemovePreview {
  const profile: WorkbenchMcpProfile = options.profile ?? 'workbench'
  const paths = configPaths(options)
  if (!fs.existsSync(paths.globalConfigPath)) throw new Error(`Codex global config not found: ${paths.globalConfigPath}`)
  if (mode(paths.globalConfigPath) !== '0600') throw new Error('Codex global config must have mode 0600 before removal.')

  const globalDocument = readToml(paths.globalConfigPath)
  const globalDefinitions = serverEntries(globalDocument).filter(([name, value]) => isWorkbenchDefinition(name, value))
  if (globalDefinitions.length > 0) throw new Error('A Workbench MCP definition already exists in the global Codex config.')
  if (!fs.existsSync(paths.projectConfigPath)) return { ...inspectCodexRegistration(options), changed: false }

  const projectDocument = readToml(paths.projectConfigPath)
  const projectDefinitions = serverEntries(projectDocument).filter(([name, value]) => isWorkbenchDefinition(name, value))
  if (projectDefinitions.length > 1 || (projectDefinitions.length === 1 && projectDefinitions[0][0] !== SERVER_NAME)) {
    throw new Error('Duplicate or conflicting Workbench MCP definitions found in project config.')
  }
  if (projectDefinitions.length === 0) return { ...inspectCodexRegistration(options), changed: false }

  const expected = expectedServer(paths.workbenchRepoRoot, paths.credentialFile, paths.nodeExecutable, profile)
  if (!definitionsMatch(projectDefinitions[0][1], expected)) {
    throw new Error('Existing Workbench MCP definition does not match the selected profile.')
  }
  return {
    ...inspectCodexRegistration(options),
    backupPath: codexBackupPath(options, paths.backupDir),
    changed: true
  }
}

export function removeCodex(options: ConfigureOptions, hooks?: RemoveHooks): CodexRegistrationStatus & { backupPath?: string } {
  const preview = previewCodexRemoval(options)
  if (!preview.changed) {
    const { changed: _changed, ...status } = preview
    return status
  }

  const paths = configPaths(options)
  const globalBeforeText = fs.readFileSync(paths.globalConfigPath, 'utf8')
  const projectBeforeText = fs.readFileSync(paths.projectConfigPath, 'utf8')
  const projectModeBefore = fs.statSync(paths.projectConfigPath).mode & 0o777
  const projectDocument = readToml(paths.projectConfigPath)
  delete (projectDocument.mcp_servers as Record<string, unknown>)[SERVER_NAME]
  const serialized = stringify(projectDocument)
  parse(serialized)
  const backupPath = preview.backupPath!
  atomicWrite(backupPath, projectBeforeText, 0o600)

  try {
    atomicWrite(paths.projectConfigPath, serialized, 0o600)
    hooks?.afterProjectConfigWrite?.()
    if (fs.readFileSync(paths.globalConfigPath, 'utf8') !== globalBeforeText) {
      throw new Error('Global Codex config changed unexpectedly.')
    }
    const status = inspectCodexRegistration(options)
    if (status.globalMatchCount !== 0 || status.projectMatchCount !== 0 || status.configured) {
      throw new Error('Workbench MCP Codex removal validation failed.')
    }
    if (status.configMode !== '0600') {
      throw new Error(`Workbench MCP Codex removal validation failed: config mode ${status.configMode ?? 'missing'} (expected 0600).`)
    }
    return { ...status, backupPath }
  } catch (error) {
    atomicWrite(paths.projectConfigPath, projectBeforeText, projectModeBefore)
    throw error
  }
}

function defaultWorkbenchRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, '../../..')
}

export function parseProjectRootArgument(argv: string[]): string | undefined {
  const args = argv[0] === '--' ? argv.slice(1) : argv
  if (args.length === 0) return undefined
  if (args.length !== 2 || args[0] !== '--project-root') {
    throw new Error('Usage: --project-root <absolute-path>')
  }
  if (!path.isAbsolute(args[1])) throw new Error('--project-root must be an absolute path.')
  return args[1]
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { projectRoot, profile } = parseConfigureCliArgs(process.argv.slice(2))
    const result = configureCodex({
      workbenchRepoRoot: defaultWorkbenchRepoRoot(),
      targetProjectRoot: projectRoot,
      profile
    })
    process.stdout.write(`${JSON.stringify({
      configured: result.configured,
      serverName: result.serverName,
      configPath: result.projectConfigPath,
      globalConfigPath: result.globalConfigPath,
      backupPath: result.backupPath,
      credentialMode: result.credentialMode,
      globalConfigUnchanged: result.globalConfigUnchanged,
      duplicateCount: result.duplicateCount,
      profile: result.profile
    }, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`Workbench MCP configuration failed: ${error instanceof Error ? error.message : 'unknown error'}\n`)
    process.exitCode = 1
  }
}
