import crypto from 'node:crypto'
import {
  canonicalizeAutonomyValue,
  createAutonomyDecisionRequest,
  createAutonomyPolicyBinding,
  type AutonomyDecisionRequest
} from '@workbench/shared'
import {
  lookupAutonomyDecision,
  type AutonomyDecisionLookup,
  type AutonomyDecisionStoreOptions
} from './autonomy-decision-store'
import {
  ensurePendingApprovalIntent,
  type ApprovalIntentFailure,
  type WorkbenchApprovalIntentRecord
} from './workbench-approval-intents'

export const ROADMAP_EFFECT_POLICY_VERSION = 'r19.2' as const
export const ROADMAP_EFFECT_MAX_COUNT = 8
export const ROADMAP_EFFECT_MAX_PACKAGES = 8

export type RoadmapEffectAuthority =
  | Readonly<{
      kind: 'package_install'
      packageManager: 'pnpm' | 'npm' | 'yarn' | 'bun'
      toolchain: 'node20.20.2'
      packages: readonly Readonly<{ name: string; version: string }>[]
      workspace: string
      manifestPath: string
      lockfilePath: string
      registryAuthority: 'npmjs'
      installMode: 'frozen_lockfile' | 'update_lockfile'
      generatedSourcePaths?: readonly string[]
    }>
  | Readonly<{
      kind: 'generated_output'
      destination: 'broker_owned_isolated' | 'repository_source'
      artifactScope?: 'run'
      paths?: readonly string[]
    }>
  | Readonly<{
      kind: 'external_service'
      serviceId: string
      operation: 'read' | 'write'
    }>
  | Readonly<{
      kind: 'deployment'
      target: string
    }>

export type RoadmapPackageInstallEffect = Extract<RoadmapEffectAuthority, { kind: 'package_install' }>
export type RoadmapGeneratedOutputEffect = Extract<RoadmapEffectAuthority, { kind: 'generated_output' }>

export type RoadmapEffectDecision = 'allow' | 'deny' | 'requires_confirmation' | 'stop'

export type RoadmapEffectApprovalState = Readonly<{
  bundleDigest: string
  requestFingerprint: string
  state: 'none' | 'matched' | 'expired' | 'policy_changed' | 'unavailable'
  decision?: 'APPROVED' | 'DENIED'
  message?: string
}>

export type RoadmapEffectPhase16Intersection = Readonly<{
  allowedCapabilities: readonly string[]
  deniedCapabilities?: readonly string[]
  allowedPaths?: readonly string[]
}>

export type RoadmapEffectPolicyInput = Readonly<{
  sourceId: string
  runId: string
  sessionId: string
  actorId: string
  policyIdentity: string
  autonomyLevel: number
  phase16Intersection: RoadmapEffectPhase16Intersection
  effect: RoadmapEffectAuthority
  taskPaths: readonly string[]
  packetPaths: readonly string[]
  capabilities: readonly string[]
  approval?: RoadmapEffectApprovalState
}>

export type RoadmapEffectPolicyResult = Readonly<{
  effectType: RoadmapEffectAuthority['kind']
  effectIdentity: string
  decision: RoadmapEffectDecision
  approvalBundleDigest: string
  approvalReusable: boolean
  requestFingerprint: string
  paths: readonly string[]
  requiredCapabilities: readonly string[]
  reasonCode: string
  humanExplanation: string
  request: AutonomyDecisionRequest
}>

export type RoadmapEffectApprovalPreparation = Readonly<{
  evaluation: RoadmapEffectPolicyResult
  approval?: WorkbenchApprovalIntentRecord
  created?: boolean
}>

export type RoadmapEffectApprovalPreparationResult =
  | Readonly<{ ok: true; value: RoadmapEffectApprovalPreparation }>
  | ApprovalIntentFailure

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/
const SAFE_DIGEST = /^[a-f0-9]{64}$/i
const SAFE_PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,119}$/
const EXACT_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const SAFE_SERVICE_OR_TARGET = /^[a-z0-9][a-z0-9._:-]{0,79}$/
const KNOWN_EXTERNAL_SERVICES = new Set(['github', 'cloudflare', 'stripe', 'n8n'])
const KNOWN_DEPLOYMENT_TARGETS = new Set(['origin-main', 'owner-local-release'])
const EXPECTED_LOCKFILES: Record<RoadmapPackageInstallEffect['packageManager'], string> = {
  pnpm: 'pnpm-lock.yaml',
  npm: 'package-lock.json',
  yarn: 'yarn.lock',
  bun: 'bun.lockb'
}

