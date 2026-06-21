# ProChat Workbench Roadmap

Status: canonical roadmap.

This roadmap implements the philosophy in [`philosophy.md`](./philosophy.md) and the operating model in [`strategy.md`](./strategy.md).

## Roadmap Principle

The product must become more agentic without sacrificing the stability of the current bounded action layer.

Every phase follows this rule:

```text
add one durable capability
-> test it against real phase-sized work
-> keep quick mode working
-> expand only after evidence
```

## Phase 1: Documentation And Product Alignment

Status: complete as of 2026-06-21.

Goals:

- establish canonical philosophy, strategy, roadmap, and implementation plan
- replace anti-agentic product language
- define Workbench as the public product identity
- classify BuildFlow identifiers as compatibility-only where required
- preserve historical documents without treating them as current guidance

Exit criteria:

- canonical documents agree on the same architecture
- README and product docs no longer contradict the agentic direction
- Custom GPT instructions and schema changes are specified before code changes

## Phase 2: Goal-Mode Custom GPT Behavior

Status: complete as of 2026-06-21.

Goals:

- automatically classify natural-language requests as quick mode or goal mode
- remove the universal three-action hard stop
- allow multiple safe action cycles in one assistant turn
- persist an exact resume point before a goal-mode turn ends
- stop only for meaningful blockers

Implementation scope:

- rewrite `docs/CUSTOM_GPT_INSTRUCTIONS.md`
- update OpenAPI descriptions without changing runtime semantics yet
- add verifier rules for goal-mode instructions

Validation gate:

- complete a documentation phase requiring at least five related actions in one turn
- verify no timeout, no unrelated writes, and no user re-prompt between ordinary safe steps

## Phase 3: Persistent Run Model

Status: complete as of 2026-06-21.

Implemented capabilities:

- versioned persistent runs with source lock, goal, phases, tasks, checkpoints, events, blockers, confirmations, metrics, and exact resume state
- durable active task and packet identity plus completed packet history
- atomic persistence, bounded event history, source-scoped active-run lookup, and compact status retrieval
- restart-safe recovery and deterministic resume without repeating completed packets

Validation evidence:

- [x] start a run, restart Workbench, and resume the exact next task
- [x] verify completed tasks do not repeat
- [x] pass `verify:workbench-async-reliability`, `verify:workbench-live-async`, `type_check_cli`, and `verify:gpt-actions`

## Phase 4: Work Packet Contract

Status: complete as of 2026-06-21.

Implemented capabilities:

- versioned deterministic packet schema with source, task, idempotency, expected `HEAD`, exact steps, validation, commit policy, and stop conditions
- duplicate and idempotency conflict rejection plus stale-`HEAD` protection
- exact-path, policy, secret, generated-output, command, and confirmation validation before mutation
- verified text operations, allowlisted validation, exact-path security scans, and explicit-path commits

Validation evidence:

- [x] reject duplicate packet IDs and conflicting idempotency keys
- [x] reject stale starting commits
- [x] reject blocked or secret-bearing paths before any write
- [x] prove no packet stages or commits unrelated files
- [x] pass `verify:workbench-async-reliability`, `type_check_cli`, and `verify:gpt-actions`

## Phase 5: Asynchronous Packet Execution

Status: complete.

Goals:

- accept a packet quickly and return a run/packet ID
- execute deterministic steps outside the GPT request lifetime
- persist step events and compact results
- support pause, cancel, and safe resume

Validation evidence:

- asynchronous submission returned immediately while execution continued outside the request lifetime
- compact status was retrieved through a separate short status call
- cooperative pause rolled back writes, persisted `paused`, and resumed deterministically
- queued and running cancellation paths were verified
- `activePacketId` and dedicated packet lifecycle events were persisted and exposed
- stale leases and execution journals recovered safely
- a real spawned local server recovered interrupted work after process restart
- startup queue draining completed queued work after restart
- `verify:workbench-async-reliability`, `verify:workbench-live-async`, `type_check_cli`, and `verify:gpt-actions` passed

Validation gate:

- [x] run a packet longer than the short GPT request window without blocking asynchronous submission
- [x] retrieve final status from a separate short call
- [x] recover after process restart

## Phase 6: Review And Automatic Continuation

Status: complete.

Goals:

- let the Custom GPT review compact packet evidence
- automatically compile and dispatch the next packet
- continue through several packets from one user goal
- preserve exact resume state when the assistant turn ends

Validation evidence:

- terminal packet outcomes persist bounded `continue`, `stop`, `repair`, or `blocked` decisions
- continuation evidence records packet status, completed steps, validation outcome, commit hash, and bounded error codes
- the authoritative next task is persisted in run resume state before continuation
- automatic continuation requires a valid `continue` decision and a matching running task
- blocked, confirmation-required, paused, cancelled, failed, completed, or already-active runs do not continue
- only the oldest already-reserved queued packet for the exact next task is scheduled
- one initial dispatch completed two sequential task packets without supervision
- `verify:workbench-async-reliability`, `verify:gpt-actions`, and `type_check_cli` passed

Validation gate:

- [x] complete a multi-task feature slice with one initial user goal and no supervision between normal packets

## Phase 7: Safe Auto-Commit

Status: complete as of 2026-06-20.

Implemented capabilities:

- per-source auto-commit policy combined with run-level `autoCommit` authorization
- required targeted validation before automatic commit
- exact-path secret scanning before commit, including post-write validation mutations
- explicit-path-only staging and committed-path verification
- task-derived commit messages with `Workbench-Run` and `Workbench-Packet` trailers
- bounded safe undo for the verified Workbench-created `HEAD` commit
- auto-push remains disabled by default

Passing validation evidence:

- `type_check_cli`
- `verify:workbench-async-reliability`
- `verify:gpt-actions`

Validation gate:

- [x] auto-commit a validated packet
- [x] prove only explicit changed paths are staged
- [x] prove blocked or secret files cannot be included
- [x] undo a Workbench-created auto commit safely

## Phase 8: Repair And Recovery

Status: complete as of 2026-06-21.

Goals:

- allow one bounded automatic repair attempt after validation failure
- stop after the second failure
- provide compact failure evidence and exact resume instructions
- recover interrupted packets safely

Implemented capabilities:

- versioned task-scoped repair state with atomic persistence
- exactly one automatic repair dispatch after a persisted `repair` continuation decision
- same-task, matching-failed-packet, explicit-path, and queued-packet enforcement
- exhausted repair state after a second failure with no further automatic scheduling
- compact failure evidence, repair-attempt metrics, exact failed paths, and deterministic manual resume instructions
- restart-safe queue drain that allows only the exact accepted repair packet and blocks duplicate or exhausted repair packets

Validation gate:

- [x] induce one repairable failure and verify exactly one repair packet succeeds automatically
- [x] induce a second failure and verify automatic continuation stops cleanly
- [x] persist compact validation evidence, repair-attempt count, exact paths, and resume instructions
- [x] prove accepted and exhausted repair state cannot dispatch duplicate packets after restart
- [x] pass `type_check_cli`, `verify:workbench-async-reliability`, and `verify:gpt-actions`

## Phase 9: Dashboard And Observability

Status: complete as of 2026-06-21.

Implemented and validated:

- [x] read-only active-run observability for run status, active task, progress, summary, source, and updated time
- [x] blocker and confirmation-reason visibility
- [x] bounded recent event visibility through the existing agent jobs status path
- [x] bounded packet summaries covering lifecycle status, task identity, exact paths, completed and failed steps, and rollback state
- [x] bounded validation outcomes, commit hash, and error-code visibility
- [x] dashboard association of packet summaries with their persisted run
- [x] persisted run and packet observability remains consistent after restart recovery
- [x] Pause and Resume remain state-gated and duplicate clicks are blocked while a job is busy
- [x] Cancel requires explicit dashboard confirmation before dispatch
- [x] targeted runtime verification covers persisted packet observability evidence
- [x] structural verification enforces the bounded packet status payload
- [x] pass `type_check_cli`, `type_check_web`, `verify:workbench-async-reliability`, and `verify:gpt-actions`

Completion evidence:

- dashboard state is backed by the same durable run, packet, result, and event stores used for restart recovery
- destructive cancellation requires explicit confirmation
- runtime and structural verification protect the observability contract

## Phase 10: Controlled Expansion

Status: future.

Only after reliability evidence:

- increase packet size
- add more deterministic packet step types
- allow opt-in auto-push with explicit confirmation policy
- explore optional integrations with long-horizon coding products

## Cross-Phase Invariants

Every phase must preserve:

- explicit source locking
- compact JSON action responses
- short synchronous action deadlines
- exact source verification before writes
- idempotency
- stale repository detection
- secret and protected-path blocking
- explicit-path commits
- no default force push
- no hidden external reasoning dependency
- quick mode as a stable fallback

## Evidence Required Before Calling The Roadmap Successful

The roadmap is not successful because the APIs exist. It is successful only when real phase-sized work demonstrates:

- fewer user prompts
- more completed tasks per goal
- reliable resume after interruption
- no unrelated file changes
- no action timeout regression
- safe commits with auditable evidence

Target benchmark:

```text
one initial goal
-> multiple completed packets
-> one final review
```

The target is not infinite autonomy. The target is a reliable reduction in supervision for large local development work.
