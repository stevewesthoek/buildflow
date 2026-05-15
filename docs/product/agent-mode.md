# BuildFlow Agentic Goal Mode

BuildFlow Agentic Goal Mode is the repo-agnostic path for long, hands-off implementation loops from a Custom GPT.

It is designed to feel like a goal-driven coding agent: the user gives one implementation goal, BuildFlow locks the source repo, creates a persistent handoff, and the Custom GPT continues through requirements, planning, implementation, review, validation, repair, hardening, documentation, and git review until the goal is complete, blocked, failed, or confirmation-required.

## What changed

Agent Mode jobs are now designed around persistent handoff state:

- jobs are stored outside the chat process so a later conversation can list or resume them
- each job exposes a `handoffPath` / `documentationPath`
- the GPT is instructed to update that handoff after each meaningful chunk
- the handoff records completed work, next task, validation evidence, blockers, rollback notes, and resume instructions
- `lastKnownGitStatus` can be attached to job status updates

This means a user should be able to start a new conversation and say: “resume where you left off on source X.” The GPT should list jobs, read the handoff path, verify sourceId and git status, then continue from the next unchecked task.

## Agent Mode lifecycle

A high-quality Agent Mode loop is:

1. lock the source scope
2. capture requirements and acceptance criteria
3. create a roadmap
4. write or update the implementation plan
5. break the roadmap into phases and tasks
6. execute one meaningful chunk
7. review changed files and command output
8. update the handoff document
9. run validation
10. repair failures and repeat
11. harden edge cases, tests, docs, and maintainability
12. clean up temporary work
13. review git status, staged files, and cached diffs
14. stop for commit/push confirmation when needed
15. produce a final handoff

The goal is quality over speed. Long-running work should prefer small verified chunks, careful review, and persistent progress over chatty step-by-step narration.

## Conversation source locking

Multiple Custom GPT conversations can be open at the same time. BuildFlow’s global active context can be changed by another chat, so Agent Mode must not rely on global active context for critical work.

The Custom GPT should:

- establish a conversation-local `conversationSourceId`
- pass `sourceId` explicitly to inspect, read, write, command, and agent calls
- avoid switching sources unless the user explicitly asks
- verify sourceId before writes, commands, commit, push, or resuming a job
- mention and correct active-context mismatches instead of silently following them

A future implementation can add true session-scoped contexts, but explicit sourceId locking is the current robust pattern.

## OpenAI Custom GPT UI limits

BuildFlow cannot currently rename ChatGPT’s native conversation titles, native batch names, or the input placeholder from inside the Custom GPT action schema.

Those UI elements are controlled by OpenAI’s ChatGPT interface, not by BuildFlow’s local repo code.

Practical alternatives:

- start prompts with the source name, such as `Use BuildFlow Agent Mode on source tradebot`
- keep one source per conversation
- use a clear handoff document path per repo or goal
- ask BuildFlow to create repo-local progress docs with source and goal names
- use the conversation’s manual rename feature in ChatGPT if available in the client

BuildFlow can make source scope explicit in action outputs and persistent docs, but it cannot directly rename the OpenAI-hosted chat UI.

## Sandbox-trusted, not reckless

BuildFlow is meant for developer-controlled repos. A connected repo can be treated as a sandbox for implementation work, but the GPT should still act like a careful senior developer.

That means:

- inspect before editing
- work from facts, not assumptions
- make small reversible changes
- keep rollback notes for risky refactors
- validate before moving on
- update the handoff frequently
- stop for no-access paths and confirmation gates

BuildFlow intentionally keeps hard blocks for secrets, real environment files, private keys, `.git`, dependency folders, generated/runtime/log outputs, path traversal, and unsupported binary writes. This keeps the public product safe while still allowing real app development inside connected repos.

## Commands and permissions

Agent Mode can use the allowlisted command runner:

- git status, diff, branch, and log checks
- cached git diff checks
- explicit `git add -- <paths>`
- confirmation-gated commit and push
- JSON validation
- package scripts and tests
- marker tests where supported
- named security scans
- BuildFlow verification commands

BuildFlow does not expose arbitrary shell by default. New command capability should be added as named, source-relative, auditable command kinds instead of unrestricted terminal execution.

## Confirmation boundaries

Agent Mode must stop when BuildFlow returns `needs_confirmation` or `REQUIRES_EXPLICIT_CONFIRMATION`.

Examples:

- dependency and lockfile changes
- migrations
- CI/CD and GitHub workflow files
- Docker files
- destructive deletes
- protected binary assets
- commit or push flows
- deployment-like operations unless a future allowlisted deploy command supports them

The GPT must not bypass policy.

## Effective prompt

```text
Use BuildFlow Agentic Goal Mode on source <sourceId>.

Goal:
<describe the feature, app, refactor, repair, or cleanup>

Work hands-off until complete, blocked, failed, or confirmation-required.
Create or update a persistent handoff document.
Continue through requirements, roadmap, implementation plan, phased tasks, execution, review, validation, repair, hardening, cleanup, and final handoff.
Pass sourceId explicitly on every action.
Do not commit or push unless I explicitly confirm.
```

## Resume prompt

```text
Resume Agent Mode on source <sourceId> where it left off.
Find the latest Agent Mode job and handoff document, read it, verify git status, identify the next unchecked task, and continue hands-off until complete, blocked, failed, or confirmation-required.
```

## Schema refresh

If Agent Mode fields or command parameters change, regenerate `docs/openapi.chatgpt.json`, paste the updated schema into the GPT editor, update `docs/CUSTOM_GPT_INSTRUCTIONS.md`, save the GPT, and start a new chat.
