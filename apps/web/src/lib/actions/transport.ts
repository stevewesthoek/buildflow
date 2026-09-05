import { getBackendUrl, getBackendMode } from './config'
import { buildActionErrorEnvelope, type ActionDiagnostics } from './action-response'
import { getActionDiagnostics } from '../env-compat'

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

import { GPT_ACTION_RESPONSE_BYTE_LIMIT, GPT_ACTION_RESPONSE_CHAR_LIMIT } from './payload-budget'

const REQUEST_TIMEOUT_MS = 12000
const DEFAULT_RESPONSE_SIZE_LIMIT_BYTES = GPT_ACTION_RESPONSE_BYTE_LIMIT

export type ActionTransportOptions = {
  timeoutMs?: number
  signal?: AbortSignal
  requestId?: string
  diagnostics?: ActionDiagnostics
  maxResponseBytes?: number
}

function isTimeoutError(err: unknown) {
  return err instanceof Error && err.name === 'AbortError'
}

function isConnectionError(err: unknown) {
  if (!(err instanceof Error)) return false
  return /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|Failed to fetch|socket hang up|network error/i.test(err.message)
}

async function readJsonResponse(response: Response, endpoint: string, maxResponseBytes = DEFAULT_RESPONSE_SIZE_LIMIT_BYTES): Promise<FetchResult> {
  const readStartedAt = Date.now()
  const text = await readResponseText(response, endpoint, maxResponseBytes)
  const readMs = Date.now() - readStartedAt
  const responseBytes = Buffer.byteLength(text, 'utf8')

  if (responseBytes > maxResponseBytes) {
    throw new ActionTransportError(
      `Response too large from ${endpoint}`,
      413,
      buildActionErrorEnvelope({
        code: 'RESPONSE_SIZE_EXCEEDED',
        message: 'Workbench response exceeded size limit.',
        details: `Response was ${responseBytes} bytes, limit is ${maxResponseBytes} bytes.`,
        recovery: ['Use a narrower read mode', 'Reduce file count or size', 'Use grep_context instead of read_paths for large files'],
        status: 'error'
      })
    )
  }

  if (!text.trim()) {
    throw new ActionTransportError(
      `Empty response from ${endpoint}`,
      response.status >= 400 ? response.status : 502,
      buildActionErrorEnvelope({
        code: 'EMPTY_RELAY_RESPONSE',
        message: 'Workbench returned an empty response.',
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
        message: 'Workbench returned invalid JSON.',
        details: `The upstream response for ${endpoint} could not be parsed as JSON.`,
        status: 'error'
      })
    )
  }

  return { response, text, data, readMs, parseMs: Date.now() - parseStartedAt, responseBytes }
}

