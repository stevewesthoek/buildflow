# Agentic Work Packets Implementation Plan

Status: canonical implementation plan.
Depends on:
- [`../philosophy.md`](../philosophy.md)
- [`../strategy.md`](../strategy.md)
- [`../roadmap.md`](../roadmap.md)

## Objective

Enable ProChat Workbench to complete substantial local development phases from a Custom GPT with materially less user supervision, without making individual GPT Actions long-running or fragile.

The implementation must preserve the stability of quick mode while adding durable goal mode.

## What We Are Building

```text
Natural-language goal
  -> persistent Workbench run
  -> versioned plan and tasks
  -> GPT-compiled deterministic packet
  -> fast packet acceptance
  -> local execution outside request lifetime
  -> validation and checkpoint
  -> safe auto-commit when allowed
  -> compact GPT review
  -> next packet
```

## What We Are Not Building

- an infinite Custom GPT loop
- two GPTs prompting each other
- a long HTTP request that waits for a whole phase
- a hidden local or hosted reasoning model
- arbitrary shell execution
- broad automatic staging
- default auto-push
- Graphify-driven source edits without exact reads

## Existing Foundation To Reuse

The repository already contains useful foundations:

- `packages/cli/src/agent/agent-jobs.ts`
- `packages/cli/src/agent/agent-events.ts`
- `packages/cli/src/agent/agent-runtime.ts`
- `/api/agent-jobs/start`
- `/api/agent-jobs/status`
- `/api/agent-jobs/control`
- `/api/agent-jobs/execute-task`
- guarded write policy
- allowlisted command runner
- explicit-path commit action
- activity metadata
- Graphify navigation

These pieces must be audited and consolidated rather than duplicated blindly.

## Why Earlier Attempts Did Not Work

Previous implementations created pieces of a job system but did not produce a reliable Custom GPT workflow.

Observed design problems:

1. The public GPT instructions explicitly stopped after tiny slices.
2. Job APIs were disconnected from the five-action Custom GPT schema.
3. The local runtime mainly ran preflight validation, not complete work packets.
4. Polling and long-running action ideas conflicted with synchronous REST limits.
5. Persistent jobs did not guarantee idempotency or stale-repo protection.
6. There was no tested end-to-end loop from goal to several committed tasks.
7. Product documentation described agentic behavior as a non-goal.

This plan requires end-to-end proof at every phase.

## Architecture

### Reasoning Layer

The Custom GPT:

- understands the goal
- creates and revises the plan
- chooses the next task
- verifies exact source context
- compiles deterministic packet steps
- reviews packet results
- decides whether to continue, repair, or stop

### Control Plane

Workbench stores:

- run identity and source lock
- goal and plan version
- current phase and task
- packet history
- repository preconditions
- events and checkpoints
- validation results
- commit hashes
- blockers and confirmations
- exact resume state

### Execution Plane

Workbench performs:

- policy validation
- exact file operations
- allowlisted commands
- security scans
- explicit-path commits
- packet event recording
- pause, cancel, and restart recovery

## Run Model

Create a versioned `WorkbenchRun` model.

Required fields:

```ts
{
  version: number
  id: string
  sourceId: string
  goal: string
  mode: 'goal'
  status: 'planned' | 'running' | 'paused' | 'blocked' | 'completed' | 'failed' | 'cancelled'
  createdAt: string
  updatedAt: string
  startingCommit: string
  currentCommit?: string
  planVersion: number
  phases: WorkbenchPhase[]
  activeTaskId?: string
  activePacketId?: string
  completedPacketIds: string[]
  confirmation?: ConfirmationState
  blocker?: RunBlocker
  resume: ResumeState
  metrics: RunMetrics
}
```

Persistence requirements:

- atomic writes
- versioned migrations
- no secret content
- bounded event history
- recovery after process restart
- source-scoped active-run lookup

Recommended storage:

```text
local control state: Workbench config directory
human-readable repo plan: docs/product/runs/<run-id>.md when policy allows
```

Do not require generated local state to be committed.

## Work Packet Model

Required packet shape:

