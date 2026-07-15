import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { parse } from 'smol-toml'
import { configureCodex, inspectCodexRegistration, parseProjectRootArgument } from '../configure-codex.js'

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-mcp-config-'))
  const homeDir = path.join(root, 'home')
  const codexHome = path.join(homeDir, '.codex')
  const workbenchRepoRoot = path.join(root, 'workbench')
  const targetProjectRoot = path.join(root, 'target-project')
  fs.mkdirSync(codexHome, { recursive: true })
  fs.mkdirSync(path.join(workbenchRepoRoot, 'apps', 'web'), { recursive: true })
  fs.mkdirSync(path.join(workbenchRepoRoot, 'packages', 'mcp', 'dist'), { recursive: true })
  fs.writeFileSync(path.join(workbenchRepoRoot, 'packages', 'mcp', 'dist', 'server.js'), '#!/usr/bin/env node\n', { mode: 0o700 })
  fs.mkdirSync(targetProjectRoot, { recursive: true })
  const globalConfigPath = path.join(codexHome, 'config.toml')
  const global = [
    'model = "gpt-5.6"',
    '',
    '[mcp_servers.existing_server]',
    'command = "/usr/bin/true"',
    'args = []',
    'enabled = true',
    ''
  ].join('\n')
  fs.writeFileSync(globalConfigPath, global, { mode: 0o600 })
  fs.writeFileSync(path.join(workbenchRepoRoot, 'apps', 'web', '.env.local'), 'WORKBENCH_ACTION_TOKEN="offline-action-token-123456789"\n', { mode: 0o600 })
  return { root, homeDir, codexHome, workbenchRepoRoot, targetProjectRoot, globalConfigPath, global }
}

test('defaults the target project to Workbench while preserving global Codex config', () => {
  const item = fixture()
  const result = configureCodex({ ...item, targetProjectRoot: undefined, now: new Date('2026-07-15T12:00:00.000Z') })
  assert.equal(fs.readFileSync(item.globalConfigPath, 'utf8'), item.global)
  assert.equal(result.configured, true)
  assert.equal(result.globalConfigUnchanged, true)
  assert.equal(result.duplicateCount, 1)
  assert.equal(result.configMode, '0600')
  assert.equal(result.credentialMode, '0600')
  assert.equal(fs.statSync(result.backupPath).mode & 0o777, 0o600)
  assert(result.backupPath.startsWith(path.join(item.homeDir, '.buildflow', 'codex-config-backups')))
  assert.equal(fs.readFileSync(result.backupPath, 'utf8'), '')
  const project = parse(fs.readFileSync(result.projectConfigPath, 'utf8')) as Record<string, any>
  const definition = project.mcp_servers.workbench
  assert.equal(definition.command, fs.realpathSync(process.execPath))
  assert.equal(definition.args.length, 1)
  assert.equal(definition.args[0], path.join(item.workbenchRepoRoot, 'packages', 'mcp', 'dist', 'server.js'))
  assert.equal(definition.cwd, item.workbenchRepoRoot)
  assert.equal(result.projectConfigPath, path.join(item.workbenchRepoRoot, '.codex', 'config.toml'))
  assert.equal(definition.default_tools_approval_mode, 'writes')
  assert(!fs.readFileSync(result.projectConfigPath, 'utf8').includes('offline-action-token'))
  const installedCredential = fs.readFileSync(result.credentialFile, 'utf8').trim()
  assert(installedCredential.startsWith('wbmcp_v1_'))
  assert(!installedCredential.includes('offline-action-token'))

  const second = configureCodex({ ...item, targetProjectRoot: undefined, now: new Date('2026-07-15T12:01:00.000Z') })
  assert.equal(second.configured, true)
  assert.equal(inspectCodexRegistration({ ...item, targetProjectRoot: undefined }).duplicateCount, 1)
  fs.rmSync(item.root, { recursive: true })
})

