# Contributing to BuildFlow Local

BuildFlow Local is the public GitHub beta priority.
Please keep contributions focused on the free local-first path unless something directly blocks that beta.

## Good contribution areas

- README and onboarding clarity
- dashboard usability for first-time Local users
- Custom GPT setup docs for self-hosted users
- fresh-clone install and verification guidance
- screenshots, demo assets, and launch-readiness docs
- issue templates, discussion guidance, and contribution docs

## How to help

- File setup friction with the provided GitHub issue templates.
- Keep feedback focused on BuildFlow Local public beta readiness.
- Propose small docs or UX improvements that help a new GitHub user clone, run, understand, and share BuildFlow.

## Secrets and logs

- Do not include bearer tokens, env values, or raw app JSON in issues or pull requests.
- Redact any local configuration details before sharing logs or screenshots.

## Before opening a pull request

- Describe the Local beta problem or improvement clearly.
- Mention any verification you ran.
- Keep the change small and focused when possible.

## How to add a new ChatGPT action

All action routes follow a consistent pattern: auth → validate input → execute → respond. Here's how to add a new one:

### 1. Create the route file

Create a new file at `apps/web/src/app/api/actions/{action-name}/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { checkActionAuth } from '@/lib/actionAuth'
import { executeAction } from '@/lib/actions/transport'
import { buildActionErrorEnvelope } from '@/lib/actions/action-response'

export async function POST(request: NextRequest) {
  const auth = checkActionAuth(request)
  if (!auth.valid) return auth.error

  try {
    const body = await request.json()
    const data = await executeAction('/api/your-endpoint', body, auth.bearerToken)
    return NextResponse.json(data)
  } catch (err) {
    return NextResponse.json(
      buildActionErrorEnvelope({
        code: 'ACTION_ERROR',
        message: 'Operation failed',
        details: err instanceof Error ? err.message : String(err)
      }),
      { status: 500 }
    )
  }
}
```

### 2. Add the OpenAPI schema

Edit `apps/web/src/app/api/openapi/route.ts` and add your action under the `paths` object:

```typescript
'/api/actions/{action-name}': {
  post: {
    operationId: 'yourActionName',
    summary: 'Brief description of what this does',
    description: 'Longer explanation of the operation.',
    tags: ['actions'],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              // your request params here
            }
          }
        }
      }
    },
    responses: {
      '200': { description: 'Success response' },
      '400': { description: 'Bad request' },
      '401': { description: 'Unauthorized' }
    }
  }
}
```

### 3. Add activity narration (for ChatGPT feedback)

If your action produces a side effect (read, write, change state), import and use `makeActivity()` and `withActivity()` from `@/lib/actions/gpt`:

```typescript
import { makeActivity, withActivity } from '@/lib/actions/gpt'

// ... in your route
const activity = makeActivity({
  operationId: 'yourActionName',
  phase: 'completed',
  actionLabel: 'What you did',
  userMessage: 'Human-friendly summary for ChatGPT to narrate',
  riskLevel: 'low',
  requiresConfirmation: false,
  verified: true,
  nextStep: 'What to do next'
})

return NextResponse.json(withActivity(data, activity))
```

### 4. For proxy routes (simple pass-through)

If your action just forwards to the local agent with no validation:

```typescript
import { handleProxyAction } from '@/lib/actions/proxy-handler'

export async function POST(request: NextRequest) {
  const auth = checkActionAuth(request)
  return handleProxyAction(request, auth.valid, auth.error, '/api/your-endpoint', auth.bearerToken)
}
```

### 5. For write operations

Write operations require additional guards:

```typescript
import { getSafeActionHttpStatus } from '@/lib/actions/http-status'

// Check for errors in response
if ('error' in data) {
  const status = getSafeActionHttpStatus(data.error)
  return NextResponse.json(buildActionErrorEnvelope({...}), { status })
}

// Verify writes completed
if ((data as { verified?: unknown }).verified !== true) {
  return NextResponse.json(buildActionErrorEnvelope({
    code: 'WRITE_NOT_VERIFIED',
    message: 'Write was not verified on disk'
  }), { status: 502 })
}
```

### Best practices

- **Always check auth first** — no exception handling should bypass `checkActionAuth`.
- **Wrap errors in `buildActionErrorEnvelope`** — ensures consistent error shape for ChatGPT.
- **Add activity for operations with side effects** — ChatGPT needs real-time feedback on what happened locally.
- **Use existing helpers** — `handleProxyAction`, `getSafeActionHttpStatus`, `makeActivity` exist to prevent duplication.
- **Type the request body** — use Fastify generic syntax `<{ Body: YourType }>` for runtime safety checks.
- **Limit output size** — truncate large responses (see `maxBytes` patterns in existing read actions).
- **Test the full path** — verify OpenAPI schema, auth, proxy, error handling before submitting PR.
