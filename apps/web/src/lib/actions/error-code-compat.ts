/**
 * Legacy error code normalization for Workbench.
 * During compatibility period, legacy BUILDFLOW_* codes map to canonical WORKBENCH_* codes.
 * This ensures the system recognizes both old and new codes while new code emits only canonical.
 */

type ErrorCodeMapping = Record<string, string>

const LEGACY_TO_CANONICAL: ErrorCodeMapping = {
  BUILDFLOW_ACTION_DEADLINE_EXCEEDED: 'WORKBENCH_ACTION_DEADLINE_EXCEEDED',
  BUILDFLOW_NEEDS_NARROWER_SCOPE: 'WORKBENCH_NEEDS_NARROWER_SCOPE',
  BUILDFLOW_RESPONSE_SIZE_EXCEEDED: 'WORKBENCH_RESPONSE_SIZE_EXCEEDED',
  BUILDFLOW_COMMAND_TIMEOUT: 'WORKBENCH_COMMAND_TIMEOUT',
  BUILDFLOW_STATUS_ERROR: 'WORKBENCH_STATUS_ERROR'
}

/**
 * Normalize a legacy error code to its canonical WORKBENCH equivalent.
 * Canonical codes pass through unchanged.
 * Unknown codes remain unchanged (no silent conversion).
 */
export function normalizeWorkbenchErrorCode(code: string): string {
  if (code in LEGACY_TO_CANONICAL) {
    return LEGACY_TO_CANONICAL[code]
  }
  return code
}

/**
 * Check if a code is a known legacy BuildFlow error code.
 */
export function isLegacyBuildFlowErrorCode(code: string): boolean {
  return code in LEGACY_TO_CANONICAL
}

/**
 * Get the canonical form of an error code (normalizes legacy if needed).
 * Useful for classifying error responses before HTTP transmission.
 */
export function getCanonicalErrorCode(code: string): string {
  return normalizeWorkbenchErrorCode(code)
}
