import { NextResponse } from 'next/server'

export async function GET() {
  const relayUrl = process.env.BRIDGE_URL || 'http://127.0.0.1:3053'

  try {
    const response = await fetch(`${relayUrl}/health`, {
      signal: AbortSignal.timeout(2000),
      cache: 'no-store'
    })
    if (!response.ok) {
      return NextResponse.json(
        { error: 'Relay health check failed', status: response.status },
        { status: 502 }
      )
    }

    const data = await response.json()
    return NextResponse.json(data)
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'AbortError'
    return NextResponse.json(
      {
        error: isTimeout
          ? `Relay health check timed out (2s): ${relayUrl}`
          : `Failed to reach relay: ${String(err)}`,
        relayUrl
      },
      { status: 503 }
    )
  }
}
