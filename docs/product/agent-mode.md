# Superseded: Previous ProChat Workbench Product Direction

Status: superseded.

This document previously defined ProChat Workbench as a small, bounded Fast Repo Assistant that stopped after one or two tasks and explicitly rejected agentic execution.

That direction is no longer canonical.

Use these documents instead:

1. [`philosophy.md`](./philosophy.md)
2. [`strategy.md`](./strategy.md)
3. [`roadmap.md`](./roadmap.md)
4. [`plans/agentic-work-packets.md`](./plans/agentic-work-packets.md)

## What Changed

The previous direction concluded that synchronous Custom GPT Actions required the whole product to remain non-agentic.

The new direction keeps the useful transport lessons but changes the architectural conclusion:

```text
short bounded actions
+ persistent run state
+ deterministic work packets
+ asynchronous local execution
+ compact review checkpoints
= stable agentic workflow
```

Workbench is now intended to support phase-sized, looping, automated local development with substantially less user supervision.

## Knowledge Preserved From The Previous Direction

The following engineering conclusions remain valid:

- individual GPT Action calls must stay short and fail-fast
- action responses must remain compact JSON
- every repo action must carry an explicit `sourceId`
- exact reads should precede writes
- Graphify is navigation only, not source truth
- writes must be guarded and verified
- validation should be targeted
- commits must stage explicit paths only
- secrets and protected paths must remain blocked
- quick mode must remain stable

## Conclusions That Are Superseded

The following previous product conclusions must no longer guide implementation:

- Workbench is not an agentic product
- large goals should stop after the first small slice
- every response should have a universal three-action hard limit
- server-side execution loops are categorically out of scope
- persistent goal mode should not be exposed to the Custom GPT
- polling or asynchronous execution can never be part of the architecture

The replacement strategy does not use endless synchronous polling. It uses durable run state and short status retrieval around asynchronous local work packets.

## Historical Purpose

This file remains only to explain why older code, tests, and documents may contain Fast Repo Assistant or anti-agentic language.

Do not cite this file as the current product direction.
