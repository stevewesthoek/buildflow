import {
  RUN_WORKBENCH_DIRECT_COMMAND_KINDS,
  type RunWorkbenchDirectCommandKind
} from '@workbench/shared'
import { WORKBENCH_TOOL_NAMES, type WorkbenchToolName } from './contracts.js'

export const MCP_ALLOWED_TOOLS_ENV = 'WORKBENCH_MCP_ALLOWED_TOOLS'
export const MCP_ALLOWED_COMMAND_KINDS_ENV = 'WORKBENCH_MCP_ALLOWED_COMMAND_KINDS'

export type WorkbenchMcpScope = {
  tools: ReadonlySet<WorkbenchToolName>
  commandKinds: ReadonlySet<RunWorkbenchDirectCommandKind>
}

function parseList(value: string | undefined, defaults: readonly string[]): string[] {
  if (value === undefined) return [...defaults]
  return Array.from(new Set(value.split(',').map(item => item.trim()).filter(Boolean)))
}

function requireKnown<T extends string>(values: string[], known: readonly T[], label: string): T[] {
  const allowed = new Set<string>(known)
  const unknown = values.filter(value => !allowed.has(value))
  if (unknown.length > 0) throw new Error(`${label} contains unknown values: ${unknown.join(', ')}`)
  return values as T[]
}

export function loadWorkbenchMcpScope(env: NodeJS.ProcessEnv = process.env): WorkbenchMcpScope {
  const tools = requireKnown(
    parseList(env[MCP_ALLOWED_TOOLS_ENV], WORKBENCH_TOOL_NAMES),
    WORKBENCH_TOOL_NAMES,
    MCP_ALLOWED_TOOLS_ENV
  )
  const commandKinds = requireKnown(
    parseList(env[MCP_ALLOWED_COMMAND_KINDS_ENV], RUN_WORKBENCH_DIRECT_COMMAND_KINDS),
    RUN_WORKBENCH_DIRECT_COMMAND_KINDS,
    MCP_ALLOWED_COMMAND_KINDS_ENV
  )
  if (!tools.includes('runWorkbenchCommand') && env[MCP_ALLOWED_COMMAND_KINDS_ENV] !== undefined && commandKinds.length > 0) {
    throw new Error(`${MCP_ALLOWED_COMMAND_KINDS_ENV} requires runWorkbenchCommand to be admitted.`)
  }
  return { tools: new Set(tools), commandKinds: new Set(commandKinds) }
}