```ts
{
  version: number
  runId: string
  packetId: string
  idempotencyKey: string
  sourceId: string
  taskId: string
  goalSummary: string
  expectedHead: string
  steps: PacketStep[]
  validation: ValidationStep[]
  commitPolicy: PacketCommitPolicy
  stopConditions: PacketStopCondition[]
  createdAt: string
}
```

Allowed initial step types:

- exact read assertion
- create text file
- patch text file
- append text file
- move allowed file
- delete confirmation-safe file
- run allowlisted validation
- security scan exact paths
- commit explicit paths

Do not support arbitrary commands or arbitrary code execution.

## Packet Validation

Before accepting a packet, Workbench must verify:

1. run exists and belongs to the source
2. packet ID has not completed or started previously
3. idempotency key is valid
4. current HEAD matches `expectedHead`
5. every path is repo-relative and allowed
6. no step writes secrets or generated output
7. all commands are allowlisted
8. changed path set is explicit and bounded
9. confirmation requirements are resolved
10. validation and commit policy are internally consistent

No write may happen before the full packet passes preflight.

## Asynchronous Lifecycle

### Submit

The GPT submits a packet through a bounded action.

Response target:

```json
{
  "accepted": true,
  "runId": "run_...",
  "packetId": "packet_...",
  "status": "queued",
  "nextStatusAfterMs": 3000
}
```

The acceptance request must complete well below the GPT Action timeout.

### Execute

The local runtime:

1. locks the run/packet
2. records `packet_started`
3. executes steps sequentially
4. verifies every write on disk
5. stops on first failed step
6. runs validation
7. optionally attempts one bounded repair packet prepared by the GPT
8. scans exact changed paths
9. commits explicit paths if policy allows
10. records compact result

### Retrieve

Status retrieval returns compact state only:

```json
{
  "runId": "run_...",
  "packetId": "packet_...",
  "status": "completed",
  "changedPaths": ["..."],
  "validation": "passed",
  "commit": "abc1234",
  "nextTaskId": "task_...",
  "requiresReview": true
}
```

Full logs remain local or available through narrowly bounded event reads.

## GPT-Facing Action Design

Prefer extending the compact surface over adding many operations.

Candidate design:

- add `run_status` and `run_plan` modes under `readWorkbenchContext`
- add `packet_preflight` mode under `applyWorkbenchFileChange`, or introduce one explicit `executeWorkbenchPacket` operation if the schema remains understandable
- use `runWorkbenchCommand` only for existing allowlisted commands, not orchestration

A schema decision must be made by comparing:

- operation count
- model action-selection reliability
- request/response size
- verifier complexity
- backward compatibility

Do not expose legacy `/api/agent-jobs/*` directly without a reviewed public contract.

## Custom GPT Instructions

Goal-mode instructions must require:

1. automatic quick/goal classification
2. persistent run creation or resume
3. Graphify only for unknown architecture
4. exact read before edit
5. deterministic packet compilation
6. compact packet review
7. automatic continuation while safe
8. exact resume persistence before stopping
9. no user prompt between ordinary safe packets

Stop conditions:

- explicit confirmation required
- material requirement ambiguity
- unexpected HEAD or worktree divergence
- validation fails twice after one repair attempt
- packet becomes stale or duplicates prior work
- user asks to pause or stop
- phase completes
- safe turn budget is exhausted

## Safe Auto-Commit Integration

Per-source policy modes:

- `off`
- `docs_only`
- `after_verified_packet`

Auto-commit prerequisites:

- packet completed successfully
- required validation passed
- security scan passed
- changed paths exactly match packet output
- no unrelated staged files
- no confirmation-gated Git operation

Commit format:

```text
<type>: <task-derived summary>

Workbench-Run: <run-id>
Workbench-Packet: <packet-id>
Workbench-Auto-Commit: true
```

Push remains manual by default.

## Recovery And Idempotency

Packet state transitions must be durable:

```text
created -> preflighted -> queued -> running -> validating -> committing -> completed
                                      \-> blocked
                                      \-> failed
                                      \-> cancelled
```

Recovery rules:

- completed packet IDs never execute again
- running packet after restart is reconciled from checkpoints
- partial uncommitted writes produce a blocked recovery state
- HEAD mismatch stops the run
- cancellation stops before the next step
- pause persists the exact next step

