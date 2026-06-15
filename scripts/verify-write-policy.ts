import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { getDefaultWritePolicy, validateWriteTarget } from '../packages/cli/src/agent/safe-access'
import { validatePath } from '../packages/cli/src/agent/permissions'
import { attachWriteConfirmation, composeArtifactRelativePath } from '../apps/web/src/lib/actions/gpt'

const policy = getDefaultWritePolicy()
assert.equal(policy.allowCreate, true)
assert.equal(policy.allowOverwrite, true)
assert.equal(policy.allowAppend, true)
assert.equal(policy.allowPatch, true)
assert.equal(policy.allowCreateParentDirectories, true)
assert.equal(policy.allowDelete, true)
assert.equal(policy.allowDeleteDirectory, true)
assert.equal(policy.allowMove, true)
assert.equal(policy.allowRename, true)
assert.equal(policy.allowMkdir, true)
assert.equal(policy.allowRmdir, true)
assert.equal(policy.recursiveDeleteRequiresConfirmation, true)
assert.equal(policy.maxRecursiveDeleteFilesWithoutConfirmation, 0)
assert(policy.allowedRoots.includes('src/**'))
assert(policy.allowedRoots.includes('app/**'))
assert(policy.allowedRoots.includes('ai/skills/**'))
assert(policy.allowedRoots.includes('operations/runbooks/**'))
assert(policy.allowedRoots.includes('operations/specs/video-orchestrator/**'))
assert(policy.allowedRoots.includes('operations/specs/**'))
assert(policy.allowedRoots.includes('projects/*'))
assert(policy.allowedRoots.includes('projects/*/**'))
assert(policy.allowedRoots.includes('projects/*/src/**'))
assert(policy.allowedRoots.includes('projects/probot/src/**'))
assert(policy.allowedRoots.includes('services/*/src/**'))
assert(policy.allowedRoots.includes('packages/*/src/**'))
assert(policy.allowedRoots.includes('specs/**'))
assert(policy.allowedRoots.includes('runbooks/**'))
assert(policy.allowedRoots.includes('*.md'))
assert(policy.blockedGlobs.includes('.env'))
assert(policy.confirmationRequiredGlobs.includes('LICENSE'))
assert(!policy.confirmationRequiredGlobs.includes('package.json'))
assert(!policy.protectedGlobs.includes('package.json'))
assert(!policy.protectedWriteGlobs.includes('scripts/**'))
assert(!policy.protectedWriteGlobs.includes('public/**'))
assert(policy.blockedWriteGlobs?.includes('generated/**'))
assert(policy.generatedDeleteAllowedGlobs?.includes('tsconfig.tsbuildinfo'))
const privateKeyPattern = ['BEGIN OPENSSH PRIVATE', ' KEY'].join('')
const githubPatPattern = ['github', '_pat_'].join('')
assert(policy.blockedContentPatterns.includes(privateKeyPattern))
assert.equal(policy.maxWriteBytes, 1000000)
assert.equal(policy.maxCreateBytes, 200000)
assert.equal(policy.maxOverwriteBytes, 300000)
assert.equal(policy.maxPatchTargetBytes, 1000000)

const root = path.resolve(process.cwd(), 'packages/cli')

const safe = validateWriteTarget({ requestedPath: '.buildflow/write-policy-test.md', changeType: 'create', sourceRoot: root })
assert.equal(safe.ok, true)
if (safe.ok) {
  assert.equal(safe.normalizedPath, '.buildflow/write-policy-test.md')
}

