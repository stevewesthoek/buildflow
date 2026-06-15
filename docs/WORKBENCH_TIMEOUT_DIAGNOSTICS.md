# ProChat Workbench Timeout Diagnostics & Recovery

## Overview

ProChat Workbench (BuildFlow) implements strict end-to-end deadlines to prevent application-side timeouts:

- **Every action has a deterministic deadline** (4s–12s depending on operation)
- **Every request receives a unique ID** (X-Workbench-Request-Id header)
- **Failures return structured JSON** before platform timeout, never plain 504 HTML
- **No response waits until Cloudflare or ChatGPT kills it**

If you encounter a timeout, this guide helps you diagnose whether it's:
1. **Application-side (preventable)** — can be optimized or narrowed
2. **Dependency-side (recoverable)** — requires restart/reconnect
3. **Platform-side (external)** — network or Cloudflare issue

## Current Investigation Summary (2026-06-15)

What had already been implemented:
- GPT-facing route deadlines for the five Custom GPT actions.
- Request IDs on wrapped action responses.
- Abort signals and bounded fetch timeouts for web-to-agent and web-to-relay calls.
- Response-size caps for read-context and transport responses.
- Compact OpenAPI and Custom GPT instructions for five Workbench actions.

What was proven to work before this pass:
- Local and public OpenAPI responses were fast when the web origin was healthy.
- Direct local agent and relay health endpoints responded quickly.
- Cached `graph_context` reads Graphify artifacts only; it does not regenerate Graphify during a GPT request.

What still failed:
- Cloudflare sometimes returned a 504 page with Browser and Cloudflare marked working, and `Host workbench.prochat.tools` marked error. That shape means the edge reached the tunnel path but the host/origin side did not return a valid response.

Earlier assumptions that were incomplete:
- The previous hardening focused on broad actions and route deadlines. The latest failure can also occur when the web origin is stale, missing, restarting, or not reachable by `cloudflared`.
- `pnpm local:restart` did not prove a fully fresh agent, relay image/container, and web build. Use `pnpm local:restart:fresh` for activation after reliability changes.
- Unauthorized action responses were fast but were outside the deadline wrapper, so they did not carry a Workbench request ID. Current code wraps auth for the five GPT actions.

## Live Request Path

```text
Custom GPT
  -> https://workbench.prochat.tools
  -> Cloudflare edge
  -> cloudflared tunnel process on the host
  -> local web origin http://127.0.0.1:3054
  -> Next.js action route
  -> action authentication
  -> withGptActionDeadline
  -> direct local agent http://127.0.0.1:3052 or relay http://127.0.0.1:3053
  -> repository operation
  -> bounded response serialization
  -> web origin
  -> cloudflared
  -> Cloudflare
  -> Custom GPT
```

| Hop | Process/container | Port | Health | Timeout/budget | Source |
|---|---|---:|---|---|---|
| Web origin | `next start` | 3054 | `/api/openapi`, `/api/unified-health` | action deadlines 4s-12s | `apps/web/src/app/api/actions/*/route.ts` |
| Deadline wrapper | Next.js route helper | n/a | request logs | one end-to-end deadline, 250ms transport reserve | `apps/web/src/lib/actions/deadline.ts` |
| Auth | Next.js route helper | n/a | 401 JSON | before downstream contact | `apps/web/src/lib/actionAuth.ts` |
| Agent proxy | web fetch | 3052 | `/health`, `/api/status` | remaining route budget | `apps/web/src/lib/actions/transport.ts` |
| Local agent | Fastify | 3052 | `/health` | command timeout + SIGTERM/SIGKILL cleanup | `packages/cli/src/agent/server.ts`, `packages/cli/src/agent/command-runner.ts` |
| Relay proxy | Docker container `workbench-relay` | 3053 | `/health`, `/ready` | web transport budget, relay pending timeout | `packages/bridge/src/server.ts` |
| Cloudflare tunnel | external `cloudflared` process | n/a | public curl + process check | external | external config, not stored in repo |

