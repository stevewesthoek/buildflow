import { getBackendMode as getBackendModeCompat, getActionToken as getActionTokenCompat } from '../env-compat'

export type BackendMode = 'direct-agent' | 'relay-agent'

export function getBackendMode(): BackendMode {
  return getBackendModeCompat()
}

export function getActionToken(): string | null {
  return getActionTokenCompat()
}

export function getRelayProxyToken(): string | null {
  // Prefer the Workbench token name while keeping the BuildFlow variable as a compatibility fallback.
  return getActionToken()
}

export function getBackendUrl(): string {
  const mode = getBackendMode()

  if (mode === 'direct-agent') {
    return process.env.LOCAL_AGENT_URL || 'http://127.0.0.1:3052'
  }

  if (mode === 'relay-agent') {
    return 'http://127.0.0.1:3053/api/actions/proxy'
  }

  throw new Error('Unknown backend mode')
}

export function getBackendDebugInfo(): { mode: BackendMode; url: string } {
  const mode = getBackendMode()
  const url = getBackendUrl()
  return { mode, url }
}