const appSafe = validateWriteTarget({ requestedPath: 'src/lib/example.ts', changeType: 'create', sourceRoot: root, content: 'export const example = 1\n' })
assert.equal(appSafe.ok, true)
const aiSkillsSafe = validateWriteTarget({ requestedPath: 'ai/skills/example.md', changeType: 'create', sourceRoot: root, content: '# skill example\n' })
assert.equal(aiSkillsSafe.ok, true)
const aiSkillsNestedSafe = validateWriteTarget({ requestedPath: 'ai/skills/custom/foo/SKILL.md', changeType: 'create', sourceRoot: root, content: '# skill example\n' })
assert.equal(aiSkillsNestedSafe.ok, true)
const aiSecretsBlocked = validateWriteTarget({ requestedPath: 'ai/secrets/example.md', changeType: 'create', sourceRoot: root, content: '# secret example\n' })
assert.equal(aiSecretsBlocked.ok, false)
if (!aiSecretsBlocked.ok) {
  assert.equal(aiSecretsBlocked.error.code, 'SECRET_PATH_BLOCKED')
}
const aiPrivateBlocked = validateWriteTarget({ requestedPath: 'ai/private/example.md', changeType: 'create', sourceRoot: root, content: '# private example\n' })
assert.equal(aiPrivateBlocked.ok, false)
if (!aiPrivateBlocked.ok) {
  assert.equal(aiPrivateBlocked.error.code, 'SECRET_PATH_BLOCKED')
}
const repoAgnosticProjectSafe = validateWriteTarget({ requestedPath: 'projects/example/src/index.ts', changeType: 'create', sourceRoot: root, content: 'export {}\n' })
assert.equal(repoAgnosticProjectSafe.ok, true)
const repoAgnosticServiceSafe = validateWriteTarget({ requestedPath: 'services/api/src/index.ts', changeType: 'create', sourceRoot: root, content: 'export {}\n' })
assert.equal(repoAgnosticServiceSafe.ok, true)
const repoAgnosticPackageSafe = validateWriteTarget({ requestedPath: 'packages/ui/src/index.ts', changeType: 'create', sourceRoot: root, content: 'export {}\n' })
assert.equal(repoAgnosticPackageSafe.ok, true)
const envTemplate = validateWriteTarget({ requestedPath: '.env.example', changeType: 'create', sourceRoot: root, content: 'PLACEHOLDER=<your-api-key>\n' })
assert.equal(envTemplate.ok, true)

assert.equal(composeArtifactRelativePath({ title: 'BuildFlow Action Demo Artifact', folder: '.buildflow', filename: 'x-demo-buildflow-artifact.md' }), '.buildflow/x-demo-buildflow-artifact.md')
assert.equal(composeArtifactRelativePath({ title: 'BuildFlow Action Demo Artifact', folder: 'docs', filename: 'x-demo-buildflow-artifact.md' }), 'docs/x-demo-buildflow-artifact.md')
assert.equal(composeArtifactRelativePath({ title: 'BuildFlow Action Demo Artifact', folder: '.buildflow' }), '.buildflow/buildflow-action-demo-artifact.md')
assert.equal(composeArtifactRelativePath({ title: 'BuildFlow Action Demo Artifact', filename: 'x-demo-buildflow-artifact.md' }), '.buildflow/x-demo-buildflow-artifact.md')

const artifactPath = composeArtifactRelativePath({ title: 'Blocked Secret Pattern Artifact Demo', folder: '.buildflow', filename: 'x-demo-blocked-secret-artifact.md' })
const artifactSafePreflight = validateWriteTarget({ requestedPath: artifactPath, changeType: 'create', sourceRoot: root, content: 'Safe artifact content for policy checks.\n' })
assert.equal(artifactSafePreflight.ok, true)
if (artifactSafePreflight.ok) {
  assert.equal(artifactSafePreflight.normalizedPath, '.buildflow/x-demo-blocked-secret-artifact.md')
}

const artifactSecretPattern = validateWriteTarget({ requestedPath: artifactPath, changeType: 'create', sourceRoot: root, content: `${githubPatPattern}TEST_SHOULD_NOT_WRITE\n` })
assert.equal(artifactSecretPattern.ok, false)
if (!artifactSecretPattern.ok) {
  assert.equal(artifactSecretPattern.error.code, 'SECRET_PATTERN_BLOCKED')
  assert.equal(artifactSecretPattern.requestedPath, artifactPath)
  assert.ok(artifactSecretPattern.normalizedPath.length > 0)
}

