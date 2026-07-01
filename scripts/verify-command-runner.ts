import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { getAllowedCommandKinds, runSafeCommand } from '../packages/cli/src/agent/command-runner'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buildflow-command-runner-'))
const run = (cmd: string, args: string[], cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'pipe' })
const write = (rel: string, content: string) => {
  const full = path.join(root, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}
const expectReject = async (label: string, fn: () => Promise<unknown>) => {
  let rejected = false
  try {
    await fn()
  } catch {
    rejected = true
  }
  assert.equal(rejected, true, label)
}

async function main() {
run('git', ['init'])
run('git', ['config', 'user.email', 'buildflow@example.test'])
run('git', ['config', 'user.name', 'BuildFlow Test'])
write('src/a.ts', 'export const a = 1\n')
write('src/config.json', '{"ok":true}\n')
write('src/not-json.ts', 'export {}\n')
write('.env.example', 'API_KEY=<token>\n')
write('pkg/package.json', JSON.stringify({ scripts: { typecheck: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"' } }, null, 2))
write('src/scan.ts', `const token = "${'g' + 'hp_FAKE_TOKEN_FOR_REDACTION_ONLY'}"\n`)

const base = { sourceId: 'test', sourceRoot: root }
const kinds = getAllowedCommandKinds()
assert(kinds.includes('git_diff_cached_stat'))
assert(kinds.includes('git_diff_cached_name_only'))
assert(kinds.includes('git_add_paths'))
assert(kinds.includes('git_commit'))
assert(kinds.includes('git_push'))
assert(kinds.includes('validate_json_files'))
assert(kinds.includes('run_package_script'))
assert(kinds.includes('run_package_test'))
assert(kinds.includes('run_package_test_marker'))
assert(kinds.includes('security_scan_paths'))

await expectReject('git_add_paths rejects dot', () => runSafeCommand({ ...base, commandKind: 'git_add_paths', paths: ['.'] }))
await expectReject('git_add_paths rejects -A', () => runSafeCommand({ ...base, commandKind: 'git_add_paths', paths: ['-A'] }))
await expectReject('git_add_paths rejects traversal', () => runSafeCommand({ ...base, commandKind: 'git_add_paths', paths: ['../outside.ts'] }))
await expectReject('git_commit requires staged changes', () => runSafeCommand({ ...base, commandKind: 'git_commit', message: 'test commit', confirmedByUser: true }))

let result = await runSafeCommand({ ...base, commandKind: 'git_add_paths', paths: ['src/a.ts', '.env.example'] })
assert.equal(result.status, 'completed')
result = await runSafeCommand({ ...base, commandKind: 'git_diff_cached_name_only' })
assert.equal(result.status, 'completed')
assert(result.stdout.includes('src/a.ts'))
await expectReject('git_commit rejects secret-looking message', () => runSafeCommand({ ...base, commandKind: 'git_commit', message: 'leak ' + 's' + 'k_live_fake', confirmedByUser: true }))
result = await runSafeCommand({ ...base, commandKind: 'git_commit', message: 'test: add fixture', confirmedByUser: true })
assert.equal(result.status, 'completed')
assert(result.stdout.includes('test: add fixture'))

write('public/assets/file.pdf', 'fake pdf\n')
run('git', ['add', '--', 'public/assets/file.pdf'])
run('git', ['commit', '-m', 'test: add tracked asset'])
fs.rmSync(path.join(root, 'public/assets/file.pdf'))
await expectReject('git_add_paths rejects tracked binary deletion without confirmation', () => runSafeCommand({ ...base, commandKind: 'git_add_paths', paths: ['public/assets/file.pdf'] }))
result = await runSafeCommand({ ...base, commandKind: 'git_add_paths', paths: ['public/assets/file.pdf'], confirmedByUser: true })
assert.equal(result.status, 'completed')
result = await runSafeCommand({ ...base, commandKind: 'git_diff_cached_name_only' })
assert.equal(result.status, 'completed')
assert(result.stdout.includes('public/assets/file.pdf'))
await expectReject('git_commit rejects tracked binary deletion without confirmation', () => runSafeCommand({ ...base, commandKind: 'git_commit', message: 'test: delete tracked asset' }))
result = await runSafeCommand({ ...base, commandKind: 'git_commit', message: 'test: delete tracked asset', confirmedByUser: true })
assert.equal(result.status, 'completed')
assert(result.stdout.includes('test: delete tracked asset'))
write('public/assets/untracked.pdf', 'fake pdf\n')
await expectReject('git_add_paths rejects untracked binary asset', () => runSafeCommand({ ...base, commandKind: 'git_add_paths', paths: ['public/assets/untracked.pdf'], confirmedByUser: true }))

await expectReject('git_push rejects force flag branch', () => runSafeCommand({ ...base, commandKind: 'git_push', branch: '--force', confirmedByUser: true }))
await expectReject('git_push rejects refspec branch', () => runSafeCommand({ ...base, commandKind: 'git_push', branch: 'main:evil', confirmedByUser: true }))

result = await runSafeCommand({ ...base, commandKind: 'validate_json_files', paths: ['src/config.json'] })
assert.equal(result.status, 'completed')
await expectReject('validate_json_files rejects non-json', () => runSafeCommand({ ...base, commandKind: 'validate_json_files', paths: ['src/not-json.ts'] }))
await expectReject('run_package_script rejects unsafe scriptName', () => runSafeCommand({ ...base, commandKind: 'run_package_script', packageDir: 'pkg', scriptName: 'test;rm' }))
result = await runSafeCommand({ ...base, commandKind: 'run_package_script', packageDir: 'pkg', scriptName: 'typecheck' })
assert.equal(result.status, 'completed')
result = await runSafeCommand({ ...base, commandKind: 'run_package_test', packageDir: 'pkg' })
assert.equal(result.status, 'completed')
await expectReject('run_package_test_marker rejects shell metacharacters', () => runSafeCommand({ ...base, commandKind: 'run_package_test_marker', packageDir: 'pkg', marker: 'ok; rm -rf .' }))
await expectReject('security_scan_paths rejects unknown pattern set', () => runSafeCommand({ ...base, commandKind: 'security_scan_paths', paths: ['src/scan.ts'], patternSet: 'custom_regex' as any }))
result = await runSafeCommand({ ...base, commandKind: 'security_scan_paths', paths: ['src/scan.ts'], patternSet: 'forbidden_secret_material' })
assert.equal(result.status, 'failed')
assert(result.stdout.includes('[REDACTED]'))
assert(!result.stdout.includes('FAKE_TOKEN_FOR_REDACTION_ONLY'))

assert(kinds.includes('run_exact_command'))

write('package.json', JSON.stringify({
  scripts: {
    valid: 'node -e "console.log(process.version)"',
    redact: 'node -e "console.log(\'DATABASE_URL=postgres://user:password@example.test/db\')"',
    mutate: 'node -e "require(\'fs\').writeFileSync(\'protected.txt\', \'changed\')"',
    timeout: 'node -e "setInterval(() => {}, 1000)"',
    database: 'payload migrate',
    migration: 'prisma migrate deploy',
    deployment: 'docker push example/image:latest',
    network: 'curl https://example.test',
    envcheck: 'node -e "console.log(process.env.DATABASE_URL || \'missing\')"'
  }
}, null, 2))
write('protected.txt', 'original\n')
run('git', ['add', '--', 'package.json', 'protected.txt'])
run('git', ['commit', '-m', 'test: add exact command fixtures'])
const branch = execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim()
const exactBase = {
  ...base,
  commandKind: 'run_exact_command' as const,
  nodeVersion: '20' as const,
  packageDir: '.',
  requiredBranch: branch,
  protectedPaths: ['protected.txt'],
  networkAccess: false as const,
  policy: { denyDatabaseCommands: true, denyMigrationCommands: true, denyDeploymentCommands: true, denyNetworkCommands: true }
}

await expectReject('exact command rejects shell metacharacters', () => runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', 'ok; bad'] }))
await expectReject('exact command rejects absolute escape', () => runSafeCommand({ ...exactBase, executable: 'node', args: [path.resolve(root, '..', 'outside.js')] }))
await expectReject('exact command rejects traversal', () => runSafeCommand({ ...exactBase, executable: 'node', args: ['../outside.js'] }))
await expectReject('exact command rejects nonexistent script', () => runSafeCommand({ ...exactBase, executable: 'pnpm', args: ['missing-script'] }))
await expectReject('exact command blocks database script', () => runSafeCommand({ ...exactBase, executable: 'pnpm', args: ['database'] }))
await expectReject('exact command blocks migration script', () => runSafeCommand({ ...exactBase, executable: 'pnpm', args: ['migration'] }))
await expectReject('exact command blocks deployment script', () => runSafeCommand({ ...exactBase, executable: 'pnpm', args: ['deployment'] }))
await expectReject('exact command blocks network script', () => runSafeCommand({ ...exactBase, executable: 'pnpm', args: ['network'] }))

result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['--version'], requiredBranch: 'definitely-not-current' })
assert.equal(result.status, 'blocked')
assert.equal(result.reason, 'branch_mismatch')
assert.equal(result.actualBranch, branch)

const siblingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'buildflow-command-sibling-'))
await expectReject('exact command cannot access sibling repository', () => runSafeCommand({ ...exactBase, executable: 'node', args: [path.join(siblingRoot, 'file.js')] }))
fs.rmSync(siblingRoot, { recursive: true, force: true })

let node20Available = process.version.startsWith('v20.')
if (!node20Available && process.env.NVM_DIR) {
  const versions = path.join(process.env.NVM_DIR, 'versions', 'node')
  node20Available = fs.existsSync(versions) && fs.readdirSync(versions).some(name => /^v20\./.test(name))
}
if (node20Available) {
  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['--version'] })
  assert.equal(result.status, 'completed')
  assert.equal(result.runtime?.nodeMajorVersion, 20)
  assert.match(result.runtime?.nodeVersion || '', /^v20\./)

  result = await runSafeCommand({ ...exactBase, executable: 'pnpm', args: ['--version'] })
  assert.equal(result.status, 'completed')
  assert(result.runtime?.pnpmVersion)

  result = await runSafeCommand({ ...exactBase, executable: 'pnpm', args: ['valid'] })
  assert.equal(result.status, 'completed')
  assert.equal((result.details as { resolvedScriptName?: string } | undefined)?.resolvedScriptName, 'valid')

  result = await runSafeCommand({ ...exactBase, executable: 'pnpm', args: ['redact'] })
  assert.equal(result.status, 'completed')
  assert(result.stdout.includes('[REDACTED]'))
  assert(!result.stdout.includes('password@example.test'))

  result = await runSafeCommand({ ...exactBase, executable: 'pnpm', args: ['envcheck'] })
  assert.equal(result.status, 'completed')
  assert(result.stdout.includes('missing'))

  result = await runSafeCommand({ ...exactBase, executable: 'pnpm', args: ['mutate'] })
  assert.equal(result.status, 'blocked')
  assert.deepEqual(result.protectedPathsChanged, ['protected.txt'])

  result = await runSafeCommand({ ...exactBase, executable: 'pnpm', args: ['timeout'], timeoutMs: 1000 })
  assert.equal(result.status, 'timed_out')
  assert(result.durationMs < 4000)
} else {
  await expectReject('exact command reports unavailable Node 20', () => runSafeCommand({ ...exactBase, executable: 'node', args: ['--version'] }))
}

write('diff/one.txt', 'one base\n')
write('diff/two.txt', 'two base\n')
run('git', ['add', '--', 'diff/one.txt', 'diff/two.txt'])
run('git', ['commit', '-m', 'test: add diff fixtures'])
write('diff/one.txt', 'one changed\n')
write('diff/two.txt', 'two changed\n')
write('diff/new.txt', 'new untracked\n')
write('unrelated-untracked.txt', 'unrelated\n')

result = await runSafeCommand({ ...base, commandKind: 'git_diff', paths: ['diff/one.txt'] })
assert.equal(result.status, 'completed')
assert(result.stdout.includes('diff/one.txt'))
assert(!result.stdout.includes('diff/two.txt'))
assert(!result.stdout.includes('unrelated-untracked.txt'))

result = await runSafeCommand({ ...base, commandKind: 'git_diff_name_only', paths: ['diff/one.txt', 'diff/two.txt', 'diff/new.txt'] })
assert.equal(result.status, 'completed')
assert(result.stdout.includes('diff/one.txt'))
assert(result.stdout.includes('diff/two.txt'))
assert(result.stdout.includes('Untracked path evidence:'))
assert(result.stdout.includes('?? diff/new.txt'))
assert(!result.stdout.includes('unrelated-untracked.txt'))

result = await runSafeCommand({ ...base, commandKind: 'git_diff_stat', paths: ['diff/one.txt', 'diff/two.txt'] })
assert.equal(result.status, 'completed')
assert(result.stdout.includes('diff/one.txt'))
assert(result.stdout.includes('diff/two.txt'))

await expectReject('git_diff rejects option-like pathspec', () => runSafeCommand({ ...base, commandKind: 'git_diff', paths: ['-bad'] }))
await expectReject('git_diff rejects traversal pathspec', () => runSafeCommand({ ...base, commandKind: 'git_diff', paths: ['../outside.txt'] }))

result = await runSafeCommand({ ...base, commandKind: 'git_diff' })
assert.equal(result.status, 'completed')
assert(result.stdout.includes('diff/one.txt'))
assert(result.stdout.includes('diff/two.txt'))
assert(!result.stdout.includes('Untracked path evidence:'))

const openapiRoute = fs.readFileSync(path.join(process.cwd(), 'apps/web/src/app/api/openapi/route.ts'), 'utf8')
for (const token of ['git_add_paths', 'git_commit', 'git_push', 'validate_json_files', 'run_package_script', 'run_package_test', 'run_package_test_marker', 'security_scan_paths', 'run_exact_command', 'executable', 'args', 'nodeVersion', 'policy', 'protectedPaths', 'requiredBranch', 'networkAccess', 'packageDir', 'scriptName', 'patternSet', 'confirmationToken']) {
  assert(openapiRoute.includes(token), `OpenAPI route missing ${token}`)
}

const runCommandRoute = fs.readFileSync(path.join(process.cwd(), 'apps/web/src/app/api/actions/run-command/route.ts'), 'utf8')
assert(runCommandRoute.includes("if (clean.status === 'timed_out')"), 'run-command route missing timed_out normalization')
assert(runCommandRoute.includes("status: 'timeout'"), 'run-command route missing timeout status')
for (const token of ['sourceId', 'executable', 'args', 'packageDir', 'requiredBranch', 'actualBranch', 'runtime', 'changedPaths', 'protectedPathsChanged', 'riskLevel', 'requiresConfirmation', 'signal', 'durationMs', 'outputTruncated', 'stdout', 'stderr', 'exitCode']) {
  assert(runCommandRoute.includes(`${token}:`), `run-command timeout response missing ${token}`)
}

fs.rmSync(root, { recursive: true, force: true })
console.log('command runner checks passed')
}

main().catch(error => {
  fs.rmSync(root, { recursive: true, force: true })
  console.error(error)
  process.exit(1)
})
