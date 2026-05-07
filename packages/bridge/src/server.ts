import http from 'http'
import WebSocket from 'ws'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { logToFile } from './logger'
import * as deviceRegistry from './storage/device-registry'
import * as tokenStore from './storage/token-store'
import * as requestAudit from './storage/request-audit'
import * as sessionStore from './storage/session-store'
import { handleAdminDevices, handleAdminRequests, setDeviceMap } from './admin/endpoints'
import { handleCreateSession, handleGetSession, handleListSessions, handleCloseSession } from './admin/session-endpoints'
import type { PersistedDevice } from './storage/types'
import { startup, type StartupResult } from './startup'

let runtimeConfig: StartupResult | null = null
const HEARTBEAT_INTERVAL = 30000

// Body size limits
const MAX_REGISTER_BODY = 4096
const MAX_PROXY_BODY = 65536

interface BodyParseResult {
  success: boolean
  body?: string
  error?: string
}

// Helper: safely accumulate request body with size limit
function parseRequestBody(
  req: http.IncomingMessage,
  maxBytes: number,
  onChunk?: (chunk: string) => void
): Promise<BodyParseResult> {
  return new Promise((resolve) => {
    let body = ''
    let exceedsLimit = false

    req.on('data', (chunk) => {
      if (exceedsLimit) return

      body += chunk.toString()
      onChunk?.(body)

      if (body.length > maxBytes) {
        exceedsLimit = true
        // Do NOT destroy the request; just stop accumulating and mark for rejection
      }
    })

    req.on('end', () => {
      if (exceedsLimit) {
        resolve({ success: false, error: 'Request body too large' })
      } else {
        resolve({ success: true, body })
      }
    })

    req.on('error', (err) => {
      resolve({ success: false, error: 'Request error' })
    })
  })
}

function requireAdminAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (!runtimeConfig?.config.relayAdminToken) {
    // No admin token set, allow access (dev mode)
    return true
  }

  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.writeHead(403)
    res.end(JSON.stringify({ error: 'Admin authentication required' }))
    logToFile({
      timestamp: new Date().toISOString(),
      tool: 'relay_admin',
      status: 'error',
      reason: 'missing_auth'
    })
    return false
  }

  const token = authHeader.slice(7)
  if (token !== runtimeConfig?.config.relayAdminToken) {
    res.writeHead(403)
    res.end(JSON.stringify({ error: 'Invalid admin token' }))
    logToFile({
      timestamp: new Date().toISOString(),
      tool: 'relay_admin',
      status: 'error',
      reason: 'invalid_token'
    })
    return false
  }

  return true
}

function authenticateUserDevice(req: http.IncomingMessage, res: http.ServerResponse): string | null {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.writeHead(401)
    res.end(JSON.stringify({ error: 'Authorization header required' }))
    logToFile({
      timestamp: new Date().toISOString(),
      tool: 'relay_action_proxy',
      status: 'error',
      reason: 'missing_auth'
    })
    return null
  }

  const token = authHeader.slice(7)
  const deviceId = tokenStore.validateToken(token)
  if (!deviceId) {
    res.writeHead(401)
    res.end(JSON.stringify({ error: 'Invalid or unregistered bearer token' }))
    logToFile({
      timestamp: new Date().toISOString(),
      tool: 'relay_action_proxy',
      status: 'error',
      reason: 'invalid_token'
    })
    return null
  }

  return deviceId
}

function requireProxyAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (!runtimeConfig?.config.relayProxyToken) {
    // No proxy token set, allow access (dev mode)
    return true
  }

  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.writeHead(403)
    res.end(JSON.stringify({ error: 'Relay proxy authentication required' }))
    logToFile({
      timestamp: new Date().toISOString(),
      tool: 'relay_action_proxy',
      status: 'error',
      reason: 'missing_auth'
    })
    return false
  }

  const token = authHeader.slice(7)
  if (token !== runtimeConfig?.config.relayProxyToken) {
    res.writeHead(403)
    res.end(JSON.stringify({ error: 'Invalid proxy token' }))
    logToFile({
      timestamp: new Date().toISOString(),
      tool: 'relay_action_proxy',
      status: 'error',
      reason: 'invalid_token'
    })
    return false
  }

  return true
}

