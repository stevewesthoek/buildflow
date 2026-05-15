# Agentic Goal Mode Upgrade Plan

## Goal

Upgrade BuildFlow Agent Mode so a Custom GPT can accept one broad implementation goal and work through a continuous repo-local loop:

1. document the goal and task plan
2. execute the next task
3. review changed files and validation results
4. update progress documentation
5. repair failures
6. continue until complete or blocked by policy

## Non-negotiable boundaries

BuildFlow must not become unrestricted arbitrary local execution. It must continue to block real secrets, `.env` files, private keys, `.git` internals, dependency folders, generated output, runtime output, logs, path traversal, absolute paths outside a source, and unrestricted shell execution.

Commit, push, destructive cleanup, protected files, dependency changes, migrations, CI/CD, Docker files, and deployment-like commands remain confirmation-gated or policy-gated.

## Implementation

- Extend `AgentJob` with an explicit autonomous documentation/review loop model.
- Add `autonomyLevel`, `documentationPath`, and `reviewEveryStep` metadata.
- Expand the default steps to include goal documentation, task execution, review, documentation update, validation repair, and final report.
- Update local agent start endpoint, web action adapter, and OpenAPI route schema.
- Update Agent Mode product docs.
- Keep Custom GPT instructions under 8,000 characters if they are changed.

## Validation

- Type-check CLI and web packages.
- Verify public scope and write policy.
- Inspect git diff/status.
- Regenerate `docs/openapi.chatgpt.json` after restart if the currently running command allowlist cannot execute the root package script.