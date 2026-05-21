import { NextRequest, NextResponse } from 'next/server'
import { checkActionAuth } from '@/lib/actionAuth'
import { executeAction, ActionTransportError } from '@/lib/actions/transport'
import { buildActionErrorEnvelope } from '@/lib/actions/action-response'

export async function POST(request: NextRequest) {
  const auth = checkActionAuth(request)
  if (!auth.valid) return auth.error

  try {
    const body = await request.json()
    const { operations } = body
    if (!Array.isArray(operations) || operations.length === 0 || operations.length > 5) {
      return NextResponse.json(buildActionErrorEnvelope({ code: 'INVALID_BATCH', message: 'operations must be 1-5 items' }), { status: 400 })
    }
    const data = await executeAction('/api/batch', { operations }, auth.bearerToken)
    return NextResponse.json(data)
  } catch (err) {
    if (err instanceof ActionTransportError) {
      return NextResponse.json(buildActionErrorEnvelope({ code: 'ACTION_TRANSPORT_ERROR', message: err.message }), { status: err.statusCode })
    }
    return NextResponse.json(buildActionErrorEnvelope({ code: 'BATCH_ERROR', message: err instanceof Error ? err.message : String(err) }), { status: 500 })
  }
}
