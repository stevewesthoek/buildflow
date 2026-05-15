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

run('git', ['init'])
run('git', ['config', 'user.email', 'buildflow@example.test'])
run('git', ['config', 'user.name', 'BuildFlow Test'])
write('src/a.ts', 'export const a = 1\n')
write('src/config.json', '{"ok":true}\n')
write('src/not-json.ts', 'export {}\n')
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

let result = await runSafeCommand({ ...base, commandKind: 'git_add_paths', paths: ['src/a.ts'] })
assert.equal(result.status, 'completed')
result = await runSafeCommand({ ...base, commandKind: 'git_diff_cached_name_only' })
assert.equal(result.status, 'completed')
assert(result.stdout.includes('src/a.ts'))
await expectReject('git_commit rejects secret-looking message', () => runSafeCommand({ ...base, commandKind: 'git_commit', message: 'leak ' + 's' + 'k_live_fake', confirmedByUser: true }))
result = await runSafeCommand({ ...base, commandKind: 'git_commit', message: 'test: add fixture', confirmedByUser: true })
assert.equal(result.status, 'completed')
assert(result.stdout.includes('test: add fixture'))
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

const openapiRoute = fs.readFileSync(path.join(process.cwd(), 'apps/web/src/app/api/openapi/route.ts'), 'utf8')
for (const token of ['git_add_paths', 'git_commit', 'git_push', 'validate_json_files', 'run_package_script', 'run_package_test', 'run_package_test_marker', 'security_scan_paths', 'packageDir', 'scriptName', 'patternSet', 'confirmationToken']) {
  assert(openapiRoute.includes(token), `OpenAPI route missing ${token}`)
}

fs.rmSync(root, { recursive: true, force: true })
console.log('command runner checks passed')
