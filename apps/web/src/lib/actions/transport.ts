import { getBackendUrl, getBackendMode } from './config'
import { buildActionErrorEnvelope } from './action-response'

export class ActionTransportError extends Error {
  constructor(message: string, public statusCode: number, public payload?: unknown) {
    super(message)
    this.name = 'ActionTransportError'
  }
}

type FetchResult = {
  response: Response
  text: string
  data: unknown
  readMs: number
  parseMs: number
  responseBytes: number
}

type TransportDiagnostics = {
  endpoint: string
  method: 'GET' | 'POST'
  backendMode: string
  status: number
  totalMs: number
  fetchMs: number
  readMs: number
  parseMs: number
  requestBytes: number
  responseBytes: number
  proxyMs?: number
}

const REQUEST_TIMEOUT_MS = 30000

function isTimeoutError(err: unknown) {
  return err instanceof DOMException && err.name === 'AbortError'
}

function isConnectionError(err: unknown) {
  if (!(err instanceof Error)) return false
  return /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|Failed to fetch|socket hang up|network error/i.test(err.message)
}

async function readJsonResponse(response: Response, endpoint: string): Promise<FetchResult> {
  const readStartedAt = Date.now()
  const text = await response.text()
  const readMs = Date.now() - readStartedAt
  const responseBytes = Buffer.byteLength(text, 'utf8')
  if (!text.trim()) {
    throw new ActionTransportError(
      `Empty response from ${endpoint}`,
      response.status >= 400 ? response.status : 502,
      buildActionErrorEnvelope({
        code: 'EMPTY_RELAY_RESPONSE',
        message: 'BuildFlow returned an empty response.',
        details: `The upstream response for ${endpoint} had no body.`,
        status: 'error'
      })
    )
  }

  let data: unknown
  const parseStartedAt = Date.now()
  try {
    data = JSON.parse(text)
  } catch {
    throw new ActionTransportError(
      `Invalid JSON from ${endpoint}`,
      response.status >= 400 ? response.status : 502,
      buildActionErrorEnvelope({
        code: 'INVALID_RELAY_RESPONSE',
        message: 'BuildFlow returned invalid JSON.',
        details: `The upstream response for ${endpoint} could not be parsed as JSON.`,
        status: 'error'
      })
    )
  }

  return { response, text, data, readMs, parseMs: Date.now() - parseStartedAt, responseBytes }
}

function normalizeTransportFailure(err: unknown, endpoint: string, timeoutMs = REQUEST_TIMEOUT_MS) {
  if (err instanceof ActionTransportError) {
    return err
  }

  if (isTimeoutError(err)) {
    return new ActionTransportError(
      `Timed out waiting for ${endpoint}`,
      504,
      buildActionErrorEnvelope({
        code: 'LOCAL_STACK_TIMEOUT',
        message: 'BuildFlow local stack timed out.',
        details: `The request to ${endpoint} exceeded ${timeoutMs}ms.`,
        recovery: ['Open OrbStack', 'Run pnpm local:restart', 'Run scripts/buildflow-local-stack.sh status'],
        status: 'unavailable'
      })
    )
  }

  if (isConnectionError(err)) {
    return new ActionTransportError(
      `Local stack unavailable for ${endpoint}`,
      503,
      buildActionErrorEnvelope({
        code: 'LOCAL_STACK_UNAVAILABLE',
        message: 'BuildFlow local stack is unavailable.',
        details: 'Docker/OrbStack may be stopped or the relay is not running.',
        recovery: ['Open OrbStack', 'Run pnpm local:restart', 'Run scripts/buildflow-local-stack.sh status'],
        status: 'unavailable'
      })
    )
  }

  return new ActionTransportError(
    'Backend request failed',
    503,
    buildActionErrorEnvelope({
      code: 'ACTION_TRANSPORT_ERROR',
      message: 'Backend request failed.',
      details: err instanceof Error ? err.message : String(err),
      status: 'error'
    })
  )
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function shouldAttachDiagnostics() {
  return process.env.BUILDFLOW_ACTION_DIAGNOSTICS === '1'
}

function attachTransportDiagnostics(data: unknown, diagnostics: TransportDiagnostics): unknown {
  if (!shouldAttachDiagnostics() || !data || typeof data !== 'object' || Array.isArray(data)) return data
  const record = data as Record<string, unknown>
  const existingDiagnostics = record.diagnostics && typeof record.diagnostics === 'object' && !Array.isArray(record.diagnostics)
    ? record.diagnostics as Record<string, unknown>
    : {}
  return {
    ...record,
    diagnostics: {
      ...existingDiagnostics,
      transport: diagnostics
    }
  }
}

function bytesOfJson(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? {}), 'utf8')
}

