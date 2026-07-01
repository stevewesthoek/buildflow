# ProChat Workbench Product Documentation

ProChat Workbench is a ChatGPT-first local development workbench. It lets a Custom GPT plan and direct substantial software work while the user’s own computer performs guarded execution against real local repositories.

The product is designed to reduce AI development cost and friction by using ChatGPT as the reasoning interface instead of requiring a separate hosted coding-agent API for ordinary workflows.

## Canonical documentation order

1. [`philosophy.md`](./philosophy.md) — why Workbench exists and what it promises
2. [`strategy.md`](./strategy.md) — how quick mode and goal mode should operate
3. [`roadmap.md`](./roadmap.md) — phased delivery with reliability gates
4. [`plans/agentic-work-packets.md`](./plans/agentic-work-packets.md) — technical implementation plan
5. code, schema, instructions, and runtime changes

These documents are authoritative when older documents conflict with them.

## Product model

```text
User goal in ChatGPT
  -> ChatGPT reasons and plans
  -> Workbench persists the run
  -> ChatGPT compiles safe work packets
  -> Workbench executes locally
  -> Workbench validates and checkpoints
  -> ChatGPT reviews evidence and continues
```

Workbench supports two internal modes:

- **Quick mode** for questions, narrow fixes, and small edits.
- **Goal mode** for features, phases, migrations, refactors, and other substantial work.

The user should describe outcomes in natural language. The Custom GPT should select the right mode and orchestration pattern automatically.

## Current stable action surface

The current Custom GPT exposes five stable operations:

- `getWorkbenchStatus`
- `readWorkbenchContext`
- `applyWorkbenchFileChange`
- `commitWorkbenchChanges`
- `runWorkbenchCommand`

These actions remain bounded and fail-fast. The new goal-mode architecture will build larger outcomes from persistent state, deterministic work packets, asynchronous local execution, and compact status retrieval rather than making one request run indefinitely.

## Current capabilities

- explicit source locking
- exact reads and bounded search
- cached Graphify navigation
- verified repo-local writes
- guarded move, delete, rename, mkdir, and rmdir operations
- targeted validation and named security scans
- explicit-path commits
- compact activity metadata
- branch-aware source metadata
- protected-path and confirmation policies

## Planned agentic capabilities

- automatic quick-mode versus goal-mode selection
- persistent runs and implementation plans
- deterministic work packets
- asynchronous packet execution
- resume after restart or from a new conversation
- compact packet review and automatic continuation
- one bounded repair attempt
- safe per-source auto-commit
- pause, cancel, recovery, and observability

## Safety model

Autonomy must not weaken repository safety.

Workbench continues to require:

- explicit `sourceId`
- exact source verification before writes
- repo-relative allowed paths
- secret and protected-path blocking
- idempotent packet execution
- stale-HEAD detection
- validation before automatic commit
- explicit changed paths only
- no default force push
- no default auto-push

## Naming and compatibility

Use **ProChat Workbench** for public product language.

The name **BuildFlow** may remain temporarily in compatibility identifiers such as:

- the repository or source ID
- legacy scripts and CLI aliases
- environment variable fallbacks
- historical release notes
- package internals that need a staged migration

New user-facing documentation, schema descriptions, errors, and features should use Workbench terminology.

## Historical and superseded documents

Older documents may remain as implementation evidence or release history, but they are not automatically current product guidance.

In particular:

- [`agent-mode.md`](./agent-mode.md) is superseded by `philosophy.md` and `strategy.md`.
- [`agent-mode-optimization-roadmap.md`](./agent-mode-optimization-roadmap.md) is superseded by `roadmap.md`.
- historical BuildFlow release documents retain their original names for traceability.

## Supporting references

- [`README.md`](../../README.md)
- [`docs/CUSTOM_GPT_INSTRUCTIONS.md`](../CUSTOM_GPT_INSTRUCTIONS.md)
- [`docs/openapi.chatgpt/README.md`](../openapi.chatgpt/README.md)
- [`public-scope.md`](./public-scope.md)
- [`chatgpt-first-workflow.md`](./chatgpt-first-workflow.md)
- release history under [`releases/`](./releases/)
