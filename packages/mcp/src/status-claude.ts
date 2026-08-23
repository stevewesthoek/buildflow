#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assessClaudeRegistration, inspectClaudeRegistration, parseConfigureCliArgs } from './configure-claude.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const workbenchRepoRoot = path.resolve(here, '../../..')

try {
  const { projectRoot, profile } = parseConfigureCliArgs(process.argv.slice(2))
  const status = inspectClaudeRegistration({
    workbenchRepoRoot,
    targetProjectRoot: projectRoot,
    profile
  })
  const assessment = assessClaudeRegistration(status)
  process.stdout.write(`${JSON.stringify({ ...status, operational: assessment.operational, warnings: assessment.warnings }, null, 2)}\n`)

  for (const warning of assessment.warnings) process.stderr.write(`WARN: ${warning}\n`)
  if (!assessment.operational) {
    for (const failure of assessment.failures) process.stderr.write(`ERROR: ${failure}\n`)
    process.stderr.write(`INFO: availability=${status.availability} (brain=optional, workbench=required)\n`)
    process.exitCode = 1
  }
} catch (error) {
  process.stderr.write(`Workbench MCP Claude Code status failed: ${error instanceof Error ? error.message : 'unknown error'}\n`)
  process.exitCode = 1
}
