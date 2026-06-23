#!/usr/bin/env bash
set -euo pipefail

echo "Running Graphify Phase 1 for buildflow with local model..."

# Use Ollama qwen2.5 (faster than local CPU, no validation issues)
# Phase 1: Extract
graphify extract . --backend ollama --model qwen2.5:32b --token-budget 4000 --max-concurrency 1 --api-timeout 900

echo "Extract complete, now clustering..."

# Phase 1: Cluster
GRAPHIFY_VIZ_NODE_LIMIT=30000 graphify cluster-only . --backend=ollama --model qwen2.5:32b

echo "Graphify Phase 1 complete!"
