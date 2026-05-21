# BuildFlow Agent Mode

**Status:** Active — GPT-driven sequential execution  
**Architecture:** The Custom GPT IS the agent loop. The backend provides atomic tools.

---

## What Agent Mode Is

When the user communicates a plan — a numbered list, a roadmap, multiple tasks described in natural language — the Custom GPT executes every task sequentially without stopping, without asking for permission, and without requiring any special keyword or command to "activate" this mode. Intent is detected from natural language.

After each task completes validation, the GPT commits immediately (not at the end of the whole plan). This keeps the git history clean and creates safe restore points throughout execution.

This is the maximum agent behavior achievable with OpenAI Custom GPT Actions. See `docs/openai-custom-gpt-limits.md` for the authoritative constraints.

---

## Why the Loop Lives in the GPT, Not the Server

**Custom GPT Actions are synchronous REST calls with a 45-second hard timeout per call.** There is no streaming, no webhooks, no background jobs, and no reliable server-push mechanism.

This means:

**Server-side orchestration does not work.** You cannot start a background job on the server, have the GPT poll for status, and expect reliable results. The GPT loses conversational context across arbitrary polling calls. The 45-second timeout means any job that takes longer fails silently. There is no way to push progress back to the chat.

**The correct model:** The GPT's own context window IS the job queue. Each action call returns a structured result with `nextStep`. The GPT reads `nextStep` and makes the next call. No server-side state machine. No polling. No job IDs.

---

## Action Architecture

Five actions. Each is fast, atomic, and bounded within the 30-second internal timeout.

```
getBuildFlowStatus         → check connection + sources (first call only)
setBuildFlowActiveContext  → lock sourceId for this conversation
readBuildFlowContext       → read files / search / list structure
applyBuildFlowFileChange   → write: create / overwrite / patch / append / delete_file / move
runBuildFlowCommand        → git status, diff, type-check, add, commit, push
```

The execution loop per task:

```
readBuildFlowContext (understand what to change)
  ↓
applyBuildFlowFileChange (make the change)
  ↓
runBuildFlowCommand: git_diff_stat (confirm what changed)
  ↓
runBuildFlowCommand: type_check_web (if TypeScript)
  ↓
git_add_paths + git_commit  ← commit after EVERY validated task
  ↓
next task (no user prompt)
  ↓
[all tasks done]
  ↓
runBuildFlowCommand: git_push
```

**Commit per task, not per plan.** Every validated task gets its own commit with a clear message. This means every task completion is a safe restore point. The push happens once at the end after all tasks are done.

---

## Conversation Isolation & Source Locking

Each Custom GPT conversation locks to one or more repos independently. This is enforced at two levels:

**Instructions level:** The GPT never auto-selects the globally active source. On first message, it calls `getBuildFlowStatus?include=sources` to list available repos, and either locks to the repo the user named or asks "Which repo should I work in?". Once locked, `sourceId` never changes unless the user explicitly requests it.

**Backend level:** Every write/read/command action requires an explicit `sourceId`. The backend refuses to fall back to global active context (`requireExplicitSourceId` in `gpt.ts`). This means even if another conversation changes the globally active source, it has zero effect on this conversation.

This design means two concurrent conversations can each be working on different repos simultaneously with no cross-contamination.

---

## Stop Conditions

The GPT stops mid-plan only for:

1. `requiresConfirmation: true` in an `applyBuildFlowFileChange` response — path is protected (e.g. lockfiles, GitHub workflows). Pause and describe what needs confirmation.
2. Two consecutive validation failures on the same file — report blocked with diagnosis.
3. `connected: false` in any response — local stack unavailable. Report recovery steps.

All other results (including non-fatal warnings) are handled inline.

---

## Backend Agent Routes

The following routes exist in the backend and are used by the CLI and dashboard:

```
/api/actions/agent/start
/api/actions/agent/status
/api/actions/agent/manage
/api/actions/agent/control
/api/actions/agent/execute-task
```

**These are NOT exposed in the Custom GPT schema.** They serve the local dashboard and CLI workflows where long-running jobs are viable. They are not part of the ChatGPT integration and should not be added to the OpenAPI schema.

---

## Response Design

Every action response includes:
- `ok` / `verified` — did it succeed?
- `nextStep` — what the GPT should do immediately after (no user prompt needed)
- Minimal payload — under 10KB, stripped of diagnostics and timing data

The `nextStep` field is the key to seamless plan execution. It tells the GPT exactly what action to make next without requiring it to re-reason from scratch.

---

## Limitations (Hard Constraints from OpenAI)

See `docs/openai-custom-gpt-limits.md` for the full reference. Key constraints that shape this architecture:

- 45-second timeout per action call → internal timeout is 30 seconds
- No streaming → full response must be ready before returning
- No server-push → GPT must drive all sequencing
- 100K character response limit → strip all non-essential fields before responding
- 8,000 character instruction limit → instructions must be concise; use `nextStep` to reduce GPT reasoning overhead
