import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { WorkbenchToolContract } from './contracts.js'

export const WORKBENCH_MCP_CREDENTIAL_FILE = path.join(os.homedir(), '.buildflow', 'codex-workbench-mcp.token')
export const WORKBENCH_ACTION_BASE_URL = 'http://127.0.0.1:3054'
export const MAX_ACTION_REQUEST_BYTES = 64 * 1024
export const MAX_ACTION_RESPONSE_BYTES = 64 * 1024
export const CONNECTION_TIMEOUT_MS = 2_000
export const TOTAL_TIMEOUT_MS = 15_000

export type BridgeErrorCode =
  | 'invalid_mcp_request'
  | 'mcp_scope_denied'
  | 'authentication_required'
  | 'authentication_failed'
  | 'workbench_unavailable'
  | 'workbench_timeout'
  | 'ambiguous_transport'
  | 'action_unavailable'
  | 'workbench_rejected'
  | 'bridge_internal_error'

export type BridgeResult =
  | { ok: true; result: unknown }
  | { ok: false; code: BridgeErrorCode; message: string; ambiguous?: boolean; details?: unknown }

export type WorkbenchClientOptions = {
  baseUrl?: string
  credentialFile?: string
  connectionTimeoutMs?: number
  totalTimeoutMs?: number
  maxRequestBytes?: number
  maxResponseBytes?: number
  lookup?: http.RequestOptions['lookup']
}

const PRIVATE_OUTPUT_KEYS = new Set([
  'authorization',
  'authorizationdigest',
  'confirmationhash',
  'credentials',
  'dispatchauthorization',
  'environment',
  'env',
  'headers',
  'leaseproof',
  'operationrecord',
  'rawworkflow',
  'stack'
])

function normalizedPrivateKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function sanitizeString(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|ghp|xox[baprs])-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
}

export function sanitizeWorkbenchValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[TRUNCATED]'
  if (typeof value === 'string') return sanitizeString(value)
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.slice(0, 200).map(item => sanitizeWorkbenchValue(item, depth + 1))
  if (!value || typeof value !== 'object') return undefined
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (PRIVATE_OUTPUT_KEYS.has(normalizedPrivateKey(key)) || key.startsWith('_')) continue
    const safe = sanitizeWorkbenchValue(item, depth + 1)
    if (safe !== undefined) result[key] = safe
  }
  return result
}

export function readActionCredential(credentialFile = WORKBENCH_MCP_CREDENTIAL_FILE): string {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(credentialFile)
  } catch {
    throw new Error('authentication_required')
  }
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
      (expectedUid !== undefined && stat.uid !== expectedUid)) {
    throw new Error('authentication_required')
  }
  const bearerValue = fs.readFileSync(credentialFile, 'utf8').trim()
  if (bearerValue.length < 16 || bearerValue.length > 4096 || /[\r\n\0]/.test(bearerValue)) throw new Error('authentication_required')
  return bearerValue
}

function statusCodeResult(statusCode: number, body: unknown): BridgeResult {
  if (statusCode === 401 || statusCode === 403) {
    return { ok: false, code: 'authentication_failed', message: 'Workbench rejected the configured action credential.' }
  }
  if (statusCode >= 300 && statusCode < 400) {
    return { ok: false, code: 'action_unavailable', message: 'Workbench action redirects are not allowed.' }
  }
  if (statusCode === 404 || statusCode === 405) {
    return { ok: false, code: 'action_unavailable', message: 'The configured Workbench action is unavailable.' }
  }
  if (statusCode >= 500) {
    return { ok: false, code: 'workbench_unavailable', message: 'Workbench could not complete the action.' }
  }
  return {
    ok: false,
    code: 'workbench_rejected',
    message: 'Workbench rejected the bounded action request.',
    details: sanitizeWorkbenchValue(body)
  }
}

function buildPath(contract: WorkbenchToolContract, input: Record<string, unknown>): string {
  if (contract.method !== 'GET') return contract.endpoint
  const include = input.include
  return typeof include === 'string' ? `${contract.endpoint}?include=${encodeURIComponent(include)}` : contract.endpoint
}

