import fs from 'fs'
import path from 'path'
import { getActiveSourceContext, getEnabledSources } from './config'

export type WriteChangeType =
  | 'create'
  | 'append'
  | 'overwrite'
  | 'patch'
  | 'delete_file'
  | 'delete_directory'
  | 'move'
  | 'rename'
  | 'mkdir'
  | 'rmdir'

export type MaintainerWriteProfile = 'repo_app_write' | 'repo_app_maintainer'

export type WritePolicySummary = {
  allowCreate: boolean
  allowOverwrite: boolean
  allowAppend: boolean
  allowPatch: boolean
  allowCreateParentDirectories: boolean
  allowDelete: boolean
  allowDeleteDirectory: boolean
  allowMove: boolean
  allowRename: boolean
  allowMkdir: boolean
  allowRmdir: boolean
  recursiveDeleteRequiresConfirmation: boolean
  maxRecursiveDeleteFilesWithoutConfirmation: number
  allowedRoots: string[]
  blockedGlobs: string[]
  blockedWriteGlobs: string[]
  generatedDeleteAllowedGlobs: string[]
  confirmationRequiredGlobs: string[]
  protectedWriteGlobs: string[]
  protectedGlobs: string[]
  blockedContentPatterns: string[]
  binaryWriteBlocked: boolean
  binaryDeleteAllowedWithConfirmation: boolean
  maxWriteBytes: number
  maxCreateBytes: number
  maxOverwriteBytes: number
  maxPatchTargetBytes: number
}

export type WriteValidationErrorCode =
  | 'WRITE_PATH_BLOCKED'
  | 'PROTECTED_PATH'
  | 'PARENT_DIRECTORY_MISSING'
  | 'CREATE_NOT_ALLOWED'
  | 'OVERWRITE_NOT_ALLOWED'
  | 'APPEND_NOT_ALLOWED'
  | 'PATCH_NOT_ALLOWED'
  | 'DELETE_NOT_ALLOWED'
  | 'MOVE_NOT_ALLOWED'
  | 'RENAME_NOT_ALLOWED'
  | 'MKDIR_NOT_ALLOWED'
  | 'RMDIR_NOT_ALLOWED'
  | 'PATCH_FIND_NOT_FOUND'
  | 'PATCH_MULTIPLE_MATCHES'
  | 'SOURCE_NOT_WRITABLE'
  | 'SOURCE_NOT_READY'
  | 'SOURCE_NOT_FOUND'
  | 'PATH_TRAVERSAL_BLOCKED'
  | 'ABSOLUTE_PATH_BLOCKED'
  | 'PATH_NOT_ALLOWED'
  | 'SECRET_PATH_BLOCKED'
  | 'SECRET_FILE_BLOCKED'
  | 'SECRET_PATTERN_BLOCKED'
  | 'GENERATED_FILE_BLOCKED'
  | 'GENERATED_WRITE_BLOCKED'
  | 'LOCKFILE_WRITE_BLOCKED'
  | 'BINARY_FILE_BLOCKED'
  | 'BINARY_WRITE_BLOCKED'
  | 'BINARY_DELETE_REQUIRES_CONFIRMATION'
  | 'DIRECTORY_NOT_EMPTY'
  | 'TARGET_ALREADY_EXISTS'
  | 'SOURCE_PATH_NOT_FOUND'
  | 'INVALID_CONFIRMATION_TOKEN'
  | 'CONFIRMATION_TOKEN_EXPIRED'
  | 'FILE_TOO_LARGE'
  | 'INVALID_ENCODING'
  | 'VERIFY_FAILED'
  | 'REQUIRES_EXPLICIT_CONFIRMATION'
  | 'OPERATION_NOT_SUPPORTED'

