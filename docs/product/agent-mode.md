# BuildFlow Fast Repo Assistant

**Status:** Active product direction.  
**Architecture:** ChatGPT does the reasoning and coding. BuildFlow provides fast, deterministic local repo tools.

## What BuildFlow Is

BuildFlow is a fast repo assistant for Custom GPTs. It lets ChatGPT work with local files safely and quickly:

1. lock an explicit source
2. prepare or read exact context
3. apply guarded file changes when asked
4. run targeted validation when needed
5. commit explicit changed paths when appropriate
6. stop with a concise result or resume point

This is not an autonomous agent product. The Custom GPT remains the reasoning layer and the coding layer; BuildFlow is the local execution, safety, context, validation, and Git layer.

## Why This Is The Only GPT Workflow

Custom GPT Actions are synchronous external API calls. Every extra action requires ChatGPT to reason, call the endpoint, wait for a full response, parse JSON, and reason again. Long loops create slow responses, timeouts, and context drift.

BuildFlow therefore optimizes for fast, bounded assistance:

```text
Ask → read exact context → answer or patch → targeted validation → optional commit → stop
```

The product should not present a separate agent mode, autonomous mode, polling mode, or server-owned implementation loop.

## Fast Defaults

- Questions: read minimal context and answer. No validation. No commit.
- Small edits: read exact files, patch, validate the smallest relevant command, report or commit.
- Larger goals: create or update a concise plan, complete only the first small safe slice, then stop.
- Task lists: normally complete 1 task per response; up to 3 tightly related small tasks when all paths and validations are clear; never exceed 5.
- Slow or broad work: stop with the next concrete action instead of continuing to loop.

## Custom GPT Action Architecture

The Custom GPT surface is limited to five compact operations:

```text
getBuildFlowStatus         -> check connection + sources
readBuildFlowContext       -> deterministic task context / read / search / list
applyBuildFlowFileChange   -> create / overwrite / patch / append / delete_file / move
commitBuildFlowChanges     -> diff + explicit stage + commit in one call
runBuildFlowCommand        -> git status, diff, type-check, validation, optional push
```

These actions are the whole GPT-facing product surface. Shared dashboard context changes are not exposed to the GPT. Add new GPT actions only when they reduce action chatter through deterministic, bounded work.

## Conversation Isolation

Every repo action requires an explicit `sourceId`. The GPT must lock the repo at the start of the conversation and keep passing the same source ID unless the user explicitly changes it.

Global active context is a dashboard convenience only. It must not be used as implicit scope for repo reads, writes, validation, or commits.

## Validation Policy

Validation is important, but it should not turn simple assistance into a slow loop.

- Run validation after code, config, package, schema, or command-runner changes.
- Prefer the smallest relevant validation command.
- Do not run type checks after pure assessment or read-only questions.
- Do not run broad test suites unless the user asked or the change requires them.
- Treat slow validation as a stopping point with clear evidence and a next action.

## Commit Policy

Commit only explicit paths. Use `commitBuildFlowChanges` to collapse diff, staging, and commit into one bounded action.

Push only when the user explicitly asks.

## Tracked Static Asset Deletion

BuildFlow may delete an already tracked static/binary asset only when the user explicitly approved that exact deletion. The delete must be `delete_file`, the file must be tracked by Git, the path must not be secret-sensitive or protected, and staging/commit must name the exact deleted path.

This is repo-agnostic and applies to safe static/document asset paths such as PDFs, images, video, audio, archives, and fonts. Creation, overwrite, and modification of binary/static assets remain blocked unless a separate policy explicitly supports them.

## Stop Conditions

Stop and report a concise result when:

1. the requested answer is complete
2. a patch and its targeted validation are complete
3. a write requires confirmation
4. the same validation fails twice after repair
5. the local stack is unavailable
6. the next task is ambiguous, broad, slow, or larger than the task budget
7. the user asks to stop

## What Not To Build Into GPT Actions

Do not add these to the Custom GPT path:

- server-side autonomous coding loops
- long-running job polling
- local LLM calls inside action routes
- OpenAI API, Responses API, Agents SDK, or separate model runtimes
- broad unrestricted shell access
- large status snapshots
- repeated read/search loops that could be replaced by one exact read or deterministic macro-action

Internal dashboard or CLI experiments must not redefine the Custom GPT product direction. The GPT-facing direction is Fast Repo Assistant only.

## Optimization Rule

The fastest BuildFlow is not more agentic. It is fewer, smaller, clearer tool calls.

Good:
- compact task context prep
- exact multi-file reads
- write policy preflight
- targeted validation
- commit-specific-paths action
- compact diagnostics on demand

Bad:
- autonomous-agent branding
- polling loops
- local AI in GPT-facing actions
- broad unrestricted shell
- repeated status endpoints that return large state
