#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$ROOT_DIR/scripts/workbench-local-stack.sh"
COMMAND="${1:-restart}"

case "$COMMAND" in
  status)
    COMMAND="verify"
    ;;
  restart-fresh|rebuild-web)
    COMMAND="restart"
    ;;
  start|stop|restart|verify)
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|restart-fresh|rebuild-web|verify|status}" >&2
    exit 2
    ;;
esac

if [ ! -x "$TARGET" ]; then
  echo "buildflow-local-stack.sh: missing executable $TARGET" >&2
  exit 1
fi

echo "buildflow-local-stack.sh is a compatibility wrapper. Delegating to ProChat Workbench local stack: $COMMAND"
exec bash "$TARGET" "$COMMAND"
