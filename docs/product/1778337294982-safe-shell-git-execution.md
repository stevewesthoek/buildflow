# Safe Shell and Git Execution

## Goal

Add safe, policy-gated command execution to BuildFlow Local so a Custom GPT can validate changes, inspect git state, and eventually commit work without handing every step to an external terminal agent.

BuildFlow must not become an unrestricted shell. Commands are treated like writes: scoped to one source, allowlisted, redacted, timed out, logged, and confirmation-gated when consequential.

## Product principles

- ChatGPT remains the primary workspace.
- BuildFlow remains the local connector and policy engine.
- Commands must be repo-local and auditable.
- Read-only/status commands are easier than mutating commands.
- Validation commands are allowed only from a safe allowlist.
- Git write operations require explicit user intent.
- Dangerous shell primitives are blocked by default.
- No secrets, raw env dumps, arbitrary network installers, or destructive cleanup.

## Phase 1 — Safe status and validation runner

Purpose: let ChatGPT prove work without Codex for common validation steps.

Scope:

- Add command policy types and a small allowlist.
- Add a local agent endpoint for safe command execution.
- Add a web proxy/action adapter endpoint only if needed by the current action flow.
- Support read-only git/status commands.
- Support known validation commands used by BuildFlow.
- Enforce cwd inside the selected source root.
- Enforce timeout and output byte limits.
- Redact secret-like output.
- Return structured activity fields.

Allowed examples:

- `git status --short`
- `git diff --stat`
- `git diff --name-only`
- `git diff`
- `git log -1 --oneline`
- `git branch --show-current`
- `pnpm verify:public-scope`
- `pnpm --dir apps/web type-check`
- `pnpm --dir packages/cli type-check`
- `./packages/cli/node_modules/.bin/tsx scripts/verify-write-policy.ts`
- `./packages/cli/node_modules/.bin/tsx scripts/verify-source-reindex-resilience.ts`

Blocked examples:

- `rm -rf`, `sudo`, `chmod -R`, `chown`, `env`, `printenv`
- `cat .env`, `cat .env.*`
- `curl | sh`, `wget | sh`
- package installation commands unless a later phase explicitly supports confirmation-gated dependency changes
- arbitrary shell strings not in the allowlist

Deliverables:

- Command execution policy module.
- Agent endpoint.
- Tests or verification script coverage.
- Product docs updated.

Commit target:

- `feat: add safe validation command runner`

## Phase 2 — Git commit workflow

Purpose: let ChatGPT safely create commits after verified edits.

Scope:

- Stage explicit files only.
- Show staged file list before commit.
- Reject generated/vendor/build outputs unless explicitly allowed by policy.
- Reject secret-like content.
- Create commit only after explicit user instruction.
- Return commit hash and final git status.
- No push by default.

Commands/actions:

- get git status
- get diff
- stage explicit files
- create commit

Commit target:

- `feat: add safe git commit workflow`

## Phase 3 — Confirmation-gated push and protected git actions

Purpose: support full handoff completion when the user explicitly approves.

Scope:

- `git push` requires explicit confirmation.
- branch-aware push only.
- no force push by default.
- reset/clean/restore are blocked unless a later maintainer profile explicitly adds them.

Commit target:

- `feat: add confirmation-gated git push`

## Phase 4 — Long task / goal integration

Purpose: connect commands to BuildFlow Goals.

Scope:

- Goals can run one validation step at a time.
- Failures become activity items and next-step suggestions.
- No autonomous destructive actions.
- Pause/resume support.

Commit target:

- `feat: integrate validation runner with goals`

## Validation checklist for every phase

- `pnpm verify:public-scope`
- `git diff --check`
- `pnpm --dir apps/web type-check`
- `pnpm --dir packages/cli type-check`
- `./packages/cli/node_modules/.bin/tsx scripts/verify-write-policy.ts`
- `./packages/cli/node_modules/.bin/tsx scripts/verify-source-reindex-resilience.ts`
- runtime smoke for dashboard, OpenAPI, and sources
- secret scan of changed files

## Safety notes

- Never return raw secret values from command output.
- Never run commands outside the selected source root.
- Never add arbitrary shell execution to the GPT action surface.
- Every mutating command needs a policy gate and, when appropriate, confirmation tokens.
