/**
 * Shared environment variable compatibility layer for Node runtime.
 * Works in CLI, bridge, and web contexts.
 * Supports canonical WORKBENCH_* with fallback to legacy BUILDFLOW_*.
 */

const deprecationWarnings = new Set<string>()

/**
 * Core resolver for environment variables with canonical/legacy support.
 *
 * Behavior:
 * - canonical only: select canonical, no warning
 * - legacy only: select legacy, emit one deprecation warning
 * - both identical: select canonical, no failure
 * - both different: throw error with variable names (no values exposed)
 * - neither: use default or undefined
 *
 * @param canonical - Canonical variable name (WORKBENCH_*)
 * @param legacy - Legacy variable name (BUILDFLOW_*)
 * @param defaultValue - Optional default value
 * @param isSecret - If true, never include values in error messages
 * @returns The selected value
 * @throws If canonical and legacy are set to different values
 */
export function resolveEnvVariable(
  canonical: string,
  legacy: string,
  defaultValue?: string,
  isSecret = false
): string | undefined {
  const canonicalValue = process.env[canonical]
  const legacyValue = process.env[legacy]

  // Both set: check for conflict
  if (canonicalValue && legacyValue) {
    if (canonicalValue !== legacyValue) {
      throw new Error(
        `Conflicting environment variables: ${canonical} and ${legacy} are both set with different values. ` +
          `Remove the legacy ${legacy}.`
      )
    }
    // Both identical: use canonical
    return canonicalValue
  }

  // Canonical only: use it
  if (canonicalValue) {
    return canonicalValue
  }

  // Legacy only: use it with deprecation warning
  if (legacyValue) {
    emitDeprecationWarning(legacy, canonical)
    return legacyValue
  }

  // Neither: use default
  return defaultValue
}

/**
 * Emit a deprecation warning once per variable per process.
 */
function emitDeprecationWarning(legacyVar: string, canonicalVar: string): void {
  if (deprecationWarnings.has(legacyVar)) return
  deprecationWarnings.add(legacyVar)
  console.warn(`[deprecated] ${legacyVar} is supported temporarily; use ${canonicalVar}.`)
}

/**
 * Resolve build SHA with fallback and conflict detection.
 */
export function getBuildSha(): string {
  const value = resolveEnvVariable('WORKBENCH_BUILD_SHA', 'BUILDFLOW_BUILD_SHA', 'unknown')
  return value || 'unknown'
}

/**
 * Resolve build timestamp with fallback and conflict detection.
 */
export function getBuildTimestamp(): string {
  const value = resolveEnvVariable('WORKBENCH_BUILD_TIMESTAMP', 'BUILDFLOW_BUILD_TIMESTAMP', 'unknown')
  return value || 'unknown'
}

/**
 * Resolve action diagnostics flag with fallback and conflict detection.
 */
export function getActionDiagnostics(): boolean {
  const value = resolveEnvVariable('WORKBENCH_ACTION_DIAGNOSTICS', 'BUILDFLOW_ACTION_DIAGNOSTICS', '0')
  return value === '1'
}

/**
 * Resolve API base URL with fallback and conflict detection.
 */
export function getApiBaseUrl(): string {
  const value = resolveEnvVariable('WORKBENCH_API', 'BUILDFLOW_API', 'http://localhost:3000')
  return value || 'http://localhost:3000'
}
