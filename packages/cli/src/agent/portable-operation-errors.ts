export type PortableOperationErrorCode = 'invalid_request' | 'unknown_operation' | 'source_mismatch' | 'session_invalid' | 'confirmation_required' | 'invalid_confirmation' | 'stale_head' | 'protected_path_rejected' | 'deadline_exceeded' | 'cancelled' | 'dependency_unavailable' | 'policy_rejected' | 'command_failed' | 'internal_error'
export class PortableOperationError extends Error {
  readonly code: PortableOperationErrorCode
  readonly details?: Record<string, unknown>
  readonly retryable?: boolean
  readonly requiresConfirmation?: boolean
  readonly confirmationToken?: string
  constructor(code: PortableOperationErrorCode, message: string, options: { details?: Record<string, unknown>; retryable?: boolean; requiresConfirmation?: boolean; confirmationToken?: string } = {}) { super(message); this.name = 'PortableOperationError'; this.code = code; this.details = options.details; this.retryable = options.retryable; this.requiresConfirmation = options.requiresConfirmation; this.confirmationToken = options.confirmationToken }
}
