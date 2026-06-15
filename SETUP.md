# ProChat Workbench Setup Guide

ProChat Workbench is the public product, powered by the BuildFlow engine. Repository names, CLI commands, package scopes, scripts, log prefixes, and API routes continue to use their existing BuildFlow technical identifiers where compatibility requires it.

Canonical hosted endpoint:

```text
https://workbench.prochat.tools
```

Legacy compatibility endpoint:

```text
https://buildflow.prochat.tools
```

Canonical action token variable:

```text
WORKBENCH_ACTION_TOKEN
```

`BUILDFLOW_ACTION_TOKEN` remains supported as a compatibility fallback. Configure only one token variable for a given runtime, prefer `WORKBENCH_ACTION_TOKEN` for new setups, and never commit token values to the repository.

## Local Development Setup

### Prerequisites

- Node.js 18+ and pnpm
- A local Markdown vault (Obsidian, Logseq, or plain folder)

### 1. Install Dependencies

```bash
cd buildflow
pnpm install
```

### 2. Build All Packages

```bash
pnpm build
```

This compiles TypeScript in:
- `packages/shared` → `dist/`
- `packages/cli` → `dist/`

### 3. Set Up the Web App Database

```bash
cd apps/web
cp ../../.env.example .env.local
npx prisma migrate dev
```

This creates `dev.db` (SQLite) with the schema.

### 4. Link the CLI Globally (Optional)

For easier CLI testing:

```bash
cd packages/cli
npm link
```

Now you can run `buildflow` from anywhere.

## Running Locally

### Quick Start: All Services (Recommended)

**Single command to start all three services (agent, relay, web):**

```bash
cd /Users/Office/Repos/stevewesthoek/buildflow
./buildflow-orchestrator.sh start
```

This starts:
- Agent on http://localhost:3052 (local CLI server)
- Relay on http://localhost:3053 (Docker bridge server)
- Web on http://localhost:3054 (Next.js dashboard)

**Check status anytime:**
```bash
./buildflow-orchestrator.sh status
```

**Stop all services:**
```bash
./buildflow-orchestrator.sh stop
```

**Full restart (rebuild + restart):**
```bash
./buildflow-orchestrator.sh restart
```

For comprehensive orchestrator documentation, see `ORCHESTRATOR_GUIDE.md`.

---

### Manual Test: Local Agent Only (No Bridge)

**Terminal 1:**
```bash
# From repo root
cd packages/cli
pnpm build
node dist/index.js init
node dist/index.js connect ~/path/to/vault
node dist/index.js index
node dist/index.js serve
```

Output:
```
[BuildFlow] Connected to vault: /Users/you/path/to/vault
[BuildFlow] Indexed 42 files.
[BuildFlow] Local agent running on http://127.0.0.1:3001
```

**Terminal 2:**
```bash
# Test endpoints
curl -X POST http://127.0.0.1:3001/api/search \
  -H "Content-Type: application/json" \
  -d '{"query": "business", "limit": 5}'

curl -X POST http://127.0.0.1:3001/api/read \
  -H "Content-Type: application/json" \
  -d '{"path": "Projects/MyProject.md"}'

curl -X POST http://127.0.0.1:3001/api/create \
  -H "Content-Type: application/json" \
  -d '{"path": "BuildFlow/Inbox/test.md", "content": "# Test\nHello"}'
```

### Test 2: SaaS Bridge (Full Stack)

**Terminal 1 — Web App:**
```bash
cd apps/web
pnpm dev
```
Runs on http://localhost:3054

**Terminal 2 — Local Agent:**
```bash
cd packages/cli
node dist/index.js init
node dist/index.js connect ~/path/to/vault
node dist/index.js login test_api_key
node dist/index.js serve
```

**Terminal 3 — Create User & Test:**
```bash
# Create user
curl -X POST http://localhost:3054/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com"}'

# Response includes apiKey

# Register device
curl -X POST http://localhost:3054/api/devices/register \
  -H "Authorization: Bearer <apiKey>" \
  -H "Content-Type: application/json" \
  -d '{"name": "MacBook"}'

# Now test tool calls
curl -X POST http://localhost:3054/api/tools/search-brain \
  -H "Authorization: Bearer <apiKey>" \
  -H "Content-Type: application/json" \
  -d '{"query": "business goals"}'
```

## Deployment

### Deploy SaaS to Vercel

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy from repo root
vercel

