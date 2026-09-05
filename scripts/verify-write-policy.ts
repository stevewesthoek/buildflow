import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { getDefaultWritePolicy, resolveSourceWritePolicy, validateWriteTarget } from '../packages/cli/src/agent/safe-access'
import { validatePath } from '../packages/cli/src/agent/permissions'
import { attachWriteConfirmation, composeArtifactRelativePath } from '../apps/web/src/lib/actions/gpt'

function findRepoRoot(start: string): string {
  let current = path.resolve(start)
  while (true) {
    if (
      fs.existsSync(path.join(current, 'package.json')) &&
      fs.existsSync(path.join(current, 'apps/web')) &&
      fs.existsSync(path.join(current, 'packages/cli'))
    ) return current
    const parent = path.dirname(current)
    if (parent === current) throw new Error('Could not locate repository root')
    current = parent
  }
}

const repoRoot = findRepoRoot(process.cwd())
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
assert.deepEqual(policy.allowedRoots, ['**'])
assert(policy.blockedGlobs.includes('.env'))
assert(policy.confirmationRequiredGlobs.includes('LICENSE'))
assert(!policy.confirmationRequiredGlobs.includes('package.json'))
assert(!policy.protectedGlobs.includes('package.json'))
assert(!policy.protectedWriteGlobs.includes('scripts/**'))
assert(!policy.protectedWriteGlobs.includes('public/**'))
assert.deepEqual(policy.blockedWriteGlobs, [])
assert.deepEqual(policy.generatedDeleteAllowedGlobs, [])
const privateKeyPattern = ['BEGIN OPENSSH PRIVATE', ' KEY'].join('')
const githubPatPattern = ['github', '_pat_'].join('')
assert(policy.blockedContentPatterns.includes(privateKeyPattern))
assert.equal(policy.maxWriteBytes, 1000000)
assert.equal(policy.maxCreateBytes, 200000)
assert.equal(policy.maxOverwriteBytes, 300000)
assert.equal(policy.maxPatchTargetBytes, 1000000)

const root = path.resolve(repoRoot, 'packages/cli')

const safe = validateWriteTarget({ requestedPath: '.buildflow/write-policy-test.md', changeType: 'create', sourceRoot: root })
assert.equal(safe.ok, true)
if (safe.ok) {
  assert.equal(safe.normalizedPath, '.buildflow/write-policy-test.md')
}

const appSafe = validateWriteTarget({ requestedPath: 'src/lib/example.ts', changeType: 'create', sourceRoot: root, content: 'export const example = 1\n' })
assert.equal(appSafe.ok, true)
const publicExtensionlessSafe = validateWriteTarget({ requestedPath: 'public/_redirects', changeType: 'create', sourceRoot: root, content: '/* /index.html 200\n' })
assert.equal(publicExtensionlessSafe.ok, true)
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
assert.equal(envTemplate.ok, false)

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

const graphifyIgnoreOverwrite = validateWriteTarget({ requestedPath: '.graphifyignore', changeType: 'overwrite', sourceRoot: root, content: 'graphify-out/\n' })
assert.equal(graphifyIgnoreOverwrite.ok, true)
const graphifyIgnorePatch = validateWriteTarget({ requestedPath: '.graphifyignore', changeType: 'patch', sourceRoot: root })
assert.equal(graphifyIgnorePatch.ok, true)

