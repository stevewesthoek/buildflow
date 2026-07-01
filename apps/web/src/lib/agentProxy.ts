import { NextResponse } from 'next/server'

const DEFAULT_AGENT_URL = 'http://127.0.0.1:3052'
const DEFAULT_TIMEOUT_MS = 30000

// Node 18+ keep-alive agent for connection reuse to localhost
// Uses undici Agent (bundled with Node 18+) loaded dynamically to avoid TS module resolution
let _dispatcher: unknown
let _dispatcherResolved = false
function getDispatcher(): unknown {
  if (!_dispatcherResolved) {
    _dispatcherResolved = true
    try {
      // Dynamic module name avoids static TS resolution
      const moduleName = 'un' + 'dici'
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = (globalThis as unknown as { require?: (m: string) => Record<string, unknown> }).require?.(moduleName)
        ?? (typeof require !== 'undefined' ? (require as (m: string) => Record<string, unknown>)(moduleName) : undefined)
      if (mod?.Agent) {
        const AgentCtor = mod.Agent as new (opts: Record<string, unknown>) => unknown
        _dispatcher = new AgentCtor({
          keepAliveTimeout: 10_000,
          keepAliveMaxTimeout: 30_000,
          connections: 10
        })
      }
    } catch {
      // undici not available; fallback to keepalive: true only
    }
  }
  return _dispatcher
}

type AgentProxyOptions = RequestInit & {
  timeoutMs?: number
}

export type AgentErrorPayload = {
  status: 'error' | 'timeout'
  code: 'AGENT_UNAVAILABLE' | 'AGENT_ERROR' | 'AGENT_TIMEOUT'
  error: string
  message: string
  userMessage: string
  detail?: string
  retryable: boolean
  connected?: boolean
}

const getAgentBaseUrl = () => (process.env.LOCAL_AGENT_URL || DEFAULT_AGENT_URL).replace(/\/$/, '')

const toErrorDetail = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err))

const unavailablePayload = (err: unknown): AgentErrorPayload => ({
  status: 'error',
  code: 'AGENT_UNAVAILABLE',
  error: 'BuildFlow agent is unavailable',
  message: 'BuildFlow agent is unavailable',
  userMessage: 'BuildFlow could not reach the local agent. Check that buildflow serve is running, then retry.',
  detail: toErrorDetail(err),
  retryable: true
})

const upstreamErrorPayload = (status: number, data: Record<string, unknown>): AgentErrorPayload & Record<string, unknown> => ({
  status: 'error',
  code: 'AGENT_ERROR',
  error: typeof data.error === 'string' ? data.error : `BuildFlow agent returned ${status}`,
  message:
    typeof data.message === 'string'
      ? data.message
      : typeof data.error === 'string'
        ? data.error
        : `BuildFlow agent returned ${status}`,
  userMessage: typeof data.userMessage === 'string' ? data.userMessage : 'BuildFlow agent returned an error for this source action.',
  detail: typeof data.detail === 'string' ? data.detail : typeof data.details === 'string' ? data.details : undefined,
  retryable: status >= 500,
  upstreamStatus: status,
  ...data
})

export async function fetchAgentJson(pathname: string, options: AgentProxyOptions = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  try {
    const dispatcher = getDispatcher()
    const fetchOptions: Record<string, unknown> = {
      cache: 'no-store',
      ...options,
      signal: controller.signal,
      keepalive: true
    }
    if (dispatcher) {
      fetchOptions.dispatcher = dispatcher
    }
    const response = await fetch(`${getAgentBaseUrl()}${pathname}`, fetchOptions as RequestInit)
    const data = (await response.json().catch(async () => ({ error: await response.text().catch(() => '') }))) as Record<string, unknown>
    return { response, data }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return {
        response: null,
        data: {
          status: 'timeout',
          code: 'AGENT_TIMEOUT',
          error: 'BuildFlow agent request timed out',
          message: 'BuildFlow agent request timed out',
          userMessage: 'The local agent is reachable but did not finish this request before the timeout.',
          detail: toErrorDetail(err),
          retryable: true,
          connected: true
        } satisfies AgentErrorPayload
      }
    }
    return { response: null, data: unavailablePayload(err) }
  } finally {
    clearTimeout(timeout)
  }
}

export function jsonFromAgentResult(result: Awaited<ReturnType<typeof fetchAgentJson>>) {
  if (!result.response) {
    return NextResponse.json(result.data, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  }

  if (!result.response.ok) {
    return NextResponse.json(upstreamErrorPayload(result.response.status, result.data), {
      status: result.response.status,
      headers: { 'Cache-Control': 'no-store' }
    })
  }

  return NextResponse.json(result.data, { status: result.response.status, headers: { 'Cache-Control': 'no-store' } })
}

export async function proxyAgentJson(pathname: string, options: AgentProxyOptions = {}) {
  return jsonFromAgentResult(await fetchAgentJson(pathname, options))
}
