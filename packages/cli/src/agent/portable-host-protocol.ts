import { Buffer } from 'node:buffer'

export const PORTABLE_HOST_PROTOCOL_VERSION = 1 as const
export const PORTABLE_HOST_MAX_FRAME_BYTES = 1_048_576
export const PORTABLE_HOST_MAX_REQUEST_BYTES = 262_144
export const PORTABLE_HOST_MAX_RESPONSE_BYTES = 786_432

export type PortableHostMessageType = 'request' | 'response' | 'cancel' | 'shutdown' | 'capabilities'

export type PortableHostRequest = {
  protocolVersion: typeof PORTABLE_HOST_PROTOCOL_VERSION
  messageType: 'request'
  requestId: string
  operationId: string
  payload: unknown
  deadlineAt?: string
  sourceId?: string
  sessionId?: string
  cancellationId?: string
}

export type PortableHostMessage =
  | PortableHostRequest
  | { protocolVersion: typeof PORTABLE_HOST_PROTOCOL_VERSION; messageType: 'cancel'; requestId: string }
  | { protocolVersion: typeof PORTABLE_HOST_PROTOCOL_VERSION; messageType: 'shutdown'; requestId: string }
  | { protocolVersion: typeof PORTABLE_HOST_PROTOCOL_VERSION; messageType: 'capabilities'; requestId: string }

export type PortableHostResponse = {
  protocolVersion: typeof PORTABLE_HOST_PROTOCOL_VERSION
  messageType: 'response'
  requestId: string
  ok: boolean
  payload?: unknown
  error?: {
    code: string
    message: string
    details?: Record<string, unknown>
    retryable?: boolean
    requiresConfirmation?: boolean
    confirmationToken?: string
  }
}

export type PortableHostCapabilities = {
  protocolVersion: typeof PORTABLE_HOST_PROTOCOL_VERSION
  messageType: 'capabilities'
  requestId: string
  hostArtifact: 'portable-core-host'
  hostVersion: string
  runtime: { name: 'node'; requiredMajor: 20 }
  maxFrameBytes: number
  supportedOperationIds: string[]
  mutationOperationsEnabled: boolean
}

export function encodeFrame(message: unknown, maxBytes = PORTABLE_HOST_MAX_FRAME_BYTES): Buffer {
  const payload = Buffer.from(JSON.stringify(message), 'utf8')
  if (payload.length === 0 || payload.length > maxBytes) throw new Error('portable host frame exceeds maximum size')
  const frame = Buffer.allocUnsafe(4 + payload.length)
  frame.writeUInt32BE(payload.length, 0)
  payload.copy(frame, 4)
  return frame
}

export function decodeFrames(buffer: Buffer, maxBytes = PORTABLE_HOST_MAX_FRAME_BYTES): { messages: unknown[]; remainder: Buffer } {
  const messages: unknown[] = []
  let offset = 0
  while (buffer.length - offset >= 4) {
    const length = buffer.readUInt32BE(offset)
    if (length === 0 || length > maxBytes) throw new Error('portable host frame length is invalid')
    if (buffer.length - offset - 4 < length) break
    const raw = buffer.subarray(offset + 4, offset + 4 + length).toString('utf8')
    try { messages.push(JSON.parse(raw)) } catch { throw new Error('portable host frame payload is invalid JSON') }
    offset += 4 + length
  }
  return { messages, remainder: buffer.subarray(offset) }
}

export function validateMessage(value: unknown): PortableHostMessage {
  if (!value || typeof value !== 'object') throw new Error('portable host message must be an object')
  const message = value as Record<string, unknown>
  if (message.protocolVersion !== PORTABLE_HOST_PROTOCOL_VERSION) throw new Error('portable host protocol version is unsupported')
  if (typeof message.requestId !== 'string' || message.requestId.length < 1 || message.requestId.length > 200) throw new Error('portable host requestId is invalid')
  if (!['request', 'cancel', 'shutdown', 'capabilities'].includes(String(message.messageType))) throw new Error('portable host message type is unsupported')
  if (message.messageType === 'request' && typeof message.operationId !== 'string') throw new Error('portable host operationId is required')
  return value as PortableHostMessage
}
