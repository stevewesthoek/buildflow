# BuildFlow Custom GPT Action Imports

For the free GitHub Local path, import the schema from your own BuildFlow endpoint.

Use one of these:

- local reference file: `docs/openapi.chatgpt.json`
- local running endpoint: `http://127.0.0.1:3054/api/openapi`
- public Custom GPT endpoint you control: `https://<your-domain-or-tunnel>/api/openapi`

BuildFlow v1.2.13-beta actions return structured `activity` fields. The GPT must be instructed to surface those summaries in conversation; the schema alone does not make the assistant narrate progress.

The Custom GPT surface is exactly these 11 operations. `applyBuildFlowFileChange` carries maintainer sub-operations through `changeType`; `runBuildFlowCommand` is the only command/validation/Git execution surface; Agent Mode operations expose a compact dashboard-visible job ledger.

- `getBuildFlowStatus`
- `listBuildFlowSources`
- `getBuildFlowActiveContext`
- `setBuildFlowActiveContext`
- `inspectBuildFlowContext`
- `readBuildFlowContext`
- `runBuildFlowCommand`
- `startBuildFlowAgentJob`
- `getBuildFlowAgentJob`
- `writeBuildFlowArtifact`
- `applyBuildFlowFileChange`

## Notes

- Do not import legacy context actions such as `setBuildFlowContext`.
- Keep the imported schema aligned with `docs/CUSTOM_GPT_INSTRUCTIONS.md`.
- Use Bearer API key auth with `Authorization: Bearer <BUILDFLOW_ACTION_TOKEN>`.
- Older per-action OpenAPI fragments are historical/reference material unless a release note says otherwise.

## Verification

- Run `pnpm verify:gpt-contract` after regenerating the schema file.
- If the root schema changes, re-import the Custom GPT actions in the OpenAI Custom GPT editor.
- Start a new chat after reimporting so the GPT uses the updated action schema.
- Restarting BuildFlow Local alone is not enough to update a previously imported GPT action definition.
- Activity metadata changes also require a schema reimport if the OpenAPI contract changes.
- Update [`docs/CUSTOM_GPT_INSTRUCTIONS.md`](../CUSTOM_GPT_INSTRUCTIONS.md) with the narration rules so the assistant explains what BuildFlow is checking, reading, preflighting, changing, blocking, verifying, and what needs confirmation.
