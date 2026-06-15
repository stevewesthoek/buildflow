import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const LOCAL_AGENT_URL =
  process.env.LOCAL_AGENT_URL || 'http://127.0.0.1:3052'

interface RelayHealthStatus {
  status: 'ok' | 'error'
  webAppRunning: boolean
  localAgentUrl: string
  localAgentReachable: boolean
  localAgentHealth?: Record<string, unknown>
  timestamp: string
}

export async function GET() {
  let localAgentHealth: Record<string, unknown> | undefined
  let localAgentReachable = false

  try {
    const response = await fetch(`${LOCAL_AGENT_URL}/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3000)
    })

    if (response.ok) {
      localAgentHealth = await response.json()
      localAgentReachable = true
    }
  } catch {
    // The local agent may be unavailable during startup or maintenance.
  }

  const status: RelayHealthStatus = {
    status: localAgentReachable ? 'ok' : 'error',
    webAppRunning: true,
    localAgentUrl: LOCAL_AGENT_URL,
    localAgentReachable,
    localAgentHealth,
    timestamp: new Date().toISOString()
  }

  return NextResponse.json(status)
}