test('registers a separate target project without moving the Workbench entrypoint', () => {
  const item = fixture()
  const projectConfigPath = path.join(item.targetProjectRoot, '.codex', 'config.toml')
  fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true })
  fs.writeFileSync(projectConfigPath, [
    'project_note = "preserve me"',
    '',
    '[mcp_servers.existing_server]',
    'command = "/usr/bin/true"',
    'args = []',
    ''
  ].join('\n'), { mode: 0o600 })
  const projectBefore = fs.readFileSync(projectConfigPath, 'utf8')

  const result = configureCodex({ ...item, now: new Date('2026-07-15T12:00:00.000Z') })
  const project = parse(fs.readFileSync(projectConfigPath, 'utf8')) as Record<string, any>
  assert.equal(result.projectConfigPath, projectConfigPath)
  assert.equal(project.project_note, 'preserve me')
  assert.equal(fs.readFileSync(result.backupPath, 'utf8'), projectBefore)
  assert.equal(project.mcp_servers.existing_server.command, '/usr/bin/true')
  assert.equal(project.mcp_servers.workbench.cwd, item.workbenchRepoRoot)
  assert.equal(project.mcp_servers.workbench.args[0], path.join(item.workbenchRepoRoot, 'packages', 'mcp', 'dist', 'server.js'))
  assert(result.credentialFile.startsWith(path.join(item.homeDir, '.buildflow')))
  assert(!result.credentialFile.startsWith(item.workbenchRepoRoot))
  assert(!result.credentialFile.startsWith(item.targetProjectRoot))
  assert.equal(inspectCodexRegistration(item).configured, true)
  assert(!fs.readFileSync(projectConfigPath, 'utf8').includes('offline-action-token'))
  fs.rmSync(item.root, { recursive: true })
})

test('rejects a duplicate Workbench bridge in global config', () => {
  const item = fixture()
  fs.appendFileSync(item.globalConfigPath, [
    '[mcp_servers.workbench]',
    'command = "/opt/homebrew/bin/node"',
    'args = ["/some/packages/mcp/dist/server.js"]',
    ''
  ].join('\n'))
  assert.throws(() => configureCodex(item), /already exists in the global/)
  fs.rmSync(item.root, { recursive: true })
})

test('canonicalizes relative, dot-segment, and symlinked Workbench entrypoints', () => {
  for (const entrypoint of [
    'packages/mcp/dist/server.js',
    'packages/mcp/../mcp/dist/server.js'
  ]) {
    const item = fixture()
    fs.appendFileSync(item.globalConfigPath, [
      '',
      '[mcp_servers.relative_workbench]',
      `command = "${fs.realpathSync(process.execPath)}"`,
      `args = ["${entrypoint}"]`,
      `cwd = "${item.workbenchRepoRoot}"`,
      ''
    ].join('\n'))
    assert.throws(() => configureCodex(item), /already exists in the global/)
    fs.rmSync(item.root, { recursive: true })
  }

  const symlinked = fixture()
  const entrypointLink = path.join(symlinked.root, 'workbench-server-link.js')
  fs.symlinkSync(path.join(symlinked.workbenchRepoRoot, 'packages', 'mcp', 'dist', 'server.js'), entrypointLink)
  fs.appendFileSync(symlinked.globalConfigPath, [
    '',
    '[mcp_servers.symlinked_workbench]',
    `command = "${fs.realpathSync(process.execPath)}"`,
    `args = ["${entrypointLink}"]`,
    `cwd = "${symlinked.workbenchRepoRoot}"`,
    ''
  ].join('\n'))
  assert.throws(() => configureCodex(symlinked), /already exists in the global/)
  fs.rmSync(symlinked.root, { recursive: true })
})

test('accepts a canonically identical existing registration and preserves a distinct server', () => {
  const item = fixture()
  const projectConfigPath = path.join(item.targetProjectRoot, '.codex', 'config.toml')
  fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true })
  fs.writeFileSync(projectConfigPath, [
    '[mcp_servers.distinct_server]',
    'command = "/usr/bin/true"',
    'args = ["tools/distinct-server.js"]',
    `cwd = "${item.targetProjectRoot}"`,
    '',
    '[mcp_servers.workbench]',
    `command = "${fs.realpathSync(process.execPath)}"`,
    'args = ["packages/mcp/../mcp/dist/server.js"]',
    `cwd = "${item.workbenchRepoRoot}"`,
    'enabled = true',
    'required = true',
    'startup_timeout_sec = 10',
    'tool_timeout_sec = 30',
    'default_tools_approval_mode = "writes"',
    '',
    '[mcp_servers.workbench.env]',
    `WORKBENCH_MCP_CREDENTIAL_FILE = "${path.join(item.homeDir, '.buildflow', 'codex-workbench-mcp.token')}"`,
    ''
  ].join('\n'), { mode: 0o600 })
  const result = configureCodex({ ...item, now: new Date('2026-07-15T12:00:00.000Z') })
  assert.equal(result.configured, true)
  assert.equal(result.duplicateCount, 1)
  const project = parse(fs.readFileSync(projectConfigPath, 'utf8')) as Record<string, any>
  assert.equal(project.mcp_servers.distinct_server.command, '/usr/bin/true')
  assert.equal(project.mcp_servers.workbench.args[0], path.join(item.workbenchRepoRoot, 'packages', 'mcp', 'dist', 'server.js'))
  fs.rmSync(item.root, { recursive: true })
})

