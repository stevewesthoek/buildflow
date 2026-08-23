import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import crypto from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, chmod, lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'

export type CbmGraphContextRequest = {
  sourceId: string
  sourceRoot: string
  query?: string
  limit: number
}

export type CbmFreshnessState = 'fresh' | 'stale' | 'unknown'

export type CbmGraphContextData = {
  sourceId: string
  freshness: CbmFreshnessState
  suggestedFiles?: string[]
  suggestedSymbols?: string[]
  matches?: string[]
  nextActions?: Array<Record<string, unknown>>
  communityHubs?: string[]
  godNodes?: string[]
  diagnostics?: Record<string, unknown>
}

export interface CbmGraphContextTransport {
  resolveGraphContext(request: CbmGraphContextRequest): Promise<CbmGraphContextData>
}

export type CbmPreflightStage =
  | 'executable_unavailable'
  | 'executable_safety_failure'
  | 'cache_unavailable'
  | 'cache_safety_failure'
  | 'no_index'
  | 'stale_index'
  | 'mcp_initialization_failure'
  | 'mcp_request_failure'

export class CbmTransportUnavailableError extends Error {
  constructor(
    message = 'Codebase Memory transport is not configured',
    public readonly stage: CbmPreflightStage = 'mcp_request_failure'
  ) {
    super(message)
    this.name = 'CbmTransportUnavailableError'
  }
}

// Thrown when a provider path cannot be safely canonicalized inside the source root.
// Causes exact-source fallback with mismatch reason unsafe_changed_path.
export class CbmUnsafeChangedPathError extends CbmTransportUnavailableError {
  constructor() {
    super('Codebase Memory changed-path list contained an unsafe path', 'stale_index')
    this.name = 'CbmUnsafeChangedPathError'
  }
}

// Allowed freshness mismatch reasons for structured diagnostics.
export type CbmFingerprintMismatchReason =
  | 'metadata_missing'
  | 'metadata_version_mismatch'
  | 'source_root_mismatch'
  | 'head_mismatch'
  | 'fingerprint_mismatch'
  | 'fingerprint_algorithm_mismatch'
  | 'provider_not_ready'
  | 'unsafe_changed_path'

// Algorithm identifier embedded in v2 metadata.
export const FINGERPRINT_ALGORITHM = 'worktree-v2-path-size-mtime-mode' as const

// Current freshness metadata schema version.
export const FRESHNESS_METADATA_VERSION = 2 as const

type JsonObject = Record<string, unknown>

type CbmRpcSession = {
  initialize(): Promise<void>
  callTool(name: string, args: JsonObject): Promise<JsonObject>
  close(): Promise<void>
  terminate(): void
}

type CodebaseMemoryTransportOptions = {
  executablePath?: string
  cacheDir?: string
  cacheRoot?: string
  timeoutMs?: number
  sessionFactory?: (input: { executablePath: string; cacheDir: string; cwd: string }) => CbmRpcSession
  currentHead?: (sourceRoot: string) => Promise<string | undefined>
  canonicalPath?: (inputPath: string) => Promise<string>
}

type CodebaseMemoryIndexOptions = {
  executablePath?: string
  cacheDir?: string
  cacheRoot?: string
  timeoutMs?: number
}

const DEFAULT_PROVIDER_TIMEOUT_MS = 1_300
const MAX_STDOUT_BYTES = 1024 * 1024
const MAX_STDERR_BYTES = 64 * 1024
const MCP_PROTOCOL_VERSION = '2025-03-26'
const SAFE_PROJECT_NAME = /[^a-zA-Z0-9._-]/g
const FRESHNESS_METADATA_FILE = '_workbench-index.json'
const MAX_FRESHNESS_METADATA_BYTES = 64 * 1024
const NON_SOURCE_PATH_SEGMENTS = new Set([
  '.git', '.build', '.buildflow', '.cache', '.next', '.turbo', '.graphify-out',
  'build', 'coverage', 'dist', 'graphify-out', 'node_modules', 'out', 'vendor'
])

// Credential-like and protected basenames excluded from freshness fingerprinting.
const CREDENTIAL_LIKE_BASENAME_PREFIXES = ['.env']
const CREDENTIAL_LIKE_BASENAME_SUFFIXES = ['.pem', '.key', '.p12', '.pfx', '.jks', '.crt', '.cer']
const CREDENTIAL_LIKE_EXACT_BASENAMES = new Set([
  'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa',
  '.netrc', 'credentials', '.credentials'
])
const CREDENTIAL_LIKE_BASENAME_SAFE_INFIX = ['example', 'sample', 'template', '.example.', '.sample.', '.template.']

export function isCredentialLikePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '')
  const basename = normalized.split('/').filter(Boolean).pop() || ''
  const lower = basename.toLowerCase()
  if (CREDENTIAL_LIKE_EXACT_BASENAMES.has(lower)) return true
  if (CREDENTIAL_LIKE_BASENAME_SUFFIXES.some(suffix => lower.endsWith(suffix))) return true
  if (CREDENTIAL_LIKE_BASENAME_PREFIXES.some(prefix => lower.startsWith(prefix))) {
    if (CREDENTIAL_LIKE_BASENAME_SAFE_INFIX.some(safe => lower.includes(safe))) return false
    return true
  }
  return false
}

