import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js'
import { createWorkbenchClient, MAX_ACTION_REQUEST_BYTES, type BridgeResult } from './client.js'
import {
  WORKBENCH_TOOL_NAMES,
  buildRunWorkbenchCommandDiscoverySchema,
  loadWorkbenchToolContracts,
  validateToolInput,
  type WorkbenchToolContract,
  type WorkbenchToolName
} from './contracts.js'
import { loadWorkbenchMcpScope, type WorkbenchMcpScope } from './scope.js'

type InvokeWorkbench = (contract: WorkbenchToolContract, input: Record<string, unknown>, signal?: AbortSignal) => Promise<BridgeResult>

function toolResponse(result: BridgeResult) {
  const payload = result.ok ? result.result : result
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    structuredContent: payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : { result: payload },
    isError: !result.ok
  }
}

export function createWorkbenchMcpServer(params: { repoRoot: string; invoke?: InvokeWorkbench; scope?: WorkbenchMcpScope; contextIntelligenceSessionId?: string }) {
  const contracts = loadWorkbenchToolContracts(params.repoRoot)
  const invoke = params.invoke ?? createWorkbenchClient()
  const scope = params.scope ?? loadWorkbenchMcpScope()
  const runWorkbenchCommandAdmitted = scope.tools.has('runWorkbenchCommand') && scope.commandKinds.size > 0
  const admittedToolNames = WORKBENCH_TOOL_NAMES.filter(name =>
    scope.tools.has(name) && (name !== 'runWorkbenchCommand' || runWorkbenchCommandAdmitted)
  )
  const admittedToolNameSet = new Set<WorkbenchToolName>(admittedToolNames)
  const runWorkbenchCommandDiscoverySchema = runWorkbenchCommandAdmitted
    ? buildRunWorkbenchCommandDiscoverySchema(scope.commandKinds)
    : undefined
  const server = new Server({ name: 'workbench', version: '1.3.12-beta' }, {
    capabilities: { tools: {} },
    instructions: 'Use only the admitted bounded Workbench actions. Workbench remains authoritative for source selection, policy, confirmation, grants, dispatch, audit, and execution. Never retry mutation-capable calls after ambiguous transport results.'
  })

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: admittedToolNames.map(name => {
      const contract = contracts.get(name)!
      return {
        name,
        title: contract.title,
        description: contract.description,
        inputSchema: (name === 'runWorkbenchCommand'
          ? runWorkbenchCommandDiscoverySchema
          : contract.inputSchema) as { type: 'object'; [key: string]: unknown },
        annotations: {
          readOnlyHint: !contract.mutationCapable,
          destructiveHint: contract.mutationCapable,
          idempotentHint: !contract.mutationCapable,
          openWorldHint: false
        }
      }
    })
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name as WorkbenchToolName
    const contract = contracts.get(name)
    if (!contract || !admittedToolNameSet.has(name)) throw new McpError(ErrorCode.MethodNotFound, 'Unknown or unadmitted Workbench MCP tool.')
    if (Buffer.byteLength(JSON.stringify(request.params.arguments ?? {}), 'utf8') > MAX_ACTION_REQUEST_BYTES) {
      return toolResponse({
        ok: false,
        code: 'invalid_mcp_request',
        message: 'Workbench MCP request exceeded the allowed size.'
      })
    }
    const rawInput = request.params.arguments ?? {}
    if (contract.name === 'runWorkbenchCommand') {
      const command = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
        ? (rawInput as Record<string, unknown>).command
        : undefined
      const commandKind = command && typeof command === 'object' && !Array.isArray(command)
        ? (command as Record<string, unknown>).commandKind
        : undefined
      if (typeof commandKind === 'string' && !scope.commandKinds.has(commandKind as never)) {
        return toolResponse({
          ok: false,
          code: 'mcp_scope_denied',
          message: 'Workbench MCP command kind is outside the admitted scope.'
        })
      }
    }
    const parsed = validateToolInput(contract, rawInput)
    if (!parsed.ok) {
      return toolResponse({
        ok: false,
        code: 'invalid_mcp_request',
        message: 'Workbench MCP input failed strict validation.',
        details: parsed.issues
      })
    }
    if (contract.name === 'runWorkbenchCommand') {
      const command = parsed.value.command
      const commandKind = command && typeof command === 'object' && !Array.isArray(command)
        ? (command as Record<string, unknown>).commandKind
        : undefined
      if (typeof commandKind !== 'string' || !scope.commandKinds.has(commandKind as never)) {
        return toolResponse({
          ok: false,
          code: 'mcp_scope_denied',
          message: 'Workbench MCP command kind is outside the admitted scope.'
        })
      }
    }
    const invokeInput = params.contextIntelligenceSessionId
      ? { ...parsed.value, contextIntelligenceSessionId: params.contextIntelligenceSessionId }
      : parsed.value
    return toolResponse(await invoke(contract, invokeInput, extra.signal))
  })

  return server
}
