# Phase 1: Workbench Action Timeout Analysis

## Request Path Diagram

```
ChatGPT Custom GPT
    ↓
Cloudflare Tunnel (prochat.tools domain)
    ↓
Next.js Web App (port 3054, force-dynamic routes)
    ├─ Route Authentication (checkActionAuth)
    ├─ JSON Body Parse
    ├─ withGptActionDeadline Wrapper
    │  ├─ AbortController + setTimeout(deadlineMs)
    │  ├─ Promise.race([handler, timeoutResponse])
    │  └─ Max wait: deadlineMs before returning structured JSON
    ├─ Action Logic (phase-based execution)
    ├─ fetchWithTimeout → Transport to Backend
    │  ├─ Agent Proxy (direct-agent mode) → port 3052
    │  └─ Relay Bridge (relay-agent mode) → port 3053 → port 3052
    ├─ Response Serialization & Size Validation
    └─ Return NextResponse.json(data, status) BEFORE Cloudflare timeout
    ↓
Cloudflare Tunnel Egress
    ↓
ChatGPT Platform
```

## Action-Level Deadlines (GPT_ACTION_DEADLINES_MS)

| Action | Deadline | Target Use |
|--------|----------|-----------|
| `getBuildFlowStatus` | 4_000 ms | Quick health check |
| `readBuildFlowContext` | 8_000 ms | Focused reads (grep, read_range, read_symbol, small search) |
| `applyBuildFlowFileChange` | 8_000 ms | File write or dry-run |
| `commitBuildFlowChanges` | 10_000 ms | Diff + stage + commit (3 phases) |
| `runBuildFlowCommand` | 12_000 ms | Validation/test commands |

## Current Deadline Implementation

**File:** `apps/web/src/lib/actions/deadline.ts`

### Strengths:
- ✅ Centralized `withGptActionDeadline()` wrapper for all actions
- ✅ `AbortController + Promise.race` enforces hard deadline
- ✅ `deadline.signal` passed to all transport calls
- ✅ `deadline.transportTimeoutMs(maxMs)` reserves safety margin (250 ms)
- ✅ Phase tracking and diagnostics collection
- ✅ Structured timeout response with recovery suggestions
- ✅ Cleanup: `clearTimeout(timer)` in finally block

### Gaps Identified:

**Critical:**
1. **No child process timeout propagation** — `dispatchBuildFlowCommand` receives `timeoutMs` in the command body, but doesn't guarantee child process gets signal before route deadline. Commands may continue running after response is sent.
   - Path: `run-command`, `commit-changes` routes dispatch commands with `{ timeoutMs: X }` but signal is not passed to subprocess layer.

2. **Relay bridge health checks missing timeout** — `apps/web/src/app/api/relay/bridge/health/route.ts` has NO timeout on fetch. Could hang indefinitely.
   - Current: `fetch(`${relayUrl}/health`)` with no signal or timeout.
   - Blocks: relay-agent mode operations until this times out at platform level.

3. **No request ID for correlation** — 504 errors cannot be correlated to application logs. When Cloudflare returns 504, which phase failed?
   - Missing: `X-Workbench-Request-Id` header, request UUID in diagnostics.

4. **Graph context and search may not respect cancellation** — Agent-side operations (search, graphify) may continue after abort signal is sent.
   - Unknown: Agent implementation does not guarantee signal cancellation.

5. **Response size validation only in status route** — `read-context` and other routes do not cap response bytes.
   - Impact: Large responses = slower serialization = higher chance of hitting platform timeout.

6. **Silent error swallowing in relay health** — Error on relay health fetch is caught silently, no diagnostics.
   - Recovery guidance incomplete.

## Transport Layer (fetchWithTimeout)

**File:** `apps/web/src/lib/actions/transport.ts`

### Strengths:
- ✅ `AbortSignal` composition for parent signal + timeout signal
- ✅ Structured timeout error classification (timeout vs. connection error vs. generic)
- ✅ Transport diagnostics collection (fetch/read/parse timing)
- ✅ Proper cleanup of abort listeners

### Gaps:

1. **DEFAULT timeout mismatch** — `REQUEST_TIMEOUT_MS = 12000` is used if no explicit timeout, but:
   - `status` action has 4 s deadline → expects ~3.75 s transport timeout
   - `readContext` has 8 s deadline → expects ~7.75 s transport timeout
   - But status route uses `deadline.transportTimeoutMs(3500)` ✓
   - And read-context uses `deadline.transportTimeoutMs(7500)` ✓
   - **Issue:** If a route forgets to pass `timeoutMs`, it silently falls back to 12 s, exceeding parent deadline.

2. **Response body read has no size cap** — `readJsonResponse()` calls `response.text()` with no limit:
   - Large responses = slow `.text()` + slow `.parse(JSON)` = timeout.
   - No cancellation if response streaming takes too long.

3. **No keep-alive timeout on socket** — Long-lived sockets could linger after response.

## Action Routes Summary

