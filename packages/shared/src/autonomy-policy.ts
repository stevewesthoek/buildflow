/**
 * R16.1: the auditable policy-data foundation for autonomy levels.
 *
 * This registry describes grants; it is deliberately not an execution
 * evaluator. Existing command, path, session, capability, network, and
 * release guards remain authoritative until a later, explicitly scoped phase.
 */
export const AUTONOMY_LEVELS = [0, 1, 2, 3, 4, 5, 6] as const
export type AutonomyLevel = typeof AUTONOMY_LEVELS[number]

export const AUTONOMY_PERMISSION_CATEGORIES = [
  'read', 'write', 'command', 'git', 'network', 'capability', 'release'
] as const
export type AutonomyPermissionCategory = typeof AUTONOMY_PERMISSION_CATEGORIES[number]
export type AutonomyGrantDecision = 'allowed' | 'allowed_with_confirmation' | 'denied'

export type AutonomyGrant = Readonly<{
  allowed: readonly string[]
  confirmationRequired: readonly string[]
  denied: readonly string[]
}>

export type AutonomyPolicy = Readonly<{
  level: AutonomyLevel
  id: string
  label: string
  description: string
  grants: Readonly<Record<AutonomyPermissionCategory, AutonomyGrant>>
}>

const denyAll = (): AutonomyGrant => ({ allowed: [], confirmationRequired: [], denied: ['*'] })
const grant = (allowed: string[] = [], confirmationRequired: string[] = []): AutonomyGrant => ({
  allowed, confirmationRequired, denied: ['*']
})

const readOnly = (extra: string[] = []): AutonomyGrant => grant([
  'get_workbench_status', 'read_workbench_context', ...extra
])
const writeOperations = [
  'create_file', 'patch_file', 'append_file', 'overwrite_file', 'move_file',
  'rename_file', 'delete_file', 'delete_directory', 'mkdir', 'rmdir'
]
const allDenied = (): Record<AutonomyPermissionCategory, AutonomyGrant> => ({
  read: denyAll(), write: denyAll(), command: denyAll(), git: denyAll(),
  network: denyAll(), capability: denyAll(), release: denyAll()
})
const policy = (
  level: AutonomyLevel,
  id: string,
  label: string,
  description: string,
  overrides: Partial<Record<AutonomyPermissionCategory, AutonomyGrant>>
): AutonomyPolicy => Object.freeze({ level, id, label, description, grants: Object.freeze({ ...allDenied(), ...overrides }) })