type ExecutableVerificationStat = {
  isFile(): boolean
  mode: number
  uid: number
}

type ExecutableVerifierDependencies = {
  realpath(inputPath: string): Promise<string>
  stat(inputPath: string): Promise<ExecutableVerificationStat>
  access(inputPath: string, mode: number): Promise<void>
  currentUid(): number | undefined
}

export function createCodebaseMemoryExecutableVerifier(
  overrides: Partial<ExecutableVerifierDependencies> = {}
): (inputPath?: string) => Promise<string> {
  const dependencies: ExecutableVerifierDependencies = {
    realpath,
    stat,
    access,
    currentUid: () => typeof process.getuid === 'function' ? process.getuid() : undefined,
    ...overrides
  }
  let verifiedDefaultPath: string | undefined

  return async (inputPath?: string): Promise<string> => {
    if (!inputPath && verifiedDefaultPath) return verifiedDefaultPath
    const candidate = inputPath || path.join(os.homedir(), '.local', 'bin', 'codebase-memory-mcp')
    if (!path.isAbsolute(candidate)) {
      throw new CbmTransportUnavailableError(
        'Codebase Memory executable path must be absolute',
        'executable_safety_failure'
      )
    }
    let resolved: string
    try {
      resolved = await dependencies.realpath(candidate)
    } catch {
      throw new CbmTransportUnavailableError(
        'Codebase Memory executable is unavailable',
        'executable_unavailable'
      )
    }
    const details = await dependencies.stat(resolved).catch(() => undefined)
    if (!details) {
      throw new CbmTransportUnavailableError(
        'Codebase Memory executable is unavailable',
        'executable_unavailable'
      )
    }
    if (!details.isFile() || (details.mode & 0o022) !== 0) {
      throw new CbmTransportUnavailableError(
        'Codebase Memory executable failed owner-local safety checks',
        'executable_safety_failure'
      )
    }
    const uid = dependencies.currentUid() ?? details.uid
    if (details.uid !== uid && details.uid !== 0) {
      throw new CbmTransportUnavailableError(
        'Codebase Memory executable has an unexpected owner',
        'executable_safety_failure'
      )
    }
    try {
      await dependencies.access(resolved, fsConstants.X_OK)
    } catch {
      throw new CbmTransportUnavailableError(
        'Codebase Memory executable is not executable',
        'executable_safety_failure'
      )
    }
    if (!inputPath) verifiedDefaultPath = resolved
    return resolved
  }
}

const verifyExecutable = createCodebaseMemoryExecutableVerifier()

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function boundedLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(10, Math.floor(value))) : 8
}

function uniqueStrings(values: Array<string | undefined>, limit: number): string[] {
  const seen = new Set<string>()
  const output: string[] = []
  for (const value of values) {
    const clean = value?.trim()
    if (!clean || seen.has(clean)) continue
    seen.add(clean)
    output.push(clean)
    if (output.length >= limit) break
  }
  return output
}

function safeName(value: string, fallback: string): string {
  const normalized = value.replace(SAFE_PROJECT_NAME, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  return normalized || fallback
}

export function codebaseMemoryCacheDir(sourceId: string, sourceRoot: string, cacheRoot?: string): string {
  const root = cacheRoot || path.join(os.homedir(), 'Library', 'Caches', 'brain', 'codebase-memory-mcp')
  const canonicalIdentity = path.resolve(sourceRoot)
  const identityHash = crypto.createHash('sha256').update(canonicalIdentity).digest('hex').slice(0, 12)
  const sourceName = safeName(sourceId, safeName(path.basename(canonicalIdentity), 'repository'))
  return path.join(root, `${sourceName}-${identityHash}`)
}

export function canonicalBrainCodebaseMemoryCacheDir(sourceRoot: string, cacheRoot?: string): string {
  const root = cacheRoot || path.join(os.homedir(), 'Library', 'Caches', 'brain', 'codebase-memory-mcp')
  const canonicalIdentity = path.resolve(sourceRoot)
  return path.join(root, safeName(path.basename(canonicalIdentity), 'repository'))
}

function selectedCacheDirectory(
  sourceId: string,
  sourceRoot: string,
  options: { cacheDir?: string; cacheRoot?: string }
): string {
  if (options.cacheDir) {
    if (!path.isAbsolute(options.cacheDir)) {
      throw new CbmTransportUnavailableError(
        'Codebase Memory cache path must be absolute',
        'cache_safety_failure'
      )
    }
    return path.normalize(options.cacheDir)
  }
  if (options.cacheRoot) return codebaseMemoryCacheDir(sourceId, sourceRoot, options.cacheRoot)
  return canonicalBrainCodebaseMemoryCacheDir(sourceRoot)
}

async function verifyCacheDirectory(cacheDir: string): Promise<string> {
  const details = await lstat(cacheDir).catch(() => undefined)
  if (!details) {
    throw new CbmTransportUnavailableError(
      'Codebase Memory cache is unavailable for this source',
      'cache_unavailable'
    )
  }
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new CbmTransportUnavailableError(
      'Codebase Memory cache failed owner-local safety checks',
      'cache_safety_failure'
    )
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : details.uid
  if (details.uid !== uid || (details.mode & 0o077) !== 0) {
    throw new CbmTransportUnavailableError(
      'Codebase Memory cache failed owner-local safety checks',
      'cache_safety_failure'
    )
  }
  try {
    return await realpath(cacheDir)
  } catch {
    throw new CbmTransportUnavailableError(
      'Codebase Memory cache is unavailable for this source',
      'cache_unavailable'
    )
  }
}

function execFileText(executable: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
      timeout: options.timeout,
      maxBuffer: MAX_STDOUT_BYTES
    }, (error, stdout, stderr) => {
      if (error) {
        const diagnostic = String(stderr || error.message).trim().slice(0, 500)
        reject(new Error(diagnostic || 'Codebase Memory command failed'))
        return
      }
      resolve(String(stdout || '').trim())
    })
  })
}

