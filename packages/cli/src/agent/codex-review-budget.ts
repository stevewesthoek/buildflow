import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getConfigDir } from '../utils/paths'

export const CODEX_REVIEW_BUDGET_SCHEMA_VERSION = 1 as const
export const CODEX_REVIEW_BUDGET_CONTRACT_VERSION = 'r20.3' as const
export const CODEX_REVIEW_BUDGET_STORE_VERSION = 1 as const
export const CODEX_REVIEW_BUDGET_STORE_FILENAME = 'codex-review-executions.json' as const

export const CODEX_REVIEW_BUDGET_LIMIT_KEYS = Object.freeze([
  'maxModelRequests',
  'maxPromptBytes',
  'maxInputFiles',
  'maxInputBytes',
  'maxInputFileBytes',
  'maxContextBytes',
  'maxStdoutBytes',
  'maxStderrBytes',
  'maxResponseBytes',
  'maxArtifactBytes',
  'maxWallClockMs',
  'cancellationGraceMs',
  'maxUsageUnits'
] as const)
export type CodexReviewBudgetLimitKey = typeof CODEX_REVIEW_BUDGET_LIMIT_KEYS[number]

export type CodexReviewBudgetLimits = Readonly<Record<CodexReviewBudgetLimitKey, number>>

/**
 * Three independent ceilings are intersected before a review can launch.
 * They are intentionally finite and conservative; a future model adapter may
 * narrow them for a particular request, but no autonomy level can broaden them.
 */
export const CODEX_REVIEW_BUDGET_POLICY_MAXIMUM: CodexReviewBudgetLimits = Object.freeze({
  maxModelRequests: 1,
  maxPromptBytes: 64 * 1024,
  maxInputFiles: 10,
  maxInputBytes: 64 * 1024,
  maxInputFileBytes: 32 * 1024,
  maxContextBytes: 64 * 1024,
  maxStdoutBytes: 32 * 1024,
  maxStderrBytes: 32 * 1024,
  maxResponseBytes: 32 * 1024,
  maxArtifactBytes: 32 * 1024,
  maxWallClockMs: 30_000,
  cancellationGraceMs: 500,
  maxUsageUnits: 100_000
})

export const CODEX_REVIEW_BUDGET_CAPABILITY_MAXIMUM: CodexReviewBudgetLimits = Object.freeze({
  ...CODEX_REVIEW_BUDGET_POLICY_MAXIMUM,
  maxPromptBytes: 48 * 1024,
  maxInputFiles: 8,
  maxInputBytes: 48 * 1024,
  maxInputFileBytes: 24 * 1024,
  maxContextBytes: 48 * 1024,
  maxResponseBytes: 24 * 1024,
  maxArtifactBytes: 24 * 1024,
  maxUsageUnits: 80_000
})

export const CODEX_REVIEW_BUDGET_RUNTIME_MAXIMUM: CodexReviewBudgetLimits = Object.freeze({
  ...CODEX_REVIEW_BUDGET_POLICY_MAXIMUM,
  maxPromptBytes: 32 * 1024,
  maxInputFiles: 8,
  maxInputBytes: 32 * 1024,
  maxInputFileBytes: 16 * 1024,
  maxContextBytes: 32 * 1024,
  maxStdoutBytes: 16 * 1024,
  maxStderrBytes: 16 * 1024,
  maxResponseBytes: 16 * 1024,
  maxArtifactBytes: 16 * 1024,
  maxWallClockMs: 10_000,
  cancellationGraceMs: 250,
  maxUsageUnits: 50_000
})

export const CODEX_REVIEW_BUDGET_HARD_CAPS: CodexReviewBudgetLimits = Object.freeze(
  Object.fromEntries(CODEX_REVIEW_BUDGET_LIMIT_KEYS.map(key => [
    key,
    Math.min(CODEX_REVIEW_BUDGET_POLICY_MAXIMUM[key], CODEX_REVIEW_BUDGET_CAPABILITY_MAXIMUM[key], CODEX_REVIEW_BUDGET_RUNTIME_MAXIMUM[key])
  ])) as CodexReviewBudgetLimits
)