export type WritePreflightResult = {
  status: 'allowed' | 'needs_confirmation' | 'blocked'
  code?: WriteValidationErrorCode
  sourceId?: string
  operation: WriteChangeType
  requestedPath: string
  normalizedPath: string
  from?: string
  to?: string
  reason: string
  hint: string
  matchedAllowGlob?: string
  matchedBlockGlob?: string
  matchedConfirmationGlob?: string
  exists?: boolean
  isDirectory?: boolean
  directoryEmpty?: boolean
  recursiveDeleteCount?: number
  recursiveDirectoryCount?: number
  wouldWrite?: boolean
  wouldDelete?: boolean
  wouldMove?: boolean
  wouldCreateDirectory?: boolean
  requiresConfirmation: boolean
  confirmationToken?: string
  verified: false
}

export type WriteValidationError = {
  code: WriteValidationErrorCode
  message: string
  userMessage: string
  reason: string
  hint: string
  matchedAllowGlob?: string
  matchedBlockGlob?: string
  matchedConfirmationGlob?: string
  requiresConfirmation: boolean
}

export type WriteValidationResult =
  | {
      ok: true
      requestedPath: string
      normalizedPath: string
      sourceRootRelativePath: string
      fullPath: string
      parentPath: string
      policy: WritePolicySummary
    }
  | {
      ok: false
      requestedPath: string
      normalizedPath: string
      sourceRootRelativePath: string
      error: WriteValidationError
      policy: WritePolicySummary
    }

const ENV_TEMPLATE_FILES = new Set([
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.local.example',
  '.env.development.example',
  '.env.production.example'
])

const BLOCKED_WRITE_PATTERNS = [
  /\.pem$/i,
  /\.key$/i,
  /\.crt$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.ppk$/i,
  /(^|\/)id_rsa$/i,
  /(^|\/)id_dsa$/i,
  /(^|\/)id_ed25519$/i,
  /(^|\/)secrets(\/|$)/i,
  /(^|\/)secret(\/|$)/i,
  /(^|\/)credentials(\/|$)/i,
  /(^|\/)[^/]*private_key[^/]*$/i,
  /(^|\/)[^/]*credential[^/]*$/i,
  /(^|\/)[^/]*token[^/]*$/i,
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)node_modules(\/|$)/i,
  /(^|\/)\.next(\/|$)/i,
  /(^|\/)dist(\/|$)/i,
  /(^|\/)build(\/|$)/i,
  /(^|\/)coverage(\/|$)/i,
  /(^|\/)generated(\/|$)/i,
  /(^|\/)vendor(\/|$)/i,
  /(^|\/)\.cache(\/|$)/i,
  /(^|\/)\.turbo(\/|$)/i,
  /(^|\/)\.vercel(\/|$)/i,
  /(^|\/)\.npm(\/|$)/i,
  /(^|\/)\.yarn(\/|$)/i,
  /(^|\/)\.pnpm-store(\/|$)/i,
  /(^|\/)\.prisma\/client(\/|$)/i
]

const SAFE_ROOT_WRITE_FILES = new Set([
  'README.md',
  'DESIGN.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'ROADMAP.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.local.example',
  '.env.development.example',
  '.env.production.example'
])

const SAFE_WRITE_ROOTS = [
  'src',
  'app',
  'components',
  'lib',
  'pages',
  'server',
  'client',
  'shared',
  'features',
  'modules',
  'utils',
  'hooks',
  'services',
  'styles',
  'types',
  'test',
  'tests',
  '__tests__',
  'e2e',
  'playwright',
  'cypress',
  'prisma',
  'scripts',
  'bin',
  'tools',
  'ai/skills',
  'operations/runbooks',
  'operations/specs/video-orchestrator',
  'projects/probot/src',
  'docs',
  'docs/product',
  'docs/product/releases',
  'docs/product/plans',
  'docs/product/prompts',
  'docs/product/notes',
  'docs/plans',
  'docs/prompts',
  'docs/notes',
  'plans',
  'notes',
  'artifacts',
  '.buildflow'
]

