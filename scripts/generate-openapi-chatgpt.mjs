#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

// GPT Actions run outside the owner Mac. The imported schema must advertise
// the public tunnel, while LOCAL_DASHBOARD_BASE_URL remains an explicit
// override for local contract tests.
const BASE_URL = process.env.LOCAL_DASHBOARD_BASE_URL || process.env.PUBLIC_BASE_URL || 'https://workbench.prochat.tools'
const OUTPUT_FILE = path.resolve(process.cwd(), 'docs/openapi.chatgpt.json')
const FROM_SOURCE = process.argv.includes('--from-source')

function assertGeneratedSchema(schema) {
  const commitSchema = schema?.paths?.['/api/actions/commit-changes']?.post?.requestBody?.content?.['application/json']?.schema
  if (!Array.isArray(commitSchema?.required) || !commitSchema.required.includes('sessionId')) {
    throw new Error('Generated schema is stale: commitWorkbenchChanges must require an active sessionId')
  }
  const commandContent = schema?.paths?.['/api/actions/run-command']?.post?.requestBody?.content?.['application/json']
  const commandSchema = commandContent?.schema
  const properties = commandSchema?.properties || {}
  if (!Array.isArray(commandSchema?.required) || !['version', 'sessionId', 'command'].every(name => commandSchema.required.includes(name))) {
    throw new Error('Generated schema is stale: strict session-aware command envelope is missing')
  }
  if (properties.version?.enum?.length !== 1 || properties.version.enum[0] !== 2) {
    throw new Error('Generated schema is stale: command envelope version must be exactly 2')
  }
  const commandProperties = properties.command?.properties || {}
  const commandKinds = commandProperties.commandKind?.enum || []
  if (!commandKinds.includes('n8n_workflow_export')) throw new Error('Generated schema is stale: n8n_workflow_export is missing')
  if (!commandKinds.includes('n8n_workflow_migration')) throw new Error('Generated schema is stale: n8n_workflow_migration is missing')
  if (!commandProperties.workflowId) throw new Error('Generated schema is stale: workflowId is missing')
  if (!commandProperties.outputPath) throw new Error('Generated schema is stale: outputPath is missing')
  if (commandProperties.networkAccess?.type !== 'boolean') throw new Error('Generated schema is stale: networkAccess must be boolean')
  const sourceDescription = commandProperties.sourceId?.description || ''
  for (const required of ['sessionId', 'default', 'workspace', 'current', 'repo']) {
    if (!sourceDescription.includes(required)) throw new Error(`Generated schema lacks source-selection guidance: ${required}`)
  }
  if (Object.prototype.hasOwnProperty.call(commandContent, 'examples')) {
    throw new Error('Generated schema must not expose synthetic command examples')
  }
  const migration = commandProperties.migration
  if (!migration || !Array.isArray(migration.oneOf) || migration.oneOf.length !== 3) {
    throw new Error('Generated schema lacks the strict controlled migration phases')
  }
}

async function main() {
  const response = FROM_SOURCE
    ? await (await import('../apps/web/src/app/api/openapi/route.ts')).GET(new Request(`${BASE_URL}/api/openapi`))
    : await fetch(`${BASE_URL}/api/openapi`)
  if (!response.ok) throw new Error(`Failed to fetch schema from ${FROM_SOURCE ? 'source route' : BASE_URL}: ${response.status}`)
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('application/json')) throw new Error(`Expected JSON schema, got ${contentType}`)
  const schema = await response.json()
  assertGeneratedSchema(schema)
  const serialized = `${JSON.stringify(schema)}\n`
  const temporaryFile = `${OUTPUT_FILE}.tmp-${process.pid}`
  fs.writeFileSync(temporaryFile, serialized, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(temporaryFile, OUTPUT_FILE)
  console.log(`Wrote verified ${path.relative(process.cwd(), OUTPUT_FILE)} from ${FROM_SOURCE ? 'source route' : 'live endpoint'} (${Buffer.byteLength(serialized, 'utf8')} bytes)`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