# Set environment variables
vercel env add DATABASE_URL postgresql://...
vercel env add NEXT_PUBLIC_API_URL https://your-domain.com
```

Vercel will:
1. Auto-detect Next.js app
2. Build monorepo
3. Deploy to production URL

### Publish CLI to npm

```bash
cd packages/cli
npm login
npm publish
```

Then users can:
```bash
npm install -g buildflow
```

## Testing the Full Loop

1. **Start local agent:**
   ```bash
   buildflow init
   buildflow connect ~/Obsidian/MyVault
   buildflow serve
   ```

2. **Create user on deployed SaaS:**
   - Go to https://your-domain.com/dashboard
   - Sign up
   - Copy API key

3. **Connect local agent to SaaS:**
   ```bash
   buildflow login <api-key>
   # Restart: buildflow serve
   ```

4. **Test with ChatGPT Custom GPT:**
   - Create new Custom GPT at https://chatgpt.com/gpts/editor
   - Add action schema from: https://your-domain.com/api/openapi
   - Instructions for GPT:

   ```
   You are BuildFlow, an assistant that helps the user ideate with context 
   from their local brain folder.
   
   When the user asks about their business, projects, goals, plans, tech stack, 
   previous notes, or wants to create a plan, search the brain first.
   
   Use search_brain before answering questions that require personal or project context.
   Use read_file only after search results show a relevant file.
   When the user asks to save, create, or export a plan, use create_note or 
   export_claude_plan.
   ```

5. **In ChatGPT:**
   ```
   Search my brain for notes about BuildFlow.
   
   Read the most relevant result.
   
   Create a Claude Code implementation plan and save it to my brain.
   ```

6. **Verify locally:**
   ```bash
   ls ~/Obsidian/MyVault/Handoffs/claude-code/
   # Should see: 2026-04-16-buildflow-mvp.md
   ```

## Troubleshooting

### "No vault connected"
```bash
buildflow connect ~/Obsidian/MyVault
buildflow index
```

### "Cannot find module '@buildflow/shared'"
```bash
cd packages/shared && pnpm build
cd ../../ && pnpm install
```

### WebSocket connection fails
- Check `apiBaseUrl` in `~/.buildflow/config.json`
- Make sure SaaS bridge is running
- Check CORS settings if cross-origin

### Audit log not found
```bash
mkdir -p ~/.buildflow
```

### TypeScript errors
```bash
pnpm type-check  # in each package
```

## Project Structure for Development

```
buildflow/
├── packages/
│   ├── shared/              # EDIT FIRST (shared types)
│   │   ├── src/
│   │   │   ├── types.ts     # Add new types here
│   │   │   ├── schemas.ts   # Add Zod schemas
│   │   │   └── constants.ts
│   │   └── package.json
│   └── cli/
│       ├── src/
│       │   ├── agent/       # EDIT: Add new agents/logic
│       │   ├── commands/    # EDIT: Add new CLI commands
│       │   ├── utils/       # EDIT: Utilities
│       │   └── index.ts     # ENTRY POINT (don't edit usually)
│       └── package.json
├── apps/
│   └── web/
│       ├── src/
│       │   ├── app/
│       │   │   ├── api/     # EDIT: Add new endpoints
│       │   │   ├── layout.tsx
│       │   │   └── page.tsx
│       │   └── lib/         # EDIT: Core logic (auth, db, bridge)
│       ├── prisma/
│       │   └── schema.prisma # EDIT: Database schema
│       └── package.json
└── README.md
```

## Common Tasks

### Add a new CLI command
1. Create `packages/cli/src/commands/mycommand.ts`
2. Import in `packages/cli/src/index.ts`
3. Add: `program.command('mycommand').action(() => mycommand())`

### Add a new API endpoint
1. Create `apps/web/src/app/api/path/to/route.ts`
2. Implement `export async function POST(request: NextRequest)`
3. Test: `curl http://localhost:3054/api/path/to`

### Add a new database model
1. Edit `apps/web/prisma/schema.prisma`
2. Run: `npx prisma migrate dev --name migration_name`
3. Update `apps/web/src/lib/db.ts` types if needed

## Performance Tips

- Run `pnpm build` before testing (TypeScript → JavaScript)
- Use `pnpm dev` for watch mode during development
- Index refresh is automatic when files are created/appended
- Search is fast (Fuse.js, in-memory index)
- WebSocket keeps connection alive (no polling)

---

**Next:** See `IMPLEMENTATION.md` for architecture details or `README.md` for user-facing docs.
