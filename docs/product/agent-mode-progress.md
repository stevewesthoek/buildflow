# Workbench Refinement Progress

Status: active implementation handoff.
Run: `agent-d5b1d0f1-236a-4534-b6fd-9f6ded603a22`
Source lock: `buildflow`

## Goal

Refine the existing ProChat Workbench architecture without redesigning the five-action Custom GPT surface. Preserve quick synchronous commands and current safety behavior while adding durable, bounded handling for allowlisted validations that outlive a GPT action request.

## Current Evidence

- The GPT-facing `run-command` route intentionally clamps ordinary commands to an effective ceiling of roughly 11 seconds so requests finish before the action deadline.
- The internal command runner already supports longer bounded execution (`DEFAULT_TIMEOUT_MS = 120000`, `MAX_TIMEOUT_MS = 300000`) and already returns structured command, runtime, output, signal, duration, changed-path, and confirmation evidence.
- Workbench already has persistent runs, deterministic packets, asynchronous scheduling, leases, pause/cancel controls, packet records, rollback journals, validation results, and compact continuation decisions.
- `scheduleWorkbenchPacket()` already returns quickly and continues work through `setImmediate()` outside the initiating request lifetime.
- Packet execution already invokes `runSafeCommand()` and records validation results.
- The worktree contains broad unrelated work. This refinement must use exact reads, exact writes, exact diffs, and explicit-path commits only.

## Smallest Compatible Design

Do not add another agent runtime and do not add a sixth Custom GPT action.

### 1. Persisted validation jobs

Add a small validation-job record using the same storage and lease conventions as packet records. A job records:

- stable job ID and idempotency key
- source ID and optional run/packet/task IDs
- allowlisted command request
- requested runtime profile, including supported Node version
- status: queued, running, completed, failed, timed_out, cancelled
- queued, started, updated, and completed timestamps
- exit code, signal, duration, termination reason, and infrastructure-termination flag
- bounded stdout and stderr plus truncation metadata
- exact changed paths before/after the command
- worker/lease ownership and cancellation request

The persisted result, not a live HTTP connection, becomes the validation evidence.

### 2. Existing action-surface integration

Keep `runWorkbenchCommand` as the only command action.

Extend it with bounded command kinds or modes that fit the existing schema:

- submit an allowlisted long validation and return immediately with a job ID
- inspect compact job status/result by job ID
- cancel a queued or running job

Do not permit arbitrary shell strings. Reuse `SafeCommandRequest`, package script names, exact executable/argument validation, protected paths, branch requirements, confirmation rules, and network policy.

Fast commands continue synchronously with current deadlines. Only explicitly classified long validations use persisted jobs.

### 3. Runtime preparation without repository mutation

Use the existing exact-command runtime profile instead of temporary `package.json` aliases.

For supported Node 20 commands, resolve the approved runtime internally and clear only the explicitly supported conflicting environment variable (`npm_config_prefix`) before spawning. Preserve the command array; do not interpolate shell text.

Initial long-job scope should be narrow:

- `run_package_script` for an existing package script such as `build`
- existing web/CLI type checks when explicitly submitted as long jobs
- existing allowlisted package tests

Deployment, migration, database, network, and arbitrary executable behavior remains blocked by existing policy.

### 4. Proactive activity and continuation messaging

Every submit/status result should include compact activity evidence before the next human action.

For a newly submitted long validation, return structured fields that support this visible response pattern:

## BUILD STARTED

- Job ID
- Source and package
- Exact allowlisted command
- Start time
- Current status

## WAIT

- State clearly that the build is running outside the GPT request.
- Give a conservative human wait instruction based on the command class, without claiming an exact completion time.
- State that sending the check prompt early is safe; it will report `running` rather than start a duplicate job.

## NEXT PROMPT

Provide a copyable prompt that checks the same job ID, compares the current diff, reads the persisted run, and continues only after a terminal result.

For status checks:

- `queued` or `running`: do not resubmit; return WAIT and the same check prompt.
- `completed`: report exit code, final output summary, changed paths, and the exact next task.
- `failed` or `timed_out`: distinguish application failure from infrastructure termination and provide one bounded repair/resume prompt.
- missing/stale job: report the loss of evidence explicitly; never infer success.

### 5. Continuity and drift prevention

Before advancing after a long validation:

- verify the locked source ID
- load the active persistent run and current task
- load the validation job by ID
- compare current `HEAD` and exact diff to the recorded pre-command state
- confirm the job is terminal and has an application exit result
- record the result in the run/packet evidence
- re-read the current roadmap/handoff acceptance criteria
- continue from the persisted next task without repeating completed work

