#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

const BASE_URL = process.env.LOCAL_DASHBOARD_BASE_URL || 'http://127.0.0.1:3054'
const OUTPUT_FILE = path.resolve(process.cwd(), 'docs/openapi.chatgpt.json')
const FROM_SOURCE = process.argv.includes('--from-source')

function assertGeneratedSchema(schema) {
  const commandContent = schema?.paths?.['/api/actions/run-command']?.post?.requestBody?.content?.['application/json']
  const commandSchema = commandContent?.schema
  const properties = commandSchema?.properties || {}
  const commandKinds = properties.commandKind?.enum || []
  if (!commandKinds.includes('n8n_workflow_export')) throw new Error('Generated schema is stale: n8n_workflow_export is missing')
  if (!commandKinds.includes('n8n_workflow_migration')) throw new Error('Generated schema is stale: n8n_workflow_migration is missing')
  if (!properties.workflowId) throw new Error('Generated schema is stale: workflowId is missing')
  if (!properties.outputPath) throw new Error('Generated schema is stale: outputPath is missing')
  if (properties.networkAccess?.type !== 'boolean') throw new Error('Generated schema is stale: networkAccess must be boolean')
  const sourceDescription = properties.sourceId?.description || ''
  for (const required of ['getWorkbenchStatus', 'include=sources', 'default', 'workspace', 'current', 'repo']) {
    if (!sourceDescription.includes(required)) throw new Error(`Generated schema lacks source-selection guidance: ${required}`)
  }
  const examples = commandContent?.examples || {}
  const genericExample = examples.repositoryStatusCheck?.value
  const workflowExample = examples.workflowExportConfirmation?.value
  if (genericExample?.sourceId !== 'workbench-example-source' || genericExample?.commandKind !== 'git_status_short') {
    throw new Error('Generated schema lacks the explicit generic source-scoped command example')
  }
  if (workflowExample?.sourceId !== 'workflow-example-source' || workflowExample?.commandKind !== 'n8n_workflow_export') {
    throw new Error('Generated schema lacks the synthetic workflow export example')
  }
  const migrationExample = examples.controlledMigrationPrepare?.value
  if (migrationExample?.sourceId !== 'migration-example-source' || migrationExample?.commandKind !== 'n8n_workflow_migration') {
    throw new Error('Generated schema lacks the synthetic controlled migration example')
  }
  if (examples.controlledMigrationExecute?.value?.migration?.phase !== 'execute' || examples.controlledMigrationStatus?.value?.migration?.phase !== 'status') {
    throw new Error('Generated schema lacks synthetic controlled migration execute/status examples')
  }
  const migration = properties.migration
  if (!migration || !Array.isArray(migration.oneOf) || migration.oneOf.length !== 3) {
    throw new Error('Generated schema lacks the strict controlled migration phases')
  }
  const placeholderSources = new Set(['default', 'workspace', 'current', 'repo'])
  for (const [name, example] of Object.entries(examples)) {
    const sourceId = typeof example?.value?.sourceId === 'string' ? example.value.sourceId.toLowerCase() : ''
    if (placeholderSources.has(sourceId)) throw new Error(`Generated schema example ${name} uses forbidden placeholder sourceId ${sourceId}`)
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
