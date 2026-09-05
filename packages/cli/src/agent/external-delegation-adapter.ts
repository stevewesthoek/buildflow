import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { ChildProcess, SpawnOptionsWithoutStdio } from 'node:child_process'
import type { DelegationEvidenceSummary, ExternalDelegationOperation } from './external-delegation'
import { manualDelegationFallback, projectDelegationStatus, validateDelegationEvidence } from './external-delegation'
import {
  createSubmissionIntent,
  evaluateProviderAdmission,
  reconcileProviderState,
  type ProviderStatusRecord,
  type SubmissionAcknowledgement,
  type SubmissionIntent,
  validateSubmissionAcknowledgement
} from './external-delegation-protocol'
import {
  getPersistedDelegationOperation,
  persistDelegationControls,
  persistDelegationTransition,
  type DelegationStoreOptions,
  type PersistedDelegationOperation
} from './external-delegation-store'
import { renderCodexPrompt, type PromptPacketTransportContract } from './prompt-packet-compiler'

export type DelegationAdapterCapability = {
  supported: boolean
  reasonCode: 'preview_only' | 'unsupported_executor' | 'network_transport_unavailable' | 'authorization_unavailable'
  manualFallback: true
  nextAction: string
}

export type DelegationAdapterPreview<T> = {
  performed: false
  capability: DelegationAdapterCapability
  preview?: T
}

export interface ExternalDelegationAdapter {
  capability(operation: ExternalDelegationOperation): DelegationAdapterCapability
  prepare(operation: ExternalDelegationOperation): DelegationAdapterPreview<ReturnType<typeof projectDelegationStatus>>
  submitPreview(operation: ExternalDelegationOperation): DelegationAdapterPreview<{ operationId: string; lifecycle: string; idempotencyKey: string }>
  statusReadback(operation: ExternalDelegationOperation): DelegationAdapterPreview<ReturnType<typeof projectDelegationStatus>>
  cancelPreview(operation: ExternalDelegationOperation): DelegationAdapterPreview<{ operationId: string; cancellation: 'requested' }>
  evidencePreview(operation: ExternalDelegationOperation, evidence: DelegationEvidenceSummary): DelegationAdapterPreview<DelegationEvidenceSummary>
  reconcilePreview(operation: ExternalDelegationOperation): DelegationAdapterPreview<{ operationId: string; reconciliation: string }>
}

function capability(reasonCode: DelegationAdapterCapability['reasonCode'] = 'preview_only'): DelegationAdapterCapability {
  const fallback = manualDelegationFallback('manual_fallback_required')
  return {
    supported: false,
    reasonCode,
    manualFallback: true,
    nextAction: fallback.nextAction
  }
}

export function createPreviewOnlyDelegationAdapter(): ExternalDelegationAdapter {
  return {
    capability: operation => capability(operation.executor.engine === 'codex' || operation.executor.engine === 'future_adapter' || operation.executor.engine === 'human' ? 'preview_only' : 'unsupported_executor'),
    prepare: operation => ({ performed: false, capability: capability(), preview: projectDelegationStatus(operation) }),
    submitPreview: operation => ({ performed: false, capability: capability('network_transport_unavailable'), preview: { operationId: operation.operationId, lifecycle: operation.lifecycle, idempotencyKey: operation.compiledIdempotencyKey } }),
    statusReadback: operation => ({ performed: false, capability: capability('network_transport_unavailable'), preview: projectDelegationStatus(operation) }),
    cancelPreview: operation => ({ performed: false, capability: capability('network_transport_unavailable'), preview: { operationId: operation.operationId, cancellation: 'requested' } }),
    evidencePreview: (operation, evidence) => {
      const validated = validateDelegationEvidence(operation, evidence)
      return validated.ok
        ? { performed: false, capability: capability('network_transport_unavailable'), preview: validated.evidence }
        : { performed: false, capability: capability('network_transport_unavailable') }
    },
    reconcilePreview: operation => ({ performed: false, capability: capability('network_transport_unavailable'), preview: { operationId: operation.operationId, reconciliation: operation.reconciliation } })
  }
}

export type CodexDelegationIsolation = 'read_only' | 'worktree'

export type CodexDelegationInput = {
  operation: PersistedDelegationOperation
  contract: PromptPacketTransportContract
  sourceRoot: string
  branch: string
  ownerSessionId: string
  isolation: CodexDelegationIsolation
}

