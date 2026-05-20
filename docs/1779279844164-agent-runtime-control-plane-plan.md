# Agent Runtime Control Plane Plan

## Hard boundary
Custom GPT remains the reasoning and coding engine. BuildFlow must not add a paid API model or local LLM executor that replaces Custom GPT for planning, code generation, or open-ended repair.

The local application is a deterministic control plane: it executes safe commands, validates, tracks compact job state, enforces payload budgets, verifies writes, stages explicit files, commits, pushes, and exposes compact progress to the dashboard and GPT actions.

## Current iteration
This iteration starts the modular Agent Runtime without changing the cost model:
- Extract deterministic Agent Mode preflight from the large local server into `packages/cli/src/agent/agent-runtime.ts`.
- Add `packages/cli/src/agent/payload-budget.ts` as the shared source of truth for GPT action payload budgets.
- Keep GPT-facing responses compact by default.
- Keep open-ended code reasoning and implementation in Custom GPT.

## Architecture direction
The optimal BuildFlow shape is:
- Custom GPT: user-facing reasoning, code generation, review, and targeted decisions.
- Local agent runtime: deterministic execution, validation, status, safety, and Git workflows.
- Dashboard: live job/event surface and local observability.
- Relay/web actions: compact control API only, not a high-volume orchestration bus.

## Next recommended slices
1. Add compact local job events with a `getRecentEvents` view that stays under 8 KB.
2. Add action contract tests that assert typical GPT action responses stay under budget.
3. Split low-level read actions into small-read and chunked-large-read paths.
4. Continue extracting server responsibilities from `server.ts` into modules.
5. Add dashboard controls for pause/resume/cancel when local deterministic jobs are running.

## Non-goals
- No local LLM implementation that performs the main coding work.
- No paid model API executor hidden inside BuildFlow.
- No broad GPT action responses or full logs in normal operation.