async function gitHead(sourceRoot: string): Promise<string | undefined> {
  try {
    return asString(await execFileText('/usr/bin/git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { timeout: 1_000 }))
  } catch {
    return undefined
  }
}

async function callCbmTool(session: CbmRpcSession, name: string, args: JsonObject): Promise<JsonObject> {
  try {
    return await session.callTool(name, args)
  } catch (error) {
    if (error instanceof CbmTransportUnavailableError) throw error
    throw new CbmTransportUnavailableError(
      `Codebase Memory MCP request failed: ${name}`,
      'mcp_request_failure'
    )
  }
}

class StdioCbmRpcSession implements CbmRpcSession {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, { resolve: (value: JsonObject) => void; reject: (error: Error) => void }>()
  private nextId = 1
  private stdoutBuffer = ''
  private stdoutBytes = 0
  private stderrBytes = 0
  private closed = false

  constructor(input: { executablePath: string; cacheDir: string; cwd: string }) {
    // Safety: executablePath is verified absolute, non-writable by others, owner-only,
    // executable, and not request-controlled. args=[] fixed. shell=false. Output bounded.
    // Timeout cleanup is the caller's responsibility via terminate()+close().
    this.child = spawn(input.executablePath, [], {
      cwd: input.cwd,
      env: { ...process.env, CBM_CACHE_DIR: input.cacheDir },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stdout.on('data', chunk => this.onStdout(String(chunk)))
    this.child.stderr.on('data', chunk => {
      this.stderrBytes += Buffer.byteLength(String(chunk), 'utf8')
      if (this.stderrBytes > MAX_STDERR_BYTES) this.failAll(new Error('Codebase Memory diagnostic output exceeded its limit'))
    })
    this.child.once('error', error => this.failAll(error))
    this.child.once('exit', (code, signal) => {
      this.closed = true
      if (this.pending.size > 0) this.failAll(new Error(`Codebase Memory exited before responding (${code ?? signal ?? 'unknown'})`))
    })
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'workbench', version: '1.0.0' }
    })
    await this.write({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
  }

  async callTool(name: string, args: JsonObject): Promise<JsonObject> {
    const result = await this.request('tools/call', { name, arguments: args })
    if (result.isError === true) throw new Error(`Codebase Memory tool failed: ${name}`)
    const structured = asObject(result.structuredContent)
    if (structured) return structured
    const text = asArray(result.content)
      .map(item => asObject(item))
      .find(item => item?.type === 'text' && typeof item.text === 'string')?.text
    if (typeof text !== 'string') return {}
    const parsed = JSON.parse(text)
    return asObject(parsed) || {}
  }

  async close(): Promise<void> {
    if (this.closed || this.child.exitCode !== null) return
    this.child.stdin.end()
    await this.waitForExit(250)
    if (this.child.exitCode === null && !this.closed) {
      this.child.kill('SIGTERM')
      await this.waitForExit(500)
    }
    if (this.child.exitCode === null && !this.closed) {
      this.child.kill('SIGKILL')
      await this.waitForExit(500)
    }
  }

  terminate(): void {
    if (!this.closed && this.child.exitCode === null) this.child.kill('SIGTERM')
    this.failAll(new Error('CBM_TIMEOUT'))
  }

  private async request(method: string, params: JsonObject): Promise<JsonObject> {
    const id = this.nextId++
    const response = new Promise<JsonObject>((resolve, reject) => this.pending.set(id, { resolve, reject }))
    try {
      await this.write({ jsonrpc: '2.0', id, method, params })
    } catch (error) {
      this.pending.delete(id)
      throw error
    }
    return response
  }

  private async write(value: JsonObject): Promise<void> {
    if (this.closed || this.child.stdin.destroyed) throw new CbmTransportUnavailableError('Codebase Memory subprocess is unavailable')
    const writable = this.child.stdin.write(`${JSON.stringify(value)}\n`)
    if (!writable) await once(this.child.stdin, 'drain')
  }

  private onStdout(chunk: string): void {
    this.stdoutBytes += Buffer.byteLength(chunk, 'utf8')
    if (this.stdoutBytes > MAX_STDOUT_BYTES) {
      this.terminate()
      return
    }
    this.stdoutBuffer += chunk
    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n')
      if (newline < 0) break
      const line = this.stdoutBuffer.slice(0, newline).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      if (!line) continue
      let message: JsonObject
      try {
        message = asObject(JSON.parse(line)) || {}
      } catch {
        this.failAll(new Error('Codebase Memory returned malformed JSON-RPC'))
        return
      }
      const id = typeof message.id === 'number' ? message.id : undefined
      if (id === undefined) continue
      const pending = this.pending.get(id)
      if (!pending) continue
      this.pending.delete(id)
      const rpcError = asObject(message.error)
      if (rpcError) pending.reject(new Error(asString(rpcError.message) || 'Codebase Memory JSON-RPC error'))
      else pending.resolve(asObject(message.result) || {})
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  private async waitForExit(timeoutMs: number): Promise<void> {
    if (this.closed || this.child.exitCode !== null) return
    await Promise.race([
      once(this.child, 'exit').catch(() => undefined),
      new Promise(resolve => setTimeout(resolve, timeoutMs))
    ])
  }
}

function projectForRoot(result: JsonObject, canonicalRoot: string): JsonObject | undefined {
  return asArray(result.projects)
    .map(asObject)
    .find(project => {
      const git = asObject(project?.git)
      const candidate = asString(git?.canonical_root) || asString(project?.root_path)
      return candidate ? path.resolve(candidate) === path.resolve(canonicalRoot) : false
    })
}

function changedCount(result: JsonObject): number | undefined {
  if (typeof result.changed_count === 'number') return result.changed_count
  if (Array.isArray(result.changed_files)) return result.changed_files.length
  return undefined
}

// v1 type kept for readFreshnessMetadata rejection path (version mismatch detection).
type CbmFreshnessMetadataV1 = {
  version: 1
  sourceRoot: string
  project: string
  indexedAtSha?: string
  worktreeFingerprint: string
  indexedAt: string
  indexedFileCount?: number
  providerVersion?: string
}

// v2 schema — deterministic fingerprint, no ctimeMs, explicit algorithm.
export type CbmFreshnessMetadataV2 = {
  version: 2
  sourceRoot: string
  project: string
  indexedAtSha?: string
  worktreeFingerprint: string
  fingerprintAlgorithm: typeof FINGERPRINT_ALGORITHM
  changedPathCountRaw: number
  changedPathCountCanonical: number
  changedPathSetDigest: string
  indexedAt: string
  indexedFileCount?: number
  providerVersion?: string
}

type CbmFreshnessMetadata = CbmFreshnessMetadataV2

export function shouldFingerprintChange(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '')
  const segments = normalized.split('/').filter(Boolean)
  if (segments.some(segment => NON_SOURCE_PATH_SEGMENTS.has(segment))) return false
  const basename = segments[segments.length - 1] || ''
  if (basename === '.DS_Store') return false
  if (isCredentialLikePath(relativePath)) return false
  return true
}

// Canonicalize a single raw provider path against the real source root.
// Returns the canonical POSIX-relative path, or undefined if the path should
// be silently skipped (empty/non-source filtered). Throws CbmUnsafeChangedPathError
// when the path escapes the source root — this causes exact-source fallback.
export function canonicalizeChangedPath(rawPath: string, canonicalRoot: string): string | undefined {
  // 1. Trim whitespace; skip blank entries.
  const trimmed = rawPath.trim()
  if (!trimmed) return undefined

  // 2. Normalize path separators (Windows backslash → POSIX slash).
  const normalized = trimmed.replace(/\\/g, '/')

  // 3. Resolve against the real canonical source root. path.resolve handles
  //    relative paths, ./prefix, and absolute paths uniformly.
  const resolved = path.resolve(canonicalRoot, normalized)

  // 4. Reject the source root itself and any traversal outside it.
  //    Use a separator-terminated prefix to avoid prefix collision attacks
  //    (e.g. /repo/abc must not match /repo/abcdef).
  const rootPrefix = `${canonicalRoot}${path.sep}`
  if (resolved === canonicalRoot || !resolved.startsWith(rootPrefix)) {
    // Outside-root path from provider — this is a safety violation, not a
    // benign skip. Throw so the router falls back to exact-source and records
    // unsafe_changed_path rather than silently omitting the path.
    throw new CbmUnsafeChangedPathError()
  }

  // 5. Convert to canonical POSIX-relative path.
  const relative = path.relative(canonicalRoot, resolved).replace(/\\/g, '/')

  // 6. Apply non-source / credential filter on the canonical relative path.
  if (!shouldFingerprintChange(relative)) return undefined

  return relative
}

// Digest of the canonical path set — used to detect provider list drift without
// exposing the full path list in diagnostics.
function changedPathSetDigest(canonicalPaths: string[]): string {
  const h = crypto.createHash('sha256')
  for (const p of canonicalPaths) {
    h.update(p)
    h.update('\0')
  }
  return h.digest('hex')
}

// Normalize mtimeMs to a stable integer string: floor to millisecond precision.
// JavaScript's Stats.mtimeMs is a float; flooring avoids sub-ms float noise.
function normalizeMtimeMs(mtimeMs: number): string {
  return String(Math.floor(mtimeMs))
}

// Compute a deterministic SHA-256 fingerprint over the canonical changed-path set.
//
// Algorithm: worktree-v2-path-size-mtime-mode
// For each canonical relative path (sorted, deduplicated):
//   hash.update(relativePath + NUL)
//   hash.update(typeMarker + NUL)   — one of: missing | file | directory | symlink | other
//   for existing entries only:
//     hash.update(size + NUL)
//     hash.update(normalizeMtimeMs(mtimeMs) + NUL)
//     hash.update(permMode + NUL)   — decimal string of (mode & 0o777)
//
// ctimeMs is intentionally excluded: ctime is updated by xattr writes, Spotlight,
// backup software, and the indexer itself — making it non-reproducible across
// process boundaries.
//
// Symlinks: only the fact that the path is a symlink plus its safe metadata is
// hashed. The link target is not read, so no path escapes the source.
export async function worktreeFingerprintV2(
  canonicalRoot: string,
  rawChangedFiles: unknown[]
): Promise<{ fingerprint: string; countRaw: number; countCanonical: number; pathSetDigest: string }> {
  const countRaw = rawChangedFiles.length

  // Canonicalize, deduplicate, sort.
  const seen = new Set<string>()
  const canonical: string[] = []
  for (const raw of rawChangedFiles) {
    const s = asString(raw)
    if (!s) continue
    let c: string | undefined
    try {
      c = canonicalizeChangedPath(s, canonicalRoot)
    } catch (e) {
      if (e instanceof CbmUnsafeChangedPathError) throw e
      continue
    }
    if (!c || seen.has(c)) continue
    seen.add(c)
    canonical.push(c)
  }
  canonical.sort()

  const pathDigest = changedPathSetDigest(canonical)
  const hash = crypto.createHash('sha256')

  for (const relativePath of canonical) {
    const absolute = path.join(canonicalRoot, relativePath)
    const details = await lstat(absolute).catch(() => undefined)

    // Hash: path NUL
    hash.update(relativePath)
    hash.update('\0')

    if (!details) {
      hash.update('missing\0')
      continue
    }

    // Hash: type marker NUL
    const typeMarker = details.isSymbolicLink() ? 'symlink'
      : details.isDirectory() ? 'directory'
      : details.isFile() ? 'file'
      : 'other'
    hash.update(typeMarker)
    hash.update('\0')

    // Hash: size NUL + mtimeMs NUL + mode NUL
    hash.update(String(details.size))
    hash.update('\0')
    hash.update(normalizeMtimeMs(details.mtimeMs))
    hash.update('\0')
    hash.update(String(details.mode & 0o777))
    hash.update('\0')
  }

  return {
    fingerprint: hash.digest('hex'),
    countRaw,
    countCanonical: canonical.length,
    pathSetDigest: pathDigest
  }
}

// Kept for internal v1 detection only — not exported as a fingerprint API.
async function worktreeFingerprint(sourceRoot: string, changes: JsonObject): Promise<string> {
  const root = path.resolve(sourceRoot)
  const raw = asArray(changes.changed_files)
  const result = await worktreeFingerprintV2(root, raw)
  return result.fingerprint
}

async function readFreshnessMetadata(cacheDir: string, canonicalRoot: string): Promise<{ metadata: CbmFreshnessMetadata | undefined; mismatchReason?: CbmFingerprintMismatchReason }> {
  const metadataPath = path.join(cacheDir, FRESHNESS_METADATA_FILE)
  try {
    const details = await lstat(metadataPath)
    const uid = typeof process.getuid === 'function' ? process.getuid() : details.uid
    if (!details.isFile() || details.isSymbolicLink() || details.uid !== uid || (details.mode & 0o077) !== 0 || details.size > MAX_FRESHNESS_METADATA_BYTES) {
      return { metadata: undefined, mismatchReason: 'metadata_missing' }
    }
    const raw = JSON.parse(await readFile(metadataPath, 'utf8')) as (CbmFreshnessMetadataV1 | CbmFreshnessMetadataV2)
    // v1 is explicitly stale — do not convert silently.
    if (raw.version !== FRESHNESS_METADATA_VERSION) {
      return { metadata: undefined, mismatchReason: 'metadata_version_mismatch' }
    }
    const parsed = raw as CbmFreshnessMetadataV2
    if (path.resolve(parsed.sourceRoot) !== path.resolve(canonicalRoot)) {
      return { metadata: undefined, mismatchReason: 'source_root_mismatch' }
    }
    if (!parsed.project || !parsed.worktreeFingerprint || !parsed.fingerprintAlgorithm) {
      return { metadata: undefined, mismatchReason: 'metadata_missing' }
    }
    if (parsed.fingerprintAlgorithm !== FINGERPRINT_ALGORITHM) {
      return { metadata: undefined, mismatchReason: 'fingerprint_algorithm_mismatch' }
    }
    return { metadata: parsed }
  } catch {
    return { metadata: undefined, mismatchReason: 'metadata_missing' }
  }
}

async function writeFreshnessMetadata(cacheDir: string, metadata: CbmFreshnessMetadataV2): Promise<void> {
  const metadataPath = path.join(cacheDir, FRESHNESS_METADATA_FILE)
  const temporaryPath = path.join(cacheDir, `.${FRESHNESS_METADATA_FILE}.${process.pid}.${Date.now()}`)
  const encoded = `${JSON.stringify(metadata, null, 2)}\n`
  if (Buffer.byteLength(encoded, 'utf8') > MAX_FRESHNESS_METADATA_BYTES) throw new Error('Codebase Memory freshness metadata exceeded its limit')
  try {
    await writeFile(temporaryPath, encoded, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await chmod(temporaryPath, 0o600)
    await rename(temporaryPath, metadataPath)
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
}

function architectureStrings(result: JsonObject, limit: number): { communityHubs: string[]; godNodes: string[] } {
  const communityHubs = uniqueStrings(asArray(result.clusters).flatMap(cluster => {
    const record = asObject(cluster)
    const label = asString(record?.label)
    const representative = asArray(record?.top_nodes).map(asString).find(Boolean)
    return [label && representative ? `${label}: ${representative}` : representative || label]
  }), limit)
  const godNodes = uniqueStrings(asArray(result.hotspots).map(hotspot => asString(asObject(hotspot)?.name)), limit)
  return { communityHubs, godNodes }
}

async function trustedProviderFile(rawPath: string | undefined, canonicalRoot: string): Promise<string | undefined> {
  if (!rawPath) return undefined
  const candidate = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(canonicalRoot, rawPath)
  if (candidate === canonicalRoot || !candidate.startsWith(`${canonicalRoot}${path.sep}`)) return undefined
  const resolved = await realpath(candidate).catch(() => undefined)
  if (!resolved || !resolved.startsWith(`${canonicalRoot}${path.sep}`)) return undefined
  const details = await stat(resolved).catch(() => undefined)
  if (!details?.isFile()) return undefined
  const relativePath = path.relative(canonicalRoot, resolved).replace(/\\/g, '/')
  return shouldFingerprintChange(relativePath) ? relativePath : undefined
}

async function searchSuggestions(result: JsonObject, query: string | undefined, limit: number, canonicalRoot: string): Promise<Pick<CbmGraphContextData, 'matches' | 'suggestedFiles' | 'suggestedSymbols' | 'nextActions'>> {
  const rawRows = asArray(result.results).map(asObject).filter((row): row is JsonObject => Boolean(row))
  const rows = (await Promise.all(rawRows.map(async row => {
    const file = await trustedProviderFile(asString(row.file_path) || asString(row.file), canonicalRoot)
    return { row, file }
  }))).filter((entry): entry is { row: JsonObject; file: string } => Boolean(entry.file))
  const normalizedFiles = uniqueStrings(rows.map(entry => entry.file), limit)
  const suggestedSymbols = uniqueStrings(rows.map(entry => asString(entry.row.name)), limit)
  const matches = uniqueStrings(rows.map(entry => {
    const file = entry.file
    const name = asString(entry.row.name)
    return file && name ? `${file} :: ${name}` : file || name
  }), limit)
  const nextActions: Array<Record<string, unknown>> = []
  for (const entry of rows) {
    const file = entry.file
    const symbol = asString(entry.row.name)
    const label = asString(entry.row.label)
    if (!file || !symbol || !['Function', 'Method', 'Class', 'Interface', 'Type'].includes(label || '')) continue
    nextActions.push({ mode: 'read_symbol', path: file, symbol })
    if (nextActions.length >= 3) break
  }
  if (nextActions.length === 0 && normalizedFiles[0]) {
    nextActions.push({ mode: 'grep_context', path: normalizedFiles[0], pattern: suggestedSymbols[0] || query || '', before: 8, after: 12, maxMatches: 5 })
  }
  return { matches, suggestedFiles: normalizedFiles, suggestedSymbols, nextActions }
}

export function createCodebaseMemoryTransport(options: CodebaseMemoryTransportOptions = {}): CbmGraphContextTransport {
  const sessionFactory = options.sessionFactory || (input => new StdioCbmRpcSession(input))
  const timeoutMs = options.timeoutMs || DEFAULT_PROVIDER_TIMEOUT_MS
  const canonicalPath = options.canonicalPath || (inputPath => realpath(inputPath))
  const currentHead = options.currentHead || gitHead

  return {
    async resolveGraphContext(request): Promise<CbmGraphContextData> {
      const executablePath = await verifyExecutable(options.executablePath)
      const canonicalRoot = await canonicalPath(request.sourceRoot)
      const configuredCacheDir = selectedCacheDirectory(request.sourceId, canonicalRoot, options)
      const cacheDir = await verifyCacheDirectory(configuredCacheDir)
      const session = sessionFactory({ executablePath, cacheDir, cwd: canonicalRoot })
      const startedAt = Date.now()
      let timeout: NodeJS.Timeout | undefined
      try {
        const work = (async () => {
          try {
            await session.initialize()
          } catch {
            throw new CbmTransportUnavailableError(
              'Codebase Memory MCP initialization failed',
              'mcp_initialization_failure'
            )
          }
          const projects = await callCbmTool(session, 'list_projects', {})
          const { metadata, mismatchReason: metadataReadReason } = await readFreshnessMetadata(cacheDir, canonicalRoot)
          const listedProject = projectForRoot(projects, canonicalRoot)
          const projectName = metadata?.project || asString(listedProject?.name)
          if (!projectName) {
            throw new CbmTransportUnavailableError(
              'Codebase Memory has no index for this source',
              'no_index'
            )
          }
          const [indexStatus, changes, head] = await Promise.all([
            callCbmTool(session, 'index_status', { project: projectName }),
            callCbmTool(session, 'detect_changes', { project: projectName }),
            currentHead(canonicalRoot)
          ])
          const indexedGit = asObject(indexStatus.git)
          const indexedHead = asString(indexedGit?.head_sha)
          const providerChangedCount = changedCount(changes)
          const ready = indexStatus.status === 'ready'

          // Compute v2 deterministic fingerprint. Throws CbmUnsafeChangedPathError
          // if any changed path escapes the source root.
          const fpResult = await worktreeFingerprintV2(canonicalRoot, asArray(changes.changed_files))

          // Determine mismatch reason for structured diagnostics.
          let mismatchReason: CbmFingerprintMismatchReason | undefined = metadataReadReason
          if (!ready) mismatchReason = 'provider_not_ready'
          else if (!mismatchReason) {
            if (!head || indexedHead !== head) mismatchReason = 'head_mismatch'
            else if (metadata && metadata.worktreeFingerprint !== fpResult.fingerprint) mismatchReason = 'fingerprint_mismatch'
          }

          const metadataMatches = Boolean(
            metadata &&
            metadata.project === projectName &&
            metadata.indexedAtSha === head &&
            metadata.worktreeFingerprint === fpResult.fingerprint
          )
          const freshness: CbmFreshnessState = ready && Boolean(head) && indexedHead === head && metadataMatches ? 'fresh' : ready ? 'stale' : 'unknown'
          const freshnessMs = Date.now() - startedAt

          const baseDiagnostics: Record<string, unknown> = {
            provider: 'codebase-memory-mcp',
            project: projectName,
            indexedAtSha: indexedHead,
            currentSha: head,
            changedFileCount: providerChangedCount,
            indexedFileCount: metadata?.indexedFileCount,
            providerVersion: metadata?.providerVersion,
            operations: ['list_projects', 'index_status', 'detect_changes'],
            phaseMs: { freshnessCheck: freshnessMs }
          }

          if (freshness !== 'fresh') {
            // Safe stale diagnostics — no raw path lists, no env values, no absolute paths.
            const staleDiagnostics: Record<string, unknown> = {
              ...baseDiagnostics,
              stage: 'stale_index',
              elapsedMs: freshnessMs,
              metadataVersion: metadata?.version ?? null,
              expectedMetadataVersion: FRESHNESS_METADATA_VERSION,
              fingerprintAlgorithm: FINGERPRINT_ALGORITHM,
              storedFingerprint: metadata?.worktreeFingerprint ?? null,
              computedFingerprint: fpResult.fingerprint,
              mismatchReason: mismatchReason ?? 'fingerprint_mismatch',
              changedPathCountRaw: fpResult.countRaw,
              changedPathCountCanonical: fpResult.countCanonical,
              changedPathSetDigest: fpResult.pathSetDigest,
              providerChangedCount: providerChangedCount ?? null
            }
            return {
              sourceId: request.sourceId,
              freshness,
              diagnostics: staleDiagnostics
            }
          }
          const limit = boundedLimit(request.limit)
          const structuralStartMs = Date.now()
          const [architecture, search] = await Promise.all([
            callCbmTool(session, 'get_architecture', { project: projectName, aspects: ['clusters', 'hotspots'] }),
            callCbmTool(session, 'search_graph', { project: projectName, query: request.query || 'entry point architecture', limit })
          ])
          const structuralMs = Date.now() - structuralStartMs
          const suggestions = await searchSuggestions(search, request.query, limit, canonicalRoot)
          const totalMs = Date.now() - startedAt
          return {
            sourceId: request.sourceId,
            freshness,
            ...architectureStrings(architecture, limit),
            ...suggestions,
            diagnostics: {
              ...baseDiagnostics,
              elapsedMs: totalMs,
              operations: [...(baseDiagnostics.operations as string[]), 'get_architecture', 'search_graph'],
              phaseMs: { freshnessCheck: freshnessMs, structuralQuery: structuralMs, total: totalMs }
            }
          }
        })()
        const deadline = new Promise<CbmGraphContextData>((_, reject) => {
          timeout = setTimeout(() => {
            session.terminate()
            reject(new Error('CBM_TIMEOUT'))
          }, timeoutMs)
        })
        return await Promise.race([work, deadline])
      } finally {
        if (timeout) clearTimeout(timeout)
        await session.close().catch(() => undefined)
      }
    }
  }
}

export async function indexCodebaseMemoryRepository(
  input: { sourceId: string; sourceRoot: string },
  options: CodebaseMemoryIndexOptions = {}
): Promise<{ project: string; cacheDir: string; durationMs: number }> {
  const startedAt = Date.now()
  const executablePath = await verifyExecutable(options.executablePath)
  const canonicalRoot = await realpath(input.sourceRoot)
  const cacheDir = selectedCacheDirectory(input.sourceId, canonicalRoot, options)
  const existingCache = await lstat(cacheDir).catch(() => undefined)
  if (existingCache) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : existingCache.uid
    if (!existingCache.isDirectory() || existingCache.isSymbolicLink() || existingCache.uid !== uid) {
      throw new CbmTransportUnavailableError(
        'Codebase Memory cache failed owner-local safety checks',
        'cache_safety_failure'
      )
    }
  } else if (options.cacheRoot) {
    await mkdir(cacheDir, { recursive: true, mode: 0o700 })
  } else {
    throw new CbmTransportUnavailableError(
      'Codebase Memory indexing requires an existing owner-approved cache directory',
      'cache_unavailable'
    )
  }
  await chmod(cacheDir, 0o700)
  await verifyCacheDirectory(cacheDir)
  const env = { ...process.env, CBM_CACHE_DIR: cacheDir }
  const timeout = options.timeoutMs || 120_000
  await execFileText(executablePath, ['config', 'set', 'auto_watch', 'false'], { cwd: canonicalRoot, env, timeout: 5_000 })
  await execFileText(executablePath, ['config', 'set', 'auto_index', 'false'], { cwd: canonicalRoot, env, timeout: 5_000 })
  const { metadata: existingMetadata } = await readFreshnessMetadata(cacheDir, canonicalRoot)
  let project = existingMetadata?.project || safeName(input.sourceId, safeName(path.basename(canonicalRoot), 'repository'))
  try {
    const existing = JSON.parse(await execFileText(executablePath, ['cli', 'list_projects'], { cwd: canonicalRoot, env, timeout: 5_000 })) as JsonObject
    project = asString(projectForRoot(existing, canonicalRoot)?.name) || project
  } catch {
    // A new isolated cache has no project yet.
  }
  await execFileText(executablePath, [
    'cli', 'index_repository',
    '--repo-path', canonicalRoot,
    '--mode', 'fast',
    '--name', project,
    '--persistence', 'false'
  ], { cwd: canonicalRoot, env, timeout })
  const changesRaw = JSON.parse(await execFileText(executablePath, ['cli', 'detect_changes', '--project', project], { cwd: canonicalRoot, env, timeout: 10_000 })) as JsonObject
  const indexedAtSha = await gitHead(canonicalRoot)

  let indexedFileCount: number | undefined
  try {
    const statusResult = JSON.parse(await execFileText(executablePath, ['cli', 'index_status', '--project', project], { cwd: canonicalRoot, env, timeout: 5_000 })) as JsonObject
    const cnt = typeof statusResult.indexed_files === 'number' ? statusResult.indexed_files : typeof statusResult.file_count === 'number' ? statusResult.file_count : undefined
    if (cnt !== undefined && Number.isFinite(cnt) && cnt >= 0) indexedFileCount = Math.floor(cnt)
  } catch {
    // Non-fatal — count omitted from manifest
  }

  let providerVersion: string | undefined
  try {
    const versionOut = await execFileText(executablePath, ['--version'], { cwd: canonicalRoot, env: { ...env }, timeout: 3_000 })
    const match = versionOut.match(/\d+\.\d+\.\d+/)
    if (match) providerVersion = match[0]
  } catch {
    // Non-fatal — version omitted
  }

  const fpResult = await worktreeFingerprintV2(canonicalRoot, asArray(changesRaw.changed_files))

  await writeFreshnessMetadata(cacheDir, {
    version: FRESHNESS_METADATA_VERSION,
    sourceRoot: canonicalRoot,
    project,
    indexedAtSha,
    worktreeFingerprint: fpResult.fingerprint,
    fingerprintAlgorithm: FINGERPRINT_ALGORITHM,
    changedPathCountRaw: fpResult.countRaw,
    changedPathCountCanonical: fpResult.countCanonical,
    changedPathSetDigest: fpResult.pathSetDigest,
    indexedAt: new Date().toISOString(),
    ...(indexedFileCount !== undefined ? { indexedFileCount } : {}),
    ...(providerVersion !== undefined ? { providerVersion } : {})
  })
  return { project, cacheDir, durationMs: Date.now() - startedAt }
}

export function validateCbmResult(
  result: CbmGraphContextData,
  expectedSourceId: string
): CbmGraphContextData {
  if (!result || typeof result !== 'object') throw new Error('Invalid Codebase Memory response')
  if (result.sourceId !== expectedSourceId) throw new Error('Codebase Memory response source mismatch')
  if (!['fresh', 'stale', 'unknown'].includes(result.freshness)) {
    throw new Error('Invalid Codebase Memory freshness state')
  }
  return result
}
