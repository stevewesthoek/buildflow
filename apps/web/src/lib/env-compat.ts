/**
 * Environment variable compatibility layer.
 * Supports canonical WORKBENCH_* variables with fallback to legacy BUILDFLOW_* for temporary compatibility.
 *
 * Key behaviors:
 * - Canonical WORKBENCH_* is read first.
 * - Legacy BUILDFLOW_* is fallback-only.
 * - Conflicting values (both set, different) are rejected with a safe error.
 * - Secret values are never logged or included in error messages.
 * - Deprecation warnings are emitted at most once per variable per process.
 */

const deprecationWarnings = new Set<string>()

type EnvCompatResult<T> = {
  value: T | undefined
  source: 'canonical' | 'legacy' | 'default' | 'unset'
  legacyUsed: boolean
}

/**
 * Safely compare secret values without exposing them.
 * Uses constant-time comparison to prevent timing attacks.
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
 * Resolve an environment variable with canonical/legacy support.
 *
 * @param canonical - Canonical variable name (WORKBENCH_*)
 * @param legacy - Legacy variable name (BUILDFLOW_*)
 * @param defaultValue - Optional default value
 * @param isSecret - If true, never log or expose values
 * @returns { value, source, legacyUsed }
 * @throws If canonical and legacy values conflict
 */
export function resolveEnvVar(
  canonical: string,
  legacy: string,
  defaultValue?: string,
  isSecret = false
): EnvCompatResult<string> {
  const canonicalValue = process.env[canonical]
  const legacyValue = process.env[legacy]

  // Both set: check for conflict
  if (canonicalValue && legacyValue) {
    if (!secretsEqual(canonicalValue, legacyValue)) {
      throw new Error(
        `Conflicting environment variables: ${canonical} and ${legacy} are both set with different values. ` +
          `Remove the legacy ${legacy}.`
      )
    }
    // Both identical: use canonical
    return {
      value: canonicalValue,
      source: 'canonical',
      legacyUsed: false
    }
  }

  // Canonical only: use it
  if (canonicalValue) {
    return {
      value: canonicalValue,
      source: 'canonical',
      legacyUsed: false
    }
  }

  // Legacy only: use it with deprecation warning
  if (legacyValue) {
    emitDeprecationWarning(legacy, canonical)
    return {
      value: legacyValue,
      source: 'legacy',
      legacyUsed: true
    }
  }

  // Neither: use default
  if (defaultValue !== undefined) {
    return {
      value: defaultValue,
      source: 'default',
      legacyUsed: false
    }
  }

  return {
    value: undefined,
    source: 'unset',
    legacyUsed: false
  }
}

/**
 * Simplified resolver: returns just the string value.
 * Uses resolveEnvVar internally but unwraps the result.
 */
export function resolveEnvVariable(
  canonical: string,
  legacy: string,
  defaultValue?: string,
  isSecret = false
): string | undefined {
  return resolveEnvVar(canonical, legacy, defaultValue, isSecret).value
}

function emitDeprecationWarning(legacyVar: string, canonicalVar: string): void {
  if (deprecationWarnings.has(legacyVar)) return
  deprecationWarnings.add(legacyVar)
  console.warn(`[deprecated] ${legacyVar} is supported temporarily; use ${canonicalVar}.`)
}

/**
 * Resolve backend mode (direct-agent or relay-agent).
 * Validates that invalid modes fail rather than silently falling back.
 */
export function getBackendMode(): 'direct-agent' | 'relay-agent' {
  const result = resolveEnvVar('WORKBENCH_BACKEND_MODE', 'BUILDFLOW_BACKEND_MODE', 'direct-agent')
  const mode = result.value as 'direct-agent' | 'relay-agent' | undefined

  if (mode && !['direct-agent', 'relay-agent'].includes(mode)) {
    throw new Error(`Invalid backend mode: "${mode}". Must be one of: direct-agent, relay-agent.`)
  }

  return mode || 'direct-agent'
}

/**
 * Resolve action token (shared token for both direct and relay modes).
 * Secret: never expose the value in logs or errors.
 */
export function getActionToken(): string | null {
  return resolveEnvVariable('WORKBENCH_ACTION_TOKEN', 'BUILDFLOW_ACTION_TOKEN', undefined, true) ?? null
}

/**
 * Resolve web server mode (production, start, or dev).
 * Validates that invalid modes fail rather than silently falling back.
 */
export function getWebServerMode(): 'production' | 'start' | 'dev' {
  const result = resolveEnvVar('WORKBENCH_WEB_SERVER_MODE', 'BUILDFLOW_WEB_SERVER_MODE', 'production')
  const mode = result.value as 'production' | 'start' | 'dev' | undefined

  if (mode && !['production', 'start', 'dev'].includes(mode)) {
    throw new Error(`Invalid web server mode: "${mode}". Must be one of: production, start, dev.`)
  }

  return mode || 'production'
}

/**
 * Resolve agent server mode (production or dev).
 * Validates that invalid modes fail rather than silently falling back.
 */
export function getAgentServerMode(): 'production' | 'dev' {
  const result = resolveEnvVar('WORKBENCH_AGENT_SERVER_MODE', 'BUILDFLOW_AGENT_SERVER_MODE', 'dev')
  const mode = result.value as 'production' | 'dev' | undefined

  if (mode && !['production', 'dev'].includes(mode)) {
    throw new Error(`Invalid agent server mode: "${mode}". Must be one of: production, dev.`)
  }

  return mode || 'dev'
}

/**
 * Resolve build SHA — delegates to shared module resolver.
 * Metadata: safe to log (non-secret).
 */
export function getBuildSha(): string {
  const value = resolveEnvVariable('WORKBENCH_BUILD_SHA', 'BUILDFLOW_BUILD_SHA', 'unknown')
  return value || 'unknown'
}

/**
 * Resolve build timestamp — delegates to shared module resolver.
 * Metadata: safe to log (non-secret).
 */
export function getBuildTimestamp(): string {
  const value = resolveEnvVariable('WORKBENCH_BUILD_TIMESTAMP', 'BUILDFLOW_BUILD_TIMESTAMP', 'unknown')
  return value || 'unknown'
}

/**
 * Resolve action diagnostics flag — delegates to shared module resolver.
 */
export function getActionDiagnostics(): boolean {
  const value = resolveEnvVariable('WORKBENCH_ACTION_DIAGNOSTICS', 'BUILDFLOW_ACTION_DIAGNOSTICS', '0')
  return value === '1'
}

/**
 * Resolve API base URL — delegates to shared module resolver.
 */
export function getApiBaseUrl(): string {
  const value = resolveEnvVariable('WORKBENCH_API', 'BUILDFLOW_API', 'http://localhost:3000')
  return value || 'http://localhost:3000'
}
