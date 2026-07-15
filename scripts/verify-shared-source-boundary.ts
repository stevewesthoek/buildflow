import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runWorkbenchCommandRequestSchema } from '../packages/shared/dist/index.js'

const root = process.cwd()
const sharedSource = path.join(root, 'packages/shared/src')
const intentionalJavaScript = new Set<string>()

for (const entry of fs.readdirSync(sharedSource, { withFileTypes: true })) {
  assert(entry.isFile(), `Shared src must remain flat: ${entry.name}`)
  const relative = `packages/shared/src/${entry.name}`
  if (entry.name.endsWith('.d.ts') || entry.name.endsWith('.d.ts.map') || entry.name.endsWith('.js.map')) {
    assert.fail(`Generated declaration or sourcemap output is forbidden under Shared src: ${relative}`)
  }
  if (entry.name.endsWith('.js')) {
    const typeScriptTwin = path.join(sharedSource, `${entry.name.slice(0, -3)}.ts`)
    assert(!fs.existsSync(typeScriptTwin), `Generated JavaScript shadows TypeScript under Shared src: ${relative}`)
    assert(intentionalJavaScript.has(entry.name), `Maintained Shared JavaScript requires explicit review and allowlisting: ${relative}`)
  }
}

const webConfig = JSON.parse(fs.readFileSync(path.join(root, 'apps/web/tsconfig.json'), 'utf8'))
const rootConfig = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.base.json'), 'utf8'))
assert.deepEqual(webConfig.compilerOptions?.paths?.['@workbench/shared'], ['../../packages/shared/src/index.ts'])
assert.deepEqual(rootConfig.compilerOptions?.paths?.['@workbench/shared'], ['packages/shared/src/index.ts'])
assert.deepEqual(rootConfig.compilerOptions?.paths?.['@workbench/shared/*'], ['packages/shared/src/*'])

const sharedConfig = JSON.parse(fs.readFileSync(path.join(root, 'packages/shared/tsconfig.json'), 'utf8'))
assert.equal(sharedConfig.compilerOptions?.outDir, 'dist', 'Shared compiler output must remain confined to dist')

const sourceIndex = fs.readFileSync(path.join(sharedSource, 'index.ts'), 'utf8')
const sourceModules = [...sourceIndex.matchAll(/^export \* from ['"]\.\/(.+)['"]$/gm)].map(match => match[1])
assert(sourceModules.includes('workbench-command-contract'), 'Shared TypeScript barrel must export the command contract')

const builtIndexPath = path.join(root, 'packages/shared/dist/index.js')
assert(fs.existsSync(builtIndexPath), 'Build Shared before verifying its source boundary')
const builtIndex = fs.readFileSync(builtIndexPath, 'utf8')
const builtModules = [...builtIndex.matchAll(/__exportStar\(require\("\.\/(.+)"\), exports\);/g)].map(match => match[1])
assert.deepEqual(builtModules, sourceModules, 'Built Shared package root disagrees with its TypeScript barrel')
for (const moduleName of sourceModules) {
  assert(fs.existsSync(path.join(root, 'packages/shared/dist', `${moduleName}.js`)), `Shared build is missing a barrel dependency: ${moduleName}`)
}
assert.equal(typeof runWorkbenchCommandRequestSchema, 'object', 'Built Shared barrel must export runWorkbenchCommandRequestSchema')
assert.equal(typeof runWorkbenchCommandRequestSchema.safeParse, 'function')

console.log('Shared source boundary verification passed')