export type CodexDelegationCapability = {
  supported: boolean
  adapterIdentity: 'codex-cli'
  command: string
  version?: string
  supportsIsolation: true
  supportsWorkbenchMcp: true
  supportsCancellation: true
  supportsStatusReadback: true
  supportsReconciliation: true
  manualFallback: true
  reasonCode: 'ready' | 'unsupported_executor' | 'network_transport_unavailable'
  nextAction: string
}

export type CodexDelegationBinding = {
  sourceId: string
  repositoryRoot: string
  branch: string
  expectedHead: string
  runId: string
  taskId: string
  packetId: string
  ownerSessionId: string
  isolation: CodexDelegationIsolation
}

export type CodexDelegationResult = {
  operationId: string
  providerOperationIdentity: string
  lifecycle: 'completed' | 'failed' | 'cancelled' | 'ambiguous'
  exitCode?: number
  signal?: string
  changedPaths: string[]
  validationEvidence: string[]
  commitIdentity?: string
  warnings: string[]
  errors: string[]
  summary?: string
  durationMs: number
  auditReferences: string[]
  provenanceReferences: string[]
}

export type CodexDelegationActivity = {
  operationId: string
  lifecycle: 'submitted' | 'running' | 'cancellation_requested' | 'completed' | 'failed' | 'cancelled' | 'ambiguous'
  sourceId: string
  runId: string
  taskId: string
  packetId: string
  changedPaths?: string[]
  commitIdentity?: string
}

export type CodexDelegationStatus = {
  operation: PersistedDelegationOperation
  providerStatus?: ProviderStatusRecord
  result?: CodexDelegationResult
}

type SpawnedProcess = Pick<ChildProcess, 'stdin' | 'stdout' | 'stderr' | 'once' | 'on' | 'kill'>

type CodexAdapterOptions = {
  command?: string
  timeoutMs?: number
  maxOutputBytes?: number
  storeOptions?: DelegationStoreOptions
  now?: () => Date
  probeCommand?: (command: string) => { available: boolean; version?: string }
  gitProbe?: (sourceRoot: string, args: string[]) => string
  spawnProcess?: (command: string, args: string[], options: SpawnOptionsWithoutStdio & { stdio: ['pipe', 'pipe', 'pipe'] }) => SpawnedProcess
  onLifecycle?: (activity: CodexDelegationActivity) => void
}

type ActiveCodexExecution = {
  input: CodexDelegationInput
  operation: PersistedDelegationOperation
  intent: SubmissionIntent
  acknowledgement: SubmissionAcknowledgement
  child: SpawnedProcess
  providerOperationIdentity: string
  startedAt: number
  stdout: string
  stdoutRemainder: string
  stderr: string
  changedPaths: string[]
  validationEvidence: string[]
  summary?: string
  commitIdentity?: string
  threadId?: string
  cancellationRequested: boolean
  settled: boolean
  result?: CodexDelegationResult
}

const CODEX_ADAPTER_ID = 'codex-cli'
const DEFAULT_TIMEOUT_MS = 10 * 60_000
const MAX_PROMPT_BYTES = 8_000
const MAX_OUTPUT_BYTES = 128 * 1024
const MAX_RESULT_TEXT = 240

function bounded(value: unknown, max = MAX_RESULT_TEXT): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized ? normalized.slice(0, max) : undefined
}

function safeList(values: string[], maxItems = 24, maxLength = 512): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].slice(0, maxItems).map(value => value.slice(0, maxLength))
}

function appendBounded(current: string, chunk: string, maxBytes: number): string {
  const next = `${current}${chunk}`
  if (Buffer.byteLength(next, 'utf8') <= maxBytes) return next
  return Buffer.from(next, 'utf8').subarray(0, maxBytes).toString('utf8')
}

function realCodexProbe(command: string): { available: boolean; version?: string } {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: false, timeout: 2_000 })
  if (result.status !== 0) return { available: false }
  const help = spawnSync(command, ['exec', '--help'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: false, timeout: 2_000 })
  if (help.status !== 0 || !['--json', '--ephemeral', '--sandbox', '-C'].every(flag => String(help.stdout || '').includes(flag))) return { available: false }
  return { available: true, version: bounded(result.stdout) }
}

