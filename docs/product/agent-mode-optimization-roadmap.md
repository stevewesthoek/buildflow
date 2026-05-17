# Agent Mode Optimization Roadmap

## Research Baseline

Official GPT Actions constraints that shape BuildFlow:

- GPT Actions have a 45 second round-trip timeout.
- Request and response payloads must stay below 100,000 characters.
- `x-openai-isConsequential: true` forces ChatGPT to ask for confirmation.
- Action responses should return compact raw data instead of natural-language prose.
- OpenAPI operation and parameter descriptions should be short and direct.

Sources:
- OpenAI GPT Actions production notes: `https://developers.openai.com/api/docs/actions/production`
- OpenAI GPT Actions configuration guide: `https://help.openai.com/en/articles/9442513-configuring-actions-in-gpts`
- OpenAI latency optimization guide: `https://developers.openai.com/api/docs/guides/latency-optimization`

## Current Bottlenecks Found

1. Agent Mode start was marked consequential, which made ChatGPT ask for confirmation by design.
2. Custom GPT instructions still contained legacy "do not push unless asked" guidance.
3. Agent job status calls returned full roadmap state by default.
4. The web action wrapper did not forward roadmap progress updates to the local agent.
5. The dashboard still presents BuildFlow as a source dashboard instead of an Agent Mode cockpit.
6. Several docs still describe commit/push as confirmation-gated even though the desired workflow is validated auto-finalization.
7. The action schema exposes useful but non-core surfaces that compete with the single Agent Mode mental model.

## Target Architecture

BuildFlow should be a thin, fast control plane for autonomous local repo work:

```text
Custom GPT
  -> compact action schema
  -> web action proxy
  -> local agent
  -> source-scoped repo read/write/command engine
  -> compact status/proof back to GPT
  -> commit/push
  -> next task
```

Core invariants:

- Every repo action carries explicit `sourceId` or `sourceIds`.
- Agent Mode is the primary workflow; dashboard source management exists only to support Agent Mode.
- The GPT receives compact proof, not full state dumps.
- The agent stores full state locally and returns compact views by default.
- Commit and push happen automatically after validation passes.
- The loop stops only for true blockers: no access, protected paths, live secrets, destructive confirmation, unavailable stack, or repeated validation failure needing a user choice.

## Implementation Phases

### Phase 1: Remove Contradictions

Status: implemented.

- Make Agent Mode start non-consequential.
- Default Agent Mode to `autoCommit: true` and `autoPush: true`.
- Remove "ask before commit/push" language from Custom GPT instructions.
- Update OpenAPI descriptions to match autonomous commit/push.
- Update Agent Mode docs.

### Phase 2: Compact the Control Plane

Status: implemented.

- Return compact AgentJob state by default.
- Keep full job state available only with `full: true`.
- Forward progress fields from the web action wrapper to the agent.
- Keep instructions under a compact, agent-mode-only policy.

### Phase 3: Reduce Action Chatter

Status: next.

- Add a single `advanceBuildFlowAgentJob` action that accepts one step result and returns the next compact task.
- Add a `finishBuildFlowTask` action that performs final validation, explicit staging, commit, push, log capture, and job update in one server-side operation.
- Keep lower-level read/write/command actions available for execution, but make the Agent Mode schema emphasize the loop actions.

### Phase 4: Dashboard Agent Cockpit

Status: next.

- Replace the source-first dashboard header with current Agent Mode job state.
- Show active source, active task, validation state, commit/push state, and blocker state first.
- Move source management into a supporting panel.
- Add a compact live activity timeline keyed by job id.
- Add a "stuck reason" panel that maps failures to concrete recovery actions.

### Phase 5: Performance Instrumentation

Status: next.

- Record per-action duration, request bytes, response bytes, and upstream duration to a local rolling metrics file.
- Add a dashboard performance strip for p50/p95 action latency and largest payloads.
- Add a `diagnose_performance` summary that ranks bottlenecks by elapsed time and bytes.

### Phase 6: Relay Hardening

Status: next.

- Ensure relay command proxy uses compact responses for Agent Mode endpoints.
- Preserve per-conversation/source isolation in relay request routing.
- Add request id, job id, source id, and compact timing headers for every proxied action.

## Success Criteria

- A broad Agent Mode request can run through task, validation, handoff update, commit, push, and next task without asking "should I commit/push?"
- Normal Agent Mode action responses stay far below 10,000 characters.
- No routine action should approach the 45 second GPT Action timeout.
- The dashboard's first screen shows Agent Mode execution state, not generic source management.
- The OpenAPI schema stays below 50,000 characters and contains no contradictory commit/push instructions.
- Multi-source tasks remain isolated by explicit source ids.
