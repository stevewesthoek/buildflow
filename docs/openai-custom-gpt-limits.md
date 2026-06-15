# OpenAI Custom GPT Action Limits

**Document type:** Authoritative constraints reference — read before changing schema, routes, or instructions  
**Last verified:** 2026-06-15
**Research method:** Current official OpenAI docs for action timeout, payload, schema, authentication, Preview testing, and GPT action setup constraints

> **CRITICAL FOR ALL FUTURE DEVELOPERS:** Every architecture decision in BuildFlow's Custom GPT layer is constrained by these limits. Do NOT implement features that contradict them. This document was written after discovering that server-side agent polling — which BuildFlow previously used — is fundamentally incompatible with Custom GPTs. Read the "What Does NOT Work" section carefully.

---

## Hard Platform Limits

| Constraint | Limit | Source |
|---|---|---|
| Action call timeout | **45 seconds** (hard cutoff, not configurable) | [platform.openai.com/docs/actions/production](https://platform.openai.com/docs/actions/production) |
| Response payload | **Less than 100,000 characters** | [platform.openai.com/docs/actions/production](https://platform.openai.com/docs/actions/production) |
| Request payload | **Less than 100,000 characters** | [platform.openai.com/docs/actions/production](https://platform.openai.com/docs/actions/production) |
| Endpoint summary field | **300 characters** max | [platform.openai.com/docs/actions/production](https://platform.openai.com/docs/actions/production) |
| Endpoint description field | **300 characters** max | [platform.openai.com/docs/actions/production](https://platform.openai.com/docs/actions/production) |
| Parameter description field | **700 characters** max | [platform.openai.com/docs/actions/production](https://platform.openai.com/docs/actions/production) |
| GPT instructions field | **BuildFlow target: under 8 KB** | local verifier |
| Streaming responses | **Not supported** — synchronous REST only | Architecture constraint |
| Custom request headers | **Not supported** | [platform.openai.com/docs/actions/production](https://platform.openai.com/docs/actions/production) |
| Images/video in payload | **Not supported** | [platform.openai.com/docs/actions/production](https://platform.openai.com/docs/actions/production) |
| TLS requirement | TLS 1.2+ on port 443 | [platform.openai.com/docs/actions/production](https://platform.openai.com/docs/actions/production) |
| Apps vs Actions | A GPT can use either apps or actions, not both at the same time | [help.openai.com/en/articles/9442513-configuring-actions-in-gpts](https://help.openai.com/en/articles/9442513-configuring-actions-in-gpts) |
| Pro mode | Actions are not available for Pro mode | [help.openai.com/en/articles/9442513-configuring-actions-in-gpts](https://help.openai.com/en/articles/9442513-configuring-actions-in-gpts) |

---

## Official Sources Checked On 2026-06-15

- **Production notes on GPT Actions** — OpenAI Developers, update date not shown on page. Confirms 45-second round-trip timeout, 100,000-character request/response payload limits, TLS 1.2+ on port 443, OpenAPI description/summary/parameter description limits, text-only payloads, no custom headers, and consequential flag behavior.
- **Configuring actions in GPTs** — OpenAI Help Center, updated 24 days ago. Confirms actions require authentication configuration plus OpenAPI schema, operation IDs identify actions, schema can be pasted/imported/started from examples, and actions should be tested in Preview.
- **Creating and editing GPTs** — OpenAI Help Center, updated 3 days ago. Confirms GPT instructions, actions, recommended models, Preview testing, save/update/versioning, and the web-only GPT editing flow.
- **Troubleshooting GPTs** — OpenAI Help Center, updated 11 days ago. Confirms Preview testing as the first troubleshooting path and confirms apps/actions availability and workspace-domain checks.
- **GPTs in ChatGPT** — OpenAI Help Center, updated 12 days ago. Confirms GPTs can include instructions, knowledge, capabilities, apps, and actions, and that a GPT can use either apps or actions but not both.

## The Single Most Important Architectural Constraint

> **Custom GPT Actions are synchronous REST calls. Each individual call must complete and return within 45 seconds. There is no streaming, no webhooks, no server-sent events, no background jobs, and no reliable polling.**

This has one unavoidable consequence for BuildFlow:

**BuildFlow must be a fast repo assistant, not an autonomous agent mode.**

---

## What DOES Work: Fast Repo Assistance

Custom GPTs CAN call multiple actions sequentially within a single conversation turn. OpenAI explicitly supports and documents this pattern — their own weather.gov example requires two sequential calls (get grid point → get forecast).

**Source:** [platform.openai.com/docs/actions/getting-started](https://platform.openai.com/docs/actions/getting-started)

This means the correct architecture for repo work in a Custom GPT is fast, bounded assistance:

```
GPT instructions define a small assistant workflow:
  1. Read exact context    → readBuildFlowContext
  2. Answer or patch       → applyBuildFlowFileChange only when editing
  3. Validate when useful  → runBuildFlowCommand for the smallest relevant check
  4. Commit when ready     → commitBuildFlowChanges for explicit paths
  5. Stop                  → concise result, validation evidence, or resume point
```

The backend provides **fast, atomic, bounded tools**. ChatGPT reasons and codes. Each tool call should complete quickly and return compact proof.

BuildFlow intentionally does not use the OpenAI API, Responses API, or Agents SDK. Therefore the Custom GPT is the only model. Do not simulate a separate runtime with polling-heavy Custom GPT Actions.

---

## What Does NOT Work: Server-Side Orchestration

BuildFlow previously attempted server-side agent orchestration:

- `POST /api/actions/agent/start` — start a server-side job  
- `POST /api/actions/agent/status` — poll for job status  
- `POST /api/actions/agent/manage` — control job lifecycle  
- `POST /api/actions/agent/control` — pause/resume/cancel  
- `POST /api/actions/agent/execute-task` — execute one task server-side  

**Why this approach fails with Custom GPTs:**

1. **Polling is the wrong shape.** A Custom GPT action is a synchronous request/response. A background job has no supported way to push progress back into the GPT, so polling adds action chatter and delay.

2. **No background job support.** A long-running backend job has no mechanism to push results back to ChatGPT. The GPT must actively poll, which is fragile.

3. **45-second hard cutoff.** Any backend chain that takes longer than the documented action timeout is outside the Custom GPT action contract.

4. **No streaming.** You cannot stream partial progress back from an action endpoint. The full response must be assembled before returning.

**Decision (2026-05-29):** Long-running job routes such as `/api/actions/agent/*` are not the Custom GPT integration. They must not be exposed in the GPT schema, marketed as a GPT-facing mode, or used to encourage polling. The Custom GPT path is Fast Repo Assistant only.

---

## BuildFlow Schema — Current Operations

**BuildFlow internal payload policy:** keep every GPT-facing request and response at or below 80,000 characters and 80,000 UTF-8 bytes unless a lower route-specific budget is documented. The internal boundary is deliberately below the OpenAI limit so action payloads remain well clear of the platform cutoff.

**Total: 5 operations** (hard limit: 30)

| `operationId` | Method | Endpoint | Purpose |
|---|---|---|---|
| `getBuildFlowStatus` | GET | `/api/actions/status` | Connection + sources |
| `readBuildFlowContext` | POST | `/api/actions/read-context` | Read files, focused large-file context, search, list structure, or prepare task context |
| `applyBuildFlowFileChange` | POST | `/api/actions/apply-file-change` | Write: create / overwrite / patch / append / delete / move |
| `commitBuildFlowChanges` | POST | `/api/actions/commit-changes` | Diff + explicit stage + commit in one call |
| `runBuildFlowCommand` | POST | `/api/actions/run-command` | Allowlisted git + validation commands |

The GPT schema does not expose shared dashboard context setters. The GPT locks a `sourceId` conversationally and passes it explicitly on every repo action.

All operations use `x-openai-isConsequential: false` because the backend write policy enforcement is more precise than the ChatGPT confirmation UI.

---

## Timeout Budget Through the Full Call Chain

Call chain: **ChatGPT → Cloudflare Tunnel → Next.js :3054 → Local Agent :3052**

BuildFlow does not use the whole 45-second platform window. The GPT-facing web routes enforce shorter deadlines and return structured JSON first.

| Operation | BuildFlow route deadline | Backend/process default | Notes |
|---|---|---|
| Status check | 4,000 ms | 1.5-3.5s subcalls | Should always be fast |
| `readBuildFlowContext` | 8,000 ms | bounded by remaining route budget | Search/list/read defaults are capped |
| `applyBuildFlowFileChange` | 8,000 ms | bounded by remaining route budget | Writes are guarded and verified |
| `commitBuildFlowChanges` | 10,000 ms | 2s diff, 2.5s add, 4.5s commit | Explicit paths only |
| `runBuildFlowCommand` | 12,000 ms | 5s fast commands, 8s slow defaults, 12s max | Slow validation should be a separate prompt |

**BuildFlow internal policy:** route deadline first, backend fetch timeout second, command process timeout third. If any layer cannot finish safely, return JSON with `status:"timeout"` or `status:"needs_narrower_scope"` and compact diagnostics.

Read-context hard caps:

- search/list limit defaults to 5 and is capped at 5 for GPT use
- `read_paths` and multi-file reads accept at most 5 paths
- `maxBytesPerFile` defaults to 4000 and is capped at 4000 for GPT use
- files over the internal GPT payload boundary return metadata and a focused-read suggestion, not top-of-file content
- `grep_context` defaults to literal matching; regex is opt-in, length-capped, and rejected when suspiciously broad
- `read_range` and `read_symbol` output is line-bounded and byte-bounded

---

## Known User-Facing Issues That Cannot Be Fixed From BuildFlow

**"Streaming interrupted" / "Message incomplete"**
This is a ChatGPT platform issue, not something BuildFlow can fully control. ChatGPT streams its *text generation* to the browser as tokens arrive. If that stream drops, the browser may show "streaming interrupted." There is no keepalive, heartbeat, or partial response mechanism available on the Custom GPT action interface. Do not attempt to implement one; use smaller actions and fast-fail JSON.

**Perceived slowness between action calls**
When BuildFlow actions return quickly but the chat waits 20-60 seconds, the delay is ChatGPT's own reasoning before/after action calls. BuildFlow can reduce tool loops and payload size, but it cannot make the Custom GPT think faster.

**What to put in Custom GPT instructions vs. what not to**
- ✅ Put in: action names, execution order, stop conditions, search/write examples, commit rules, isolation rules
- ✅ Put in: one-line progress narration rule (low token cost, high UX benefit)
- ❌ Do not put in: verbose examples that consume the 8K limit without behavioral benefit
- ❌ Do not put in: retry logic, polling loops, or anything that adds action calls without necessity
- ❌ Do not put in: instructions that only describe what the GPT already does by default (it wastes the character budget)

## Best Practices

From [platform.openai.com/docs/actions/production](https://platform.openai.com/docs/actions/production) and BuildFlow's local verifier:

1. Keep responses under 100K characters — return minimal structured JSON, not prose
2. Target sub-10s response times — the 45s limit is a ceiling, not a goal
3. Use `nextStep` hints in responses — the GPT uses them to choose its next action
4. Use clear, specific `operationId` names — the model uses these to decide which action to call
5. Never call LLMs or slow external APIs from inside an action endpoint
6. Validate at the action boundary — not inside GPT instructions
7. `x-openai-isConsequential: false` removes the "Always Allow" button suppression; only use it when your backend enforces safety

## OpenAPI Schema Metadata Length Limits (MUST ENFORCE)

**These limits are enforced by OpenAI's CustomGPT UI and will cause import failures or truncation if exceeded.**

| Field | Max Length | Enforcement | Notes |
|---|---|---|---|
| Operation `summary` | 300 chars | Hard limit; schema import fails if exceeded | Clear one-line operation name + key detail |
| Operation `description` | 300 chars | Hard limit; schema import fails if exceeded | Detailed explanation of what the operation does; keep concise and technical |
| Parameter `description` | 700 chars | Hard limit; schema import fails if exceeded | Parameter guidance for the GPT; can be detailed |

**Verification:** `pnpm run verify:gpt-actions` and `pnpm verify:gpt-contract` enforce these via `verify-custom-gpt-actions.mjs`. All generated OpenAPI operation metadata must pass character count checks before commit or GPT editor import.

**Regression note (2026-06-15):** the Custom GPT editor rejected `getWorkbenchStatus` because its operation `description` was 318 characters. The verifier must check operation `summary`, operation `description`, query parameter descriptions, and request-body schema property descriptions. Do not rely on manual review for these limits.

**When adding or updating operations:**
1. Write the `summary` (max 300 chars)
2. Write the `description` (max 300 chars) — if exceeding, trim to essential info
3. Write parameter `description` fields (max 700 chars each)
4. Regenerate `docs/openapi.chatgpt.json`
5. Run `pnpm verify:gpt-contract` to catch violations before import or commit
6. Do not import or commit if verification fails

---

*Update this document whenever OpenAI releases new documentation. Do not implement features that contradict these constraints. This document is the source of truth for what the Custom GPT layer can and cannot do.*
