# Agent Runtime v1.1 Hardening

## Boundary
Custom GPT remains the reasoning and coding engine. BuildFlow local remains the deterministic control plane for validation, compact progress, safety, and Git workflows.

## Implemented in this pass
- Added dashboard-facing proxy route `apps/web/src/app/api/agent/jobs/control/route.ts` for Agent Runtime pause/resume/cancel/events.
- Extended local Agent Runtime job status responses with compact recent events and byte budget metadata.
- Added dashboard Agent Runtime event visualization through the existing activity stream.
- Added dashboard pause/resume/cancel controls to Agent Mode job cards.
- Kept event payloads compact and reused the existing v1.1 event store instead of adding another dashboard-only state channel.

## Validation plan
- CLI type-check.
- Web type-check.
- JSON schema validation for `docs/openapi.chatgpt.json`.
- GPT action contract verification.
- Git status/diff review before commit and push.

## Notes
The large local server remains a future extraction target, but this pass avoided a risky broad route-file refactor. The practical modularization remains centered on the Agent Runtime/event modules created in v1.1.
