# BuildFlow Agentic Goal Mode

BuildFlow Agentic Goal Mode is the repo-agnostic path for hands-off implementation loops from a Custom GPT.

It is designed to simulate a Codex-style goal workflow: the user gives one implementation goal, and the Custom GPT continues locally through documentation, task execution, review, validation, repair, progress updates, and final reporting.

## What Agentic Goal Mode can do

A goal-mode job can guide the Custom GPT through this continuous cycle:

1. inspect the selected source
2. document the goal, constraints, assumptions, task list, and validation plan
3. execute the next task with verified repo-local writes
4. review changed files and command output
5. update progress documentation
6. run allowlisted validation commands
7. repair failures
8. repeat until the goal is complete, blocked, or confirmation is required
9. produce a final report with validation evidence and git state

The job tracks:

- `autonomyLevel`: `hands_off_safe` by default
- `documentationPath`: default progress document path
- `reviewEveryStep`: enabled by default
- `maxIterations`: bounded repair/validation loop count
- `autoCommit` and `autoPush`: requested only; still confirmation-gated

## Why this is not unrestricted local access

Agentic Goal Mode deliberately does not grant raw unrestricted machine control. BuildFlow remains a local execution engine with safety rails:

- source-relative reads and writes only
- verified file changes
- allowlisted commands only
- no arbitrary shell
- explicit git staging only
- confirmation-gated commit and push
- no-access blocks for secrets, environment files, private keys, `.git`, dependency folders, build outputs, generated outputs, runtime outputs, logs, path traversal, and binary writes

This preserves the ability to build real applications while avoiding the most dangerous failure modes of an unrestricted browser-to-terminal bridge.

## Confirmation boundaries

Agentic Goal Mode must stop when policy requires confirmation. Examples include:

- dependency or lockfile changes
- migrations
- CI/CD and GitHub workflow files
- Docker files
- destructive deletes
- protected binary assets
- commit or push flows
- deployment-like operations unless a future allowlisted deploy command explicitly supports them

When BuildFlow returns `needs_confirmation`, the Custom GPT must stop and ask. It must not bypass policy.

## Custom GPT workflow

For broad build goals, the Custom GPT should call `startBuildFlowAgentJob` and then continue with existing actions:

- `listBuildFlowSources`
- `inspectBuildFlowContext`
- `readBuildFlowContext`
- `writeBuildFlowArtifact`
- `applyBuildFlowFileChange`
- `runBuildFlowCommand`
- `getBuildFlowAgentJob`

The GPT should update the job state after major milestones and should update the configured progress document after each task review.

## Schema refresh

Because Agentic Goal Mode changes Custom GPT actions, regenerate `docs/openapi.chatgpt.json`, paste the updated schema into the GPT editor, update `docs/CUSTOM_GPT_INSTRUCTIONS.md`, save the GPT, and start a new chat.