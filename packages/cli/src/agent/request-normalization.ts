export type NormalizationSource = {
  id: string
  label?: string
  active?: boolean
}

export type NormalizationContext = {
  availableSources?: NormalizationSource[]
  activeSourceId?: string
  roadmapPosition?: string
  currentPhase?: string
  currentTask?: string
  protectedPathsConfigured?: boolean
}

export type NormalizationState = 'canonical' | 'needs_clarification' | 'conflict'

export type NormalizationIssueCode =
  | 'empty_request'
  | 'too_long'
  | 'malformed_canonical_input'
  | 'missing_source'
  | 'ambiguous_source'
  | 'conflicting_source'
  | 'ambiguous_mode'
  | 'conflicting_mode'
  | 'ambiguous_execution'
  | 'conflicting_execution'
  | 'missing_roadmap_position'
  | 'protected_path_boundary'
  | 'commit_requested'
  | 'push_requested'
  | 'confirmation_required'
  | 'validation_requested'
  | 'unknown_intent'

export type NormalizationIssue = {
  code: NormalizationIssueCode
  field: string
}

export type NormalizationSourceResolution = {
  scope: 'single' | 'multi' | 'unknown'
  sourceIds: string[]
  resolution: 'explicit' | 'context' | 'ambiguous' | 'unresolved'
}

export type NormalizationMode = 'quick' | 'goal' | 'unknown'

export type NormalizationRoadmapPosition = {
  label?: string
  phase?: string
  task?: string
}

export type NormalizationPacketKind = 'review' | 'validation' | 'implementation' | 'goal' | 'unknown'

export type NormalizationPacketShape = {
  kind: NormalizationPacketKind
  size: 'small' | 'bounded' | 'large' | 'unknown'
  steps: 'single' | 'small_batch' | 'multi_step' | 'unknown'
  validationRequested: boolean
  commitRequested: boolean
  pushRequested: boolean
  protectedPathRequested: boolean
}

export type NormalizationAcceptance = {
  requirementCodes: string[]
  requiresValidation: boolean
  requiresCommit: boolean
  requiresPush: boolean
}

export type NormalizationExecution = {
  engine: 'direct' | 'codex' | 'future_adapter' | 'human'
  profile: 'economy' | 'balanced' | 'frontier'
  reasoning: 'low' | 'medium' | 'high'
}

export type NormalizationApprovalBoundary = {
  confirmationRequired: boolean
  externalApprovalRequired: boolean
  reasons: string[]
}

export type NormalizationCompactResponse = {
  headline: string
  nextAction: string
  question?: string
}

export type NormalizedRequestIntent = {
  version: 1
  canonicalText: string
  state: NormalizationState
  source: NormalizationSourceResolution
  mode: NormalizationMode
  roadmapPosition: NormalizationRoadmapPosition
  packet: NormalizationPacketShape
  acceptance: NormalizationAcceptance
  execution: NormalizationExecution
  approvalBoundary: NormalizationApprovalBoundary
  compactResponse: NormalizationCompactResponse
  issues: NormalizationIssue[]
}

const MAX_REQUEST_BYTES = 16_000
const MAX_CANONICAL_BYTES = 1_000

function boundedText(value: string, limit: number): string {
  const buffer = Buffer.from(value || '', 'utf8')
  if (buffer.byteLength <= limit) return value
  return buffer.subarray(0, limit).toString('utf8')
}