type RecordValue = Record<string, unknown>

function record(value: unknown): value is RecordValue {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function onlyKeys(value: RecordValue, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every(key => allowed.has(key))
}

function relativePath(value: unknown, allowDot = false): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_000) return undefined
  const normalized = value.replace(/\\/g, '/').replace(/\/+/g, '/')
  if (normalized.startsWith('/') || normalized.startsWith('~') || normalized.includes('\0')) return undefined
  const parts = normalized.split('/').filter(part => part.length > 0 && part !== '.')
  if (parts.some(part => part === '..')) return undefined
  if (parts.length === 0) return allowDot ? '.' : undefined
  return parts.join('/')
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

function inScope(candidate: string, roots: readonly string[]): boolean {
  return roots.some(root => root === '.' || candidate === root || candidate.startsWith(root.endsWith('/') ? root : `${root}/`))
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalizeAutonomyValue(value), 'utf8').digest('hex')
}

function packageInstall(value: RecordValue): RoadmapPackageInstallEffect {
  if (!onlyKeys(value, ['kind', 'packageManager', 'toolchain', 'packages', 'workspace', 'manifestPath', 'lockfilePath', 'registryAuthority', 'installMode', 'generatedSourcePaths'])) throw new Error('package_install contains an arbitrary installer, flag, environment, or registry field')
  if (!['pnpm', 'npm', 'yarn', 'bun'].includes(String(value.packageManager))) throw new Error('package_install manager is unknown')
  if (value.toolchain !== 'node20.20.2') throw new Error('package_install toolchain must be the pinned Node 20.20.2 toolchain')
  if (value.registryAuthority !== 'npmjs') throw new Error('package_install registry authority is undeclared')
  if (!['frozen_lockfile', 'update_lockfile'].includes(String(value.installMode))) throw new Error('package_install install mode is unknown')
  const manager = value.packageManager as RoadmapPackageInstallEffect['packageManager']
  if (!Array.isArray(value.packages) || value.packages.length < 1 || value.packages.length > ROADMAP_EFFECT_MAX_PACKAGES) throw new Error('package_install package list is outside the bounded range')
  const packages = value.packages.map((item, index) => {
    if (!record(item) || !onlyKeys(item, ['name', 'version']) || typeof item.name !== 'string' || typeof item.version !== 'string' || !SAFE_PACKAGE.test(item.name) || !EXACT_VERSION.test(item.version)) throw new Error(`package_install package ${index} must contain one exact package name and semver version`)
    return { name: item.name, version: item.version }
  }).sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version))
  if (new Set(packages.map(item => item.name)).size !== packages.length) throw new Error('package_install package names must be unique')
  const workspace = relativePath(value.workspace, true)
  const manifestPath = relativePath(value.manifestPath)
  const lockfilePath = relativePath(value.lockfilePath)
  if (!workspace || !manifestPath || !lockfilePath) throw new Error('package_install workspace, manifest, and lockfile must be safe repository-relative paths')
  if (workspace !== '.' && (!manifestPath.startsWith(`${workspace}/`) || !lockfilePath.startsWith(`${workspace}/`))) throw new Error('package_install manifest and lockfile must remain inside the declared workspace')
  if (lockfilePath.split('/').pop() !== EXPECTED_LOCKFILES[manager]) throw new Error('package_install lockfile does not match the declared package manager')
  if (manager === 'pnpm' && manifestPath.split('/').pop() !== 'package.json') throw new Error('pnpm package_install requires the exact package.json manifest')
  const generatedSourcePaths = value.generatedSourcePaths === undefined ? undefined : (() => {
    if (!Array.isArray(value.generatedSourcePaths) || value.generatedSourcePaths.length > ROADMAP_EFFECT_MAX_PACKAGES) throw new Error('package_install generated source scope is outside the bounded range')
    return sortedUnique(value.generatedSourcePaths.map(item => {
      const path = relativePath(item)
      if (!path) throw new Error('package_install generated source path is unsafe')
      return path
    }))
  })()
  return {
    kind: 'package_install', packageManager: manager, toolchain: 'node20.20.2', packages,
    workspace, manifestPath, lockfilePath, registryAuthority: 'npmjs',
    installMode: value.installMode as 'frozen_lockfile' | 'update_lockfile',
    ...(generatedSourcePaths && generatedSourcePaths.length > 0 ? { generatedSourcePaths } : {})
  }
}

