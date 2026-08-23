import { randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const BIN_NAMES = Object.freeze(['workbench', 'buildflow'])

function requireRegularFile(path, label) {
  let info
  try {
    info = lstatSync(path)
  } catch {
    throw new Error(`${label} must be a non-empty regular non-symlink file: ${path}`)
  }
  if (info.isSymbolicLink() || !info.isFile() || info.size === 0) {
    throw new Error(`${label} must be a non-empty regular non-symlink file: ${path}`)
  }
}

function atomicWrite(path, source, mode) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, source, { flag: 'wx', mode })
    chmodSync(temporary, mode)
    renameSync(temporary, path)
    chmodSync(path, mode)
  } finally {
    try { unlinkSync(temporary) } catch {}
  }
}

export function materializeCliBins({ distRoot, packageJsonPath }) {
  const binRoot = join(distRoot, 'bin')
  mkdirSync(binRoot, { recursive: true, mode: 0o755 })
  requireRegularFile(packageJsonPath, 'CLI package metadata')
  const emittedPackageRoot = join(distRoot, 'packages/cli')
  mkdirSync(emittedPackageRoot, { recursive: true, mode: 0o755 })
  atomicWrite(join(emittedPackageRoot, 'package.json'), readFileSync(packageJsonPath), 0o644)

  return BIN_NAMES.map(name => {
    const compiled = join(distRoot, 'packages/cli/src/bin', `${name}.js`)
    requireRegularFile(compiled, `compiled ${name} entrypoint`)

    const output = join(binRoot, `${name}.js`)
    const relativeTarget = relative(binRoot, compiled).split(sep).join('/')
    const source = `#!/usr/bin/env node\nrequire(${JSON.stringify(relativeTarget.startsWith('.') ? relativeTarget : `./${relativeTarget}`)})\n`
    atomicWrite(output, source, 0o755)
    return output
  })
}

function main(argv) {
  if (argv.length > 1) throw new Error('usage: node scripts/materialize-cli-bin.mjs [dist-root]')
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const distRoot = resolve(argv[0] ?? join(root, 'packages/cli/dist'))
  const outputs = materializeCliBins({ distRoot, packageJsonPath: join(root, 'packages/cli/package.json') })
  process.stdout.write(`CLI bins materialized: ${outputs.join(', ')}\n`)
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) main(process.argv.slice(2))
