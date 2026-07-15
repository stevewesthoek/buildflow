#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REQUIRED_RUNTIME_FILES = [
  'scripts/workbench-local-stack.sh',
  'scripts/workbench-detached-service.mjs',
  'scripts/verify-workbench-detached-lifecycle.mjs',
  'scripts/verify-shared-source-boundary.ts'
]
const PACKAGE_MANAGER_BUILTINS = new Set(['add', 'dlx', 'exec', 'install', 'publish', 'remove', 'run'])
const ESLINT_CONFIG_FILES = [
  '.eslintrc',
  '.eslintrc.cjs',
  '.eslintrc.js',
  '.eslintrc.json',
  '.eslintrc.yaml',
  '.eslintrc.yml',
  'eslint.config.cjs',
  'eslint.config.js',
  'eslint.config.mjs'
]
const SOURCE_FILE_PATTERN = /(?:^|[\s"'=])((?:\.\.\/|\.\/)?(?:[A-Za-z0-9_.@-]+\/)*[A-Za-z0-9_.@-]+\.(?:cjs|js|json|mjs|sh|ts|tsx))(?=$|[\s"';&|)])/g

async function exists(candidate) {
  try {
    await fs.access(candidate)
    return true
  } catch {
    return false
  }
}

async function walkPackageManifests(root, directory = root) {
  const manifests = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.buildflow') continue
    const candidate = path.join(directory, entry.name)
    if (entry.isDirectory()) manifests.push(...await walkPackageManifests(root, candidate))
    else if (entry.isFile() && entry.name === 'package.json') manifests.push(candidate)
  }
  return manifests
}

function normalizedRelative(root, candidate) {
  return path.relative(root, candidate).split(path.sep).join('/') || '.'
}

function isGeneratedReference(reference) {
  return reference.includes('node_modules/') || reference.startsWith('dist/') || reference.includes('/dist/') || reference.includes('*') || reference.includes('$')
}

export async function validatePublicScriptClosure(root) {
  const resolvedRoot = path.resolve(root)
  const errors = []

  for (const required of REQUIRED_RUNTIME_FILES) {
    if (!await exists(path.join(resolvedRoot, required))) errors.push(`Public runtime dependency is missing: ${required}`)
  }

  for (const manifestPath of await walkPackageManifests(resolvedRoot)) {
    const manifestRelative = normalizedRelative(resolvedRoot, manifestPath)
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
    const scripts = manifest.scripts || {}

    if (Object.values(scripts).some(command => typeof command === 'string' && /(?:^|[;&|]\s*)next\s+lint(?:\s|$)/.test(command))) {
      const hasEslintConfig = (await Promise.all(ESLINT_CONFIG_FILES.map(file => exists(path.join(path.dirname(manifestPath), file))))).some(Boolean)
      if (!hasEslintConfig) errors.push(`${manifestRelative} runs next lint without an exported ESLint configuration`)
    }

    for (const [scriptName, command] of Object.entries(scripts)) {
      if (typeof command !== 'string') continue

      for (const match of command.matchAll(SOURCE_FILE_PATTERN)) {
        const reference = match[1].replace(/^\.\//, '')
        if (isGeneratedReference(reference)) continue
        const candidate = path.resolve(path.dirname(manifestPath), reference)
        if (!candidate.startsWith(`${resolvedRoot}${path.sep}`) || !await exists(candidate)) {
          errors.push(`${manifestRelative} script ${scriptName} references missing file: ${reference}`)
        }
      }

      const pnpmPattern = /\bpnpm\s+(?:--dir\s+([^\s&;|]+)\s+)?(?:run\s+)?([A-Za-z][A-Za-z0-9:_-]*)/g
      for (const match of command.matchAll(pnpmPattern)) {
        const targetDirectory = match[1]
          ? path.resolve(path.dirname(manifestPath), match[1])
          : path.dirname(manifestPath)
        const targetScript = match[2]
        if (PACKAGE_MANAGER_BUILTINS.has(targetScript)) continue
        const targetManifestPath = path.join(targetDirectory, 'package.json')
        if (!targetManifestPath.startsWith(`${resolvedRoot}${path.sep}`) || !await exists(targetManifestPath)) {
          errors.push(`${manifestRelative} script ${scriptName} targets a missing package: ${match[1] || '.'}`)
          continue
        }
        const targetManifest = JSON.parse(await fs.readFile(targetManifestPath, 'utf8'))
        if (typeof targetManifest.scripts?.[targetScript] !== 'string') {
          errors.push(`${manifestRelative} script ${scriptName} targets missing script ${targetScript} in ${normalizedRelative(resolvedRoot, targetManifestPath)}`)
        }
      }
    }
  }

  return errors
}

async function main() {
  const root = path.resolve(process.argv[2] || process.cwd())
  const errors = await validatePublicScriptClosure(root)
  if (errors.length > 0) {
    for (const error of errors) console.error(error)
    process.exitCode = 1
    return
  }
  console.log(`Public package-script dependency closure passed: ${root}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
