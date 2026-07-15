import crypto from 'node:crypto'

const WORKBENCH_MCP_CREDENTIAL_CONTEXT = 'workbench-mcp:codex:v1'
const WORKBENCH_MCP_CREDENTIAL_PREFIX = 'wbmcp_v1_'

export function deriveWorkbenchMcpCredential(actionToken: string): string {
  if (actionToken.length < 16 || actionToken.length > 4096 || /[\r\n\0]/.test(actionToken)) {
    throw new Error('A valid Workbench action credential is required.')
  }
  const digest = crypto.createHmac('sha256', actionToken)
    .update(WORKBENCH_MCP_CREDENTIAL_CONTEXT)
    .digest('hex')
  return `${WORKBENCH_MCP_CREDENTIAL_PREFIX}${digest}`
}

export function verifyWorkbenchMcpCredential(candidate: string, actionToken: string): boolean {
  try {
    const expected = deriveWorkbenchMcpCredential(actionToken)
    const candidateBuffer = Buffer.from(candidate)
    const expectedBuffer = Buffer.from(expected)
    return candidateBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(candidateBuffer, expectedBuffer)
  } catch {
    return false
  }
}