export const CODEX_REVIEW_BUDGET_DEFAULT_REQUEST: CodexReviewBudgetLimits = Object.freeze({
  maxModelRequests: 1,
  maxPromptBytes: 8 * 1024,
  maxInputFiles: 3,
  maxInputBytes: 16 * 1024,
  maxInputFileBytes: 8 * 1024,
  maxContextBytes: 8 * 1024,
  maxStdoutBytes: 8 * 1024,
  maxStderrBytes: 8 * 1024,
  maxResponseBytes: 8 * 1024,
  maxArtifactBytes: 8 * 1024,
  maxWallClockMs: 2_000,
  cancellationGraceMs: 100,
  maxUsageUnits: 1_000
})

export type CodexReviewBudgetRequest = Readonly<{
  profileId: string
  policyIdentity: string
  requested: CodexReviewBudgetLimits
}>

export type CodexReviewExecutionBudget = Readonly<{
  schemaVersion: typeof CODEX_REVIEW_BUDGET_SCHEMA_VERSION
  contractVersion: typeof CODEX_REVIEW_BUDGET_CONTRACT_VERSION
  profileId: string
  policyIdentity: string
  requested: CodexReviewBudgetLimits
  effective: CodexReviewBudgetLimits
  hardCapDigest: string
  budgetIdentity: string
  budgetDigest: string
}>

export type CodexReviewBudgetCreationFailureCode =
  | 'BUDGET_REQUEST_INVALID'
  | 'BUDGET_LIMIT_MISSING'
  | 'BUDGET_LIMIT_INVALID'
  | 'BUDGET_LIMIT_EXCEEDS_HARD_CAP'

export type CodexReviewBudgetCreationResult =
  | { ok: true; budget: CodexReviewExecutionBudget }
  | { ok: false; code: CodexReviewBudgetCreationFailureCode; message: string; field?: string }

export type CodexReviewBudgetInputFacts = Readonly<{
  inputFiles: number
  inputBytes: number
  maxInputFileBytes: number
  contextBytes: number
}>

export type CodexReviewBudgetConsumption = Readonly<{
  modelRequests: number
  promptBytes: number
  inputFiles: number
  inputBytes: number
  maxInputFileBytes: number
  contextBytes: number
  stdoutBytes: number
  stderrBytes: number
  responseBytes: number
  artifactBytes: number
  wallClockMs: number
  usageUnits: number
}>

export type CodexReviewTerminalState =
  | 'SUCCESS'
  | 'REQUEST_BUDGET_EXCEEDED'
  | 'PROMPT_BUDGET_EXCEEDED'
  | 'INPUT_BUDGET_EXCEEDED'
  | 'OUTPUT_BUDGET_EXCEEDED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'COST_BUDGET_EXCEEDED'
  | 'REVIEW_RUNTIME_UNAVAILABLE'
  | 'EXECUTION_FAILED'

export const CODEX_REVIEW_TERMINAL_STATES = Object.freeze([
  'SUCCESS',
  'REQUEST_BUDGET_EXCEEDED',
  'PROMPT_BUDGET_EXCEEDED',
  'INPUT_BUDGET_EXCEEDED',
  'OUTPUT_BUDGET_EXCEEDED',
  'TIMEOUT',
  'CANCELLED',
  'COST_BUDGET_EXCEEDED',
  'REVIEW_RUNTIME_UNAVAILABLE',
  'EXECUTION_FAILED'
] as const)

function isTerminalState(value: unknown): value is CodexReviewTerminalState {
  return typeof value === 'string' && (CODEX_REVIEW_TERMINAL_STATES as readonly string[]).includes(value)
}

export type CodexReviewBudgetTrackerSnapshot = Readonly<{
  terminalState?: CodexReviewTerminalState
  consumed: CodexReviewBudgetConsumption
  terminalCount: number
  terminalAt?: string
}>

type MutableConsumption = { -readonly [Key in keyof CodexReviewBudgetConsumption]: number }

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).length === keys.length && Object.keys(value).every(key => allowed.has(key))
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => stableSerialize(item)).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(object[key])}`).join(',')}}`
}

function sha256(value: unknown): string {
  return crypto.createHash('sha256').update(stableSerialize(value), 'utf8').digest('hex')
}

function validFinitePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 160 && /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)
}

