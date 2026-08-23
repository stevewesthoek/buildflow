import fs from 'node:fs'
import path from 'node:path'

export const WORKBENCH_MCP_PROFILES = ['workbench', 'brain'] as const
export type WorkbenchMcpProfile = typeof WORKBENCH_MCP_PROFILES[number]

// Node.js contract: exactly major 20, minimum 20.20.2
export const REQUIRED_NODE_MAJOR = 20
export const REQUIRED_NODE_MINOR = 20
export const REQUIRED_NODE_PATCH = 2

export function validateNodeContract(version = process.version): { valid: boolean; reason?: string } {
  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)$/)
  if (!match) return { valid: false, reason: `Could not parse Node.js version: ${version}` }

  const [, major, minor, patch] = match.map(v => parseInt(v, 10))

  if (major !== REQUIRED_NODE_MAJOR) {
    return {
      valid: false,
      reason: `Node.js major version ${major} is not supported; required ${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR}.${REQUIRED_NODE_PATCH}+`
    }
  }

  if (minor < REQUIRED_NODE_MINOR || (minor === REQUIRED_NODE_MINOR && patch < REQUIRED_NODE_PATCH)) {
    return {
      valid: false,
      reason: `Node.js ${process.version} is below required ${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR}.${REQUIRED_NODE_PATCH}`
    }
  }

  return { valid: true }
}

export const BRAIN_PROFILE_ALLOWED_TOOLS = 'getWorkbenchStatus,readWorkbenchContext,runWorkbenchCommand'
export const BRAIN_PROFILE_ALLOWED_COMMAND_KINDS = 'n8n_workflow_migration'

// The brain profile is optional so a transient Workbench outage cannot prevent Brain sessions
// from starting. Guarded migration operations remain fail-closed at call time via scope enforcement.
export const PROFILE_AVAILABILITY: Record<WorkbenchMcpProfile, 'required' | 'optional'> = {
  workbench: 'required',
  brain: 'optional'
}

// Historical name preserved for backward compatibility; the credential file is client-neutral.
// Both Codex and Claude Code configurations point to this same derived credential file.
export const WORKBENCH_CREDENTIAL_FILE_NAME = 'codex-workbench-mcp.token'

export const WORKBENCH_ENTRYPOINT_SUFFIX = path.join('packages', 'mcp', 'dist', 'server.js')

export function canonicalProjectRoot(value: string, description: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${description} must be an absolute path.`)
  let real: string
  try {
    real = fs.realpathSync(value)
  } catch {
    throw new Error(`${description} does not exist: ${value}`)
  }
  const stat = fs.statSync(real)
  if (!stat.isDirectory()) throw new Error(`${description} must be a directory: ${real}`)
  return real
}

export function canonicalNodeExecutable(value: string): string {
  if (!path.isAbsolute(value)) throw new Error('Node executable must be an absolute path.')
  const real = fs.realpathSync(value)
  const stat = fs.statSync(real)
  if (!stat.isFile() || (stat.mode & 0o111) === 0) throw new Error('Node executable must be an executable regular file.')
  return real
}

export type WorkbenchMcpServerSpec = {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  profile: WorkbenchMcpProfile
  availability: 'required' | 'optional'
}

export function buildWorkbenchMcpServerSpec(
  repoRoot: string,
  credentialFile: string,
  nodeExecutable: string,
  profile: WorkbenchMcpProfile = 'workbench'
): WorkbenchMcpServerSpec {
  const env: Record<string, string> = { WORKBENCH_MCP_CREDENTIAL_FILE: credentialFile }
  if (profile === 'brain') {
    env.WORKBENCH_MCP_ALLOWED_TOOLS = BRAIN_PROFILE_ALLOWED_TOOLS
    env.WORKBENCH_MCP_ALLOWED_COMMAND_KINDS = BRAIN_PROFILE_ALLOWED_COMMAND_KINDS
  }
  return {
    command: nodeExecutable,
    args: [path.join(repoRoot, WORKBENCH_ENTRYPOINT_SUFFIX)],
    cwd: repoRoot,
    env,
    profile,
    availability: PROFILE_AVAILABILITY[profile]
  }
}

export function parseConfigureCliArgs(argv: string[]): { projectRoot?: string; profile?: WorkbenchMcpProfile } {
  const args = argv[0] === '--' ? argv.slice(1) : argv
  const result: { projectRoot?: string; profile?: WorkbenchMcpProfile } = {}
  let i = 0
  while (i < args.length) {
    if (args[i] === '--project-root' && i + 1 < args.length) {
      const value = args[i + 1]
      if (!path.isAbsolute(value)) throw new Error('--project-root must be an absolute path.')
      result.projectRoot = value
      i += 2
    } else if (args[i] === '--profile' && i + 1 < args.length) {
      const value = args[i + 1]
      if (!(WORKBENCH_MCP_PROFILES as readonly string[]).includes(value)) {
        throw new Error(`--profile must be one of: ${WORKBENCH_MCP_PROFILES.join(', ')}`)
      }
      result.profile = value as WorkbenchMcpProfile
      i += 2
    } else {
      throw new Error(`Unknown argument: ${args[i]}. Usage: [--project-root <absolute-path>] [--profile ${WORKBENCH_MCP_PROFILES.join('|')}]`)
    }
  }
  return result
}
