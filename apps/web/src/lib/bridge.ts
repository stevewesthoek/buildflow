import { TOOL_CALL_TIMEOUT } from '@workbench/shared'

// Bridge manager for Next.js API routes
// Actual WebSocket bridge runs in separate packages/bridge/ server
// This stub keeps API routes type-safe

interface PendingCall {
  resolve: (value: Record<string, unknown>) => void
  reject: (err: Error) => void
  timeout: NodeJS.Timeout
}

export class BridgeManager {
  private pendingCalls: Map<string, PendingCall> = new Map()

  async callTool(
    deviceId: string,
    tool: string,
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    // For MVP: This would connect to the standalone bridge server
    // For now, return error directing users to run bridge separately
    throw new Error(
      'WebSocket bridge not connected. Ensure the bridge server is running on port 3002.'
    )
  }
}

export const bridgeManager = new BridgeManager()
