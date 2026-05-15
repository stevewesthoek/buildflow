# Agent Mode persistence and conversation source lock upgrade

## Goal
Make BuildFlow more robust for multi-conversation Custom GPT use and interrupted Agent Mode work.

## Boundaries
- Keep BuildFlow publishable and safe: no arbitrary shell, no silent real .env writes, no secret exposure, no force push, no destructive cleanup without policy/confirmation.
- Treat connected repos as developer sandboxes, but preserve hard secret/path blocks.
- Prefer explicit sourceId over global active context.

## Plan
1. Persist Agent Mode jobs to disk so a new conversation can resume after an interruption or local restart.
2. Add richer Agent Mode lifecycle steps: requirements, roadmap, implementation plan, phases, task execution, review, hardening, validation, docs, commit review, cleanup, final handoff.
3. Add job summaries that explicitly instruct the GPT to keep a progress document updated as the handoff/resume source of truth.
4. Rewrite Custom GPT instructions in compressed LLM policy format under 8,000 characters, preserving existing safety rules and adding conversation source-lock rules.
5. Update public docs to explain OpenAI UI limits: BuildFlow cannot rename ChatGPT conversations or change the native placeholder, but it can create repo-local handoff docs and use source locks.
6. Validate typecheck and GPT action schema contract where available.

## Validation
- git status before/after
- package typecheck where supported
- verify GPT action schema if available through allowlisted commands
- inspect changed files

## Expected schema impact
No required schema change unless adding new action parameters. If only Agent Mode internals and instructions change, the current schema remains usable.
