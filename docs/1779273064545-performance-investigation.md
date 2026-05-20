# BuildFlow Custom GPT Performance Investigation

## Problem
Custom GPT usage against BuildFlow can be extremely slow, with user-visible delays, regular errors, and timeouts. The failure mode is unacceptable for agentic repo work because every tool call crosses several boundaries: ChatGPT action planning, OpenAPI schema selection, web action route, optional proxy, relay, local agent, repo IO, response serialization, and model-side parsing of returned JSON.

## Evidence gathered
- Source `buildflow` is enabled, searchable, writable, and indexed.
- The Custom GPT instructions already require explicit source IDs and lean reads, but they did not define a hard latency budget.
- The OpenAPI schema is about 31 KB. That is not the main problem by itself, but it amplifies confusion if operations overlap or payloads are broad.
- The local agent had `READ_FILES_RESPONSE_BUDGET_BYTES = 90_000` and `DEFAULT_READ_FILES_MAX_BYTES_PER_FILE = 12_000`. A single read can therefore return large JSON into the GPT action loop.
- During this investigation, a large exact read of `packages/cli/src/agent/server.ts` stalled, which reproduced the same class of slow/tool-timeout behavior from inside the GPT action loop.
- Agent Mode status is called repeatedly during long jobs. Its compact text limits were still large enough to accumulate unnecessary repeated payload.
- Active context is explicitly called out as a shared dashboard convenience, not authoritative repo scope. Multiple conversations can interact through global active context if a caller relies on it. The GPT instructions and API guards are correct to require explicit `sourceId` or `sourceIds` for repo reads/writes.

## OpenAI Custom GPT Actions guidance applied
Official OpenAI GPT guidance emphasizes clear instructions, testing in Preview, and using Actions for external APIs with well-defined schemas. The performance implication is that the GPT should receive compact, purpose-built action responses and unambiguous operation descriptions. Large action payloads and unclear overlapping tools increase model/tool latency and failure probability.

## Root-cause assessment
The strongest root cause is payload and loop architecture, not one isolated slow function:
1. **Oversized action responses:** read-context could return up to 90 KB, plus route/activity wrappers. This is too large for responsive GPT action loops.
2. **Long multi-call agent loop:** Agent Mode requires repeated inspect/read/write/status/validation calls. Even moderate payload bloat compounds quickly.
3. **Broad repo discovery temptation:** file listing and search/read tools make it easy for the GPT to ask for broad data. If one call returns large or stalls, the whole conversational UX appears frozen.
4. **Shared active context hazard:** multiple conversations can conflict only if they rely on global active context. Explicit `sourceId` avoids this. The design should continue treating active context as dashboard-only convenience.
5. **Layered architecture overhead:** ChatGPT → web → proxy/relay → local agent is sound for secure local access, but it must be fail-fast, compact, and observable. Without strict byte budgets, the architecture becomes fragile.

## Changes made in this pass
- `packages/cli/src/agent/server.ts`
  - Reduced read response budget from 90 KB to 32 KB.
  - Reduced default per-file read size from 12 KB to 6 KB.
  - Added a code comment explaining GPT action latency constraints.
- `packages/cli/src/agent/agent-jobs.ts`
  - Reduced max goal length from 4000 to 3000.
  - Reduced compact job text limit from 700 to 420.
  - Reduced compact list item limit from 240 to 160.
  - Added a code comment explaining repeated GPT Action status payload constraints.
- `docs/CUSTOM_GPT_INSTRUCTIONS.md`
  - Added a latency budget section: prefer 1-3 exact files, 2-6 KB reads, shallow list depth, search-first/read-exact workflow, and diagnostics only for performance debugging.

## Architectural answer
A full architectural replacement is not required yet. The current architecture is defensible because it isolates local repo access behind a relay/agent boundary and enforces explicit source IDs. However, BuildFlow needs an architectural operating principle: **all GPT-facing endpoints must be compact by default, paginated/chunked when needed, fail-fast, and diagnostic-on-demand only.**

The biggest architectural improvement would be to make Agent Mode more asynchronous from the GPT perspective: the GPT should submit a small task, receive an immediate job ID, and poll compact progress/events instead of driving every low-level repo step through chat. The current dashboard-visible job ledger is already a foundation for this, but implementation still depends on the GPT executing each step. That design naturally creates many action round trips.

## Next hardening recommendations
1. Add server-enforced limits to `list_files` and search results that are stricter for GPT action routes than dashboard routes.
2. Add response-size logging/diagnostics with warnings when any GPT action exceeds 16 KB, and hard truncation above 32 KB.
3. Split `readBuildFlowContext` into explicit `readSmallFiles` and `readLargeFileChunk` operations in the OpenAPI schema so the model cannot accidentally request huge reads.
4. Make Agent Mode optionally execute server-side task batches, returning only job progress and compact diffs to GPT.
5. Add action contract tests for response payload size and route duration.
6. Keep using explicit `sourceId`; never rely on active context for repo work across multiple conversations.

## Validation plan
- Run TypeScript type checks for changed packages.
- Validate JSON schema files.
- Inspect git diff and changed paths.
- Regenerate/import GPT schema after instruction or schema changes when applicable.


## Follow-up implementation pass: local server-side Agent Mode preflight

After reviewing the pre-existing dirty tree, the prior work was preserved because it formed a coherent set of improvements: OpenAPI action wording, dashboard Agent Mode visibility, command-runner GitHub push hardening, generated schema updates, and a dashboard API route for agent jobs.

Additional implementation:
- `packages/cli/src/agent/server.ts` now starts deterministic local Agent Mode preflight when a job is created with `autonomyLevel: hands_off_safe`.
- The local agent runs `git_status_short`, package type checks when the corresponding package manifests exist, and JSON schema validation when `docs/openapi.chatgpt.json` exists.
- The GPT receives the job immediately and can poll compact status instead of orchestrating those validation commands itself.
- The job ledger is updated server-side with running/completed/blocked/failed state and compact evidence.
- This intentionally avoids claiming full open-ended implementation without a local model runtime. It offloads deterministic validation and progress bookkeeping first, which is safe and immediately reduces GPT round trips.

Validation evidence for this pass:
- Regenerated `docs/openapi.chatgpt.json` from `/api/openapi` source.
- `type_check_cli`: passed.
- `type_check_web`: passed.
- `validate_json_files docs/openapi.chatgpt.json`: passed.