async function readResponseText(response: Response, endpoint: string, maxResponseBytes = DEFAULT_RESPONSE_SIZE_LIMIT_BYTES): Promise<string> {
  if (!response.body) {
    const text = await response.text()
    if (text.length > GPT_ACTION_RESPONSE_CHAR_LIMIT || Buffer.byteLength(text, 'utf8') > maxResponseBytes) {
      throw new ActionTransportError(
        `Response too large from ${endpoint}`,
        413,
        buildActionErrorEnvelope({
          code: 'RESPONSE_SIZE_EXCEEDED',
          message: 'Workbench response exceeded size limit.',
          details: `Response from ${endpoint} exceeded ${GPT_ACTION_RESPONSE_CHAR_LIMIT} characters or ${maxResponseBytes} bytes.`,
          recovery: ['Use a narrower read mode', 'Reduce file count or size', 'Use grep_context instead of broad reads'],
          status: 'needs_narrower_scope'
        })
      )
    }
    return text
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let responseBytes = 0
  let responseChars = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      responseBytes += value.byteLength
      const chunk = decoder.decode(value, { stream: true })
      responseChars += chunk.length
      if (responseBytes > maxResponseBytes || responseChars > GPT_ACTION_RESPONSE_CHAR_LIMIT) {
        await reader.cancel().catch(() => undefined)
        throw new ActionTransportError(
          `Response too large from ${endpoint}`,
          413,
          buildActionErrorEnvelope({
            code: 'RESPONSE_SIZE_EXCEEDED',
            message: 'Workbench response exceeded size limit.',
            details: `Response exceeded ${GPT_ACTION_RESPONSE_CHAR_LIMIT} characters or ${maxResponseBytes} bytes while reading.`,
            recovery: ['Use a narrower read mode', 'Reduce file count or size', 'Use grep_context instead of broad reads'],
            status: 'needs_narrower_scope'
          })
        )
      }
      chunks.push(chunk)
    }
    const finalChunk = decoder.decode()
    responseChars += finalChunk.length
    if (responseBytes > maxResponseBytes || responseChars > GPT_ACTION_RESPONSE_CHAR_LIMIT) {
      throw new ActionTransportError(
        `Response too large from ${endpoint}`,
        413,
        buildActionErrorEnvelope({
          code: 'RESPONSE_SIZE_EXCEEDED',
          message: 'Workbench response exceeded size limit.',
          details: `Response exceeded ${GPT_ACTION_RESPONSE_CHAR_LIMIT} characters or ${maxResponseBytes} bytes while reading.`,
          recovery: ['Use a narrower read mode', 'Reduce file count or size', 'Use grep_context instead of broad reads'],
          status: 'needs_narrower_scope'
        })
      )
    }
    chunks.push(finalChunk)
    return chunks.join('')
  } finally {
    reader.releaseLock()
  }
}

function compactDiagnostics(input: ActionDiagnostics): ActionDiagnostics {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== null)) as ActionDiagnostics
}

function normalizeTransportFailure(err: unknown, endpoint: string, options: { timeoutMs: number; startedAt: number; diagnostics?: ActionDiagnostics }) {
  if (err instanceof ActionTransportError) {
    return err
  }

  const diagnostics = compactDiagnostics({
    ...(options.diagnostics || {}),
    endpoint,
    elapsedMs: Date.now() - options.startedAt,
    deadlineMs: options.timeoutMs,
    responseBytes: 0
  })

  if (isTimeoutError(err)) {
    return new ActionTransportError(
      `Timed out waiting for ${endpoint}`,
      200,
      buildActionErrorEnvelope({
        code: 'LOCAL_STACK_TIMEOUT',
        message: 'Workbench local stack timed out.',
        details: `The request to ${endpoint} exceeded ${options.timeoutMs}ms.`,
        recovery: ['Retry the exact bounded read.', 'Use grep_context or read_range if the request remains slow.', 'Run pnpm local:verify only if health checks also fail.'],
        status: 'timeout',
        connected: true,
        diagnostics
      })
    )
  }

  if (isConnectionError(err)) {
    return new ActionTransportError(
      `Local stack unavailable for ${endpoint}`,
      200,
      buildActionErrorEnvelope({
        code: 'LOCAL_STACK_UNAVAILABLE',
        message: 'Workbench local stack is unavailable.',
        details: 'Docker/OrbStack may be stopped or the relay is not running.',
        recovery: ['Open OrbStack', 'Run pnpm local:restart', 'Run scripts/buildflow-local-stack.sh status'],
        status: 'unavailable',
        diagnostics
      })
    )
  }

  return new ActionTransportError(
    'Backend request failed',
    200,
    buildActionErrorEnvelope({
      code: 'ACTION_TRANSPORT_ERROR',
      message: 'Backend request failed.',
      details: err instanceof Error ? err.message : String(err),
      status: 'error',
      diagnostics
    })
  )
}

export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS, options: { signal?: AbortSignal } = {}) {
  const controller = new AbortController()
  const parentSignals = [options.signal, init.signal].filter((signal): signal is AbortSignal => Boolean(signal))
  const abortFromParent = () => controller.abort()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    for (const signal of parentSignals) {
      if (signal.aborted) {
        controller.abort()
        break
      }
      signal.addEventListener('abort', abortFromParent, { once: true })
    }
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
    for (const signal of parentSignals) {
      signal.removeEventListener('abort', abortFromParent)
    }
  }
}

