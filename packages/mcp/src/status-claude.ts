#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectClaudeRegistration, parseConfigureCliArgs } from './configure-claude.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const workbenchRepoRoot = path.resolve(here, '../../..')

try {
  const { projectRoot, profile } = parseConfigureCliArgs(process.argv.slice(2))
  const status = inspectClaudeRegistration({
    workbenchRepoRoot,
    targetProjectRoot: projectRoot,
    profile
  })
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`)

  const failures: string[] = []
  if (!status.configured) failures.push(`No valid Workbench MCP registration found in Claude local scope (profile: ${status.profile}).`)
  if (status.claudeJsonMode !== '0600') failures.push(`~/.claude.json mode must be 0600 (found: ${status.claudeJsonMode ?? 'missing'}).`)
  if (status.credentialMode !== '0600') failures.push(`Credential file mode must be 0600 (found: ${status.credentialMode ?? 'missing'}).`)
  if (status.userMatchCount > 0) {
    failures.push(
      `Found ${status.userMatchCount} Workbench definition(s) at user scope in ~/.claude.json. ` +
      'Remove with `claude mcp remove workbench -s user` to avoid shadowing the local-scope registration.'
    )
  }
  if (status.localMatchCount > 1) {
    failures.push(
      `Found ${status.localMatchCount} Workbench definitions in local scope (expected 1). ` +
      'Remove duplicates from ~/.claude.json projects entry.'
    )
  }

  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`ERROR: ${failure}\n`)
    process.stderr.write(`INFO: availability=${status.availability} (brain=optional, workbench=required)\n`)
    process.exitCode = 1
  }
} catch (error) {
  process.stderr.write(`Workbench MCP Claude Code status failed: ${error instanceof Error ? error.message : 'unknown error'}\n`)
  process.exitCode = 1
}
