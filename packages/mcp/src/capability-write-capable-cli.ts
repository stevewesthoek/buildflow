import {
  validateCliCapabilityManifest,
  type CapabilityManifestValidationIssue,
  type CliCapabilityManifest
} from '@workbench/shared'
import type {
  CapabilityJobHandler,
  CapabilityJobHandlerContext,
  CapabilityJobHandlerResult
} from './capability-execution-coordinator.js'

/**
 * R18.4 is a packet-backed write mode. The CLI declaration identifies the
 * configured local adapter, while the packet remains the only write plan that
 * may cross into the CLI-side executor.
 */
export const WRITE_CAPABLE_CLI_MAX_PATHS = 5
export const WRITE_CAPABLE_CLI_MAX_PACKET_BYTES = 64 * 1024

export type WriteCapableCliManifestValidationResult =
  | Readonly<{ ok: true; value: CliCapabilityManifest }>
  | Readonly<{
      ok: false
      issues: readonly CapabilityManifestValidationIssue[]
      message: string
    }>

export type WriteCapableCliExecutionInput = Readonly<{
  context: CapabilityJobHandlerContext
  packet: unknown
  authorizedPaths: readonly string[]
}>

export type WriteCapableCliPacketExecutor = (
  input: WriteCapableCliExecutionInput
) => Promise<CapabilityJobHandlerResult>

type RecordValue = Record<string, unknown>