function proxyMsFrom(response: Response): number | undefined {
  const raw = response.headers.get('x-buildflow-proxy-duration-ms')
  if (!raw) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

// Post request with optional token passthrough
// In relay-agent mode: forwards user token unchanged to bridge for multi-user routing
// In direct-agent mode: no auth token needed (validates at route level)
export async function executeAction(
  endpoint: string,
  body: Record<string, unknown>,
  userToken?: string
): Promise<unknown> {
  const backendUrl = getBackendUrl()
  const mode = getBackendMode()
  const url = `${backendUrl}${endpoint}`
  const totalStartedAt = Date.now()
  const requestBytes = bytesOfJson(body)

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }

    if (mode === 'relay-agent' && userToken) {
      headers['Authorization'] = `Bearer ${userToken}`
    }

    const bodyJson = JSON.stringify(body)
    const fetchStartedAt = Date.now()
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: bodyJson
    })
    const fetchMs = Date.now() - fetchStartedAt

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      let errorData: unknown = {}
      if (errorText.trim()) {
        try {
          errorData = JSON.parse(errorText)
        } catch {
          errorData = { error: errorText }
        }
      }
      const message = typeof (errorData as Record<string, unknown>).error === 'string'
        ? (errorData as Record<string, unknown>).error as string
        : `Action failed: ${response.status}`
      throw new ActionTransportError(message, response.status, errorData)
    }

    const parsed = await readJsonResponse(response, endpoint)
    return attachTransportDiagnostics(parsed.data, {
      endpoint,
      method: 'POST',
      backendMode: mode,
      status: response.status,
      totalMs: Date.now() - totalStartedAt,
      fetchMs,
      readMs: parsed.readMs,
      parseMs: parsed.parseMs,
      requestBytes,
      responseBytes: parsed.responseBytes,
      ...(proxyMsFrom(response) !== undefined ? { proxyMs: proxyMsFrom(response) } : {})
    })
  } catch (err) {
    throw normalizeTransportFailure(err, endpoint)
  }
}

export async function executeActionGET(
  endpoint: string,
  userToken?: string
): Promise<{ data: unknown; status: number }> {
  const mode = getBackendMode()
  const backendUrl = getBackendUrl()
  const totalStartedAt = Date.now()

  // In relay-agent mode: convert to POST through proxy endpoint (cleaner than bridge GET support)
  if (mode === 'relay-agent') {
    // Convert /api/status -> /api/actions/proxy/api/status
    const proxyEndpoint = `/api/actions/proxy${endpoint}`
    const url = `${backendUrl}${proxyEndpoint}`

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }

      if (userToken) {
        headers['Authorization'] = `Bearer ${userToken}`
      }

      const fetchStartedAt = Date.now()
      const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({})
      })
      const fetchMs = Date.now() - fetchStartedAt

      const parsed = await readJsonResponse(response, endpoint)
      const data = attachTransportDiagnostics(parsed.data, {
        endpoint,
        method: 'POST',
        backendMode: mode,
        status: response.status,
        totalMs: Date.now() - totalStartedAt,
        fetchMs,
        readMs: parsed.readMs,
        parseMs: parsed.parseMs,
        requestBytes: bytesOfJson({}),
        responseBytes: parsed.responseBytes,
        ...(proxyMsFrom(response) !== undefined ? { proxyMs: proxyMsFrom(response) } : {})
      })
      return { data, status: response.status }
    } catch (err) {
      throw normalizeTransportFailure(err, endpoint)
    }
  }

  // In direct-agent mode: use GET as normal
  const url = `${backendUrl}${endpoint}`

  try {
    const headers: Record<string, string> = { 'Cache-Control': 'no-store' }

    const fetchStartedAt = Date.now()
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers,
      cache: 'no-store'
    })
    const fetchMs = Date.now() - fetchStartedAt

    const parsed = await readJsonResponse(response, endpoint)
    const data = attachTransportDiagnostics(parsed.data, {
      endpoint,
      method: 'GET',
      backendMode: mode,
      status: response.status,
      totalMs: Date.now() - totalStartedAt,
      fetchMs,
      readMs: parsed.readMs,
      parseMs: parsed.parseMs,
      requestBytes: 0,
      responseBytes: parsed.responseBytes,
      ...(proxyMsFrom(response) !== undefined ? { proxyMs: proxyMsFrom(response) } : {})
    })
    return { data, status: response.status }
  } catch (err) {
    throw normalizeTransportFailure(err, endpoint)
  }
}
