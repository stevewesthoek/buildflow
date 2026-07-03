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

async function verifyExtensionlessGitPaths() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'buildflow-extensionless-git-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'buildflow-extensionless-outside-'))
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe', encoding: 'utf8' })
  const put = (rel: string, content: string) => {
    const full = path.join(repo, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  const cachedPaths = () => git(['diff', '--cached', '--name-only']).trim().split('\n').filter(Boolean).sort()
  const extensionlessPaths = Array.from({ length: 10 }, (_, index) => `docs/example/channel/scripts/${String(index + 1).padStart(3, '0')}`)
  const requestedPaths = [
    'docs/example/README.md',
    'docs/example/channel/README.md',
    ...extensionlessPaths
  ]
  const modifiedExtensionless = [extensionlessPaths[0], extensionlessPaths[1], extensionlessPaths[3], extensionlessPaths[4], extensionlessPaths[8]]
  const deletedExtensionless = [extensionlessPaths[2], extensionlessPaths[5], extensionlessPaths[6], extensionlessPaths[7], extensionlessPaths[9]]
  const binaryExtensionless = 'docs/example/channel/scripts/binary'
  const commandBase = { sourceId: 'extensionless-test', sourceRoot: repo }

  try {
    git(['init'])
    git(['config', 'user.email', 'buildflow@example.test'])
    git(['config', 'user.name', 'BuildFlow Test'])
    put(requestedPaths[0], '# Initial channel\n')
    put(requestedPaths[1], '# Initial scripts\n')
    extensionlessPaths.forEach((rel, index) => put(rel, `initial ${index + 1}\n`))
    put('LICENSE', 'initial license\n')
    fs.writeFileSync(path.join(repo, binaryExtensionless), Buffer.from([0, 1, 2, 3]))
    put('notes/unrelated.md', 'initial unrelated\n')
    git(['add', '--', ...requestedPaths, 'LICENSE', binaryExtensionless, 'notes/unrelated.md'])
    git(['commit', '-m', 'test: seed extensionless fixtures'])

    put('LICENSE', 'updated license\n')
    await expectReject('git_add_paths requires confirmation for LICENSE', () => runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: ['LICENSE'] }))
    await expectReject('git_add_paths rejects an invalid LICENSE confirmation token', () => runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: ['LICENSE'], confirmationToken: 'confirm:invalid' }))
    assert.deepEqual(cachedPaths(), [])
    let result = await runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: ['LICENSE'], confirmedByUser: true })
    assert.equal(result.status, 'completed')
    await expectReject('git_commit requires confirmation for LICENSE', () => runSafeCommand({ ...commandBase, commandKind: 'git_commit', paths: ['LICENSE'], message: 'test: update license' }))
    await expectReject('git_commit rejects an invalid LICENSE confirmation token', () => runSafeCommand({ ...commandBase, commandKind: 'git_commit', paths: ['LICENSE'], message: 'test: update license', confirmationToken: 'confirm:invalid' }))
    result = await runSafeCommand({ ...commandBase, commandKind: 'git_commit', paths: ['LICENSE'], message: 'test: update license', confirmedByUser: true })
    assert.equal(result.status, 'completed')

    fs.rmSync(path.join(repo, binaryExtensionless))
    await expectReject('git_add_paths rejects a deleted extensionless binary even with confirmation', () => runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: [binaryExtensionless], confirmedByUser: true }))
    assert.deepEqual(cachedPaths(), [])
    git(['checkout', '--', binaryExtensionless])

    put(requestedPaths[0], '# Updated channel\n')
    put(requestedPaths[1], '# Updated scripts\n')
    modifiedExtensionless.forEach((rel, index) => put(rel, `modified ${index + 1}\n`))
    deletedExtensionless.forEach(rel => fs.rmSync(path.join(repo, rel)))
    put('notes/unrelated.md', 'changed but unstaged\n')
    put('kanban.md', 'untracked and unrelated\n')

    result = await runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: requestedPaths })
    assert.equal(result.status, 'completed')
    const exactDetails = result.details as {
      requestedPaths: string[]
      stagedPaths: string[]
      stagedStatuses: Array<{ status: string; path: string }>
      unrelatedStagedPaths: string[]
      missingStagedPaths: string[]
      exactMatch: boolean
    }
    assert.equal(exactDetails.exactMatch, true)
    assert.deepEqual([...exactDetails.requestedPaths].sort(), [...requestedPaths].sort())
    assert.deepEqual([...exactDetails.stagedPaths].sort(), [...requestedPaths].sort())
    assert.deepEqual(exactDetails.unrelatedStagedPaths, [])
    assert.deepEqual(exactDetails.missingStagedPaths, [])
    assert.deepEqual(cachedPaths(), [...requestedPaths].sort())
    for (const rel of deletedExtensionless) {
      assert(exactDetails.stagedStatuses.some(item => item.path === rel && item.status.startsWith('D')), `${rel} must be staged as deleted`)
    }
    assert(!cachedPaths().includes('notes/unrelated.md'))
    assert(!cachedPaths().includes('kanban.md'))

    result = await runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: requestedPaths })
    assert.equal(result.status, 'completed')
    assert.equal((result.details as { exactMatch?: boolean }).exactMatch, true)
    assert.deepEqual(cachedPaths(), [...requestedPaths].sort())

    result = await runSafeCommand({ ...commandBase, commandKind: 'git_commit', paths: requestedPaths, message: 'test: commit exact extensionless set' })
    assert.equal(result.status, 'completed')
    const committedPaths = git(['show', '--pretty=format:', '--name-only', 'HEAD']).trim().split('\n').filter(Boolean).sort()
    assert.deepEqual(committedPaths, [...requestedPaths].sort())
    const unrelatedStatus = git(['status', '--short', '--', 'notes/unrelated.md', 'kanban.md'])
    assert(unrelatedStatus.includes('notes/unrelated.md'))
    assert(unrelatedStatus.includes('kanban.md'))

    put('scripts/untracked-command', 'untracked extensionless text\n')
    result = await runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: ['scripts/untracked-command', 'scripts/untracked-command'] })
    assert.equal(result.status, 'completed')
    const dedupedDetails = result.details as { exactMatch?: boolean; requestedPaths?: string[] }
    assert.equal(dedupedDetails.exactMatch, true)
    assert.deepEqual(dedupedDetails.requestedPaths, ['scripts/untracked-command'])
    git(['reset', '--', 'scripts/untracked-command'])
    fs.rmSync(path.join(repo, 'scripts/untracked-command'))

    const disallowedUntracked = 'wiki/example/channel/scripts/untracked'
    put(disallowedUntracked, 'outside ordinary write roots\n')
    await expectReject('git_add_paths rejects untracked extensionless files outside ordinary write roots', () => runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: [disallowedUntracked] }))
    fs.rmSync(path.join(repo, disallowedUntracked))

    fs.mkdirSync(path.join(repo, 'scripts/directory'), { recursive: true })
    await expectReject('git_add_paths rejects explicit directories', () => runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: ['scripts/directory'] }))
    fs.rmSync(path.join(repo, 'scripts/directory'), { recursive: true })

    fs.writeFileSync(path.join(repo, 'scripts/oversized-command'), Buffer.alloc(1_000_001, 65))
    await expectReject('git_add_paths rejects oversized extensionless files consistently', () => runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: ['scripts/oversized-command'] }))
    fs.rmSync(path.join(repo, 'scripts/oversized-command'))
    await expectReject('git_add_paths rejects control characters in paths', () => runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: ['scripts/bad\nname'] }))

    if (process.platform !== 'win32') {
      put('scripts/*', 'literal wildcard filename\n')
      put('scripts/pathspec-neighbor', 'must remain untracked\n')
      result = await runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: ['scripts/*'] })
      assert.equal(result.status, 'completed')
      const literalDetails = result.details as { exactMatch?: boolean; stagedPaths?: string[] }
      assert.equal(literalDetails.exactMatch, true)
      assert.deepEqual(literalDetails.stagedPaths, ['scripts/*'])
      assert(!cachedPaths().includes('scripts/pathspec-neighbor'))
      git(['reset', '--', 'scripts/*'])
      fs.rmSync(path.join(repo, 'scripts/*'))
      fs.rmSync(path.join(repo, 'scripts/pathspec-neighbor'))
    }

    put(extensionlessPaths[0], 'valid change before atomic rejection\n')
    const cachedBeforeRejectedRequest = cachedPaths()
    await expectReject('git_add_paths rejects an atomic set containing .git/config', () => runSafeCommand({
      ...commandBase,
      commandKind: 'git_add_paths',
      paths: [extensionlessPaths[0], '.git/config']
    }))
    assert.deepEqual(cachedPaths(), cachedBeforeRejectedRequest)
    await expectReject('git_add_paths rejects traversal for extensionless paths', () => runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: ['../outside-file'] }))
    await expectReject('git_add_paths rejects absolute extensionless paths', () => runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: [path.join(repo, extensionlessPaths[0])] }))
    await expectReject('git_add_paths rejects prohibited .git/config', () => runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: ['.git/config'] }))

    if (process.platform !== 'win32') {
      const outsideFile = path.join(outside, 'outside-file')
      fs.writeFileSync(outsideFile, 'outside\n')
      const symlinkPath = path.join(repo, 'scripts', 'escape')
      fs.mkdirSync(path.dirname(symlinkPath), { recursive: true })
      fs.symlinkSync(outsideFile, symlinkPath)
      await expectReject('git_add_paths rejects symlink escapes', () => runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: ['scripts/escape'] }))
      fs.rmSync(symlinkPath)
    }

    put('notes/unrelated.md', 'pre-staged unrelated change\n')
    git(['add', '--', 'notes/unrelated.md'])
    result = await runSafeCommand({ ...commandBase, commandKind: 'git_add_paths', paths: [extensionlessPaths[0]] })
    assert.equal(result.status, 'completed')
    assert.equal((result.details as { exactMatch?: boolean }).exactMatch, false)
    assert((result.details as { unrelatedStagedPaths: string[] }).unrelatedStagedPaths.includes('notes/unrelated.md'))

    result = await runSafeCommand({ ...commandBase, commandKind: 'git_commit', paths: [extensionlessPaths[0]], message: 'test: must not commit mismatched set' })
    assert.equal(result.status, 'failed')
    assert.equal(result.reason, 'staged_path_set_mismatch')
    const mismatchDetails = result.details as { exactMatch: boolean; unrelatedStagedPaths: string[] }
    assert.equal(mismatchDetails.exactMatch, false)
    assert(mismatchDetails.unrelatedStagedPaths.includes('notes/unrelated.md'))
    assert.equal(git(['log', '-1', '--pretty=%s']).trim(), 'test: commit exact extensionless set')
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
}

