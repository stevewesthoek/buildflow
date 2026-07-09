#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$ROOT_DIR/scripts/workbench-local-stack.sh"

if [ ! -x "$TARGET" ]; then
  echo "buildflow-orchestrator.sh: missing executable $TARGET" >&2
  exit 1
fi

echo "buildflow-orchestrator.sh is a compatibility wrapper. Delegating to ProChat Workbench local stack."
exec bash "$TARGET" "${1:-restart}"
