import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { configureClaude, inspectClaudeRegistration, probeProcessName } from '../configure-claude.js'
import {
  BRAIN_PROFILE_ALLOWED_TOOLS,
  BRAIN_PROFILE_ALLOWED_COMMAND_KINDS,
  PROFILE_AVAILABILITY
} from '../configure-core.js'
import { installWorkbenchOwnerConfig } from '@workbench/shared/workbench-owner-config'
import { deriveWorkbenchMcpCredential } from '@workbench/shared/workbench-mcp-auth'

function createMockClaudeBin(homeDir: string): string {
  const binDir = path.join(homeDir, '.local', 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  const binPath = path.join(binDir, 'claude')
  fs.writeFileSync(binPath, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
if (args[0] === 'mcp' && args[1] === 'add-json' && args.includes('--scope') && args.includes('local')) {
  const nameIdx = args.indexOf('local') + 1;
  const name = args[nameIdx];
  const json = args[nameIdx + 1];
  const entry = JSON.parse(json);
  const home = process.env.HOME || require('os').homedir();
  const claudeJsonPath = path.join(home, '.claude.json');
  let doc = {};
  if (fs.existsSync(claudeJsonPath)) doc = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
  if (!doc.projects) doc.projects = {};
  const cwd = process.cwd();
  if (!doc.projects[cwd]) doc.projects[cwd] = {};
  if (!doc.projects[cwd].mcpServers) doc.projects[cwd].mcpServers = {};
  doc.projects[cwd].mcpServers[name] = entry;
  fs.writeFileSync(claudeJsonPath, JSON.stringify(doc, null, 2) + '\\n', { mode: 0o600 });
  process.stdout.write('Added stdio MCP server ' + name + ' to local config\\n');
} else if (args[0] === 'mcp' && args[1] === 'get') {
  const name = args[2];
  const home = process.env.HOME || require('os').homedir();
  const claudeJsonPath = path.join(home, '.claude.json');
  if (fs.existsSync(claudeJsonPath)) {
    const doc = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    const cwd = process.cwd();
    const entry = doc?.projects?.[cwd]?.mcpServers?.[name];
    if (entry) {
      process.stdout.write(name + ':\\n  Scope: Local config (private to you in this project)\\n');
      process.exit(0);
    }
  }
  process.stderr.write('No MCP server named "' + name + '"\\n');
  process.exit(1);
} else {
  process.stderr.write('mock-claude: unsupported command\\n');
  process.exit(1);
}
`, { mode: 0o755 })
  return binPath
}

// Creates a mock claude binary that writes the entry to ~/.claude.json and then exits 1.
// Used to test the post-CLI credential preservation path.
function createWriteAndFailBin(homeDir: string): string {
  const binDir = path.join(homeDir, '.local', 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  const binPath = path.join(binDir, 'claude-write-and-fail')
  fs.writeFileSync(binPath, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
if (args[0] === 'mcp' && args[1] === 'add-json' && args.includes('--scope') && args.includes('local')) {
  const nameIdx = args.indexOf('local') + 1;
  const name = args[nameIdx];
  const json = args[nameIdx + 1];
  const entry = JSON.parse(json);
  const home = process.env.HOME || require('os').homedir();
  const claudeJsonPath = path.join(home, '.claude.json');
  let doc = {};
  if (fs.existsSync(claudeJsonPath)) doc = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
  if (!doc.projects) doc.projects = {};
  const cwd = process.cwd();
  if (!doc.projects[cwd]) doc.projects[cwd] = {};
  if (!doc.projects[cwd].mcpServers) doc.projects[cwd].mcpServers = {};
  doc.projects[cwd].mcpServers[name] = entry;
  fs.writeFileSync(claudeJsonPath, JSON.stringify(doc, null, 2) + '\\n', { mode: 0o600 });
  process.stderr.write('write-and-fail: wrote entry then failing\\n');
  process.exit(1);
}
process.stderr.write('write-and-fail: unsupported command\\n');
process.exit(1);
`, { mode: 0o755 })
  return binPath
}

function fixture() {
  const rawRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-claude-config-'))
  const root = fs.realpathSync(rawRoot)
  const homeDir = path.join(root, 'home')
  const workbenchRepoRoot = path.join(root, 'workbench')
  const targetProjectRoot = path.join(root, 'target-project')
  fs.mkdirSync(homeDir, { recursive: true })
  fs.mkdirSync(path.join(workbenchRepoRoot, 'packages', 'mcp', 'dist'), { recursive: true })
  fs.writeFileSync(path.join(workbenchRepoRoot, 'packages', 'mcp', 'dist', 'server.js'), '#!/usr/bin/env node\n', { mode: 0o700 })
  fs.mkdirSync(targetProjectRoot, { recursive: true })
  const claudeJsonPath = path.join(homeDir, '.claude.json')
  installWorkbenchOwnerConfig({ actionToken: 'offline-action-token-123456789', homeDir })
  const claudeBin = createMockClaudeBin(homeDir)
  return { root, homeDir, workbenchRepoRoot, targetProjectRoot, claudeJsonPath, claudeBin, checkProcesses: () => [] as string[] }
}

test('writes to ~/.claude.json local scope (projects key) via CLI, not .claude/settings.json', () => {
  const item = fixture()
  const result = configureClaude({ ...item, now: new Date('2026-07-22T10:00:00.000Z') })
  assert.equal(result.configured, true)
  assert.equal(result.scope, 'local')
  assert.equal(result.claudeJsonPath, item.claudeJsonPath)
  const doc = JSON.parse(fs.readFileSync(item.claudeJsonPath, 'utf8'))
  assert.ok(doc.projects, 'must have projects key in ~/.claude.json')
  assert.ok(doc.projects[item.targetProjectRoot], 'must have project entry for target root')
  assert.ok(doc.projects[item.targetProjectRoot].mcpServers.workbench, 'must have workbench MCP in project entry')
  fs.rmSync(item.root, { recursive: true })
})

test('REGRESSION: .claude/settings.json is NOT treated as MCP registry', () => {
  const item = fixture()
  const settingsDir = path.join(item.targetProjectRoot, '.claude')
  const settingsPath = path.join(settingsDir, 'settings.json')
  fs.mkdirSync(settingsDir, { recursive: true })
  fs.writeFileSync(settingsPath, JSON.stringify({
    model: 'claude-sonnet-5',
    permissions: { allow: ['Bash(git:*)'] },
    mcpServers: { workbench: { command: '/usr/bin/node', args: ['/fake/server.js'] } }
  }), { mode: 0o600 })

  const status = inspectClaudeRegistration({ ...item, profile: 'workbench' })
  assert.equal(status.configured, false, 'must not detect MCP from .claude/settings.json')
  assert.equal(status.localMatchCount, 0, 'must not count .claude/settings.json entries')
  assert.equal(status.userMatchCount, 0, 'must not count .claude/settings.json entries as user-scope')

  const settingsAfter = fs.readFileSync(settingsPath, 'utf8')
  assert.ok(settingsAfter.includes('claude-sonnet-5'), '.claude/settings.json must be left untouched')
  fs.rmSync(item.root, { recursive: true })
})

test('REGRESSION: configure does not write to .claude/settings.json', () => {
  const item = fixture()
  const settingsDir = path.join(item.targetProjectRoot, '.claude')
  const settingsPath = path.join(settingsDir, 'settings.json')
  fs.mkdirSync(settingsDir, { recursive: true })
  const originalContent = JSON.stringify({ permissions: { allow: [] } })
  fs.writeFileSync(settingsPath, originalContent, { mode: 0o600 })

  configureClaude({ ...item, now: new Date('2026-07-22T10:00:00.000Z') })

  assert.equal(fs.readFileSync(settingsPath, 'utf8'), originalContent,
    '.claude/settings.json must not be modified by the Claude adapter')
  fs.rmSync(item.root, { recursive: true })
})

test('REGRESSION: macOS /tmp canonicalization via realpathSync', () => {
  const rawTmp = fs.mkdtempSync(path.join('/tmp', 'workbench-canon-'))
  const canonicalTmp = fs.realpathSync(rawTmp)
  const homeDir = path.join(canonicalTmp, 'home')
  const workbenchRepoRoot = path.join(canonicalTmp, 'workbench')
  const targetProjectRoot = path.join(canonicalTmp, 'target')
  fs.mkdirSync(homeDir, { recursive: true })
  fs.mkdirSync(path.join(workbenchRepoRoot, 'packages', 'mcp', 'dist'), { recursive: true })
  fs.writeFileSync(path.join(workbenchRepoRoot, 'packages', 'mcp', 'dist', 'server.js'), '#!/usr/bin/env node\n', { mode: 0o700 })
  fs.mkdirSync(targetProjectRoot, { recursive: true })
  const claudeJsonPath = path.join(homeDir, '.claude.json')
  installWorkbenchOwnerConfig({ actionToken: 'offline-action-token-123456789', homeDir })
  const claudeBin = createMockClaudeBin(homeDir)

  const result = configureClaude({
    workbenchRepoRoot: rawTmp + '/workbench',
    targetProjectRoot: rawTmp + '/target',
    homeDir,
    claudeBin,
    checkProcesses: () => [],
    now: new Date('2026-07-22T10:00:00.000Z')
  })

  assert.equal(result.configured, true)
  assert.equal(result.targetProjectRoot, targetProjectRoot, 'must use fs.realpathSync canonical path')
  const doc = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'))
  assert.ok(doc.projects[canonicalTmp + '/target'], 'project key must be canonical /private/tmp path on macOS')
  assert.equal(doc.projects[rawTmp + '/target'], undefined, 'non-canonical /tmp path must not be used as key')
  fs.rmSync(canonicalTmp, { recursive: true })
})

test('detects user-scope duplicates and rejects for ALL profiles', () => {
  const item = fixture()
  fs.writeFileSync(item.claudeJsonPath, JSON.stringify({
    mcpServers: {
      workbench: {
        command: '/opt/homebrew/bin/node',
        args: [path.join(item.workbenchRepoRoot, 'packages', 'mcp', 'dist', 'server.js')]
      }
    }
  }), { mode: 0o600 })

  const status = inspectClaudeRegistration({ ...item, profile: 'workbench' })
  assert.equal(status.userMatchCount, 1, 'must detect workbench at user scope')
  assert.equal(status.configured, false, 'local scope is not configured')

  assert.throws(
    () => configureClaude({ ...item, profile: 'workbench', now: new Date('2026-07-22T10:00:00.000Z') }),
    /already exists at user scope/,
    'must reject workbench profile when user-scope duplicate exists'
  )

  assert.throws(
    () => configureClaude({ ...item, profile: 'brain', now: new Date('2026-07-22T10:00:00.000Z') }),
    /already exists at user scope/,
    'must reject brain profile when user-scope duplicate exists'
  )
  fs.rmSync(item.root, { recursive: true })
})

test('defaults target project to Workbench repo root', () => {
  const item = fixture()
  const result = configureClaude({
    workbenchRepoRoot: item.workbenchRepoRoot,
    homeDir: item.homeDir,
    claudeBin: item.claudeBin,
    checkProcesses: () => [],
    now: new Date('2026-07-22T10:00:00.000Z')
  })
  assert.equal(result.configured, true)
  assert.equal(result.targetProjectRoot, item.workbenchRepoRoot)
  const doc = JSON.parse(fs.readFileSync(item.claudeJsonPath, 'utf8'))
  assert.ok(doc.projects[item.workbenchRepoRoot].mcpServers.workbench)
  fs.rmSync(item.root, { recursive: true })
})

test('preserves existing ~/.claude.json content including unrelated concurrent keys', () => {
  const item = fixture()
  const existingDoc = {
    mcpServers: { other_server: { command: '/bin/other', args: [] } },
    numericSetting: 42,
    projects: { '/other/project': { mcpServers: { otherMcp: { command: '/bin/x' } } } }
  }
  fs.writeFileSync(item.claudeJsonPath, JSON.stringify(existingDoc, null, 2), { mode: 0o600 })

  configureClaude({ ...item, now: new Date('2026-07-22T10:00:00.000Z') })

  const doc = JSON.parse(fs.readFileSync(item.claudeJsonPath, 'utf8'))
  assert.deepEqual(doc.mcpServers, existingDoc.mcpServers, 'user-scope servers must be preserved')
  assert.equal(doc.numericSetting, 42, 'unrelated keys must be preserved')
  assert.ok(doc.projects['/other/project'].mcpServers.otherMcp, 'other project entries must be preserved')
  assert.ok(doc.projects[item.targetProjectRoot].mcpServers.workbench, 'workbench must be added to target project')
  fs.rmSync(item.root, { recursive: true })
})

test('configures workbench profile with no scope restrictions', () => {
  const item = fixture()
  const result = configureClaude({ ...item, now: new Date('2026-07-22T10:00:00.000Z') })
  assert.equal(result.configured, true)
  assert.equal(result.profile, 'workbench')
  const doc = JSON.parse(fs.readFileSync(item.claudeJsonPath, 'utf8'))
  const env = doc.projects[item.targetProjectRoot].mcpServers.workbench.env
  assert.ok(env.WORKBENCH_MCP_CREDENTIAL_FILE, 'credential file env must be set')
  assert.equal(env.WORKBENCH_MCP_ALLOWED_TOOLS, undefined, 'workbench profile must not restrict tools')
  assert.equal(env.WORKBENCH_MCP_ALLOWED_COMMAND_KINDS, undefined, 'workbench profile must not restrict command kinds')
  fs.rmSync(item.root, { recursive: true })
})

test('configures brain profile with guarded scope restrictions', () => {
  const item = fixture()
  const result = configureClaude({ ...item, profile: 'brain', now: new Date('2026-07-22T10:00:00.000Z') })
  assert.equal(result.configured, true)
  assert.equal(result.profile, 'brain')
  assert.equal(result.availability, 'optional')
  const doc = JSON.parse(fs.readFileSync(item.claudeJsonPath, 'utf8'))
  const env = doc.projects[item.targetProjectRoot].mcpServers.workbench.env
  assert.ok(env.WORKBENCH_MCP_CREDENTIAL_FILE)
  assert.equal(env.WORKBENCH_MCP_ALLOWED_TOOLS, BRAIN_PROFILE_ALLOWED_TOOLS)
  assert.equal(env.WORKBENCH_MCP_ALLOWED_COMMAND_KINDS, BRAIN_PROFILE_ALLOWED_COMMAND_KINDS)
  fs.rmSync(item.root, { recursive: true })
})

test('workbench profile generates availability=required', () => {
  const item = fixture()
  const result = configureClaude({ ...item, now: new Date('2026-07-22T10:00:00.000Z') })
  assert.equal(result.availability, 'required')
  assert.equal(PROFILE_AVAILABILITY.workbench, 'required')
  const status = inspectClaudeRegistration({ ...item, profile: 'workbench' })
  assert.equal(status.availability, 'required')
  fs.rmSync(item.root, { recursive: true })
})

test('brain profile generates availability=optional', () => {
  const item = fixture()
  configureClaude({ ...item, profile: 'brain', now: new Date('2026-07-22T10:00:00.000Z') })
  const status = inspectClaudeRegistration({ ...item, profile: 'brain' })
  assert.equal(status.availability, 'optional')
  assert.equal(PROFILE_AVAILABILITY.brain, 'optional')
  fs.rmSync(item.root, { recursive: true })
})

test('status reports configured=false when profile does not match', () => {
  const item1 = fixture()
  configureClaude({ ...item1, now: new Date('2026-07-22T10:00:00.000Z') })
  const brainCheck = inspectClaudeRegistration({ ...item1, profile: 'brain' })
  assert.equal(brainCheck.configured, false, 'workbench definition should not match brain profile')
  fs.rmSync(item1.root, { recursive: true })

  const item2 = fixture()
  configureClaude({ ...item2, profile: 'brain', now: new Date('2026-07-22T10:00:00.000Z') })
  const workbenchCheck = inspectClaudeRegistration({ ...item2, profile: 'workbench' })
  assert.equal(workbenchCheck.configured, false, 'brain definition should not match workbench profile')
  fs.rmSync(item2.root, { recursive: true })
})

test('brain profile status rejects widened tool list', () => {
  const item = fixture()
  configureClaude({ ...item, profile: 'brain', now: new Date('2026-07-22T10:00:00.000Z') })
  const doc = JSON.parse(fs.readFileSync(item.claudeJsonPath, 'utf8'))
  doc.projects[item.targetProjectRoot].mcpServers.workbench.env.WORKBENCH_MCP_ALLOWED_TOOLS =
    `${BRAIN_PROFILE_ALLOWED_TOOLS},applyWorkbenchFileChange`
  fs.writeFileSync(item.claudeJsonPath, JSON.stringify(doc), { mode: 0o600 })
  const status = inspectClaudeRegistration({ ...item, profile: 'brain' })
  assert.equal(status.configured, false, 'widened tool list must not match brain profile')
  fs.rmSync(item.root, { recursive: true })
})

test('brain profile status rejects widened command kinds', () => {
  const item = fixture()
  configureClaude({ ...item, profile: 'brain', now: new Date('2026-07-22T10:00:00.000Z') })
  const doc = JSON.parse(fs.readFileSync(item.claudeJsonPath, 'utf8'))
  doc.projects[item.targetProjectRoot].mcpServers.workbench.env.WORKBENCH_MCP_ALLOWED_COMMAND_KINDS =
    `${BRAIN_PROFILE_ALLOWED_COMMAND_KINDS},git_status_short`
  fs.writeFileSync(item.claudeJsonPath, JSON.stringify(doc), { mode: 0o600 })
  const status = inspectClaudeRegistration({ ...item, profile: 'brain' })
  assert.equal(status.configured, false, 'widened command kinds must not match brain profile')
  fs.rmSync(item.root, { recursive: true })
})

test('post-write validation requires duplicateCount=1, userMatchCount=0, mode 0600', () => {
  const item = fixture()
  const result = configureClaude({ ...item, now: new Date('2026-07-22T10:00:00.000Z') })
  assert.equal(result.configured, true)
  assert.equal(result.duplicateCount, 1, 'exactly one registration')
  assert.equal(result.userMatchCount, 0, 'zero user-scope entries')
  assert.equal(result.localMatchCount, 1, 'one local-scope entry')
  assert.equal(result.claudeJsonMode, '0600', '~/.claude.json must be mode 0600')
  assert.equal(result.credentialMode, '0600', 'credential file must be mode 0600')
  fs.rmSync(item.root, { recursive: true })
})

test('rolls back credential after fault injected after credential write', () => {
  const item = fixture()
  const credentialFile = path.join(item.homeDir, '.buildflow', 'codex-workbench-mcp.token')

  assert.throws(
    () => configureClaude(
      { ...item, now: new Date('2026-07-22T10:00:00.000Z') },
      { afterCredentialWrite: () => { throw new Error('injected-fault-after-credential-write') } }
    ),
    /injected-fault-after-credential-write/
  )
  assert.equal(fs.existsSync(credentialFile), false, 'credential file must be removed by rollback')
  fs.rmSync(item.root, { recursive: true })
})

test('rolls back credential after CLI add failure', () => {
  const item = fixture()
  const credentialFile = path.join(item.homeDir, '.buildflow', 'codex-workbench-mcp.token')
  const failBin = path.join(item.homeDir, '.local', 'bin', 'claude-fail')
  fs.writeFileSync(failBin, '#!/usr/bin/env node\nprocess.stderr.write("mock failure\\n"); process.exit(1);', { mode: 0o755 })

  // The fail bin does not write any entry, so post-CLI inspection finds nothing
  // referencing our credential → safe rollback proceeds.
  assert.throws(
    () => configureClaude({ ...item, claudeBin: failBin, now: new Date('2026-07-22T10:00:00.000Z') }),
    /mock failure|Command failed/
  )
  assert.equal(fs.existsSync(credentialFile), false, 'credential file must be removed after CLI failure with no written entry')
  fs.rmSync(item.root, { recursive: true })
})

test('rolls back to original credential when pre-existing credential and CLI fails', () => {
  const item = fixture()
  const credentialFile = path.join(item.homeDir, '.buildflow', 'codex-workbench-mcp.token')
  const originalCredential = 'wbmcp_v1_original-credential\n'
  fs.mkdirSync(path.dirname(credentialFile), { recursive: true })
  fs.writeFileSync(credentialFile, originalCredential, { mode: 0o600 })

  const failBin = path.join(item.homeDir, '.local', 'bin', 'claude-fail')
  fs.writeFileSync(failBin, '#!/usr/bin/env node\nprocess.stderr.write("mock failure\\n"); process.exit(1);', { mode: 0o755 })

  assert.throws(
    () => configureClaude({ ...item, claudeBin: failBin, now: new Date('2026-07-22T10:00:00.000Z') }),
    /mock failure|Command failed/
  )
  assert.equal(fs.readFileSync(credentialFile, 'utf8'), originalCredential)
  assert.equal(fs.statSync(credentialFile).mode & 0o777, 0o600)
  fs.rmSync(item.root, { recursive: true })
})

test('concurrent mutations to unrelated keys survive through CLI-delegated write', () => {
  const item = fixture()
  const existingDoc = {
    numericSetting: 42,
    projects: { '/other/project': { mcpServers: { otherMcp: { command: '/bin/x' } } } }
  }
  fs.writeFileSync(item.claudeJsonPath, JSON.stringify(existingDoc, null, 2), { mode: 0o600 })

  const result = configureClaude(
    { ...item, now: new Date('2026-07-22T10:00:00.000Z') },
    {
      afterCredentialWrite: () => {
        const doc = JSON.parse(fs.readFileSync(item.claudeJsonPath, 'utf8'))
        doc.concurrentKey = 'added-by-another-process'
        doc.projects['/other/project'].settings = { model: 'opus' }
        fs.writeFileSync(item.claudeJsonPath, JSON.stringify(doc, null, 2), { mode: 0o600 })
      }
    }
  )

  assert.equal(result.configured, true)
  const doc = JSON.parse(fs.readFileSync(item.claudeJsonPath, 'utf8'))
  assert.equal(doc.numericSetting, 42, 'original key must survive')
  assert.ok(doc.projects['/other/project'].mcpServers.otherMcp, 'other project MCP entries must survive')
  assert.ok(doc.projects[item.targetProjectRoot].mcpServers.workbench, 'workbench must be written')
  fs.rmSync(item.root, { recursive: true })
})

test('never restores an old whole-file snapshot: rollback only touches credential', () => {
  const item = fixture()
  fs.writeFileSync(item.claudeJsonPath, JSON.stringify({ version: 1 }), { mode: 0o600 })

  configureClaude({ ...item, now: new Date('2026-07-22T10:00:00.000Z') })

  const failBin = path.join(item.homeDir, '.local', 'bin', 'claude-fail')
  fs.writeFileSync(failBin, '#!/usr/bin/env node\nprocess.stderr.write("second-attempt-fail\\n"); process.exit(1);', { mode: 0o755 })

  fs.writeFileSync(item.claudeJsonPath, JSON.stringify({ version: 2, updated_by: 'other' }), { mode: 0o600 })

  assert.throws(
    () => configureClaude({ ...item, claudeBin: failBin, now: new Date('2026-07-22T10:01:00.000Z') })
  )

  const afterRollback = JSON.parse(fs.readFileSync(item.claudeJsonPath, 'utf8'))
  assert.equal(afterRollback.version, 2, 'must NOT restore version 1 — rollback never touches ~/.claude.json')
  assert.equal(afterRollback.updated_by, 'other', 'concurrent writer state must be preserved')
  fs.rmSync(item.root, { recursive: true })
})

test('repeated idempotent configuration produces the same result', () => {
  const item = fixture()
  const first = configureClaude({ ...item, profile: 'brain', now: new Date('2026-07-22T10:00:00.000Z') })
  assert.equal(first.configured, true)
  const firstContent = fs.readFileSync(item.claudeJsonPath, 'utf8')
  const firstCredential = fs.readFileSync(first.credentialFile, 'utf8')

  const second = configureClaude({ ...item, profile: 'brain', now: new Date('2026-07-22T10:01:00.000Z') })
  assert.equal(second.configured, true)
  assert.equal(fs.readFileSync(item.claudeJsonPath, 'utf8'), firstContent)
  assert.equal(fs.readFileSync(second.credentialFile, 'utf8'), firstCredential)
  assert.equal(inspectClaudeRegistration({ ...item, profile: 'brain' }).configured, true)
  fs.rmSync(item.root, { recursive: true })
})

test('reports userMatchCount and localMatchCount for duplicate diagnosis', () => {
  const item = fixture()
  configureClaude({ ...item, now: new Date('2026-07-22T10:00:00.000Z') })
  const status = inspectClaudeRegistration({ ...item, profile: 'workbench' })
  assert.equal(status.localMatchCount, 1)
  assert.equal(status.userMatchCount, 0)
  assert.equal(status.duplicateCount, 1)

  const doc = JSON.parse(fs.readFileSync(item.claudeJsonPath, 'utf8'))
  doc.mcpServers = {
    workbench: {
      command: fs.realpathSync(process.execPath),
      args: [path.join(item.workbenchRepoRoot, 'packages', 'mcp', 'dist', 'server.js')],
      env: { WORKBENCH_MCP_CREDENTIAL_FILE: '/some/path' }
    }
  }
  fs.writeFileSync(item.claudeJsonPath, JSON.stringify(doc), { mode: 0o600 })

  const conflicted = inspectClaudeRegistration({ ...item, profile: 'workbench' })
  assert.equal(conflicted.configured, true, 'local entry is still valid')
  assert.equal(conflicted.duplicateCount, 2, 'user + local = 2')
  assert.equal(conflicted.userMatchCount, 1)
  assert.equal(conflicted.localMatchCount, 1)
  fs.rmSync(item.root, { recursive: true })
})

test('credential file path matches the client-neutral shared path used by Codex', () => {
  const item = fixture()
  const result = configureClaude({ ...item, now: new Date('2026-07-22T10:00:00.000Z') })
  assert(result.credentialFile.endsWith('codex-workbench-mcp.token'),
    'credential file must use the shared cross-client name: codex-workbench-mcp.token')
  assert(result.credentialFile.startsWith(path.join(item.homeDir, '.buildflow')))
  fs.rmSync(item.root, { recursive: true })
})

test('secret is not disclosed in ~/.claude.json', () => {
  const item = fixture()
  configureClaude({ ...item, profile: 'brain', now: new Date('2026-07-22T10:00:00.000Z') })
  const content = fs.readFileSync(item.claudeJsonPath, 'utf8')
  assert(!content.includes('offline-action-token'), 'raw action token must not appear in ~/.claude.json')
  assert(!content.includes('wbmcp_v1_'), 'derived credential must not appear — only its file path')
  fs.rmSync(item.root, { recursive: true })
})

test('scope equivalence: brain profile produces same env keys as Codex brain profile', () => {
  const item = fixture()
  configureClaude({ ...item, profile: 'brain', now: new Date('2026-07-22T10:00:00.000Z') })
  const doc = JSON.parse(fs.readFileSync(item.claudeJsonPath, 'utf8'))
  const env = doc.projects[item.targetProjectRoot].mcpServers.workbench.env
  assert.equal(env.WORKBENCH_MCP_ALLOWED_TOOLS, BRAIN_PROFILE_ALLOWED_TOOLS)
  assert.equal(env.WORKBENCH_MCP_ALLOWED_COMMAND_KINDS, BRAIN_PROFILE_ALLOWED_COMMAND_KINDS)
  assert.ok(env.WORKBENCH_MCP_CREDENTIAL_FILE)
  fs.rmSync(item.root, { recursive: true })
})

test('ignores worktree-local action tokens and derives MCP auth from owner configuration', () => {
  const item = fixture()
  const worktreeTokenFile = path.join(item.workbenchRepoRoot, 'apps', 'web', '.env.local')
  fs.mkdirSync(path.dirname(worktreeTokenFile), { recursive: true })
  fs.writeFileSync(worktreeTokenFile, 'WORKBENCH_ACTION_TOKEN=worktree-override-token-value\n', { mode: 0o600 })
  const result = configureClaude({ ...item, now: new Date('2026-07-22T10:00:00.000Z') })
  assert.equal(
    fs.readFileSync(result.credentialFile, 'utf8').trim(),
    deriveWorkbenchMcpCredential('offline-action-token-123456789')
  )
  fs.rmSync(item.root, { recursive: true })
})

test('INTEGRATION: claude mcp get recognizes local-scope registration (isolated HOME)', () => {
  let claudeBin: string
  try {
    claudeBin = execSync('command -v claude', { encoding: 'utf8', shell: '/bin/bash' }).trim()
    if (!claudeBin || !fs.existsSync(claudeBin)) throw new Error('not found')
  } catch {
    return
  }

  const rawRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-claude-integ-'))
  const root = fs.realpathSync(rawRoot)
  const homeDir = path.join(root, 'home')
  const workbenchRepoRoot = path.join(root, 'workbench')
  const targetProjectRoot = path.join(root, 'target')
  fs.mkdirSync(homeDir, { recursive: true })
  fs.mkdirSync(path.join(workbenchRepoRoot, 'packages', 'mcp', 'dist'), { recursive: true })
  fs.writeFileSync(path.join(workbenchRepoRoot, 'packages', 'mcp', 'dist', 'server.js'), '#!/usr/bin/env node\n', { mode: 0o700 })
  fs.mkdirSync(targetProjectRoot, { recursive: true })
  installWorkbenchOwnerConfig({ actionToken: 'offline-action-token-integration', homeDir })

  configureClaude({
    workbenchRepoRoot,
    targetProjectRoot,
    homeDir,
    claudeBin,
    checkProcesses: () => [],
    now: new Date('2026-07-22T10:00:00.000Z')
  })

  try {
    const env: Record<string, string | undefined> = { ...process.env, HOME: homeDir }
    delete env.CLAUDE_CONFIG_DIR
    const output = execSync(`${claudeBin} mcp get workbench`, {
      encoding: 'utf8',
      cwd: targetProjectRoot,
      env
    })
    assert.ok(output.includes('workbench') || output.includes('Local config'),
      `claude mcp get must find the local registration. Got: ${output.slice(0, 200)}`)
  } catch (error) {
    const stderr = (error as any).stderr?.toString() ?? ''
    const stdout = (error as any).stdout?.toString() ?? ''
    assert.fail(`Claude CLI did not recognize the local registration. stderr: ${stderr}. stdout: ${stdout}`)
  } finally {
    fs.rmSync(root, { recursive: true })
  }
})

test('REGRESSION: afterCliAdd boundary — concurrent write after CLI add is visible in validation', () => {
  const item = fixture()
  const existingDoc = { numericSetting: 99 }
  fs.writeFileSync(item.claudeJsonPath, JSON.stringify(existingDoc), { mode: 0o600 })

  const result = configureClaude(
    { ...item, now: new Date('2026-07-22T10:00:00.000Z') },
    {
      afterCliAdd: () => {
        const doc = JSON.parse(fs.readFileSync(item.claudeJsonPath, 'utf8'))
        doc.laterKey = 'written-after-cli-add'
        fs.writeFileSync(item.claudeJsonPath, JSON.stringify(doc, null, 2), { mode: 0o600 })
      }
    }
  )

  assert.equal(result.configured, true, 'post-write validation must still pass')
  const doc = JSON.parse(fs.readFileSync(item.claudeJsonPath, 'utf8'))
  assert.equal(doc.laterKey, 'written-after-cli-add', 'concurrent write after CLI add must survive — no whole-file restore')
  assert.equal(doc.numericSetting, 99, 'original key must survive')
  assert.ok(doc.projects[item.targetProjectRoot].mcpServers.workbench, 'workbench entry must be present')
  fs.rmSync(item.root, { recursive: true })
})

// ─── New tests for Blockers 1, 2, 3 ───────────────────────────────────────────

test('process guard: blocks mutation when Claude processes are running, credential not written', () => {
  const item = fixture()
  const credentialFile = path.join(item.homeDir, '.buildflow', 'codex-workbench-mcp.token')

  assert.throws(
    () => configureClaude({
      ...item,
      checkProcesses: () => ['Claude', 'claude'],
      now: new Date('2026-07-22T10:00:00.000Z')
    }),
    (err: Error) => {
      assert.ok(err.message.includes('Claude'), 'error must mention process name Claude')
      assert.ok(err.message.includes('claude'), 'error must mention process name claude')
      return true
    }
  )
  assert.equal(fs.existsSync(credentialFile), false,
    'credential file must NOT exist — process guard fires pre-CLI, credential is rolled back')
  fs.rmSync(item.root, { recursive: true })
})

test('process guard: allows mutation when checkProcesses returns empty array', () => {
  const item = fixture()
  const result = configureClaude({
    ...item,
    checkProcesses: () => [],
    now: new Date('2026-07-22T10:00:00.000Z')
  })
  assert.equal(result.configured, true, 'must succeed when no processes are running')
  fs.rmSync(item.root, { recursive: true })
})

test('post-CLI: credential preserved when CLI writes entry then exits non-zero', () => {
  const item = fixture()
  const credentialFile = path.join(item.homeDir, '.buildflow', 'codex-workbench-mcp.token')
  const writeAndFailBin = createWriteAndFailBin(item.homeDir)

  let caughtError: any
  assert.throws(
    () => configureClaude({
      ...item,
      claudeBin: writeAndFailBin,
      now: new Date('2026-07-22T10:00:00.000Z')
    }),
    (err: Error) => {
      caughtError = err
      return true
    }
  )

  assert.equal(fs.existsSync(credentialFile), true,
    'credential file MUST be preserved — CLI wrote the entry so the credential is referenced')
  assert.equal((caughtError as any).credentialPreserved, true,
    'error must have credentialPreserved=true')
  assert.equal((caughtError as any).phase, 'post-cli',
    'error must have phase=post-cli')

  // Verify the entry was actually written by the CLI before it exited 1
  const doc = JSON.parse(fs.readFileSync(item.claudeJsonPath, 'utf8'))
  assert.ok(doc.projects?.[item.targetProjectRoot]?.mcpServers?.workbench,
    'entry must be present in ~/.claude.json (written by CLI before exit 1)')

  fs.rmSync(item.root, { recursive: true })
})

test('post-CLI: credential preserved when afterCliAdd throws after entry is written', () => {
  const item = fixture()
  const credentialFile = path.join(item.homeDir, '.buildflow', 'codex-workbench-mcp.token')

  let caughtError: any
  assert.throws(
    () => configureClaude(
      { ...item, now: new Date('2026-07-22T10:00:00.000Z') },
      { afterCliAdd: () => { throw new Error('injected-fault-after-cli-add') } }
    ),
    (err: Error) => {
      caughtError = err
      return true
    }
  )

  assert.equal(fs.existsSync(credentialFile), true,
    'credential file must be preserved — CLI already wrote the entry')
  assert.equal((caughtError as any).credentialPreserved, true,
    'error must have credentialPreserved=true')

  // Entry was written by the mock CLI
  const doc = JSON.parse(fs.readFileSync(item.claudeJsonPath, 'utf8'))
  assert.ok(doc.projects?.[item.targetProjectRoot]?.mcpServers?.workbench,
    'entry must remain in ~/.claude.json after afterCliAdd fault')

  fs.rmSync(item.root, { recursive: true })
})

test('single file authority: inspectClaudeRegistration reads same path as CLI mutation target', () => {
  const item = fixture()
  const result = configureClaude({ ...item, now: new Date('2026-07-22T10:00:00.000Z') })
  const status = inspectClaudeRegistration({ ...item })
  assert.equal(result.claudeJsonPath, path.join(item.homeDir, '.claude.json'),
    'configureClaude must target ~/.claude.json derived from homeDir')
  assert.equal(status.claudeJsonPath, path.join(item.homeDir, '.claude.json'),
    'inspectClaudeRegistration must read the same path')
  assert.equal(result.claudeJsonPath, status.claudeJsonPath,
    'configure and inspect must use identical path — no claudeJsonPath option divergence possible')
  fs.rmSync(item.root, { recursive: true })
})

// ─── Closure items: process-probe, recovery commands, and post-CLI boundaries ──

// ─── probeProcessName unit tests: real decision logic, stub executor ─────────
// These test the actual defaultCheckProcesses decision code without touching live processes.

test('probeProcessName: exit 0 means process is running', () => {
  // Stub: execFileSync returns normally (exit 0 — process found).
  const result = probeProcessName('SomeApp', (_file, _args, _opts) => { /* no throw = exit 0 */ })
  assert.equal(result, 'running')
})

test('probeProcessName: exit 1 means no matching process (absent)', () => {
  // Stub: throw with status=1 (pgrep "no match").
  const exit1Error = Object.assign(new Error('Command failed'), { status: 1 })
  const result = probeProcessName('SomeApp', () => { throw exit1Error })
  assert.equal(result, 'absent')
})

test('probeProcessName: exit 2 (non-1 non-0) means probe error — fail closed', () => {
  const exit2Error = Object.assign(new Error('Command failed'), { status: 2 })
  const result = probeProcessName('SomeApp', () => { throw exit2Error })
  assert.equal(result, 'probe-error')
})

test('probeProcessName: null/missing status (ENOENT, EPERM) means probe error — fail closed', () => {
  // Stub: ENOENT (pgrep binary missing) — error has no status field.
  const enoentError = Object.assign(new Error('spawn /usr/bin/pgrep ENOENT'), { code: 'ENOENT' })
  const result = probeProcessName('SomeApp', () => { throw enoentError })
  assert.equal(result, 'probe-error')
})

test('probeProcessName: exit 127 (not-found shell error) means probe error — fail closed', () => {
  const err = Object.assign(new Error('spawn error'), { status: 127 })
  const result = probeProcessName('SomeApp', () => { throw err })
  assert.equal(result, 'probe-error')
})

test('defaultCheckProcesses (via injected): probe-error fails pre-CLI and rolls back credential', () => {
  // Verifies that a probe-error from defaultCheckProcesses propagates pre-mutation.
  const item = fixture()
  const credentialFile = path.join(item.homeDir, '.buildflow', 'codex-workbench-mcp.token')

  // Simulate what defaultCheckProcesses does when probeProcessName returns 'probe-error':
  // it throws before cliStarted=true, so the credential must be rolled back.
  assert.throws(
    () => configureClaude({
      ...item,
      checkProcesses: () => {
        throw new Error('Process probe for \'Claude\' failed unexpectedly.')
      },
      now: new Date('2026-07-22T10:00:00.000Z')
    }),
    /Process probe.*failed unexpectedly/
  )
  assert.equal(fs.existsSync(credentialFile), false,
    'credential must not exist — probe error fires pre-CLI, credential is rolled back')
  fs.rmSync(item.root, { recursive: true })
})

test('post-CLI: credential preserved when CLI times out after writing entry', () => {
  // Simulates a timeout-after-write: the binary writes the entry, then sleeps past the timeout.
  // The adapter's post-CLI inspection must find the entry and preserve the credential.
  const item = fixture()
  const credentialFile = path.join(item.homeDir, '.buildflow', 'codex-workbench-mcp.token')

  // Build a bin that writes the entry, then hangs (will be killed by the timeout).
  const binDir = path.join(item.homeDir, '.local', 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  const timeoutBin = path.join(binDir, 'claude-timeout-after-write')
  fs.writeFileSync(timeoutBin, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
if (args[0] === 'mcp' && args[1] === 'add-json' && args.includes('--scope') && args.includes('local')) {
  const nameIdx = args.indexOf('local') + 1;
  const name = args[nameIdx];
  const json = args[nameIdx + 1];
  const entry = JSON.parse(json);
  const home = process.env.HOME || require('os').homedir();
  const claudeJsonPath = path.join(home, '.claude.json');
  let doc = {};
  if (fs.existsSync(claudeJsonPath)) doc = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
  if (!doc.projects) doc.projects = {};
  const cwd = process.cwd();
  if (!doc.projects[cwd]) doc.projects[cwd] = {};
  if (!doc.projects[cwd].mcpServers) doc.projects[cwd].mcpServers = {};
  doc.projects[cwd].mcpServers[name] = entry;
  fs.writeFileSync(claudeJsonPath, JSON.stringify(doc, null, 2) + '\\n', { mode: 0o600 });
  // Hang until killed by the execFileSync timeout
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
}
process.exit(1);
`, { mode: 0o755 })

  let caughtError: any
  assert.throws(
    () => configureClaude({
      ...item,
      claudeBin: timeoutBin,
      now: new Date('2026-07-22T10:00:00.000Z')
    }),
    (err: Error) => { caughtError = err; return true }
  )

  assert.equal(fs.existsSync(credentialFile), true,
    'credential must be preserved — entry was written before timeout')
  assert.equal((caughtError as any).credentialPreserved, true,
    'error must carry credentialPreserved=true')
  assert.equal((caughtError as any).phase, 'post-cli',
    'error must carry phase=post-cli')
  fs.rmSync(item.root, { recursive: true })
})

test('post-CLI: credential preserved when ~/.claude.json is unreadable after CLI invocation', () => {
  const item = fixture()
  const credentialFile = path.join(item.homeDir, '.buildflow', 'codex-workbench-mcp.token')

  // Use a bin that corrupts ~/.claude.json after writing (simulates unreadable/ambiguous state).
  const binDir = path.join(item.homeDir, '.local', 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  const corruptBin = path.join(binDir, 'claude-corrupt')
  fs.writeFileSync(corruptBin, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
if (args[0] === 'mcp' && args[1] === 'add-json') {
  const home = process.env.HOME || require('os').homedir();
  const claudeJsonPath = path.join(home, '.claude.json');
  // Write invalid JSON (unreadable/ambiguous state)
  fs.writeFileSync(claudeJsonPath, 'NOT_VALID_JSON_{{{', { mode: 0o600 });
  process.stderr.write('corrupt-bin: wrote invalid JSON\\n');
  process.exit(1);
}
process.exit(1);
`, { mode: 0o755 })

  let caughtError: any
  assert.throws(
    () => configureClaude({
      ...item,
      claudeBin: corruptBin,
      now: new Date('2026-07-22T10:00:00.000Z')
    }),
    (err: Error) => { caughtError = err; return true }
  )

  assert.equal(fs.existsSync(credentialFile), true,
    'credential must be preserved when ~/.claude.json is unreadable — conservative policy')
  assert.equal((caughtError as any).credentialPreserved, true,
    'error must carry credentialPreserved=true for unreadable state')
  assert.ok(caughtError.message.includes('unreadable') || caughtError.message.includes('complete cleanly'),
    'error message must describe the unreadable state')
  fs.rmSync(item.root, { recursive: true })
})

test('post-write validation failure: credential preserved when validation fails after CLI succeeds', () => {
  // The CLI writes a valid local entry, but then a concurrent write adds a user-scope duplicate,
  // causing the post-write userMatchCount validation to fail. The credential must be preserved
  // because the expected local entry is present and references it.
  const item = fixture()
  const credentialFile = path.join(item.homeDir, '.buildflow', 'codex-workbench-mcp.token')

  let caughtError: any
  assert.throws(
    () => configureClaude(
      { ...item, now: new Date('2026-07-22T10:00:00.000Z') },
      {
        afterCliAdd: () => {
          // Inject a user-scope workbench entry after the CLI has written the local entry.
          // This will fail the post-write userMatchCount !== 0 validation.
          const doc = JSON.parse(fs.readFileSync(item.claudeJsonPath, 'utf8'))
          doc.mcpServers = { workbench: { command: '/usr/bin/node', args: ['/fake/server.js'] } }
          fs.writeFileSync(item.claudeJsonPath, JSON.stringify(doc), { mode: 0o600 })
        }
      }
    ),
    (err: Error) => { caughtError = err; return true }
  )

  assert.equal(fs.existsSync(credentialFile), true,
    'credential must be preserved — expected local entry is present even though validation failed')
  assert.equal((caughtError as any).credentialPreserved, true,
    'error must carry credentialPreserved=true')
  assert.equal((caughtError as any).phase, 'post-cli',
    'error must carry phase=post-cli')
  fs.rmSync(item.root, { recursive: true })
})

test('recovery commands: POSIX-quoted status and configure commands with --project-root and --profile', () => {
  const item = fixture()
  const credentialFile = path.join(item.homeDir, '.buildflow', 'codex-workbench-mcp.token')
  const writeAndFailBin = createWriteAndFailBin(item.homeDir)

  let caughtError: any
  assert.throws(
    () => configureClaude({
      ...item,
      claudeBin: writeAndFailBin,
      profile: 'brain',
      now: new Date('2026-07-22T10:00:00.000Z')
    }),
    (err: Error) => { caughtError = err; return true }
  )

  assert.equal(fs.existsSync(credentialFile), true, 'credential must be preserved')
  const msg: string = caughtError.message

  // Path must be POSIX single-quoted in the recovery commands
  const quotedRoot = `'${item.targetProjectRoot}'`
  assert.ok(
    msg.includes(`--project-root ${quotedRoot}`),
    `status command must include POSIX-quoted --project-root. Got: ${msg}`
  )
  // Must include --profile brain (non-default profile)
  assert.ok(msg.includes('--profile brain'), `status command must include --profile brain. Got: ${msg}`)
  // Grab just the recovery section to avoid false positives from JSON in the underlying error
  const statusIdx = msg.indexOf('pnpm mcp:claude:status')
  const configureIdx = msg.indexOf('pnpm mcp:claude:configure')
  assert.ok(statusIdx >= 0, 'must contain status command')
  assert.ok(configureIdx >= 0, 'must contain configure command')
  const recoverySection = msg.slice(statusIdx, msg.indexOf('Underlying error:'))
  assert.ok(!recoverySection.includes('['), `recovery section must not contain literal bracket. Got: ${recoverySection}`)
  fs.rmSync(item.root, { recursive: true })
})

test('recovery commands: workbench profile omits --profile flag (default)', () => {
  const item = fixture()
  const writeAndFailBin = createWriteAndFailBin(item.homeDir)

  let caughtError: any
  assert.throws(
    () => configureClaude({
      ...item,
      claudeBin: writeAndFailBin,
      profile: 'workbench',
      now: new Date('2026-07-22T10:00:00.000Z')
    }),
    (err: Error) => { caughtError = err; return true }
  )

  const msg: string = caughtError.message
  const quotedRoot = `'${item.targetProjectRoot}'`
  assert.ok(
    msg.includes(`--project-root ${quotedRoot}`),
    `must include POSIX-quoted --project-root. Got: ${msg}`
  )
  // workbench is the default: --profile flag should NOT appear
  assert.ok(!msg.includes('--profile'), `workbench profile must omit --profile flag. Got: ${msg}`)
  fs.rmSync(item.root, { recursive: true })
})

test('recovery commands: path with spaces and metacharacters is POSIX-shell safe', () => {
  // Build a fixture with a target project root containing spaces and shell metacharacters.
  // The fixture directory cannot contain null bytes but can contain spaces, $, backticks, etc.
  const rawRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-claude-config-'))
  const root = fs.realpathSync(rawRoot)
  const homeDir = path.join(root, 'home')
  // Use a target dir name with a space and $ (common in project names like "My Project $version")
  const targetProjectRoot = path.join(root, 'my project $var')
  const workbenchRepoRoot = path.join(root, 'workbench')
  fs.mkdirSync(homeDir, { recursive: true })
  fs.mkdirSync(path.join(workbenchRepoRoot, 'packages', 'mcp', 'dist'), { recursive: true })
  fs.writeFileSync(path.join(workbenchRepoRoot, 'packages', 'mcp', 'dist', 'server.js'), '#!/usr/bin/env node\n', { mode: 0o700 })
  fs.mkdirSync(targetProjectRoot, { recursive: true })
  installWorkbenchOwnerConfig({ actionToken: 'offline-action-token-123456789', homeDir })
  const writeAndFailBin = createWriteAndFailBin(homeDir)

  let caughtError: any
  assert.throws(
    () => configureClaude({
      workbenchRepoRoot,
      targetProjectRoot,
      homeDir,
      claudeBin: writeAndFailBin,
      checkProcesses: () => [],
      profile: 'brain',
      now: new Date('2026-07-22T10:00:00.000Z')
    }),
    (err: Error) => { caughtError = err; return true }
  )

  const msg: string = caughtError.message
  const canonicalTarget = fs.realpathSync(targetProjectRoot)

  // The path must be single-quoted — space and $ will not cause word-splitting or expansion
  const quotedTarget = `'${canonicalTarget}'`
  assert.ok(
    msg.includes(`--project-root ${quotedTarget}`),
    `path with space/$var must be single-quoted. Got: ${msg}`
  )

  // Prove no argument splitting: the unquoted path must NOT appear adjacent to --project-root
  // (if it did, the space would split it into two shell tokens)
  assert.ok(
    !msg.includes(`--project-root ${canonicalTarget} `),
    `unquoted path must not appear (would split on space). Got: ${msg}`
  )

  // Prove no $ expansion: the literal $var must survive inside the quotes
  assert.ok(
    msg.includes('$var'),
    `dollar sign must be preserved literally inside single quotes. Got: ${msg}`
  )

  fs.rmSync(root, { recursive: true })
})

test('recovery commands: path with embedded single quote is properly escaped', () => {
  // Edge case: path containing a single quote — must use the '\\'' escape sequence.
  const rawRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-claude-config-'))
  const root = fs.realpathSync(rawRoot)
  const homeDir = path.join(root, 'home')
  // Path: /tmp/.../it's/brain (contains a single quote)
  const targetProjectRoot = path.join(root, "it's brain")
  const workbenchRepoRoot = path.join(root, 'workbench')
  fs.mkdirSync(homeDir, { recursive: true })
  fs.mkdirSync(path.join(workbenchRepoRoot, 'packages', 'mcp', 'dist'), { recursive: true })
  fs.writeFileSync(path.join(workbenchRepoRoot, 'packages', 'mcp', 'dist', 'server.js'), '#!/usr/bin/env node\n', { mode: 0o700 })
  fs.mkdirSync(targetProjectRoot, { recursive: true })
  installWorkbenchOwnerConfig({ actionToken: 'offline-action-token-123456789', homeDir })
  const writeAndFailBin = createWriteAndFailBin(homeDir)

  let caughtError: any
  assert.throws(
    () => configureClaude({
      workbenchRepoRoot,
      targetProjectRoot,
      homeDir,
      claudeBin: writeAndFailBin,
      checkProcesses: () => [],
      now: new Date('2026-07-22T10:00:00.000Z')
    }),
    (err: Error) => { caughtError = err; return true }
  )

  const msg: string = caughtError.message
  const canonicalTarget = fs.realpathSync(targetProjectRoot)

  // The single quote in the path must be escaped as '\'' so the shell sees one token
  const expectedQuoted = `'${canonicalTarget.replace(/'/g, "'\\''")}'`
  assert.ok(
    msg.includes(`--project-root ${expectedQuoted}`),
    `single-quote in path must use '\\'' escape. Expected: --project-root ${expectedQuoted}. Got: ${msg}`
  )

  fs.rmSync(root, { recursive: true })
})
