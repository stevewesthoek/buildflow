# Decision Log

Durable decisions for buildflow. Append-only archive.

## 2026-04-16 -- Port migration and Cloudflare tunnel

- Decision: Migrate web app from port 3000 to fixed port 3054
- Reason: Avoid conflicts with other dev apps; stable endpoint for Cloudflare tunnel
- Impact: All references updated (package.json, README, docs, OpenAPI); public URL stable at https://buildflow.prochat.tools

## 2026-04-16 -- ChatGPT Custom GPT MVP scope

- Decision: Phase 3 limited to read-only actions (search, read) with no authentication
- Reason: Fast iteration for MVP verification; safe for local testing
- Impact: Confirmed Custom GPT integration works; Phase 3.5 adds combined search-and-read for fewer confirmations

## 2026-04-16 -- OpenAPI 3.1.0 + operationId requirement

- Decision: Use OpenAPI 3.1.0 with operationId for each action
- Reason: ChatGPT requires operationId for Custom Actions (not 3.0.0)
- Impact: Created reusable schemas in components section; compatible with ChatGPT UI

## 2026-04-16 -- Phase 3.5 combined search-and-read action

- Decision: Add search-and-read endpoint to reduce ChatGPT confirmation prompts
- Reason: User feedback: Custom GPT asks for confirmation on every action call; combined action fewer calls
- Impact: New /api/actions/search-and-read (max 3 results capped for safety); all actions remain read-only, no authentication

## 2026-04-17 -- Dual-repo architecture: Brain and Mind (Final)

- Decision: Use symlink `brain/mind/` to write personal captures to Mind vault inbox
- Reason: Architectural separation — brain holds knowledge base; mind holds personal Obsidian vault. Brain-Bridge bridges both via symlink.
- Structure: Brain repo is parent; `brain/mind/` is symlink to `../mind` (separate repo). Brain-Bridge reads from brain root, writes personal notes to `mind/01-inbox/` via symlink.
- Path: Personal note creation writes to `mind/01-inbox/` (via symlink from brain vault perspective) = `/Users/Office/Repos/stevewesthoek/mind/01-inbox/` (real path)
- Safety: Symlink is valid relative path; local agent sees `mind/` as directory within connected vault; writes permitted
- Removed: `.unprocessed/` subfolder (not needed; captures land directly in `01-inbox/` same as n8n workflow); old `brain/notes/inbox/` removed
- Impact: Legacy personal-note writes were routed to the correct inbox; captures co-exist with n8n webhook captures; user reviews all in one place in Obsidian

## 2026-06-04 -- Custom GPT fail-fast action contract

- Decision: Keep the Custom GPT surface to five Fast Repo Assistant actions and enforce short GPT-facing route deadlines: status 4s, read-context 8s, apply-file-change 8s, commit-changes 10s, run-command 12s.
- Reason: OpenAI GPT Actions are synchronous requests with a 45-second timeout; BuildFlow should return compact structured JSON before ChatGPT or Cloudflare times out.
- Impact: Broad reads fail with narrower-scope diagnostics, large files require focused reads, command timeouts are capped at the GPT boundary, and docs/schema/verifier now encode this contract.
