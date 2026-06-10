# Fast Repo Assistant Optimization Roadmap

## Current Decision

BuildFlow has one GPT-facing direction: Fast Repo Assistant.

ChatGPT does the reasoning and coding. BuildFlow supplies local repo context, guarded writes, targeted validation, and explicit Git operations. BuildFlow does not expose or market a separate agent mode for Custom GPT usage.

## Why This Direction

The dominant latency cost is not local file IO. Local search, reads, and tree listing are fast. The expensive part is repeated Custom GPT action chatter: model reasoning, external action call, response parsing, then more model reasoning.

Therefore the product should optimize for fewer, smaller, clearer actions instead of autonomous loops.

## Target Architecture

```text
Custom GPT
  -> compact 5-action schema
  -> web action adapter
  -> local agent process
  -> deterministic source-scoped repo tools
  -> compact proof back to GPT
```

Core invariants:

- Every repo action carries explicit `sourceId`.
- ChatGPT remains the only reasoning and coding layer.
- BuildFlow returns compact proof, not full state dumps.
- Validation is targeted and only run when useful.
- Commits stage explicit paths only.
- Push only happens when explicitly requested.
- Large work stops with a plan or resume point.
- No local LLM or external model API is made inside GPT-facing actions.

## GPT-Facing Actions

Keep exactly the compact action surface unless a new deterministic macro-action removes more chatter than it adds:

- `getBuildFlowStatus`
- `readBuildFlowContext`
- `applyBuildFlowFileChange`
- `commitBuildFlowChanges`
- `runBuildFlowCommand`

Do not add GPT actions for long-running jobs, polling, server-owned coding loops, or local AI orchestration.

## Fast Workflow

```text
question -> minimal exact read -> answer
small edit -> exact read -> patch -> smallest validation -> optional commit -> stop
large goal -> concise plan -> first safe slice only -> resume point
```

Normal task budget:

- 1 task per response by default
- up to 2 tightly related small tasks when all paths and validations are clear
- hard action budget: 3 BuildFlow actions per response, preferably 1-2
- larger work stops with a resume point instead of continuing the loop

## Implementation Phases

### Phase 1: Remove Conflicting Product Language

Status: implemented in this direction.

- Replace agent-mode and bounded-sequential branding with Fast Repo Assistant.
- Keep ChatGPT as the reasoning/coding layer.
- Document that server-side autonomous loops and polling are not the Custom GPT path.

### Phase 2: Keep The Schema Lean

Status: active.

- Keep the five GPT-facing operations compact.
- Keep OpenAPI descriptions short and direct.
- Reimport schema into the Custom GPT after schema wording changes.

### Phase 3: Reduce Action Chatter

Status: active.

- Use deterministic `prepare_task_context` only when paths are unknown.
- Prefer exact reads over repeated search/read calls.
- Keep `commitBuildFlowChanges` as the single diff/stage/commit action.
- Add only bounded deterministic macro-actions when they remove repeated calls.

### Phase 4: Runtime Metrics

Status: active hardening.

- Record per-action duration, request bytes, response bytes, source ID, mode, and result count.
- Expose a compact diagnostics summary on demand.
- Keep timing details out of normal GPT responses.

### Phase 5: Cached Graphify Navigation

Status: planned. This is an optimization layer, not a redesign.

BuildFlow should consume existing `graphify-out/` artifacts when they are present so the GPT can navigate a repo by structure before falling back to narrower exact reads. Graphify should help answer "where should I look?" It must not answer "what should I patch?" without source verification.

Assessment:

- Graphify output is useful because every connected repo can carry a local `graphify-out/GRAPH_REPORT.md`, `graph.json`, `manifest.json`, and related metadata.
- `GRAPH_REPORT.md` gives a compact human-readable map: summary, freshness, community hubs, god nodes, surprising connections, and likely architectural neighborhoods.
- `graph.json` is useful for local parsing and ranking, but it must never be returned wholesale to the GPT.
- The graph can be stale after edits. BuildFlow must treat it as a cached navigation hint only.
- The source of truth remains exact source reads: `grep_context`, `read_range`, and `read_symbol` before any patch.
- Graph building or `graphify update` must not run inside GPT-facing actions because it can be slow and timeout-prone.