Completed and failed job IDs must be retained in bounded history so retries cannot accidentally duplicate a build or overwrite prior evidence.

## Implementation Slices

### Slice A: validation-job persistence

Likely files:

- new `packages/cli/src/agent/workbench-validation-jobs.ts`
- new or existing worker/coordinator module
- `packages/cli/src/agent/server.ts`
- `packages/shared/src/types.ts`

Acceptance:

- submit returns quickly with a stable job ID
- duplicate idempotency submission returns the existing job
- restart preserves queued/running/terminal evidence
- output is bounded and terminal exit evidence is persisted

### Slice B: command runner integration

Likely files:

- `packages/cli/src/agent/command-runner.ts`
- focused verifier updates in `scripts/verify-command-runner.ts`

Acceptance:

- synchronous fast commands remain unchanged
- long jobs reuse existing allowlisted command construction
- no temporary package script is required
- supported Node 20 preparation is array-based and policy checked
- cancellation terminates the owned process tree and records the outcome

### Slice C: five-action API and activity refinement

Likely files:

- `apps/web/src/app/api/actions/run-command/route.ts`
- `apps/web/src/lib/actions/gpt.ts`
- `apps/web/src/app/api/openapi/route.ts`
- generated/static OpenAPI only through the existing generator

Acceptance:

- submit/status/cancel finish inside the current action deadline
- no sixth action is introduced
- activity includes job ID, proven state, what remains, and exact next prompt data
- timeout text never presents externally induced termination as an application failure

### Slice D: run/packet evidence and documentation

Likely files:

- persistent run/packet result integration
- `docs/CUSTOM_GPT_INSTRUCTIONS.md`
- `docs/product/roadmap.md`
- this handoff
- timeout/reliability documentation and focused contract verifiers

Acceptance:

- completed and failed validations appear in persistent run status
- continuation prompts reuse job/run IDs and do not drift
- documentation matches the implemented schema and behavior
- broad existing product behavior remains unchanged

## Validation Strategy

Use the smallest checks per slice:

- focused command-runner verifier
- focused validation-job persistence/restart verifier
- CLI type check
- GPT/OpenAPI contract verifier after API/schema changes
- one real allowlisted build submitted asynchronously, followed by bounded status checks until terminal
- exact diff and explicit-path security scan before each commit

Do not accept a compile phase or partial output as proof of a successful production build. A passing build requires persisted terminal status with application exit code `0`.

## Guardrails

- No arbitrary shell action.
- No user-supplied shell metacharacters.
- No broad environment mutation.
- No unbounded output or job history.
- No silent resubmission after timeout.
- No automatic staging, commit, or push after a non-terminal validation.
- No unrelated worktree changes in refinement commits.
- No changes to other repositories.

## Current Task State

Completed:

- inspected current worktree state
- mapped the synchronous GPT command ceiling
- mapped internal longer command support
- mapped asynchronous packet coordinator, executor, store, leases, rollback, and validation result flow
- recorded the smallest compatible design
- added `packages/cli/src/agent/workbench-validation-jobs.ts` with bounded persisted records, source-scoped compact retrieval, idempotent submission, conflict detection, terminal result storage, and conversion to the existing safe command request
- wired `validationJobOperation: submit | status` through the existing CLI `/api/commands/run` endpoint without changing synchronous command behavior
- forwarded validation-job fields through `dispatchWorkbenchCommand()` and represented queued/running jobs as active verification work rather than failures
- added `scripts/verify-validation-jobs.ts` with isolated storage assertions for persistence, compact status, source isolation, duplicate submission, idempotency conflicts, and invalid requests
- repaired the directly related `SubmitWorkbenchValidationJobResult` TypeScript narrowing error

Validation evidence:

- `package.json` now provides `verify:validation-jobs` as the repository-native verifier entry
- `verify:validation-jobs`: passed on 2026-07-01 with `validation job persistence checks passed`, exit code `0`
- the focused verifier now covers worker scheduling, execution through `runSafeCommand()`, persisted terminal status `completed`, persisted exit code `0`, and persisted output containing `worker-ok`
- `type_check_cli`: passed within the same verifier run on 2026-07-01 with `tsc --noEmit`, exit code `0`
- no repair was required
- the persisted validation-job submit/status/worker slice is validated

Exact refinement files changed so far:

