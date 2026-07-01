# ProChat Workbench Strategy

Status: canonical product strategy.

## Strategic Objective

Make ProChat Workbench capable of completing large, phase-sized local development goals from ChatGPT with substantially less user supervision, while preserving the stability of short, bounded Custom GPT Actions.

The strategy is to separate reasoning, control, and execution:

```text
ChatGPT
  reasons, plans, reviews, and chooses the next packet

Workbench control plane
  persists goals, plans, state, checkpoints, and policies

Workbench execution plane
  performs deterministic reads, writes, validation, Git, and recovery
```

## Two Operating Modes

### Quick Mode

Use automatically for:

- questions
- narrow investigations
- one-file changes
- small fixes
- simple documentation updates

Workflow:

```text
understand -> exact read -> change or answer -> validate if needed -> optional commit -> stop
```

Quick mode preserves the current stable bounded workflow.

### Goal Mode

Use automatically for:

- feature implementation
- roadmap phases
- multi-file refactors
- application slices
- substantial migrations
- hardening programs
- complete documentation rewrites

Workflow:

```text
persist goal
-> create or refresh plan
-> select next task
-> compile work packet
-> execute locally
-> validate
-> checkpoint
-> auto-commit when allowed
-> review evidence
-> continue
```

The user should not need to request goal mode explicitly.

## Core Strategy: Durable Work Packets

A work packet is a bounded, deterministic execution unit prepared by ChatGPT and executed by Workbench.

A packet should contain:

- run ID
- packet ID
- source ID
- goal and task reference
- expected starting commit
- exact read/write paths
- exact changes or commands
- validation requirements
- commit policy
- idempotency key
- stop conditions

A packet should be small enough to execute safely but large enough to remove repeated action chatter.

Typical packet size:

- 1–3 tightly related tasks
- 1–5 exact file changes
- targeted validation
- one explicit-path commit

## Execution Model

Long execution must not depend on a long-lived GPT Action request.

The preferred lifecycle is:

1. GPT submits a packet.
2. Workbench validates the entire packet synchronously.
3. Workbench returns an accepted run/packet ID quickly.
4. Workbench executes deterministic steps locally.
5. Workbench persists events and checkpoints.
6. GPT retrieves a compact result.
7. GPT reviews evidence and submits the next packet.

Short packets may complete synchronously when safely below the action deadline. Longer packets should be asynchronous by default.

## Continuation Model

Goal mode must continue without requiring the user to restate the goal.

Continuation should be driven by persistent run state:

```text
current phase
current task
completed packets
changed paths
validation evidence
commit hashes
blockers
next recommended packet
```

A new conversation should be able to resume with natural language such as:

```text
Continue the current Workbench phase.
```

Workbench should recover the active run and exact next task.

## Why This Strategy Should Work

This strategy avoids the failure modes of earlier attempts.

It does not rely on:

- one request staying open for the whole phase
- endless GPT-side polling
- a second Custom GPT prompting the first
- hidden local model reasoning
- repeated broad repository scans
- the user manually reconstructing state

It relies on capabilities Workbench can control reliably:

- persistent files/state
- deterministic local operations
- short REST calls
- explicit checkpoints
- exact-path Git operations
- compact status retrieval

## Custom GPT Behavior

The Custom GPT should translate natural-language requests automatically.

For a phase-sized goal it should:

1. lock the source
2. load or create the persistent run
3. use Graphify once when architecture is unknown
4. verify exact source before editing
5. compile the next work packet
6. dispatch it
7. review the result
8. continue while the safe turn budget permits
9. persist an exact resume point before stopping

The user should not need to name internal modes or tools.

## Action Budget Strategy

The universal three-action hard stop should be retired.

Recommended budgets:

### Quick mode

- target: 1–3 actions
- stop after the narrow request is complete

### Goal mode

- target: up to 8–12 short actions in one assistant turn
- or up to 3 work-packet cycles
- stop earlier for safety, ambiguity, divergence, or failed recovery

This is a turn budget, not a request timeout. Every individual API call remains bounded.

## Safety Strategy

Autonomy must be policy-driven.

Workbench may continue automatically only when:

- the source is locked
- the packet precondition commit matches
- all paths are allowed
- the packet is idempotent
- validation requirements are known
- no explicit confirmation is required
- no unrelated worktree changes would be included

Workbench must stop when:

- requirements are materially ambiguous
- the repo changed unexpectedly
- validation fails twice after one repair attempt
- a protected operation requires confirmation
- a packet is stale or already executed
- the user pauses or cancels
- the phase is complete

## Git Strategy

- Stage explicit Workbench-changed paths only.
- Never use `git add -A` for automatic work.
- Run security scans on changed paths before auto-commit.
- Generate concise task-derived commit messages.
- Add a Workbench auto-commit trailer.
- Keep auto-push disabled by default.
- Provide a recoverable undo workflow for Workbench-created commits.

## Graphify Strategy

Graphify remains a navigation accelerator.

Use it to reduce discovery cost for unknown repo areas, then verify exact files and symbols before editing.

Graphify must never become the execution source of truth.

## Product and Compatibility Naming

Public product language should use ProChat Workbench.

BuildFlow should remain only where required for compatibility, such as:

- repository/source identifiers
- legacy scripts or CLI aliases
- environment variable fallbacks
- historical release records

New user-facing documentation, schema descriptions, errors, and features should use Workbench terminology.

## Measurement Strategy

The strategy should be evaluated with phase-sized benchmarks, not only single-action latency.

Track:

- user prompts per completed phase
- packets per phase
- successful packet completion rate
- average packet duration
- action failures/timeouts
- validation repair rate
- resume success after restart/new conversation
- unrelated-file modification rate
- auto-commit success and rollback rate

Primary success metric:

```text
completed meaningful tasks per user supervision event
```

## Rollout Strategy

1. Align philosophy and documentation.
2. Add goal-mode instructions without changing runtime semantics.
3. Expose persistent run status safely.
4. Implement packet validation and idempotency.
5. Add asynchronous packet execution.
6. Connect validation and safe auto-commit.
7. Add resume and recovery.
8. Expand packet size only after stability evidence.

Each stage must preserve the existing quick-mode workflow as a fallback.