function shouldAttachDiagnostics() {
  return getActionDiagnostics()
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
  userToken?: string,
  options: ActionTransportOptions = {}
): Promise<unknown> {
  const backendUrl = getBackendUrl()
  const mode = getBackendMode()
  const url = `${backendUrl}${endpoint}`
  const totalStartedAt = Date.now()
  const requestBytes = bytesOfJson(body)
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (options.requestId) headers['X-Workbench-Request-Id'] = options.requestId

    if (mode === 'relay-agent' && userToken) {
      headers['Authorization'] = `Bearer ${userToken}`
    }

    const bodyJson = JSON.stringify(body)
    const fetchStartedAt = Date.now()
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: bodyJson
    }, timeoutMs, { signal: options.signal })
    const fetchMs = Date.now() - fetchStartedAt

    if (!response.ok) {
      const errorText = await readResponseText(response, endpoint, options.maxResponseBytes ?? DEFAULT_RESPONSE_SIZE_LIMIT_BYTES).catch(() => '')
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
      const payload = errorData && typeof errorData === 'object' && !Array.isArray(errorData)
        ? {
            ...(errorData as Record<string, unknown>),
            diagnostics: compactDiagnostics({
              ...(options.diagnostics || {}),
              ...(((errorData as Record<string, unknown>).diagnostics && typeof (errorData as Record<string, unknown>).diagnostics === 'object')
                ? (errorData as Record<string, unknown>).diagnostics as Record<string, unknown>
                : {}),
              endpoint,
              elapsedMs: Date.now() - totalStartedAt,
              responseBytes: Buffer.byteLength(errorText, 'utf8')
            })
          }
        : errorData
      throw new ActionTransportError(message, response.status, payload)
    }

    const parsed = await readJsonResponse(response, endpoint, options.maxResponseBytes ?? DEFAULT_RESPONSE_SIZE_LIMIT_BYTES)
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
    throw normalizeTransportFailure(err, endpoint, { timeoutMs, startedAt: totalStartedAt, diagnostics: options.diagnostics })
  }
}

export async function executeActionGET(
  endpoint: string,
  userToken?: string,
  options: ActionTransportOptions = {}
): Promise<{ data: unknown; status: number }> {
  const mode = getBackendMode()
  const backendUrl = getBackendUrl()
  const totalStartedAt = Date.now()
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS

  // In relay-agent mode: convert to POST through proxy endpoint (cleaner than bridge GET support)
  if (mode === 'relay-agent') {
    // getBackendUrl() already includes the relay proxy prefix in relay-agent mode.
    // Keep this as /api/actions/proxy + /api/status, not a double-prefixed proxy path.
    const url = `${backendUrl}${endpoint}`

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (options.requestId) headers['X-Workbench-Request-Id'] = options.requestId

      if (userToken) {
        headers['Authorization'] = `Bearer ${userToken}`
      }

      const fetchStartedAt = Date.now()
      const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({})
      }, timeoutMs, { signal: options.signal })
      const fetchMs = Date.now() - fetchStartedAt

      const parsed = await readJsonResponse(response, endpoint, options.maxResponseBytes ?? DEFAULT_RESPONSE_SIZE_LIMIT_BYTES)
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
      throw normalizeTransportFailure(err, endpoint, { timeoutMs, startedAt: totalStartedAt, diagnostics: options.diagnostics })
    }
  }

  // In direct-agent mode: use GET as normal
  const url = `${backendUrl}${endpoint}`

  try {
    const headers: Record<string, string> = { 'Cache-Control': 'no-store' }
    if (options.requestId) headers['X-Workbench-Request-Id'] = options.requestId

    const fetchStartedAt = Date.now()
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers,
      cache: 'no-store'
    }, timeoutMs, { signal: options.signal })
    const fetchMs = Date.now() - fetchStartedAt

    const parsed = await readJsonResponse(response, endpoint, options.maxResponseBytes ?? DEFAULT_RESPONSE_SIZE_LIMIT_BYTES)
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
    throw normalizeTransportFailure(err, endpoint, { timeoutMs, startedAt: totalStartedAt, diagnostics: options.diagnostics })
  }
}