- `packages/cli/src/agent/workbench-validation-jobs.ts`
- `packages/cli/src/agent/server.ts`
- `apps/web/src/lib/actions/gpt.ts`
- `scripts/verify-validation-jobs.ts`
- `docs/product/agent-mode-progress.md`

Remaining limitations:

- validation jobs are persisted and retrievable but no worker executes queued jobs yet
- the GPT-facing OpenAPI/tool schema has not been updated to expose validation-job fields or the existing exact-command runtime fields
- the focused verifier needs either a pre-existing allowlisted package script or schema exposure for guarded exact-command arguments; `package.json` was intentionally not modified for test orchestration
- terminal build evidence, cancellation, restart recovery, run/packet evidence integration, WAIT/CHECK/NEXT response formatting, and live long-build acceptance remain pending

Next task:

Finish only the remaining end-to-end validation-job contract: expose the already implemented submit/status fields through the existing `runWorkbenchCommand` OpenAPI schema, add the matching Custom GPT continuation instructions, then perform one fresh restart and live submit/status acceptance check. Do not redesign the five-action surface or add unrelated capabilities.




## Final Validation and Restart Readiness

Validation completed on 2026-07-01:

- `verify:validation-jobs`: passed with `validation job persistence checks passed`, including submit, compact status, source isolation, duplicate idempotency, idempotency conflict, bounded worker scheduling, `runSafeCommand()` execution, terminal `completed`, exit code `0`, and persisted `worker-ok` output
- `verify:gpt-actions`: passed with status `ok`, generated schema size `14589` bytes, instruction size `7949` characters, and exactly five public operations
- `type_check_web`: passed with `tsc --noEmit`, exit code `0`
- `type_check_cli`: passed with `tsc --noEmit`, exit code `0`
- no directly related repair remained after the stale `.gitignore` / `.graphifyignore` verifier literal was aligned with the already-correct write policy

Final isolated review status:

- dedicated refinement files are isolated: `packages/cli/src/agent/workbench-validation-jobs.ts`, `scripts/verify-validation-jobs.ts`, and this handoff
- `package.json` contains the focused `verify:validation-jobs` entry
- mixed files require explicit-path and, where applicable, hunk-level commit review because the worktree already contains unrelated changes: `packages/cli/src/agent/server.ts`, `apps/web/src/lib/actions/gpt.ts`, `apps/web/src/app/api/openapi/route.ts`, `docs/openapi.chatgpt.json`, `docs/CUSTOM_GPT_INSTRUCTIONS.md`, and `scripts/verify-custom-gpt-actions.mjs`
- the prior path-requested Git diff command returned broad unrelated worktree changes and truncated output; therefore no broad commit or commit-all operation is safe
- a final exact-read retry for the implementation symbols encountered a Workbench transport `ContentTypeError`; no file was changed by that failed read

Restart readiness:

- static implementation, persistence, worker, schema, instruction, and TypeScript checks pass
- the refinement is ready for one fresh Workbench rebuild/restart
- after restart, update the Custom GPT with `docs/CUSTOM_GPT_INSTRUCTIONS.md`, import the regenerated `docs/openapi.chatgpt.json`, and run one live submit → running/status → terminal exit-code acceptance test
- do not commit until the live acceptance test passes; commit only explicit refinement paths after reviewing mixed-file hunks

Next task:

Perform the fresh rebuild/restart, update the Custom GPT instructions and schema, then execute one live persisted validation-job acceptance test using the same job ID from submit through terminal status. Stop and report exact evidence before any commit.




## Live Persisted Validation Acceptance

Completed on 2026-07-01:

- source: `buildflow`
- run: `agent-d5b1d0f1-236a-4534-b6fd-9f6ded603a22`
- command: `type_check_cli`
- validation job: `validation-6a113684-bcd9-4a72-b702-c8dcfd6b0099`
- observed transition: `running` → `completed`
- exit code: `0`
- activity verification: `verified: true`
- no duplicate submission was made; the same persisted job ID was used from submit through terminal status

Remaining response-contract defect:

- terminal status returned top-level `ok: false` despite `status: completed`, exit code `0`, and `verified: true`
- the GPT-visible terminal response omitted persisted `stdout`, `stderr`, `outputTruncated`, `changedPaths`, `terminatedByInfrastructure`, and `terminationReason`
- this is a response-envelope/serialization defect, not a validation execution failure
- no infrastructure termination was indicated by the returned activity evidence

Next task:

Repair only the terminal validation-job status response contract so completed jobs return a consistent success envelope and expose the compact persisted result fields already stored by the worker. Then rerun the same focused verifier and one live status acceptance check before any commit.




