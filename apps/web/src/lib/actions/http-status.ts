import { type ActionErrorEnvelope } from './action-response'

type ControlledFailureClassification = {
  httpStatus: number
  internalStatusCode: number
  failureStage: string
}

const CONTROLLED_FAILURES: Record<string, ControlledFailureClassification> = {
  LOCAL_STACK_TIMEOUT: { httpStatus: 200, internalStatusCode: 504, failureStage: 'transport' },
  LOCAL_STACK_UNAVAILABLE: { httpStatus: 200, internalStatusCode: 503, failureStage: 'transport' },
  RESPONSE_SIZE_EXCEEDED: { httpStatus: 200, internalStatusCode: 413, failureStage: 'transport' },
  EMPTY_RELAY_RESPONSE: { httpStatus: 200, internalStatusCode: 502, failureStage: 'transport' },
  INVALID_RELAY_RESPONSE: { httpStatus: 200, internalStatusCode: 502, failureStage: 'transport' },
  ACTION_TRANSPORT_ERROR: { httpStatus: 200, internalStatusCode: 503, failureStage: 'transport' },
  BUILDFLOW_ACTION_DEADLINE_EXCEEDED: { httpStatus: 200, internalStatusCode: 504, failureStage: 'deadline' },
  BUILDFLOW_NEEDS_NARROWER_SCOPE: { httpStatus: 200, internalStatusCode: 400, failureStage: 'route' },
  STATUS_PAYLOAD_EXCEEDS_BUDGET: { httpStatus: 200, internalStatusCode: 413, failureStage: 'route' },
  BUILDFLOW_RESPONSE_SIZE_EXCEEDED: { httpStatus: 200, internalStatusCode: 413, failureStage: 'route' },
  BUILDFLOW_COMMAND_TIMEOUT: { httpStatus: 200, internalStatusCode: 504, failureStage: 'command' },
  REQUIRES_EXPLICIT_CONFIRMATION: { httpStatus: 200, internalStatusCode: 200, failureStage: 'policy' }
}

export function getSafeActionHttpStatus(error: unknown): number {
  if (!error || typeof error !== 'object') return 500

  const envelope = error as ActionErrorEnvelope
  const errorCode = envelope.error?.code

  if (errorCode && errorCode in CONTROLLED_FAILURES) {
    return CONTROLLED_FAILURES[errorCode].httpStatus
  }

  if (envelope.error?.code === 'MISSING_PARAM' || envelope.error?.code === 'INVALID_REQUEST') {
    return 400
  }

  return 500
}

export function getControlledFailureClassification(errorCode: string): ControlledFailureClassification | undefined {
  return CONTROLLED_FAILURES[errorCode]
}

export function isControlledFailure(errorCode: string): boolean {
  return errorCode in CONTROLLED_FAILURES
}

export function validateNoGatewayStatusCodes(): void {
  const gatewayStatuses = [502, 503, 504, 507]
  const violations = Object.entries(CONTROLLED_FAILURES)
    .filter(([, { httpStatus }]) => gatewayStatuses.includes(httpStatus))
    .map(([code, { httpStatus }]) => `${code}: HTTP ${httpStatus}`)

  if (violations.length > 0) {
    throw new Error(`Controlled failures must not use gateway status codes:\n${violations.join('\n')}`)
  }
}