function realGitProbe(sourceRoot: string, args: string[]): string {
  return execFileSync('git', args, { cwd: sourceRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: false, timeout: 3_000 }).trim()
}

function realSpawnProcess(command: string, args: string[], options: SpawnOptionsWithoutStdio & { stdio: ['pipe', 'pipe', 'pipe'] }): SpawnedProcess {
  return spawn(command, args, options)
}

function codexCapability(options: CodexAdapterOptions): CodexDelegationCapability {
  const command = options.command || process.env.CODEX_CLI_PATH || 'codex'
  const probe = (options.probeCommand || realCodexProbe)(command)
  if (!probe.available) {
    return {
      supported: false,
      adapterIdentity: CODEX_ADAPTER_ID,
      command,
      supportsIsolation: true,
      supportsWorkbenchMcp: true,
      supportsCancellation: true,
      supportsStatusReadback: true,
      supportsReconciliation: true,
      manualFallback: true,
      reasonCode: 'network_transport_unavailable',
      nextAction: 'Use the manual bounded packet fallback until the local Codex CLI is available.'
    }
  }
  return {
    supported: true,
    adapterIdentity: CODEX_ADAPTER_ID,
    command,
    ...(probe.version ? { version: probe.version } : {}),
    supportsIsolation: true,
    supportsWorkbenchMcp: true,
    supportsCancellation: true,
    supportsStatusReadback: true,
    supportsReconciliation: true,
    manualFallback: true,
    reasonCode: 'ready',
    nextAction: 'Submit the admitted bounded packet through Codex CLI.'
  }
}

function transition(options: CodexAdapterOptions, operation: PersistedDelegationOperation, next: Parameters<typeof persistDelegationTransition>[0]['next']): PersistedDelegationOperation {
  const result = persistDelegationTransition({
    operationId: operation.operationId,
    expectedRevision: operation.revision,
    next,
    now: (options.now || (() => new Date()))().toISOString(),
    options: options.storeOptions
  })
  if (result.ok !== true) throw new Error(result.message)
  return result.operation
}

function updateControls(options: CodexAdapterOptions, operation: PersistedDelegationOperation, controls: Parameters<typeof persistDelegationControls>[0]): PersistedDelegationOperation {
  const result = persistDelegationControls({ ...controls, operationId: operation.operationId, expectedRevision: operation.revision, now: (options.now || (() => new Date()))().toISOString(), options: options.storeOptions })
  if (result.ok !== true) throw new Error(result.message)
  return result.operation
}

function parseCodexEvent(execution: ActiveCodexExecution, line: string): void {
  let event: unknown
  try { event = JSON.parse(line) } catch { return }
  if (!event || typeof event !== 'object' || Array.isArray(event)) return
  const record = event as Record<string, unknown>
  if (record.type === 'thread.started' && typeof record.thread_id === 'string') execution.threadId = record.thread_id.slice(0, 160)
  const item = record.item && typeof record.item === 'object' ? record.item as Record<string, unknown> : undefined
  if (item) {
    const itemType = typeof item.type === 'string' ? item.type : 'unknown_item'
    execution.validationEvidence = safeList([...execution.validationEvidence, `${itemType}:${typeof item.status === 'string' ? item.status : 'observed'}`], 24, 160)
    const summary = bounded(item.text) || bounded(item.message) || bounded(item.summary)
    if (summary) execution.summary = summary
    if (typeof item.commit === 'string') execution.commitIdentity = item.commit.slice(0, 128)
    if (typeof item.commitIdentity === 'string') execution.commitIdentity = item.commitIdentity.slice(0, 128)
    const paths: string[] = []
    if (typeof item.path === 'string') paths.push(item.path)
    if (Array.isArray(item.changes)) {
      for (const change of item.changes) {
        if (change && typeof change === 'object' && typeof (change as Record<string, unknown>).path === 'string') paths.push((change as Record<string, unknown>).path as string)
      }
    }
    execution.changedPaths = safeList([...execution.changedPaths, ...paths])
  }
  const error = bounded(record.error) || bounded(record.message)
  if (record.type === 'error' && error) execution.stderr = appendBounded(execution.stderr, error, MAX_OUTPUT_BYTES)
}