export function createCodexReviewExecutionBudget(input: CodexReviewBudgetRequest): CodexReviewBudgetCreationResult {
  if (!isRecord(input) || !onlyKeys(input, ['profileId', 'policyIdentity', 'requested']) || !validIdentity(input.profileId) || !validIdentity(input.policyIdentity) || !isRecord(input.requested) || !onlyKeys(input.requested, CODEX_REVIEW_BUDGET_LIMIT_KEYS)) {
    return { ok: false, code: 'BUDGET_REQUEST_INVALID', message: 'R20.3 budget requests must contain only the profile, policy identity, and complete finite limits.' }
  }
  const requested = input.requested as Partial<CodexReviewBudgetLimits>
  for (const key of CODEX_REVIEW_BUDGET_LIMIT_KEYS) {
    const value = requested[key]
    if (value === undefined) return { ok: false, code: 'BUDGET_LIMIT_MISSING', message: `Budget limit ${key} is required.`, field: key }
    if (!validFinitePositiveInteger(value)) return { ok: false, code: 'BUDGET_LIMIT_INVALID', message: `Budget limit ${key} must be a positive safe integer.`, field: key }
    if (value > CODEX_REVIEW_BUDGET_HARD_CAPS[key]) return { ok: false, code: 'BUDGET_LIMIT_EXCEEDS_HARD_CAP', message: `Budget limit ${key} exceeds the configured finite hard cap.`, field: key }
  }
  const normalizedRequested = Object.fromEntries(CODEX_REVIEW_BUDGET_LIMIT_KEYS.map(key => [key, requested[key]])) as CodexReviewBudgetLimits
  const effective = Object.fromEntries(CODEX_REVIEW_BUDGET_LIMIT_KEYS.map(key => [key, Math.min(normalizedRequested[key], CODEX_REVIEW_BUDGET_HARD_CAPS[key])])) as CodexReviewBudgetLimits
  const hardCapDigest = sha256({ contractVersion: CODEX_REVIEW_BUDGET_CONTRACT_VERSION, hardCaps: CODEX_REVIEW_BUDGET_HARD_CAPS })
  const semantic = { contractVersion: CODEX_REVIEW_BUDGET_CONTRACT_VERSION, profileId: input.profileId, policyIdentity: input.policyIdentity, effective, hardCapDigest }
  const budgetDigest = sha256(semantic)
  return {
    ok: true,
    budget: Object.freeze({
      schemaVersion: CODEX_REVIEW_BUDGET_SCHEMA_VERSION,
      contractVersion: CODEX_REVIEW_BUDGET_CONTRACT_VERSION,
      profileId: input.profileId,
      policyIdentity: input.policyIdentity,
      requested: Object.freeze(normalizedRequested),
      effective: Object.freeze(effective),
      hardCapDigest,
      budgetIdentity: `codex-review-budget:${budgetDigest.slice(0, 16)}`,
      budgetDigest
    })
  }
}

export function isCodexReviewExecutionBudget(value: unknown): value is CodexReviewExecutionBudget {
  if (!isRecord(value) || !onlyKeys(value, ['schemaVersion', 'contractVersion', 'profileId', 'policyIdentity', 'requested', 'effective', 'hardCapDigest', 'budgetIdentity', 'budgetDigest'])) return false
  if (value.schemaVersion !== CODEX_REVIEW_BUDGET_SCHEMA_VERSION || value.contractVersion !== CODEX_REVIEW_BUDGET_CONTRACT_VERSION || !validIdentity(value.profileId) || !validIdentity(value.policyIdentity) || typeof value.hardCapDigest !== 'string' || typeof value.budgetIdentity !== 'string' || typeof value.budgetDigest !== 'string') return false
  const recreated = createCodexReviewExecutionBudget({ profileId: value.profileId, policyIdentity: value.policyIdentity, requested: value.requested as CodexReviewBudgetLimits })
  return recreated.ok && stableSerialize(recreated.budget) === stableSerialize(value)
}

function emptyConsumption(): MutableConsumption {
  return { modelRequests: 0, promptBytes: 0, inputFiles: 0, inputBytes: 0, maxInputFileBytes: 0, contextBytes: 0, stdoutBytes: 0, stderrBytes: 0, responseBytes: 0, artifactBytes: 0, wallClockMs: 0, usageUnits: 0 }
}

export class CodexReviewBudgetTracker {
  private readonly consumption: MutableConsumption = emptyConsumption()
  private terminalStateValue: CodexReviewTerminalState | undefined
  private terminalAtValue: string | undefined
  private terminalCountValue = 0
  private readonly startedMonotonic = performance.now()

