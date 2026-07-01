import { retiredAgentAction } from '@/lib/actions/retired-agent-actions'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function POST() {
  return retiredAgentAction('manageWorkbenchAgentRun')
}