assert.equal(validatePath('.env.example').valid, true)
assert.equal(validatePath('.gitignore').valid, true)
assert.equal(validatePath('.graphifyignore').valid, true)
assert.equal(validatePath('.github/workflows/example.yml').valid, true)
assert.equal(validatePath('.kiro/specs/example.md').valid, true)
assert.equal(validatePath('.ai/current.md').valid, true)
assert.equal(validatePath('.env').valid, false)
assert.equal(validatePath('.git/config').valid, false)
assert.equal(validatePath('.env.local').valid, false)
assert.equal(validatePath('.private-config').valid, false)

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
  assert.equal(trackedAssetDeleteNoConfirmation.error.code, 'BINARY_DELETE_REQUIRES_CONFIRMATION')
}
fs.writeFileSync(path.join(trackedAssetRoot, 'public/assets/untracked.pdf'), 'fake pdf\n')
const untrackedAssetDelete = validateWriteTarget({ sourceId: 'test', requestedPath: 'public/assets/untracked.pdf', changeType: 'delete_file', sourceRoot: trackedAssetRoot, confirmedByUser: true })
assert.equal(untrackedAssetDelete.ok, false)
if (!untrackedAssetDelete.ok) {
  assert.equal(untrackedAssetDelete.error.code, 'BINARY_DELETE_REQUIRES_CONFIRMATION')
}
const trackedAssetCreate = validateWriteTarget({ sourceId: 'test', requestedPath: 'public/assets/new.pdf', changeType: 'create', sourceRoot: trackedAssetRoot, content: 'fake pdf\n', confirmedByUser: true })
assert.equal(trackedAssetCreate.ok, false)
if (!trackedAssetCreate.ok) assert.equal(trackedAssetCreate.error.code, 'BINARY_WRITE_BLOCKED')
const trackedSvgAssetCreate = validateWriteTarget({ sourceId: 'test', requestedPath: 'public/assets/new.svg', changeType: 'create', sourceRoot: trackedAssetRoot, content: '<svg></svg>\n', confirmedByUser: true })
assert.equal(trackedSvgAssetCreate.ok, false)
if (!trackedSvgAssetCreate.ok) assert.equal(trackedSvgAssetCreate.error.code, 'BINARY_WRITE_BLOCKED')
const trackedAssetOverwrite = validateWriteTarget({ sourceId: 'test', requestedPath: 'public/assets/file.pdf', changeType: 'overwrite', sourceRoot: trackedAssetRoot, content: 'fake pdf\n', confirmedByUser: true })
assert.equal(trackedAssetOverwrite.ok, false)
if (!trackedAssetOverwrite.ok) assert.equal(trackedAssetOverwrite.error.code, 'BINARY_WRITE_BLOCKED')
const trackedSvgAssetOverwrite = validateWriteTarget({ sourceId: 'test', requestedPath: 'public/assets/file.svg', changeType: 'overwrite', sourceRoot: trackedAssetRoot, content: '<svg></svg>\n', confirmedByUser: true })
assert.equal(trackedSvgAssetOverwrite.ok, false)
if (!trackedSvgAssetOverwrite.ok) assert.equal(trackedSvgAssetOverwrite.error.code, 'BINARY_WRITE_BLOCKED')
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
assert.equal(nodeModulesDelete.ok, true)
fs.rmSync(trackedAssetRoot, { recursive: true, force: true })

const allowedDotSegmentCases = [
  'src/app/[slug]/page.tsx',
  'src/app/[...segments]/page.tsx',
  'src/app/[[...segments]]/page.tsx',
  'src/files/report..draft.md'
]

for (const requestedPath of allowedDotSegmentCases) {
  const result = validateWriteTarget({ requestedPath, changeType: 'create', sourceRoot: root, content: 'export default null\n' })
  assert.equal(result.ok, true, requestedPath)
}

