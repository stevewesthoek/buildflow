#!/usr/bin/env bash
set -euo pipefail

export MTPLX_API_KEY="not-needed"

# Stop Ollama to free memory for MTPLX (they can't coexist on 24GB)
if pgrep -q -f "Ollama"; then
  echo "Stopping Ollama to free memory for MTPLX..."
  osascript -e 'quit app "Ollama"' 2>/dev/null || true
  sleep 3
fi

echo "Running Graphify Phase 1 for buildflow with Qwen 3.6 27B MTPLX Speed..."

# Phase 1: Extract
graphify extract . --backend mtplx --model mtplx --token-budget 4000 --max-concurrency 1 --api-timeout 900

echo "Extract complete, now clustering..."

# Phase 1: Cluster
GRAPHIFY_VIZ_NODE_LIMIT=30000 graphify cluster-only . --backend=mtplx --model mtplx

echo "Graphify Phase 1 complete!"