export function createWorkbenchClient(options: WorkbenchClientOptions = {}) {
  const baseUrl = new URL(options.baseUrl ?? WORKBENCH_ACTION_BASE_URL)
  if (baseUrl.protocol !== 'http:' || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error('Workbench MCP client requires a fixed plain local HTTP origin.')
  }
  const credentialFile = options.credentialFile ?? process.env.WORKBENCH_MCP_CREDENTIAL_FILE ?? WORKBENCH_MCP_CREDENTIAL_FILE
  const connectionTimeoutMs = options.connectionTimeoutMs ?? CONNECTION_TIMEOUT_MS
  const totalTimeoutMs = options.totalTimeoutMs ?? TOTAL_TIMEOUT_MS
  const maxRequestBytes = options.maxRequestBytes ?? MAX_ACTION_REQUEST_BYTES
  const maxResponseBytes = options.maxResponseBytes ?? MAX_ACTION_RESPONSE_BYTES

  return async function invoke(contract: WorkbenchToolContract, input: Record<string, unknown>, signal?: AbortSignal): Promise<BridgeResult> {
    let bearerValue: string
    try {
      bearerValue = readActionCredential(credentialFile)
    } catch {
      return { ok: false, code: 'authentication_required', message: 'A protected Workbench action credential is required.' }
    }

    const body = contract.method === 'POST' ? JSON.stringify(input) : ''
    if (Buffer.byteLength(body, 'utf8') > maxRequestBytes) {
      return { ok: false, code: 'invalid_mcp_request', message: 'Workbench MCP request exceeded the allowed size.' }
    }

    return await new Promise<BridgeResult>((resolve) => {
      let settled = false
      let dispatchInitiated = false
      let responseStarted = false
      let connectTimer: NodeJS.Timeout | undefined
      let totalTimer: NodeJS.Timeout | undefined
      const finish = (result: BridgeResult) => {
        if (settled) return
        settled = true
        clearTimeout(connectTimer)
        clearTimeout(totalTimer)
        signal?.removeEventListener('abort', onAbort)
        resolve(result)
      }
      const transportFailure = (message: string): BridgeResult => {
        if (contract.mutationCapable && (dispatchInitiated || responseStarted)) {
          return { ok: false, code: 'ambiguous_transport', message, ambiguous: true }
        }
        return { ok: false, code: 'workbench_unavailable', message }
      }
      const request = http.request({
        protocol: baseUrl.protocol,
        hostname: baseUrl.hostname,
        port: baseUrl.port,
        method: contract.method,
        path: buildPath(contract, input),
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${bearerValue}`,
          ...(contract.method === 'POST' ? {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body, 'utf8')
          } : {})
        },
        agent: false,
        lookup: options.lookup
      }, response => {
        responseStarted = true
        const chunks: Buffer[] = []
        let bytes = 0
        response.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          bytes += buffer.length
          if (bytes > maxResponseBytes) {
            response.destroy()
            finish(contract.mutationCapable
              ? { ok: false, code: 'ambiguous_transport', message: 'Workbench returned an oversized response after possible dispatch.', ambiguous: true }
              : { ok: false, code: 'workbench_rejected', message: 'Workbench response exceeded the allowed size.' })
            return
          }
          chunks.push(buffer)
        })
        response.on('end', () => {
          if (settled) return
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed: unknown
          try {
            parsed = text ? JSON.parse(text) : {}
          } catch {
            finish(contract.mutationCapable
              ? { ok: false, code: 'ambiguous_transport', message: 'Workbench returned malformed JSON after possible dispatch.', ambiguous: true }
              : { ok: false, code: 'workbench_rejected', message: 'Workbench returned a malformed JSON response.' })
            return
          }
          const statusCode = response.statusCode ?? 500
          if (statusCode < 200 || statusCode >= 300) {
            finish(statusCodeResult(statusCode, parsed))
            return
          }
          finish({ ok: true, result: sanitizeWorkbenchValue(parsed) })
        })
        response.on('error', () => finish(transportFailure('Workbench connection ended before a complete response.')))
      })

      const onAbort = () => {
        request.destroy()
        finish(transportFailure('Workbench MCP request was cancelled.'))
      }
      request.on('socket', socket => {
        if (!socket.connecting) return
        connectTimer = setTimeout(() => {
          request.destroy()
          finish({ ok: false, code: 'workbench_timeout', message: 'Workbench connection timed out.' })
        }, connectionTimeoutMs)
        socket.once('connect', () => clearTimeout(connectTimer))
      })
      request.on('error', () => finish(transportFailure('Workbench is unavailable.')))
      totalTimer = setTimeout(() => {
        request.destroy()
        if (contract.mutationCapable && (dispatchInitiated || responseStarted)) {
          finish({ ok: false, code: 'ambiguous_transport', message: 'Workbench transport timed out after possible dispatch.', ambiguous: true })
        } else {
          finish({ ok: false, code: 'workbench_timeout', message: 'Workbench action timed out.' })
        }
      }, totalTimeoutMs)

      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) {
        onAbort()
        return
      }
      dispatchInitiated = true
      request.end(body)
    })
  }
}