Freshness model:

- Prefer graph metadata that records the commit the graph was built from.
- Compare the graph commit to current `git rev-parse HEAD` when cheap.
- If commit metadata is missing, compare graph artifact modified time to a bounded sample of recent repo file mtimes or the latest commit time.
- Return `fresh`, `stale`, or `unknown`; do not block graph use solely because freshness is unknown.
- If stale, return suggestions with a warning and require exact focused reads before patching.

Target workflow:

```text
unknown area -> graph_context -> suggested files/symbols -> focused read -> answer/patch
known file   -> grep_context/read_range directly
known symbol -> read_symbol directly
patch        -> exact source read required; graph is not enough
```

Boundaries:

- Add `graph_context` as a new `readBuildFlowContext` mode, not a sixth GPT action.
- Use only cached graph artifacts during GPT actions.
- Keep graph_context response below normal action budgets.
- Return suggested next focused reads instead of large graph data.
- If no graph exists, return a compact fallback suggesting `prepare_task_context` or `grep_context`.

### Phase 6: Relay Parity

Status: optional hardening.

- Ensure relay paths proxy the same direct local API contract.
- Avoid duplicate route semantics between relay and direct mode.
- Preserve source isolation in relay request routing.

## Success Criteria

- Normal action responses stay far below 10,000 characters.
- Routine actions do not approach the GPT Action timeout.
- Read-only questions answer after minimal exact context.
- Small edits complete with one read, one patch, one targeted validation, and optional commit.
- Larger work produces a concise progress document and resume point instead of looping.
- The OpenAPI schema contains no autonomous-agent or long-running-polling promises.
- Multi-source tasks remain isolated by explicit source IDs.




### Phase 6: Safe Auto-Commit

Status: planned.

Goal: make BuildFlow smoother after verified edits by optionally committing safe completed slices without requiring the user to remember a separate commit prompt.

Inspiration: `autogit` demonstrates useful workflow ideas such as per-repo opt-in, no-op when there are no changes, pre-commit secret checks, task-derived commit messages, generated commit trailers, and an undo path. BuildFlow should copy the safety patterns, not the exact behavior.

BuildFlow policy:

- Auto-commit must be per-source opt-in.
- Push remains explicit unless a future policy explicitly enables it with confirmation.
- Stage explicit BuildFlow-changed paths only; never use `git add -A`.
- Run a security scan on changed paths before committing.
- Require relevant validation for code/config/schema changes; docs-only changes may skip validation when appropriate.
- Generate concise commit messages from the task goal and changed files.
- Add an identifiable trailer such as `BuildFlow-Auto-Commit: true`.
- Provide an undo workflow only for BuildFlow-created auto commits.
- Never auto-commit `.env`, key, PEM, private, generated build output, or blocked paths.

Initial implementation tasks:

1. Add a per-source `autoCommit` policy with modes such as `off`, `docs_only`, and `after_verified_write`.
2. Track changed paths returned by `applyBuildFlowFileChange` in the action activity/result.
3. Add a deterministic auto-commit decision helper that checks policy, changed paths, validation status, and security scan status.
4. Reuse `commitBuildFlowChanges` internally so commits still stage explicit paths only.
5. Add a secret/security scan gate for the exact changed paths before auto-commit.
6. Add verifier coverage that auto-commit never uses `git add -A`, never auto-pushes, and never bypasses blocked paths.
7. Update Custom GPT instructions so natural-language edit requests can end with a safe auto-commit only when the repo policy allows it.

Exit criteria:

- A completed safe edit can be auto-committed when the source policy allows it.
- The user can still request manual review/no commit.
- Auto-push does not happen by default.
- Commits remain auditable, explicit-path-only, and recoverable.
