// Shared GPT-facing payload budget constants.
// Custom GPT remains the reasoning/coding engine; local BuildFlow keeps action payloads compact and deterministic.
export const GPT_ACTION_RESPONSE_BUDGET_BYTES = 32_000
export const GPT_ACTION_TARGET_BYTES = 8_000
export const GPT_ACTION_WARNING_BYTES = 16_000
export const GPT_ACTION_DEFAULT_FILE_BYTES = 6_000

export type PayloadBudgetReport = {
  bytes: number
  targetBytes: number
  warningBytes: number
  hardBudgetBytes: number
  overTarget: boolean
  overWarning: boolean
  overBudget: boolean
}

export function measureJsonPayload(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? {}), 'utf8')
}

export function payloadBudgetReport(value: unknown): PayloadBudgetReport {
  const bytes = measureJsonPayload(value)
  return {
    bytes,
    targetBytes: GPT_ACTION_TARGET_BYTES,
    warningBytes: GPT_ACTION_WARNING_BYTES,
    hardBudgetBytes: GPT_ACTION_RESPONSE_BUDGET_BYTES,
    overTarget: bytes > GPT_ACTION_TARGET_BYTES,
    overWarning: bytes > GPT_ACTION_WARNING_BYTES,
    overBudget: bytes > GPT_ACTION_RESPONSE_BUDGET_BYTES
  }
}
