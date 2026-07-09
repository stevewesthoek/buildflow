#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="$ROOT_DIR/packages/cli"
WEB_DIR="$ROOT_DIR/apps/web"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"
PROJECT_NAME="workbench"

HOST="127.0.0.1"
AGENT_PORT="${AGENT_PORT:-3052}"
RELAY_PORT="${RELAY_PORT:-3053}"
WEB_PORT="${WEB_PORT:-3054}"

RUN_DIR="$ROOT_DIR/runtime/local/workbench-stack"
AGENT_LOG="$RUN_DIR/agent.log"
AGENT_ERR="$RUN_DIR/agent.err.log"
WEB_LOG="$RUN_DIR/web.log"
WEB_ERR="$RUN_DIR/web.err.log"

mkdir -p "$RUN_DIR"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

pids_on_port() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true
}

pid_cwd() {
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1 || true
}

pid_command() {
  ps -p "$1" -o command= 2>/dev/null || true
}

is_workbench_pid() {
  local pid="$1"
  local cwd
  local cmd

  cwd="$(pid_cwd "$pid")"
  cmd="$(pid_command "$pid")"

  [[ "$cwd" == "$ROOT_DIR"* ]] && return 0
  [[ "$cmd" == *"$ROOT_DIR"* ]] && return 0

  return 1
}

kill_workbench_port() {
  local port="$1"
  local label="$2"
  local pids
  pids="$(pids_on_port "$port")"

  if [ -z "$pids" ]; then
    log "✓ $label port $port already free"
    return 0
  fi

  for pid in $pids; do
    if is_workbench_pid "$pid"; then
      log "Stopping stale $label process pid=$pid"
      kill "$pid" 2>/dev/null || true
    else
      log "ERROR: port $port is occupied by a non-Workbench process"
      log "pid=$pid"
      log "cwd=$(pid_cwd "$pid")"
      log "cmd=$(pid_command "$pid")"
      exit 1
    fi
  done
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

  kill_workbench_port "$WEB_PORT" "web"
  kill_workbench_port "$AGENT_PORT" "agent"

  wait_port_free "$WEB_PORT" "web"
  wait_port_free "$AGENT_PORT" "agent"

  stop_relay
}

build_runtime_packages() {
  log "Building runtime packages only"

  pnpm --dir "$ROOT_DIR/packages/shared" build
  pnpm --dir "$ROOT_DIR/packages/proxy" build
  pnpm --dir "$ROOT_DIR/packages/bridge" build
  pnpm --dir "$ROOT_DIR/packages/cli" build
  pnpm --dir "$WEB_DIR" build
}

start_relay() {
  log "Starting relay compose project only"
  docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" up -d --remove-orphans
  wait_http_ok "http://$HOST:$RELAY_PORT/health" "relay"
}

start_agent() {
  log "Starting agent on $AGENT_PORT"

  (
    cd "$AGENT_DIR"
    nohup env \
      PORT="$AGENT_PORT" \
      HOST="$HOST" \
      WORKBENCH_AGENT_PORT="$AGENT_PORT" \
      WORKBENCH_AGENT_HOST="$HOST" \
      BUILDFLOW_AGENT_PORT="$AGENT_PORT" \
      BUILDFLOW_AGENT_HOST="$HOST" \
      node dist/index.js serve \
      > "$AGENT_LOG" 2> "$AGENT_ERR" &
    echo $! > "$RUN_DIR/agent.pid"
  )

  wait_http_ok "http://$HOST:$AGENT_PORT/health" "agent" || {
    log "Recent agent stdout:"
    tail -n 120 "$AGENT_LOG" 2>/dev/null || true
    log "Recent agent stderr:"
    tail -n 120 "$AGENT_ERR" 2>/dev/null || true
    exit 1
  }
}

start_web() {
  log "Starting web on $WEB_PORT"

  (
    cd "$WEB_DIR"
    nohup env \
      PORT="$WEB_PORT" \
      HOSTNAME="$HOST" \
      node_modules/.bin/next start -H "$HOST" -p "$WEB_PORT" \
      > "$WEB_LOG" 2> "$WEB_ERR" &
    echo $! > "$RUN_DIR/web.pid"
  )

  wait_http_ok "http://$HOST:$WEB_PORT/api/openapi" "web api" || {
    log "Recent web stdout:"
    tail -n 120 "$WEB_LOG" 2>/dev/null || true
    log "Recent web stderr:"
    tail -n 120 "$WEB_ERR" 2>/dev/null || true
    exit 1
  }

  wait_http_ok "http://$HOST:$WEB_PORT/" "web page" || {
    log "Recent web stdout:"
    tail -n 120 "$WEB_LOG" 2>/dev/null || true
    log "Recent web stderr:"
    tail -n 120 "$WEB_ERR" 2>/dev/null || true
    exit 1
  }
}

verify_stack() {
  log "Verifying unified health"

  local body
  body="$(curl -fsS --max-time 5 "http://$HOST:$WEB_PORT/api/unified-health")"

  printf '%s\n' "$body"

  if printf '%s' "$body" | grep -q '"allHealthy":true'; then
    log "✓ Workbench stack healthy"
    return 0
  fi

  log "ERROR: unified health is not allHealthy=true"
  log "Recent agent stdout:"
  tail -n 120 "$AGENT_LOG" 2>/dev/null || true
  log "Recent agent stderr:"
  tail -n 120 "$AGENT_ERR" 2>/dev/null || true
  log "Recent web stdout:"
  tail -n 120 "$WEB_LOG" 2>/dev/null || true
  log "Recent web stderr:"
  tail -n 120 "$WEB_ERR" 2>/dev/null || true
  exit 1
}

start_stack_clean() {
  stop_stack
  build_runtime_packages
  start_relay
  start_agent
  start_web
  verify_stack
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