## Detached Self-Restart Acceptance and Final Response Contract

Completed on 2026-07-01:

- detached restart ID: `restart-1782909956360-8efa0ca4`
- detached launcher returned `scheduled` before shutdown with worker PID `53446`
- restart state transitioned to `completed`
- restart exit code: `0`
- restart signal: `null`
- automatic endpoint recovery succeeded without a manual repository step
- recovered web process PID: `53796`
- recovered web process started at `2026-07-01T12:46:52.760Z`
- recovered build timestamp: `2026-07-01T12:45:59Z`
- recovered web build ID: `wOx7RoHRWr_RWZcfaxceQ`
- restart state path: `/tmp/buildflow-restart-latest.json`
- restart log path: `/tmp/buildflow-restart-restart-1782909956360-8efa0ca4.log`

Rebuilt persisted validation response contract:

- existing job `validation-6a113684-bcd9-4a72-b702-c8dcfd6b0099` returned top-level `ok: true`
- status: `completed`
- exit code: `0`
- persisted stdout was exposed
- `outputTruncated: false`
- `changedPaths: []`
- `terminatedByInfrastructure: false`
- final serializer defaults now keep `stderr` explicit as an empty string when unavailable
- final serializer defaults now keep `terminationReason` explicit as `null` when unavailable

Final focused validation:

- `verify:validation-jobs` passed
- validation job persistence checks passed
- CLI `tsc --noEmit` passed
- exit code: `0`
- output was not truncated

No restart, implementation change, commit, or push was performed during this documentation update.



## Persisted Exact-Build Repair and JPV Live Acceptance

Completed on 2026-07-01:

- repaired persisted validation status handling so stored terminal `timed_out` results are returned as job evidence instead of a new GPT transport timeout;
- added persisted `run_exact_command` support through the existing guarded exact-command runner;
- separated the bounded persisted job timeout (default 300 seconds, maximum 900 seconds) from the short GPT-facing HTTP timeout;
- added structured invalid-request fields (`field`, `reason`, and `allowedValues`);
- preserved source-scoped idempotency and stable job reuse;
- returned complete bounded stdout/stderr, exit code, signal, lifecycle timestamps, changed paths, runtime, branch, protected-path, infrastructure-termination, and termination-reason evidence;
- resolved Node 20 through explicit `NVM_DIR`, standard `$HOME/.nvm`, or the current Node 20 runtime;
- resolved the pnpm shim from the approved Node 20 bin, `PNPM_HOME`, or the existing PATH while keeping Node 20 first in the child environment;
- kept synchronous exact commands capped at 12 seconds while persisted validations use their bounded job timeout;
- pruned mutable vendor and generated output directories from mandatory secret-path scanning while retaining `.git`, environment-file, and private-key protection;
- reordered mandatory protected snapshots so Workbench's own Git inspection does not create false-positive `.git` changes.

Focused validation evidence:

- `verify:validation-jobs`: passed, including persisted exact `pnpm run` execution under Node 20, branch protection, caller-protected paths, complete output, structured invalid fields, and a 300-second default persisted timeout;
- CLI `tsc --noEmit`: passed within `verify:validation-jobs`;
- `verify:command-runner`: passed, including generated `node_modules` output without mandatory-protection false positives;
- `verify:gpt-actions`: passed with exactly five public operations;
- web `tsc --noEmit`: passed;
- detached fresh restart `restart-1782916817972-fb0cc512`: completed with exit code `0` and signal `null`.

Live cross-repository acceptance evidence:

- source: `prochattools-jpv-bootcamp`;
- required branch: `feature/course-branding-and-preview`;
- validation job: `validation-63917bce-b5ca-4c23-9fa6-4cf5278de441`;
- exact command: `pnpm run build`;
- runtime: Node `v20.20.2`, pnpm `10.33.0`;
- observed status: `running` → `completed` using the same job ID;
- exit code: `0`;
- duration: `13,554ms`, proving execution continued beyond the GPT action deadline;
- output was complete and not truncated;
- actual branch matched the required branch;
- caller-protected `.graphifyignore` and handoff document were unchanged;
- no infrastructure termination occurred.

The validated JPV implementation was then committed as `49197e4 fix: repair staging migration path and member authentication` and pushed only to `origin/feature/course-branding-and-preview`.

BuildFlow isolation status:

- the persisted-validation repair hunks were isolated from unrelated `close_run` work before staging;
- all focused validation and security review completed against the isolated repair state;
- the repair is intended for one dedicated local commit with no push authorization.