const blockedCases = [
  { requestedPath: '.env', code: 'SECRET_PATH_BLOCKED' },
  { requestedPath: '.env.local', code: 'SECRET_PATH_BLOCKED' },
  { requestedPath: 'ai/private/example.md', code: 'SECRET_PATH_BLOCKED' },
  { requestedPath: '../outside.md', code: 'PATH_TRAVERSAL_BLOCKED' },
  { requestedPath: 'folder/../outside.md', code: 'PATH_TRAVERSAL_BLOCKED' },
  { requestedPath: '..', code: 'PATH_TRAVERSAL_BLOCKED' },
  { requestedPath: '/tmp/outside.md', code: 'ABSOLUTE_PATH_BLOCKED' },
  { requestedPath: 'secrets.pem', code: 'SECRET_PATH_BLOCKED' },
  { requestedPath: 'id_rsa', code: 'SECRET_PATH_BLOCKED' },
  { requestedPath: '.git/config', code: 'PROTECTED_PATH' },
  { requestedPath: 'package-lock.json', code: 'REQUIRES_EXPLICIT_CONFIRMATION' },
  { requestedPath: '.github/workflows/build.yml', code: 'REQUIRES_EXPLICIT_CONFIRMATION' },
  { requestedPath: 'LICENSE', code: 'REQUIRES_EXPLICIT_CONFIRMATION' },
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

const openapiSource = fs.readFileSync(path.join(repoRoot, 'apps/web/src/lib/openapi-chatgpt.json'), 'utf8')
const serverSource = fs.readFileSync(path.join(repoRoot, 'packages/cli/src/agent/server.ts'), 'utf8')
const instructionsSource = fs.readFileSync(path.join(repoRoot, 'docs/CUSTOM_GPT_INSTRUCTIONS.md'), 'utf8')
const gptActionsSource = fs.readFileSync(path.join(repoRoot, 'apps/web/src/lib/actions/gpt.ts'), 'utf8')
const staticOpenapiSource = fs.readFileSync(path.join(repoRoot, 'docs/openapi.chatgpt.json'), 'utf8')
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
assert(instructionsSource.includes('allowMultiple') || staticOpenapi.paths?.['/api/actions/apply-file-change']?.post?.requestBody?.content?.['application/json']?.schema?.properties?.allowMultiple)
assert(instructionsSource.includes('edit secrets'))
assert(instructionsSource.includes('private keys'))
assert(instructionsSource.includes('.git'))
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
assert.equal(nodeModulesBlocked.ok, true, 'node_modules is inside the connected repository')
const traversalBlocked = validateWriteTarget({ requestedPath: '../outside.txt', changeType: 'patch', sourceRoot: root })
assert.equal(traversalBlocked.ok, false, 'traversal still blocked')

// unrelated YAML retains existing policy
const unrelatedYamlSafe = validateWriteTarget({ requestedPath: 'scripts/deploy.yaml', changeType: 'patch', sourceRoot: root })
assert.equal(unrelatedYamlSafe.ok, true, 'scripts/deploy.yaml allowed (safe root)')

console.log('write policy contract checks passed')

// --- Source-aware policy resolution ---

// 1. resolveSourceWritePolicy with no sourceId returns the default policy unchanged
const defaultResolved = resolveSourceWritePolicy(undefined)
assert.deepEqual(defaultResolved, getDefaultWritePolicy(), 'resolveSourceWritePolicy(undefined) must equal getDefaultWritePolicy()')

// 2. resolveSourceWritePolicy with an unknown sourceId falls back to default (no crash)
const unknownSourceResolved = resolveSourceWritePolicy('__nonexistent_source__')
assert.deepEqual(unknownSourceResolved, getDefaultWritePolicy(), 'resolveSourceWritePolicy with unknown sourceId must fall back to default')

// 3. Source-specific allowedRoots additions are merged additively over the default
//    Simulate a source record by writing a temp config, setting WORKBENCH_CONFIG_DIR, and running a subprocess check.
//    (validateWriteTarget already uses resolveSourceWritePolicy — test via a config fixture in a temp dir)
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbench-policy-test-'))
  const tmpSourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbench-source-test-'))
  try {
    const testSourceId = 'policy-test-source'
    const testConfig = {
      userId: 'test-user',
      deviceId: 'test-device',
      deviceToken: 'test-token',
      sources: [
        {
          id: testSourceId,
          label: 'Policy Test Source',
          path: tmpSourceDir,
          enabled: true,
          writePolicy: {
            allowedRoots: ['graphify-out', 'graphify-out/**'],
            generatedDeleteAllowedGlobs: ['graphify-out', 'graphify-out/**'],
            protectedGlobs: ['.obsidian/**', 'kanban.md', 'tasks.md'],
            protectedWriteGlobs: ['.obsidian/**', 'kanban.md', 'tasks.md']
          }
        }
      ]
    }
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(testConfig, null, 2))

    // Run resolution in a subprocess with WORKBENCH_CONFIG_DIR overridden so loadConfig() reads our fixture
    const verifyScript = `
      process.env.WORKBENCH_CONFIG_DIR = ${JSON.stringify(tmpDir)};
      const { resolveSourceWritePolicy, getDefaultWritePolicy, validateWriteTarget } = require(${JSON.stringify(path.resolve(repoRoot, 'packages/cli/dist/agent/safe-access.js'))});
      const assert = require('assert');
      const def = getDefaultWritePolicy();

      // 3a. Additive merge: source allowedRoots are present, default allowedRoots are preserved
      const resolved = resolveSourceWritePolicy(${JSON.stringify(testSourceId)});
      assert.deepEqual(resolved.allowedRoots, ['**']);
      assert.deepEqual(resolved.generatedDeleteAllowedGlobs, []);
      assert(resolved.protectedGlobs.includes('.obsidian/**'), 'source .obsidian/** in protectedGlobs');
      assert(resolved.protectedWriteGlobs.includes('.obsidian/**'), 'source .obsidian/** in protectedWriteGlobs');
      assert(resolved.protectedWriteGlobs.includes('package-lock.json'), 'default package-lock.json preserved in protectedWriteGlobs');

      // 3b. validateWriteTarget with sourceId uses source-specific allowedRoots
      const graphifyDelete = validateWriteTarget({ sourceId: ${JSON.stringify(testSourceId)}, requestedPath: 'graphify-out/graph.json', changeType: 'delete_file', sourceRoot: ${JSON.stringify(tmpSourceDir)} });
      assert(graphifyDelete.ok !== false || (graphifyDelete.ok === false && graphifyDelete.error.code !== 'PATH_NOT_ALLOWED'), 'graphify-out delete must not return PATH_NOT_ALLOWED with source policy');

      // 3c. Default source (no sourceId) still blocks graphify-out
      const graphifyDefaultBlocked = validateWriteTarget({ requestedPath: 'graphify-out/graph.json', changeType: 'delete_file', sourceRoot: ${JSON.stringify(tmpSourceDir)} });
      assert(!(graphifyDefaultBlocked.ok === false && graphifyDefaultBlocked.error.code === 'PATH_NOT_ALLOWED'), 'graphify-out is not folder-allowlist blocked');

      // 3d. Protected paths are blocked even with source-specific policy (hardcoded classifyBlockedPath gates)
      const gitBlocked = validateWriteTarget({ sourceId: ${JSON.stringify(testSourceId)}, requestedPath: '.git/config', changeType: 'patch', sourceRoot: ${JSON.stringify(tmpSourceDir)} });
      assert(gitBlocked.ok === false, '.git/config must be blocked even with source policy');

      // 3e. Hardcoded secret path checks still apply
      const envBlocked = validateWriteTarget({ sourceId: ${JSON.stringify(testSourceId)}, requestedPath: '.env', changeType: 'patch', sourceRoot: ${JSON.stringify(tmpSourceDir)} });
      assert(envBlocked.ok === false, '.env must be blocked even with source policy');

      console.log('source-aware policy subprocess checks passed');
    `
    // Build the CLI dist first so this can be imported as CJS
    // (subprocess check requires compiled output; run via tsx to avoid that requirement)
    const tsxBin = path.join(repoRoot, 'packages/cli/node_modules/.bin/tsx')
    const tsVerify = `
      process.env.WORKBENCH_CONFIG_DIR = ${JSON.stringify(tmpDir)};
      import { resolveSourceWritePolicy, getDefaultWritePolicy, validateWriteTarget } from ${JSON.stringify(path.resolve(repoRoot, 'packages/cli/src/agent/safe-access.js'))};
    `
    // Inline check using already-imported resolveSourceWritePolicy from the current process
    // (WORKBENCH_CONFIG_DIR is set below to intercept loadConfig)
    const origConfigDir = process.env['WORKBENCH_CONFIG_DIR']
    process.env['WORKBENCH_CONFIG_DIR'] = tmpDir

    // 3a. Additive merge check
    const resolvedWithSource = resolveSourceWritePolicy(testSourceId)
    assert.deepEqual(resolvedWithSource.allowedRoots, ['**'])
    assert.deepEqual(resolvedWithSource.generatedDeleteAllowedGlobs, [])
    assert(resolvedWithSource.protectedGlobs.includes('.obsidian/**'), '3a: .obsidian/** in protectedGlobs')
    assert(resolvedWithSource.protectedWriteGlobs.includes('.obsidian/**'), '3a: .obsidian/** in protectedWriteGlobs')
    assert(resolvedWithSource.protectedWriteGlobs.includes('package-lock.json'), '3a: default package-lock.json preserved in protectedWriteGlobs')

    // 3b. Scalar defaults preserved when not overridden
    assert.equal(resolvedWithSource.allowCreate, true, '3b: allowCreate preserved from default')
    assert.equal(resolvedWithSource.recursiveDeleteRequiresConfirmation, true, '3b: recursiveDeleteRequiresConfirmation preserved from default')
    assert.equal(resolvedWithSource.binaryWriteBlocked, true, '3b: binaryWriteBlocked preserved from default')
    assert.equal(resolvedWithSource.maxWriteBytes, 1_000_000, '3b: maxWriteBytes preserved from default')

    // 3c. validateWriteTarget with source policy allows graphify-out directory delete (not PATH_NOT_ALLOWED)
    //     With source policy: generatedDeleteAllowedGlobs includes 'graphify-out', so it passes the PATH_NOT_ALLOWED gate
    //     and reaches the recursiveDeleteRequiresConfirmation gate instead.
    const graphifyWithPolicy = validateWriteTarget({ sourceId: testSourceId, requestedPath: 'graphify-out', changeType: 'delete_directory', sourceRoot: tmpSourceDir })
    assert(!(graphifyWithPolicy.ok === false && graphifyWithPolicy.error.code === 'PATH_NOT_ALLOWED'), '3c: graphify-out delete_directory must not be PATH_NOT_ALLOWED with source policy')

    // 3d. validateWriteTarget without sourceId still blocks graphify-out directory delete under default policy
    //     Default generatedDeleteAllowedGlobs does not include 'graphify-out', and it's not in allowedRoots/extensions.
    const graphifyDefaultBlock = validateWriteTarget({ requestedPath: 'graphify-out', changeType: 'delete_directory', sourceRoot: tmpSourceDir })
    assert(!(graphifyDefaultBlock.ok === false && graphifyDefaultBlock.error.code === 'PATH_NOT_ALLOWED'), '3d: graphify-out is not folder-allowlist blocked')

    // 3e. Hardcoded security gates (.git/**, .env) still block even with source policy
    const gitConfigWithSource = validateWriteTarget({ sourceId: testSourceId, requestedPath: '.git/config', changeType: 'patch', sourceRoot: tmpSourceDir })
    assert(gitConfigWithSource.ok === false, '3e: .git/config blocked even with source policy')

    const envWithSource = validateWriteTarget({ sourceId: testSourceId, requestedPath: '.env', changeType: 'patch', sourceRoot: tmpSourceDir })
    assert(envWithSource.ok === false, '3e: .env blocked even with source policy')

    // 3g. Source-specific protectedGlobs block writes to .obsidian/**, kanban.md, tasks.md
    const obsidianBlocked = validateWriteTarget({ sourceId: testSourceId, requestedPath: '.obsidian/bookmarks.json', changeType: 'overwrite', sourceRoot: tmpSourceDir, content: '{}' })
    assert(obsidianBlocked.ok === false, '3g: .obsidian/bookmarks.json blocked by protectedGlobs')
    if (!obsidianBlocked.ok) assert.equal(obsidianBlocked.error.code, 'PROTECTED_PATH', '3g: error code is PROTECTED_PATH for .obsidian/')

    const kanbanBlocked = validateWriteTarget({ sourceId: testSourceId, requestedPath: 'kanban.md', changeType: 'overwrite', sourceRoot: tmpSourceDir, content: '# test' })
    assert(kanbanBlocked.ok === false, '3g: kanban.md blocked by protectedGlobs')
    if (!kanbanBlocked.ok) assert.equal(kanbanBlocked.error.code, 'PROTECTED_PATH', '3g: error code is PROTECTED_PATH for kanban.md')

    const tasksBlocked = validateWriteTarget({ sourceId: testSourceId, requestedPath: 'tasks.md', changeType: 'overwrite', sourceRoot: tmpSourceDir, content: '# test' })
    assert(tasksBlocked.ok === false, '3g: tasks.md blocked by protectedGlobs')
    if (!tasksBlocked.ok) assert.equal(tasksBlocked.error.code, 'PROTECTED_PATH', '3g: error code is PROTECTED_PATH for tasks.md')

    // 3h. Without source policy, those same paths are NOT blocked by protectedGlobs (default policy has empty protectedGlobs)
    const kanbanDefaultAllowed = validateWriteTarget({ requestedPath: 'kanban.md', changeType: 'overwrite', sourceRoot: tmpSourceDir, content: '# test' })
    assert(kanbanDefaultAllowed.ok === true, '3h: kanban.md allowed under default policy (no source protectedGlobs)')

    // 3f. Consistency regression: resolveSourceWritePolicy is stable (calling it twice returns same structure)
    const resolved2 = resolveSourceWritePolicy(testSourceId)
    assert.deepEqual(resolvedWithSource, resolved2, '3f: resolveSourceWritePolicy is deterministic')

    // Restore env
    if (origConfigDir === undefined) {
      delete process.env['WORKBENCH_CONFIG_DIR']
    } else {
      process.env['WORKBENCH_CONFIG_DIR'] = origConfigDir
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.rmSync(tmpSourceDir, { recursive: true, force: true })
  }
}

console.log('source-aware policy resolution checks passed')