interface DeviceConnection {
  ws: WebSocket
  deviceId: string
  status: 'online' | 'offline'
  lastSeen: Date
  lastHeartbeat: Date
}

interface PendingRequest {
  resolve: (value: any) => void
  reject: (reason?: any) => void
  timeout: NodeJS.Timeout
}

// Device registry (in-memory during operation, persisted to disk)
const devices = new Map<string, DeviceConnection>()
const pendingRequests = new Map<string, PendingRequest>()
let requestIdCounter = 0

// Helper to generate request ID
function generateRequestId(): string {
  return `req-${++requestIdCounter}-${Date.now()}`
}

// Rate limiter for device registration: max 5 registrations per IP per minute
const registrationRateLimits = new Map<string, { count: number; resetAt: number }>()

function checkRegistrationRateLimit(ip: string): boolean {
  const now = Date.now()
  const limit = registrationRateLimits.get(ip)

  if (!limit || now >= limit.resetAt) {
    // Reset or first request
    registrationRateLimits.set(ip, { count: 1, resetAt: now + 60000 })
    return true
  }

  if (limit.count < 5) {
    limit.count++
    return true
  }

  return false
}

// HTTP server
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') {
    res.writeHead(200)
    res.end()
    return
  }

  // Admin: list devices (persisted + connected status)
  if (req.method === 'GET' && req.url === '/api/admin/devices') {
    if (!requireAdminAuth(req, res)) return
    handleAdminDevices(req, res)
    return
  }

  // Admin: list request audit records
  if (req.method === 'GET' && req.url?.startsWith('/api/admin/requests')) {
    if (!requireAdminAuth(req, res)) return
    handleAdminRequests(req, res)
    return
  }

  // Session management endpoints
  if (req.url?.startsWith('/api/sessions')) {
    if (!requireAdminAuth(req, res)) return

    // POST /api/sessions - create session
    if (req.method === 'POST' && req.url === '/api/sessions') {
      handleCreateSession(req, res)
      return
    }

    // GET /api/sessions - list sessions
    if (req.method === 'GET' && req.url === '/api/sessions') {
      handleListSessions(req, res)
      return
    }

    // GET /api/sessions/{sessionId} - get session details
    const sessionMatch = req.url?.match(/^\/api\/sessions\/([a-zA-Z0-9_-]+)$/)
    if (req.method === 'GET' && sessionMatch) {
      handleGetSession(req, res, sessionMatch[1])
      return
    }

    // POST /api/sessions/{sessionId}/close - close session
    const closeMatch = req.url?.match(/^\/api\/sessions\/([a-zA-Z0-9_-]+)\/close$/)
    if (req.method === 'POST' && closeMatch) {
      handleCloseSession(req, res, closeMatch[1])
      return
    }

    res.writeHead(404)
    res.end(JSON.stringify({ error: 'Not found' }))
    return
  }

  // Health endpoint
  if (req.method === 'GET' && req.url === '/health') {
    const connectedDevices = Array.from(devices.values()).filter(d => d.ws.readyState === WebSocket.OPEN)

    const status = {
      status: 'ok',
      bridgeRunning: true,
      port: runtimeConfig?.config.bridgePort,
      connectedDevices: connectedDevices.length
    }

    res.writeHead(200)
    res.end(JSON.stringify(status, null, 2))
    return
  }

  // Readiness endpoint
  if (req.method === 'GET' && req.url === '/ready') {
    if (!runtimeConfig?.readyForTraffic) {
      res.writeHead(503)
      res.end(JSON.stringify({ ready: false, reason: 'startup_incomplete' }))
      return
    }

    // Test data directory is still writable
    const testFile = path.join(runtimeConfig.config.dataDir, `.ready-test-${crypto.randomBytes(4).toString('hex')}`)
    try {
      fs.writeFileSync(testFile, 'ready-check', { mode: 0o600 })
      fs.unlinkSync(testFile)
      res.writeHead(200)
      res.end(JSON.stringify({ ready: true, dataDir: runtimeConfig.config.dataDir }))
    } catch (err) {
      res.writeHead(503)
      res.end(JSON.stringify({ ready: false, reason: 'data_dir_not_writable' }))
    }
    return
  }

  // Device registration endpoint: register new device with new token
  if (req.method === 'POST' && req.url === '/api/register') {
    const clientIp = req.headers['x-forwarded-for'] as string || req.socket.remoteAddress || 'unknown'
    const ipAddr = typeof clientIp === 'string' ? clientIp.split(',')[0].trim() : 'unknown'

    if (!checkRegistrationRateLimit(ipAddr)) {
      res.writeHead(429)
      res.end(JSON.stringify({ error: 'Too many registration attempts. Maximum 5 per minute.' }))
      return
    }

    parseRequestBody(req, MAX_REGISTER_BODY).then(async (result) => {
      if (!result.success) {
        res.writeHead(413)
        res.end(JSON.stringify({ error: result.error }))
        return
      }

      try {
        const body = result.body!

        const payload = JSON.parse(body)
        let { deviceToken, deviceId: requestedDeviceId } = payload

        if (!deviceToken) {
          res.writeHead(400)
          res.end(JSON.stringify({ error: 'Missing deviceToken' }))
          return
        }

        // Validate deviceToken format
        if (typeof deviceToken !== 'string') {
          res.writeHead(400)
          res.end(JSON.stringify({ error: 'Invalid deviceToken' }))
          return
        }
        if (deviceToken.length < 16 || deviceToken.length > 256) {
          res.writeHead(400)
          res.end(JSON.stringify({ error: 'Invalid deviceToken' }))
          return
        }
        // Verify printable ASCII only (no control characters)
        if (!/^[\x20-\x7E]+$/.test(deviceToken)) {
          res.writeHead(400)
          res.end(JSON.stringify({ error: 'Invalid deviceToken' }))
          return
        }

        // Validate requestedDeviceId format if provided
        if (requestedDeviceId !== undefined && requestedDeviceId !== null) {
          if (typeof requestedDeviceId !== 'string' || !requestedDeviceId.match(/^[a-zA-Z0-9_-]{1,64}$/)) {
            res.writeHead(400)
            res.end(JSON.stringify({ error: 'Invalid deviceId' }))
            return
          }
        }

        // Check if token already exists
        const existingDeviceId = tokenStore.validateToken(deviceToken)
        if (existingDeviceId) {
          res.writeHead(409)
          res.end(JSON.stringify({ error: 'Token already registered', deviceId: existingDeviceId }))
          logToFile({
            timestamp: new Date().toISOString(),
            tool: 'relay_register',
            status: 'error',
            reason: 'token_already_exists'
          })
          return
        }

        // Generate or use requested deviceId
        const deviceId = requestedDeviceId || `device-${Date.now()}`

        // Check if deviceId already exists
        if (deviceRegistry.findDevice(deviceId)) {
          res.writeHead(409)
          res.end(JSON.stringify({ error: 'Device ID already exists', deviceId }))
          logToFile({
            timestamp: new Date().toISOString(),
            tool: 'relay_register',
            status: 'error',
            reason: 'device_id_exists'
          })
          return
        }

        // Register new token
        tokenStore.registerNewToken(deviceToken, deviceId)

        // Create persisted device record (not connected yet)
        const now = new Date().toISOString()
        const crypto = await import('crypto')
        const tokenHash = crypto.createHash('sha256').update(deviceToken).digest('hex')

        const persistedDevice: PersistedDevice = {
          deviceId,
          tokenHash,
          createdAt: now,
          lastSeenAt: now,
          version: 1
        }
        deviceRegistry.saveDevice(persistedDevice)

        res.writeHead(201)
        res.end(JSON.stringify({
          status: 'ok',
          deviceId,
          message: 'Device registered successfully.',
          usage: 'Your registration token is ready. Use it to connect your local agent to this relay.'
        }))

        logToFile({
          timestamp: new Date().toISOString(),
          tool: 'relay_register',
          status: 'success',
          deviceId
        })
      } catch (err) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'Invalid request' }))
      }
    }).catch((err) => {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'Invalid request' }))
    })
    return
  }

  // Action proxy endpoint: relay-backed execution for ChatGPT actions
  // Routes to device associated with the requesting user's bearer token
  if (req.method === 'POST' && req.url?.startsWith('/api/actions/proxy/')) {
    // Authenticate user device via bearer token
    const requestDeviceId = authenticateUserDevice(req, res)
    if (!requestDeviceId) return

    parseRequestBody(req, MAX_PROXY_BODY).then((result) => {
      if (!result.success) {
        res.writeHead(413)
        res.end(JSON.stringify({ error: result.error }))
        return
      }

      try {
        const body = result.body!
        // Extract agent endpoint from URL (e.g., /api/actions/proxy/api/search -> /api/search)
        const proxyMatch = req.url?.match(/^\/api\/actions\/proxy(.*)$/)
        if (!proxyMatch) {
          res.writeHead(400)
          res.end(JSON.stringify({ error: 'Invalid proxy path' }))
          return
        }

        const agentEndpoint = proxyMatch[1]
        if (!agentEndpoint) {
          res.writeHead(400)
          res.end(JSON.stringify({ error: 'Action endpoint required' }))
          return
        }

        // Convert endpoint to relay command (e.g., /api/search -> action_proxy:search)
        const commandMatch = agentEndpoint.match(/^\/api\/([a-z-]+)/)
        if (!commandMatch) {
          res.writeHead(400)
          res.end(JSON.stringify({ error: 'Invalid action endpoint' }))
          return
        }
        const relayCommand = `action_proxy:${commandMatch[1]}`

        // Find the device for this user
        const device = devices.get(requestDeviceId)

        if (!device || device.ws.readyState !== WebSocket.OPEN) {
          res.writeHead(503)
          res.end(JSON.stringify({
            error: 'Your device is not connected to the relay. Start your local BuildFlow agent with relay mode enabled.'
          }))
          logToFile({
            timestamp: new Date().toISOString(),
            tool: 'relay_action_proxy',
            status: 'error',
            reason: 'device_offline',
            deviceId: requestDeviceId,
            endpoint: agentEndpoint
          })
          return
        }

        // Validate request body
        let params: any
        try {
          params = body ? JSON.parse(body) : {}
        } catch {
          res.writeHead(400)
          res.end(JSON.stringify({ error: 'Invalid request body' }))
          return
        }

        const requestId = generateRequestId()
        const startTime = Date.now()
        let timedOut = false

        // Log request start
        requestAudit.logRequest({
          requestId,
          deviceId: device.deviceId,
          command: relayCommand,
          status: 'pending',
          createdAt: new Date().toISOString(),
          version: 1
        })

        // Status is a read-only relay health check that only needs device connectivity.
        // Answer it directly so staging does not depend on the device command round-trip.
        if (relayCommand === 'action_proxy:status') {
          const duration = Date.now() - startTime
          const result = {
            status: 'ok',
            deviceConnected: true
          }

          requestAudit.logRequest({
            requestId,
            deviceId: device.deviceId,
            command: relayCommand,
            status: 'success',
            createdAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            duration,
            version: 1
          })

          logToFile({
            timestamp: new Date().toISOString(),
            tool: 'relay_action_proxy',
            status: 'success',
            endpoint: agentEndpoint,
            deviceId: device.deviceId,
            requestId,
            duration
          })

          res.writeHead(200)
          res.end(JSON.stringify(result))
          return
        }

        // Create pending request with timeout
        const timeout = setTimeout(() => {
          timedOut = true
          pendingRequests.delete(requestId)
          const duration = Date.now() - startTime
          res.writeHead(504)
          res.end(JSON.stringify({ error: 'Request timeout' }))

          // Log timeout
          requestAudit.logRequest({
            requestId,
            deviceId: device.deviceId,
            command: relayCommand,
            status: 'timeout',
            createdAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            duration,
            version: 1
          })

          logToFile({
            timestamp: new Date().toISOString(),
            tool: 'relay_action_proxy',
            status: 'error',
            reason: 'timeout',
            endpoint: agentEndpoint,
            deviceId: device.deviceId
          })
        }, 30000)

        // Register pending request
        pendingRequests.set(requestId, {
          resolve: (result: any) => {
            if (timedOut) return
            clearTimeout(timeout)
            pendingRequests.delete(requestId)
            const duration = Date.now() - startTime
            res.writeHead(200)
            res.end(JSON.stringify(result))

            // Log success
            requestAudit.logRequest({
              requestId,
              deviceId: device.deviceId,
              command: relayCommand,
              status: 'success',
              createdAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
              duration,
              version: 1
            })

            logToFile({
              timestamp: new Date().toISOString(),
              tool: 'relay_action_proxy',
              status: 'success',
              endpoint: agentEndpoint,
              deviceId: device.deviceId,
              requestId,
              duration
            })
          },
          reject: (error: any) => {
            if (timedOut) return
            clearTimeout(timeout)
            pendingRequests.delete(requestId)
            const duration = Date.now() - startTime
            res.writeHead(500)
            res.end(JSON.stringify({ error: 'Device command failed' }))

            // Log error
            requestAudit.logRequest({
              requestId,
              deviceId: device.deviceId,
              command: relayCommand,
              status: 'error',
              createdAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
              duration,
              error: 'device_command_error',
              version: 1
            })

            logToFile({
              timestamp: new Date().toISOString(),
              tool: 'relay_action_proxy',
              status: 'error',
              endpoint: agentEndpoint,
              deviceId: device.deviceId,
              reason: 'device_command_error'
            })
          },
          timeout
        })

        // Send action request to device
        device.ws.send(JSON.stringify({
          type: 'command_request',
          requestId,
          command: relayCommand,
          params
        }))

        console.log(`[Bridge] Forwarded action proxy ${agentEndpoint} to device ${device.deviceId} (request ${requestId})`)
      } catch (err) {
        res.writeHead(500)
        res.end(JSON.stringify({ error: 'Device command failed' }))
      }
    }).catch((err) => {
      res.writeHead(500)
      res.end(JSON.stringify({ error: 'Internal server error' }))
    })
    return
  }

  // Command endpoint via session: external requester sends command through a session
  // REQUIRES ADMIN AUTH
  if (req.method === 'POST' && req.url === '/api/commands/session') {
    if (!requireAdminAuth(req, res)) return

    parseRequestBody(req, MAX_PROXY_BODY).then((result) => {
      if (!result.success) {
        res.writeHead(413)
        res.end(JSON.stringify({ error: result.error }))
        return
      }

      try {
        const body = result.body!
        const payload = JSON.parse(body)
        const { sessionId, command, params } = payload

        if (!sessionId || !command) {
          res.writeHead(400)
          res.end(JSON.stringify({ error: 'Missing sessionId or command' }))
          return
        }

        // Get session and validate
        const session = sessionStore.getSession(sessionId)
        if (!session) {
          res.writeHead(404)
          res.end(JSON.stringify({ error: 'Session not found' }))
          return
        }

        if (session.status === 'closed') {
          res.writeHead(410)
          res.end(JSON.stringify({ error: 'Session is closed' }))
          return
        }

        const deviceId = session.deviceId
        const device = devices.get(deviceId)
        if (!device) {
          res.writeHead(404)
          res.end(JSON.stringify({ error: 'Device not found' }))
          return
        }

        if (device.ws.readyState !== WebSocket.OPEN) {
          res.writeHead(503)
          res.end(JSON.stringify({ error: 'Device not connected' }))
          return
        }

        // Generate request ID and route command
        const requestId = generateRequestId()
        const startTime = Date.now()
        let timedOut = false

        // Update session activity
        sessionStore.updateSessionActivity(sessionId, requestId, command)

        // Log request start
        requestAudit.logRequest({
          requestId,
          deviceId,
          command,
          status: 'pending',
          createdAt: new Date().toISOString(),
          version: 1
        })

        // Create pending request with timeout
        const timeout = setTimeout(() => {
          timedOut = true
          pendingRequests.delete(requestId)
          const duration = Date.now() - startTime
          res.writeHead(504)
          res.end(JSON.stringify({ error: 'Command timeout' }))

          // Log timeout
          requestAudit.logRequest({
            requestId,
            deviceId,
            command,
            status: 'timeout',
            createdAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            duration,
            version: 1
          })
        }, 30000)

        // Register pending request
        pendingRequests.set(requestId, {
          resolve: (result: any) => {
            if (timedOut) return
            clearTimeout(timeout)
            pendingRequests.delete(requestId)
            const duration = Date.now() - startTime
            res.writeHead(200)
            res.end(JSON.stringify({ status: 'ok', requestId, result }))

            // Log success
            requestAudit.logRequest({
              requestId,
              deviceId,
              command,
              status: 'success',
              createdAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
              duration,
              version: 1
            })
          },
          reject: (error: any) => {
            if (timedOut) return
            clearTimeout(timeout)
            pendingRequests.delete(requestId)
            const duration = Date.now() - startTime
            res.writeHead(500)
            res.end(JSON.stringify({ error: 'Device command failed' }))

            // Log error
            requestAudit.logRequest({
              requestId,
              deviceId,
              command,
              status: 'error',
              createdAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
              duration,
              error: 'device_command_error',
              version: 1
            })
          },
          timeout
        })

        // Send command to device over WebSocket
        device.ws.send(JSON.stringify({
          type: 'command_request',
          requestId,
          command,
          params: params || {}
        }))
      } catch (err) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'Invalid request' }))
      }
    }).catch((err) => {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'Invalid request' }))
    })
    return
  }

  // Command endpoint: external requester sends command targeting a device (LEGACY)
  // REQUIRES ADMIN AUTH
  if (req.method === 'POST' && req.url === '/api/commands') {
    if (!requireAdminAuth(req, res)) return

    parseRequestBody(req, MAX_PROXY_BODY).then((result) => {
      if (!result.success) {
        res.writeHead(413)
        res.end(JSON.stringify({ error: result.error }))
        return
      }

      try {
        const body = result.body!
        const payload = JSON.parse(body)
        const { deviceId, command, params } = payload

        if (!deviceId || !command) {
          res.writeHead(400)
          res.end(JSON.stringify({ error: 'Missing deviceId or command' }))
          return
        }

        const device = devices.get(deviceId)
        if (!device) {
          res.writeHead(404)
          res.end(JSON.stringify({ error: 'Device not found' }))
          logToFile({
            timestamp: new Date().toISOString(),
            tool: 'relay_command',
            status: 'error',
            deviceId,
            command,
            reason: 'device_not_found'
          })
          return
        }

        if (device.ws.readyState !== WebSocket.OPEN) {
          res.writeHead(503)
          res.end(JSON.stringify({ error: 'Device not connected' }))
          logToFile({
            timestamp: new Date().toISOString(),
            tool: 'relay_command',
            status: 'error',
            deviceId,
            command,
            reason: 'device_offline'
          })
          return
        }

        // Generate request ID for correlation
        const requestId = generateRequestId()
        const startTime = Date.now()
        let timedOut = false

        // Log request start
        requestAudit.logRequest({
          requestId,
          deviceId,
          command,
          status: 'pending',
          createdAt: new Date().toISOString(),
          version: 1
        })

        // Create pending request with timeout
        const timeout = setTimeout(() => {
          timedOut = true
          pendingRequests.delete(requestId)
          const duration = Date.now() - startTime
          res.writeHead(504)
          res.end(JSON.stringify({ error: 'Command timeout' }))

          // Log timeout
          requestAudit.logRequest({
            requestId,
            deviceId,
            command,
            status: 'timeout',
            createdAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            duration,
            version: 1
          })

          logToFile({
            timestamp: new Date().toISOString(),
            tool: 'relay_command',
            status: 'error',
            deviceId,
            command,
            reason: 'timeout'
          })
        }, 30000)

        // Register pending request
        pendingRequests.set(requestId, {
          resolve: (result: any) => {
            if (timedOut) return
            clearTimeout(timeout)
            pendingRequests.delete(requestId)
            const duration = Date.now() - startTime
            res.writeHead(200)
            res.end(JSON.stringify({ status: 'ok', result }))

            // Log success
            requestAudit.logRequest({
              requestId,
              deviceId,
              command,
              status: 'success',
              createdAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
              duration,
              version: 1
            })

            logToFile({
              timestamp: new Date().toISOString(),
              tool: 'relay_command',
              status: 'success',
              deviceId,
              command,
              requestId
            })
          },
          reject: (error: any) => {
            if (timedOut) return
            clearTimeout(timeout)
            pendingRequests.delete(requestId)
            const duration = Date.now() - startTime
            res.writeHead(500)
            res.end(JSON.stringify({ error: 'Device command failed' }))

            // Log error
            requestAudit.logRequest({
              requestId,
              deviceId,
              command,
              status: 'error',
              createdAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
              duration,
              error: 'device_command_error',
              version: 1
            })

            logToFile({
              timestamp: new Date().toISOString(),
              tool: 'relay_command',
              status: 'error',
              deviceId,
              command,
              reason: 'device_command_error',
              requestId
            })
          },
          timeout
        })

        // Send command to device over WebSocket
        device.ws.send(JSON.stringify({
          type: 'command_request',
          requestId,
          command,
          params: params || {}
        }))

        console.log(`[Bridge] Forwarded ${command} to device ${deviceId} (request ${requestId})`)
      } catch (err) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'Invalid request' }))
      }
    }).catch((err) => {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'Invalid request' }))
    })
    return
  }

  res.writeHead(404)
  res.end(JSON.stringify({ error: 'Not found' }))
})

