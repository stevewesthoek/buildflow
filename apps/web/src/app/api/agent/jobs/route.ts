import { proxyAgentJson } from '@/lib/agentProxy'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET() {
  return proxyAgentJson('/api/agent-jobs/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 8 })
  })
}
