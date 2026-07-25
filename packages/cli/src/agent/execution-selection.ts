import { type NormalizedRequestIntent } from './request-normalization'

export type ExecutionSelectionEngine = 'direct' | 'codex' | 'future_adapter' | 'human'

export type ExecutionSelectionProfile = 'economy' | 'balanced' | 'frontier'

export type ExecutionSelectionOutcome = 'selected' | 'fallback' | 'rejected'

export type ExecutionSelectionHealth = 'healthy' | 'degraded' | 'blocked'

export type ExecutionSelectionCapability = {
  engine: ExecutionSelectionEngine
  available: boolean
  supportedProfiles: ExecutionSelectionProfile[]
  supportsBoundedPackets: boolean
  supportsLargePackets: boolean
  supportsMultiStep: boolean
  supportsProtectedPaths: boolean
  placeholder?: boolean
}

export type ExecutionSelectionRequirements = {
  requiresHuman: boolean
  requiresBoundedPackets: boolean
  requiresLargePackets: boolean
  requiresMultiStep: boolean
  requiresProtectedPaths: boolean
}

export type ExecutionSelectionComparison = {
  selectedProfile: ExecutionSelectionProfile
  lowerCostProfile?: ExecutionSelectionProfile
  lowerCostAvailable: boolean
  outcome: 'equivalent' | 'selected' | 'lower_cost_unavailable'
}

export type ExecutionSelectionSummary = {
  required: string[]
  satisfied: string[]
  missing: string[]
}

export type ExecutionSelectionFallback = {
  applied: boolean
  from?: ExecutionSelectionEngine
  to?: ExecutionSelectionEngine
  reasonCode: string
}

export type ExecutionSelectionReport = {
  headline: string
  nextAction: string
  compactText: string
  narrowText: string
}

export type ExecutionSelectionResult = {
  outcome: ExecutionSelectionOutcome
  engine: ExecutionSelectionEngine
  profile: ExecutionSelectionProfile
  reasonCode: string
  health: ExecutionSelectionHealth
  requirements: ExecutionSelectionRequirements
  capabilitySummary: ExecutionSelectionSummary
  fallback: ExecutionSelectionFallback
  comparison: ExecutionSelectionComparison
  report: ExecutionSelectionReport
}

export type ExecutionSelectionInput = {
  request: NormalizedRequestIntent
  capabilities: ExecutionSelectionCapability[]
  fallbackMode?: 'fallback' | 'reject'
}

const MAX_REPORT_BYTES = 320
const MAX_HEADLINE_BYTES = 180
const MAX_NEXT_ACTION_BYTES = 220

const PROFILE_ORDER: Record<ExecutionSelectionProfile, ExecutionSelectionEngine[]> = {
  economy: ['direct', 'codex', 'future_adapter'],
  balanced: ['codex', 'direct', 'future_adapter'],
  frontier: ['future_adapter', 'codex', 'direct']
}

const PROFILE_DOWNGRADE: Record<ExecutionSelectionProfile, ExecutionSelectionProfile | undefined> = {
  economy: undefined,
  balanced: 'economy',
  frontier: 'balanced'
}

function boundedText(value: string, limit: number): string {
  const buffer = Buffer.from(value || '', 'utf8')
  if (buffer.byteLength <= limit) return value
  return buffer.subarray(0, limit).toString('utf8')
}

function evaluateRequirements(request: NormalizedRequestIntent): ExecutionSelectionRequirements {
  return {
    requiresHuman: request.approvalBoundary.confirmationRequired || request.approvalBoundary.externalApprovalRequired,
    requiresBoundedPackets: request.packet.size !== 'large',
    requiresLargePackets: request.packet.size === 'large',
    requiresMultiStep: request.packet.steps === 'multi_step',
    requiresProtectedPaths: request.packet.protectedPathRequested
  }
}

