# OpenAI Custom GPT Action Limits

**Document type:** Authoritative constraints reference — read before changing schema, routes, or instructions  
**Last verified:** 2026-05-21  
**Research method:** OpenAI official docs + community empirical findings (linked below)

> **CRITICAL FOR ALL FUTURE DEVELOPERS:** Every architecture decision in BuildFlow's Custom GPT layer is constrained by these limits. Do NOT implement features that contradict them. This document was written after discovering that server-side agent polling — which BuildFlow previously used — is fundamentally incompatible with Custom GPTs. Read the "What Does NOT Work" section carefully.

---

## Hard Platform Limits

| Constraint | Limit | Source |
|---|---|---|
| Action call timeout | **45 seconds** (hard cutoff, not configurable) | [platform.openai.com/docs/actions/production](https://platform.openai.com/docs/actions/production) |
| Response payload | **100,000 characters** max | [platform.openai.com/docs/actions/production](https://platform.openai.com/docs/actions/production) |
| Request payload | **100,000 characters** max | [platform.openai.com/docs/actions/production](https://platform.openai.com/docs/actions/production) |
| Operations per schema | **30 max** (enforced: "OpenAPI spec can have a maximum of 30 operations") | [community.openai.com/t/openapi-spec-can-have-a-maximum-of-30-operations/586484](https://community.openai.com/t/openapi-spec-can-have-a-maximum-of-30-operations/586484) |
| Schema slots per GPT | **10 schemas** per Custom GPT | [community.openai.com/t/custom-gpt-limits-and-overcoming-them/1061473](https://community.openai.com/t/custom-gpt-limits-and-overcoming-them/1061473) |
| Endpoint summary field | **300 characters** max | [platform.openai.com/docs/actions/production](https://platform.openai.com/docs/actions/production) |
| Parameter description field | **700 characters** max | [platform.openai.com/docs/actions/production](https://platform.openai.com/docs/actions/production) |
| GPT instructions field | **8,000 characters** max | [community.openai.com/t/token-limit-for-custom-gpts/946259](https://community.openai.com/t/token-limit-for-custom-gpts/946259) |
| Streaming responses | **Not supported** — synchronous REST only | Architecture constraint |
| Custom request headers | **Not supported** | [platform.openai.com/docs/actions/production](https://platform.openai.com/docs/actions/production) |
| Images/video in payload | **Not supported** | [platform.openai.com/docs/actions/production](https://platform.openai.com/docs/actions/production) |
| TLS requirement | TLS 1.2+ on port 443 | [platform.openai.com/docs/actions/production](https://platform.openai.com/docs/actions/production) |
| HTTP methods supported | **GET, POST** (PATCH unreliable in practice) | Community reports |

---

## The Single Most Important Architectural Constraint

> **Custom GPT Actions are synchronous REST calls. Each individual call must complete and return within 45 seconds. There is no streaming, no webhooks, no server-sent events, no background jobs, and no reliable polling.**

This has one unavoidable consequence for agent-style behavior:

**You cannot implement the agent loop on the server. The agent loop must live in the GPT instructions.**

---

## What DOES Work: GPT-Driven Sequential Execution

Custom GPTs CAN call multiple actions sequentially within a single conversation turn. OpenAI explicitly supports and documents this pattern — their own weather.gov example requires two sequential calls (get grid point → get forecast).

**Source:** [platform.openai.com/docs/actions/getting-started](https://platform.openai.com/docs/actions/getting-started)

This means the correct architecture for "agent mode" in a Custom GPT is:

```
GPT instructions define the loop:
  1. Read relevant files   → readBuildFlowContext
  2. Apply the change      → applyBuildFlowFileChange
  3. Validate              → runBuildFlowCommand (git_diff_stat, type_check_web)
  4. On success            → proceed immediately to next task (no user prompt)
  5. All tasks done        → git_add_paths → git_commit → git_push
  6. Stop only if          → requiresConfirmation, double failure, or stack unavailable
```

The backend provides **fast, atomic, bounded tools**. The GPT orchestrates. Each tool call completes in under 30 seconds.

---

## What Does NOT Work: Server-Side Orchestration

BuildFlow previously attempted server-side agent orchestration:

- `POST /api/actions/agent/start` — start a server-side job  
- `POST /api/actions/agent/status` — poll for job status  
- `POST /api/actions/agent/manage` — control job lifecycle  
- `POST /api/actions/agent/control` — pause/resume/cancel  
- `POST /api/actions/agent/execute-task` — execute one task server-side  

**Why this approach fails with Custom GPTs:**

1. **Polling is unreliable.** The model does not maintain guaranteed conversational context across arbitrary polling calls. After extended use (~1 hour), context degrades. Community confirmation: [community.openai.com/t/gpt-actions-issues-wish-list/641228](https://community.openai.com/t/gpt-actions-issues-wish-list/641228)

2. **No background job support.** A long-running backend job has no mechanism to push results back to ChatGPT. The GPT must actively poll, which is fragile.

3. **45-second hard cutoff.** Any backend chain that takes longer than 45 seconds fails silently with a generic "Tool Error". There is no way to extend this limit.

4. **No streaming.** You cannot stream partial progress back from an action endpoint. The full response must be assembled before returning.

**Decision (2026-05-21):** The server-side agent routes (`/api/actions/agent/*`) remain as internal backend infrastructure available to CLI and dashboard tools. They are **not exposed in the Custom GPT schema** and should not be. The Custom GPT uses the sequential action pattern exclusively.

---

## BuildFlow Schema — Current Operations

**Total: 5 operations** (hard limit: 30)

| `operationId` | Method | Endpoint | Purpose |
|---|---|---|---|
| `getBuildFlowStatus` | GET | `/api/actions/status` | Connection + sources + active context |
| `setBuildFlowActiveContext` | POST | `/api/actions/status` | Set which source(s) to work with |
| `readBuildFlowContext` | POST | `/api/actions/read-context` | Read files, search, list structure |
| `applyBuildFlowFileChange` | POST | `/api/actions/apply-file-change` | Write: create / overwrite / patch / append / delete / move |
| `runBuildFlowCommand` | POST | `/api/actions/run-command` | Allowlisted git + validation commands |

All operations use `x-openai-isConsequential: false` because the backend write policy enforcement is more precise than the ChatGPT confirmation UI.

---

## Timeout Budget Through the Full Call Chain

Call chain: **ChatGPT → Cloudflare Tunnel → Next.js :3054 → Local Agent :3052**

| Operation | Max recommended `timeoutMs` | Notes |
|---|---|---|
| Status check | 5,000 | Should always be fast |
| File read (1–3 files) | 10,000 | Depends on file size |
| Search | 15,000 | Depends on index size |
| File write | 10,000 | Should be fast |
| `git_status_short` | 5,000 | Fast |
| `git_diff_stat` | 10,000 | Slow on large repos |
| `type_check_web` | 25,000 | TypeScript compilation |
| `git_commit` + `git_push` | 20,000 | Network-dependent |

**BuildFlow internal timeout:** 30,000 ms — leaves 15 seconds margin before the 45-second platform cutoff. Cloudflare tunnel adds ~100–300 ms overhead.

---

## Known User-Facing Issues That Cannot Be Fixed From BuildFlow

**"Streaming interrupted" / "Message incomplete"**
This is a ChatGPT platform issue, not a BuildFlow timeout. ChatGPT streams its *text generation* to the browser as tokens arrive. If that stream drops (network blip, OpenAI infra hiccup), the browser shows "streaming interrupted" — but this has nothing to do with action call timeouts. BuildFlow's backend returns in under 200ms, nowhere near the 45s limit. There is no keepalive, heartbeat, or partial response mechanism available on the Custom GPT action interface. Do not attempt to implement one — it is architecturally impossible with synchronous REST actions.

**Perceived slowness between action calls**
Each action call is ~100ms on our backend. The 20–60 second waits the user experiences are ChatGPT's own model inference time (reasoning before calling, processing response after). This is irreducible from BuildFlow's side. The only mitigation is switching the Custom GPT's model to GPT-4o mini (faster inference, less reasoning overhead for tool-calling tasks).

**What to put in Custom GPT instructions vs. what not to**
- ✅ Put in: action names, execution order, stop conditions, search/write examples, commit rules, isolation rules
- ✅ Put in: one-line progress narration rule (low token cost, high UX benefit)
- ❌ Do not put in: verbose examples that consume the 8K limit without behavioral benefit
- ❌ Do not put in: retry logic, polling loops, or anything that adds action calls without necessity
- ❌ Do not put in: instructions that only describe what the GPT already does by default (it wastes the character budget)

## Best Practices

From [platform.openai.com/docs/actions/production](https://platform.openai.com/docs/actions/production) and community findings:

1. Keep responses under 100K characters — return minimal structured JSON, not prose
2. Target sub-10s response times — the 45s limit is a ceiling, not a goal
3. Use `nextStep` hints in responses — the GPT uses them to choose its next action
4. Use clear, specific `operationId` names — the model uses these to decide which action to call
5. Never call LLMs or slow external APIs from inside an action endpoint
6. Validate at the action boundary — not inside GPT instructions
7. `x-openai-isConsequential: false` removes the "Always Allow" button suppression; only use it when your backend enforces safety

---

*Update this document whenever OpenAI releases new documentation. Do not implement features that contradict these constraints. This document is the source of truth for what the Custom GPT layer can and cannot do.*