export const AUTONOMY_POLICIES: readonly AutonomyPolicy[] = Object.freeze([
  policy(0, 'observe', 'Observe', 'Read basic status and context only.', { read: readOnly() }),
  policy(1, 'inspect', 'Inspect', 'Read status, context, and non-sensitive repository metadata.', {
    read: readOnly(['read_source_metadata', 'read_evidence_metadata'])
  }),
  policy(2, 'supervised_edit', 'Supervised edit', 'Prepare bounded edits and validation under confirmation.', {
    read: readOnly(['read_source_metadata', 'read_evidence_metadata']),
    write: grant([], ['create_file', 'patch_file', 'append_file']),
    command: grant(['git_status_short', 'git_diff_stat', 'git_diff_name_only', 'git_diff'], ['type_check_web', 'type_check_cli', 'run_package_test']),
    git: grant(['git_status_short', 'git_diff_stat', 'git_diff_name_only', 'git_diff'], ['git_add_paths'])
  }),
  policy(3, 'supervised_commit', 'Supervised commit', 'Commit exact, reviewed paths under confirmation.', {
    read: readOnly(['read_source_metadata', 'read_evidence_metadata']),
    write: grant([], ['create_file', 'patch_file', 'append_file', 'overwrite_file', 'move_file']),
    command: grant(['git_status_short', 'git_diff_stat', 'git_diff_name_only', 'git_diff', 'type_check_web', 'type_check_cli', 'run_package_test'], ['run_exact_command']),
    git: grant(['git_status_short', 'git_diff_stat', 'git_diff_name_only', 'git_diff'], ['git_add_paths', 'git_commit'])
  }),
  policy(4, 'bounded_operator', 'Bounded operator', 'Run allowlisted local operations with explicit confirmation.', {
    read: readOnly(['read_source_metadata', 'read_evidence_metadata']),
    write: grant([], ['create_file', 'patch_file', 'append_file', 'overwrite_file', 'move_file']),
    command: grant(['git_status_short', 'git_diff_stat', 'git_diff_name_only', 'git_diff', 'type_check_web', 'type_check_cli', 'run_package_test'], ['run_exact_command', 'security_scan_paths']),
    git: grant(['git_status_short', 'git_diff_stat', 'git_diff_name_only', 'git_diff'], ['git_add_paths', 'git_commit']),
    network: grant([], ['github_read']),
    capability: grant([], ['approved_capability'])
  }),
  policy(5, 'approved_capability', 'Approved capability', 'Use an explicitly approved capability within its existing guardrails.', {
    read: readOnly(['read_source_metadata', 'read_evidence_metadata']),
    write: grant([], ['create_file', 'patch_file', 'append_file', 'overwrite_file', 'move_file']),
    command: grant(['git_status_short', 'git_diff_stat', 'git_diff_name_only', 'git_diff', 'type_check_web', 'type_check_cli', 'run_package_test'], ['run_exact_command', 'security_scan_paths']),
    git: grant(['git_status_short', 'git_diff_stat', 'git_diff_name_only', 'git_diff'], ['git_add_paths', 'git_commit']),
    network: grant([], ['github_read', 'approved_network_request']),
    capability: grant([], ['approved_capability', 'n8n_workflow_export'])
  }),
  policy(6, 'release_operator', 'Release operator', 'Prepare a guarded release operation under explicit confirmation.', {
    read: readOnly(['read_source_metadata', 'read_evidence_metadata']),
    write: grant([], writeOperations),
    command: grant(['git_status_short', 'git_diff_stat', 'git_diff_name_only', 'git_diff', 'type_check_web', 'type_check_cli', 'run_package_test'], ['run_exact_command', 'security_scan_paths']),
    git: grant(['git_status_short', 'git_diff_stat', 'git_diff_name_only', 'git_diff'], ['git_add_paths', 'git_commit', 'git_push']),
    network: grant([], ['github_read', 'approved_network_request']),
    capability: grant([], ['approved_capability', 'n8n_workflow_export']),
    release: grant([], ['install_promote', 'restart'])
  })
])

const categorySet = new Set<string>(AUTONOMY_PERMISSION_CATEGORIES)
const levelSet = new Set<number>(AUTONOMY_LEVELS)

export function getAutonomyPolicy(level: unknown): AutonomyPolicy | undefined {
  if (!Number.isInteger(level) || !levelSet.has(level as number)) return undefined
  return AUTONOMY_POLICIES.find(item => item.level === level)
}

export function decideAutonomyGrant(policyValue: unknown, category: unknown, operation: unknown): AutonomyGrantDecision {
  if (!policyValue || typeof policyValue !== 'object' || !categorySet.has(String(category)) || typeof operation !== 'string' || !operation) return 'denied'
  const grants = (policyValue as { grants?: unknown }).grants
  if (!grants || typeof grants !== 'object') return 'denied'
  const value = (grants as Record<string, unknown>)[String(category)]
  if (!value || typeof value !== 'object') return 'denied'
  const grantValue = value as Partial<AutonomyGrant>
  if (grantValue.confirmationRequired?.includes(operation)) return 'allowed_with_confirmation'
  if (grantValue.allowed?.includes(operation)) return 'allowed'
  if (grantValue.denied?.includes(operation) || grantValue.denied?.includes('*')) return 'denied'
  return 'denied'
}

export function serializeAutonomyPolicies(): string {
  return JSON.stringify(AUTONOMY_POLICIES)
}
