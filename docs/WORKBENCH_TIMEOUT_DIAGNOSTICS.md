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
3. If agent is unavailable, run: `pnpm local:restart`
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
# Restart local stack
pnpm local:restart

# Or manually start services
docker-compose up -d   # if using Docker Compose
# or OrbStack equivalent
```

### Scenario: Relay bridge health check returns 503

**Meaning:** Bridge cannot reach the local agent within 2 seconds.

**Recovery:**
1. Check if agent is running: `curl http://127.0.0.1:3052/health`
2. If agent is slow or unresponsive, restart it
3. Check relay-to-agent connectivity and Docker network

---

## Distinguishing Cloudflare/Platform Timeouts

### Recognizing platform timeouts:
- **Status 504** from Cloudflare (usually plain HTML, not JSON)
- **No X-Workbench-Request-Id header** (request never reached BuildFlow routes)
- **No diagnostics** in response body

### If you see plain 504 HTML:
1. **Check Cloudflare status:** https://www.cloudflarestatus.com/
2. **Check public endpoint:** `curl -I https://buildflow.prochat.tools/api/actions/status`
3. **Check local health independently:**
   - If local tests pass: issue is public endpoint or Cloudflare
   - If local tests fail: local services are down

### Expected behavior:
- BuildFlow actions ALWAYS return JSON with `requestId` before route deadline
- If you see plain 504, it means the route deadline was NOT enforced (bug or external issue)

---

## Local Diagnostic Commands

### Quick health check:
```bash
curl -s http://localhost:3054/api/actions/status | jq '.connected, .runtime'
```

### Full status with sources (slow if many sources):
```bash
curl -s "http://localhost:3054/api/actions/status?include=all" | jq .
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