## Documentation Migration

After the canonical documents are accepted:

1. update `README.md`
2. update `docs/product/README.md`
3. supersede or rewrite `docs/product/agent-mode.md`
4. supersede `docs/product/agent-mode-optimization-roadmap.md`
5. update `docs/CUSTOM_GPT_INSTRUCTIONS.md`
6. update OpenAPI descriptions and generated schema
7. mark historical agent-runtime documents clearly
8. create a compatibility document for BuildFlow identifiers

## Code Naming Migration

Public user-facing code should use Workbench terminology.

Compatibility identifiers may remain temporarily:

- `buildflow` source ID
- legacy CLI entry point
- legacy script aliases
- legacy environment variable fallback
- historical file and release names

Do not perform a blind global rename.

## Implementation Sequence

### Batch 1: Documentation contract

- canonical philosophy
- canonical strategy
- canonical roadmap
- this implementation plan
- superseded-document map

### Batch 2: Instruction-only goal mode

- rewrite Custom GPT instructions
- update schema descriptions
- add verifier assertions
- no runtime packet execution yet

### Batch 3: Run persistence

- versioned run store
- migration from or reuse of `agent-jobs`
- compact run read modes
- restart/resume tests

### Batch 4: Packet preflight

- packet schema
- validation
- idempotency
- stale-HEAD check
- policy integration

### Batch 5: Packet execution

- asynchronous queue
- step engine
- events/checkpoints
- pause/cancel/recovery

### Batch 6: Validation and auto-commit

- targeted validation
- exact-path security scan
- explicit-path commit
- trailers
- undo support

### Batch 7: GPT continuation

- packet-result review guidance
- next-packet compilation
- larger goal-mode turn budget
- exact resume behavior

### Batch 8: Dashboard

- run list
- current task
- packet events
- validation and commit evidence
- controls

## Verification Program

Each batch requires unit/contract tests plus an end-to-end scenario.

Mandatory scenarios:

### Scenario A: Documentation phase

- one natural-language goal
- at least five related file updates
- targeted validation
- one explicit-path commit
- no intermediate user supervision

### Scenario B: Code feature

- unknown architecture discovered through Graphify
- exact reads
- multi-file packet
- type-check
- commit

### Scenario C: Restart recovery

- submit packet
- restart Workbench during execution
- reconcile and resume or block safely

### Scenario D: Stale packet

- change HEAD after packet compilation
- confirm packet refuses to execute

### Scenario E: Duplicate packet

- submit the same packet twice
- confirm only one execution

### Scenario F: Validation repair

- first validation fails
- one GPT-prepared repair packet runs
- second failure stops

### Scenario G: Protected path

- packet includes blocked or confirmation-required path
- confirm preflight prevents all writes

## Success Metrics

Track:

- prompts per completed phase
- completed tasks per user supervision event
- packet success rate
- packet retries
- timeout rate
- restart recovery rate
- duplicate execution count
- unrelated changed-file count
- validation repair success
- auto-commit success

Release threshold for goal mode:

- zero duplicate packet executions
- zero unrelated staged files
- zero secret/protected-path bypasses
- successful restart recovery in the supported scenarios
- materially fewer user prompts than quick-mode-only execution

## Final Acceptance Criterion

The implementation is complete only when a user can give one phase-sized goal and Workbench can execute multiple validated, checkpointed, explicit-path packets with no ordinary supervision, then return a compact final review or a precise genuine blocker.




## Phase 5 Completion Record

Status: complete as of 2026-06-20.

Implemented capabilities:

- fast asynchronous packet submission with immediate packet identity
- deterministic execution outside the GPT request lifetime
- persistent packet leases, journals, compact results, and restart-safe queue draining
- cooperative pause, cancel, rollback, and deterministic resume semantics
- persistent `activePacketId` on the parent run
- dedicated `packet_paused`, `packet_resumed`, and `packet_cancelled` lifecycle events
- stale-lease recovery and execution-journal restoration
- separate live submit and status endpoints

Passing validation evidence:

- `verify:workbench-async-reliability`
- `verify:workbench-live-async`
- `type_check_cli`
- `verify:gpt-actions`