const PROTECTED_FILES = new Set(['docker-compose.yml'])
const BLOCKED_DIRECTORY_NAMES = new Set(['node_modules', '.next', 'dist', 'build', 'coverage', '.git'])
const ALLOWED_DOTFILES = new Set(['.github', '.env.example', '.env.sample', '.env.template', '.env.local.example', '.env.development.example', '.env.production.example', '.gitignore', '.buildflow', '.nvmrc', '.prettierrc', '.eslintrc'])
const CONFIRMATION_REQUIRED_GLOBS = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', '.github/**', 'LICENSE']
const BLOCKED_CONTENT_PATTERNS = ['BEGIN RSA PRIVATE KEY', 'BEGIN OPENSSH PRIVATE KEY', 'BEGIN EC PRIVATE KEY', 'ghp_', 'github_pat_', 'sk_live_', 'rk_live_', 'xoxb-', 'AKIA', 'AIza']

export function isSafeRelativePath(relativePath: string): boolean {
  if (!relativePath || relativePath.includes('..') || relativePath.startsWith('/')) return false
  return true
}

export function normalizeRepoRelativePath(requestedPath: string): string {
  return requestedPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/').trim()
}

export function getDefaultWritePolicy(): WritePolicySummary {
  return {
    allowCreate: true,
    allowOverwrite: true,
    allowAppend: true,
    allowPatch: true,
    allowCreateParentDirectories: true,
    allowDelete: true,
    allowDeleteDirectory: true,
    allowMove: true,
    allowRename: true,
    allowMkdir: true,
    allowRmdir: true,
    recursiveDeleteRequiresConfirmation: true,
    maxRecursiveDeleteFilesWithoutConfirmation: 0,
    allowedRoots: ['src/**', 'app/**', 'components/**', 'lib/**', 'pages/**', 'server/**', 'client/**', 'shared/**', 'features/**', 'modules/**', 'utils/**', 'hooks/**', 'services/**', 'styles/**', 'types/**', 'test/**', 'tests/**', '__tests__/**', 'e2e/**', 'playwright/**', 'cypress/**', 'prisma/**', 'scripts/**', 'bin/**', 'tools/**', 'ai/skills/**', 'operations/runbooks/**', 'operations/specs/**', 'operations/specs/video-orchestrator/**', 'projects/*/src/**', 'projects/probot/src/**', 'services/*/src/**', 'packages/*/src/**', 'specs/**', 'runbooks/**', '*.md', '*.mdx', 'docs/**', 'plans/**', 'notes/**', 'artifacts/**', '.buildflow/**', 'README.md', 'CHANGELOG.md', 'CLAUDE.md', 'decision-log.md', 'LICENSE', 'package.json', 'docker-compose.yml', 'Dockerfile', 'next.config.*', 'vite.config.*', 'nuxt.config.*', 'remix.config.*', 'astro.config.*', 'tsconfig.json', 'jsconfig.json', 'tailwind.config.*', 'postcss.config.*', 'components.json', 'eslint.config.*', 'prettier.config.*', '.prettierrc', '.prettierrc.*', 'vitest.config.*', 'jest.config.*', 'playwright.config.*', 'cypress.config.*', 'nixpacks.toml', 'turbo.json', 'pnpm-workspace.yaml', '.env.example', '.env.sample', '.env.template', '.env.local.example', '.env.development.example', '.env.production.example'],
    blockedGlobs: ['.env', '.env.*', '**/*.pem', '**/*.key', '**/id_rsa', '**/id_ed25519', '.git/**', 'node_modules/**', '.next/**', 'dist/**', 'build/**', 'coverage/**', '.cache/**', '.turbo/**', '.vercel/**', '.npm/**', '.yarn/**', '.pnpm-store/**', 'generated/**', '.prisma/client/**', 'ai/private/**', 'ai/secrets/**'],
    blockedWriteGlobs: ['.next/**', 'dist/**', 'build/**', 'out/**', 'coverage/**', '.cache/**', '.turbo/**', '.vercel/**', '.npm/**', '.yarn/**', '.pnpm-store/**', 'generated/**', '.prisma/client/**', 'ai/private/**', 'ai/secrets/**'],
    generatedDeleteAllowedGlobs: ['tsconfig.tsbuildinfo', '.next/**', 'dist/**', 'build/**', 'out/**', 'coverage/**', '.cache/**', '.turbo/**'],
    confirmationRequiredGlobs: CONFIRMATION_REQUIRED_GLOBS,
    protectedWriteGlobs: ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', '.github/**', 'LICENSE'],
    protectedGlobs: [],
    blockedContentPatterns: BLOCKED_CONTENT_PATTERNS,
    binaryWriteBlocked: true,
    binaryDeleteAllowedWithConfirmation: true,
    maxWriteBytes: 1_000_000,
    maxCreateBytes: 200_000,
    maxOverwriteBytes: 300_000,
    maxPatchTargetBytes: 1_000_000
  }
}

function isWithinAllowedRoots(normalized: string): boolean {
  if (!normalized) return false
  if (!normalized.includes('/') && SAFE_ROOT_WRITE_FILES.has(normalized)) return true
  if (getDefaultWritePolicy().allowedRoots.some(pattern => matchesGlob(pattern, normalized))) return true
  if (normalized.endsWith('.md') || normalized.endsWith('.mdx') || normalized.endsWith('.txt') || normalized.endsWith('.json') || normalized.endsWith('.ts') || normalized.endsWith('.tsx') || normalized.endsWith('.js') || normalized.endsWith('.jsx') || normalized.endsWith('.mjs') || normalized.endsWith('.cjs') || normalized.endsWith('.cts') || normalized.endsWith('.mts') || normalized.endsWith('.css') || normalized.endsWith('.scss') || normalized.endsWith('.sass') || normalized.endsWith('.html') || normalized.endsWith('.sql') || normalized.endsWith('.prisma') || normalized.endsWith('.graphql') || normalized.endsWith('.gql') || normalized.endsWith('.yaml') || normalized.endsWith('.yml') || normalized.endsWith('.toml') || normalized.endsWith('.sh') || normalized.endsWith('.bash') || normalized.endsWith('.zsh')) return true
  return SAFE_WRITE_ROOTS.some(root => normalized === root || normalized.startsWith(`${root}/`))
}

function classifyBlockedPath(normalized: string): { code: WriteValidationErrorCode; reason: string; message: string; hint: string } | null {
  if (normalized.startsWith('/') || path.isAbsolute(normalized)) {
    return { code: 'ABSOLUTE_PATH_BLOCKED', reason: 'absolute_path', message: 'Absolute paths outside the repo are blocked.', hint: 'Use a repo-relative path inside the connected source.' }
  }
  if (normalized.includes('..')) {
    return { code: 'PATH_TRAVERSAL_BLOCKED', reason: 'path_traversal', message: 'Path traversal outside the repo is blocked.', hint: 'Use a normalized path within the connected source root.' }
  }
  if (ENV_TEMPLATE_FILES.has(path.basename(normalized))) {
    return null
  }
  if (/(\.env(\..*)?)$/i.test(normalized) || /(^|\/)\.env(\..*)?$/i.test(normalized)) {
    return { code: 'SECRET_PATH_BLOCKED', reason: 'secret_path', message: 'Files that may contain secrets are blocked.', hint: 'Choose a documentation path instead of an environment file.' }
  }
  if (/(^|\/)ai\/(private|secrets)(\/|$)/i.test(normalized)) {
    return { code: 'SECRET_PATH_BLOCKED', reason: 'secret_path', message: 'Private or secret AI paths are blocked.', hint: 'Use ai/skills/** for skill content and keep private notes elsewhere.' }
  }
  if (normalized.split('/').some(part => part === '.next' || part === 'dist' || part === 'build' || part === 'coverage' || part === '.cache' || part === '.turbo' || part === '.vercel' || part === '.npm' || part === '.yarn' || part === '.pnpm-store' || part === 'generated' || part === '.prisma')) {
    return { code: 'GENERATED_WRITE_BLOCKED', reason: 'generated_write', message: 'Generated or build output paths are blocked.', hint: 'Write to the source file or a repo note instead.' }
  }
  if (normalized.split('/').some(part => BLOCKED_DIRECTORY_NAMES.has(part))) {
    return { code: 'PROTECTED_PATH', reason: 'protected_directory', message: 'Protected runtime directories are blocked.', hint: 'Write outside build, dist, node_modules, or .git directories.' }
  }
  if (BLOCKED_WRITE_PATTERNS.some(pattern => pattern.test(normalized))) {
    return { code: 'SECRET_PATH_BLOCKED', reason: 'secret_path', message: 'This path looks like a secret or credential file.', hint: 'Use a docs or project note path instead.' }
  }
  if (PROTECTED_FILES.has(path.basename(normalized))) {
    return { code: 'PROTECTED_PATH', reason: 'protected_file', message: 'This file is protected by policy.', hint: 'Use a docs path or update the source write policy if intentional.' }
  }
  return null
}

function matchesGlob(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '::DOUBLESTAR::').replace(/\*/g, '[^/]*').replace(/::DOUBLESTAR::/g, '.*')
  return new RegExp(`^${escaped}$`, 'i').test(value)
}

