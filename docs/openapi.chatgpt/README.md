# BuildFlow Custom GPT Action Imports

For the free GitHub Local path, import the schema from your own BuildFlow endpoint.

Use one of these for schema import/generation:

- local reference file: `docs/openapi.chatgpt.json`
- local running endpoint for local schema generation: `http://127.0.0.1:3054/api/openapi`
- public Custom GPT endpoint you control: `https://<your-domain-or-tunnel>/api/openapi`

For actual ChatGPT Actions, the server URL inside the imported schema must be reachable by ChatGPT over HTTPS. A `localhost` server URL is not a valid runtime endpoint for ChatGPT-hosted action calls.

BuildFlow v1.2.13-beta actions return compact structured results for a Fast Repo Assistant Custom GPT. The GPT must be instructed to narrate progress before each action; the schema alone does not make the assistant explain what it is doing.

The current Custom GPT surface is exactly these 5 operations. `applyBuildFlowFileChange` carries maintainer sub-operations through `changeType`; `runBuildFlowCommand` is the only raw command/validation/Git execution surface; `commitBuildFlowChanges` batches diff, explicit staging, and commit into one bounded action.

- `getBuildFlowStatus`
- `readBuildFlowContext`
- `applyBuildFlowFileChange`
- `commitBuildFlowChanges`
- `runBuildFlowCommand`

Long-running job or polling routes are intentionally not exposed in this Custom GPT schema. Do not add them to GPT Actions; the GPT-facing product is Fast Repo Assistant only.

Large-file inspection should use bounded focused reads through `readBuildFlowContext`:

- `grep_context` finds literal or regex matches in one file with bounded line context.
- `read_range` returns only a requested line range with line numbers.
- `read_symbol` returns the enclosing TypeScript class/function/const block for a known symbol.
- File-specific `search_and_read` with one `paths` entry degrades to bounded grep-style output instead of returning a huge top-of-file excerpt.

## Notes

- Do not import legacy context actions such as `setBuildFlowContext`.
- Keep the imported schema aligned with `docs/CUSTOM_GPT_INSTRUCTIONS.md`.
- Use Bearer API key auth with `Authorization: Bearer <BUILDFLOW_ACTION_TOKEN>`.
- Older per-action OpenAPI fragments are historical/reference material unless a release note says otherwise.

## Verification

- Run `pnpm verify:gpt-contract` after regenerating the schema file.
- `readBuildFlowContext` mode `prepare_task_context` is deterministic source-index context prep. It does not call local AI.
- If the root schema changes, re-import the Custom GPT actions in the OpenAI Custom GPT editor.
- Start a new chat after reimporting so the GPT uses the updated action schema.
- Restarting BuildFlow Local alone is not enough to update a previously imported GPT action definition.
- Activity metadata changes also require a schema reimport if the OpenAPI contract changes.
- Update [`docs/CUSTOM_GPT_INSTRUCTIONS.md`](../CUSTOM_GPT_INSTRUCTIONS.md) with the narration rules so the assistant explains what BuildFlow is checking, reading, preflighting, changing, blocking, verifying, and what needs confirmation.