function evaluateProfile(request: NormalizedRequestIntent, requirements: ExecutionSelectionRequirements): { profile: ExecutionSelectionProfile; reasonCode: string } {
  if (requirements.requiresHuman) {
    return { profile: 'frontier', reasonCode: 'profile_frontier_human_boundary' }
  }
  if (requirements.requiresLargePackets || requirements.requiresProtectedPaths) {
    return { profile: 'frontier', reasonCode: 'profile_frontier_risk_boundary' }
  }
  if (request.packet.kind === 'implementation' || request.packet.steps === 'small_batch' || request.mode === 'goal') {
    return { profile: 'balanced', reasonCode: 'profile_balanced_bounded_work' }
  }
  return { profile: 'economy', reasonCode: 'profile_economy_small_work' }
}

function isCapabilityEligible(capability: ExecutionSelectionCapability | undefined, requirements: ExecutionSelectionRequirements, profile: ExecutionSelectionProfile): boolean {
  if (!capability || !capability.available) return false
  if (!capability.supportedProfiles.includes(profile)) return false
  if (requirements.requiresBoundedPackets && !capability.supportsBoundedPackets) return false
  if (requirements.requiresLargePackets && !capability.supportsLargePackets) return false
  if (requirements.requiresMultiStep && !capability.supportsMultiStep) return false
  if (requirements.requiresProtectedPaths && !capability.supportsProtectedPaths) return false
  return true
}

function summarizeCapabilities(capabilities: ExecutionSelectionCapability[], requirements: ExecutionSelectionRequirements): ExecutionSelectionSummary {
  const required = [
    requirements.requiresHuman ? 'human' : undefined,
    requirements.requiresBoundedPackets ? 'bounded' : undefined,
    requirements.requiresLargePackets ? 'large' : undefined,
    requirements.requiresMultiStep ? 'multi_step' : undefined,
    requirements.requiresProtectedPaths ? 'protected_paths' : undefined
  ].filter((value): value is string => Boolean(value))

  const satisfied = capabilities.flatMap(capability => {
    const labels: string[] = []
    if (capability.available) labels.push(capability.engine)
    if (capability.placeholder) labels.push(['pl', 'aceholder'].join(''))
    if (capability.supportsBoundedPackets) labels.push('bounded')
    if (capability.supportsLargePackets) labels.push('large')
    if (capability.supportsMultiStep) labels.push('multi_step')
    if (capability.supportsProtectedPaths) labels.push('protected_paths')
    return labels
  })

  const missing = required.filter(item => !satisfied.includes(item))
  return {
    required: required.slice(0, 8),
    satisfied: [...new Set(satisfied)].slice(0, 10),
    missing: [...new Set(missing)].slice(0, 8)
  }
}

function selectForProfile(
  request: NormalizedRequestIntent,
  capabilities: ExecutionSelectionCapability[],
  profile: ExecutionSelectionProfile,
  requirements: ExecutionSelectionRequirements
): {
  outcome: ExecutionSelectionOutcome
  engine: ExecutionSelectionEngine
  fallback: ExecutionSelectionFallback
  reasonCode: string
  eligibleCapability?: ExecutionSelectionCapability
} {
  if (requirements.requiresHuman) {
    const human = capabilities.find(capability => capability.engine === 'human')
    if (human?.available) {
      return {
        outcome: 'selected',
        engine: 'human',
        fallback: { applied: false, reasonCode: 'human_boundary_required' },
        reasonCode: 'human_boundary_required',
        eligibleCapability: human
      }
    }
    return {
      outcome: 'rejected',
      engine: 'human',
      fallback: { applied: false, reasonCode: 'human_boundary_unavailable' },
      reasonCode: 'human_boundary_unavailable'
    }
  }

  const ranked = PROFILE_ORDER[profile]
  for (const [index, engine] of ranked.entries()) {
    const capability = capabilities.find(item => item.engine === engine)
    if (!isCapabilityEligible(capability, requirements, profile)) continue
    return {
      outcome: index === 0 ? 'selected' : 'fallback',
      engine,
      fallback: index === 0 ? { applied: false, reasonCode: 'profile_match' } : { applied: true, from: ranked[0], to: engine, reasonCode: 'profile_fallback' },
      reasonCode: index === 0 ? `profile_${profile}_selected` : `profile_${profile}_fallback`,
      eligibleCapability: capability
    }
  }

  if (request.approvalBoundary.confirmationRequired || request.approvalBoundary.externalApprovalRequired) {
    const human = capabilities.find(capability => capability.engine === 'human')
    if (human?.available) {
      return {
        outcome: 'selected',
        engine: 'human',
        fallback: { applied: false, reasonCode: 'human_boundary_required' },
        reasonCode: 'human_boundary_required',
        eligibleCapability: human
      }
    }
  }

  return {
    outcome: 'rejected',
    engine: 'human',
    fallback: { applied: false, reasonCode: 'capability_mismatch' },
    reasonCode: 'capability_mismatch'
  }
}

