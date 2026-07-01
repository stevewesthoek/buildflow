import { retiredAgentAction } from '@/lib/actions/retired-agent-actions'

export async function POST() {
  return retiredAgentAction('startWorkbenchAgentRun')
}
