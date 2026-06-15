#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'

const ROOT = path.resolve(new URL('..', import.meta.url).pathname)
const read = relativePath => fs.readFileSync(path.join(ROOT, relativePath), 'utf8')

function assertIncludes(file, needle, message) {
  assert.ok(read(file).includes(needle), message || `${file} must include ${needle}`)
}

function routeBody(file) {
  const text = read(file)
  assert.ok(text.includes('withGptActionDeadline'), `${file} must use withGptActionDeadline`)
  const wrapperIndex = text.indexOf('withGptActionDeadline')
  const authIndex = text.indexOf('checkActionAuth', wrapperIndex)
  assert.ok(authIndex > wrapperIndex, `${file} must authenticate inside the deadline wrapper`)
  assert.ok(text.includes("deadline.setPhase('authenticate')"), `${file} must record auth phase`)
  assert.ok(text.includes("deadline.markStage('authentication_complete'"), `${file} must record auth completion`)
}

function classifySample({ status, headers = {}, bodyPreview = '', json, error }) {
  if (error) {
    if (/ECONNREFUSED|Connection refused|fetch failed/i.test(error)) return 'connection_refused'
    if (/timed out|AbortError/i.test(error)) return 'socket_timeout'
    return 'network_error'
  }
  const contentType = headers['content-type'] || ''
  const server = headers.server || ''
  if (status === 504 && /text\/html/i.test(contentType) && /cloudflare/i.test(server + bodyPreview)) return 'cloudflare_html_504'
  if (/application\/json/i.test(contentType)) {
    const resultStatus = json?.status
    const code = json?.error?.code || json?.code
    if (resultStatus === 'timeout') return 'workbench_structured_timeout'
    if (resultStatus === 'needs_narrower_scope') return 'workbench_needs_narrower_scope'
    if (code === 'LOCAL_STACK_UNAVAILABLE') return 'origin_unavailable'
    if (status === 401) return 'unauthorized_json'
    return 'structured_json'
  }
  return status >= 500 ? 'origin_or_proxy_error' : 'other'
}

function main() {
  const routes = [
    'apps/web/src/app/api/actions/status/route.ts',
    'apps/web/src/app/api/actions/read-context/route.ts',
    'apps/web/src/app/api/actions/apply-file-change/route.ts',
    'apps/web/src/app/api/actions/commit-changes/route.ts',
    'apps/web/src/app/api/actions/run-command/route.ts'
  ]
  routes.forEach(routeBody)

  assertIncludes('apps/web/src/lib/actions/deadline.ts', 'X-Workbench-Request-Id', 'deadline wrapper must return request IDs')
  assertIncludes('apps/web/src/lib/actions/deadline.ts', 'workbench_action_origin', 'deadline wrapper must log origin events')
  assertIncludes('apps/web/src/lib/actions/deadline.ts', 'stages', 'deadline diagnostics must include stage timeline')
  assertIncludes('apps/web/src/lib/actions/transport.ts', 'readResponseText', 'transport must bound body reads')
  assertIncludes('apps/web/src/lib/actions/transport.ts', 'reader.cancel()', 'oversized response reads must be cancelled')
  assertIncludes('packages/cli/src/agent/command-runner.ts', "signalProcess('SIGTERM')", 'command timeout must terminate process group')
  assertIncludes('packages/cli/src/agent/command-runner.ts', "signalProcess('SIGKILL')", 'command timeout must escalate to SIGKILL')
  assertIncludes('packages/cli/src/agent/graph-context.ts', "freshness.status === 'fresh'", 'graph_context must label freshness')
  assertIncludes('packages/cli/src/agent/graph-context.ts', 'missing_graph_artifacts', 'graph_context must have missing-cache fallback')
  assert.ok(!/execFile\(['"]graphify/.test(read('packages/cli/src/agent/graph-context.ts')), 'graph_context must not run Graphify synchronously')
  assertIncludes('scripts/buildflow-local-stack.sh', 'restart_fresh()', 'fresh restart command must exist')
  assertIncludes('scripts/buildflow-local-stack.sh', 'docker compose build relay', 'fresh restart must rebuild relay image')
  assertIncludes('scripts/buildflow-local-stack.sh', 'pnpm build', 'fresh restart must rebuild packages/web')
  assert.ok(!read('scripts/buildflow-local-stack.sh').includes('down -v'), 'fresh restart must not delete volumes')
  assertIncludes('scripts/diagnose-workbench-path.mjs', 'cloudflare_html_504', 'diagnostic must classify Cloudflare HTML 504')
  assertIncludes('scripts/diagnose-workbench-path.mjs', 'WORKBENCH_ACTION_TOKEN', 'diagnostic may use token from env')
  assert.ok(!/console\.log\(token\)|Authorization.*console/.test(read('scripts/diagnose-workbench-path.mjs')), 'diagnostic must not print token')

  assert.equal(classifySample({
    status: 504,
    headers: { 'content-type': 'text/html', server: 'cloudflare' },
    bodyPreview: '<html><title>504 Gateway Time-out</title></html>'
  }), 'cloudflare_html_504')
  assert.equal(classifySample({
    status: 200,
    headers: { 'content-type': 'application/json' },
    json: { ok: false, status: 'timeout' }
  }), 'workbench_structured_timeout')
  assert.equal(classifySample({ status: 0, error: 'TypeError: fetch failed ECONNREFUSED' }), 'connection_refused')
  assert.equal(classifySample({
    status: 503,
    headers: { 'content-type': 'application/json' },
    json: { ok: false, error: { code: 'LOCAL_STACK_UNAVAILABLE' } }
  }), 'origin_unavailable')

  console.log('Workbench reliability invariants passed')
}

main()
