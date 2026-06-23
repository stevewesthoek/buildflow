#!/usr/bin/env bash
set -euo pipefail

export MTPLX_API_KEY="not-needed"

echo "Running graphify Phase 1+2 for buildflow with Qwen 3.6 27B MTPLX Speed..."

graphify extract . --backend mtplx --model mtplx --token-budget 4000 --max-concurrency 1 --api-timeout 900

echo "Extract complete, now clustering..."

GRAPHIFY_VIZ_NODE_LIMIT=30000 graphify cluster-only . --backend=mtplx --model mtplx

echo "Graphify complete!"