function generatedOutput(value: RecordValue): RoadmapGeneratedOutputEffect {
  if (!onlyKeys(value, ['kind', 'destination', 'artifactScope', 'paths'])) throw new Error('generated_output contains an undeclared destination or write field')
  if (!['broker_owned_isolated', 'repository_source'].includes(String(value.destination))) throw new Error('generated_output destination is not declared')
  if (value.destination === 'broker_owned_isolated') {
    if (value.artifactScope !== 'run' || value.paths !== undefined) throw new Error('broker-owned isolated output must use the fixed run artifact scope and no source paths')
    return { kind: 'generated_output', destination: 'broker_owned_isolated', artifactScope: 'run' }
  }
  if (!Array.isArray(value.paths) || value.paths.length < 1 || value.paths.length > ROADMAP_EFFECT_MAX_PACKAGES) throw new Error('repository generated output requires a bounded exact path list')
  const paths = sortedUnique(value.paths.map(item => {
    const path = relativePath(item)
    if (!path) throw new Error('repository generated output path is unsafe')
    return path
  }))
  return { kind: 'generated_output', destination: 'repository_source', paths }
}

function externalService(value: RecordValue): RoadmapEffectAuthority {
  if (!onlyKeys(value, ['kind', 'serviceId', 'operation'])) throw new Error('external_service contains an undeclared endpoint, credential, or payload field')
  if (!SAFE_SERVICE_OR_TARGET.test(String(value.serviceId)) || !['read', 'write'].includes(String(value.operation))) throw new Error('external_service identity or operation is invalid')
  return { kind: 'external_service', serviceId: String(value.serviceId), operation: value.operation as 'read' | 'write' }
}

function deployment(value: RecordValue): RoadmapEffectAuthority {
  if (!onlyKeys(value, ['kind', 'target'])) throw new Error('deployment contains an undeclared target or execution field')
  if (!SAFE_SERVICE_OR_TARGET.test(String(value.target))) throw new Error('deployment target is invalid')
  return { kind: 'deployment', target: String(value.target) }
}

export function normalizeRoadmapEffects(value: unknown, taskPaths: readonly string[]): RoadmapEffectAuthority[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length < 1 || value.length > ROADMAP_EFFECT_MAX_COUNT) throw new Error(`effects must contain 1-${ROADMAP_EFFECT_MAX_COUNT} typed effects`)
  const normalized = value.map((item, index) => {
    if (!record(item) || typeof item.kind !== 'string') throw new Error(`effect ${index} has no typed kind`)
    if (item.kind === 'package_install') {
      const effect = packageInstall(item)
      if (!taskPaths.includes(effect.manifestPath) || !taskPaths.includes(effect.lockfilePath)) throw new Error('package_install manifest and lockfile must both be exact task paths')
      if (effect.generatedSourcePaths?.some(itemPath => !taskPaths.includes(itemPath))) throw new Error('package_install generated source scope expands beyond task paths')
      return effect
    }
    if (item.kind === 'generated_output') {
      const effect = generatedOutput(item)
      if (effect.destination === 'repository_source' && effect.paths?.some(itemPath => !taskPaths.includes(itemPath))) throw new Error('repository generated output expands beyond task paths')
      return effect
    }
    if (item.kind === 'external_service') return externalService(item)
    if (item.kind === 'deployment') return deployment(item)
    throw new Error(`effect ${index} has an unknown typed kind`)
  })
  const identities = normalized.map(effect => digest(effect))
  if (new Set(identities).size !== identities.length) throw new Error('duplicate typed effects are not allowed')
  return [...normalized].sort((left, right) => digest(left).localeCompare(digest(right)))
}