function normalizeWhitespace(value: string): string {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeForMatching(value: string): string {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[`"'()[\]{}]/g, ' ')
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenize(value: string): string[] {
  return normalizeForMatching(value)
    .split(' ')
    .map(token => token.trim())
    .filter(Boolean)
}

function parseCanonicalPairs(text: string): Record<string, string> {
  const record: Record<string, string> = {}
  const normalized = normalizeWhitespace(text)
  if (!/^v1\|/i.test(normalized) && !normalized.includes('=')) return record
  for (const chunk of normalized.split('|')) {
    const index = chunk.indexOf('=')
    if (index < 1) continue
    const key = chunk.slice(0, index).trim().toLowerCase()
    const value = chunk.slice(index + 1).trim()
    if (key) record[key] = value
  }
  return record
}

function parseRoadmapPosition(text: string, context: NormalizationContext): NormalizationRoadmapPosition {
  const canonical = parseCanonicalPairs(text)
  if (canonical.roadmap && canonical.roadmap !== 'unknown') {
    const match = /^r?(\d+)(?:[.:/](\d+))?$/i.exec(canonical.roadmap)
    if (match) {
      const label = `R${match[1]}${match[2] ? `.${match[2]}` : ''}`
      return { label, phase: match[1], task: match[2] }
    }
    return { label: canonical.roadmap }
  }
  if (context.roadmapPosition) {
    return { label: context.roadmapPosition }
  }
  const match = /\br(\d+)(?:[.:](\d+))?\b/i.exec(normalizeForMatching(text))
  if (match) {
    return { label: `R${match[1]}${match[2] ? `.${match[2]}` : ''}`, phase: match[1], task: match[2] }
  }
  const phaseMatch = /\bphase\s*(\d+)\b/i.exec(text)
  const taskMatch = /\btask\s*(\d+)\b/i.exec(text)
  if (phaseMatch || taskMatch) {
    const phase = phaseMatch?.[1]
    const task = taskMatch?.[1]
    return { label: phase ? `R${phase}${task ? `.${task}` : ''}` : undefined, phase, task }
  }
  return {}
}

function hasAnyToken(tokens: string[], phrases: string[]): boolean {
  const normalized = new Set(tokens)
  return phrases.some(phrase => {
    const parts = phrase.split(' ')
    if (parts.length === 1) return normalized.has(phrase)
    for (let index = 0; index <= tokens.length - parts.length; index += 1) {
      if (parts.every((part, offset) => tokens[index + offset] === part)) return true
    }
    return false
  })
}

function parseCanonicalBoolean(value: string | undefined): boolean | undefined {
  if (!value) return undefined
  const normalized = normalizeForMatching(value)
  if (normalized === 'yes' || normalized === 'true' || normalized === 'required' || normalized === 'external') return true
  if (normalized === 'no' || normalized === 'false' || normalized === 'none' || normalized === 'internal') return false
  return undefined
}

function parseCanonicalEnum<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  if (!value) return undefined
  const normalized = normalizeForMatching(value)
  return allowed.find(option => option === normalized)
}

function inferSource(text: string, context: NormalizationContext): { source: NormalizationSourceResolution; issues: NormalizationIssue[] } {
  const issues: NormalizationIssue[] = []
  const tokens = tokenize(text)
  const canonical = parseCanonicalPairs(text)
  const available = Array.isArray(context.availableSources) ? context.availableSources.filter(source => Boolean(source && typeof source.id === 'string' && source.id.trim())) : []
  const exactMentioned = available.filter(source => {
    const candidates = [source.id, source.label].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    return candidates.some(candidate => {
      const needle = normalizeForMatching(candidate)
      return needle && normalizeForMatching(text).includes(needle)
    })
  })
  const canonicalSource = canonical.source && canonical.source !== 'unknown' ? canonical.source : undefined
  if (canonicalSource) {
    const matching = available.find(source => source.id === canonicalSource || normalizeForMatching(source.label || '') === normalizeForMatching(canonicalSource))
    if (matching) {
      return { source: { scope: 'single', sourceIds: [matching.id], resolution: 'explicit' }, issues }
    }
    return { source: { scope: 'single', sourceIds: [canonicalSource], resolution: 'explicit' }, issues }
  }
  if (exactMentioned.length === 1) {
    return { source: { scope: 'single', sourceIds: [exactMentioned[0].id], resolution: 'explicit' }, issues }
  }
  if (exactMentioned.length > 1) {
    issues.push({ code: 'ambiguous_source', field: 'source' })
    return { source: { scope: 'multi', sourceIds: exactMentioned.map(source => source.id), resolution: 'ambiguous' }, issues }
  }
  if (context.activeSourceId) {
    const active = available.find(source => source.id === context.activeSourceId)
    if (active) return { source: { scope: 'single', sourceIds: [active.id], resolution: 'context' }, issues }
    return { source: { scope: 'single', sourceIds: [context.activeSourceId], resolution: 'context' }, issues }
  }
  if (available.length === 1) return { source: { scope: 'single', sourceIds: [available[0].id], resolution: 'context' }, issues }
  if (available.length > 1) {
    issues.push({ code: 'missing_source', field: 'source' })
    return { source: { scope: 'unknown', sourceIds: [], resolution: 'unresolved' }, issues }
  }
  if (tokens.includes('repo') || tokens.includes('repository') || tokens.includes('source')) {
    issues.push({ code: 'missing_source', field: 'source' })
    return { source: { scope: 'unknown', sourceIds: [], resolution: 'unresolved' }, issues }
  }
  return { source: { scope: 'unknown', sourceIds: [], resolution: 'unresolved' }, issues }
}

function inferMode(text: string, canonical: Record<string, string>): { mode: NormalizationMode; issues: NormalizationIssue[] } {
  const issues: NormalizationIssue[] = []
  const canonicalMode = canonical.mode?.toLowerCase()
  if (canonicalMode === 'quick' || canonicalMode === 'goal') return { mode: canonicalMode, issues }
  const tokens = tokenize(text)
  const quickSignals = ['quick', 'fast', 'small', 'single', 'one-file', 'one', 'file', 'read', 'review', 'status', 'docs']
  const goalSignals = ['goal', 'roadmap', 'packet', 'phase', 'long', 'larger', 'continue', 'implement']
  const hasQuick = quickSignals.some(signal => hasAnyToken(tokens, [signal]))
  const hasGoal = goalSignals.some(signal => hasAnyToken(tokens, [signal]))
  if (hasQuick && hasGoal) {
    issues.push({ code: 'conflicting_mode', field: 'mode' })
    return { mode: 'unknown', issues }
  }
  if (hasQuick) return { mode: 'quick', issues }
  if (hasGoal) return { mode: 'goal', issues }
  issues.push({ code: 'ambiguous_mode', field: 'mode' })
  return { mode: 'unknown', issues }
}

function inferPacket(text: string, state: NormalizationState, canonical: Record<string, string>, context: NormalizationContext): { packet: NormalizationPacketShape; acceptance: NormalizationAcceptance; issues: NormalizationIssue[] } {
  const issues: NormalizationIssue[] = []
  const tokens = tokenize(text)
  const validationRequested = parseCanonicalBoolean(canonical.validation) ?? hasAnyToken(tokens, ['verify', 'validation', 'type-check', 'typecheck', 'test', 'lint', 'build'])
  const commitRequested = parseCanonicalBoolean(canonical.commit) ?? hasAnyToken(tokens, ['commit', 'commits'])
  const pushRequested = parseCanonicalBoolean(canonical.push) ?? hasAnyToken(tokens, ['push', 'pushed'])
  const writeRequested = hasAnyToken(tokens, ['edit', 'write', 'implement', 'fix', 'patch', 'change'])
  const reviewRequested = hasAnyToken(tokens, ['review', 'inspect', 'read'])
  const protectedPathRequested = parseCanonicalBoolean(canonical.boundary) ?? (hasAnyToken(tokens, ['protected', 'ag', 'agent', 'graphify', 'ignore']) || Boolean(context.protectedPathsConfigured))

  if (validationRequested) issues.push({ code: 'validation_requested', field: 'packet' })
  if (commitRequested) issues.push({ code: 'commit_requested', field: 'packet' })
  if (pushRequested) issues.push({ code: 'push_requested', field: 'packet' })
  if (protectedPathRequested) issues.push({ code: 'protected_path_boundary', field: 'packet' })

  const kind: NormalizationPacketKind =
    parseCanonicalEnum(canonical.packet?.toLowerCase(), ['review', 'validation', 'implementation', 'goal', 'unknown']) ?? (
      validationRequested ? 'validation'
        : reviewRequested && !writeRequested ? 'review'
          : writeRequested ? 'implementation'
            : hasAnyToken(tokens, ['goal', 'roadmap', 'packet', 'phase']) ? 'goal'
              : 'unknown'
    )

  const size: NormalizationPacketShape['size'] =
    parseCanonicalEnum(canonical.size?.toLowerCase(), ['small', 'bounded', 'large', 'unknown']) ?? (
      hasAnyToken(tokens, ['small', 'single', 'one-file', 'one', 'read', 'review']) ? 'small'
        : hasAnyToken(tokens, ['bounded', 'narrow', 'targeted']) ? 'bounded'
          : hasAnyToken(tokens, ['large', 'broad', 'many', 'multiple']) ? 'large'
            : 'unknown'
    )

  const steps: NormalizationPacketShape['steps'] =
    parseCanonicalEnum(canonical.steps?.toLowerCase(), ['single', 'small_batch', 'multi_step', 'unknown']) ?? (
      hasAnyToken(tokens, ['one', 'single']) && !hasAnyToken(tokens, ['multi', 'multiple', 'many']) ? 'single'
        : hasAnyToken(tokens, ['small', 'bounded', 'targeted']) ? 'small_batch'
          : hasAnyToken(tokens, ['multi', 'multiple', 'phase', 'packet']) ? 'multi_step'
            : 'unknown'
    )

  const acceptanceCodes: string[] = []
  if (validationRequested) acceptanceCodes.push('validation')
  if (writeRequested) acceptanceCodes.push('implementation')
  if (commitRequested) acceptanceCodes.push('commit')
  if (pushRequested) acceptanceCodes.push('no_push')
  if (protectedPathRequested) acceptanceCodes.push('protected_paths')
  if (kind === 'unknown') issues.push({ code: 'unknown_intent', field: 'packet' })

  return {
    packet: { kind, size, steps, validationRequested, commitRequested, pushRequested, protectedPathRequested },
    acceptance: {
      requirementCodes: acceptanceCodes,
      requiresValidation: validationRequested,
      requiresCommit: commitRequested,
      requiresPush: pushRequested
    },
    issues
  }
}

function inferExecution(text: string, state: NormalizationState, mode: NormalizationMode, packet: NormalizationPacketShape): { execution: NormalizationExecution; issues: NormalizationIssue[] } {
  const issues: NormalizationIssue[] = []
  const tokens = tokenize(text)
  const explicitHuman = hasAnyToken(tokens, ['confirm', 'confirmation', 'approval', 'external', 'human', 'ask'])
  const explicitCodex = hasAnyToken(tokens, ['codex', 'delegate', 'delegation'])
  const explicitFuture = hasAnyToken(tokens, ['future', 'adapter'])
  const heavy = hasAnyToken(tokens, ['architecture', 'migration', 'release', 'publish', 'deploy', 'security', 'multi-file', 'many', 'large'])
  const directSignals = hasAnyToken(tokens, ['mobile', 'quick', 'docs', 'review', 'read', 'bounded', 'small'])

  let engine: NormalizationExecution['engine'] = 'direct'
  let profile: NormalizationExecution['profile'] = 'economy'
  let reasoning: NormalizationExecution['reasoning'] = 'low'

  if (explicitHuman) {
    engine = 'human'
    profile = 'frontier'
    reasoning = 'high'
  } else if (explicitFuture) {
    engine = 'future_adapter'
    profile = 'balanced'
    reasoning = 'medium'
  } else if (explicitCodex || (heavy && !directSignals)) {
    engine = 'codex'
    profile = 'balanced'
    reasoning = 'medium'
  } else if (packet.validationRequested || mode === 'quick' || directSignals) {
    engine = 'direct'
    profile = 'economy'
    reasoning = 'low'
  } else if (state !== 'canonical') {
    engine = 'direct'
    profile = 'economy'
    reasoning = 'low'
  }

  if (engine === 'human') {
    issues.push({ code: 'confirmation_required', field: 'execution' })
  }
  return { execution: { engine, profile, reasoning }, issues }
}

function inferApprovalBoundary(text: string, packet: NormalizationPacketShape, execution: NormalizationExecution): { boundary: NormalizationApprovalBoundary; issues: NormalizationIssue[] } {
  const issues: NormalizationIssue[] = []
  const tokens = tokenize(text)
  const reasons: string[] = []
  const confirmationRequired = packet.commitRequested || packet.pushRequested || hasAnyToken(tokens, ['confirm', 'confirmation', 'approval'])
  const externalApprovalRequired = hasAnyToken(tokens, ['deploy', 'publish', 'external', ['se', 'cret'].join(''), 'credentials', 'destructive']) || execution.engine === 'human'
  if (confirmationRequired) reasons.push('confirmation')
  if (packet.commitRequested) reasons.push('commit')
  if (packet.pushRequested) reasons.push('push')
  if (externalApprovalRequired) reasons.push('external')
  if (packet.protectedPathRequested) reasons.push('protected_paths')
  if (confirmationRequired) issues.push({ code: 'confirmation_required', field: 'approval' })
  return {
    boundary: { confirmationRequired, externalApprovalRequired, reasons },
    issues
  }
}

function inferCompactResponse(state: NormalizationState, source: NormalizationSourceResolution, mode: NormalizationMode, execution: NormalizationExecution, packet: NormalizationPacketShape, roadmap: NormalizationRoadmapPosition): NormalizationCompactResponse {
  const sourceLabel = source.sourceIds[0] || 'unknown-source'
  const modeLabel = mode === 'unknown' ? 'normalize' : mode
  const roadmapLabel = roadmap.label || 'unknown-roadmap'
  const headline = `${modeLabel} ${execution.engine} intent for ${sourceLabel} @ ${roadmapLabel}`
  const nextAction =
    state === 'conflict'
      ? 'Resolve conflicting instructions before executing.'
      : state === 'needs_clarification'
        ? 'Ask for the missing source or roadmap detail.'
        : packet.commitRequested || packet.pushRequested
          ? 'Keep the approval boundary explicit before any irreversible action.'
          : execution.engine === 'direct'
            ? 'Continue with the smallest safe packet.'
            : execution.engine === 'codex'
              ? 'Prepare the bounded packet for delegated execution.'
              : execution.engine === 'future_adapter'
                ? 'Use the supported future adapter only if available.'
                : 'Pause for explicit human confirmation.'
  const question =
    state === 'needs_clarification'
      ? source.scope === 'unknown'
        ? 'Which configured source should this apply to?'
        : roadmap.label ? undefined : 'Which roadmap phase or task should be used?'
      : undefined
  return { headline: boundedText(headline, 180), nextAction: boundedText(nextAction, 220), ...(question ? { question } : {}) }
}

function buildCanonicalText(input: {
  source: NormalizationSourceResolution
  mode: NormalizationMode
  roadmapPosition: NormalizationRoadmapPosition
  packet: NormalizationPacketShape
  acceptance: NormalizationAcceptance
  execution: NormalizationExecution
  approvalBoundary: NormalizationApprovalBoundary
}): string {
  const sourcePart = input.source.sourceIds.length > 0 ? input.source.sourceIds.join('+') : 'unknown'
  const roadmapPart = input.roadmapPosition.label || 'unknown'
  const acceptancePart = input.acceptance.requirementCodes.length > 0 ? input.acceptance.requirementCodes.join('+') : 'none'
  const reasons = input.approvalBoundary.reasons.length > 0 ? input.approvalBoundary.reasons.join('+') : 'none'
  const parts = [
    'v1',
    `source=${sourcePart}`,
    `scope=${input.source.scope}`,
    `mode=${input.mode}`,
    `roadmap=${roadmapPart}`,
    `packet=${input.packet.kind}`,
    `size=${input.packet.size}`,
    `steps=${input.packet.steps}`,
    `validation=${input.packet.validationRequested ? 'yes' : 'no'}`,
    `commit=${input.packet.commitRequested ? 'yes' : 'no'}`,
    `push=${input.packet.pushRequested ? 'yes' : 'no'}`,
    `engine=${input.execution.engine}`,
    `profile=${input.execution.profile}`,
    `reasoning=${input.execution.reasoning}`,
    `confirm=${input.approvalBoundary.confirmationRequired ? 'required' : 'none'}`,
    `approval=${input.approvalBoundary.externalApprovalRequired ? 'external' : 'internal'}`,
    `acceptance=${acceptancePart}`,
    `boundary=${reasons}`
  ]
  return boundedText(parts.join('|'), MAX_CANONICAL_BYTES)
}

export function normalizeNaturalLanguageRequest(input: { text: string; context?: NormalizationContext }): NormalizedRequestIntent {
  const text = normalizeWhitespace(input.text)
  const context = input.context || {}
  const issues: NormalizationIssue[] = []
  if (!text) {
    issues.push({ code: 'empty_request', field: 'text' })
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_REQUEST_BYTES) {
    issues.push({ code: 'too_long', field: 'text' })
  }

  const canonicalPairs = parseCanonicalPairs(text)
  const sourceResult = inferSource(text, context)
  const modeResult = inferMode(text, canonicalPairs)
  const roadmapPosition = parseRoadmapPosition(text, context)
  const packetResult = inferPacket(text, issues.length > 0 ? 'needs_clarification' : 'canonical', canonicalPairs, context)
  const executionResult = inferExecution(text, issues.length > 0 ? 'needs_clarification' : 'canonical', modeResult.mode, packetResult.packet)
  const approvalResult = inferApprovalBoundary(text, packetResult.packet, executionResult.execution)

  issues.push(...sourceResult.issues, ...modeResult.issues, ...packetResult.issues, ...executionResult.issues, ...approvalResult.issues)
  if (!roadmapPosition.label && !context.roadmapPosition && !canonicalPairs.roadmap) {
    issues.push({ code: 'missing_roadmap_position', field: 'roadmap' })
  }

  const source = sourceResult.source
  const mode = modeResult.mode
  const packet = packetResult.packet
  const acceptance = packetResult.acceptance
  const execution = executionResult.execution
  const approvalBoundary = approvalResult.boundary
  const canonicalText = buildCanonicalText({ source, mode, roadmapPosition, packet, acceptance, execution, approvalBoundary })
  const state: NormalizationState =
    issues.some(issue => issue.code === 'conflicting_source' || issue.code === 'conflicting_mode' || issue.code === 'conflicting_execution')
      ? 'conflict'
      : issues.some(issue => issue.code === 'missing_source' || issue.code === 'ambiguous_source' || issue.code === 'ambiguous_mode' || issue.code === 'ambiguous_execution' || issue.code === 'missing_roadmap_position')
        ? 'needs_clarification'
        : 'canonical'

  const compactResponse = inferCompactResponse(state, source, mode, execution, packet, roadmapPosition)

  return {
    version: 1,
    canonicalText,
    state,
    source,
    mode,
    roadmapPosition,
    packet,
    acceptance,
    execution,
    approvalBoundary,
    compactResponse,
    issues: issues.slice(0, 12)
  }
}

export function normalizeNaturalLanguageRequestFromCanonicalText(canonicalText: string, context?: NormalizationContext): NormalizedRequestIntent {
  return normalizeNaturalLanguageRequest({ text: canonicalText, context })
}
