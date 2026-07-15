import { NextRequest, NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { verifyWorkbenchMcpCredential } from '@workbench/shared/workbench-mcp-auth'
import { logRequest } from '@workbench/bridge/request-audit'
import { getActionToken, getBackendMode } from './actions/config'

export interface AuthResult {
  valid: boolean
  error?: NextResponse
  bearerToken?: string
  principal?: string
}

export const WORKBENCH_MCP_ACTION_ROUTES = new Set([
  'GET /api/actions/status',
  'POST /api/actions/read-context',
  'POST /api/actions/apply-file-change',
  'POST /api/actions/commit-changes',
  'POST /api/actions/run-command'
])

function auditMcpRequest(request: NextRequest): boolean {
  const now = new Date().toISOString()
  return logRequest({
    requestId: `mcp_${crypto.randomUUID()}`,
    deviceId: 'codex-workbench-mcp',
    command: `action:${request.method}:${request.nextUrl.pathname}`,
    status: 'success',
    createdAt: now,
    completedAt: now,
    duration: 0,
    version: 1
  })
}

// Token authentication with mode-aware behavior:
// - relay-agent mode: pass-through user tokens (forward to bridge unchanged)
// - direct-agent mode: validate against WORKBENCH_ACTION_TOKEN, with BUILDFLOW_ACTION_TOKEN fallback
export function checkActionAuth(request: NextRequest): AuthResult {
  const mode = getBackendMode()
  const authHeader = request.headers.get('authorization')
  const actionCredential = getActionToken()
  const candidate = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : ''
  const isMcpCredential = !!candidate && !!actionCredential && verifyWorkbenchMcpCredential(candidate, actionCredential)

  // The local MCP bridge is intentionally direct-agent only. Never forward its
  // installation credential through the relay as an end-user bearer token.
  if (mode === 'relay-agent' && isMcpCredential) {
    return {
      valid: false,
      error: NextResponse.json({ error: 'Workbench MCP is unavailable in relay-agent mode' }, { status: 403 })
    }
  }

  // Relay-agent mode: accept any valid Authorization header and forward it
  if (mode === 'relay-agent') {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return {
        valid: false,
        error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }
    }
    const bearerValue = authHeader.slice(7)
    return { valid: true, bearerToken: bearerValue }
  }

  // Direct-agent mode: prefer WORKBENCH_ACTION_TOKEN and retain the legacy fallback.
  if (!actionCredential) {
    return {
      valid: false,
      error: NextResponse.json(
        { error: 'Server configuration error: WORKBENCH_ACTION_TOKEN not set' },
        { status: 500 }
      )
    }
  }

  const expectedBearer = `Bearer ${actionCredential}`
  if (!authHeader || (authHeader !== expectedBearer && !isMcpCredential)) {
    return {
      valid: false,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  if (isMcpCredential) {
    const routeIdentity = `${request.method.toUpperCase()} ${request.nextUrl.pathname}`
    if (!WORKBENCH_MCP_ACTION_ROUTES.has(routeIdentity)) {
      return {
        valid: false,
        error: NextResponse.json({ error: 'Workbench MCP action is not admitted' }, { status: 403 })
      }
    }
    if (!auditMcpRequest(request)) {
      return {
        valid: false,
        error: NextResponse.json({ error: 'Workbench action audit unavailable' }, { status: 503 })
      }
    }
    return { valid: true, principal: 'codex-workbench-mcp' }
  }

  return { valid: true }
}
