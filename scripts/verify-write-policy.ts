import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
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
assert(policy.blockedContentPatterns.includes('BEGIN OPENSSH PRIVATE KEY'))
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
const envTemplate = validateWriteTarget({ requestedPath: '.env.example', changeType: 'create', sourceRoot: root, content: 'API_KEY=<your-api-key>\n' })
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

const artifactSecretPattern = validateWriteTarget({ requestedPath: artifactPath, changeType: 'create', sourceRoot: root, content: 'github_pat_TEST_SHOULD_NOT_WRITE\n' })
assert.equal(artifactSecretPattern.ok, false)
if (!artifactSecretPattern.ok) {
  assert.equal(artifactSecretPattern.error.code, 'SECRET_PATTERN_BLOCKED')
  assert.equal(artifactSecretPattern.requestedPath, artifactPath)
  assert.ok(artifactSecretPattern.normalizedPath.length > 0)
}

const artifactPrivateKey = validateWriteTarget({ requestedPath: artifactPath, changeType: 'create', sourceRoot: root, content: '-----BEGIN OPENSSH PRIVATE KEY-----\nTEST\n-----END OPENSSH PRIVATE KEY-----\n' })
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
assert(openapiSource.includes('dryRun'))
assert(openapiSource.includes('preflight'))
assert(openapiSource.includes('writable'))
assert(openapiSource.includes('writePolicy'))
assert(openapiSource.includes('writeProfile'))
assert(openapiSource.includes('activitySchema'))

console.log('write policy contract checks passed')
