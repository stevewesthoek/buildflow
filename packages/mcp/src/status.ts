#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectCodexRegistration, parseConfigureCliArgs } from './configure-codex.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const workbenchRepoRoot = path.resolve(here, '../../..')

try {
  const { projectRoot, profile } = parseConfigureCliArgs(process.argv.slice(2))
  const status = inspectCodexRegistration({
    workbenchRepoRoot,
    targetProjectRoot: projectRoot,
    profile
  })
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`)

  const failures: string[] = []
  if (!status.configured) failures.push(`No valid Workbench MCP registration found in the project config (profile: ${status.profile}).`)
  if (status.configMode !== '0600') failures.push(`Project config mode must be 0600 (found: ${status.configMode ?? 'missing'}).`)
  if (status.credentialMode !== '0600') failures.push(`Credential file mode must be 0600 (found: ${status.credentialMode ?? 'missing'}).`)
  if (status.duplicateCount !== 1) {
    failures.push(
      `Expected exactly 1 Workbench MCP registration but found ${status.duplicateCount} ` +
      `(${status.globalMatchCount} global, ${status.projectMatchCount} project). ` +
      'Remove the global entry from ~/.codex/config.toml and keep only the project-local registration.'
    )
  }

  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`ERROR: ${failure}\n`)
    process.stderr.write(`INFO: availability=${status.availability} (brain=optional, workbench=required)\n`)
    process.exitCode = 1
  }
} catch (error) {
  process.stderr.write(`Workbench MCP status failed: ${error instanceof Error ? error.message : 'unknown error'}\n`)
  process.exitCode = 1
}
