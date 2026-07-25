#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_DIR="$ROOT_DIR/apps/web"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"
PROJECT_NAME="workbench"
SERVICE_MANAGER="$ROOT_DIR/scripts/workbench-detached-service.mjs"

HOST="127.0.0.1"
AGENT_PORT="${AGENT_PORT:-3052}"
RELAY_PORT="${RELAY_PORT:-3053}"
WEB_PORT="${WEB_PORT:-3054}"

OWNER_HOME="$(node -p "require('node:os').userInfo().homedir")"
RUN_DIR="$OWNER_HOME/.config/workbench/runtime-state"
AGENT_LOG="$RUN_DIR/agent.log"
AGENT_ERR="$RUN_DIR/agent.err.log"
WEB_LOG="$RUN_DIR/web.log"
WEB_ERR="$RUN_DIR/web.err.log"

mkdir -p "$RUN_DIR"

initialize_build_identity() {
  local package_version
  local git_sha
  local build_timestamp

  package_version="$(node -p "require('$ROOT_DIR/package.json').version" 2>/dev/null || true)"
  git_sha="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || true)"
  build_timestamp="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

  if ! printf '%s' "$git_sha" | grep -Eq '^[0-9a-f]{40}$'; then
    log "ERROR: could not establish exact Workbench Git revision"
    return 1
  fi
  if [ -z "$package_version" ]; then
    log "ERROR: could not establish Workbench package version"
    return 1
  fi

  export WORKBENCH_PACKAGE_VERSION="$package_version"
  export WORKBENCH_BUILD_SHA="$git_sha"
  export WORKBENCH_BUILD_TIMESTAMP="$build_timestamp"
}

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

pids_on_port() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true
}

wait_port_free() {
  local port="$1"
  local label="$2"
  local deadline=$((SECONDS + 25))

  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ -z "$(pids_on_port "$port")" ]; then
      log "✓ $label port $port is free"
      return 0
    fi
    sleep 1
  done

  log "ERROR: $label port $port is still occupied"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN || true
  exit 1
}

wait_http_ok() {
  local url="$1"
  local label="$2"
  local deadline=$((SECONDS + 60))

  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -fsS --max-time 4 "$url" >/dev/null 2>&1; then
      log "✓ $label healthy: $url"
      return 0
    fi
    sleep 1
  done

  log "ERROR: $label did not become healthy: $url"
  return 1
}

stop_relay() {
  log "Stopping only Docker Compose project: $PROJECT_NAME"

  docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" down --remove-orphans || true

  local containers
  containers="$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT_NAME" || true)"

  if [ -n "$containers" ]; then
    log "Removing leftover Workbench compose containers"
    docker rm -f $containers >/dev/null
  fi

  wait_port_free "$RELAY_PORT" "relay"
}

stop_stack() {
  log "Stopping Workbench host services only"

  node "$SERVICE_MANAGER" stop web --port "$WEB_PORT"
  node "$SERVICE_MANAGER" stop agent --port "$AGENT_PORT"

  wait_port_free "$WEB_PORT" "web"
  wait_port_free "$AGENT_PORT" "agent"

  stop_relay
}

build_runtime_packages() {
  log "Building runtime packages only"

  pnpm --dir "$ROOT_DIR/packages/proxy" build
  pnpm --dir "$ROOT_DIR/packages/bridge" build
  pnpm --dir "$ROOT_DIR/packages/cli" build
  pnpm --dir "$WEB_DIR" build
}

preflight_action_auth() {
  log "Validating owner-local Workbench action authentication"
  pnpm --dir "$ROOT_DIR/packages/shared" build
  if ! node "$SERVICE_MANAGER" validate-auth; then
    log "ERROR: owner-local Workbench action authentication is unavailable"
    return 1
  fi
  log "✓ owner-local Workbench action authentication validated"
}

start_relay() {
  log "Starting relay compose project only"
  if ! docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" up -d --remove-orphans; then
    return 1
  fi
  if ! wait_http_ok "http://$HOST:$RELAY_PORT/health" "relay"; then
    return 1
  fi
}

start_agent() {
  local launch_id="$1"
  log "Starting agent on $AGENT_PORT"

  if ! node "$SERVICE_MANAGER" start agent --port "$AGENT_PORT" --launch-id "$launch_id"; then
    return 1
  fi

  if ! wait_http_ok "http://$HOST:$AGENT_PORT/health" "agent"; then
    log "Recent agent stdout:"
    tail -n 120 "$AGENT_LOG" 2>/dev/null || true
    log "Recent agent stderr:"
    tail -n 120 "$AGENT_ERR" 2>/dev/null || true
    return 1
  fi
}