function bindingFor(input: CodexDelegationInput, gitProbe: (sourceRoot: string, args: string[]) => string): CodexDelegationBinding {
  if (!input.operation || input.operation.executor.engine !== 'codex') throw new Error('Codex delegation requires the codex executor.')
  if (input.operation.lifecycle !== 'admitted') throw new Error(`Codex delegation requires an admitted operation, found ${input.operation.lifecycle}.`)
  if (!input.ownerSessionId.trim()) throw new Error('Codex delegation owner session is required.')
  const prompt = renderCodexPrompt(input.contract)
  if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) throw new Error('Codex delegation prompt exceeds the bounded packet limit.')
  if (input.operation.sourceId !== input.contract.sourceId || input.operation.runId !== input.contract.runId || input.operation.taskId !== input.contract.taskId || input.operation.packetId !== input.contract.packetId || input.operation.expectedHead !== input.contract.expectedHead || input.operation.compiledContractHash !== input.contract.contentHash || input.operation.compiledIdempotencyKey !== input.contract.idempotencyKey) {
    throw new Error('Codex delegation contract identity does not match the persisted operation.')
  }
  const repositoryRoot = path.resolve(input.sourceRoot)
  if (!fs.existsSync(repositoryRoot) || !fs.statSync(repositoryRoot).isDirectory()) throw new Error('Codex delegation source root is unavailable.')
  const actualRoot = path.resolve(gitProbe(repositoryRoot, ['rev-parse', '--show-toplevel']))
  const actualBranch = gitProbe(repositoryRoot, ['branch', '--show-current'])
  const actualHead = gitProbe(repositoryRoot, ['rev-parse', 'HEAD'])
  if (actualRoot !== repositoryRoot) throw new Error('Codex delegation source root is not the repository root.')
  if (!input.branch || actualBranch !== input.branch) throw new Error('Codex delegation branch binding does not match the current branch.')
  if (!input.operation.expectedHead || actualHead !== input.operation.expectedHead) throw new Error('Codex delegation HEAD binding does not match the current HEAD.')
  if (input.isolation === 'worktree' && input.contract.restrictions.commitEnabled) {
    const gitDir = path.resolve(repositoryRoot, gitProbe(repositoryRoot, ['rev-parse', '--git-dir']))
    const commonDir = path.resolve(repositoryRoot, gitProbe(repositoryRoot, ['rev-parse', '--git-common-dir']))
    if (gitDir === commonDir) throw new Error('Mutation-capable Codex delegation requires an explicitly isolated worktree root.')
  }
  return {
    sourceId: input.operation.sourceId,
    repositoryRoot,
    branch: actualBranch,
    expectedHead: actualHead,
    runId: input.operation.runId,
    taskId: input.operation.taskId,
    packetId: input.operation.packetId,
    ownerSessionId: input.ownerSessionId.slice(0, 160),
    isolation: input.isolation
  }
}

function providerStatus(execution: ActiveCodexExecution, lifecycle: ProviderStatusRecord['lifecycle'], now: string): ProviderStatusRecord {
  return {
    providerOperationIdentity: execution.providerOperationIdentity,
    lifecycle,
    adapterIdentity: CODEX_ADAPTER_ID,
    observedAt: now,
    reasonCode: lifecycle,
    durationMs: Math.max(0, Date.now() - execution.startedAt),
    validationState: lifecycle === 'completed' ? 'passed' : lifecycle === 'failed' ? 'failed' : 'unknown'
  }
}

function resultFor(execution: ActiveCodexExecution, lifecycle: CodexDelegationResult['lifecycle'], exitCode?: number, signal?: string): CodexDelegationResult {
  return {
    operationId: execution.operation.operationId,
    providerOperationIdentity: execution.providerOperationIdentity,
    lifecycle,
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(signal ? { signal } : {}),
    changedPaths: safeList(execution.changedPaths),
    validationEvidence: safeList(execution.validationEvidence, 24, 160),
    warnings: safeList(execution.stderr ? ['Codex emitted bounded diagnostic output.'] : [], 8, 160),
    errors: safeList(lifecycle === 'failed' || lifecycle === 'ambiguous' ? ['Codex execution did not produce a verified successful terminal result.'] : [], 8, 160),
    ...(execution.summary ? { summary: execution.summary } : {}),
    ...(execution.commitIdentity ? { commitIdentity: execution.commitIdentity } : {}),
    durationMs: Math.max(0, Date.now() - execution.startedAt),
    auditReferences: [`delegation:${execution.operation.operationId}`, `packet:${execution.operation.packetId}`],
    provenanceReferences: [`source:${execution.operation.sourceId}`, `head:${execution.operation.expectedHead}`]
  }
}

