#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'

const ROOT = process.cwd()
const PRIVATE_ALLOWLIST_PATH = path.join(ROOT, 'packages/public-export/config/allowlist.json')
const SEARCH_ROOTS = [
  'README.md',
  'CONTRIBUTING.md',
  'DESIGN.md',
  'COMMERCIAL-LICENSING.md',
  'TRADEMARKS.md',
  'SECURITY.md',
  'package.json',
  'docs',
  'apps',
  'packages',
  'scripts'
]
const IGNORED_DIRS = new Set(['node_modules', '.next', 'dist', 'build', 'out', 'coverage', '.git', '.turbo', '.cache', 'graphify-out', 'node-compile-cache'])
const ALLOWED_FILES = new Set([
  path.normalize('README.md'),
  path.normalize('CONTRIBUTING.md'),
  path.normalize('COMMERCIAL-LICENSING.md'),
  path.normalize('docs/product/README.md'),
  path.normalize('public/docs/product/README.md'),
  path.normalize('TRADEMARKS.md'),
  path.normalize('SECURITY.md'),
  path.normalize('docs/product/public-scope.md'),
  path.normalize('docs/product/local/feature-scope.md'),
  path.normalize('docs/product/beta-release-gate.md'),
  path.normalize('docs/product/roadmap.md'),
  path.normalize('docs/openapi.chatgpt.json'),
  path.normalize('apps/web/src/app/api/openapi/route.ts')
])
const SELF_FILE = path.normalize('scripts/audit-public-scope.mjs')

const RULES = makeRules()

const FILE_EXTENSIONS = new Set(['.md', '.js', '.mjs', '.ts', '.tsx', '.sh', '.json', '.yaml', '.yml'])

async function getSearchRoots() {
  try {
    const allowlist = JSON.parse(await fs.readFile(PRIVATE_ALLOWLIST_PATH, 'utf8'))
    if (allowlist?.schemaVersion === 1 && Array.isArray(allowlist.entries)) {
      return [...new Set(allowlist.entries.map(entry => String(entry.source || '').trim()).filter(Boolean))]
    }
  } catch {
    // Generated public snapshots intentionally do not include private export controls.
  }
  return SEARCH_ROOTS
}

async function main() {
  const findings = []
  const searchRoots = await getSearchRoots()
  for (const root of searchRoots) {
    await walk(path.join(ROOT, root), findings)
  }

  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(`${finding.file}:${finding.line}: ${finding.term}`)
    }
    process.exit(1)
  }
}

function makeRules() {
  const exact = (text) => new RegExp(text.split('').map((ch) => escapeRegExpChar(ch)).join(''), 'i')
  return [
    ['buildflow managed', /buildflow managed/i],
    ['managed endpoint', /managed endpoints?/i],
    ['managed relay', /managed relay/i],
    ['managed dashboard', /managed dashboard/i],
    ['saas', /\bsaas\b/i],
    ['paid', /\bpaid\b/i],
    ['pricing', /\bpricing\b/i],
    ['billing', /\bbilling\b/i],
    ['subscription', /\bsubscription\b/i],
    ['commercial', /\bcommercial\b/i],
    ['hosted account', /hosted accounts?/i],
    ['hosted product', /hosted product/i],
    ['pro saas', /pro\s+saas/i],
    ['pro features', /pro features?/i],
    ['team workspaces', /team workspaces?/i],
    [exact(['buildflow', 'prochat', 'tools'].join('.')), exact(['buildflow', 'prochat', 'tools'].join('.'))],
    [exact(['prochat', 'tools', 'api'].join('/')), exact(['prochat', 'tools', 'api'].join('/'))],
    ['dokploy', /\bdokploy\b/i],
    ['cloudflare', /\bcloudflare\b/i],
    ['private roadmap', /private roadmap/i],
    ['sales strategy', /sales strategy/i],
    ['customer onboarding', /customer onboarding/i],
    ['managed execution', /managed execution/i]
  ]
}

function escapeRegExpChar(ch) {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch
}

async function walk(currentPath, findings) {
  try {
    const stat = await fs.stat(currentPath)
    if (stat.isDirectory()) {
      const entries = await fs.readdir(currentPath, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue
        await walk(path.join(currentPath, entry.name), findings)
      }
      return
    }

    const rel = path.relative(ROOT, currentPath)
    if (path.normalize(rel) === SELF_FILE) return
    if (ALLOWED_FILES.has(path.normalize(rel))) return

    if (!FILE_EXTENSIONS.has(path.extname(currentPath))) return

    const text = await fs.readFile(currentPath, 'utf8')
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      for (const [term, regex] of RULES) {
        if (regex.test(line)) {
          findings.push({ file: rel, line: i + 1, term })
          break
        }
      }
    }
  } catch {
    // Missing paths are fine; just skip them.
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
