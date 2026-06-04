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
- up to 3 tightly related small tasks when all paths and validations are clear
- never more than 5

## Implementation Phases

### Phase 1: Remove Conflicting Product Language

Status: implemented in this direction.

- Replace agent-mode and bounded-sequential branding with Fast Repo Assistant.
- Keep ChatGPT as the reasoning/coding layer.
- Document that server-side autonomous loops and polling are not the Custom GPT path.

### Phase 2: Keep The Schema Lean

Status: active.

- Keep the six GPT-facing operations compact.
- Keep OpenAPI descriptions short and direct.
- Reimport schema into the Custom GPT after schema wording changes.

### Phase 3: Reduce Action Chatter

Status: active.

- Use deterministic `prepare_task_context` only when paths are unknown.
- Prefer exact reads over repeated search/read calls.
- Keep `commitBuildFlowChanges` as the single diff/stage/commit action.
- Add only bounded deterministic macro-actions when they remove repeated calls.

### Phase 4: Runtime Metrics

Status: next useful hardening.

- Record per-action duration, request bytes, response bytes, source ID, mode, and result count.
- Expose a compact diagnostics summary on demand.
- Keep timing details out of normal GPT responses.

### Phase 5: Relay Parity

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
