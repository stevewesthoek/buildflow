# Superseded: Fast Repo Assistant Optimization Roadmap

Status: superseded by [`roadmap.md`](./roadmap.md).

This document previously optimized ProChat Workbench around very small tasks, one to three actions per response, and frequent user supervision.

That direction improved stability, but it is no longer the canonical product roadmap.

## Current Roadmap

Use:

- [`philosophy.md`](./philosophy.md)
- [`strategy.md`](./strategy.md)
- [`roadmap.md`](./roadmap.md)
- [`plans/agentic-work-packets.md`](./plans/agentic-work-packets.md)

## What This Roadmap Got Right

The following findings remain part of the new architecture:

- repeated Custom GPT action chatter is expensive
- local reads are usually faster than model/action round trips
- exact reads are preferable to broad scans
- cached Graphify navigation can reduce discovery work
- action payloads and responses must stay bounded
- route deadlines and structured failures improve stability
- commits must use explicit paths
- source locking prevents cross-conversation drift
- targeted validation is preferable to unnecessary full validation
- automatic commits require security and policy gates

These lessons now support larger goals instead of limiting the product to small tasks.

## What Is Superseded

The following conclusions are no longer current:

- Fast Repo Assistant is the only product direction
- one task per response should be the default for every request
- three actions should be a universal hard stop
- large goals should complete only the first safe slice
- persistent run orchestration should remain disconnected from the Custom GPT
- asynchronous packet execution is out of scope
- agentic looping should not be a product goal

## Replacement Architecture

The new roadmap uses:

```text
quick mode for narrow work
+
goal mode for phase-sized work
+
persistent run state
+
deterministic work packets
+
asynchronous local execution
+
compact review and continuation
```

The individual action layer remains short and stable. Larger outcomes are achieved through durable state and multiple bounded packet cycles.

## Historical Implementations Preserved

The following completed work remains valuable and should not be removed merely because this roadmap is superseded:

- fail-fast GPT action deadlines
- status response hardening
- Graphify context detection and concrete next actions
- focused read modes
- write-policy verification
- repo hygiene support
- explicit-path commit behavior
- activity metadata
- safe auto-commit planning

These capabilities become foundations for the canonical roadmap rather than endpoints of the product.

## Migration Rule

When old code, tests, or documentation cite this roadmap, update them to the canonical roadmap unless the reference is explicitly historical.