  public constructor(private readonly budget: CodexReviewExecutionBudget, private readonly now: () => Date = () => new Date()) {}

  public tryTerminal(state: CodexReviewTerminalState): boolean {
    if (this.terminalStateValue) return false
    this.consumption.wallClockMs = Math.max(0, Math.round(performance.now() - this.startedMonotonic))
    this.terminalStateValue = state
    this.terminalAtValue = this.now().toISOString()
    this.terminalCountValue += 1
    return true
  }

  public reserveModelRequest(): boolean {
    if (this.terminalStateValue) return false
    const next = this.consumption.modelRequests + 1
    this.consumption.modelRequests = Math.min(this.budget.effective.maxModelRequests, next)
    if (next > this.budget.effective.maxModelRequests) this.tryTerminal('REQUEST_BUDGET_EXCEEDED')
    return !this.terminalStateValue
  }

  public recordPrompt(bytes: number): boolean { return this.recordBounded('promptBytes', bytes, this.budget.effective.maxPromptBytes, 'PROMPT_BUDGET_EXCEEDED') }

  public recordInput(facts: CodexReviewBudgetInputFacts): boolean {
    if (this.terminalStateValue || !validFinitePositiveInteger(facts.inputFiles) || !Number.isSafeInteger(facts.inputBytes) || facts.inputBytes < 0 || !Number.isSafeInteger(facts.maxInputFileBytes) || facts.maxInputFileBytes < 0 || !Number.isSafeInteger(facts.contextBytes) || facts.contextBytes < 0) return false
    this.consumption.inputFiles = Math.min(this.budget.effective.maxInputFiles, facts.inputFiles)
    this.consumption.inputBytes = Math.min(this.budget.effective.maxInputBytes, facts.inputBytes)
    this.consumption.maxInputFileBytes = Math.min(this.budget.effective.maxInputFileBytes, facts.maxInputFileBytes)
    this.consumption.contextBytes = Math.min(this.budget.effective.maxContextBytes, facts.contextBytes)
    if (facts.inputFiles > this.budget.effective.maxInputFiles || facts.inputBytes > this.budget.effective.maxInputBytes || facts.maxInputFileBytes > this.budget.effective.maxInputFileBytes || facts.contextBytes > this.budget.effective.maxContextBytes) this.tryTerminal('INPUT_BUDGET_EXCEEDED')
    return !this.terminalStateValue
  }

  public recordStdout(bytes: number): boolean { return this.recordBounded('stdoutBytes', bytes, this.budget.effective.maxStdoutBytes, 'OUTPUT_BUDGET_EXCEEDED') }
  public recordStderr(bytes: number): boolean { return this.recordBounded('stderrBytes', bytes, this.budget.effective.maxStderrBytes, 'OUTPUT_BUDGET_EXCEEDED') }
  public recordResponse(bytes: number): boolean { return this.recordBounded('responseBytes', bytes, this.budget.effective.maxResponseBytes, 'OUTPUT_BUDGET_EXCEEDED') }
  public recordArtifact(bytes: number): boolean { return this.recordBounded('artifactBytes', bytes, this.budget.effective.maxArtifactBytes, 'OUTPUT_BUDGET_EXCEEDED') }

  public recordUsage(units: number): boolean {
    return this.recordBounded('usageUnits', units, this.budget.effective.maxUsageUnits, 'COST_BUDGET_EXCEEDED')
  }

  public succeed(): boolean { return this.tryTerminal('SUCCESS') }
  public fail(): boolean { return this.tryTerminal('EXECUTION_FAILED') }
  public timeout(): boolean { return this.tryTerminal('TIMEOUT') }
  public cancel(): boolean { return this.tryTerminal('CANCELLED') }
  public unavailable(): boolean { return this.tryTerminal('REVIEW_RUNTIME_UNAVAILABLE') }

  public snapshot(): CodexReviewBudgetTrackerSnapshot {
    return Object.freeze({
      ...(this.terminalStateValue ? { terminalState: this.terminalStateValue } : {}),
      consumed: Object.freeze({ ...this.consumption }),
      terminalCount: this.terminalCountValue,
      ...(this.terminalAtValue ? { terminalAt: this.terminalAtValue } : {})
    })
  }

