# Graphify Context Integration Plan

Status: planned.  
Product direction: Fast Repo Assistant.  
Scope: improve navigation and reduce broad search loops by consuming cached Graphify artifacts.

## Problem

BuildFlow is fast when the GPT knows exactly which file or symbol to read. It becomes slow when the GPT has to discover where to look across a repo. Repeated broad search/read actions increase action chatter, increase timeout risk, and can push the ChatGPT UI into long "talking to BuildFlow" waits.

Graphify can help with this discovery step because connected repos now include `graphify-out/` artifacts in their root. These artifacts give BuildFlow a cached structural map of the repo. The map can guide the GPT to better focused reads.

## Non-Goals

- Do not redesign BuildFlow.
- Do not add a sixth Custom GPT action.
- Do not run `graphify`, `graphify update`, or other graph builds inside GPT-facing actions.
- Do not treat Graphify as absolute truth.
- Do not patch files from graph evidence alone.
- Do not introduce agent mode, polling, local LLMs, Codex workers, OpenAI API calls, or server-owned implementation loops.

## Graphify Role

Graphify is a cached navigation layer.

Use it to answer:

- What area of the repo is likely relevant?
- Which files should be inspected first?
- Which symbols or communities might matter?
- What exact focused read should the GPT perform next?

Do not use it to answer:

- What is the exact current source text?
- Is a patch safe?
- Did validation pass?
- Is the graph guaranteed fresh?

## Proposed Mode

Add one new `readBuildFlowContext` mode:

```json
{
  "mode": "graph_context",
  "sourceId": "buildflow",
  "query": "GPT action deadline timeout transport",
  "limit": 8
}
```

This preserves the existing 5-operation Custom GPT schema. It adds capability under the existing read action.

## Output Shape

Return compact navigation, not graph data dumps:

```json
{
  "mode": "graph_context",
  "sourceId": "buildflow",
  "graphAvailable": true,
  "freshness": {
    "status": "stale",
    "builtFromCommit": "8e47f7b2",
    "currentCommit": "...",
    "basis": "commit"
  },
  "matchedCommunities": [
    "Action Deadlines & Auth",
    "Action Transport"
  ],
  "suggestedFiles": [
    "apps/web/src/lib/actions/deadline.ts",
    "apps/web/src/lib/actions/transport.ts"
  ],
  "suggestedSymbols": [
    "executeAction",
    "buildActionErrorEnvelope"
  ],
  "nextActions": [
    {
      "mode": "read_symbol",
      "path": "apps/web/src/lib/actions/transport.ts",
      "symbol": "executeAction"
    },
    {
      "mode": "grep_context",
      "path": "apps/web/src/app/api/actions/read-context/route.ts",
      "pattern": "needsNarrowerScope"
    }
  ],
  "warning": "Graph may be stale. Verify with exact source reads before patching."
}
```

## Freshness Logic

Freshness is useful if it is cheap and bounded. Implement only simple checks.

Priority order:

1. Read Graphify metadata containing the built commit if available.
2. Compare built commit with current `git rev-parse HEAD`.
3. If commit metadata is missing, compare graph artifact modified time against the latest commit time.
4. If both are unavailable, return `status: "unknown"`.

Do not recursively scan the repo for all mtimes inside a GPT-facing action. A full mtime walk can become the same broad-work problem Graphify is meant to avoid.

Freshness statuses:

- `fresh`: built commit equals current HEAD, or graph mtime is newer than latest commit time.
- `stale`: built commit differs from current HEAD, or graph mtime predates latest commit time.
- `unknown`: metadata is missing or cannot be checked cheaply.

Stale graphs remain usable for navigation, but every response must state that exact reads are required before patching.

## Phase 0: Assessment And Fixtures

Goal: understand real graph artifacts without changing runtime behavior.

Status: assessment started. BuildFlow's own `graphify-out/` confirms the basic artifact shape. The registered `brain` source did not expose `graphify-out/GRAPH_REPORT.md` at its source root during this pass, so implementation must tolerate missing graph artifacts and return a compact fallback.

Observed BuildFlow artifact fields:

- `GRAPH_REPORT.md` includes summary counts, graph freshness, built commit short hash, community hubs, god nodes, and relationship highlights.
- `graph.json` is a NetworkX-style JSON document with top-level `directed`, `multigraph`, `graph`, `nodes`, and edges/links later in the file.
- `graph.json` nodes include useful fields such as `label`, `file_type`, `source_file`, `source_location`, `_origin`, `community`, `norm_label`, and `id`.
- `manifest.json` maps repo-relative paths to `mtime`, `ast_hash`, and `semantic_hash`, but can be large and should not be read wholesale during a GPT action.
- Hidden/intermediate Graphify files such as `.graphify_analysis.json`, `.graphify_labels.json`, scheduler data, and cache files may exist locally but should not be required for v1.

Research notes:

- Graphify's public README documents `graph.html`, `GRAPH_REPORT.md`, and `graph.json` as the main generated artifacts.
- Recent Graphify release notes say `graph.json` records the git commit and `GRAPH_REPORT.md` shows the short hash, supporting commit-based freshness as the preferred cheap check.
- Graphify recommends committing `graphify-out/` and using hooks/updates outside the assistant's normal response path; BuildFlow should follow that pattern and never build graphs during GPT actions.

Remaining tasks:

1. Inspect one larger repo that actually exposes `graphify-out/` at the registered source root.
2. Document exact commit metadata fields in `graph.json` once observed.
3. Add small sample fixtures if tests are practical.
4. Confirm no graph artifact contains secrets before exposing excerpts.

Exit criteria:

- Known artifact fields are documented.
- Missing graph artifacts return a compact fallback.
- A parser design can be implemented without loading huge output into GPT responses.

