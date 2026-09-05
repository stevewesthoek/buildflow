export const CLIENT_WORKFLOW_TOOL_NAMES = [
  'mcpClientSessionCreate',
  'mcpClientSessionStatus',
  'mcpClientSessionRevoke',
  'mcpCapabilityRequest',
  'mcpCapabilityDiscover',
  'mcpCapabilityApproval',
  'mcpCapabilityRequestStatus',
  'mcpCapabilityPlan',
  'mcpCapabilityPlanApprove',
  'mcpCapabilityExecute',
  'mcpCapabilityResult'
] as const

export type ClientWorkflowToolName = typeof CLIENT_WORKFLOW_TOOL_NAMES[number]
