import { proxyAgentJson } from '@/lib/agentProxy'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}))
  return proxyAgentJson('/api/agent-jobs/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}
