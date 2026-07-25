import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(__dirname, '..')
const serverPath = path.join(root, 'packages/cli/src/agent/server.ts')
const source = fs.readFileSync(serverPath, 'utf8')
const routeStart = source.indexOf("fastify.post<{ Body: unknown }>('/api/commands/run'")
const routeEnd = source.indexOf('\n  // Search endpoint', routeStart)

assert.ok(routeStart >= 0, 'CLI run-command route must accept Body: unknown')
assert.ok(routeEnd > routeStart, 'CLI run-command route must be locatable')

const route = source.slice(routeStart, routeEnd)
const parseIndex = route.indexOf('parseRunCommandRouteRequest(request.body)')
const sourceLookupIndex = route.indexOf('getSourcesSafe().find')
const safeRequestIndex = route.indexOf('toSafeCommandRequest(parsed.request, source.path)')
const runSafeIndex = route.indexOf('runSafeCommand(safeRequest)')
const legacyDispatchIndex = route.indexOf("routed.mode === 'legacy'")
const admissionIndex = route.indexOf('executeWithWorkbenchAdmission({')

assert.ok(parseIndex >= 0, 'route must parse legacy and session-aware requests with the typed route adapter')
assert.ok(sourceLookupIndex > parseIndex, 'strict parsing must occur before source lookup')
assert.ok(safeRequestIndex > sourceLookupIndex, 'sourceRoot must be injected only after exact source lookup')
assert.ok(runSafeIndex > safeRequestIndex, 'direct execution must use the normalized safe request')
assert.ok(legacyDispatchIndex > runSafeIndex, 'legacy compatibility must remain an explicit post-parse branch')
assert.ok(admissionIndex > legacyDispatchIndex, 'session-aware requests must pass through admission after the legacy branch')
assert.match(route, /send\(\{ error: routed\.error \}\)/)
assert.match(route, /submitWorkbenchValidationJob\(parsed\.request\)/)
assert.match(route, /getCompactWorkbenchValidationJob\(parsed\.validationJobId, parsed\.sourceId\)/)
assert.match(route, /runControlledWorkflowMigrationCommand\(parsed\.request/)
assert.match(route, /sessionId: routed\.sessionId/)
assert.match(route, /sourceId: parsed\.sourceId/)
assert.match(route, /operation: classifyParsedRunCommandRequest\(parsed\)/)
assert.match(route, /execute: dispatch/)
assert.doesNotMatch(route, /migrationCapabilityUnavailable/)
assert.doesNotMatch(route, /update-workflow|spawn\(|child_process|\.exec\(/)
assert.match(route, /toSafeCommandRequest\(parsed\.request, source\.path\)/)
assert.match(route, /runSafeCommand\(safeRequest\)/)
assert.doesNotMatch(route, /const \{ sourceId, commandKind,[^\n]+\} = request\.body/)
assert.doesNotMatch(route, /sourceRoot:\s*request\./)

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