function effectPaths(effect: RoadmapEffectAuthority): string[] {
  if (effect.kind === 'package_install') return sortedUnique([effect.manifestPath, effect.lockfilePath, ...(effect.generatedSourcePaths || [])])
  if (effect.kind === 'generated_output' && effect.destination === 'repository_source') return sortedUnique([...(effect.paths || [])])
  return []
}

function requiredCapabilities(input: RoadmapEffectPolicyInput): string[] {
  if (input.effect.kind === 'package_install') return ['install', 'lockfile_change', 'network_request']
  if (input.effect.kind === 'external_service') return ['external_service', 'network_request']
  if (input.effect.kind === 'deployment') return ['deployment']
  if (input.effect.destination === 'repository_source') {
    const writeCapability = input.capabilities.find(item => ['create_file', 'patch_file', 'append_file', 'overwrite_file', 'move_file'].includes(item))
    return [writeCapability || 'create_file']
  }
  return []
}

function bundle(input: RoadmapEffectPolicyInput): { identity: RecordValue; value: RecordValue; paths: string[]; required: string[] } {
  const paths = effectPaths(input.effect)
  const required = requiredCapabilities(input)
  const identity = {
    version: ROADMAP_EFFECT_POLICY_VERSION,
    sourceId: input.sourceId, runId: input.runId, sessionId: input.sessionId, actorId: input.actorId,
    effect: input.effect
  }
  return {
    identity,
    value: {
      ...identity,
      policyIdentity: input.policyIdentity,
      autonomyLevel: input.autonomyLevel,
      phase16Intersection: input.phase16Intersection,
      taskPaths: sortedUnique(input.taskPaths),
      packetPaths: sortedUnique(input.packetPaths),
      capabilities: sortedUnique(input.capabilities),
      requiredCapabilities: required,
      effectPaths: paths
    },
    paths,
    required
  }
}

export function roadmapEffectBundleDigest(input: RoadmapEffectPolicyInput): string {
  return digest(bundle(input).value)
}

export function roadmapEffectIdentity(input: RoadmapEffectPolicyInput): string {
  return digest(bundle(input).identity)
}

export function createRoadmapEffectDecisionRequest(input: RoadmapEffectPolicyInput): AutonomyDecisionRequest {
  const built = bundle(input)
  const approvalPolicy = createAutonomyPolicyBinding(ROADMAP_EFFECT_POLICY_VERSION, built.value)
  return createAutonomyDecisionRequest({
    operation: 'approved_capability',
    category: 'capability',
    sourceId: input.sourceId,
    runId: input.runId,
    sessionId: input.sessionId,
    actorId: input.actorId,
    capabilityId: 'roadmap-effect',
    paths: built.paths,
    // Keep policy context in the persisted policy binding, not in the scope
    // arguments. That preserves Phase 16's policy_changed classification when
    // the same effect is re-evaluated under a changed policy.
    arguments: { effectIdentity: digest(built.identity), effect: input.effect },
    policy: approvalPolicy
  })
}

function result(input: RoadmapEffectPolicyInput, decision: RoadmapEffectDecision, reasonCode: string, humanExplanation: string, request: AutonomyDecisionRequest, reusable = false): RoadmapEffectPolicyResult {
  const built = bundle(input)
  const summary = input.effect.kind === 'package_install'
    ? `package=${input.effect.packages.map(item => `${item.name}@${item.version}`).join(',')} manager=${input.effect.packageManager} toolchain=${input.effect.toolchain} registry=${input.effect.registryAuthority} manifest=${input.effect.manifestPath} lockfile=${input.effect.lockfilePath} mode=${input.effect.installMode} generated=${input.effect.generatedSourcePaths?.join(',') || 'none'}`
    : input.effect.kind === 'generated_output'
      ? input.effect.destination === 'repository_source' ? `generated repository paths=${input.effect.paths?.join(',') || 'none'}` : 'generated destination=broker-owned-isolated scope=run'
      : input.effect.kind === 'external_service' ? `external=${input.effect.serviceId} operation=${input.effect.operation}`
        : `deployment=${input.effect.target}`
  const explanation = `${humanExplanation} ${summary}`.slice(0, 320)
  return {
    effectType: input.effect.kind,
    effectIdentity: digest(built.identity),
    decision,
    approvalBundleDigest: digest(built.value),
    approvalReusable: reusable,
    requestFingerprint: request.requestFingerprint,
    paths: built.paths,
    requiredCapabilities: built.required,
    reasonCode,
    humanExplanation: explanation,
    request
  }
}