test('preserves an unrelated relative entrypoint without a cwd', () => {
  const item = fixture()
  fs.appendFileSync(item.globalConfigPath, [
    '',
    '[mcp_servers.relative_unrelated]',
    `command = "${fs.realpathSync(process.execPath)}"`,
    'args = ["scripts/unrelated-server.js"]',
    ''
  ].join('\n'))
  const result = configureCodex(item)
  assert.equal(result.configured, true)
  assert.equal(result.duplicateCount, 1)
  const global = parse(fs.readFileSync(item.globalConfigPath, 'utf8')) as Record<string, any>
  assert.deepEqual(global.mcp_servers.relative_unrelated.args, ['scripts/unrelated-server.js'])
  fs.rmSync(item.root, { recursive: true })
})

test('rejects an unresolved symlinked Workbench entrypoint', () => {
  const item = fixture()
  const dangling = path.join(item.workbenchRepoRoot, 'packages', 'mcp', 'dist', 'dangling-server.js')
  fs.symlinkSync(path.join(item.root, 'missing-server.js'), dangling)
  fs.appendFileSync(item.globalConfigPath, [
    '',
    '[mcp_servers.ambiguous_workbench]',
    `command = "${fs.realpathSync(process.execPath)}"`,
    `args = ["${dangling}"]`,
    `cwd = "${item.workbenchRepoRoot}"`,
    ''
  ].join('\n'))
  assert.throws(() => configureCodex(item), /unresolved symlink/)
  fs.rmSync(item.root, { recursive: true })
})

test('rejects a permissive action credential source file', () => {
  const item = fixture()
  fs.chmodSync(path.join(item.workbenchRepoRoot, 'apps', 'web', '.env.local'), 0o644)
  assert.throws(() => configureCodex(item), /owner-only regular file/)
  fs.rmSync(item.root, { recursive: true })
})

test('rejects missing, relative, symlinked, and conflicting target project configuration', () => {
  const item = fixture()
  assert.throws(() => configureCodex({ ...item, targetProjectRoot: path.join(item.root, 'missing') }), /does not exist/)
  assert.throws(() => configureCodex({ ...item, targetProjectRoot: 'relative-project' }), /absolute path/)
  const symlink = path.join(item.root, 'target-link')
  fs.symlinkSync(item.targetProjectRoot, symlink)
  assert.throws(() => configureCodex({ ...item, targetProjectRoot: symlink }), /non-symlink directory/)
  fs.unlinkSync(symlink)
  fs.mkdirSync(path.join(item.targetProjectRoot, '.codex'), { recursive: true })
  fs.writeFileSync(path.join(item.targetProjectRoot, '.codex', 'config.toml'), [
    '[mcp_servers.other_name]',
    'args = ["/some/packages/mcp/dist/server.js"]',
    ''
  ].join('\n'), { mode: 0o600 })
  assert.throws(() => configureCodex(item), /Duplicate or conflicting/)
  fs.rmSync(item.root, { recursive: true })
})

test('accepts only the generic absolute project-root CLI argument', () => {
  assert.equal(parseProjectRootArgument([]), undefined)
  assert.equal(parseProjectRootArgument(['--project-root', '/tmp/project']), '/tmp/project')
  assert.equal(parseProjectRootArgument(['--', '--project-root', '/tmp/project']), '/tmp/project')
  assert.throws(() => parseProjectRootArgument(['--project-root', 'project']), /absolute path/)
  assert.throws(() => parseProjectRootArgument(['--wrong-root', '/tmp/project']), /Usage/)
})
