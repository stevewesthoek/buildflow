# ProChat Workbench Custom GPT Action Imports

For the self-hosted GitHub path, import the schema from your own ProChat Workbench endpoint. The Workbench product is powered by the BuildFlow engine, so technical action operation names and contracts remain unchanged.

Use one of these for schema import or generation:

- canonical schema file: `docs/openapi.chatgpt.json`
- local running endpoint for schema generation: `http://127.0.0.1:3054/api/openapi`
- canonical hosted endpoint: `https://workbench.prochat.tools/api/openapi`
- legacy compatibility endpoint: `https://buildflow.prochat.tools/api/openapi`
- another HTTPS endpoint you control: `https://<your-domain-or-tunnel>/api/openapi`

For actual ChatGPT Actions, the server URL inside the imported schema must be reachable by ChatGPT over HTTPS. A `localhost` server URL is not a valid runtime endpoint for ChatGPT-hosted action calls. New imports should use `https://workbench.prochat.tools`; the legacy hostname remains available for compatibility with existing schemas.

ProChat Workbench uses BuildFlow v1.2.13-beta actions to return compact structured results. The GPT must narrate progress before each action and summarize compact action results after each action; the schema alone does not make the assistant explain what it is doing. Custom GPT Actions are synchronous external API calls, so the BuildFlow engine keeps progress visible through small, bounded calls rather than hidden loops or streaming claims.

BuildFlow now enforces GPT-facing deadlines below the platform timeout: status 4s, read-context 8s, apply-file-change 8s, commit-changes 10s, and run-command 12s. If an action cannot finish safely, it returns structured JSON with `status: "timeout"` or `status: "needs_narrower_scope"` and compact diagnostics. This reduces Cloudflare/ChatGPT timeout risk but does not claim to make network or platform outages impossible.

The current canonical Custom GPT surface is exactly these 5 Workbench operations. `applyWorkbenchFileChange` carries maintainer sub-operations through `changeType`; `runWorkbenchCommand` is the only raw command/validation/Git execution surface; `commitWorkbenchChanges` batches diff, explicit staging, and commit into one bounded action. The legacy `buildflow.prochat.tools` compatibility schema keeps the old BuildFlow operation IDs for already-imported GPTs.

- `getWorkbenchStatus`
- `readWorkbenchContext`
- `applyWorkbenchFileChange`
- `commitWorkbenchChanges`
- `runWorkbenchCommand`

Long-running job or polling routes are intentionally not exposed in this Custom GPT schema. Do not add them to GPT Actions; the GPT-facing product is Fast Repo Assistant only.

Large-file inspection and graph-assisted navigation use bounded modes through `readWorkbenchContext`:

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

- When OpenAPI descriptions, operation IDs, parameters, response schemas, authentication, or GPT operating instructions change, the GPT editor update is manual.
- Run `pnpm verify:gpt-contract` after regenerating the schema file.
- The verifier enforces exactly 5 operations, no `/api/actions/agent/*` routes, focused read modes, small read caps, and timeout/deadline language.
- `readWorkbenchContext` mode `prepare_task_context` is deterministic source-index context prep. It does not call local AI.
- If the root schema changes, import `docs/openapi.chatgpt.json` in the Custom GPT editor Actions panel or import from `https://workbench.prochat.tools/api/openapi`.
- If `docs/CUSTOM_GPT_INSTRUCTIONS.md` changes, paste the updated instructions into the GPT editor Instructions field.
- In Preview, test all five canonical operations after any schema or instruction update: `getWorkbenchStatus`, `readWorkbenchContext`, `applyWorkbenchFileChange`, `commitWorkbenchChanges`, and `runWorkbenchCommand`.
- Start a new chat after updating so the GPT uses the updated action schema and instructions.
- Restarting BuildFlow Local alone is not enough to update a previously imported GPT action definition.
- Activity metadata changes also require a schema reimport if the OpenAPI contract changes.
- Update [`docs/CUSTOM_GPT_INSTRUCTIONS.md`](../CUSTOM_GPT_INSTRUCTIONS.md) with the narration rules so the assistant explains what BuildFlow is checking, reading, preflighting, changing, blocking, verifying, and what needs confirmation.
