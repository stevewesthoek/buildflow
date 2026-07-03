const DIRECT_FILE_CHANGE_TYPES = new Set([
  'create',
  'overwrite',
  'patch',
  'append',
  'delete_file',
  'move'
])

export function requiresVerifiedFileWrite(changeType: unknown, isDryRun: boolean): boolean {
  return !isDryRun && typeof changeType === 'string' && DIRECT_FILE_CHANGE_TYPES.has(changeType)
}
