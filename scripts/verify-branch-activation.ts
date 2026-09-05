import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getConfigPath } from '../packages/cli/src/utils/paths'
import { getIndexStatePath, flushIndexStateOnShutdown } from '../packages/cli/src/agent/index-state'
import { discoverRepositories, getActiveSourceContext, setActiveSourceContext, setSourceEnabled } from '../packages/cli/src/agent/config'

const configPath = getConfigPath()
const indexStatePath = getIndexStatePath()
const configBackup = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null
const indexStateBackup = fs.existsSync(indexStatePath) ? fs.readFileSync(indexStatePath, 'utf8') : null
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'buildflow-branch-activation-'))

function writeFileRestored(filePath: string, backup: string | null): void {
  if (backup === null) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    return
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, backup)
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

try {
  const mainPath = path.join(tempRoot, 'repo-main')
  const featurePath = path.join(tempRoot, 'repo-feature')
  const otherPath = path.join(tempRoot, 'other')
  fs.mkdirSync(mainPath)
  fs.mkdirSync(featurePath)
  fs.mkdirSync(otherPath)

  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify({
    userId: 'test-user',
    deviceId: 'test-device',
    deviceToken: 'test-token',
    apiBaseUrl: 'http://127.0.0.1',
    mode: 'read_create_append',
    allowedExtensions: ['.md', '.ts'],
    ignorePatterns: [],
    activeSourcesMode: 'single',
    activeSourceIds: ['repo-main'],
    sources: [
      {
        id: 'repo-main',
        label: 'Repo Main',
        path: mainPath,
        enabled: true,
        repoGroupId: 'git:test-repo',
        branchName: 'main'
      },
      {
        id: 'repo-feature',
        label: 'Repo Feature',
        path: featurePath,
        enabled: true,
        repoGroupId: 'git:test-repo',
        branchName: 'feature/workbench'
      },
      {
        id: 'other-repo',
        label: 'Other Repo',
        path: otherPath,
        enabled: true,
        repoGroupId: 'git:other-repo',
        branchName: 'main'
      }
    ]
  }, null, 2))

  const reconciled = getActiveSourceContext()
  assert.equal(reconciled.mode, 'multi', 'single active branch should reconcile to multi when repo has branch siblings')
  assert.deepEqual(reconciled.activeSourceIds.sort(), ['repo-feature', 'repo-main'], 'activating one branch must activate all enabled branch siblings')

  const activatedFeature = setActiveSourceContext('single', ['repo-feature'])
  assert.equal(activatedFeature.mode, 'multi', 'explicit single activation should expand to multi for branch groups')
  assert.deepEqual(activatedFeature.activeSourceIds.sort(), ['repo-feature', 'repo-main'], 'feature branch activation must include main branch sibling')

  const disabled = setSourceEnabled('repo-main', false)
  assert(disabled.some(source => source.id === 'repo-main' && source.enabled === false), 'disabling a repo branch must disable the selected branch')
  assert(disabled.some(source => source.id === 'repo-feature' && source.enabled === false), 'disabling a repo branch must disable branch siblings')
  assert(disabled.some(source => source.id === 'other-repo' && source.enabled === true), 'disabling one repo group must not disable another repo')

  const reenabled = setSourceEnabled('repo-feature', true)
  assert(reenabled.some(source => source.id === 'repo-main' && source.enabled === true), 'reenabling a repo branch must reenable branch siblings')
  assert(reenabled.some(source => source.id === 'repo-feature' && source.enabled === true), 'reenabling a repo branch must reenable the selected branch')

  const discoveryRoot = path.join(tempRoot, 'repos')
  const mainRepo = path.join(discoveryRoot, 'repo-main')
  const featureWorktree = path.join(discoveryRoot, 'repo-feature')
  fs.mkdirSync(mainRepo, { recursive: true })
  git(mainRepo, ['init', '-b', 'main'])
  git(mainRepo, ['config', 'user.email', 'test@example.com'])
  git(mainRepo, ['config', 'user.name', 'BuildFlow Test'])
  fs.writeFileSync(path.join(mainRepo, 'README.md'), '# Test repo\n')
  git(mainRepo, ['add', 'README.md'])
  git(mainRepo, ['commit', '-m', 'initial'])
  git(mainRepo, ['worktree', 'add', '-b', 'feature-workbench', featureWorktree])

  const discovered = discoverRepositories(discoveryRoot).repositories
  const canonicalMainRepo = fs.realpathSync(mainRepo)
  const canonicalFeatureWorktree = fs.realpathSync(featureWorktree)
  const mainDiscovered = discovered.find(repo => repo.path === canonicalMainRepo)
  const featureDiscovered = discovered.find(repo => repo.path === canonicalFeatureWorktree)
  assert(mainDiscovered, 'repository discovery must include the primary checkout')
  assert(featureDiscovered, 'repository discovery must include linked Git worktrees with .git files')
  assert.equal(mainDiscovered.repoGroupId, featureDiscovered.repoGroupId, 'primary checkout and worktree must share a repo group')
  assert.equal(mainDiscovered.branchName, 'main', 'primary checkout branch metadata missing')
  assert.equal(featureDiscovered.branchName, 'feature-workbench', 'worktree branch metadata missing')
  assert.equal(featureDiscovered.isGitWorktree, true, 'linked worktree must be marked as a worktree')

  console.log('branch activation checks passed')
} finally {
  flushIndexStateOnShutdown()
  writeFileRestored(configPath, configBackup)
  writeFileRestored(indexStatePath, indexStateBackup)
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