function matchesGlobAny(patterns: string[] | undefined, value: string): boolean {
  if (!Array.isArray(patterns)) return false
  return patterns.some(pattern => matchesGlob(pattern, value))
}

function buildConfirmationError(reason: string, hint: string): WriteValidationError {
  return { code: 'REQUIRES_EXPLICIT_CONFIRMATION', message: 'This change requires explicit confirmation.', userMessage: 'BuildFlow needs explicit confirmation before making this change.', reason, hint, requiresConfirmation: true }
}

function buildConfirmationToken(sourceId: string | undefined, operation: WriteChangeType, normalizedPath: string, toPath?: string): string {
  return `confirm:${sourceId || ''}:${operation}:${normalizedPath}${toPath ? `->${normalizeRepoRelativePath(toPath)}` : ''}`
}

function hasValidConfirmation(params: {
  sourceId?: string
  changeType: WriteChangeType
  normalizedPath: string
  toPath?: string
  confirmedByUser?: boolean
  confirmationToken?: string
}): boolean {
  if (params.confirmedByUser === true) return true
  if (typeof params.confirmationToken !== 'string' || !params.confirmationToken) return false
  return params.confirmationToken === buildConfirmationToken(params.sourceId, params.changeType, params.normalizedPath, params.toPath)
}

