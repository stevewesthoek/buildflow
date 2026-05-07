import { NextRequest, NextResponse } from 'next/server'
import { executeAction, ActionTransportError } from './transport'
import { buildActionErrorEnvelope } from './action-response'

// Handle standard proxy action: auth → parse body → execute → respond
export async function handleProxyAction(
  request: NextRequest,
  authValid: boolean,
  authError: NextResponse | undefined,
  endpoint: string,
  bearerToken?: string
): Promise<NextResponse> {
  if (!authValid) return authError!

  try {
    const body = await request.json()
    const data = await executeAction(endpoint, body, bearerToken)
    return NextResponse.json(data)
  } catch (err) {
    if (err instanceof ActionTransportError) {
      return NextResponse.json(
        err.payload && typeof err.payload === 'object'
          ? err.payload
          : buildActionErrorEnvelope({
              code: 'ACTION_TRANSPORT_ERROR',
              message: err.message,
              details: `Status ${err.statusCode}`,
              status: err.statusCode === 504 ? 'unavailable' : 'error'
            }),
        { status: err.statusCode }
      )
    }
    return NextResponse.json(
      buildActionErrorEnvelope({
        code: 'BUILDFLOW_STATUS_ERROR',
        message: 'Proxy action error',
        details: err instanceof Error ? err.message : String(err)
      }),
      { status: 500 }
    )
  }
}
