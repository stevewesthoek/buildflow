#!/bin/bash

set -e

DEMO_VAULT="/tmp/buildflow-demo"
REPO_ROOT="/Users/Office/Repos/prochattools/saas/prochat-workbench"

echo ""
echo "╔════════════════════════════════════════╗"
echo "║  BuildFlow MVP — Local Demo Setup   ║"
echo "╚════════════════════════════════════════╝"
echo ""

# Step 1: Create vault
echo "📁 Step 1: Creating test vault..."
mkdir -p "$DEMO_VAULT"
mkdir -p "$DEMO_VAULT/BuildFlow/Inbox"

# Create test files
cat > "$DEMO_VAULT/business.md" << 'EOF'
# Business Context

BuildFlow connects local Markdown vaults to ChatGPT.

## Goals
- Search local notes from ChatGPT
- Create plans and save them back
- Keep everything local and private

## Key Features
- Full-text search with Fuse.js
- Create and append files
- Export Claude Code plans
- Audit logging

## Target Users
- Note-takers who use ChatGPT
- People with Obsidian vaults
- Teams building knowledge bases
EOF

cat > "$DEMO_VAULT/architecture.md" << 'EOF'
# System Architecture

## Components

### Local CLI Agent
- Node.js executable
- Runs on your machine
- No cloud upload
- Direct file access

### Search Engine
- Fuse.js full-text search
- Fuzzy matching
- Instant results
- Cached index

### HTTP Server
- Fastify framework
- Port 3001
- RESTful endpoints
- Request logging

### Security
- Path traversal protection
- No file deletion
- Read/create/append only
- Audit trail

## Data Flow

User → CLI → Vault (local files)
      ↓
   HTTP Server (port 3001)
      ↓
   Search/Read/Create endpoints
EOF

cat > "$DEMO_VAULT/roadmap.md" << 'EOF'
# BuildFlow Roadmap

## MVP (Phase 1) — Local Agent ✅
- [x] CLI commands
- [x] Vault connection
- [x] File indexing
- [x] Search
- [x] Read files
- [x] Create notes
- [x] Export plans

## Phase 2 — SaaS Bridge
- [ ] WebSocket bridge server
- [ ] Device registration
- [ ] API authentication
- [ ] Relay tool calls

## Phase 3 — ChatGPT Integration
- [ ] Custom GPT Action
- [ ] OpenAPI schema
- [ ] Conversation context
- [ ] Live demonstration
EOF

echo "   ✓ Created $DEMO_VAULT"
echo "   ✓ Added 3 test Markdown files"
echo ""

# Step 2: Install
echo "📦 Step 2: Installing dependencies..."
cd "$REPO_ROOT"
pnpm install > /dev/null 2>&1
echo "   ✓ Dependencies installed"
echo ""

# Step 3: Build
echo "🔨 Step 3: Building packages..."
pnpm build > /dev/null 2>&1
echo "   ✓ All packages built"
echo ""

# Step 4: Initialize
echo "⚙️  Step 4: Initializing CLI..."
cd "$REPO_ROOT/packages/cli"
node dist/index.js init > /dev/null 2>&1
echo "   ✓ CLI initialized"
echo ""

# Step 5: Connect
echo "🔗 Step 5: Connecting to vault..."
node dist/index.js connect "$DEMO_VAULT" > /dev/null 2>&1
echo "   ✓ Vault connected"
echo "   ✓ Files indexed"
echo ""

# Step 6: Status
echo "📊 Step 6: Checking status..."
echo ""
node dist/index.js status
echo ""

# Summary
echo ""
echo "╔════════════════════════════════════════╗"
echo "║  ✅ Demo Setup Complete                ║"
echo "╚════════════════════════════════════════╝"
echo ""

echo "🚀 TO TEST THE DEMO:"
echo ""
echo "   Terminal 1 (Start Server):"
echo "   ─────────────────────────"
echo "   cd $REPO_ROOT/packages/cli"
echo "   node dist/index.js serve"
echo ""
echo "   Terminal 2 (Test Endpoints):"
echo "   ──────────────────────────"
echo ""
echo "   # Search:"
echo "   curl -X POST http://127.0.0.1:3001/api/search \\"
echo "     -H 'Content-Type: application/json' \\"
echo "     -d '{\"query\": \"architecture\", \"limit\": 5}'"
echo ""
echo "   # Read file:"
echo "   curl -X POST http://127.0.0.1:3001/api/read \\"
echo "     -H 'Content-Type: application/json' \\"
echo "     -d '{\"path\": \"business.md\"}'"
echo ""
echo "   # Create note:"
echo "   curl -X POST http://127.0.0.1:3001/api/create \\"
echo "     -H 'Content-Type: application/json' \\"
echo "     -d '{\"path\": \"BuildFlow/Inbox/new-note.md\", \"content\": \"# New Note\"}'"
echo ""
echo "   # Export plan:"
echo "   curl -X POST http://127.0.0.1:3001/api/export-plan \\"
echo "     -H 'Content-Type: application/json' \\"
echo "     -d '{\"title\": \"Test Plan\", \"projectGoal\": \"Demo\", \"summary\": \"Local demo\", \"techStack\": \"Node.js\", \"implementationPlan\": \"Phase 1\", \"tasks\": [\"test\"], \"acceptanceCriteria\": [\"works\"]}'"
echo ""

echo "📖 FOR ALL TESTS:"
echo "   See DEMO_LOCAL.md in the repo root"
echo ""

echo "🧹 TO CLEAN UP:"
echo "   rm -rf /tmp/buildflow-demo ~/.buildflow"
echo ""