function isConfirmationRequiredPath(normalizedPath: string): boolean {
  return CONFIRMATION_REQUIRED_GLOBS.some(pattern => matchesGlob(pattern, normalizedPath))
}

function isDependencyChange(content?: string): boolean {
  if (typeof content !== 'string' || !content.trim()) return false
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    return Boolean(parsed.dependencies || parsed.devDependencies || parsed.peerDependencies || parsed.optionalDependencies)
  } catch {
    return false
  }
}

export function validateWriteTarget(params: {
  sourceId?: string
  requestedPath: string
  changeType: WriteChangeType
  sourceRoot?: string
  allowCreateParentDirectories?: boolean
  content?: string
  toPath?: string
  confirmedByUser?: boolean
  confirmationToken?: string
}): WriteValidationResult {
  const policy = getDefaultWritePolicy()
  const requestedPath = params.requestedPath || ''
  const rawRequestedPath = requestedPath.replace(/\\/g, '/').trim()
  const normalizedPath = normalizeRepoRelativePath(requestedPath)
  const sourceRootRelativePath = normalizedPath

  if (!requestedPath || !normalizedPath) {
    return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: 'WRITE_PATH_BLOCKED', message: 'This path is blocked by the source write policy.', userMessage: 'BuildFlow can read this file, but it needs a valid repo-relative path to write it.', reason: 'empty_path', hint: 'Provide a repo-relative path like docs/README.md.', requiresConfirmation: false } }
  }

  if (rawRequestedPath.startsWith('/')) {
    return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: 'ABSOLUTE_PATH_BLOCKED', message: 'Absolute paths outside the repo are blocked.', userMessage: 'BuildFlow can only write inside the connected source root.', reason: 'absolute_path', hint: 'Use a repo-relative path inside the source root.', requiresConfirmation: false } }
  }

  const blocked = classifyBlockedPath(normalizedPath)
  if (blocked) {
    return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: blocked.code, message: blocked.message, userMessage: blocked.message, reason: blocked.reason, hint: blocked.hint, requiresConfirmation: false } }
  }

  const deleteOperation = params.changeType === 'delete_file' || params.changeType === 'delete_directory' || params.changeType === 'rmdir'
  const generatedDeleteAllowed = deleteOperation && matchesGlobAny(policy.generatedDeleteAllowedGlobs, normalizedPath)
  if (!generatedDeleteAllowed && !isWithinAllowedRoots(normalizedPath)) {
    return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: 'PATH_NOT_ALLOWED', message: 'This path is blocked by the source write policy.', userMessage: 'BuildFlow can read this file, but the current write policy blocks changes to this path.', reason: 'path_not_allowed', hint: 'Choose an allowed repo-local path or update the source write policy.', requiresConfirmation: false } }
  }

  if (isConfirmationRequiredPath(normalizedPath) && !hasValidConfirmation({
    sourceId: params.sourceId,
    changeType: params.changeType,
    normalizedPath,
    toPath: params.toPath,
    confirmedByUser: params.confirmedByUser,
    confirmationToken: params.confirmationToken
  })) {
    return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: buildConfirmationError('confirmation_required_path', 'Explicitly confirm before editing lockfiles, GitHub workflows, LICENSE, or Prisma migrations.') }
  }

  if (normalizedPath === 'package.json') {
    if (typeof params.content === 'string') {
      try {
        JSON.parse(params.content)
      } catch {
        return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: 'INVALID_ENCODING', message: 'Package.json content must be valid JSON.', userMessage: 'BuildFlow could not parse package.json content.', reason: 'invalid_json', hint: 'Provide valid JSON before writing package.json.', requiresConfirmation: false } }
      }
    }
  }

  if (typeof params.content === 'string') {
    const byteLength = Buffer.byteLength(params.content, 'utf8')
    const maxBytes = params.changeType === 'create' ? policy.maxCreateBytes : params.changeType === 'overwrite' ? policy.maxOverwriteBytes : policy.maxPatchTargetBytes
    if (byteLength > maxBytes) {
      return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: 'FILE_TOO_LARGE', message: 'The write exceeds the configured size limit.', userMessage: 'BuildFlow is not allowed to write content this large without a smaller change.', reason: 'content_too_large', hint: 'Reduce the file size or split the change into smaller edits.', requiresConfirmation: false } }
    }
    if (BLOCKED_CONTENT_PATTERNS.some(pattern => params.content.includes(pattern))) {
      return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: 'SECRET_PATTERN_BLOCKED', message: 'The content looks like it contains a secret.', userMessage: 'BuildFlow will not write content that looks like a real secret or private key.', reason: 'blocked_content_pattern', hint: 'Replace secrets with placeholders such as [REDACTED] or <token>.', requiresConfirmation: false } }
    }
    if (/[\u0000]/.test(params.content)) {
      return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: 'BINARY_WRITE_BLOCKED', message: 'Binary content is blocked by policy.', userMessage: 'BuildFlow only writes text files with the general repo-write profile.', reason: 'binary_content', hint: 'Use a text-based file or a dedicated binary upload path.', requiresConfirmation: false } }
    }
  }

  if (params.changeType === 'create' && !policy.allowCreate) {
    return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: 'CREATE_NOT_ALLOWED', message: 'Create is blocked by policy.', userMessage: 'BuildFlow is not allowed to create files here.', reason: 'create_blocked', hint: 'Use an allowed docs path or update the source policy.', requiresConfirmation: false } }
  }
  if (params.changeType === 'overwrite' && !policy.allowOverwrite) {
    return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: 'OVERWRITE_NOT_ALLOWED', message: 'Overwrite is blocked by policy.', userMessage: 'BuildFlow is not allowed to overwrite files here.', reason: 'overwrite_blocked', hint: 'Use an allowed docs path or update the source policy.', requiresConfirmation: false } }
  }
  if (params.changeType === 'append' && !policy.allowAppend) {
    return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: 'APPEND_NOT_ALLOWED', message: 'Append is blocked by policy.', userMessage: 'BuildFlow is not allowed to append to files here.', reason: 'append_blocked', hint: 'Use an allowed docs path or update the source policy.', requiresConfirmation: false } }
  }
  if (params.changeType === 'patch' && !policy.allowPatch) {
    return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: 'PATCH_NOT_ALLOWED', message: 'Patch is blocked by policy.', userMessage: 'BuildFlow is not allowed to patch files here.', reason: 'patch_blocked', hint: 'Use an allowed docs path or update the source policy.', requiresConfirmation: false } }
  }
  if (params.changeType === 'delete_file' && !policy.allowDelete) {
    return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: 'DELETE_NOT_ALLOWED', message: 'Delete is blocked by policy.', userMessage: 'BuildFlow is not allowed to delete files here.', reason: 'delete_blocked', hint: 'Use an allowed cleanup path or update the source policy.', requiresConfirmation: false } }
  }
  if ((params.changeType === 'delete_directory' || params.changeType === 'rmdir') && !policy.allowDeleteDirectory) {
    return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: 'DELETE_NOT_ALLOWED', message: 'Directory delete is blocked by policy.', userMessage: 'BuildFlow is not allowed to delete directories here.', reason: 'delete_directory_blocked', hint: 'Use an allowed cleanup path or update the source policy.', requiresConfirmation: false } }
  }
  if (params.changeType === 'move' && !policy.allowMove) {
    return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: 'MOVE_NOT_ALLOWED', message: 'Move is blocked by policy.', userMessage: 'BuildFlow is not allowed to move files here.', reason: 'move_blocked', hint: 'Use an allowed archive path or update the source policy.', requiresConfirmation: false } }
  }
  if (params.changeType === 'rename' && !policy.allowRename) {
    return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: 'RENAME_NOT_ALLOWED', message: 'Rename is blocked by policy.', userMessage: 'BuildFlow is not allowed to rename files here.', reason: 'rename_blocked', hint: 'Use an allowed repo-local path or update the source policy.', requiresConfirmation: false } }
  }
  if (params.changeType === 'mkdir' && !policy.allowMkdir) {
    return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: 'MKDIR_NOT_ALLOWED', message: 'mkdir is blocked by policy.', userMessage: 'BuildFlow is not allowed to create directories here.', reason: 'mkdir_blocked', hint: 'Use an allowed repo-local path or update the source policy.', requiresConfirmation: false } }
  }
  if ((params.changeType === 'delete_directory' || params.changeType === 'rmdir') && !policy.allowRmdir) {
    return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: 'RMDIR_NOT_ALLOWED', message: 'rmdir is blocked by policy.', userMessage: 'BuildFlow is not allowed to remove directories here.', reason: 'rmdir_blocked', hint: 'Use an allowed repo-local path or update the source policy.', requiresConfirmation: false } }
  }

  const sourceRoot = params.sourceRoot ? path.resolve(params.sourceRoot) : ''
  const fullPath = sourceRoot ? path.resolve(path.join(sourceRoot, normalizedPath)) : normalizedPath
  const parentPath = path.dirname(fullPath)
  if (sourceRoot && !fullPath.startsWith(sourceRoot)) {
    return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: 'PATH_TRAVERSAL_BLOCKED', message: 'Path traversal outside the repo is blocked.', userMessage: 'BuildFlow can only write inside the connected source root.', reason: 'path_outside_source_root', hint: 'Use a repo-relative path inside the source root.', requiresConfirmation: false } }
  }

  return { ok: true, requestedPath, normalizedPath, sourceRootRelativePath, fullPath, parentPath, policy }
}

