# Custom GPT Migration Readiness Package

Status: migration complete as of 2026-06-21.

This document defines the approved public behavior, compatibility mapping, verification gates, and rollback criteria for the coordinated Custom GPT migration. Explicit user approval was received on 2026-06-21.

The migration is authorized within this documented scope. Operation IDs, request contracts, runtime semantics, and imported-action compatibility remain unchanged unless separately reviewed and approved.

## Proposed Public Goal-Mode Behavior

The Custom GPT should classify requests automatically without requiring users to name a mode.

Quick mode remains the default for focused questions, small edits, and narrow investigations. It should use the smallest useful set of bounded actions, validate when useful, and stop after delivering the requested result.

Goal mode applies to multi-file features, roadmap phases, migrations, hardening programs, and other substantial outcomes. It should:

1. lock the source explicitly
2. load or create durable run state
3. select the exact next task
4. verify source context before mutation
5. compile or reserve one bounded deterministic packet
6. execute through the existing guarded runtime
7. retrieve compact result evidence
8. validate and checkpoint
9. continue automatically when the persisted decision is `continue`
10. allow one bounded repair only when the persisted decision is `repair`
11. stop for confirmation, policy blocks, ambiguity, cancellation, exhausted repair, or terminal completion

Goal mode must not imply an infinite loop, long-held HTTP request, hidden model runtime, arbitrary command execution, broad staging, or automatic push.

## Proposed Stopping Rules

The public instructions should require stopping when:

- source identity is missing or changes unexpectedly
- an operation requires explicit confirmation
- the run is paused, cancelled, blocked, failed, or completed
- packet preflight rejects paths, policy, commands, content, or expected `HEAD`
- the single automatic repair attempt is exhausted
- the next task is ambiguous or lacks exact source evidence
- the status response reports unavailable, timeout, or narrower-scope guidance
- the user asks to stop

Ordinary successful packet completion should not require a new user prompt when a valid persisted continuation decision and already-reserved next packet exist.

## Five-Operation Compatibility Mapping

The public operation IDs remain unchanged:

| Operation | Persistent capability mapping | Compatibility rule |
| --- | --- | --- |
| `getWorkbenchStatus` | source discovery, connection state, active context, compact runtime readiness | Preserve method, operation ID, source identifiers, and bounded response behavior |
| `readWorkbenchContext` | exact reads, graph navigation, active-run inspection, compact status evidence | Preserve current modes and add no implicit source fallback |
| `applyWorkbenchFileChange` | guarded file mutation plus existing run, resume, and packet-preflight change types | Preserve current change types and payload compatibility; new descriptions must not promise unsupported execution |
| `commitWorkbenchChanges` | explicit-path commit and existing confirmation handling | Preserve exact-path staging and confirmation semantics |
| `runWorkbenchCommand` | allowlisted validation, tests, security scans, and safe Git controls | Preserve allowlist, path bounds, deadlines, and no arbitrary shell execution |

The migration should expose persistent behavior through descriptions and verified existing change types before considering any new public operation. Existing operation IDs, package names, routes, environment variables, and source IDs remain compatibility contracts.

## Stale Public Wording Inventory

The approved migration must reconcile at least these statements:

- `docs/CUSTOM_GPT_INSTRUCTIONS.md`: goal mode is described as an approximation until persistent packet APIs exist
- `docs/openapi.chatgpt/README.md`: persistent run and packet operations are described as not shipped
- `docs/openapi.chatgpt/README.md`: the section titled “Current use before packet APIs ship” is obsolete
- `docs/product/roadmap.md`: Phase 1 and Phase 2 remain open until the migration specification, review, approval, and validation are complete
- README and related product docs must be checked for claims that conflict with the final public action surface

## Review-Only Change Set

Before approval, prepare diffs but do not apply them to the active public contract:

- revised `docs/CUSTOM_GPT_INSTRUCTIONS.md`
- revised OpenAPI operation and parameter descriptions in `docs/openapi.chatgpt.json`
- revised `docs/openapi.chatgpt/README.md`
- aligned README and product documentation
- verifier assertions for mode selection, stop conditions, source locking, compatibility, and stale wording removal

No operation ID, route, request schema, or runtime semantic should change unless separately justified and explicitly approved.

## Migration Verification Gates

The migration is ready to activate only when all of the following pass:

- schema remains within current size and metadata limits
- exactly the expected five public operations remain exposed unless separately approved
- all operation IDs and existing request fields remain compatible
- explicit `sourceId` requirements remain enforced
- quick mode remains bounded and functional
- goal mode instructions reference only implemented persistent capabilities
- stop, confirmation, repair, and cancellation rules match runtime behavior
- stale pre-packet wording is removed from canonical public docs
- `verify:gpt-actions` passes with migration-specific assertions
- CLI and web type-checks pass if code or generated schema changes are involved
- a documented rollback artifact is available before activation

## Rollback Criteria

Rollback should occur immediately when any of these are observed after activation:

- imported Custom GPT actions fail schema validation
- an operation ID or required request shape changes unexpectedly
- the GPT attempts unsupported actions or arbitrary commands
- source locking becomes implicit or unreliable
- quick-mode requests become materially slower or require unnecessary run creation
- goal mode loops without persisted continuation evidence
- confirmation, cancellation, or repair stop conditions are bypassed
- response payloads exceed established budgets
- current verifier or reliability suites regress

## Rollback Procedure

