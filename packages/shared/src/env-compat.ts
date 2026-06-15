/**
 * Shared environment variable compatibility layer for Node runtime.
 * Works in CLI, bridge, and web contexts.
 * Supports canonical WORKBENCH_* with fallback to legacy BUILDFLOW_*.
 */

const deprecationWarnings = new Set<string>()

/**
 * Safely compare secret values without exposing them.
 */
function secretsEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return a === b
  if (a.length !== b.length) return false
  let equal = 0
  for (let i = 0; i < a.length; i++) {
    equal |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return equal === 0
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
 * Resolve build SHA with fallback.
 */
export function getBuildSha(): string {
  const value = process.env.WORKBENCH_BUILD_SHA || process.env.BUILDFLOW_BUILD_SHA || 'unknown'
  if (process.env.BUILDFLOW_BUILD_SHA && !process.env.WORKBENCH_BUILD_SHA) {
    emitDeprecationWarning('BUILDFLOW_BUILD_SHA', 'WORKBENCH_BUILD_SHA')
  }
  return value
}

/**
 * Resolve build timestamp with fallback.
 */
export function getBuildTimestamp(): string {
  const value = process.env.WORKBENCH_BUILD_TIMESTAMP || process.env.BUILDFLOW_BUILD_TIMESTAMP || 'unknown'
  if (process.env.BUILDFLOW_BUILD_TIMESTAMP && !process.env.WORKBENCH_BUILD_TIMESTAMP) {
    emitDeprecationWarning('BUILDFLOW_BUILD_TIMESTAMP', 'WORKBENCH_BUILD_TIMESTAMP')
  }
  return value
}

/**
 * Resolve action diagnostics flag.
 */
export function getActionDiagnostics(): boolean {
  const canonical = process.env.WORKBENCH_ACTION_DIAGNOSTICS
  const legacy = process.env.BUILDFLOW_ACTION_DIAGNOSTICS

  if (canonical && legacy && canonical !== legacy) {
    throw new Error(
      `Conflicting environment variables: WORKBENCH_ACTION_DIAGNOSTICS and BUILDFLOW_ACTION_DIAGNOSTICS ` +
        `are both set with different values. Remove the legacy BUILDFLOW_ACTION_DIAGNOSTICS.`
    )
  }

  if (legacy && !canonical) {
    emitDeprecationWarning('BUILDFLOW_ACTION_DIAGNOSTICS', 'WORKBENCH_ACTION_DIAGNOSTICS')
  }

  return (canonical || legacy) === '1'
}

/**
 * Resolve API base URL with fallback.
 */
export function getApiBaseUrl(): string {
  const value = process.env.WORKBENCH_API || process.env.BUILDFLOW_API || 'http://localhost:3000'
  if (process.env.BUILDFLOW_API && !process.env.WORKBENCH_API) {
    emitDeprecationWarning('BUILDFLOW_API', 'WORKBENCH_API')
  }
  return value
}
