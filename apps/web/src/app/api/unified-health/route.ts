import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { getBuildSha, getBuildTimestamp } from '@/lib/env-compat'

const LOCAL_AGENT_URL = process.env.LOCAL_AGENT_URL || 'http://127.0.0.1:3052'
const LOCAL_RELAY_URL = process.env.LOCAL_RELAY_URL || 'http://127.0.0.1:3053'

const HEALTH_TIMEOUT_MS = 3000
const WEB_PROCESS_STARTED_AT = new Date().toISOString()

function readWebBuildId(): string | undefined {
  try {
    return fs.readFileSync(path.join(process.cwd(), '.next/BUILD_ID'), 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

async function checkService(url: string): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
    const response = await fetch(url, { signal: controller.signal })
    clearTimeout(timeout)
    return response.ok
  } catch {
    return false
  }
}

export async function GET() {
  const [agentOk, relayOk, webOk] = await Promise.all([
    checkService(`${LOCAL_AGENT_URL}/health`),
    checkService(`${LOCAL_RELAY_URL}/health`),
    checkService('http://localhost:3054/api/openapi')
  ])

  const allHealthy = agentOk && relayOk && webOk
  const healthyCount = [agentOk, relayOk, webOk].filter(Boolean).length

  return NextResponse.json(
    {
      status: allHealthy ? 'ok' : 'unhealthy',
      allHealthy,
      healthyCount,
      total: 3,
      services: {
        agent: { url: `${LOCAL_AGENT_URL}/health`, healthy: agentOk },
        relay: { url: `${LOCAL_RELAY_URL}/health`, healthy: relayOk },
        web: { url: 'http://localhost:3054/api/openapi', healthy: webOk }
      },
      service: {
        role: 'web',
        packageVersion: process.env.npm_package_version || '1.2.13-beta',
        gitCommit: getBuildSha(),
        buildTimestamp: getBuildTimestamp(),
        processStartedAt: WEB_PROCESS_STARTED_AT,
        pid: process.pid,
        webBuildId: process.env.WORKBENCH_WEB_BUILD_ID || readWebBuildId() || 'unknown'
      }
    },
    { status: allHealthy ? 200 : 503 }
  )
}