  private recordBounded(key: keyof MutableConsumption, amount: number, limit: number, overflowState: CodexReviewTerminalState): boolean {
    if (this.terminalStateValue || !Number.isSafeInteger(amount) || amount < 0) return false
    const next = this.consumption[key] + amount
    this.consumption[key] = Math.min(limit, next)
    if (next > limit) this.tryTerminal(overflowState)
    return !this.terminalStateValue
  }
}

export type CodexReviewExecutionRecord = Readonly<{
  schemaVersion: typeof CODEX_REVIEW_BUDGET_STORE_VERSION
  executionId: string
  reviewId: string
  sourceId: string
  runId: string
  budgetIdentity: string
  budget: CodexReviewExecutionBudget
  status: 'running' | 'terminal'
  terminalState?: CodexReviewTerminalState
  launched: boolean
  replayAllowed: false
  createdAt: string
  updatedAt: string
  terminalAt?: string
  consumed: CodexReviewBudgetConsumption
  evidence: Readonly<{ stdoutBytes: number; stderrBytes: number; responseBytes: number; artifactBytes: number; truncated: boolean }>
  errorCode?: string
}>

export type CodexReviewExecutionStoreOptions = Readonly<{
  storePath?: string
  now?: () => Date
  maxRecords?: number
}>

export type CodexReviewExecutionStoreFailureCode = 'EXECUTION_STORE_BUSY' | 'EXECUTION_STORE_CORRUPT' | 'EXECUTION_STORE_WRITE_FAILED' | 'EXECUTION_DUPLICATE' | 'EXECUTION_NOT_FOUND' | 'EXECUTION_ALREADY_TERMINAL'
export type CodexReviewExecutionStoreResult<T> = { ok: true; record: T } | { ok: false; code: CodexReviewExecutionStoreFailureCode; message: string; record?: CodexReviewExecutionRecord }
type StoreFailure = Extract<CodexReviewExecutionStoreResult<never>, { ok: false }>

type ExecutionStore = { version: typeof CODEX_REVIEW_BUDGET_STORE_VERSION; updatedAt: string; records: CodexReviewExecutionRecord[] }
const MAX_RECORDS = 300
const EXECUTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/

function storePath(options: CodexReviewExecutionStoreOptions = {}): string { return path.resolve(options.storePath || path.join(getConfigDir(), CODEX_REVIEW_BUDGET_STORE_FILENAME)) }
function nowIso(options: CodexReviewExecutionStoreOptions = {}): string { return (options.now?.() || new Date()).toISOString() }

/** Execution persistence must never be placed in the admitted source tree. */
export function isCodexReviewExecutionStorePathSafe(sourceRoot: string, options: CodexReviewExecutionStoreOptions = {}): boolean {
  try {
    const source = fs.realpathSync(sourceRoot)
    const target = storePath(options)
    const parent = fs.realpathSync(path.dirname(target))
    const targetReal = fs.existsSync(target) ? fs.realpathSync(target) : target
    return ![parent, targetReal].some(candidate => candidate === source || candidate.startsWith(`${source}${path.sep}`))
  } catch {
    return false
  }
}

function storeFailure(code: CodexReviewExecutionStoreFailureCode, message: string, record?: CodexReviewExecutionRecord): StoreFailure { return { ok: false, code, message, ...(record ? { record } : {}) } }

function isStoreFailure(value: unknown): value is StoreFailure {
  return isRecord(value) && value.ok === false && typeof value.code === 'string'
}

function validConsumption(value: unknown): value is CodexReviewBudgetConsumption {
  return isRecord(value) && ['modelRequests', 'promptBytes', 'inputFiles', 'inputBytes', 'maxInputFileBytes', 'contextBytes', 'stdoutBytes', 'stderrBytes', 'responseBytes', 'artifactBytes', 'wallClockMs', 'usageUnits'].every(key => validFinitePositiveInteger(value[key]) || value[key] === 0)
}