const artifactPrivateKey = validateWriteTarget({ requestedPath: artifactPath, changeType: 'create', sourceRoot: root, content: `-----${privateKeyPattern}-----\n` })
assert.equal(artifactPrivateKey.ok, false)
if (!artifactPrivateKey.ok) {
  assert.equal(artifactPrivateKey.error.code, 'SECRET_PATTERN_BLOCKED')
  assert.equal(artifactPrivateKey.requestedPath, artifactPath)
  assert.ok(artifactPrivateKey.normalizedPath.length > 0)
}

const confirmationPayload: Record<string, unknown> = {}
attachWriteConfirmation(confirmationPayload, { confirmedByUser: true, confirmationToken: 'confirm:test:append:scripts/x-demo-confirmation-test.md' })
assert.equal(confirmationPayload.confirmedByUser, true)
assert.equal(confirmationPayload.confirmationToken, 'confirm:test:append:scripts/x-demo-confirmation-test.md')

const confirmationPayloadWithoutToken: Record<string, unknown> = {}
attachWriteConfirmation(confirmationPayloadWithoutToken, { confirmedByUser: false })
assert.equal(confirmationPayloadWithoutToken.confirmedByUser, false)
assert.equal('confirmationToken' in confirmationPayloadWithoutToken, false)

const confirmationTarget = validateWriteTarget({
  sourceId: 'buildflow',
  requestedPath: 'scripts/x-demo-confirmation-test.md',
  changeType: 'create',
  sourceRoot: root,
  content: '# confirmation test\n',
  confirmationToken: 'confirm:buildflow:create:scripts/x-demo-confirmation-test.md'
})
assert.equal(confirmationTarget.ok, true)

assert.equal(validatePath('.env.example').valid, true)
assert.equal(validatePath('.gitignore').valid, true)
assert.equal(validatePath('.github/workflows/example.yml').valid, true)
assert.equal(validatePath('.kiro/specs/example.md').valid, true)
assert.equal(validatePath('.ai/current.md').valid, true)
assert.equal(validatePath('.env').valid, false)
assert.equal(validatePath('.git/config').valid, false)
assert.equal(validatePath('.env.local').valid, false)

const generatedDelete = validateWriteTarget({ requestedPath: 'tsconfig.tsbuildinfo', changeType: 'delete_file', sourceRoot: root })
assert.equal(generatedDelete.ok, true)

const trackedAssetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'buildflow-write-policy-assets-'))
execFileSync('git', ['init'], { cwd: trackedAssetRoot, stdio: 'ignore' })
execFileSync('git', ['config', 'user.email', 'buildflow@example.test'], { cwd: trackedAssetRoot, stdio: 'ignore' })
execFileSync('git', ['config', 'user.name', 'BuildFlow Test'], { cwd: trackedAssetRoot, stdio: 'ignore' })
fs.mkdirSync(path.join(trackedAssetRoot, 'public/assets'), { recursive: true })
fs.writeFileSync(path.join(trackedAssetRoot, 'public/assets/file.pdf'), 'fake pdf\n')
execFileSync('git', ['add', '--', 'public/assets/file.pdf'], { cwd: trackedAssetRoot, stdio: 'ignore' })
execFileSync('git', ['commit', '-m', 'test: add asset'], { cwd: trackedAssetRoot, stdio: 'ignore' })

