import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const WORKBENCH_TRUSTED_GIT_BOOTSTRAP_VERSION = 'r21.2-trusted-git-bootstrap-v1' as const
export const WORKBENCH_TRUSTED_GIT_ALLOWED_OPERATIONS = Object.freeze([
  'rev-parse --show-toplevel',
  'rev-parse --is-inside-work-tree',
  'rev-parse --git-dir',
  'rev-parse HEAD',
  'status --porcelain=v1 --untracked-files=all'
] as const)

export type TrustedGitBootstrapEvidence = Readonly<{
  executable: string
  worktreeGitDir: string
  commonGitDir: string
  showTopLevel: string
  insideWorkTree: string
  gitDir: string
  status: string
  statusBytes: number
  hooksPath: '/dev/null'
  credentials: 'disabled'
  remoteNetwork: 'disabled'
}>

function canonical(pathname: string): string {
  return fs.realpathSync(pathname)
}

function safeGitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin',
    HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-r21-2-git-home-')),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/usr/bin/false',
    GIT_SSH_COMMAND: '/usr/bin/false',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
    LANG: 'C'
  }
}

function runFixedGit(executable: string, worktreePath: string, args: readonly string[], environment: NodeJS.ProcessEnv): string {
  return execFileSync(executable, ['-c', 'core.hooksPath=/dev/null', '-C', worktreePath, ...args], {
    encoding: 'utf8',
    env: environment,
    timeout: 3_000,
    maxBuffer: 16 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function resolveGitExecutable(): string {
  const discovered = execFileSync('/usr/bin/xcrun', ['--find', 'git'], { encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const executable = canonical(discovered)
  const stat = fs.statSync(executable)
  if (!stat.isFile() || (stat.mode & 0o111) === 0 || !['/usr/bin/git', '/Library/Developer/CommandLineTools/usr/bin/git'].includes(executable)) throw new Error('resolved Git executable is outside the supported local toolchain')
  return executable
}

function resolveWorktreeMetadata(worktreePath: string, sourceRoot: string): { worktreeGitDir: string; commonGitDir: string } {
  const pointerPath = path.join(worktreePath, '.git')
  const pointer = fs.readFileSync(pointerPath, 'utf8').trim()
  const match = pointer.match(/^gitdir:\s*(.+)$/i)
  if (!match) throw new Error('isolated worktree .git pointer is not a regular linked-worktree pointer')
  const worktreeGitDir = canonical(path.resolve(worktreePath, match[1]))
  const expectedWorktreeParent = canonical(path.join(sourceRoot, '.git', 'worktrees'))
  if (path.dirname(worktreeGitDir) !== expectedWorktreeParent) throw new Error('isolated worktree Git metadata is outside the canonical source worktree-admin directory')
  const commondirPath = path.join(worktreeGitDir, 'commondir')
  const commonReference = fs.readFileSync(commondirPath, 'utf8').trim()
  const commonGitDir = canonical(path.resolve(worktreeGitDir, commonReference || '.'))
  if (commonGitDir !== canonical(path.join(sourceRoot, '.git'))) throw new Error('isolated worktree common Git metadata is not the canonical source repository metadata')
  return { worktreeGitDir, commonGitDir }
}

export function runTrustedGitBootstrap(params: { worktreePath: string; sourceRoot: string; expectedHead: string }): TrustedGitBootstrapEvidence {
  const worktreePath = canonical(params.worktreePath)
  const sourceRoot = canonical(params.sourceRoot)
  if (worktreePath === sourceRoot) throw new Error('trusted Git bootstrap refuses the main checkout')
  const executable = resolveGitExecutable()
  const metadata = resolveWorktreeMetadata(worktreePath, sourceRoot)
  const environment = safeGitEnvironment()
  try {
    const showTopLevel = runFixedGit(executable, worktreePath, ['rev-parse', '--show-toplevel'], environment)
    const insideWorkTree = runFixedGit(executable, worktreePath, ['rev-parse', '--is-inside-work-tree'], environment)
    const gitDir = runFixedGit(executable, worktreePath, ['rev-parse', '--git-dir'], environment)
    const status = runFixedGit(executable, worktreePath, ['status', '--porcelain=v1', '--untracked-files=all'], environment)
    if (showTopLevel !== worktreePath || insideWorkTree !== 'true' || canonical(path.resolve(worktreePath, gitDir)) !== metadata.worktreeGitDir) throw new Error('trusted Git bootstrap identity did not match the exact isolated worktree')
    if (runFixedGit(executable, worktreePath, ['rev-parse', 'HEAD'], environment) !== params.expectedHead) throw new Error('trusted Git bootstrap HEAD did not match the packet expected HEAD')
    return { executable, ...metadata, showTopLevel, insideWorkTree, gitDir, status, statusBytes: Buffer.byteLength(status, 'utf8'), hooksPath: '/dev/null', credentials: 'disabled', remoteNetwork: 'disabled' }
  } finally {
    try { fs.rmSync(environment.HOME, { recursive: true, force: true }) } catch {}
  }
}