// WebSocket server: devices connect here
const wss = new WebSocket.Server({ server })

wss.on('connection', (ws: WebSocket) => {
  let deviceId: string | null = null

  ws.on('message', async (data: string) => {
    try {
      const message = JSON.parse(data)

      // Device authentication
      if (message.type === 'auth') {
        const token = message.deviceToken
        const validatedDeviceId = tokenStore.validateToken(token)
        if (!validatedDeviceId) {
          ws.send(JSON.stringify({
            type: 'auth_response',
            status: 'error',
            error: 'Invalid device token'
          }))
          ws.close()
          return
        }

        deviceId = validatedDeviceId
        const now = new Date()

        // Check if device already exists (reconnection)
        const existingDevice = devices.get(deviceId)
        if (existingDevice) {
          // Close old WebSocket gracefully
          console.log(`[Bridge] Device ${deviceId} reconnecting, replacing stale connection`)
          existingDevice.ws.close()
          devices.delete(deviceId)
        }

        // Store new connection
        devices.set(deviceId, {
          ws,
          deviceId,
          status: 'online',
          lastSeen: now,
          lastHeartbeat: now
        })

        // Persist device record (update lastSeenAt and connectedAt)
        const existingRecord = deviceRegistry.findDevice(deviceId)
        if (!existingRecord) {
          // New device (shouldn't happen if registered via /api/register, but handle it)
          const crypto = await import('crypto')
          const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
          const persistedDevice: PersistedDevice = {
            deviceId,
            tokenHash,
            createdAt: now.toISOString(),
            lastSeenAt: now.toISOString(),
            connectedAt: now.toISOString(),
            version: 1
          }
          deviceRegistry.saveDevice(persistedDevice)
        } else {
          // Existing device, update lastSeenAt
          deviceRegistry.updateLastSeen(deviceId)
        }

        ws.send(JSON.stringify({
          type: 'auth_response',
          status: 'ok',
          deviceId
        }))

        console.log(`[Bridge] Device authenticated: ${deviceId}`)
        logToFile({
          timestamp: new Date().toISOString(),
          tool: 'relay_auth',
          status: 'success',
          deviceId
        })
        return
      }

      // Device heartbeat response (pong)
      if (message.type === 'pong') {
        if (deviceId) {
          const device = devices.get(deviceId)
          if (device) {
            device.lastHeartbeat = new Date()
            // Update lastSeenAt metadata
            deviceRegistry.updateLastSeen(deviceId)
          }
        }
        return
      }

      // Device command response: device sends result back to relay
      // This is the return path: device completed a command, sending response
      if (message.type === 'command_response') {
        const { requestId, error, result } = message

        const pending = pendingRequests.get(requestId)
        if (pending) {
          clearTimeout(pending.timeout)
          if (error) {
            pending.reject(new Error(error))
          } else {
            pending.resolve(result)
          }
          pendingRequests.delete(requestId)

          console.log(`[Bridge] Device ${deviceId} responded to request ${requestId}`)
        } else {
          console.warn(`[Bridge] Received response for unknown request ${requestId}`)
        }
        return
      }

      // Update last seen on any message
      if (deviceId) {
        const device = devices.get(deviceId)
        if (device) {
          device.lastSeen = new Date()
        }
      }
    } catch (err) {
      console.error('[Bridge] Parse error:', err)
    }
  })

  ws.on('close', () => {
    if (deviceId) {
      devices.delete(deviceId)
      // Update lastSeenAt but do not persist status (runtime only)
      deviceRegistry.updateLastSeen(deviceId)
      console.log(`[Bridge] Device disconnected: ${deviceId}`)
      logToFile({
        timestamp: new Date().toISOString(),
        tool: 'relay_disconnect',
        status: 'success',
        deviceId
      })
    }
  })

  ws.on('error', (err) => {
    console.error('[Bridge] WebSocket error:', err)
  })
})

