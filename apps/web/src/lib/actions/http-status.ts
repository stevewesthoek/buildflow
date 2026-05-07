// Determine safe HTTP status code for action errors
export function getSafeActionHttpStatus(error: unknown): number {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code
    if (code === 'REQUIRES_EXPLICIT_CONFIRMATION') return 200
    return 403
  }
  return 403
}