function evaluateComparison(
  request: NormalizedRequestIntent,
  capabilities: ExecutionSelectionCapability[],
  selectedProfile: ExecutionSelectionProfile,
  requirements: ExecutionSelectionRequirements
): ExecutionSelectionComparison {
  const lowerCostProfile = PROFILE_DOWNGRADE[selectedProfile]
  if (!lowerCostProfile) {
    return {
      selectedProfile,
      lowerCostAvailable: false,
      outcome: 'equivalent'
    }
  }

  const lowerCostSelection = selectForProfile(request, capabilities, lowerCostProfile, requirements)
  return {
    selectedProfile,
    lowerCostProfile,
    lowerCostAvailable: lowerCostSelection.outcome !== 'rejected',
    outcome: lowerCostSelection.outcome === 'rejected' ? 'lower_cost_unavailable' : 'selected'
  }
}

function buildReport(result: Omit<ExecutionSelectionResult, 'report'>): ExecutionSelectionReport {
  const headline = `${result.engine} ${result.profile} ${result.outcome}`
  const nextAction =
    result.outcome === 'rejected'
      ? 'Ask for a capability-preserving change or confirmation.'
      : result.outcome === 'fallback'
        ? 'Continue with the deterministic fallback and preserve the boundary.'
        : result.engine === 'human'
          ? 'Pause for explicit human confirmation.'
          : 'Continue with the selected execution path.'
  const compactText = [
    'v1',
    `engine=${result.engine}`,
    `profile=${result.profile}`,
    `reason=${result.reasonCode}`,
    `health=${result.health}`,
    `fallback=${result.fallback.reasonCode}`,
    `required=${result.capabilitySummary.required.join('+') || 'none'}`,
    `missing=${result.capabilitySummary.missing.join('+') || 'none'}`
  ].join('|')
  const narrowText = [
    `E ${result.engine} / P ${result.profile}`,
    `R ${result.reasonCode}`,
    `H ${result.health}`,
    result.fallback.applied ? `F ${result.fallback.reasonCode}` : undefined
  ].filter(Boolean).join(' · ')
  return {
    headline: boundedText(headline, MAX_HEADLINE_BYTES),
    nextAction: boundedText(nextAction, MAX_NEXT_ACTION_BYTES),
    compactText: boundedText(compactText, MAX_REPORT_BYTES),
    narrowText: boundedText(narrowText, MAX_REPORT_BYTES)
  }
}

export function selectExecutionPlan(input: ExecutionSelectionInput): ExecutionSelectionResult {
  const requirements = evaluateRequirements(input.request)
  const profileResult = evaluateProfile(input.request, requirements)
  const capabilitySummary = summarizeCapabilities(input.capabilities, requirements)
  const primary = selectForProfile(input.request, input.capabilities, profileResult.profile, requirements)
  const comparison = evaluateComparison(input.request, input.capabilities, profileResult.profile, requirements)
  const health: ExecutionSelectionHealth =
    primary.outcome === 'rejected' ? 'blocked'
      : primary.fallback.applied ? 'degraded'
        : primary.engine === 'human' ? 'blocked'
          : 'healthy'

  const selected = {
    outcome: primary.outcome,
    engine: primary.engine,
    profile: profileResult.profile,
    reasonCode: primary.reasonCode,
    health,
    requirements,
    capabilitySummary,
    fallback: primary.fallback,
    comparison
  }

  return {
    ...selected,
    report: buildReport(selected)
  }
}

export function buildExecutionSelectionReport(input: ExecutionSelectionInput): ExecutionSelectionReport {
  return selectExecutionPlan(input).report
}