// Heartbeat interval: send ping to all connected devices
setInterval(() => {
  const now = new Date()
  devices.forEach((device, deviceId) => {
    if (device.ws.readyState === WebSocket.OPEN) {
      device.ws.send(JSON.stringify({ type: 'ping' }))

      // Detect stale connections (no pong within timeout window)
      const timeSinceHeartbeat = now.getTime() - device.lastHeartbeat.getTime()
      if (timeSinceHeartbeat > 60000) {
        // Device is unresponsive, close it (will trigger ws.on('close'))
        device.ws.close()
      }
    }
  })
}, HEARTBEAT_INTERVAL)

// Session cleanup interval: remove expired sessions
setInterval(() => {
  const cleaned = sessionStore.cleanupExpiredSessions()
  if (cleaned > 0) {
    console.log(`[Bridge] Cleaned up ${cleaned} expired sessions`)
  }
}, 60000) // Every 60 seconds

// Start server with startup validation
startup().then(result => {
  runtimeConfig = result
  const PORT = result.config.bridgePort

  // Load persisted state after validation
  console.log('[Bridge] Loading persisted state...')
  deviceRegistry.loadDevices()
  tokenStore.loadTokens()
  requestAudit.loadRequests()
  setDeviceMap(devices)
  console.log('[Bridge] Persisted state loaded')

  // Check if default tokens are enabled
  if (result.config.enableDefaultTokens) {
    console.warn('[Bridge] ⚠ Default development tokens are ENABLED')
    console.warn('[Bridge]   For production, set: RELAY_ENABLE_DEFAULT_TOKENS=false')
  } else {
    console.log('[Bridge] ✓ Default tokens disabled')
  }

  // Check if admin auth is configured
  if (result.config.relayAdminToken) {
    console.log('[Bridge] ✓ Admin endpoint authentication enabled')
  } else {
    console.warn('[Bridge] ⚠ Admin endpoints have NO authentication')
    console.warn('[Bridge]   For production, set: RELAY_ADMIN_TOKEN=<secret>')
  }

  // Start listening (0.0.0.0 for container access from host)
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Bridge] Relay running on http://localhost:${PORT}`)
    console.log(`[Bridge] WebSocket: ws://localhost:${PORT}`)
    console.log(`[Bridge] Health: GET http://localhost:${PORT}/health`)
    console.log(`[Bridge] Ready: GET http://localhost:${PORT}/ready`)
    console.log(`[Bridge] Register: POST http://localhost:${PORT}/api/register`)
    console.log(`[Bridge] Commands: POST http://127.0.0.1:${PORT}/api/commands`)
    console.log(`[Bridge] Admin: GET http://127.0.0.1:${PORT}/api/admin/devices`)
    console.log(`[Bridge] Admin: GET http://127.0.0.1:${PORT}/api/admin/requests`)
  })
}).catch(err => {
  console.error('[Bridge] Startup failed:', err)
  process.exit(1)
})

export { devices }
