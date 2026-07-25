import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import test from 'node:test'
import {
  WORKBENCH_MCP_PROFILES,
  BRAIN_PROFILE_ALLOWED_TOOLS,
  BRAIN_PROFILE_ALLOWED_COMMAND_KINDS,
  PROFILE_AVAILABILITY,
  WORKBENCH_CREDENTIAL_FILE_NAME,
  buildWorkbenchMcpServerSpec,
  canonicalProjectRoot,
  canonicalNodeExecutable,
  parseConfigureCliArgs
} from '../configure-core.js'

test('WORKBENCH_MCP_PROFILES contains exactly workbench and brain', () => {
  assert.deepEqual([...WORKBENCH_MCP_PROFILES], ['workbench', 'brain'])
})

test('PROFILE_AVAILABILITY maps workbench=required and brain=optional', () => {
  assert.equal(PROFILE_AVAILABILITY.workbench, 'required')
  assert.equal(PROFILE_AVAILABILITY.brain, 'optional')
})

test('WORKBENCH_CREDENTIAL_FILE_NAME is the shared cross-client credential file name', () => {
  assert.equal(WORKBENCH_CREDENTIAL_FILE_NAME, 'codex-workbench-mcp.token')
})

test('BRAIN_PROFILE constants are the exact allowlist values both clients must emit', () => {
  assert.equal(BRAIN_PROFILE_ALLOWED_TOOLS, 'getWorkbenchStatus,readWorkbenchContext,runWorkbenchCommand')
  assert.equal(BRAIN_PROFILE_ALLOWED_COMMAND_KINDS, 'n8n_workflow_migration')
})

test('buildWorkbenchMcpServerSpec workbench profile has no scope restrictions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-core-'))
  const credFile = path.join(root, '.buildflow', 'codex-workbench-mcp.token')
  const nodeExec = process.execPath
  const spec = buildWorkbenchMcpServerSpec(root, credFile, nodeExec, 'workbench')
  assert.equal(spec.command, nodeExec)
  assert.deepEqual(spec.args, [path.join(root, 'packages', 'mcp', 'dist', 'server.js')])
  assert.equal(spec.cwd, root)
  assert.equal(spec.env.WORKBENCH_MCP_CREDENTIAL_FILE, credFile)
  assert.equal(spec.env.WORKBENCH_MCP_ALLOWED_TOOLS, undefined)
  assert.equal(spec.env.WORKBENCH_MCP_ALLOWED_COMMAND_KINDS, undefined)
  assert.equal(spec.profile, 'workbench')
  assert.equal(spec.availability, 'required')
  fs.rmSync(root, { recursive: true })
})

test('buildWorkbenchMcpServerSpec brain profile includes exact scope restriction env vars', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-core-'))
  const credFile = path.join(root, '.buildflow', 'codex-workbench-mcp.token')
  const nodeExec = process.execPath
  const spec = buildWorkbenchMcpServerSpec(root, credFile, nodeExec, 'brain')
  assert.equal(spec.env.WORKBENCH_MCP_ALLOWED_TOOLS, BRAIN_PROFILE_ALLOWED_TOOLS)
  assert.equal(spec.env.WORKBENCH_MCP_ALLOWED_COMMAND_KINDS, BRAIN_PROFILE_ALLOWED_COMMAND_KINDS)
  assert.equal(spec.profile, 'brain')
  assert.equal(spec.availability, 'optional')
  fs.rmSync(root, { recursive: true })
})

test('buildWorkbenchMcpServerSpec defaults to workbench profile', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-core-'))
  const spec = buildWorkbenchMcpServerSpec(root, '/cred', process.execPath)
  assert.equal(spec.profile, 'workbench')
  assert.equal(spec.availability, 'required')
  fs.rmSync(root, { recursive: true })
})

test('parseConfigureCliArgs parses all valid argument combinations', () => {
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

test('parseConfigureCliArgs rejects a relative project root', () => {
  assert.throws(() => parseConfigureCliArgs(['--project-root', 'relative/path']), /absolute path/)
})

test('canonicalProjectRoot resolves symlinks (macOS /tmp regression)', () => {
  const rawTmp = fs.mkdtempSync(path.join('/tmp', 'workbench-canon-root-'))
  const canonical = canonicalProjectRoot(rawTmp, 'test root')
  assert.equal(canonical, fs.realpathSync(rawTmp), 'must resolve through symlinks')
  fs.rmSync(canonical, { recursive: true })
})

test('canonicalProjectRoot rejects non-absolute path', () => {
  assert.throws(() => canonicalProjectRoot('relative/path', 'test'), /absolute path/)
})

test('canonicalProjectRoot rejects non-directory', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-canon-'))
  const root = fs.realpathSync(tmp)
  const file = path.join(root, 'file.txt')
  fs.writeFileSync(file, 'x')
  assert.throws(() => canonicalProjectRoot(file, 'test'), /must be a directory/)
  fs.rmSync(root, { recursive: true })
})

test('canonicalNodeExecutable resolves to real path', () => {
  const real = canonicalNodeExecutable(process.execPath)
  assert.equal(real, fs.realpathSync(process.execPath))
})

test('canonicalNodeExecutable rejects non-absolute path', () => {
  assert.throws(() => canonicalNodeExecutable('node'), /absolute path/)
})