The active tunnel configuration is outside the repository. Do not edit or print external tunnel config from repo workflows. Validate it with `pnpm diagnose:workbench-path`; if it points anywhere other than `http://127.0.0.1:3054` or equivalent local web origin, fix the external tunnel configuration manually.

## 504 Classification Workflow

Use `pnpm diagnose:workbench-path` before changing code or tunnel settings. It safely checks:

- `cloudflared` process presence, start command with token-like values redacted, and whether more than one tunnel process appears.
- listeners on ports 3052, 3053, and 3054.
- relay container image, name, Compose project, create time, and start time.
- local web, agent, and relay health.
- canonical public endpoint `https://workbench.prochat.tools`.
- compatibility endpoint `https://buildflow.prochat.tools`.
- `CF-Ray`, `X-Workbench-Request-Id`, content type, status, and response class.

Classification rules:

| Observation | Classification | Next step |
|---|---|---|
| Public request fails, local origin succeeds, and no matching origin request log exists | Cloudflare/tunnel ingress | inspect external tunnel process/config/logs without printing credentials |
| Public request fails, local origin succeeds, and origin has start log but no finish log | origin handler or downstream dependency | use request ID and stage timings |
| Local origin and public endpoint both fail | web/action/agent/relay | restart fresh and inspect service logs |
| Public 504 appears before Workbench route deadline and no request ID exists | tunnel/origin connectivity or stale origin | verify port 3054 listener and cloudflared target |
| Workbench returns JSON with `status:"timeout"` | bounded application timeout | diagnose `diagnostics.phase` and narrow/retry |

Cloudflare HTML alone is not enough evidence. Correlate `CF-Ray`, `X-Workbench-Request-Id`, origin logs, and local health.

## OpenAI Custom GPT Findings (Accessed 2026-06-15)

Official sources checked:
- **Production notes on GPT Actions** — OpenAI Developers, update date not shown. Documents 45-second round-trip action timeout, 100,000-character request/response payload limit, text-only payloads, no custom headers, TLS 1.2+ on port 443, and OpenAPI description length limits.
- **Configuring actions in GPTs** — OpenAI Help Center, updated 24 days ago. Documents authentication, OpenAPI schema, operation IDs, schema import/paste flow, action-domain restrictions, and Preview testing after configuration.
- **Creating and editing GPTs** — OpenAI Help Center, updated 3 days ago. Documents GPT instructions, capabilities, actions, recommended model behavior, Preview testing, and manual Update flow.
- **Troubleshooting GPTs** — OpenAI Help Center, updated 11 days ago. Documents Preview testing, instruction tightening, apps/actions availability, and workspace-domain checks.
- **GPTs in ChatGPT** — OpenAI Help Center, updated 12 days ago. Documents GPT components and that a GPT can use either apps or actions, not both.

Implications:
- Workbench must return well before the published 45-second GPT Actions timeout; current route deadlines stay at 4s-12s.
- Action changes are represented by authentication configuration, OpenAPI schema, operation IDs, and GPT instructions. The GPT editor update is manual.
- Test action changes in Preview after importing schema/instruction changes.
- Actions are not available for Pro mode; the GPT editor model selector only shows non-Pro models that support actions.

## Graphify Navigation Workflow

Graphify is a navigation layer, not source truth.

For an unknown repository area:

1. Use `readBuildFlowContext` with `mode:"graph_context"` to inspect cached Graphify hints and freshness.
2. Treat stale or missing graph data as navigation metadata only.
3. Select likely paths or symbols from the hint.
4. Perform a focused exact read with `read_range`, `read_symbol`, `read_paths`, or `grep_context`.
5. Patch only after exact source verification.

For a known path, skip Graphify and read the path directly. For a known symbol, use exact symbol reading. Never regenerate Graphify during a public GPT action request, never patch from graph evidence alone, and do not fail an exact read only because Graphify is unavailable.

## Fresh Restart Procedure

Use a fresh restart after reliability, timeout, tunnel-origin, or service lifecycle changes:

```bash
pnpm local:restart:fresh
```

That command:

- stops web, agent, and relay;
- verifies ports 3052, 3053, and 3054 are released;
- rebuilds shared and agent packages;
- rebuilds the relay image from current source without deleting volumes;
- removes stale web build output and rebuilds the Next.js production app;
- starts relay, agent, and web in deterministic order;
- verifies local health, public OpenAPI, public status, process/container metadata, and reported commit;
- fails with actionable output if any health check or freshness check fails.

Do not use `docker compose down -v` for reliability work. Persistent relay volumes may contain local state.

Service freshness metadata appears in local health/status payloads:

- web: `/api/unified-health` and authenticated `/api/actions/status`;
- agent: `http://127.0.0.1:3052/health`;
- relay: `http://127.0.0.1:3053/health`.

Safe freshness fields include service role, package version, Git commit, build timestamp, process start timestamp, process ID, web build ID, relay container name, and Compose project. They must not include local filesystem paths, bearer tokens, tunnel credentials, certificates, or private keys.

---

## Request ID Correlation

Every action response includes `X-Workbench-Request-Id` header:

```
X-Workbench-Request-Id: wr_xxxxxxxx_xxxxxx
```

When a timeout occurs:
1. **Note the request ID** from the response header or error message
2. **Check local BuildFlow logs** for that ID (if running locally)
3. **Cross-reference with timing** to identify the failing stage

Example request ID: `wr_1v2c3m_aq5k7z`

The web origin also logs compact JSON events with `tool:"workbench_action_origin"`, `requestId`, `operationId`, `route`, `phase`, elapsed time, remaining budget, and a bounded stage list. These logs do not include bearer tokens or request bodies.

Use the request ID to determine whether a request reached the web origin:
- Public failure has `CF-Ray` but no Workbench request ID and no origin log: Cloudflare/tunnel ingress did not reach the route.
- Public failure has Workbench request ID and matching origin start but no finish: origin handler or downstream dependency hung or crashed.
- Public failure has Workbench structured JSON: bounded Workbench failure; diagnose `diagnostics.phase`.

---

## Action-Level Deadlines

| Action | Deadline | Intended Use | Timeout Behavior |
|--------|----------|--------------|------------------|
| `status` | 4s | Health check | Returns `unavailable` if dependencies unreachable |
| `read-context` | 8s | Exact reads or bounded search | Returns `needs_narrower_scope` if response >256 KB |
| `apply-file-change` | 8s | Single file write/delete/move | Fails fast if write policy rejected or file too large |
| `commit-changes` | 10s | Diff + stage + commit (3 steps) | Fails at first failing step with diagnostics |
| `run-command` | 12s | Fast allowlisted commands | Command is killed if exceeds deadline |

---

## Diagnosing Application-Side Timeouts

### Scenario: `read-context` returns `status: "needs_narrower_scope"`

**Meaning:** Response exceeded 256 KB before deadline was reached.

**Recovery:**
1. Check returned `suggestedNarrowerMode` (e.g., `grep_context`, `read_range`)
2. Use that mode with more specific parameters (fewer files, smaller pattern, fewer lines)
3. Avoid `search_and_read` or `prepare_task_context` for large repos without narrowing first

**Example:**
```json
{
  "ok": false,
  "status": "needs_narrower_scope",
  "error": {
    "code": "BUILDFLOW_RESPONSE_SIZE_EXCEEDED",
    "message": "BuildFlow response exceeded action size budget.",
    "recovery": [
      "Use grep_context with a more specific pattern",
      "Use read_range on a specific file",
      "Reduce the limit parameter"
    ]
  },
  "diagnostics": {
    "requestId": "wr_xxxxxxx_xxxxxx",
    "phase": "response_size_check",
    "responseBytes": 289504,
    "budgetBytes": 262144
  }
}
```

### Scenario: Timeout error with `phase: "agent_request"`

**Meaning:** Web route exceeded deadline while waiting for local agent response.

**Recovery:**
1. Check if local agent is running: `curl http://127.0.0.1:3052/health` (should respond <1s)
2. Check if Docker/OrbStack is running
3. If agent is unavailable, run: `pnpm local:restart:fresh`
4. Retry the action