export function evaluateRoadmapEffectPolicy(input: RoadmapEffectPolicyInput): RoadmapEffectPolicyResult {
  const built = bundle(input)
  let request: AutonomyDecisionRequest
  try {
    request = createRoadmapEffectDecisionRequest(input)
  } catch (error) {
    const fallback = createAutonomyDecisionRequest({
      operation: 'approved_capability', category: 'capability', sourceId: input.sourceId, runId: input.runId,
      sessionId: input.sessionId, actorId: input.actorId, capabilityId: 'roadmap-effect',
      policy: createAutonomyPolicyBinding(ROADMAP_EFFECT_POLICY_VERSION, built.value)
    })
    return result(input, 'stop', 'malformed_bundle', error instanceof Error ? error.message : 'Effect approval bundle is malformed.', fallback)
  }
  if (!Number.isInteger(input.autonomyLevel) || input.autonomyLevel < 0 || input.autonomyLevel > 5) return result(input, 'stop', 'level5_boundary', 'R19.2 effect policy only accepts autonomy levels 0 through 5.', request)
  if (!SAFE_ID.test(input.sourceId) || !SAFE_ID.test(input.runId) || !SAFE_ID.test(input.sessionId) || !SAFE_ID.test(input.actorId) || !SAFE_ID.test(input.policyIdentity)) return result(input, 'stop', 'identity_invalid', 'The effect bundle has an invalid source, run, session, actor, or policy identity.', request)
  if (input.effect.kind === 'deployment') return result(input, 'stop', KNOWN_DEPLOYMENT_TARGETS.has(input.effect.target) ? 'deployment_hard_stop' : 'hidden_deployment', KNOWN_DEPLOYMENT_TARGETS.has(input.effect.target) ? 'Deployment is a separate hard stop and cannot be approved through the package or network decision.' : 'The deployment target is not in the bounded release authority; deployment remains a hard stop.', request)
  if (input.effect.kind === 'external_service' && !KNOWN_EXTERNAL_SERVICES.has(input.effect.serviceId)) return result(input, 'stop', 'unknown_external_service', 'The external service is not in the bounded service authority; declare a separate supported service before retrying.', request)
  if (input.effect.kind === 'generated_output' && input.effect.destination === 'repository_source') {
    if (!input.effect.paths?.every(itemPath => input.taskPaths.includes(itemPath) && input.packetPaths.includes(itemPath))) return result(input, 'stop', 'generated_scope_expanded', 'Generated repository output must use exact task and packet paths.', request)
  }
  if (input.effect.kind === 'package_install') {
    if (!input.taskPaths.includes(input.effect.manifestPath) || !input.taskPaths.includes(input.effect.lockfilePath)) return result(input, 'stop', 'unexpected_lockfile_scope', 'The exact manifest and lockfile are outside the declared task path scope.', request)
    if (input.effect.generatedSourcePaths?.some(itemPath => !input.taskPaths.includes(itemPath))) return result(input, 'stop', 'generated_scope_expanded', 'Generated package-install output is outside the declared task path scope.', request)
  }
  const allowedCapabilities = new Set(input.phase16Intersection.allowedCapabilities)
  const deniedCapabilities = new Set(input.phase16Intersection.deniedCapabilities || [])
  const missingCapability = built.required.find(capability => deniedCapabilities.has(capability) || !allowedCapabilities.has(capability))
  if (missingCapability) return result(input, 'deny', 'phase16_intersection_denied', `The Phase 16 intersection does not grant the exact ${missingCapability} effect capability.`, request)
  const allowedPaths = input.phase16Intersection.allowedPaths
  const outside = allowedPaths && built.paths.find(itemPath => !inScope(itemPath, allowedPaths))
  if (outside) return result(input, 'deny', 'phase16_path_intersection_denied', `Effect path ${outside} is outside the Phase 16 allowed path intersection.`, request)
  if (input.effect.kind === 'generated_output' && input.effect.destination === 'broker_owned_isolated') return result(input, 'allow', 'isolated_output_allowed', 'Broker-owned isolated output is already bounded by the R18.3 artifact authority; no new prompt is required.', request)

  const approval = input.approval
  if (approval && approval.bundleDigest !== digest(built.value)) return result(input, 'stop', 'stale_policy', 'The supplied approval does not bind to this exact effect bundle.', request)
  if (approval && approval.requestFingerprint && approval.requestFingerprint !== request.requestFingerprint) return result(input, 'stop', 'stale_policy', 'The supplied approval request identity changed; recompile and request a new exact decision.', request)
  if (approval?.state === 'policy_changed' || approval?.state === 'unavailable') return result(input, 'stop', 'stale_policy', approval.message || 'The persisted approval is unavailable or was created under a different policy.', request)
  if (approval?.state === 'matched' && approval.decision === 'APPROVED') return result(input, 'allow', 'persisted_approval_reused', 'The identical approved effect bundle is reused with zero additional prompts.', request, true)
  if (approval?.state === 'matched' && approval.decision === 'DENIED') return result(input, 'deny', 'persisted_denial', 'The identical denied effect bundle remains denied; no repeated prompt is created.', request)
  if (input.effect.kind === 'package_install') return result(input, 'requires_confirmation', 'bounded_install_confirmation_required', 'Confirm this one bounded package, registry, toolchain, manifest, lockfile, and generated-source bundle.', request)
  if (input.effect.kind === 'generated_output') return result(input, 'requires_confirmation', 'generated_source_confirmation_required', 'Confirm the exact generated repository paths as a separate source-write effect.', request)
  return result(input, 'requires_confirmation', 'external_service_confirmation_required', 'Confirm this external service effect separately; it is not covered by package-install approval.', request)
}

