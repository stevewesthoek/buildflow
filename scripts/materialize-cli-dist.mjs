import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageRoot = path.join(repositoryRoot, 'packages', 'cli')
const compiledRoot = path.join(packageRoot, 'dist', 'packages', 'cli', 'src')
const runtimeRoot = path.join(packageRoot, 'dist')
const mcpSourceRoot = path.join(repositoryRoot, 'packages', 'mcp', 'dist')
const mcpRuntimeRoot = path.join(runtimeRoot, 'packages', 'mcp', 'dist')
const mcpPackageRoot = path.join(repositoryRoot, 'packages', 'mcp')
const sharedPackageRoot = path.join(repositoryRoot, 'packages', 'shared')

if (!fs.existsSync(compiledRoot)) throw new Error(`Compiled CLI tree is missing: ${compiledRoot}`)
if (!fs.existsSync(mcpSourceRoot)) throw new Error(`Compiled MCP tree is missing: ${mcpSourceRoot}`)
for (const entry of fs.readdirSync(compiledRoot, { withFileTypes: true })) {
  fs.cpSync(path.join(compiledRoot, entry.name), path.join(runtimeRoot, entry.name), { recursive: true, force: true })
}
fs.mkdirSync(mcpRuntimeRoot, { recursive: true })
for (const entry of fs.readdirSync(mcpSourceRoot, { withFileTypes: true })) {
  fs.cpSync(path.join(mcpSourceRoot, entry.name), path.join(mcpRuntimeRoot, entry.name), { recursive: true, force: true })
}
function readPackageJson(packageRoot) {
  return JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
}

function resolveDependencyPackage(sourcePackageRoot, dependencyName) {
  const dependencyParts = dependencyName.split('/')
  let searchRoot = fs.realpathSync(sourcePackageRoot)
  while (true) {
    const candidate = path.join(searchRoot, 'node_modules', ...dependencyParts)
    if (fs.existsSync(candidate)) return fs.realpathSync(candidate)
    const parentRoot = path.dirname(searchRoot)
    if (parentRoot === searchRoot) break
    searchRoot = parentRoot
  }

  const requireFromPackage = createRequire(path.join(sourcePackageRoot, 'package.json'))
  try {
    const entrypoint = requireFromPackage.resolve(dependencyName)
    let packageRoot = path.dirname(entrypoint)
    while (packageRoot !== path.dirname(packageRoot)) {
      if (fs.existsSync(path.join(packageRoot, 'package.json'))) return fs.realpathSync(packageRoot)
      packageRoot = path.dirname(packageRoot)
    }
  } catch (error) {
    throw new Error(`Runtime dependency is missing: ${dependencyName} from ${sourcePackageRoot}`, { cause: error })
  }
  throw new Error(`Runtime dependency package metadata is missing: ${dependencyName} from ${sourcePackageRoot}`)
}

function materializePackageDependencies(sourcePackageRoot, targetPackageRoot, activePackages = new Set()) {
  const realSourcePackageRoot = fs.realpathSync(sourcePackageRoot)
  if (activePackages.has(realSourcePackageRoot)) return

  const packageJson = readPackageJson(realSourcePackageRoot)
  const dependencyNames = Object.keys(packageJson.dependencies || {})
  const nextActivePackages = new Set(activePackages)
  nextActivePackages.add(realSourcePackageRoot)
  const targetNodeModules = path.join(targetPackageRoot, 'node_modules')
  fs.mkdirSync(targetNodeModules, { recursive: true })

  for (const dependencyName of dependencyNames) {
    const source = resolveDependencyPackage(realSourcePackageRoot, dependencyName)
    const target = path.join(targetNodeModules, dependencyName)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (fs.existsSync(target) && fs.realpathSync(target) === source) continue
    fs.cpSync(source, target, {
      recursive: true,
      force: true,
      dereference: true,
      filter: candidate => path.basename(candidate) !== 'node_modules'
    })
    materializePackageDependencies(source, target, nextActivePackages)
  }
}
materializePackageDependencies(mcpPackageRoot, path.join(runtimeRoot, 'packages', 'mcp'))
materializePackageDependencies(sharedPackageRoot, path.join(runtimeRoot, 'packages', 'shared'))
process.stdout.write(`CLI runtime tree materialized: ${runtimeRoot}\n`)