The isolated live-server proof verified prompt asynchronous submission, separate status retrieval, interrupted-write restoration, actual process restart recovery, and startup completion of queued work. The public Custom GPT schema and instructions remain unchanged until the later coordinated migration described by the roadmap.




## Phase 6 Completion Record

Status: complete as of 2026-06-20.

Implemented capabilities:

- bounded persistent continuation decisions with `continue`, `stop`, `repair`, and `blocked` outcomes
- compact review evidence covering packet status, completed steps, validation outcome, commit hash, and bounded error codes
- exact next-task persistence in run resume state
- automatic continuation only for a valid `continue` decision on a running, non-blocked, non-confirmation-required run
- strict matching between the authoritative `activeTaskId` and `decision.nextTaskId`
- scheduling of only the oldest already-reserved queued packet for the exact next task
- no continuation for paused, cancelled, failed, completed, blocked, confirmation-required, or already-active runs

Passing validation evidence:

- `verify:workbench-async-reliability`
- `verify:gpt-actions`
- `type_check_cli`

The runtime reliability proof reserved two sequential task packets, dispatched only the first, and verified that the second completed automatically without supervision. The run preserved exact resume evidence throughout the transition.




## Phase 7 Completion Record

Status: complete as of 2026-06-20.

Implemented capabilities:

- per-source auto-commit policy combined with run-level `autoCommit` authorization
- required targeted validation before any automatic commit
- exact-path security scanning before commit, including detection of post-write validation mutations
- explicit-path staging with staged-path and committed-path equality checks
- task-derived commit messages with `Workbench-Run` and `Workbench-Packet` trailers
- preflight rejection for blocked or secret-bearing packet content before mutation
- bounded safe undo for the verified Workbench-created `HEAD` commit
- exact-path revert verification while preserving unrelated worktree files
- auto-push remains disabled by default

Passing validation evidence:

- `type_check_cli`
- `verify:workbench-async-reliability`
- `verify:gpt-actions`

The isolated runtime proof completed a validated automatic commit, confirmed that unrelated work was not staged, verified both preflight and post-write secret blocking, and safely reverted the Workbench-created commit without touching unrelated files.

## Phase 8 First Implementation Slice: Bounded Repair State

Status: complete as of 2026-06-21.

Objective:

Allow one deterministic automatic repair attempt after a failed packet, then stop cleanly after a second failure with durable evidence and an exact resume point.

Implemented capabilities:

- versioned atomic repair-state persistence keyed by run and task
- failed packet identity, accepted repair packet identity, attempt count, and explicit `eligible`, `accepted`, `exhausted`, and `cleared` states
- terminal failed packet results automatically create task-scoped repair eligibility
- automatic repair dispatch requires a persisted `repair` continuation decision
- repair dispatch requires the same active task, matching failed packet, eligible state, and an already-reserved queued repair packet
- the single repair attempt is consumed before scheduling, preventing duplicate or repeated automatic repair
- a second failure exhausts repair state and leaves later repair packets queued and unscheduled
- existing successful `continue` scheduling remains separate from failed-packet repair scheduling

Completed implementation tasks:

- [x] persist repair-attempt state for the active task and failed packet
- [x] allow automatic repair continuation only when the persisted continuation decision is `repair`
- [x] require the repair packet to target the same active task and use an already-reserved explicit-path packet
- [x] increment repair state only when the repair packet is accepted for execution
- [x] prevent a second automatic repair attempt for the same task
- [x] after a second failure, persist compact validation and error evidence with repair-attempt count and exact resume instructions
- [x] add restart proof that accepted or exhausted repair state cannot duplicate repair execution

Passing validation evidence:

- `type_check_cli`
- `verify:workbench-async-reliability`
- `verify:gpt-actions`

Runtime and structural proof:

- a repairable validation failure automatically dispatched exactly one same-task repair packet and completed successfully
- accepted repair state persisted attempt count `1` and the selected repair packet ID
- a second failure persisted `exhausted` state, scheduled no third packet, and preserved that packet as queued
- exhausted repair handoff persisted packet status, completed steps, validation result, bounded error codes, repair-attempt count, authoritative task ID, exact failed paths, and deterministic manual resume instructions
- later partial run updates preserve the exhausted-repair instructions instead of replacing them with generic defaults
- restart queue drain allows only the exact accepted repair packet and blocks duplicate accepted, eligible, and exhausted repair packets
- structural verification enforces terminal failure gating, persisted repair decision, active-task matching, eligible-state matching, attempt consumption, selected repair identity, duplicate scheduling prevention, and restart repair-state gating



## Phase 9 Completion Record: Dashboard And Observability

Status: complete as of 2026-06-21.

Objective:

Expose persisted run and packet state in the dashboard without weakening the bounded action and execution model.

Implemented and validated capabilities:

- [x] read-only active-run observability panel in the dashboard
- [x] run status, active phase and task, progress, summary, source, and last-updated visibility
- [x] blocker and confirmation-reason visibility
- [x] bounded recent agent event visibility through the existing `/api/agent/jobs` response
- [x] bounded packet observability summaries from `/api/agent-jobs/status`
- [x] packet lifecycle status, task identity, exact paths, completed steps, failed step, and rollback visibility
- [x] bounded validation command outcomes, commit hash, and error-code visibility
- [x] dashboard association of packet summaries with their persisted run
- [x] read-only rendering of the latest packet validation, commit, rollback, and failure evidence
- [x] persisted run and packet observability remains consistent after restart recovery
- [x] Pause and Resume controls remain state-gated and repeated requests are blocked while a job is busy
- [x] Cancel requires explicit dashboard confirmation before dispatch
- [x] targeted runtime assertions cover persisted packet identity, exact paths, lifecycle, validation, rollback, errors, and timestamps
- [x] structural verification enforces every bounded packet observability field in the agent jobs status payload

Passing validation evidence:

- `type_check_cli`
- `type_check_web`
- `verify:workbench-async-reliability`
- `verify:gpt-actions`

Completion evidence:

The dashboard exposes active-run, packet, validation, commit, blocker, confirmation, and recent event state using the existing agent jobs status path. Restart recovery preserves the underlying persisted observability evidence, destructive cancellation requires explicit confirmation, and both runtime and structural verification cover the bounded payload contract.



## Phase 3 Completion Record: Persistent Run Model

Status: complete as of 2026-06-21.

Implemented capabilities:

- versioned persistent Workbench run records with source lock, goal, phases, tasks, status, timestamps, and plan version
- durable active task and active packet identity
- completed packet history, blocker state, confirmation state, metrics, and exact resume state
- bounded persistent event history and compact status retrieval
- source-scoped active-run lookup
- atomic persistence and compatibility with the legacy agent-job model
- restart-safe recovery of queued and interrupted work
- deterministic resume from the exact next task without repeating completed packets

Passing validation evidence:

- `verify:workbench-async-reliability`
- `verify:workbench-live-async`
- `type_check_cli`
- `verify:gpt-actions`

Runtime and structural proof:

- a persisted run resumed after process restart with the same active task and packet state
- interrupted execution journals and stale packet leases recovered without duplicating completed work
- startup queue draining completed queued work after restart
- exact resume evidence remained durable across automatic continuation, repair, pause, and later partial run updates

## Phase 4 Completion Record: Work Packet Contract

Status: complete as of 2026-06-21.

Implemented capabilities:

- versioned deterministic packet schema with run, packet, task, source, idempotency, expected `HEAD`, exact steps, validation, commit policy, and stop conditions
- duplicate packet and idempotency conflict rejection
- stale-`HEAD` protection before execution
- exact repo-relative path validation and bounded changed-path sets
- blocked path, secret-bearing content, generated output, and unsafe command rejection before mutation
- allowlisted validation commands and exact-path security scans
- verified text create, patch, append, move, and confirmation-safe delete operations
- explicit-path staging and commit-path equality checks
- preflight enforcement before any write and compact result persistence after execution

Passing validation evidence:

- `verify:workbench-async-reliability`
- `type_check_cli`
- `verify:gpt-actions`

Runtime and structural proof:

- duplicate packet IDs and conflicting idempotency keys were rejected
- stale starting commits were rejected before mutation
- blocked and secret-bearing paths were rejected during preflight
- unrelated worktree files were neither staged nor committed
- post-write validation mutations were detected by the exact-path security scan
- explicit committed paths matched the validated packet path set