**Diagnostics in response:**
```json
{
  "ok": false,
  "status": "timeout",
  "requestId": "wr_xxxxxxx_xxxxxx",
  "error": {
    "code": "BUILDFLOW_ACTION_DEADLINE_EXCEEDED",
    "message": "BuildFlow stopped this action before the hosting gateway timed out.",
    "details": "readBuildFlowContext exceeded its 8000ms GPT-facing deadline.",
    "recovery": [
      "Use a narrower read mode such as grep_context or read_range.",
      "Split the task into a smaller request.",
      "Run validation in a separate prompt."
    ]
  },
  "diagnostics": {
    "requestId": "wr_xxxxxxx_xxxxxx",
    "operationId": "readBuildFlowContext",
    "phase": "agent_request",
    "elapsedMs": 7987,
    "deadlineMs": 8000
  }
}
```

### Scenario: `run-command` returns `status: "timed_out"`

**Meaning:** Command process exceeded its timeout and was killed.

**Recovery:**
1. Check the command kind and typical duration
2. For slow commands (type-check, test suites), run in a separate prompt
3. For fast commands that still timeout, the repo may be too large or the command legitimately slow
4. Run a smaller marker variant if available (e.g., `run_package_test_marker` with a specific test)

**Example:**
```json
{
  "ok": false,
  "status": "timeout",
  "error": {
    "code": "BUILDFLOW_COMMAND_TIMEOUT",
    "message": "BuildFlow stopped this command before the GPT action deadline.",
    "details": "type_check_web exceeded 11500ms.",
    "recovery": [
      "Run the type check in a separate prompt after narrowing the change.",
      "Use a smaller validation command.",
      "Inspect partial stdout/stderr before retrying."
    ]
  },
  "commandKind": "type_check_web",
  "elapsedMs": 11483,
  "timeoutMs": 11500,
  "stdout": "... truncated output ...",
  "diagnostics": {
    "requestId": "wr_xxxxxxx_xxxxxx",
    "phase": "command_timed_out",
    "elapsedMs": 11483,
    "deadlineMs": 11500
  }
}
```

---

## Diagnosing Dependency-Side Issues

### Scenario: Status returns `connected: false` and `unavailable` code

**Meaning:** Local agent or relay bridge is not reachable.

**Quick diagnosis:**

1. **Check local agent health:**
   ```bash
   curl -s http://127.0.0.1:3052/health | jq .
   ```
   - If timeout or refuse: agent not running
   - If error: agent crashed or misconfigured

2. **Check relay bridge health (if using relay mode):**
   ```bash
   curl -s http://127.0.0.1:3053/health | jq .
   ```
   - If timeout or refuse: relay not running
   - If error: relay misconfigured

3. **Check Docker/OrbStack:**
   ```bash
   docker ps  # or orbctl/orb ps in OrbStack
   ```

**Recovery:**
```bash
# Rebuild and restart local stack from fresh code
pnpm local:restart:fresh

# Or manually start services
docker-compose up -d   # if using Docker Compose
# or OrbStack equivalent
```

### Scenario: Relay bridge health check returns 503

**Meaning:** Bridge cannot reach the local agent within 2 seconds.

**Recovery:**
1. Check if agent is running: `curl http://127.0.0.1:3052/health`
2. If agent is slow or unresponsive, run `pnpm local:restart:fresh`
3. Check relay-to-agent connectivity and Docker network

---

## Distinguishing Cloudflare/Platform Timeouts

### Recognizing platform timeouts:
- **Status 504** from Cloudflare (usually plain HTML, not JSON)
- **No X-Workbench-Request-Id header** (request never reached BuildFlow routes)
- **No diagnostics** in response body

### If you see plain 504 HTML:
1. **Check Cloudflare status:** https://www.cloudflarestatus.com/
2. **Check public endpoint:** `curl -I https://workbench.prochat.tools/api/openapi`
3. **Run path diagnostics:** `pnpm diagnose:workbench-path`
4. **Check local health independently:**
   - If local tests pass: issue is public endpoint or Cloudflare
   - If local tests fail: local services are down