function emitLifecycle(options: CodexAdapterOptions, execution: ActiveCodexExecution, lifecycle: CodexDelegationActivity['lifecycle'], result?: CodexDelegationResult): void {
  try {
    options.onLifecycle?.({
      operationId: execution.operation.operationId,
      lifecycle,
      sourceId: execution.operation.sourceId,
      runId: execution.operation.runId,
      taskId: execution.operation.taskId,
      packetId: execution.operation.packetId,
      ...(result?.changedPaths.length ? { changedPaths: result.changedPaths } : {}),
      ...(result?.commitIdentity ? { commitIdentity: result.commitIdentity } : {})
    })
  } catch {
    // Activity projection is best-effort and must never alter executor state.
  }
}

export type CodexDelegationAdapter = {
  capability(): CodexDelegationCapability
  prepare(input: CodexDelegationInput): { ok: true; binding: CodexDelegationBinding } | { ok: false; reason: string }
  submit(input: CodexDelegationInput): Promise<{ ok: true; operation: PersistedDelegationOperation; providerOperationIdentity: string } | { ok: false; reason: string }>
  statusReadback(operationId: string): CodexDelegationStatus | undefined
  cancel(operationId: string): { ok: true; operation: PersistedDelegationOperation } | { ok: false; reason: string }
  reconcile(operationId: string): CodexDelegationStatus | undefined
  evidence(operationId: string): CodexDelegationResult | undefined
}