async function main() {
await verifyExtensionlessGitPaths()
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
    generatevendor: 'node -e "require(\'fs\').mkdirSync(\'node_modules/generated\', { recursive: true }); require(\'fs\').writeFileSync(\'node_modules/generated/output.txt\', \'generated\')"',
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

await expectReject('inline Node rejects source over 12000 characters', () => runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', 'x'.repeat(12_001)] }))
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
const nvmDirs = Array.from(new Set([
  process.env.NVM_DIR,
  process.env.HOME ? path.join(process.env.HOME, '.nvm') : undefined
].filter((value): value is string => typeof value === 'string' && value.length > 0)))
for (const nvmDir of nvmDirs) {
  if (node20Available) break
  const versions = path.join(nvmDir, 'versions', 'node')
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

  write('scan/one.txt', 'deprecated-package\n')
  write('scan/nested/two.md', 'safe\ndeprecated-package\n')
  write('node_modules/example-cli/index.js', "#!/usr/bin/env node\nif (process.argv.includes('--help')) console.log('example-cli help')\n")
  fs.chmodSync(path.join(root, 'node_modules/example-cli/index.js'), 0o755)
  fs.mkdirSync(path.join(root, 'node_modules/.bin'), { recursive: true })
  fs.symlinkSync('../example-cli/index.js', path.join(root, 'node_modules/.bin/example-cli'))

  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', "const pkg=JSON.parse(require('node:fs').readFileSync('package.json','utf8')); console.log(pkg.scripts.valid)"] })
  assert.equal(result.status, 'completed')
  assert(result.stdout.includes('process.version'))

  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', "console.log('small-output')"] })
  assert.equal(result.status, 'completed')
  assert.equal(result.outputTruncated, false)
  assert(result.stdout.includes('small-output'))

  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', "process.stdout.write('x'.repeat(70_000))"] })
  assert.equal(result.status, 'failed')
  assert.equal(result.outputTruncated, true)
  assert.equal(result.reason, 'output_limit_exceeded')

  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', "process.stderr.write('x'.repeat(70_000))"] })
  assert.equal(result.status, 'failed')
  assert.equal(result.outputTruncated, true)
  assert.equal(result.reason, 'output_limit_exceeded')

  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', "process.stdout.write('x'.repeat(35_000)); process.stderr.write('y'.repeat(35_000))"] })
  assert.equal(result.status, 'failed')
  assert.equal(result.outputTruncated, true)
  assert.equal(result.reason, 'output_limit_exceeded')

  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', "require('node:os')"] })
  assert.equal(result.status, 'failed')
  assert.match(result.stderr, /module node:os is not allowlisted/)

  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', "console.log(JSON.stringify({platform:process.platform,arch:process.arch}))"] })
  assert.equal(result.status, 'completed')
  assert(result.stdout.includes(process.platform))
  assert(result.stdout.includes(process.arch))

  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', "require('node:child_process')"] })
  assert.equal(result.status, 'failed')
  assert.match(result.stderr, /module node:child_process is not allowlisted/)

  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', "require('node:fs').readdirSync('.', { recursive: true })"] })
  assert.equal(result.status, 'failed')
  assert.match(result.stderr, /recursive readdir is not allowed/)

  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', "require('node:fs\/promises').readdir('.', { recursive: true })"] })
  assert.equal(result.status, 'failed')
  assert.match(result.stderr, /recursive readdir is not allowed/)

  const recursiveSearchSource = "const fs=require('node:fs'); const path=require('node:path'); const hits=[]; const walk=dir=>{ for(const entry of fs.readdirSync(dir,{withFileTypes:true})){ const file=path.join(dir,entry.name); if(entry.isDirectory()) walk(file); else if(fs.readFileSync(file,'utf8').includes('deprecated-package')) hits.push(file); } }; walk('scan'); console.log(JSON.stringify(hits));"
  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', recursiveSearchSource] })
  assert.equal(result.status, 'completed')
  assert(result.stdout.includes('scan/one.txt'))
  assert(result.stdout.includes('scan/nested/two.md'))

  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', "const name='Workbench'; console.log(`hello ${name}`)"] })
  assert.equal(result.status, 'completed')
  assert(result.stdout.includes('hello Workbench'))

  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', "const value='deprecated-package'; console.log(/deprecated-[a-z]+/.test(value))"] })
  assert.equal(result.status, 'completed')
  assert(result.stdout.includes('true'))

  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', "const fs=require('node:fs'); const target=fs.realpathSync('node_modules/.bin/example-cli'); const mode=fs.statSync('node_modules/.bin/example-cli').mode; console.log(JSON.stringify({target,mode}))"] })
  assert.equal(result.status, 'completed')
  assert(result.stdout.includes('example-cli/index.js'))
  assert.match(result.stdout, /\"mode\":\d+/)

  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', "require('node:fs').readFileSync('../outside.txt','utf8')"] })
  assert.equal(result.status, 'failed')
  assert(result.stderr.includes('path traversal'))

  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', "require('node:https')"] })
  assert.equal(result.status, 'failed')
  assert(result.stderr.includes('not allowlisted'))

  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', "require('node:child_process').spawnSync('sh',['-c','echo bad'],{encoding:'utf8',shell:false})"] })
  assert.equal(result.status, 'failed')
  assert(result.stderr.includes('blocked'))

  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', "require('node:child_process').spawnSync('npm',['install'],{encoding:'utf8',shell:false})"] })
  assert.equal(result.status, 'failed')
  assert(result.stderr.includes('blocked'))

  result = await runSafeCommand({ ...exactBase, executable: 'node', args: ['-e', "require('node:fs').writeFileSync('protected.txt','changed')"] })
  assert.equal(result.status, 'failed')
  assert(result.stderr.includes('not allowed'))
  assert.equal(fs.readFileSync(path.join(root, 'protected.txt'), 'utf8'), 'original\n')

  result = await runSafeCommand({ ...exactBase, executable: 'pnpm', args: ['valid'] })
  assert.equal(result.status, 'completed')
  assert.equal((result.details as { resolvedScriptName?: string } | undefined)?.resolvedScriptName, 'valid')

  result = await runSafeCommand({ ...exactBase, executable: 'pnpm', args: ['generatevendor'] })
  assert.equal(result.status, 'completed')
  assert.equal(result.protectedPathsChanged?.length, 0)
  assert(fs.existsSync(path.join(root, 'node_modules/generated/output.txt')))

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
assert(
  runCommandRoute.includes("if (clean.status === 'timed_out' && validationJobOperation === undefined)"),
  'run-command route must normalize only synchronous timed_out results'
)
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