## Phase 1: Cached Graph Detector

Status: implemented.

Goal: safely detect Graphify artifacts for a source.

Implemented tasks:

1. Added local helper to resolve `graphify-out/` paths inside a source root.
2. Detects `GRAPH_REPORT.md`, `graph.json`, and `manifest.json`.
3. Returns metadata: exists, file sizes, mtimes, bounded report sections, and report line count.
4. Adds freshness helper using `GRAPH_REPORT.md` built commit plus current HEAD, with latest-commit-time fallback.
5. Does not parse full graph yet.
6. Missing graph returns a compact fallback and suggested next read mode.

Exit criteria:

- Metadata lookup is bounded and avoids full graph JSON parsing.
- Missing graph returns a compact fallback.

## Phase 2: Report-Based Graph Context

Status: partially implemented; next fine-tuning is active.

Goal: ship a useful first version without parsing the full JSON graph.

Implemented tasks:

1. Added `readBuildFlowContext` mode `graph_context`.
2. Reads bounded sections from `GRAPH_REPORT.md`:
   - Summary
   - Graph Freshness
   - Community Hubs
   - God Nodes
   - limited matching lines for query terms
3. Returns matched communities, freshness, graph artifact metadata, and graph warnings.
4. Keeps response under the normal action budget.
5. Updated OpenAPI route, generated schema, GPT instructions, docs, and verifier.

Benchmark findings from first live pass:

- `graph_context` on BuildFlow returned in about 73ms and surfaced relevant hubs such as Action Deadlines & Auth, Action Transport, Action Error Handling, and GPT Action Verification.
- Graph-guided `grep_context` on `apps/web/src/lib/actions/transport.ts` for `executeAction` returned in about 4ms.
- Missing graph fallback on `brain` returned in about 2ms and did not block the workflow.
- `graph_context` on `prochattools-prochat-qa-memory` returned in about 38ms with fresh commit metadata.

Immediate fine-tuning tasks:

1. Replace placeholder `nextActions` with concrete suggestions derived from report matches and god nodes where possible.
2. Extract likely symbols from backticked report entries such as ``executeAction()`` and return `read_symbol` suggestions only when a TypeScript-looking source file is known.
3. Extract likely file paths from report lines and return concrete `grep_context` suggestions using the strongest query term or symbol.
4. Keep generic fallback `nextActions` only when no concrete path or symbol can be inferred.
5. Add verifier coverage so `graph_context` never returns placeholder-only suggestions when concrete evidence exists.

Natural-language GPT behavior requirement:

The user should not need to remember special Graphify prompts. Custom GPT instructions must teach BuildFlow to translate normal natural-language requests into the optimized pattern automatically:

```text
unknown repo area -> graph_context -> one focused exact read -> answer or propose next patch
known file        -> focused read directly
known symbol      -> read_symbol directly
patch request     -> verify exact source before apply-file-change
```

This behavior must be part of the GPT instructions, not something the user has to ask for explicitly.

Exit criteria:

- Broad architectural questions can use `graph_context` before grep/search.
- Known file/symbol questions still skip graph and use focused reads directly.
- `nextActions` prefer concrete file/symbol suggestions over placeholders.
- The Custom GPT automatically optimizes natural-language user requests into small BuildFlow action plans.

## Phase 3: Bounded graph.json Parser

Goal: improve ranking without returning huge graph data.

Tasks:

1. Parse `graph.json` locally with a strict file-size ceiling or streaming approach.
2. Extract only fields needed for ranking: node id/name/type/path/community and edge source/target/type/confidence.
3. Match query terms against node names, file paths, communities, and edge labels.
4. Return top N files/symbols/communities only.
5. Enforce response byte budget and timeout deadline.

Exit criteria:

- `graph_context` can suggest files/symbols more accurately than report-only mode.
- Large graph files do not produce large GPT responses.

## Phase 4: Dashboard/CLI Freshness Workflow

Goal: update graphs outside GPT actions.

Tasks:

1. Add dashboard indicator for Graphify availability and freshness.
2. Add optional manual action to run or document `graphify update .` outside GPT Actions.
3. Consider post-commit or local scheduled update instructions, not a GPT action loop.
4. Document that stale graphs are acceptable for navigation but not proof.

Exit criteria:

- Users know when a graph is stale.
- Graph refresh does not block Custom GPT action responses.

## Phase 5: Verification And Guardrails

Goal: prevent drift and regression.

Tasks:

1. Extend `verify:gpt-actions` to check:
   - exactly 5 operations remain exposed
   - `graph_context` is a read mode, not a new action
   - docs say Graphify is cached navigation only
   - docs forbid graph builds inside GPT actions
   - docs require exact focused reads before patching
2. Add type checks and JSON validation to the implementation PR.
3. Keep Custom GPT instructions within budget.

Exit criteria:

- Docs, schema, and code agree.
- Known bad patterns are explicitly blocked.

## Custom GPT Usage Guidance

Use graph first only when the location is unknown:

```text
Unknown area: graph_context -> read_symbol/grep_context -> answer or patch
Known file: grep_context/read_range directly
Known symbol: read_symbol directly
Patch: exact source read required before apply-file-change
```

If graph is missing or stale:

```text
Use graph suggestions only as hints. Verify with focused exact reads before editing.
```

## Acceptance Criteria

- BuildFlow remains a Fast Repo Assistant.
- The GPT action surface remains exactly 5 operations.
- Graphify never runs inside GPT-facing actions.
- `graph_context` returns compact suggestions and next focused reads.
- Freshness is checked cheaply and reported honestly.
- Stale graphs are useful but never treated as proof.
- Broad search loops are reduced for repos with graph artifacts.
- Exact source reads remain mandatory before patches.
