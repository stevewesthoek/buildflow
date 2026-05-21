#!/usr/bin/env bash
set -euo pipefail

echo "=== BuildFlow Production Start ==="

# Kill stale processes
lsof -ti:3052 | xargs kill -9 2>/dev/null || true
lsof -ti:3054 | xargs kill -9 2>/dev/null || true
sleep 1

# Build web
echo "Building web app..."
pnpm --dir apps/web build

# Start agent in background
echo "Starting agent..."
pnpm --filter=./packages/cli dev &
AGENT_PID=$!
sleep 2

# Start web in production mode
echo "Starting web (production)..."
PORT=3054 pnpm --dir apps/web start &
WEB_PID=$!

echo "Agent PID: $AGENT_PID"
echo "Web PID: $WEB_PID"
echo "=== BuildFlow running in production mode ==="
echo "Agent: http://localhost:3052"
echo "Web: http://localhost:3054"

wait