function record(value: unknown): value is RecordValue {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function issue(path: string, code: string, message: string): CapabilityManifestValidationIssue {
  return { path, code, message }
}

function validationMessage(issues: readonly CapabilityManifestValidationIssue[]): string {
  return `Write-capable CLI capability manifest invalid: ${issues.slice(0, 12).map(item => `${item.path} ${item.message}`).join(' ')}`
}

function closedInputHasPacketShape(manifest: CliCapabilityManifest): boolean {
  const schema = manifest.inputSchema
  if (!record(schema) || schema.type !== 'object' || schema.additionalProperties !== false || !record(schema.properties)) return false
  const properties = schema.properties
  const required = Array.isArray(schema.required) ? [...schema.required].sort() : []
  return JSON.stringify(Object.keys(properties).sort()) === JSON.stringify(['packet', 'writePaths'])
    && JSON.stringify(required) === JSON.stringify(['packet', 'writePaths'])
    && properties.writePaths?.type === 'array'
    && properties.writePaths.items?.type === 'string'
    && properties.writePaths.maxItems === WRITE_CAPABLE_CLI_MAX_PATHS
    && properties.packet?.type === 'object'
}

export function validateWriteCapableCliCapabilityManifest(value: unknown): WriteCapableCliManifestValidationResult {
  const base = validateCliCapabilityManifest(value)
  if (!base.ok) return { ok: false, issues: base.issues, message: base.message }

  const manifest = base.value
  const issues: CapabilityManifestValidationIssue[] = []
  if (manifest.writePolicy.mode !== 'explicit-paths') {
    issues.push(issue('writePolicy.mode', 'explicit_paths_required', 'must be explicit-paths; a mode name never grants a broad source write scope.'))
  }
  if (manifest.pathPolicy.mode !== 'source-relative') {
    issues.push(issue('pathPolicy.mode', 'source_relative_required', 'must be source-relative for packet-backed source writes.'))
  }
  if (manifest.pathPolicy.maxPaths < 1 || manifest.pathPolicy.maxPaths > WRITE_CAPABLE_CLI_MAX_PATHS) {
    issues.push(issue('pathPolicy.maxPaths', 'bounded_path_count_required', `must be between 1 and ${WRITE_CAPABLE_CLI_MAX_PATHS}.`))
  }
  if (manifest.writePolicy.maxFiles < 1 || manifest.writePolicy.maxFiles > WRITE_CAPABLE_CLI_MAX_PATHS) {
    issues.push(issue('writePolicy.maxFiles', 'bounded_write_count_required', `must be between 1 and ${WRITE_CAPABLE_CLI_MAX_PATHS}.`))
  }
  if (manifest.networkPolicy.mode !== 'denied') {
    issues.push(issue('networkPolicy.mode', 'network_not_allowed', 'must be denied for write-capable CLI execution.'))
  }
  if (manifest.cli.shell !== false) {
    issues.push(issue('cli.shell', 'shell_not_allowed', 'must be false for write-capable CLI execution.'))
  }
  if (manifest.cli.environment.mode !== 'minimal' || manifest.cli.environment.inheritedKeys.length !== 0) {
    issues.push(issue('cli.environment', 'ambient_environment', 'must use minimal environment with no inherited keys.'))
  }
  if (manifest.cwdPolicy.mode !== 'source-root') {
    issues.push(issue('cwdPolicy.mode', 'cwd_not_bounded', 'must be source-root; callers cannot select an arbitrary cwd.'))
  }
  if (manifest.confirmation.mode !== 'required') {
    issues.push(issue('confirmation.mode', 'confirmation_required', 'must require one explicit confirmation for source writes.'))
  }
  if (manifest.validation.mode !== 'required' || !manifest.validation.checks.includes('verifier')) {
    issues.push(issue('validation', 'validation_required', 'must require a declared deterministic verifier before success.'))
  }
  if (!closedInputHasPacketShape(manifest)) {
    issues.push(issue('inputSchema', 'closed_packet_input_required', 'must accept exactly writePaths and packet in a closed schema.'))
  }
  if (manifest.cli.argv.some(template => template.kind !== 'literal')) {
    issues.push(issue('cli.argv', 'arbitrary_argv_not_allowed', 'must contain only fixed literal arguments; packet fields are not CLI argv authority.'))
  }

  return issues.length > 0
    ? { ok: false, issues, message: validationMessage(issues) }
    : { ok: true, value: manifest }
}

function failure(context: CapabilityJobHandlerContext, code: string, message: string): CapabilityJobHandlerResult {
  return {
    status: 'failed',
    resultRef: `workbench://capability-jobs/${context.job.jobId}/result`,
    evidenceRef: context.job.evidenceRef,
    failure: { code, message: message.slice(0, 1_000), retryable: false }
  }
}

/**
 * The MCP package owns the mode admission contract. The CLI package supplies
 * the packet executor so MCP never imports CLI stores or creates a second
 * mutation path.
 */
export function createWriteCapableCliCapabilityHandler(
  manifest: CliCapabilityManifest,
  executePacket: WriteCapableCliPacketExecutor
): CapabilityJobHandler {
  const validation = validateWriteCapableCliCapabilityManifest(manifest)
  if (!validation.ok) throw new Error(validation.message)

  return async context => {
    if (context.signal.aborted) return { status: 'cancelled', failure: { code: 'cancelled', message: 'Write-capable CLI job was cancelled before packet execution.', retryable: false } }
    if (!record(context.input) || !('packet' in context.input)) return failure(context, 'packet_input_missing', 'Write-capable CLI execution requires a bounded packet input.')
    const authorizedPaths = context.authorized.writePaths.map(item => item.relative)
    if (authorizedPaths.length === 0) return failure(context, 'write_scope_missing', 'Write-capable CLI execution requires at least one authorized write path.')
    context.reportStep('packet-preflight')
    return executePacket({ context, packet: context.input.packet, authorizedPaths })
  }
}

export const writeCapableCliRuntimeContract = Object.freeze({
  mode: 'write-capable-cli',
  authority: 'packet-preflight-and-cli-side-executor',
  pathScope: 'explicit-source-relative-paths',
  shell: false,
  arbitraryArgv: false,
  inheritedEnvironment: false,
  network: 'denied',
  cwd: 'source-root',
  confirmation: 'one-exact-persisted-phase16-decision',
  validation: 'canonical-packet-validation-before-success',
  git: 'exact-path-only-no-push'
})