| Route | Deadline | Key Risks |
|-------|----------|-----------|
| `/api/actions/status` | 4 s | ✅ Well-bounded; transport timeout 3.5 s; response budget 8 KB |
| `/api/actions/read-context` | 8 s | 🔴 Broad `search_and_read`/`prepare_task_context` may timeout; no `needs_narrower_scope` for all cases; 7.5 s transport budget |
| `/api/actions/apply-file-change` | 8 s | ✅ Well-scoped; 7.5 s transport; DRY-RUN works fast |
| `/api/actions/commit-changes` | 10 s | 🟡 3-step pipeline (diff/add/commit); no inter-step cancellation; transport budgets: 2.5→3→5 s |
| `/api/actions/run-command` | 12 s | 🟡 Command timeout (`timeoutMs`) sent to agent but not enforced; child process may ignore or continue |

## Context Read Modes & Bounds

**File:** `apps/web/src/app/api/actions/read-context/route.ts` + `gpt.ts`

### Mode Analysis:

**Exact reads (✅ Should be fast):**
- `grep_context`: Pattern match in one file → agent focused-read → expected <2s
- `read_range`: Line range in one file → agent focused-read → expected <2s
- `read_symbol`: Type symbol search in one file → agent focused-read → expected <2s
- `read_paths`: Multiple exact paths, up to 5, each capped 4 KB → agent read → expected <3s

**Narrow searches (✅ Bounded but risky if scope isn't checked):**
- `list_files`: Directory listing, limited to 5 results → agent list → expected <2s
- `search`: Pattern search, limited to 5 results, inline content fallback → agent search → expected <3-5s

**Broad operations (🔴 Timeouts if scope not validated):**
- `search_and_read`: Search + read candidates; limit 5 but candidates may be large files
  - Current guard: `isBroadUnscopedQuery()` rejects plain "all", "repo", "code" etc.
  - **Gap:** Fuzzy queries like "test validation" could still spawn large search if not bounded.
  - **Fix:** Need explicit result-size and search-time budgets.

- `prepare_task_context`: Full task context builder; likely invokes broader search or graph
  - **Gap:** No explicit budget enforcement in read-context route.
  - **Gap:** Unclear if agent has its own bounds.

- `graph_context`: Graphify navigation hints
  - **Gap:** Does not build index synchronously ✓ but response size unbounded.
  - **Gap:** If Graphify cache is stale/missing, fallback cost is not metered.

### OpenAPI Schema Issues (Phase 7 task):

Currently limits:
- `paths`: max 5 items
- `limit`: 1–5 (search/list)
- `maxBytesPerFile`: 1000–4000 (defaults 4000)
- `pattern`: unlimited length (should cap)
- `query`: unlimited length (should cap ~200 chars)

Missing enforcements:
- Total response budget
- Search time budget
- Candidate count before reading

## Critical Findings

### Root Causes of 504 Timeouts:

1. **Broad search operations with no time budget** — If agent search hits every file, response slows down.
2. **Relay bridge unavailability** — Relay health check hangs → all relay-agent mode requests timeout.
3. **Command operations continue after route deadline** — Subprocess doesn't get cancellation.
4. **Large response serialization** — No size validation means large reads slow JSON.stringify.
5. **No request ID correlation** — Cannot debug which phase causes the 504.

### Evidence from Spec:

From task description:
- "One failure involved a broad `search_and_read`."
- "Another failure involved an exact `read_paths` call for five known files." ← Should be <2s; suggests agent or transport issue, not Workbench route.
- "A commit request also previously returned a 504."

→ Suggests timeout is backend service issue OR slow response serialization.

## Recommended Implementation Order

**Phase 2 (Diagnosis):** Add request ID + stage timing to all actions
**Phase 3 (Deadline propagation):** Ensure agent receives abort signal for subprocesses
**Phase 4 (Bound context reads):** Add response size cap + search time budget
**Phase 5 (Relay health):** Add timeout to bridge health check
**Phase 6 (Child process cleanup):** Ensure commands killed before response
**Phase 7 (OpenAPI):** Document bounds in schema; encourage narrower GPT prompts
**Phase 8 (Tests):** Mock timeout scenarios
**Phase 9 (Benchmarks):** Measure p95/p50 latency per mode
**Phase 10 (Docs):** Troubleshooting guide for 504 errors

## Key Files to Modify

- `apps/web/src/lib/actions/deadline.ts` — Add request ID, pass signal to subprocess calls
- `apps/web/src/lib/actions/transport.ts` — Cap response size, add diagnostics
- `apps/web/src/app/api/relay/bridge/health/route.ts` — Add timeout
- `apps/web/src/app/api/actions/read-context/route.ts` — Add response size validation
- `apps/web/src/app/api/actions/search-and-read/route.ts` (if separate) or gpt.ts — Add search budget
- Agent implementation (out of scope for this repo)

---

**Status:** ✅ Phase 1 complete. Ready for Phase 2 diagnostics implementation.