function validExecutionRecord(value: unknown): value is CodexReviewExecutionRecord {
  if (!isRecord(value) || value.schemaVersion !== CODEX_REVIEW_BUDGET_STORE_VERSION || typeof value.executionId !== 'string' || !EXECUTION_ID.test(value.executionId) || !validIdentity(value.reviewId) || !validIdentity(value.sourceId) || !validIdentity(value.runId) || !isCodexReviewExecutionBudget(value.budget) || value.budgetIdentity !== value.budget.budgetIdentity || !['running', 'terminal'].includes(String(value.status)) || value.launched !== true && value.launched !== false || value.replayAllowed !== false || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string' || !validConsumption(value.consumed) || !isRecord(value.evidence)) return false
  if (!['stdoutBytes', 'stderrBytes', 'responseBytes', 'artifactBytes'].every(key => validFinitePositiveInteger(value.evidence[key]) || value.evidence[key] === 0) || typeof value.evidence.truncated !== 'boolean') return false
  return value.status === 'running' ? value.terminalState === undefined : isTerminalState(value.terminalState) && typeof value.terminalAt === 'string'
}

function readStore(options: CodexReviewExecutionStoreOptions): ExecutionStore | StoreFailure {
  const target = storePath(options)
  if (!fs.existsSync(target)) return { version: CODEX_REVIEW_BUDGET_STORE_VERSION, updatedAt: nowIso(options), records: [] }
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as Partial<ExecutionStore>
    if (parsed.version !== CODEX_REVIEW_BUDGET_STORE_VERSION || typeof parsed.updatedAt !== 'string' || !Array.isArray(parsed.records) || parsed.records.length > MAX_RECORDS || parsed.records.some(record => !validExecutionRecord(record))) return storeFailure('EXECUTION_STORE_CORRUPT', 'The Codex review execution store is corrupt.')
    return { version: CODEX_REVIEW_BUDGET_STORE_VERSION, updatedAt: parsed.updatedAt, records: parsed.records as CodexReviewExecutionRecord[] }
  } catch {
    return storeFailure('EXECUTION_STORE_CORRUPT', 'The Codex review execution store is corrupt.')
  }
}

function writeStore(store: ExecutionStore, options: CodexReviewExecutionStoreOptions): void {
  const target = storePath(options)
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temporary, JSON.stringify({ ...store, records: store.records.slice(-MAX_RECORDS) }), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  try { fs.renameSync(temporary, target); fs.chmodSync(target, 0o600) } finally { try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) } catch { /* preserve the committed atomic file */ } }
}

function withStoreLock<T>(options: CodexReviewExecutionStoreOptions, callback: (store: ExecutionStore) => T | StoreFailure): T | StoreFailure {
  const target = storePath(options)
  const lock = `${target}.lock`
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(lock, 'wx', 0o600)
    const current = readStore(options)
    if (isStoreFailure(current)) return current
    const result = callback(current)
    if (isStoreFailure(result)) return result
    current.updatedAt = nowIso(options)
    writeStore(current, options)
    return result
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && String((error as { code?: unknown }).code) === 'EEXIST') return storeFailure('EXECUTION_STORE_BUSY', 'The Codex review execution store is busy.')
    return storeFailure('EXECUTION_STORE_WRITE_FAILED', 'The Codex review execution store could not be written safely.')
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    if (descriptor !== undefined) { try { fs.unlinkSync(lock) } catch { /* leave unknown lock state for operator recovery */ } }
  }
}

export function createCodexReviewExecutionRecord(input: Readonly<{ executionId: string; reviewId: string; sourceId: string; runId: string; budget: CodexReviewExecutionBudget; launched: boolean; consumed: CodexReviewBudgetConsumption; evidence?: Partial<CodexReviewExecutionRecord['evidence']> }>, options: CodexReviewExecutionStoreOptions = {}): CodexReviewExecutionStoreResult<CodexReviewExecutionRecord> {
  if (!EXECUTION_ID.test(input.executionId) || !validIdentity(input.reviewId) || !validIdentity(input.sourceId) || !validIdentity(input.runId) || !isCodexReviewExecutionBudget(input.budget) || !validConsumption(input.consumed)) return storeFailure('EXECUTION_STORE_WRITE_FAILED', 'The Codex review execution record is invalid.')
  const timestamp = nowIso(options)
  const record: CodexReviewExecutionRecord = {
    schemaVersion: CODEX_REVIEW_BUDGET_STORE_VERSION,
    executionId: input.executionId,
    reviewId: input.reviewId,
    sourceId: input.sourceId,
    runId: input.runId,
    budgetIdentity: input.budget.budgetIdentity,
    budget: input.budget,
    status: 'running',
    launched: input.launched,
    replayAllowed: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    consumed: input.consumed,
    evidence: { stdoutBytes: input.evidence?.stdoutBytes || 0, stderrBytes: input.evidence?.stderrBytes || 0, responseBytes: input.evidence?.responseBytes || 0, artifactBytes: input.evidence?.artifactBytes || 0, truncated: input.evidence?.truncated === true }
  }
  const result = withStoreLock(options, store => {
    if (store.records.some(item => item.executionId === input.executionId)) return storeFailure('EXECUTION_DUPLICATE', 'The Codex review execution identity already exists.')
    store.records.push(record)
    return record
  })
  return isStoreFailure(result) ? result : { ok: true, record: result }
}

