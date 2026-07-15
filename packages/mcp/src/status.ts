#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectCodexRegistration, parseProjectRootArgument } from './configure-codex.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const workbenchRepoRoot = path.resolve(here, '../../..')

try {
  const status = inspectCodexRegistration({
    workbenchRepoRoot,
    targetProjectRoot: parseProjectRootArgument(process.argv.slice(2))
  })
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`)
  if (!status.configured || status.duplicateCount !== 1 || status.configMode !== '0600' || status.credentialMode !== '0600') {
    process.exitCode = 1
  }
} catch (error) {
  process.stderr.write(`Workbench MCP status failed: ${error instanceof Error ? error.message : 'unknown error'}\n`)
  process.exitCode = 1
}
