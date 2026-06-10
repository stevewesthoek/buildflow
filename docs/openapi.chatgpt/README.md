# BuildFlow Custom GPT Action Imports

For the free GitHub Local path, import the schema from your own BuildFlow endpoint.

Use one of these for schema import/generation:

- local reference file: `docs/openapi.chatgpt.json`
- local running endpoint for local schema generation: `http://127.0.0.1:3054/api/openapi`
- public Custom GPT endpoint you control: `https://<your-domain-or-tunnel>/api/openapi`

For actual ChatGPT Actions, the server URL inside the imported schema must be reachable by ChatGPT over HTTPS. A `localhost` server URL is not a valid runtime endpoint for ChatGPT-hosted action calls.

BuildFlow v1.2.13-beta actions return compact structured results for a Fast Repo Assistant Custom GPT. The GPT must narrate progress before each action and summarize compact action results after each action; the schema alone does not make the assistant explain what it is doing. Custom GPT Actions are synchronous external API calls, so BuildFlow keeps progress visible by using small, bounded calls rather than hidden loops or streaming claims.

BuildFlow now enforces GPT-facing deadlines below the platform timeout: status 4s, read-context 8s, apply-file-change 8s, commit-changes 10s, and run-command 12s. If an action cannot finish safely, it returns structured JSON with `status: "timeout"` or `status: "needs_narrower_scope"` and compact diagnostics. This reduces Cloudflare/ChatGPT timeout risk but does not claim to make network or platform outages impossible.

The current Custom GPT surface is exactly these 5 operations. `applyBuildFlowFileChange` carries maintainer sub-operations through `changeType`; `runBuildFlowCommand` is the only raw command/validation/Git execution surface; `commitBuildFlowChanges` batches diff, explicit staging, and commit into one bounded action.

- `getBuildFlowStatus`
- `readBuildFlowContext`
- `applyBuildFlowFileChange`
- `commitBuildFlowChanges`
- `runBuildFlowCommand`

Long-running job or polling routes are intentionally not exposed in this Custom GPT schema. Do not add them to GPT Actions; the GPT-facing product is Fast Repo Assistant only.

Large-file inspection and graph-assisted navigation use bounded modes through `readBuildFlowContext`:

- `graph_context` reads only cached Graphify metadata/report sections when present. It is optional navigation, can be stale, and must be verified with exact source reads before patching.
- `grep_context` finds literal or regex matches in one file with bounded line context.
- `read_range` returns only a requested line range with line numbers.
- `read_symbol` returns the enclosing TypeScript class/function/const block for a known symbol.
- File-specific `search_and_read` with one `paths` entry degrades to bounded grep-style output instead of returning a huge top-of-file excerpt.
- `read_paths` and multi-file `search_and_read` default to 4 KB per file, at most 5 paths, and metadata-only refusal for files over 100 KB. Use focused modes for those files.

## Notes

- Do not import legacy context actions such as `setBuildFlowContext`.
- Keep the imported schema aligned with `docs/CUSTOM_GPT_INSTRUCTIONS.md`.
- Use Bearer API key auth with `Authorization: Bearer <BUILDFLOW_ACTION_TOKEN>`.
- Older per-action OpenAPI fragments are historical/reference material unless a release note says otherwise.

## Verification

- Run `pnpm verify:gpt-contract` after regenerating the schema file.
- The verifier enforces exactly 5 operations, no `/api/actions/agent/*` routes, focused read modes, small read caps, and timeout/deadline language.
- `readBuildFlowContext` mode `prepare_task_context` is deterministic source-index context prep. It does not call local AI.
- If the root schema changes, re-import the Custom GPT actions in the OpenAI Custom GPT editor.
- Start a new chat after reimporting so the GPT uses the updated action schema.
- Restarting BuildFlow Local alone is not enough to update a previously imported GPT action definition.
- Activity metadata changes also require a schema reimport if the OpenAPI contract changes.
- Update [`docs/CUSTOM_GPT_INSTRUCTIONS.md`](../CUSTOM_GPT_INSTRUCTIONS.md) with the narration rules so the assistant explains what BuildFlow is checking, reading, preflighting, changing, blocking, verifying, and what needs confirmation.