### Expected behavior:
- Workbench actions that reach the web route return JSON with `requestId` before route deadline.
- If public 504 HTML has no Workbench request ID and no matching origin log, the request did not reach the action route.
- If public 504 HTML has an origin start log but no finish log, the origin or downstream path still has a hang bug.

---

## Local Diagnostic Commands

### Quick health check:
```bash
curl -s http://localhost:3054/api/unified-health | jq '.ok, .service'
```

### Full status with sources (slow if many sources):
```bash
curl -s "http://localhost:3054/api/actions/status?include=all" | jq .
```

Use the status route only with the configured bearer token:

```bash
curl -s http://localhost:3054/api/actions/status \
  -H "Authorization: Bearer $WORKBENCH_ACTION_TOKEN" | jq '.connected, .runtime.service'
```

### Check unified health:
```bash
curl -s http://localhost:3054/api/unified-health | jq .
```

### Test exact read (known file):
```bash
curl -s -X POST http://localhost:3054/api/actions/read-context \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "mode": "read_range",
    "sourceId": "your_source_id",
    "path": "apps/web/package.json",
    "startLine": 1,
    "endLine": 20
  }' | jq '.ok, .diagnostics | {requestId, elapsedMs, phase}'
```

### Monitor request timing:
```bash
# Measure status call
time curl -s http://localhost:3054/api/actions/status | jq '.connected'

# Should complete in <500ms
```

---

## Acceptance Thresholds

### Local development (unloaded machine):
- `status`: p95 < 500 ms
- `read-context` (exact small read): p95 < 1.5 s
- `apply-file-change` (dryRun): p95 < 1 s
- `commit-changes` (small commit): p95 < 3 s
- `run-command` (fast command): p95 < 2 s

### No timeout occurs in repeated local tests:
- Run status 20 times in a row
- Run read-context (grep_context) 10 times on same file
- Run small commit 5 times
- All should complete successfully without timing out

### Public endpoint (prochat.tools):
- No application-generated 504 in 20 sequential calls
- All failures correlate with request ID
- No `phase: "timeout"` responses for well-scoped requests

---

## Prevention Checklist

### If implementing new actions:

- [ ] Deadline enforced via `withGptActionDeadline()`
- [ ] Request ID passed in response headers and diagnostics
- [ ] All transport calls pass deadline signal and deadline-aware timeout
- [ ] Response size validated before returning (cap at 256 KB for reads)
- [ ] Child processes receive abort signal on deadline
- [ ] Errors are structured JSON, never HTML or plain text
- [ ] Timeout behavior documented in OpenAPI schema
- [ ] Example "needs_narrower_scope" guidance provided

### If debugging a timeout:

1. **Collect request ID** from error response or headers
2. **Check phase** in diagnostics (which step failed)
3. **Verify local dependencies** are running and responsive
4. **Narrow the request** if `needs_narrower_scope` was returned
5. **Retry with fresh request** (don't loop the same timeout request)
6. **Escalate to platform** only if local health checks pass and remote test fails

---

## Common Mistakes & Recovery

### Mistake: Retrying the same broad search that timed out
**Recovery:** Use narrower mode recommended in `suggestedNarrowerMode`

### Mistake: Assuming 504 is always application bug
**Recovery:** Check platform status and request ID; if no request ID, issue is upstream

### Mistake: Increasing timeout values to fix slow operations
**Recovery:** Optimize the operation (narrower search, smaller files, fewer results) instead

### Mistake: Running large tests in a single action
**Recovery:** Split tests into separate prompts or use a marker for a specific test

---

## Support & Escalation

If a timeout occurs despite following this guide:

1. **Collect diagnostics:**
   - Request ID
   - Request body (redacted of secrets)
   - Response JSON with diagnostics
   - Local health check results
   - Repo size or file size (if relevant)

2. **Check local logs** (if running locally):
   - Web app logs (port 3054)
   - Agent logs (port 3052)
   - Docker/OrbStack logs

3. **Verify reproduction:**
   - Same request succeeds when narrowed
   - Same request fails consistently with broad scope

4. **Document:**
   - Which action
   - Which mode (if applicable)
   - Which operation reached timeout
   - Typical elapsed time vs. deadline

Then escalate with that information.
