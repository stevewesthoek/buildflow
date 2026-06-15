/**
 * Environment variable compatibility layer for Next.js web app.
 * Uses shared @workbench/shared module for core resolver logic.
 * Web app also re-exports for test convenience.
 */

import { resolveEnvVariable as sharedResolveEnvVariable } from '@workbench/shared'

// Re-export for tests
export const resolveEnvVariable = sharedResolveEnvVariable

/**
 * Resolve backend mode (direct-agent or relay-agent).
 * Validates that invalid modes fail rather than silently falling back.
 */
export function getBackendMode(): 'direct-agent' | 'relay-agent' {
  const mode = sharedResolveEnvVariable('WORKBENCH_BACKEND_MODE', 'BUILDFLOW_BACKEND_MODE', 'direct-agent') as
    | 'direct-agent'
    | 'relay-agent'
    | undefined

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
  return sharedResolveEnvVariable('WORKBENCH_ACTION_TOKEN', 'BUILDFLOW_ACTION_TOKEN') ?? null
}

/**
 * Resolve web server mode (production, start, or dev).
 * Validates that invalid modes fail rather than silently falling back.
 */
export function getWebServerMode(): 'production' | 'start' | 'dev' {
  const mode = sharedResolveEnvVariable('WORKBENCH_WEB_SERVER_MODE', 'BUILDFLOW_WEB_SERVER_MODE', 'production') as
    | 'production'
    | 'start'
    | 'dev'
    | undefined

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
  const mode = sharedResolveEnvVariable('WORKBENCH_AGENT_SERVER_MODE', 'BUILDFLOW_AGENT_SERVER_MODE', 'dev') as
    | 'production'
    | 'dev'
    | undefined

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
  const value = sharedResolveEnvVariable('WORKBENCH_BUILD_SHA', 'BUILDFLOW_BUILD_SHA', 'unknown')
  return value || 'unknown'
}

/**
 * Resolve build timestamp — delegates to shared module resolver.
 * Metadata: safe to log (non-secret).
 */
export function getBuildTimestamp(): string {
  const value = sharedResolveEnvVariable('WORKBENCH_BUILD_TIMESTAMP', 'BUILDFLOW_BUILD_TIMESTAMP', 'unknown')
  return value || 'unknown'
}

/**
 * Resolve action diagnostics flag — delegates to shared module resolver.
 */
export function getActionDiagnostics(): boolean {
  const value = sharedResolveEnvVariable('WORKBENCH_ACTION_DIAGNOSTICS', 'BUILDFLOW_ACTION_DIAGNOSTICS', '0')
  return value === '1'
}

/**
 * Resolve API base URL — delegates to shared module resolver.
 */
export function getApiBaseUrl(): string {
  const value = sharedResolveEnvVariable('WORKBENCH_API', 'BUILDFLOW_API', 'http://localhost:3000')
  return value || 'http://localhost:3000'
}