export function getCodexReviewExecutionRecord(executionId: string, options: CodexReviewExecutionStoreOptions = {}): CodexReviewExecutionStoreResult<CodexReviewExecutionRecord | undefined> {
  const store = readStore(options)
  if (isStoreFailure(store)) return store
  return { ok: true, record: store.records.find(item => item.executionId === executionId) }
}

export function completeCodexReviewExecutionRecord(executionId: string, input: Readonly<{ terminalState: CodexReviewTerminalState; consumed: CodexReviewBudgetConsumption; evidence: CodexReviewExecutionRecord['evidence']; errorCode?: string }>, options: CodexReviewExecutionStoreOptions = {}): CodexReviewExecutionStoreResult<CodexReviewExecutionRecord> {
  const result = withStoreLock(options, store => {
    const index = store.records.findIndex(item => item.executionId === executionId)
    if (index < 0) return storeFailure('EXECUTION_NOT_FOUND', 'The Codex review execution record was not found.')
    const current = store.records[index]
    if (current.status === 'terminal') return storeFailure('EXECUTION_ALREADY_TERMINAL', 'The Codex review execution is already terminal.', current)
    const timestamp = nowIso(options)
    const updated: CodexReviewExecutionRecord = { ...current, status: 'terminal', terminalState: input.terminalState, terminalAt: timestamp, updatedAt: timestamp, consumed: input.consumed, evidence: input.evidence, ...(input.errorCode ? { errorCode: input.errorCode } : {}) }
    store.records[index] = updated
    return updated
  })
  return isStoreFailure(result) ? result : { ok: true, record: result }
}

/** Reconcile a nonterminal review after restart without replaying or resetting budget. */
export function reconcileCodexReviewExecutionRecord(executionId: string, options: CodexReviewExecutionStoreOptions = {}): CodexReviewExecutionStoreResult<CodexReviewExecutionRecord | undefined> {
  const result = withStoreLock(options, store => {
    const index = store.records.findIndex(item => item.executionId === executionId)
    if (index < 0) return undefined
    const current = store.records[index]
    if (current.status === 'terminal') return current
    const timestamp = nowIso(options)
    const updated: CodexReviewExecutionRecord = { ...current, status: 'terminal', terminalState: 'EXECUTION_FAILED', terminalAt: timestamp, updatedAt: timestamp, errorCode: 'ORPHANED_EXECUTION' }
    store.records[index] = updated
    return updated
  })
  return isStoreFailure(result) ? result : { ok: true, record: result }
}

export function formatCodexReviewBudgetStatus(snapshot: CodexReviewBudgetTrackerSnapshot, budget: CodexReviewExecutionBudget): string {
  const consumed = snapshot.consumed
  const state = snapshot.terminalState || 'RUNNING'
  return [
    'Codex review budget',
    `Files: ${consumed.inputFiles} / ${budget.effective.maxInputFiles}`,
    `Input: ${consumed.inputBytes} B / ${budget.effective.maxInputBytes} B`,
    `Output: ${consumed.stdoutBytes + consumed.stderrBytes} B / ${budget.effective.maxStdoutBytes + budget.effective.maxStderrBytes} B`,
    `Time: ${consumed.wallClockMs} ms / ${budget.effective.maxWallClockMs} ms`,
    `Model calls: ${consumed.modelRequests} / ${budget.effective.maxModelRequests}`,
    `Usage: ${consumed.usageUnits} / ${budget.effective.maxUsageUnits}`,
    `Status: ${state}`
  ].join('\n')
}