## Pre-Migration Readiness Record

Status: preparation in progress as of 2026-06-21. Public Custom GPT instructions, schema, operation contracts, and imported action behavior remain unchanged pending explicit user approval.

Validated prerequisites already complete:

- [x] persistent versioned run model and exact resume state
- [x] deterministic packet contract with idempotency, stale-`HEAD`, path, policy, and confirmation checks
- [x] asynchronous packet execution, compact results, pause, cancel, resume, and restart recovery
- [x] automatic continuation with bounded evidence and exact next-task state
- [x] validated exact-path auto-commit, security scanning, and safe undo
- [x] one bounded automatic repair attempt with clean second-failure handoff
- [x] dashboard observability, restart consistency, control safety, and bounded payload verification
- [x] passing `type_check_cli`, `type_check_web`, `verify:workbench-async-reliability`, and `verify:gpt-actions`

Preparation work still required before migration approval:

- [x] define the final public goal-mode behavior and stopping rules without changing runtime contracts
- [x] map current five-operation actions to persistent run and packet capabilities while preserving operation IDs and compatibility
- [x] identify stale pre-packet wording in `docs/CUSTOM_GPT_INSTRUCTIONS.md`, `docs/openapi.chatgpt/README.md`, README, and related product docs
- [x] draft the coordinated instruction and OpenAPI description changes for review without applying them
- [x] add migration-specific verifier assertions and rollback criteria
- [x] define a compatibility and rollback checklist for imported Custom GPT configurations
- [x] perform a final documentation consistency review immediately before migration
- [x] obtain explicit user confirmation to begin migration

Review-only preparation package:

- [`custom-gpt-migration-readiness.md`](./custom-gpt-migration-readiness.md) defines the proposed goal-mode behavior, stopping rules, five-operation compatibility mapping, stale wording inventory, migration verification gates, rollback criteria, and approval checklist without changing the active public contract.

Migration authorization gate:

No public Custom GPT instruction rewrite, OpenAPI schema migration, operation-contract change, or imported-action behavior change may begin until the user explicitly approves the migration. Preparation documents and review-only drafts may proceed before approval, but they must not alter the active public contract.

Known stale wording to resolve during the approved migration:

- `docs/CUSTOM_GPT_INSTRUCTIONS.md` still says goal mode should be approximated until persistent packet APIs are implemented
- `docs/openapi.chatgpt/README.md` still says persistent run and packet operations have not shipped
- the canonical roadmap still leaves Phase 1 active and Phase 2 planned until the coordinated public migration is specified, reviewed, approved, and validated



## Custom GPT Migration Completion Record

Status: complete as of 2026-06-21.

Completed migration scope:

- rebuilt `docs/CUSTOM_GPT_INSTRUCTIONS.md` as a complete application- and schema-aligned instruction set under the hard 8,000-character limit
- replaced obsolete pre-packet guidance with persistent run, bounded packet, continuation, confirmation, repair, and exact-resume behavior
- migrated `docs/openapi.chatgpt/README.md` to the implemented five-operation persistent goal-mode model
- updated the OpenAPI top-level description without changing operation IDs, paths, request fields, response contracts, or runtime semantics
- activated migration-specific verifier assertions for instruction length, stable operations, explicit `sourceId`, goal-mode behavior, stop rules, stale wording, metadata limits, and packet observability
- reconciled the readiness package and roadmap with explicit user approval and final validation evidence

Passing completion gates:

- `verify:gpt-actions`
- `validate_json_files` for `docs/openapi.chatgpt.json`
- `type_check_cli`
- `type_check_web`

Compatibility evidence:

- exactly five public operation IDs remain exposed
- current source IDs, API contracts, package names, scripts, routes, and environment variables remain compatible
- quick mode remains bounded
- goal mode uses implemented persistent run and deterministic packet capabilities
- no arbitrary shell execution, broad staging, default push, hidden model runtime, or indefinite request lifetime was introduced

Phases 1 and 2 are complete. Phases 3–9 remain complete. Phase 10 remains future work.
