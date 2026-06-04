# Custom GPT Performance Root Cause And Fast Repo Assistant Architecture

Date: 2026-05-29

## Final Conclusion

BuildFlow's slow behavior is not caused by local file IO. Local search, reads, and tree listing are fast. The slow behavior comes from repeated Custom GPT action turns: model reasoning before an action, a synchronous HTTP action call, model reasoning after the result, and then another action.

BuildFlow has one GPT-facing product direction: **Fast Repo Assistant**.

ChatGPT does the reasoning and coding. BuildFlow provides the local execution layer: explicit source selection, deterministic context prep, exact reads, guarded writes, targeted validation, and explicit Git operations.

BuildFlow will not use the OpenAI API, Responses API, Agents SDK, local AI, or a separate model runtime for coding inside GPT-facing actions.

## Optimized Architecture

```text
Custom GPT
  -> compact 5-action OpenAPI schema
  -> BuildFlow web action adapter
  -> local BuildFlow service
  -> deterministic source index, exact reads, guarded writes, targeted validation, explicit commits
```

## What Works

Fast repo assistance works when the GPT keeps action chatter low:

1. lock the explicit source once
2. prepare or read exact context
3. answer, or apply one small bounded change
4. run the smallest useful validation only when needed
5. optionally commit explicit paths
6. stop with a concise result or resume point

Custom GPT Actions do not give BuildFlow a reliable way to stream live progress into the ChatGPT message while a single action is running. The product therefore makes progress visible by requiring short narration before each action and a compact evidence summary after each action result. Long-running work must be split into smaller conversation slices instead of hidden inside one request.

Recommended task budget:

- default: 1 task per response
- up to 2 tightly related small tasks when paths and validation are clear
- hard action budget: 3 BuildFlow actions per response, preferably 1-2
- larger work: plan first, complete only the first safe slice, then stop with a resume point

## What Does Not Work

Do not build or document these as the Custom GPT path:

- autonomous coding modes
- long-running server-side implementation loops
- job polling from the GPT
- local LLM calls inside GPT Actions
- OpenAI API / Responses API / Agents SDK runtimes
- unrestricted shell access
- large status snapshots
- repeated broad search/read loops

Those approaches increase latency or contradict the product decision that ChatGPT itself is the reasoning and coding layer.

## Local AI Decision

Local AI was tested with realistic context-ranking prompts and failed the GPT-facing latency budget. Even when fail-closed, it added code, docs, warmup state, and operational complexity without reliable benefit.

Decision: keep local AI out of the GPT-facing path.

`readBuildFlowContext` mode `prepare_task_context` remains deterministic source-index context prep only. It returns likely files and an exact read plan without calling a local model.

## Current Optimizations

- Custom GPT schema is 5 operations.
- Custom GPT instructions are compact, repo-assistant oriented, and action-budgeted.
- Default read budget is compact.
- Search/list limits default narrow.
- `grep_context`, `read_range`, and `read_symbol` keep large-file inspection bounded.
- File-specific `search_and_read` degrades to focused grep output instead of huge full-file context.
- `prepare_task_context` collapses broad search/read discovery into one deterministic planning call.
- `commitBuildFlowChanges` collapses diff, explicit staging, and commit into one bounded action.
- Push is not automatic; it runs only when the user explicitly asks.
- Long-running job or polling routes are not exposed in the Custom GPT schema.

## Bottleneck Ranking

1. ChatGPT model reasoning between action calls.
2. Too many sequential action calls for large task lists.
3. Slow validation commands when run unnecessarily.
4. Over-broad reads/searches if the GPT ignores instructions.
5. Relay/proxy hop overhead when not using direct local routing.
6. Local IO only after the above, and currently not a practical bottleneck.

## Engineering Direction

Further optimization should reduce action chatter:

- keep schema small
- keep responses compact
- prefer exact reads
- use focused large-file reads before patching
- run targeted validation only when useful
- batch deterministic mechanical work when it removes repeated calls
- preserve compact action activity so the GPT can summarize progress after each action
- add compact diagnostics when field diagnosis needs visibility
- keep relay parity with the direct local API

## UI Stability Boundary

BuildFlow cannot control the ChatGPT client UI state, including temporary "talking to BuildFlow" banners, action spinners, or cases where the ChatGPT app re-renders a message while an action is still pending. BuildFlow can only reduce the likelihood of unstable UI behavior by returning faster, smaller action responses and by instructing the GPT to narrate before and after each action.

Do not attempt to solve UI flipping with server-side polling, streaming, or background jobs. Those are incompatible with the Custom GPT action path. The mitigation is smaller action slices, shorter action chains, and explicit resume points.

The correct user-facing promise is: **fast local repo assistance through ChatGPT with guardrails**.