start_web() {
  local launch_id="$1"
  log "Starting web on $WEB_PORT"

  if ! node "$SERVICE_MANAGER" start web --port "$WEB_PORT" --launch-id "$launch_id"; then
    return 1
  fi

  if ! wait_http_ok "http://$HOST:$WEB_PORT/api/openapi" "web api"; then
    log "Recent web stdout:"
    tail -n 120 "$WEB_LOG" 2>/dev/null || true
    log "Recent web stderr:"
    tail -n 120 "$WEB_ERR" 2>/dev/null || true
    return 1
  fi

  if ! wait_http_ok "http://$HOST:$WEB_PORT/" "web page"; then
    log "Recent web stdout:"
    tail -n 120 "$WEB_LOG" 2>/dev/null || true
    log "Recent web stderr:"
    tail -n 120 "$WEB_ERR" 2>/dev/null || true
    return 1
  fi
}

cleanup_launch_attempt() {
  local launch_id="$1"
  log "Cleaning up only host services launched by attempt $launch_id"
  node "$SERVICE_MANAGER" stop web --port "$WEB_PORT" --launch-id "$launch_id" || true
  node "$SERVICE_MANAGER" stop agent --port "$AGENT_PORT" --launch-id "$launch_id" || true
}

regenerate_openapi_schema() {
  log "Regenerating verified Custom GPT schema from the healthy web endpoint"
  if ! (
    cd "$ROOT_DIR"
    LOCAL_DASHBOARD_BASE_URL="http://$HOST:$WEB_PORT" node scripts/generate-openapi-chatgpt.mjs
  ); then
    log "ERROR: verified schema regeneration failed"
    return 1
  fi
  log "✓ verified schema regenerated: docs/openapi.chatgpt.json"
}

verify_stack() {
  log "Verifying unified health"

  if ! node "$SERVICE_MANAGER" status-all --agent-port "$AGENT_PORT" --web-port "$WEB_PORT"; then
    log "ERROR: Workbench service ownership status is not live"
    return 1
  fi

  local body
  body="$(curl -fsS --max-time 5 "http://$HOST:$WEB_PORT/api/unified-health")"

  printf '%s\n' "$body"

  if printf '%s' "$body" | grep -q '"allHealthy":true'; then
    log "✓ Workbench stack healthy"
  else
    log "ERROR: unified health is not allHealthy=true"
    log "Recent agent stdout:"
    tail -n 120 "$AGENT_LOG" 2>/dev/null || true
    log "Recent agent stderr:"
    tail -n 120 "$AGENT_ERR" 2>/dev/null || true
    log "Recent web stdout:"
    tail -n 120 "$WEB_LOG" 2>/dev/null || true
    log "Recent web stderr:"
    tail -n 120 "$WEB_ERR" 2>/dev/null || true
    return 1
  fi

  if ! node "$SERVICE_MANAGER" verify-auth --web-port "$WEB_PORT"; then
    log "ERROR: authenticated Workbench status verification failed"
    return 1
  fi
  log "✓ authenticated Workbench status verification passed"
}

verify_sustained_stack() {
  log "Requiring sustained process and HTTP health before launcher exit"
  if ! node "$SERVICE_MANAGER" sustain \
      --agent-port "$AGENT_PORT" \
      --relay-port "$RELAY_PORT" \
      --web-port "$WEB_PORT" \
      --duration-ms 8000 \
      --interval-ms 2000; then
    log "ERROR: sustained Workbench readiness failed"
    return 1
  fi
  log "✓ Workbench stack sustained readiness passed"
}

start_stack_clean() {
  local launch_id="restart-$$-$(date +%s)"

  initialize_build_identity
  preflight_action_auth
  stop_stack
  build_runtime_packages

  if ! start_relay; then
    stop_relay
    return 1
  fi
  if ! start_agent "$launch_id" ||
     ! start_web "$launch_id" ||
     ! verify_stack ||
     ! verify_sustained_stack ||
     ! regenerate_openapi_schema; then
    cleanup_launch_attempt "$launch_id"
    stop_relay
    return 1
  fi
}

case "${1:-restart}" in
  start)
    start_stack_clean
    ;;
  restart)
    start_stack_clean
    ;;
  stop)
    stop_stack
    ;;
  verify)
    verify_stack
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|verify}" >&2
    exit 2
    ;;
esac