export function getSourceRoot(sourceId?: string): { id: string; path: string } {
  const sources = getEnabledSources()
  if (sources.length === 0) throw new Error('No enabled knowledge sources configured')
  if (sourceId) {
    const source = sources.find(s => s.id === sourceId)
    if (!source) throw new Error(`Source not found: ${sourceId}`)
    return { id: source.id, path: source.path }
  }
  return { id: sources[0].id, path: sources[0].path }
}

export function resolveTargetSourceId(sourceId?: string): string {
  const active = getActiveSourceContext()
  const enabled = getEnabledSources()
  if (sourceId) {
    const source = enabled.find(s => s.id === sourceId)
    if (!source) throw new Error(`Source not found: ${sourceId}`)
    return source.id
  }

  const activeIds = active.mode === 'all' ? enabled.map(s => s.id) : active.activeSourceIds
  if (activeIds.length === 1) return activeIds[0]
  throw new Error('Target sourceId required when multiple sources are active.')
}

export function getResolvedActiveSources(sourceIds?: string[]): Array<{ id: string; path: string }> {
  if (sourceIds && sourceIds.length > 0) {
    const enabled = getEnabledSources()
    const wanted = new Set(sourceIds)
    const resolved = enabled.filter(source => wanted.has(source.id)).map(source => ({ id: source.id, path: source.path }))
    if (resolved.length === 0) throw new Error('No matching active sources found')
    return resolved
  }

  const active = getActiveSourceContext()
  if (active.mode === 'all') {
    return getEnabledSources().map(source => ({ id: source.id, path: source.path }))
  }
  return active.activeSourceIds.map(id => {
    const source = getEnabledSources().find(s => s.id === id)
    if (!source) throw new Error(`Active source not found: ${id}`)
    return { id: source.id, path: source.path }
  })
}

