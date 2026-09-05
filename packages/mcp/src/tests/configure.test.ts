import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { parse } from 'smol-toml'
import { configureCodex, inspectCodexRegistration, parseProjectRootArgument, parseConfigureCliArgs, BRAIN_PROFILE_ALLOWED_TOOLS, BRAIN_PROFILE_ALLOWED_COMMAND_KINDS, PROFILE_AVAILABILITY } from '../configure-codex.js'
import { installWorkbenchOwnerConfig } from '@workbench/shared/workbench-owner-config'
import { deriveWorkbenchMcpCredential } from '@workbench/shared/workbench-mcp-auth'

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-mcp-config-')))
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
  installWorkbenchOwnerConfig({ actionToken: 'offline-action-token-123456789', homeDir })
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

test('ignores worktree-local action tokens and derives MCP auth from owner configuration', () => {
  const item = fixture()
  const worktreeTokenFile = path.join(item.workbenchRepoRoot, 'apps', 'web', '.env.local')
  fs.writeFileSync(worktreeTokenFile, 'WORKBENCH_ACTION_TOKEN=worktree-override-token-value\n', { mode: 0o600 })
  const result = configureCodex({ ...item, now: new Date('2026-07-15T12:00:00.000Z') })
  assert.equal(
    fs.readFileSync(result.credentialFile, 'utf8').trim(),
    deriveWorkbenchMcpCredential('offline-action-token-123456789')
  )
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

test('accepts one matching owner-global Workbench bridge without creating a project duplicate', () => {
  const item = fixture()
  const expected = [
    '',
    '[mcp_servers.workbench]',
    `command = "${fs.realpathSync(process.execPath)}"`,
    `args = ["${path.join(item.workbenchRepoRoot, 'packages', 'mcp', 'dist', 'server.js')}"]`,
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
  ].join('\n')
  fs.appendFileSync(item.globalConfigPath, expected)

  const result = configureCodex({ ...item, now: new Date('2026-07-15T12:00:00.000Z') })
  assert.equal(result.configured, true)
  assert.equal(result.scope, 'global')
  assert.equal(result.projectMatchCount, 0)
  assert.equal(result.duplicateCount, 1)
  assert.equal(fs.existsSync(result.projectConfigPath), false)
  assert.equal(fs.readFileSync(item.globalConfigPath, 'utf8'), `${item.global}${expected}`)
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

test('accepts a valid registered Node 20 path independent of the inspector runtime path', () => {
  const item = fixture()
  const alternateNode = path.join(item.root, 'alternate-node')
  fs.copyFileSync(process.execPath, alternateNode)
  fs.chmodSync(alternateNode, 0o700)

  const configured = configureCodex({ ...item, targetProjectRoot: undefined, nodeExecutable: alternateNode, now: new Date('2026-07-22T10:00:00.000Z') })
  assert.equal(configured.configured, true)

  const inspected = inspectCodexRegistration({ ...item, targetProjectRoot: undefined })
  assert.equal(inspected.configured, true)
  assert.equal(inspected.command, fs.realpathSync(alternateNode))
  fs.rmSync(item.root, { recursive: true })
})

test('rejects a Workbench registration whose executable is not a compatible Node runtime', () => {
  const item = fixture()
  const incompatibleNode = path.join(item.root, 'incompatible-node')
  fs.writeFileSync(incompatibleNode, '#!/bin/sh\nprintf "v19.0.0\\n"\n', { mode: 0o700 })
  const projectConfigPath = path.join(item.workbenchRepoRoot, '.codex', 'config.toml')
  fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true })
  fs.writeFileSync(projectConfigPath, [
    '[mcp_servers.workbench]',
    `command = "${incompatibleNode}"`,
    `args = ["${path.join(item.workbenchRepoRoot, 'packages', 'mcp', 'dist', 'server.js')}"]`,
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

  const inspected = inspectCodexRegistration({ ...item, targetProjectRoot: undefined })
  assert.equal(inspected.configured, false)
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

test('rejects a permissive owner-local action credential source file', () => {
  const item = fixture()
  fs.chmodSync(path.join(item.homeDir, '.config', 'workbench', 'runtime.env'), 0o644)
  assert.throws(() => configureCodex(item), /unavailable or invalid/)
  fs.rmSync(item.root, { recursive: true })
})

test('rejects missing, relative, symlinked, and conflicting target project configuration', () => {
  const item = fixture()
  assert.throws(() => configureCodex({ ...item, targetProjectRoot: path.join(item.root, 'missing') }), /does not exist/)
  assert.throws(() => configureCodex({ ...item, targetProjectRoot: 'relative-project' }), /absolute path/)
  const symlink = path.join(item.root, 'target-link')
  fs.symlinkSync(item.targetProjectRoot, symlink)
  const symlinkResult = configureCodex({ ...item, targetProjectRoot: symlink, now: new Date('2026-07-22T10:00:00.000Z') })
  assert.equal(symlinkResult.configured, true, 'symlinked target must resolve to real path')
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

test('configures the workbench profile atomically with no scope restrictions', () => {
  const item = fixture()
  const result = configureCodex({ ...item, targetProjectRoot: undefined, now: new Date('2026-07-22T10:00:00.000Z') })
  assert.equal(result.configured, true)
  assert.equal(result.profile, 'workbench')
  assert.equal(result.duplicateCount, 1)
  assert.equal(result.configMode, '0600')
  assert.equal(result.credentialMode, '0600')
  const project = parse(fs.readFileSync(result.projectConfigPath, 'utf8')) as Record<string, any>
  const env = project.mcp_servers.workbench.env
  assert.ok(env.WORKBENCH_MCP_CREDENTIAL_FILE, 'credential file env must be set')
  assert.equal(env.WORKBENCH_MCP_ALLOWED_TOOLS, undefined, 'workbench profile must not restrict tools')
  assert.equal(env.WORKBENCH_MCP_ALLOWED_COMMAND_KINDS, undefined, 'workbench profile must not restrict command kinds')
  fs.rmSync(item.root, { recursive: true })
})

test('configures the brain profile atomically with guarded scope restrictions', () => {
  const item = fixture()
  const result = configureCodex({ ...item, targetProjectRoot: undefined, profile: 'brain', now: new Date('2026-07-22T10:00:00.000Z') })
  assert.equal(result.configured, true)
  assert.equal(result.profile, 'brain')
  assert.equal(result.duplicateCount, 1)
  assert.equal(result.configMode, '0600')
  assert.equal(result.credentialMode, '0600')
  const project = parse(fs.readFileSync(result.projectConfigPath, 'utf8')) as Record<string, any>
  const env = project.mcp_servers.workbench.env
  assert.ok(env.WORKBENCH_MCP_CREDENTIAL_FILE, 'credential file env must be set')
  assert.equal(env.WORKBENCH_MCP_ALLOWED_TOOLS, BRAIN_PROFILE_ALLOWED_TOOLS)
  assert.equal(env.WORKBENCH_MCP_ALLOWED_COMMAND_KINDS, BRAIN_PROFILE_ALLOWED_COMMAND_KINDS)
  assert.equal(env.WORKBENCH_MCP_ALLOWED_CLIENT_WORKFLOW_TOOLS, '')
  fs.rmSync(item.root, { recursive: true })
})

test('status reports configured=false when profile does not match the written definition', () => {
  // Configure with workbench profile, inspect with brain profile -> configured=false
  const item1 = fixture()
  configureCodex({ ...item1, targetProjectRoot: undefined, now: new Date('2026-07-22T10:00:00.000Z') })
  const statusWithBrainProfile = inspectCodexRegistration({ ...item1, targetProjectRoot: undefined, profile: 'brain' })
  assert.equal(statusWithBrainProfile.configured, false, 'workbench definition should not match brain profile')
  assert.equal(statusWithBrainProfile.profile, 'brain')
  fs.rmSync(item1.root, { recursive: true })

  // Configure with brain profile, inspect with workbench profile -> configured=false
  const item2 = fixture()
  configureCodex({ ...item2, targetProjectRoot: undefined, profile: 'brain', now: new Date('2026-07-22T10:00:00.000Z') })
  const statusWithWorkbenchProfile = inspectCodexRegistration({ ...item2, targetProjectRoot: undefined, profile: 'workbench' })
  assert.equal(statusWithWorkbenchProfile.configured, false, 'brain definition should not match workbench profile')
  assert.equal(statusWithWorkbenchProfile.profile, 'workbench')
  fs.rmSync(item2.root, { recursive: true })
})

test('brain profile status rejects widened tool list in project config', () => {
  const item = fixture()
  configureCodex({ ...item, targetProjectRoot: undefined, profile: 'brain', now: new Date('2026-07-22T10:00:00.000Z') })
  const projectConfigPath = path.join(item.workbenchRepoRoot, '.codex', 'config.toml')
  const projectContent = fs.readFileSync(projectConfigPath, 'utf8')
  const widened = projectContent.replace(
    BRAIN_PROFILE_ALLOWED_TOOLS,
    `${BRAIN_PROFILE_ALLOWED_TOOLS},applyWorkbenchFileChange`
  )
  fs.writeFileSync(projectConfigPath, widened, { mode: 0o600 })
  const status = inspectCodexRegistration({ ...item, targetProjectRoot: undefined, profile: 'brain' })
  assert.equal(status.configured, false, 'widened tool list must not match brain profile')
  fs.rmSync(item.root, { recursive: true })
})

test('brain profile status rejects widened command kinds in project config', () => {
  const item = fixture()
  configureCodex({ ...item, targetProjectRoot: undefined, profile: 'brain', now: new Date('2026-07-22T10:00:00.000Z') })
  const projectConfigPath = path.join(item.workbenchRepoRoot, '.codex', 'config.toml')
  const projectContent = fs.readFileSync(projectConfigPath, 'utf8')
  const widened = projectContent.replace(
    BRAIN_PROFILE_ALLOWED_COMMAND_KINDS,
    `${BRAIN_PROFILE_ALLOWED_COMMAND_KINDS},git_status_short`
  )
  fs.writeFileSync(projectConfigPath, widened, { mode: 0o600 })
  const status = inspectCodexRegistration({ ...item, targetProjectRoot: undefined, profile: 'brain' })
  assert.equal(status.configured, false, 'widened command kinds must not match brain profile')
  fs.rmSync(item.root, { recursive: true })
})

test('brain profile configureCodex rolls back on failure when credential source is permissive', () => {
  const item = fixture()
  fs.chmodSync(path.join(item.homeDir, '.config', 'workbench', 'runtime.env'), 0o644)
  assert.throws(() => configureCodex({ ...item, targetProjectRoot: undefined, profile: 'brain' }), /unavailable or invalid/)
  const credentialFile = path.join(item.homeDir, '.buildflow', 'codex-workbench-mcp.token')
  assert.equal(fs.existsSync(credentialFile), false, 'credential file must not be left behind after rollback')
  fs.rmSync(item.root, { recursive: true })
})

test('parseConfigureCliArgs parses project root and profile', () => {
  assert.deepEqual(parseConfigureCliArgs([]), {})
  assert.deepEqual(parseConfigureCliArgs(['--project-root', '/tmp/x']), { projectRoot: '/tmp/x' })
  assert.deepEqual(parseConfigureCliArgs(['--profile', 'brain']), { profile: 'brain' })
  assert.deepEqual(parseConfigureCliArgs(['--profile', 'workbench']), { profile: 'workbench' })
  assert.deepEqual(parseConfigureCliArgs(['--project-root', '/tmp/x', '--profile', 'workbench']), { projectRoot: '/tmp/x', profile: 'workbench' })
  assert.deepEqual(parseConfigureCliArgs(['--', '--project-root', '/tmp/x', '--profile', 'brain']), { projectRoot: '/tmp/x', profile: 'brain' })
  assert.throws(() => parseConfigureCliArgs(['--profile', 'invalid']), /--profile must be one of/)
  assert.throws(() => parseConfigureCliArgs(['--project-root', 'relative']), /absolute path/)
  assert.throws(() => parseConfigureCliArgs(['--unknown']), /Unknown argument/)
})

test('workbench profile generates required=true and availability=required', () => {
  const item = fixture()
  const result = configureCodex({ ...item, targetProjectRoot: undefined, now: new Date('2026-07-22T10:00:00.000Z') })
  const project = parse(fs.readFileSync(result.projectConfigPath, 'utf8')) as Record<string, any>
  assert.equal(project.mcp_servers.workbench.required, true, 'workbench profile must be required=true')
  assert.equal(result.availability, 'required')
  assert.equal(PROFILE_AVAILABILITY.workbench, 'required')
  const status = inspectCodexRegistration({ ...item, targetProjectRoot: undefined, profile: 'workbench' })
  assert.equal(status.availability, 'required')
  fs.rmSync(item.root, { recursive: true })
})

test('brain profile generates required=false and availability=optional', () => {
  const item = fixture()
  const result = configureCodex({ ...item, targetProjectRoot: undefined, profile: 'brain', now: new Date('2026-07-22T10:00:00.000Z') })
  const project = parse(fs.readFileSync(result.projectConfigPath, 'utf8')) as Record<string, any>
  assert.equal(project.mcp_servers.workbench.required, false, 'brain profile must be required=false so a Workbench outage cannot block Brain Codex sessions')
  assert.equal(result.availability, 'optional')
  assert.equal(PROFILE_AVAILABILITY.brain, 'optional')
  const status = inspectCodexRegistration({ ...item, targetProjectRoot: undefined, profile: 'brain' })
  assert.equal(status.availability, 'optional')
  fs.rmSync(item.root, { recursive: true })
})

test('rolls back both managed files after a fault injected after the first write', () => {
  // Proves that if the process fails after writing the credential but before writing the
  // project config, the rollback restores the original project config and removes the credential.
  const item = fixture()
  const projectConfigPath = path.join(item.workbenchRepoRoot, '.codex', 'config.toml')
  const credentialFile = path.join(item.homeDir, '.buildflow', 'codex-workbench-mcp.token')

  assert.throws(
    () => configureCodex(
      { ...item, targetProjectRoot: undefined, now: new Date('2026-07-22T10:00:00.000Z') },
      {
        afterCredentialWrite: () => {
          // Simulate filesystem failure between the two managed writes.
          throw new Error('injected-fault-after-credential-write')
        }
      }
    ),
    /injected-fault-after-credential-write/
  )

  // Credential must have been written and then removed by rollback.
  assert.equal(fs.existsSync(credentialFile), false, 'credential file must be removed by rollback after fault')
  // Project config must not have been created.
  assert.equal(fs.existsSync(projectConfigPath), false, 'project config must not exist after rollback')
  fs.rmSync(item.root, { recursive: true })
})

test('rolls back both managed files after a fault injected after the second write', () => {
  // Proves that if the process fails after writing the project config, the rollback restores
  // both the project config (removed, since it did not exist before) and the credential.
  const item = fixture()
  const projectConfigPath = path.join(item.workbenchRepoRoot, '.codex', 'config.toml')
  const credentialFile = path.join(item.homeDir, '.buildflow', 'codex-workbench-mcp.token')

  assert.throws(
    () => configureCodex(
      { ...item, targetProjectRoot: undefined, now: new Date('2026-07-22T10:00:00.000Z') },
      {
        afterProjectConfigWrite: () => {
          throw new Error('injected-fault-after-project-config-write')
        }
      }
    ),
    /injected-fault-after-project-config-write/
  )

  assert.equal(fs.existsSync(credentialFile), false, 'credential file must be removed by rollback after fault')
  assert.equal(fs.existsSync(projectConfigPath), false, 'project config must not exist after rollback')
  fs.rmSync(item.root, { recursive: true })
})

test('rolls back to original content when fault is injected after the second write with pre-existing configs', () => {
  // Proves that rollback restores previous content when both files already existed before configure.
  const item = fixture()
  const projectConfigPath = path.join(item.workbenchRepoRoot, '.codex', 'config.toml')
  const credentialFile = path.join(item.homeDir, '.buildflow', 'codex-workbench-mcp.token')

  // Pre-write original content for both managed files.
  fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true })
  const originalProjectConfig = '[existing_key]\nvalue = "original"\n'
  fs.writeFileSync(projectConfigPath, originalProjectConfig, { mode: 0o600 })
  const originalCredential = 'wbmcp_v1_original-credential\n'
  fs.mkdirSync(path.dirname(credentialFile), { recursive: true })
  fs.writeFileSync(credentialFile, originalCredential, { mode: 0o600 })

  assert.throws(
    () => configureCodex(
      { ...item, targetProjectRoot: undefined, now: new Date('2026-07-22T10:00:00.000Z') },
      {
        afterProjectConfigWrite: () => {
          throw new Error('injected-fault-after-project-config-write-with-originals')
        }
      }
    ),
    /injected-fault-after-project-config-write-with-originals/
  )

  assert.equal(
    fs.readFileSync(credentialFile, 'utf8'),
    originalCredential,
    'credential file must be restored to original content after rollback'
  )
  assert.equal(
    fs.statSync(credentialFile).mode & 0o777,
    0o600,
    'credential file mode must be 0600 after rollback'
  )
  assert.equal(
    fs.readFileSync(projectConfigPath, 'utf8'),
    originalProjectConfig,
    'project config must be restored to original content after rollback'
  )
  assert.equal(
    fs.statSync(projectConfigPath).mode & 0o777,
    0o600,
    'project config mode must be 0600 after rollback'
  )
  fs.rmSync(item.root, { recursive: true })
})

test('repeated idempotent configuration produces the same result each time', () => {
  const item = fixture()
  const first = configureCodex({ ...item, targetProjectRoot: undefined, profile: 'brain', now: new Date('2026-07-22T10:00:00.000Z') })
  assert.equal(first.configured, true)
  assert.equal(first.profile, 'brain')
  assert.equal(first.availability, 'optional')
  const firstContent = fs.readFileSync(first.projectConfigPath, 'utf8')
  const firstCredential = fs.readFileSync(first.credentialFile, 'utf8')

  const second = configureCodex({ ...item, targetProjectRoot: undefined, profile: 'brain', now: new Date('2026-07-22T10:01:00.000Z') })
  assert.equal(second.configured, true)
  assert.equal(second.profile, 'brain')
  assert.equal(second.availability, 'optional')
  assert.equal(fs.readFileSync(second.projectConfigPath, 'utf8'), firstContent, 'project config must be identical after re-run')
  assert.equal(fs.readFileSync(second.credentialFile, 'utf8'), firstCredential, 'derived credential is deterministic for the same owner token')
  assert.equal(inspectCodexRegistration({ ...item, targetProjectRoot: undefined, profile: 'brain' }).configured, true)
  fs.rmSync(item.root, { recursive: true })
})

test('reports globalMatchCount and projectMatchCount separately for actionable duplicate diagnosis', () => {
  const item = fixture()
  const result = configureCodex({ ...item, targetProjectRoot: undefined, now: new Date('2026-07-22T10:00:00.000Z') })
  assert.equal(result.duplicateCount, 1)
  assert.equal(result.globalMatchCount, 0)
  assert.equal(result.projectMatchCount, 1)

  // Simulate a conflicting global entry (Brain-managed narrow-scope entry in the global config).
  const globalWithConflict = [
    'model = "gpt-5.6"',
    '',
    '[mcp_servers.existing_server]',
    'command = "/usr/bin/true"',
    'args = []',
    'enabled = true',
    '',
    '[mcp_servers.workbench]',
    `command = "${fs.realpathSync(process.execPath)}"`,
    `args = ["${path.join(item.workbenchRepoRoot, 'packages', 'mcp', 'dist', 'server.js')}"]`,
    `cwd = "${item.workbenchRepoRoot}"`,
    'WORKBENCH_MCP_ALLOWED_TOOLS = "getWorkbenchStatus,readWorkbenchContext,runWorkbenchCommand"',
    ''
  ].join('\n')
  fs.writeFileSync(item.globalConfigPath, globalWithConflict, { mode: 0o600 })

  const conflicted = inspectCodexRegistration({ ...item, targetProjectRoot: undefined })
  assert.equal(conflicted.configured, true, 'project entry is still valid')
  assert.equal(conflicted.duplicateCount, 2, 'global + project = 2')
  assert.equal(conflicted.globalMatchCount, 1, 'one match in global config')
  assert.equal(conflicted.projectMatchCount, 1, 'one match in project config')

  fs.rmSync(item.root, { recursive: true })
})
