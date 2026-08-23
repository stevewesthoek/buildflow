import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(__dirname, '..')
const serverPath = path.join(root, 'packages/cli/src/agent/server.ts')
const source = fs.readFileSync(serverPath, 'utf8')
const authorityPath = path.join(root, 'packages/cli/src/agent/portable-mutation-handlers.ts')
const authoritySource = fs.readFileSync(authorityPath, 'utf8')
const routeStart = source.indexOf("fastify.post<{ Body: unknown }>('/api/commands/run'")
const routeEnd = source.indexOf('\n  // Search endpoint', routeStart)

assert.ok(routeStart >= 0, 'CLI run-command route must accept Body: unknown')
assert.ok(routeEnd > routeStart, 'CLI run-command route must be locatable')

const route = source.slice(routeStart, routeEnd)
const authorityStart = authoritySource.indexOf('export async function executeWorkbenchCommandMutation')
const authorityEnd = authoritySource.indexOf('async function apply', authorityStart)
assert.ok(authorityStart >= 0 && authorityEnd > authorityStart, 'shared command authority must be locatable')
const authority = authoritySource.slice(authorityStart, authorityEnd)
const parseIndex = authority.indexOf('parseRunCommandRouteRequest(body)')
const sourceLookupIndex = authority.indexOf('const source = requireEnabledSource(sourceId)')
const safeRequestIndex = authority.indexOf('toSafeCommandRequest(effectiveRequest, source.path)')
const runSafeIndex = authority.indexOf('runSafeCommand({ ...safeRequest, signal: context.signal })')
const legacyDispatchIndex = authority.indexOf("routed.mode === 'legacy'")
const admissionIndex = authority.indexOf('executeWithWorkbenchAdmission({')

assert.match(route, /executeWorkbenchCommandMutation\(request\.body/)
assert.ok(parseIndex >= 0, 'shared authority must parse legacy and session-aware requests with the typed route adapter')
assert.ok(sourceLookupIndex > parseIndex, 'strict parsing must occur before source lookup')
assert.ok(safeRequestIndex > sourceLookupIndex, 'sourceRoot must be injected only after exact source lookup')
assert.ok(runSafeIndex > safeRequestIndex, 'direct execution must use the normalized safe request')
assert.ok(legacyDispatchIndex > runSafeIndex, 'legacy compatibility must remain an explicit post-parse branch')
assert.ok(admissionIndex > legacyDispatchIndex, 'session-aware requests must pass through admission after the legacy branch')
assert.match(authority, /return \{ statusCode: 400, body: \{ error: routed\.error \} \}/)
assert.match(authority, /if \(sessionRunId && parsed\.request\.runId && parsed\.request\.runId !== sessionRunId\)/)
assert.match(authority, /submitWorkbenchValidationJob\(sessionRunId && !parsed\.request\.runId \? \{ \.\.\.parsed\.request, runId: sessionRunId \} : parsed\.request\)/)
assert.match(authority, /getCompactWorkbenchValidationJob\(parsed\.validationJobId, sourceId\)/)
assert.match(authority, /runControlledWorkflowMigrationCommand\(parsed\.request/)
assert.match(authority, /sessionId: sessionId \|\| routed\.sessionId/)
assert.match(authority, /sourceId,/)
assert.match(authority, /operation: classifyParsedRunCommandRequest\(parsed\)/)
assert.match(authority, /execute: dispatch/)
assert.doesNotMatch(authority, /migrationCapabilityUnavailable/)
assert.doesNotMatch(authority, /update-workflow|spawn\(|child_process|\.exec\(/)
assert.match(authority, /toSafeCommandRequest\(effectiveRequest, source\.path\)/)
assert.match(authority, /runSafeCommand\(\{ \.\.\.safeRequest, signal: context\.signal \}\)/)
assert.doesNotMatch(authority, /const \{ sourceId, commandKind,[^\n]+\} = body/)
assert.doesNotMatch(authority, /sourceRoot:\s*body\./)

const cliSourceFiles: string[] = []
function collectTypeScript(current: string): void {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name)
    if (entry.isDirectory()) collectTypeScript(full)
    else if (entry.isFile() && entry.name.endsWith('.ts')) cliSourceFiles.push(full)
  }
}
collectTypeScript(path.join(root, 'packages/cli/src'))
for (const file of cliSourceFiles) {
  const text = fs.readFileSync(file, 'utf8')
  assert.doesNotMatch(text, /from ['"][^'"]*shared\/src\//, `${path.relative(root, file)} must consume @workbench/shared, not Shared source paths`)
}

console.log('CLI runWorkbenchCommand server boundary verification passed')
