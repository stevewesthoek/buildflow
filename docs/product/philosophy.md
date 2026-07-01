# ProChat Workbench Philosophy

Status: canonical product philosophy.

## Purpose

ProChat Workbench exists to let people use ChatGPT as the reasoning interface for substantial software work while their own computer remains the execution environment and their local repositories remain the source of truth.

The product is designed to reduce the cost and friction of building software with AI. A user should be able to use a ChatGPT subscription and a Custom GPT to plan, implement, validate, and commit work in local repositories without operating a second paid model API or copying files between browser chat and local tools.

## Core Idea

```text
User goal in ChatGPT
  -> ChatGPT reasons, plans, reviews, and decides
  -> Workbench reads and changes the real local repo
  -> Workbench validates, checkpoints, and commits locally
  -> ChatGPT reviews evidence and continues
```

ChatGPT is the reasoning layer. Workbench is the persistent local execution layer.

## Agentic By Design

Workbench is intended to support autonomous, agentic, looping execution for large goals within the constraints of Custom GPT Actions.

Agentic does not mean keeping one HTTP request open indefinitely. It means preserving the goal and continuing safely through multiple short, checkpointed operations.

Workbench should provide:

- persistent goals and plans
- automatic quick-mode versus goal-mode selection
- deterministic work packets
- asynchronous local execution
- compact status retrieval
- validation and repair checkpoints
- safe auto-commit
- resumability across conversations and restarts
- explicit pause, cancel, and recovery controls

A user should be able to ask for a feature, phase, refactor, or application area in natural language. The Custom GPT should translate that goal into the internal plan and execution pattern automatically.

## Why Previous Agentic Attempts Failed

Earlier approaches repeatedly failed because they tried to create autonomy in the wrong layer.

Common failure patterns were:

1. Holding a GPT Action request open while too much work happened.
2. Using repeated polling as if the Custom GPT could run an endless loop reliably.
3. Asking the user to re-prompt after every small task.
4. Enforcing a universal one-task or three-action limit.
5. Mixing model reasoning, local execution, and status transport inside one synchronous call.
6. Treating stability and autonomy as opposites.
7. Creating job metadata without connecting it to the Custom GPT workflow.

The new philosophy separates these concerns:

```text
short synchronous control calls
+ persistent local run state
+ deterministic asynchronous execution
+ GPT review checkpoints
= stable agentic workflow
```

## Stability Is A Requirement, Not A Competing Goal

The current stable action layer must remain stable.

Individual calls should remain bounded, compact, authenticated, source-scoped, and fail-fast. Large work should be achieved by chaining durable work packets, not by weakening the transport contract.

The product must preserve:

- explicit `sourceId` on repo actions
- compact JSON responses
- bounded reads and writes
- exact-path commits
- secret and protected-path blocking
- idempotent packet execution
- validation before commit
- no default force push
- no hidden external model dependency

## Cost Philosophy

Workbench should save costs by using the ChatGPT interface the user already pays for as the planning and reasoning surface.

The local Workbench runtime should remain deterministic. It should not require a local model, a hosted coding-agent API, or a second reasoning service to complete ordinary workflows.

Optional future integrations may exist, but the core product must work with:

```text
ChatGPT Custom GPT
+ local Workbench runtime
+ local repositories
```

## User Experience Principle

The user should describe outcomes, not orchestration mechanics.

The user should not need to remember terms such as:

- `graph_context`
- work packet
- run ID
- status polling
- exact action names
- commit policy switches

The Custom GPT should infer and apply the optimal workflow.

## Product Promise

ProChat Workbench should make this possible:

> Give ChatGPT a meaningful software goal, let Workbench execute substantial safe portions locally, and return only when review, confirmation, recovery, or final approval is genuinely needed.

## Non-Negotiable Boundaries

Workbench must not:

- claim that a Custom GPT can reason forever without another turn
- hide failed validation
- silently modify unrelated files
- stage the whole repository by default
- auto-push without explicit policy
- bypass secret, key, environment, or protected-path rules
- treat stale Graphify data as source truth
- execute the same packet twice
- continue after repository state diverges from the packet precondition

## Definition Of Success

The philosophy is successfully implemented when a user can request a phase-sized goal and Workbench can:

1. persist the goal and plan
2. execute multiple safe work packets
3. validate each completed slice
4. commit explicit paths when policy permits
5. recover from action or application restarts
6. continue from a new conversation
7. stop only for a real blocker, confirmation, failed recovery, or phase completion

The target experience is not infinite autonomy. It is materially less supervision for materially larger local development outcomes.