export function createCodexDelegationAdapter(options: CodexAdapterOptions = {}): CodexDelegationAdapter {
  const active = new Map<string, ActiveCodexExecution>()
  const results = new Map<string, CodexDelegationResult>()
  const command = options.command || process.env.CODEX_CLI_PATH || 'codex'
  const timeoutMs = Math.max(5_000, Math.min(options.timeoutMs || DEFAULT_TIMEOUT_MS, 3_600_000))
  const maxOutputBytes = Math.max(8_192, Math.min(options.maxOutputBytes || MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES))
  const gitProbe = options.gitProbe || realGitProbe
  const spawnProcess = options.spawnProcess || realSpawnProcess

  const finalize = (execution: ActiveCodexExecution, lifecycle: CodexDelegationResult['lifecycle'], exitCode?: number, signal?: string): void => {
    if (execution.settled) return
    execution.settled = true
    active.delete(execution.operation.operationId)
    const now = (options.now || (() => new Date()))().toISOString()
    const provider = providerStatus(execution, lifecycle, now)
    const result = resultFor(execution, lifecycle, exitCode, signal)
    const reconciliation = reconcileProviderState({
      operation: execution.operation,
      intent: execution.intent,
      acknowledgement: execution.acknowledgement,
      status: provider,
      evidence: {
        operationId: result.operationId,
        packetId: execution.operation.packetId,
        resultStatus: result.lifecycle,
        validationState: lifecycle === 'completed' ? 'passed' : lifecycle === 'failed' ? 'failed' : 'unknown',
        ...(result.commitIdentity ? { commitIdentity: result.commitIdentity } : {}),
        durationMs: result.durationMs,
        reasonCode: provider.reasonCode
      }
    })
    const effectiveLifecycle = reconciliation.outcome === 'matched' ? lifecycle : 'ambiguous'
    const effectiveResult = effectiveLifecycle === lifecycle ? result : resultFor(execution, 'ambiguous', exitCode, signal)
    results.set(execution.operation.operationId, effectiveResult)
    try {
      const nextOperation = execution.operation.lifecycle === 'cancellation_requested'
        ? effectiveLifecycle === 'cancelled' ? transition(options, execution.operation, 'cancelled') : transition(options, execution.operation, 'ambiguous')
        : transition(options, execution.operation, effectiveLifecycle)
      execution.operation = updateControls(options, nextOperation, {
        operationId: nextOperation.operationId,
        expectedRevision: nextOperation.revision,
        evidence: {
          operationId: nextOperation.operationId,
          packetId: nextOperation.packetId,
          resultStatus: effectiveLifecycle,
          validationState: effectiveLifecycle === 'completed' ? 'passed' : effectiveLifecycle === 'failed' ? 'failed' : 'unknown',
          ...(effectiveResult.commitIdentity ? { commitIdentity: effectiveResult.commitIdentity } : {}),
          ...(effectiveResult.durationMs ? { durationMs: effectiveResult.durationMs } : {}),
          reasonCode: reconciliation.reasonCode
        },
        reconciliation: effectiveLifecycle === 'ambiguous' ? 'ambiguous' : 'matched',
        now
      })
    } catch {
      // A lost store write must never be presented as a verified terminal result.
      const current = getPersistedDelegationOperation(execution.operation.operationId, options.storeOptions)
      if (current && !['completed', 'failed', 'cancelled', 'ambiguous'].includes(current.lifecycle)) {
        try {
          const ambiguous = transition(options, current, 'ambiguous')
          execution.operation = updateControls(options, ambiguous, { operationId: ambiguous.operationId, expectedRevision: ambiguous.revision, reconciliation: 'ambiguous', now })
        } catch { /* caller must reconcile the persisted operation */ }
      }
    }
    emitLifecycle(options, execution, effectiveLifecycle, effectiveResult)
  }

  const start = (execution: ActiveCodexExecution): void => {
    execution.child.once('error', () => finalize(execution, 'failed'))
    execution.child.once('spawn', () => {
      if (execution.settled) return
      execution.operation = transition(options, execution.operation, 'running')
      emitLifecycle(options, execution, 'running')
    })
    execution.child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk)
      execution.stdout = appendBounded(execution.stdout, text, maxOutputBytes)
      if (Buffer.byteLength(execution.stdout, 'utf8') >= maxOutputBytes && !execution.settled) {
        execution.child.kill('SIGTERM')
        finalize(execution, 'ambiguous', undefined, 'SIGTERM')
        return
      }
      const combined = `${execution.stdoutRemainder}${text}`
      const lines = combined.split('\n')
      execution.stdoutRemainder = lines.pop() || ''
      for (const line of lines) parseCodexEvent(execution, line)
    })
    execution.child.stderr?.on('data', (chunk: Buffer | string) => { execution.stderr = appendBounded(execution.stderr, String(chunk), maxOutputBytes) })
    execution.child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (execution.settled) return
      if (execution.stdoutRemainder) parseCodexEvent(execution, execution.stdoutRemainder)
      const lifecycle: CodexDelegationResult['lifecycle'] = execution.cancellationRequested ? 'cancelled' : code === 0 ? 'completed' : 'failed'
      finalize(execution, lifecycle, code === null ? undefined : code, signal || undefined)
    })
    const timer = setTimeout(() => {
      if (execution.settled) return
      execution.child.kill('SIGTERM')
      finalize(execution, 'ambiguous', undefined, 'SIGTERM')
    }, timeoutMs)
    timer.unref?.()
    execution.child.once('close', () => clearTimeout(timer))
  }

  return {
    capability: () => codexCapability(options),
    prepare: input => {
      try { return { ok: true, binding: bindingFor(input, gitProbe) } } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : 'Codex delegation preparation failed.' } }
    },
    submit: async input => {
      const available = codexCapability(options)
      if (!available.supported) return { ok: false, reason: available.nextAction }
      const prepared = input.operation.lifecycle === 'admitted' ? { ok: true as const, binding: bindingFor(input, gitProbe) } : { ok: false as const, reason: 'Codex delegation operation is not admitted.' }
      if (!prepared.ok) return { ok: false, reason: prepared.reason }
      const admission = evaluateProviderAdmission({ operation: input.operation, contract: input.contract, adapterIdentity: CODEX_ADAPTER_ID, adapterSupported: true, expectedRevision: input.operation.revision })
      if (!admission.allowed) return { ok: false, reason: admission.nextAction }
      let submitted: PersistedDelegationOperation
      try { submitted = transition(options, input.operation, 'submitted') } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : 'Could not persist submission state.' } }
      const intent = createSubmissionIntent({ operation: submitted, adapterIdentity: CODEX_ADAPTER_ID, now: (options.now || (() => new Date()))().toISOString() })
      const providerOperationIdentity = `codex:${submitted.operationId}`
      const acknowledgement: SubmissionAcknowledgement = {
        schemaVersion: 1,
        operationId: submitted.operationId,
        packetId: submitted.packetId,
        adapterIdentity: CODEX_ADAPTER_ID,
        providerOperationIdentity,
        compiledContractHash: submitted.compiledContractHash,
        idempotencyKey: submitted.compiledIdempotencyKey,
        acceptedAt: (options.now || (() => new Date()))().toISOString(),
        status: 'accepted',
        reasonCode: 'local_process_spawn_pending'
      }
      const acknowledgementCheck = validateSubmissionAcknowledgement({ operation: submitted, intent, acknowledgement })
      if (!acknowledgementCheck.ok) return { ok: false, reason: 'Codex submission acknowledgement failed identity validation.' }
      let child: SpawnedProcess
      try {
        const args = ['exec', '--json', '--ephemeral', '--sandbox', input.isolation === 'worktree' ? 'workspace-write' : 'read-only', '-C', prepared.binding.repositoryRoot]
        child = spawnProcess(command, args, { cwd: prepared.binding.repositoryRoot, shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
      } catch (error) {
        const failed = transition(options, submitted, 'failed')
        updateControls(options, failed, { operationId: failed.operationId, expectedRevision: failed.revision, reconciliation: 'matched', evidence: { operationId: failed.operationId, packetId: failed.packetId, resultStatus: 'failed', validationState: 'failed', reasonCode: 'spawn_failed' }, now: (options.now || (() => new Date()))().toISOString() })
        return { ok: false, reason: error instanceof Error ? error.message : 'Codex CLI could not be started.' }
      }
      const execution: ActiveCodexExecution = { input, operation: submitted, intent, acknowledgement, child, providerOperationIdentity, startedAt: Date.now(), stdout: '', stdoutRemainder: '', stderr: '', changedPaths: [], validationEvidence: [], cancellationRequested: false, settled: false }
      active.set(submitted.operationId, execution)
      emitLifecycle(options, execution, 'submitted')
      start(execution)
      try { child.stdin?.end(renderCodexPrompt(input.contract)) } catch { finalize(execution, 'ambiguous') }
      return { ok: true, operation: submitted, providerOperationIdentity }
    },
    statusReadback: operationId => {
      const running = active.get(operationId)
      if (running) {
        const lifecycle = running.operation.lifecycle === 'submitted' ? 'submitted' : 'running'
        return { operation: running.operation, providerStatus: providerStatus(running, lifecycle, (options.now || (() => new Date()))().toISOString()), ...(running.result ? { result: running.result } : {}) }
      }
      const operation = getPersistedDelegationOperation(operationId, options.storeOptions)
      if (!operation) return undefined
      return { operation, ...(results.has(operationId) ? { result: results.get(operationId) } : {}) }
    },
    cancel: operationId => {
      const execution = active.get(operationId)
      if (!execution) return { ok: false, reason: 'No active Codex process is available; reconcile the persisted operation.' }
      if (execution.operation.lifecycle !== 'submitted' && execution.operation.lifecycle !== 'running') return { ok: false, reason: `Codex operation is ${execution.operation.lifecycle}.` }
      try {
        execution.operation = transition(options, execution.operation, 'cancellation_requested')
        execution.cancellationRequested = true
        emitLifecycle(options, execution, 'cancellation_requested')
        execution.child.kill('SIGTERM')
        return { ok: true, operation: execution.operation }
      } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : 'Codex cancellation failed.' } }
    },
    reconcile: operationId => {
      const activeExecution = active.get(operationId)
      if (activeExecution) return { operation: activeExecution.operation, ...(activeExecution.result ? { result: activeExecution.result } : {}) }
      const operation = getPersistedDelegationOperation(operationId, options.storeOptions)
      if (!operation) return undefined
      if (operation.lifecycle === 'submitted' || operation.lifecycle === 'running') {
        try {
          const ambiguous = transition(options, operation, 'ambiguous')
          const reconciled = updateControls(options, ambiguous, { operationId: ambiguous.operationId, expectedRevision: ambiguous.revision, reconciliation: 'ambiguous', now: (options.now || (() => new Date()))().toISOString() })
          return { operation: reconciled }
        } catch { return { operation } }
      }
      return { operation, ...(results.has(operationId) ? { result: results.get(operationId) } : {}) }
    },
    evidence: operationId => results.get(operationId)
  }
}