export function lookupRoadmapEffectApproval(input: RoadmapEffectPolicyInput, options?: AutonomyDecisionStoreOptions): RoadmapEffectApprovalState {
  const request = createRoadmapEffectDecisionRequest(input)
  const bundleDigest = roadmapEffectBundleDigest(input)
  const lookup = lookupAutonomyDecision(request, options)
  if (lookup.ok === false) return { bundleDigest, requestFingerprint: request.requestFingerprint, state: 'unavailable', message: lookup.message }
  return {
    bundleDigest,
    requestFingerprint: request.requestFingerprint,
    state: lookup.state,
    ...(lookup.decision ? { decision: lookup.decision.decision } : {})
  }
}

export function prepareRoadmapEffectApprovalIntent(input: RoadmapEffectPolicyInput & { now?: string; storeOptions?: AutonomyDecisionStoreOptions; requestId?: string }): RoadmapEffectApprovalPreparationResult {
  const evaluation = evaluateRoadmapEffectPolicy(input)
  if (evaluation.decision !== 'requires_confirmation') return { ok: true, value: { evaluation } }
  const now = input.now || new Date().toISOString()
  const pending = ensurePendingApprovalIntent({
    sourceId: input.sourceId,
    runId: input.runId,
    sessionId: input.sessionId,
    requestId: input.requestId,
    operationKind: 'roadmap-effect-bundle',
    paths: [...evaluation.paths],
    reason: evaluation.humanExplanation,
    requestDigest: evaluation.requestFingerprint,
    decisionRequest: evaluation.request,
    evidenceRef: {
      evidenceId: `effect-${evaluation.approvalBundleDigest.slice(0, 32)}`,
      kind: 'validation_result',
      reference: `workbench://roadmap-effects/${evaluation.approvalBundleDigest}`,
      recordedAt: now
    },
    options: input.storeOptions
  })
  if (pending.ok === false) return pending
  return { ok: true, value: { evaluation, approval: pending.record, created: pending.created } }
}

export function approvalStateFromLookup(input: RoadmapEffectPolicyInput, lookup: AutonomyDecisionLookup): RoadmapEffectApprovalState {
  const request = createRoadmapEffectDecisionRequest(input)
  return {
    bundleDigest: roadmapEffectBundleDigest(input),
    requestFingerprint: request.requestFingerprint,
    state: lookup.ok === false ? 'unavailable' : lookup.state,
    ...(lookup.ok && lookup.decision ? { decision: lookup.decision.decision } : {}),
    ...(lookup.ok === false ? { message: lookup.message } : {})
  }
}
