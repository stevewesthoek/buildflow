import { z } from 'zod'

/**
 * Product-owned acceptance policy for a narrow n8n wrapper protocol.  This is
 * deliberately a value contract, not a wrapper configuration format: callers
 * cannot supply an executable, origin, environment, or operation details.
 */
export const CONTROLLED_N8N_WRAPPER_CONTRACT_VERSION = 1 as const

const exact = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict()

export const controlledN8nWrapperContractSchema = exact({
  schemaVersion: z.literal(CONTROLLED_N8N_WRAPPER_CONTRACT_VERSION),
  kind: z.literal('n8n-workflow-wrapper'),
  read: exact({
    operation: z.literal('get-workflow'),
    argvTemplate: z.tuple([z.literal('get-workflow'), z.literal('{workflowId}')])
  }),
  mutation: exact({
    operation: z.literal('update-workflow'),
    argvTemplate: z.tuple([z.literal('update-workflow'), z.literal('{workflowId}'), z.literal('-')]),
    httpMethod: z.literal('PUT'),
    pathTemplate: z.literal('/workflows/{workflowId}'),
    payloadTransport: z.literal('stdin')
  }),
  limits: exact({
    maximumPayloadBytes: z.literal(500_000),
    maximumResponseBytes: z.literal(500_000),
    defaultConnectTimeoutSeconds: z.literal(5),
    maximumConnectTimeoutSeconds: z.literal(30),
    defaultTotalTimeoutSeconds: z.literal(60),
    maximumTotalTimeoutSeconds: z.literal(300)
  }),
  policy: exact({
    automaticRetries: z.literal(0),
    maximumMutationRequestsPerInvocation: z.literal(1),
    followsRedirects: z.literal(false),
    usesAmbientClientConfiguration: z.literal(false),
    requiresReadbackAfterMutation: z.literal(true),
    duplicateInvocationsAreIntrinsicallySafe: z.literal(false),
    requiresExternalReplayProtection: z.literal(true)
  }),
  classifications: z.tuple([
    z.literal('succeeded'),
    z.literal('definitively_failed'),
    z.literal('ambiguous'),
    z.literal('timed_out')
  ]),
  protectedFieldPolicy: z.literal('forward_validated_payload_unchanged')
})

export type ControlledN8nWrapperContract = z.infer<typeof controlledN8nWrapperContractSchema>

/** The sole protocol accepted by Workbench v1; no installation identity is embedded. */
export const CONTROLLED_N8N_WRAPPER_CONTRACT_V1: ControlledN8nWrapperContract = Object.freeze<ControlledN8nWrapperContract>({
  schemaVersion: 1,
  kind: 'n8n-workflow-wrapper',
  read: { operation: 'get-workflow', argvTemplate: ['get-workflow', '{workflowId}'] },
  mutation: {
    operation: 'update-workflow',
    argvTemplate: ['update-workflow', '{workflowId}', '-'],
    httpMethod: 'PUT',
    pathTemplate: '/workflows/{workflowId}',
    payloadTransport: 'stdin'
  },
  limits: {
    maximumPayloadBytes: 500_000,
    maximumResponseBytes: 500_000,
    defaultConnectTimeoutSeconds: 5,
    maximumConnectTimeoutSeconds: 30,
    defaultTotalTimeoutSeconds: 60,
    maximumTotalTimeoutSeconds: 300
  },
  policy: {
    automaticRetries: 0,
    maximumMutationRequestsPerInvocation: 1,
    followsRedirects: false,
    usesAmbientClientConfiguration: false,
    requiresReadbackAfterMutation: true,
    duplicateInvocationsAreIntrinsicallySafe: false,
    requiresExternalReplayProtection: true
  },
  classifications: ['succeeded', 'definitively_failed', 'ambiguous', 'timed_out'],
  protectedFieldPolicy: 'forward_validated_payload_unchanged'
})

export function parseControlledN8nWrapperContract(value: unknown):
  | { ok: true; contract: ControlledN8nWrapperContract }
  | { ok: false; issues: Array<{ path: string; message: string }> } {
  const parsed = controlledN8nWrapperContractSchema.safeParse(value)
  if (parsed.success) return { ok: true, contract: parsed.data }
  return {
    ok: false,
    issues: parsed.error.issues.slice(0, 20).map(issue => ({
      path: issue.path.map(String).join('.') || 'contract',
      message: issue.message.slice(0, 240)
    }))
  }
}