export function resolveWithinSource(relativePath: string, sourceId?: string): { sourceId: string; fullPath: string } {
  if (!isSafeRelativePath(relativePath)) throw new Error('Access denied. Invalid relative path.')
  const source = getSourceRoot(sourceId)
  const fullPath = path.resolve(path.join(source.path, path.normalize(relativePath)))
  const root = path.resolve(source.path)
  if (!fullPath.startsWith(root)) throw new Error('Access denied. Path outside source.')
  return { sourceId: source.id, fullPath }
}

export function isBlockedWritePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/')
  if (!isSafeRelativePath(normalized)) return true
  return BLOCKED_WRITE_PATTERNS.some(pattern => pattern.test(normalized))
}

export function isAllowedArtifactRoot(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/')
  if (!normalized.includes('/') && SAFE_ROOT_WRITE_FILES.has(normalized)) return true
  return SAFE_WRITE_ROOTS.some(root => normalized === root || normalized.startsWith(`${root}/`))
}

export function isAllowedSafeWriteRoot(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/')
  if (!normalized.includes('/') && SAFE_ROOT_WRITE_FILES.has(normalized)) return true
  return SAFE_WRITE_ROOTS.some(root => normalized === root || normalized.startsWith(`${root}/`))
}

export function shouldIncludeEntry(name: string): boolean {
  if (BLOCKED_DIRECTORY_NAMES.has(name)) return false
  if (!name.startsWith('.')) return true
  return ALLOWED_DOTFILES.has(name)
}