const trackedAssetDelete = validateWriteTarget({ sourceId: 'test', requestedPath: 'public/assets/file.pdf', changeType: 'delete_file', sourceRoot: trackedAssetRoot, confirmedByUser: true })
assert.equal(trackedAssetDelete.ok, true)
const trackedAssetDeleteNoConfirmation = validateWriteTarget({ sourceId: 'test', requestedPath: 'public/assets/file.pdf', changeType: 'delete_file', sourceRoot: trackedAssetRoot })
assert.equal(trackedAssetDeleteNoConfirmation.ok, false)
if (!trackedAssetDeleteNoConfirmation.ok) {
  assert.equal(trackedAssetDeleteNoConfirmation.error.code, 'PATH_NOT_ALLOWED')
}
fs.writeFileSync(path.join(trackedAssetRoot, 'public/assets/untracked.pdf'), 'fake pdf\n')
const untrackedAssetDelete = validateWriteTarget({ sourceId: 'test', requestedPath: 'public/assets/untracked.pdf', changeType: 'delete_file', sourceRoot: trackedAssetRoot, confirmedByUser: true })
assert.equal(untrackedAssetDelete.ok, false)
if (!untrackedAssetDelete.ok) {
  assert.equal(untrackedAssetDelete.error.code, 'PATH_NOT_ALLOWED')
}
const trackedAssetCreate = validateWriteTarget({ sourceId: 'test', requestedPath: 'public/assets/new.pdf', changeType: 'create', sourceRoot: trackedAssetRoot, content: 'fake pdf\n', confirmedByUser: true })
assert.equal(trackedAssetCreate.ok, false)
if (!trackedAssetCreate.ok) assert.equal(trackedAssetCreate.error.code, 'BINARY_WRITE_BLOCKED')
const trackedAssetOverwrite = validateWriteTarget({ sourceId: 'test', requestedPath: 'public/assets/file.pdf', changeType: 'overwrite', sourceRoot: trackedAssetRoot, content: 'fake pdf\n', confirmedByUser: true })
assert.equal(trackedAssetOverwrite.ok, false)
if (!trackedAssetOverwrite.ok) assert.equal(trackedAssetOverwrite.error.code, 'BINARY_WRITE_BLOCKED')
const docsAssetCreate = validateWriteTarget({ sourceId: 'test', requestedPath: 'docs/assets/new.pdf', changeType: 'create', sourceRoot: trackedAssetRoot, content: 'fake pdf\n', confirmedByUser: true })
assert.equal(docsAssetCreate.ok, false)
if (!docsAssetCreate.ok) assert.equal(docsAssetCreate.error.code, 'BINARY_WRITE_BLOCKED')
const envDelete = validateWriteTarget({ sourceId: 'test', requestedPath: '.env', changeType: 'delete_file', sourceRoot: trackedAssetRoot, confirmedByUser: true })
assert.equal(envDelete.ok, false)
if (!envDelete.ok) assert.equal(envDelete.error.code, 'SECRET_PATH_BLOCKED')
const keyDelete = validateWriteTarget({ sourceId: 'test', requestedPath: 'public/assets/private.key', changeType: 'delete_file', sourceRoot: trackedAssetRoot, confirmedByUser: true })
assert.equal(keyDelete.ok, false)
if (!keyDelete.ok) assert.equal(keyDelete.error.code, 'SECRET_PATH_BLOCKED')
const nodeModulesDelete = validateWriteTarget({ sourceId: 'test', requestedPath: 'node_modules/pkg/file.pdf', changeType: 'delete_file', sourceRoot: trackedAssetRoot, confirmedByUser: true })
assert.equal(nodeModulesDelete.ok, false)
if (!nodeModulesDelete.ok) assert.equal(nodeModulesDelete.error.code, 'PROTECTED_PATH')
fs.rmSync(trackedAssetRoot, { recursive: true, force: true })