1. restore the last approved `docs/CUSTOM_GPT_INSTRUCTIONS.md`
2. restore the last approved `docs/openapi.chatgpt.json` and generated schema output
3. restore aligned README and OpenAPI guide wording
4. rerun `verify:gpt-actions`
5. confirm the five stable operation IDs and schema limits
6. re-import the last approved schema into the Custom GPT if the migrated schema had been activated
7. record the failure and required remediation before another migration attempt

## Review-Only Instruction Draft

The approved migration should replace the temporary approximation language in `docs/CUSTOM_GPT_INSTRUCTIONS.md` with behavior equivalent to:

```text
Goal mode uses persistent Workbench runs and bounded deterministic packets.
Load or create the run, select the exact next task, verify source context,
submit one bounded packet, retrieve compact result evidence, validate,
checkpoint, and continue only when persisted continuation state permits it.

Do not stop after an arbitrary action count. Stop for confirmation, policy
rejection, ambiguity, timeout or unavailable guidance, cancellation,
terminal completion, or exhausted bounded repair.
```

The approved instruction update must also:

- preserve quick mode for narrow work
- preserve explicit source locking on every repo action
- remove the temporary `8–12` action recommendation as the primary goal-mode mechanism
- describe persistent continuation without promising an infinite loop or long-running HTTP request
- retain all current safety, confirmation, secret, path, validation, staging, commit, and push restrictions

This is a review draft only. It is not the active Custom GPT instruction text.

## Review-Only OpenAPI Description Draft

The approved migration should update descriptions, not operation IDs or request contracts.

Proposed top-level description:

```text
ProChat Workbench exposes five bounded actions for local repository work.
Quick requests use exact reads and guarded operations directly. Substantial
goals use durable run state and deterministic packets while each GPT-facing
request remains short, source-scoped, policy-checked, and restart-safe.
```

Proposed description changes by operation:

- `getWorkbenchStatus`: describe source discovery and compact readiness; do not imply run mutation
- `readWorkbenchContext`: describe exact reads plus active-run and compact persisted evidence modes
- `applyWorkbenchFileChange`: describe guarded text changes and the existing run, resume, and packet-preflight change types without implying arbitrary packet execution
- `commitWorkbenchChanges`: retain explicit-path staging, confirmation, and no-broad-commit language
- `runWorkbenchCommand`: retain allowlisted validation and safe Git controls; explicitly reject arbitrary shell execution

The schema must continue to expose exactly the five approved operation IDs unless a separate migration is proposed and approved.

## Draft Migration-Specific Verifier Assertions

The migration patch should add assertions to `verify:gpt-actions` that fail when:

- `docs/CUSTOM_GPT_INSTRUCTIONS.md` contains `Until persistent packet APIs are implemented`
- `docs/openapi.chatgpt/README.md` contains `does not yet expose the final persistent run and packet contract`
- `docs/openapi.chatgpt/README.md` contains `Current use before packet APIs ship`
- goal-mode instructions omit persistent run state, bounded packets, exact resume state, or persisted continuation evidence
- stopping rules omit confirmation, blocked or failed state, cancellation, timeout or unavailable guidance, and exhausted repair
- source locking no longer requires explicit `sourceId`
- the schema exposes an operation count other than five
- any approved operation ID changes
- metadata or response budgets exceed existing limits
- instructions claim arbitrary shell, broad staging, default push, hidden model execution, or indefinite request lifetimes

These assertions should be introduced in the same approved migration change as the public wording they enforce. Activating them earlier would intentionally fail against the current pre-migration text.

## Final Documentation Consistency Review

Review result as of 2026-06-21:

- canonical philosophy, strategy, roadmap, implementation plan, and migration readiness package agree on the persistent run and bounded packet architecture
- README already presents persistent goals and packets as product capabilities
- `docs/CUSTOM_GPT_INSTRUCTIONS.md` still contains temporary approximation language and an action-count recommendation that should be replaced during migration
- `docs/openapi.chatgpt/README.md` still describes persistent packet operations as unshipped and contains an obsolete pre-packet usage section
- the current five-operation public contract remains internally consistent and verified
- Phase 1 must remain active until public documentation is reconciled
- Phase 2 must remain planned until the instruction and description migration is explicitly approved, applied, and validated
- no current runtime or schema contract needs to change merely to complete the wording migration

Consistency gate result: ready for explicit approval of the coordinated documentation and description migration, but not authorized to migrate.

## Approval Checklist

- [x] prepare proposed goal-mode behavior and stopping rules for review
- [x] prepare five-operation compatibility mapping for review
- [x] complete stale wording inventory
- [x] prepare migration verification gates
- [x] prepare rollback criteria and procedure
- [x] prepare review-only instruction and OpenAPI description drafts
- [x] prepare migration-specific verifier assertions
- [x] perform final pre-migration documentation consistency review
- [x] obtain explicit user approval to begin migration
- [x] migrate `docs/CUSTOM_GPT_INSTRUCTIONS.md` under the hard 8,000-character limit
- [x] migrate `docs/openapi.chatgpt/README.md` and the OpenAPI top-level description
- [x] activate migration-specific verifier assertions
- [x] pass `verify:gpt-actions`
- [x] validate `docs/openapi.chatgpt.json`

Migration validation is in progress. The remaining completion gates are CLI and web type-checks plus final roadmap and implementation-plan reconciliation. Operation IDs, request contracts, and runtime semantics remain unchanged.