export function truncateContent(content: string, maxBytes: number): { content: string; truncated: boolean } {
  const buf = Buffer.from(content, 'utf8')
  if (buf.length <= maxBytes) return { content, truncated: false }
  return { content: buf.subarray(0, maxBytes).toString('utf8'), truncated: true }
}

export function redactSecrets(content: string): string {
  return content
    // Redact double-quoted real secrets, but preserve documentation placeholders [...]
    .replace(/(AWS_SECRET_ACCESS_KEY|OPENAI_API_KEY|API_KEY|TOKEN|SECRET|PASSWORD)\s*[:=]\s*"(?!\[)([^"]+)"/gi, '$1="[REDACTED]"')
    // Redact single-quoted real secrets, but preserve documentation placeholders [...]
    .replace(/(AWS_SECRET_ACCESS_KEY|OPENAI_API_KEY|API_KEY|TOKEN|SECRET|PASSWORD)\s*[:=]\s*'(?!\[)([^']+)'/gi, "$1='[REDACTED]'")
    // Redact unquoted real secrets: alphanumeric/special chars that look like tokens
    // Skip documentation placeholders like "[generate-...]" or "[new-dev-token-only]"
    .replace(/(AWS_SECRET_ACCESS_KEY|OPENAI_API_KEY|API_KEY|TOKEN|SECRET|PASSWORD)\s*[:=]\s*(?!\[)([a-zA-Z0-9_\-\.]{8,})/gi, '$1=[REDACTED]')
    // Redact private keys
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
}