const blockedCases = [
  { requestedPath: '.env', code: 'SECRET_PATH_BLOCKED' },
  { requestedPath: '.env.local', code: 'SECRET_PATH_BLOCKED' },
  { requestedPath: 'ai/private/example.md', code: 'SECRET_PATH_BLOCKED' },
  { requestedPath: '../outside.md', code: 'PATH_TRAVERSAL_BLOCKED' },
  { requestedPath: '/tmp/outside.md', code: 'ABSOLUTE_PATH_BLOCKED' },
  { requestedPath: 'secrets.pem', code: 'SECRET_PATH_BLOCKED' },
  { requestedPath: 'id_rsa', code: 'SECRET_PATH_BLOCKED' },
  { requestedPath: '.git/config', code: 'PROTECTED_PATH' },
  { requestedPath: 'node_modules/example.md', code: 'PROTECTED_PATH' },
  { requestedPath: 'package-lock.json', code: 'REQUIRES_EXPLICIT_CONFIRMATION' },
  { requestedPath: '.github/workflows/build.yml', code: 'REQUIRES_EXPLICIT_CONFIRMATION' },
  { requestedPath: 'LICENSE', code: 'REQUIRES_EXPLICIT_CONFIRMATION' },
  { requestedPath: 'dist/output.js', code: 'GENERATED_WRITE_BLOCKED' },
  { requestedPath: 'build/output.js', code: 'GENERATED_WRITE_BLOCKED' }
]

for (const testCase of blockedCases) {
  const result = validateWriteTarget({ requestedPath: testCase.requestedPath, changeType: 'create', sourceRoot: root, content: testCase.content })
  assert.equal(result.ok, false, testCase.requestedPath)
  if (!result.ok) {
    assert.equal(result.error.code, testCase.code, testCase.requestedPath)
    assert.equal(result.requestedPath, testCase.requestedPath)
    assert.ok(result.normalizedPath.length > 0)
  }
}

const openapiSource = fs.readFileSync(path.join(process.cwd(), 'apps/web/src/app/api/openapi/route.ts'), 'utf8')
const serverSource = fs.readFileSync(path.join(process.cwd(), 'packages/cli/src/agent/server.ts'), 'utf8')
const instructionsSource = fs.readFileSync(path.join(process.cwd(), 'docs/CUSTOM_GPT_INSTRUCTIONS.md'), 'utf8')
const gptActionsSource = fs.readFileSync(path.join(process.cwd(), 'apps/web/src/lib/actions/gpt.ts'), 'utf8')
const staticOpenapiSource = fs.readFileSync(path.join(process.cwd(), 'docs/openapi.chatgpt.json'), 'utf8')
const staticOpenapi = JSON.parse(staticOpenapiSource) as {
  paths?: Record<string, any>
}
assert(openapiSource.includes('dryRun'))
assert(openapiSource.includes('confirmedByUser'))
assert(openapiSource.includes('allowMultiple'))
assert(gptActionsSource.includes('preflight'))
assert(gptActionsSource.includes('makeActivity'))
assert(gptActionsSource.includes('withActivity'))
assert(gptActionsSource.includes('writable'))
assert(gptActionsSource.includes('writePolicy'))
assert(gptActionsSource.includes('writeProfile'))
assert(serverSource.includes('allowMultiple?: boolean'))
assert(serverSource.includes('allowMultiple = false'))
assert(serverSource.includes('allowMultiple === true ? original.split(find).join(replace) : original.replace(find, replace)'))
assert(instructionsSource.includes('`allowMultiple` only when replacing every identical match is intended'))
assert(instructionsSource.includes('BuildFlow narration and activity feedback'))
assert(instructionsSource.includes('already tracked static/binary asset'))
assert(staticOpenapi.paths?.['/api/actions/apply-file-change']?.post?.requestBody?.content?.['application/json']?.schema?.properties?.allowMultiple)
assert(staticOpenapi.paths?.['/api/actions/apply-file-change']?.post?.requestBody?.content?.['application/json']?.schema?.properties?.confirmedByUser)
assert(staticOpenapi.paths?.['/api/actions/commit-changes']?.post?.requestBody?.content?.['application/json']?.schema?.properties?.confirmedByUser)

