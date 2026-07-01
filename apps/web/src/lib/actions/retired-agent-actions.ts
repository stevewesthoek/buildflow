import { NextResponse } from 'next/server'

const recovery = [
  'Reimport the current OpenAPI schema from https://workbench.prochat.tools/api/openapi.',
  'Use getWorkbenchStatus, readWorkbenchContext, applyWorkbenchFileChange, commitWorkbenchChanges, or runWorkbenchCommand.',
  'Start a new Custom GPT chat after updating the GPT so stale Agent Mode actions are not reused.'
]

export function retiredAgentAction(operationId: string) {
  return NextResponse.json({
    ok: false,
    connected: true,
    status: 'retired',
    error: {
      code: 'WORKBENCH_AGENT_ACTION_RETIRED',
      message: 'This Agent Mode GPT action route has been retired.',
      details: `${operationId} is not part of the current Workbench Custom GPT action contract.`,
      recovery
    },
    activity: {
      operationId,
      phase: 'retired',
      actionLabel: 'Retired Agent Mode action rejected',
      userMessage: 'This GPT is using a stale Agent Mode action. Update the GPT schema before continuing.',
      riskLevel: 'low',
      requiresConfirmation: false,
      verified: true,
      nextStep: 'Update the GPT schema and retry with the current five Workbench actions.'
    }
  }, {
    status: 200,
    headers: {
      'Cache-Control': 'no-store',
      'X-Workbench-Action-Retired': 'true'
    }
  })
}
