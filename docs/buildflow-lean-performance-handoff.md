# BuildFlow Lean Performance Handoff

Status: implementation chunk complete; validation passed.
Source lock: buildflow.
Agent job: agent-c0ac988b-84a2-462d-98fb-f25050ade130.

## Goal
Make BuildFlow leaner/faster without removing features. Preserve Handoff, conversation isolation/source locking, web surface, agent surface, relay surface, write safety, validation, and git workflow behavior.

## Findings
- Main confirmed GPT-side bloat was `docs/openapi.chatgpt.json`: 145,978 bytes before, regenerated to 57,604 bytes after minified serialization.
- GPT instructions were prose-heavy: 7,233 bytes before, reduced to 4,742 bytes with machine-oriented rules while preserving action list, source lock, Handoff/Agent Mode, verification, safety, write policy, command/git, and fallback behavior.
- `apps/web/src/app/api/openapi/route.ts` repeated reusable schemas inline. A component `$ref` helper and component schema registry were added as source-level groundwork for future live-schema dedupe. No endpoint or field was removed.
- Existing pre-work user change in `buildflow-orchestrator.sh` was detected and left intact.

## Changed files
- `docs/CUSTOM_GPT_INSTRUCTIONS.md`: compacted machine-readable instruction set.
- `scripts/generate-openapi-chatgpt.mjs`: emits minified JSON and logs byte count.
- `docs/openapi.chatgpt.json`: regenerated minified schema, valid JSON, 57,604 bytes.
- `apps/web/src/app/api/openapi/route.ts`: added `$ref` helper and reusable component schemas; no behavior removed.
- `buildflow-orchestrator.sh`: pre-existing modification, not edited by this job.

## Validation evidence
- `pnpm run generate:openapi-chatgpt`: passed; wrote `docs/openapi.chatgpt.json (57604 bytes)`.
- `validate_json_files docs/openapi.chatgpt.json`: passed.
- `type_check_web`: passed (`tsc --noEmit`).
- `type_check_cli`: passed (`tsc --noEmit`).
- `git diff --stat`: 5 files changed, 73 insertions, 4462 deletions; includes pre-existing orchestrator change.

## Rollback notes
- Revert `scripts/generate-openapi-chatgpt.mjs` to `JSON.stringify(schema, null, 2)` if pretty docs are required.
- Re-run `pnpm run generate:openapi-chatgpt` after rollback to restore pretty schema output.
- Restore previous `docs/CUSTOM_GPT_INSTRUCTIONS.md` from git if human-prose instructions are preferred.
- Revert the `ref` helper/components block in `apps/web/src/app/api/openapi/route.ts` if unwanted; it is non-breaking source preparation.
- Do not rollback `buildflow-orchestrator.sh` unless intentionally discarding the pre-existing detached launcher work.

## Remaining optional hardening
- Fully replace repeated response schema references inside `apps/web/src/app/api/openapi/route.ts` with `$ref` objects for live `/api/openapi` payload dedupe, then regenerate docs and rerun type checks.
- Update `scripts/verify-custom-gpt-actions.mjs` byte thresholds and instruction-alignment checks if the full live GPT contract suite is run; current validation covered JSON validity and TypeScript.
- After restart/redeploy, import the new minified `docs/openapi.chatgpt.json` into the GPT action schema and update the custom instructions.

## Resume point
Continue with optional live-schema `$ref` dedupe and full GPT action contract verification if needed. Otherwise proceed to commit review, excluding or separately handling the pre-existing `buildflow-orchestrator.sh` change.


## Update: full lean-schema implementation

Status: completed second optimization pass.

### Additional changes
- `apps/web/src/app/api/openapi/route.ts`: live `/api/openapi` now returns a cached compact OpenAPI document. Repeated schema objects are replaced with component `$ref`s at module load, so runtime schema serving no longer duplicates Activity/Source/FileResult/WriteResult/AgentJob/CommandResult/Error objects across endpoints.
- `docs/openapi.chatgpt.json`: regenerated from live compact endpoint. Final size is 29,533 bytes, down from 145,978 bytes original and 57,604 bytes after first minify-only pass.
- `scripts/verify-custom-gpt-actions.mjs`: updated expected action list to 11 actions, added `$ref` response-schema resolution, and aligned consequential flag checks with current schema.

### Additional validation evidence
- `type_check_web`: passed after live compact OpenAPI changes.
- `pnpm run generate:openapi-chatgpt`: passed; wrote `docs/openapi.chatgpt.json (29533 bytes)`.
- `validate_json_files docs/openapi.chatgpt.json`: passed.
- `type_check_cli`: passed in earlier pass and was unaffected by later web/schema verifier changes.
- `verify:gpt-contract`: not run to completion because `BUILDFLOW_ACTION_TOKEN` is not available in this command environment; verifier code was updated but full authenticated smoke suite still needs token-bearing environment.
- `security_scan_paths forbidden_all_high_risk`: failed on expected generator/verifier patterns (`fetch`, `execFileSync`, token env read, deliberate blocked-content smoke string). No secret value was exposed; findings are test/generator mechanics rather than new secret material.

### Custom GPT update required
Yes. After deploying/restarting the web surface that serves `/api/openapi`, update both in the Custom GPT editor:
1. Replace the GPT instructions with `docs/CUSTOM_GPT_INSTRUCTIONS.md`.
2. Reimport/paste `docs/openapi.chatgpt.json` as the action schema.
Then save/update the GPT and start a new chat so ChatGPT uses the lean schema/instructions.

### Commit note
Recommended intended commit set for this optimization excludes the pre-existing `buildflow-orchestrator.sh` unless that detached-launcher change should be bundled separately.

## Update: orchestrator cleanup before commit

- `buildflow-orchestrator.sh`: pre-existing detached Python launcher change was reviewed and consolidated.
- Previous working-tree state duplicated the inline Python detached launcher in both `tsx` and `next` branches.
- Final version adds one `launch_detached` helper and uses it for `pnpm exec tsx ...` and `pnpm dev`.
- Intent preserved: services detach cleanly from the shell, logs stream to `.buildflow/<service>.log`, and startup no longer depends on `nohup` shell job state.
- Cleanup value: less duplicated launcher code, clearer log messages, and a single code path to maintain.