// --- Docker config write policy ---
const dockerPatchRoot = validateWriteTarget({ requestedPath: 'docker-compose.yml', changeType: 'patch', sourceRoot: root, content: 'version: "3"\n' })
assert.equal(dockerPatchRoot.ok, true, 'docker-compose.yml patch allowed')

const dockerNestedPatch = validateWriteTarget({ requestedPath: 'deploy/compose.production.yaml', changeType: 'patch', sourceRoot: root, content: 'services:\n' })
assert.equal(dockerNestedPatch.ok, true, 'nested compose.production.yaml patch allowed')

const dockerfileOverwrite = validateWriteTarget({ requestedPath: 'Dockerfile', changeType: 'overwrite', sourceRoot: root, content: 'FROM node:18\n' })
assert.equal(dockerfileOverwrite.ok, true, 'Dockerfile overwrite allowed')

const dockerignoreAppend = validateWriteTarget({ requestedPath: '.dockerignore', changeType: 'append', sourceRoot: root, content: 'node_modules\n' })
assert.equal(dockerignoreAppend.ok, true, '.dockerignore append allowed')

// delete and move must be confirmation-gated
const dockerDeleteNoConfirm = validateWriteTarget({ requestedPath: 'docker-compose.yml', changeType: 'delete_file', sourceRoot: root })
assert.equal(dockerDeleteNoConfirm.ok, false, 'docker-compose.yml delete requires confirmation')
if (!dockerDeleteNoConfirm.ok) assert.equal(dockerDeleteNoConfirm.error.code, 'REQUIRES_EXPLICIT_CONFIRMATION')

const dockerMoveNoConfirm = validateWriteTarget({ requestedPath: 'Dockerfile', changeType: 'move', sourceRoot: root })
assert.equal(dockerMoveNoConfirm.ok, false, 'Dockerfile move requires confirmation')
if (!dockerMoveNoConfirm.ok) assert.equal(dockerMoveNoConfirm.error.code, 'REQUIRES_EXPLICIT_CONFIRMATION')

// staging and commit path (patch) allowed
const dockerStagingPatch = validateWriteTarget({ sourceId: 'buildflow', requestedPath: 'docker-compose.yml', changeType: 'patch', sourceRoot: root })
assert.equal(dockerStagingPatch.ok, true, 'docker-compose.yml staging/commit path allowed')

// secrets and protected paths stay blocked
const envInDockerBlocked = validateWriteTarget({ requestedPath: '.env.production', changeType: 'patch', sourceRoot: root })
assert.equal(envInDockerBlocked.ok, false, '.env.production still blocked')
const pemBlocked = validateWriteTarget({ requestedPath: 'server.pem', changeType: 'patch', sourceRoot: root })
assert.equal(pemBlocked.ok, false, 'server.pem still blocked')
const gitConfigBlocked = validateWriteTarget({ requestedPath: '.git/config', changeType: 'patch', sourceRoot: root })
assert.equal(gitConfigBlocked.ok, false, '.git/config still blocked')
const nodeModulesBlocked = validateWriteTarget({ requestedPath: 'node_modules/foo/index.js', changeType: 'patch', sourceRoot: root })
assert.equal(nodeModulesBlocked.ok, false, 'node_modules still blocked')
const traversalBlocked = validateWriteTarget({ requestedPath: '../outside.txt', changeType: 'patch', sourceRoot: root })
assert.equal(traversalBlocked.ok, false, 'traversal still blocked')

// unrelated YAML retains existing policy
const unrelatedYamlSafe = validateWriteTarget({ requestedPath: 'scripts/deploy.yaml', changeType: 'patch', sourceRoot: root })
assert.equal(unrelatedYamlSafe.ok, true, 'scripts/deploy.yaml allowed (safe root)')

console.log('write policy contract checks passed')
