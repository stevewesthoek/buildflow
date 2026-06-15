#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_PORT="${AGENT_PORT:-3052}"
RELAY_PORT="${RELAY_PORT:-3053}"
WEB_PORT="${WEB_PORT:-3054}"
WEB_SERVER_MODE="${BUILDFLOW_WEB_SERVER_MODE:-production}"
AGENT_SERVER_MODE="${BUILDFLOW_AGENT_SERVER_MODE:-dev}"
AGENT_HEALTH_URL="http://127.0.0.1:${AGENT_PORT}/health"
RELAY_HEALTH_URL="http://127.0.0.1:${RELAY_PORT}/health"
WEB_HEALTH_URL="http://127.0.0.1:${WEB_PORT}/api/openapi"
WEB_ACTION_STATUS_URL="http://127.0.0.1:${WEB_PORT}/api/actions/status"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-${LOCAL_DASHBOARD_BASE_URL:-http://127.0.0.1:${WEB_PORT}}}"
PUBLIC_OPENAPI_URL="${PUBLIC_BASE_URL}/api/openapi"
PUBLIC_STATUS_URL="${PUBLIC_BASE_URL}/api/actions/status"

AGENT_LOG="/tmp/buildflow-agent.log"
AGENT_ERR_LOG="/tmp/buildflow-agent.err.log"
AGENT_PID_FILE="/tmp/buildflow-agent.pid"
RELAY_LOG="/tmp/buildflow-relay.log"
RELAY_ERR_LOG="/tmp/buildflow-relay.err.log"
WEB_LOG="/tmp/buildflow-web.log"
WEB_ERR_LOG="/tmp/buildflow-web.err.log"
WEB_PID_FILE="/tmp/buildflow-web.pid"

die() {
  echo "buildflow-local-stack: $*" >&2
  exit 1
}

log() {
  echo "buildflow-local-stack: $*"
}

kill_port() {
  local port="$1"
  local pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN || true)"
  if [ -n "$pids" ]; then
    log "Stopping listeners on port $port: $pids"
    kill $pids || true
  fi
}

wait_port_free() {
  local port="$1"
  local label="$2"
  for _ in $(seq 1 20); do
    if ! lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  lsof -nP -iTCP:"$port" -sTCP:LISTEN || true
  die "$label port $port was not released"
}

verify_ports_free() {
  wait_port_free "$AGENT_PORT" agent
  wait_port_free "$RELAY_PORT" relay
  wait_port_free "$WEB_PORT" web
}

web_pid_running() {
  if [ ! -f "$WEB_PID_FILE" ]; then
    return 1
  fi
  local pid
  pid="$(cat "$WEB_PID_FILE" 2>/dev/null || true)"
  if [ -z "$pid" ]; then
    return 1
  fi
  kill -0 "$pid" >/dev/null 2>&1
}

stop_web_pid() {
  if [ ! -f "$WEB_PID_FILE" ]; then
    return 0
  fi
  local pid
  pid="$(cat "$WEB_PID_FILE" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1; then
    log "Stopping web PID $pid"
    kill "$pid" || true
    for _ in $(seq 1 10); do
      if ! kill -0 "$pid" >/dev/null 2>&1; then
        break
      fi
      sleep 1
    done
    if kill -0 "$pid" >/dev/null 2>&1; then
      log "Force stopping web PID $pid"
      kill -9 "$pid" || true
    fi
  fi
  rm -f "$WEB_PID_FILE"
}

agent_pid_running() {
  if [ ! -f "$AGENT_PID_FILE" ]; then
    return 1
  fi
  local pid
  pid="$(cat "$AGENT_PID_FILE" 2>/dev/null || true)"
  if [ -z "$pid" ]; then
    return 1
  fi
  kill -0 "$pid" >/dev/null 2>&1
}

stop_agent_pid() {
  if [ ! -f "$AGENT_PID_FILE" ]; then
    return 0
  fi
  local pid
  pid="$(cat "$AGENT_PID_FILE" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1; then
    log "Stopping agent PID $pid"
    kill "$pid" || true
    for _ in $(seq 1 10); do
      if ! kill -0 "$pid" >/dev/null 2>&1; then
        break
      fi
      sleep 1
    done
    if kill -0 "$pid" >/dev/null 2>&1; then
      log "Force stopping agent PID $pid"
      kill -9 "$pid" || true
    fi
  fi
  rm -f "$AGENT_PID_FILE"
}

wait_for_docker() {
  if docker info >/dev/null 2>&1; then
    return 0
  fi
  if command -v orbctl >/dev/null 2>&1; then
    log "Docker is not ready. Starting OrbStack."
    orbctl start || true
  fi
  for _ in $(seq 1 12); do
    if docker info >/dev/null 2>&1; then
      log "Docker is ready."
      return 0
    fi
    sleep 5
  done
  if command -v orbctl >/dev/null 2>&1; then
    log "OrbStack status:"
    orbctl status || true
  fi
  log "Docker/OrbStack is still unavailable. Open OrbStack and retry 'pnpm local:restart'."
  die "Docker/OrbStack did not become ready"
}

agent_healthy() {
  curl -sf "$AGENT_HEALTH_URL" >/dev/null 2>&1
}

relay_healthy() {
  curl -sf "$RELAY_HEALTH_URL" >/dev/null 2>&1
}

web_healthy() {
  local openapi_body status_body
  openapi_body="$(curl -sS "$WEB_HEALTH_URL" 2>/dev/null || true)"
  status_body="$(curl -sS "$WEB_ACTION_STATUS_URL" 2>/dev/null || true)"
  [[ "$openapi_body" == *'"openapi":"3.1.0"'* ]] || return 1
  [[ "$openapi_body" != *'Cannot find module'* && "$openapi_body" != *'MODULE_NOT_FOUND'* && "$openapi_body" != *'webpack-runtime'* ]] || return 1
  [[ "$status_body" == *'"error":"Unauthorized"'* || "$status_body" == *'"error": "Unauthorized"'* || "$status_body" == *'"connected"'* || "$status_body" == *'"status":"ok"'* ]] || return 1
  [[ "$status_body" != *'Cannot find module'* && "$status_body" != *'MODULE_NOT_FOUND'* && "$status_body" != *'webpack-runtime'* ]] || return 1
  return 0
}

web_status_healthy() {
  local body
  body="$(curl -sS "$WEB_ACTION_STATUS_URL" 2>/dev/null || true)"
  [[ "$body" == *'"error":"Unauthorized"'* || "$body" == *'"error": "Unauthorized"'* ]]
}

public_openapi_healthy() {
  local body
  body="$(curl -sS "$PUBLIC_OPENAPI_URL" 2>/dev/null || true)"
  [[ "$body" == *'"openapi":"3.1.0"'* ]] || return 1
  [[ "$body" != *'Cannot find module'* && "$body" != *'MODULE_NOT_FOUND'* && "$body" != *'webpack-runtime'* && "$body" != *'502 Bad Gateway'* ]] || return 1
  return 0
}

public_status_healthy() {
  local body
  body="$(curl -sS "$PUBLIC_STATUS_URL" 2>/dev/null || true)"
  [[ "$body" == *'"error":"Unauthorized"'* || "$body" == *'"error": "Unauthorized"'* || "$body" == *'"status":"ok"'* || "$body" == *'"connected"'* ]] || return 1
  [[ "$body" != *'Cannot find module'* && "$body" != *'MODULE_NOT_FOUND'* && "$body" != *'webpack-runtime'* && "$body" != *'502 Bad Gateway'* ]] || return 1
  return 0
}

assert_no_stale_next_errors() {
  local openapi_body status_body
  openapi_body="$(curl -sS "$WEB_HEALTH_URL" 2>/dev/null || true)"
  status_body="$(curl -sS "$WEB_ACTION_STATUS_URL" 2>/dev/null || true)"
  if [[ "$openapi_body" == *'Cannot find module'* || "$openapi_body" == *'MODULE_NOT_FOUND'* || "$openapi_body" == *'webpack-runtime'* || "$openapi_body" == *'8352.js'* ]]; then
    die "Stale Next.js chunk/runtime errors detected in /api/openapi"
  fi
  if [[ "$status_body" == *'Cannot find module'* || "$status_body" == *'MODULE_NOT_FOUND'* || "$status_body" == *'webpack-runtime'* || "$status_body" == *'8352.js'* ]]; then
    die "Stale Next.js chunk/runtime errors detected in /api/actions/status"
  fi
}

start_agent_if_needed() {
  if agent_healthy; then
    log "Agent already healthy on ${AGENT_PORT}."
    return 0
  fi
  if agent_pid_running; then
    log "Agent PID file exists but health check failed; stopping stale agent process."
    stop_agent_pid
  fi
  log "Starting agent on ${AGENT_PORT}."
  : >"$AGENT_LOG"
  : >"$AGENT_ERR_LOG"
  local pid
  pid="$(
    python3 - "$REPO_ROOT/packages/cli" "$AGENT_PORT" "$AGENT_LOG" "$AGENT_ERR_LOG" "$AGENT_SERVER_MODE" <<'PY'
import os
import subprocess
import sys

cli_dir, port, log_path, err_path, mode = sys.argv[1:6]
env = os.environ.copy()
env["AGENT_PORT"] = port
env.setdefault("BRIDGE_URL", "http://127.0.0.1:3053")
env.setdefault("DEVICE_TOKEN", "local-device")
command = ["node", "dist/index.js", "serve"] if mode in ("production", "start") else ["pnpm", "--dir", cli_dir, "dev"]

with open(log_path, "ab", buffering=0) as log_file, open(err_path, "ab", buffering=0) as err_file:
    proc = subprocess.Popen(
        command,
        cwd=cli_dir,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=log_file,
        stderr=err_file,
        start_new_session=True,
    )
    print(proc.pid)
PY
  )"
  echo "$pid" >"$AGENT_PID_FILE"
  log "Agent started with ${AGENT_SERVER_MODE} mode on ${AGENT_PORT}."
}

start_relay() {
  wait_for_docker
  log "Starting relay via docker compose."
  (cd "$REPO_ROOT" && docker compose up -d)
}

rebuild_relay_image() {
  wait_for_docker
  log "Rebuilding relay image from current source."
  (cd "$REPO_ROOT" && docker compose build relay)
}

start_web_if_needed() {
  if web_healthy; then
    log "Web already healthy on ${WEB_PORT}."
    return 0
  fi
  if web_pid_running; then
    log "Web PID file exists but health check failed; stopping stale web process."
    stop_web_pid
  fi
  log "Starting web on ${WEB_PORT}."
  : >"$WEB_LOG"
  : >"$WEB_ERR_LOG"
  local next_bin="$REPO_ROOT/apps/web/node_modules/.bin/next"
  local next_command="dev"
  if [ "$WEB_SERVER_MODE" = "production" ] || [ "$WEB_SERVER_MODE" = "start" ]; then
    if [ ! -f "$REPO_ROOT/apps/web/.next/BUILD_ID" ]; then
      log "No production web build found; building apps/web before next start."
      (cd "$REPO_ROOT/apps/web" && pnpm build)
    fi
    next_command="start"
  elif [ "$WEB_SERVER_MODE" != "dev" ]; then
    die "Unknown BUILDFLOW_WEB_SERVER_MODE: $WEB_SERVER_MODE (expected production, start, or dev)"
  fi
  local pid
  pid="$(
    python3 - "$REPO_ROOT/apps/web" "$WEB_PORT" "$WEB_LOG" "$WEB_ERR_LOG" "$next_bin" "$next_command" <<'PY'
import os
import subprocess
import sys

web_dir, port, log_path, err_path, next_bin, next_command = sys.argv[1:7]
env = os.environ.copy()
env["HOST"] = "127.0.0.1"
env["PORT"] = port
with open(log_path, "ab", buffering=0) as log_file, open(err_path, "ab", buffering=0) as err_file:
    proc = subprocess.Popen(
        [next_bin, next_command, "-H", "127.0.0.1", "-p", port],
        cwd=web_dir,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=log_file,
        stderr=err_file,
        start_new_session=True,
    )
    print(proc.pid)
PY
  )"
  echo "$pid" >"$WEB_PID_FILE"
  log "Web started with next ${next_command} on ${WEB_PORT}."
}

stop_web() {
  stop_web_pid
  kill_port "$WEB_PORT"
}

stop_agent() {
  stop_agent_pid
  kill_port "$AGENT_PORT"
}

stop_relay() {
  log "Stopping relay via docker compose."
  (cd "$REPO_ROOT" && docker compose down) || true
}

rebuild_web() {
  stop_web
  wait_port_free "$WEB_PORT" web
  rm -rf "$REPO_ROOT/apps/web/.next"
  (cd "$REPO_ROOT/apps/web" && pnpm type-check)
  (cd "$REPO_ROOT/apps/web" && pnpm build)
  start_web_if_needed
  sleep 8
  verify_local_web
}

verify_local_web() {
  if ! web_pid_running && ! web_healthy; then
    tail -n 80 "$WEB_LOG" || true
    tail -n 80 "$WEB_ERR_LOG" || true
    die "Web process is not running and ${WEB_PORT} is not healthy"
  fi
  web_healthy || die "Web on ${WEB_PORT} is not healthy"
  local status_body
  status_body="$(curl -sS "$WEB_ACTION_STATUS_URL" 2>/dev/null || true)"
  if [[ "$status_body" == *'Cannot find module'* || "$status_body" == *'webpack-runtime'* || "$status_body" == *'MODULE_NOT_FOUND'* || "$status_body" == *'8352.js'* ]]; then
    die "Web action endpoint still shows stale Next.js chunk/runtime errors"
  fi
  if [[ "$status_body" != *'"error":"Unauthorized"'* && "$status_body" != *'"error": "Unauthorized"'* && "$status_body" != *'"status":"ok"'* && "$status_body" != *'"connected"'* ]]; then
    die "Web action endpoint did not return Unauthorized or expected JSON"
  fi
  assert_no_stale_next_errors
}

verify_public() {
  public_openapi_healthy || die "Public /api/openapi is not healthy"
  local status_body
  status_body="$(curl -sS "$PUBLIC_STATUS_URL" 2>/dev/null || true)"
  if [[ "$status_body" == *'502 Bad Gateway'* || "$status_body" == *'Cannot find module'* || "$status_body" == *'webpack-runtime'* || "$status_body" == *'MODULE_NOT_FOUND'* || "$status_body" == *'8352.js'* ]]; then
    die "Public BuildFlow endpoint still unhealthy"
  fi
  if [[ "$status_body" != *'"error":"Unauthorized"'* && "$status_body" != *'"error": "Unauthorized"'* && "$status_body" != *'"status":"ok"'* && "$status_body" != *'"connected"'* ]]; then
    die "Public action status endpoint did not return Unauthorized or expected JSON"
  fi
}

verify_all() {
  agent_healthy || die "Agent on ${AGENT_PORT} is not healthy"
  relay_healthy || die "Relay on ${RELAY_PORT} is not healthy"
  verify_local_web
  public_openapi_healthy || die "Public /api/openapi is not healthy"
  verify_public
}

status_all() {
  log "Agent ${AGENT_PORT}: $(agent_healthy && echo healthy || echo unhealthy)"
  log "Relay ${RELAY_PORT}: $(relay_healthy && echo healthy || echo unhealthy)"
  log "Web ${WEB_PORT}: $(web_healthy && echo healthy || echo unhealthy)"
}

restart_all() {
  stop_web
  wait_port_free "$WEB_PORT" web
  rm -rf "$REPO_ROOT/apps/web/.next"
  (cd "$REPO_ROOT/apps/web" && pnpm type-check)
  (cd "$REPO_ROOT/apps/web" && pnpm build)
  wait_for_docker
  start_relay
  start_agent_if_needed
  start_web_if_needed
  sleep 8
  verify_all
}

restart_fresh() {
  local previous_agent_pid previous_web_pid previous_container_id previous_image_id previous_build_id
  previous_agent_pid="$(lsof -tiTCP:"$AGENT_PORT" -sTCP:LISTEN 2>/dev/null || true)"
  previous_web_pid="$(lsof -tiTCP:"$WEB_PORT" -sTCP:LISTEN 2>/dev/null || true)"
  previous_container_id="$(docker inspect workbench-relay --format '{{.Id}}' 2>/dev/null || true)"
  previous_image_id="$(docker inspect workbench-relay --format '{{.Image}}' 2>/dev/null || true)"
  previous_build_id="$(cat "$REPO_ROOT/apps/web/.next/BUILD_ID" 2>/dev/null || true)"

  export WORKBENCH_BUILD_SHA="${WORKBENCH_BUILD_SHA:-$(git -C "$REPO_ROOT" rev-parse HEAD)}"
  export WORKBENCH_BUILD_TIMESTAMP="${WORKBENCH_BUILD_TIMESTAMP:-$(date -u '+%Y-%m-%dT%H:%M:%SZ')}"

  log "Fresh restart target commit: ${WORKBENCH_BUILD_SHA}"
  log "Previous agent PID: ${previous_agent_pid:-none}"
  log "Previous web PID: ${previous_web_pid:-none}"
  log "Previous relay container: ${previous_container_id:-none}"
  log "Previous relay image: ${previous_image_id:-none}"
  log "Previous web build ID: ${previous_build_id:-none}"

  stop_web
  stop_agent
  stop_relay
  verify_ports_free

  log "Rebuilding shared package."
  (cd "$REPO_ROOT/packages/shared" && pnpm build)
  log "Rebuilding agent package."
  (cd "$REPO_ROOT/packages/cli" && pnpm build)
  rebuild_relay_image

  log "Rebuilding web application from current source."
  rm -rf "$REPO_ROOT/apps/web/.next"
  (cd "$REPO_ROOT/apps/web" && pnpm type-check)
  (cd "$REPO_ROOT/apps/web" && pnpm build)
  export WORKBENCH_WEB_BUILD_ID="$(cat "$REPO_ROOT/apps/web/.next/BUILD_ID")"

  start_relay
  BUILDFLOW_AGENT_SERVER_MODE=production AGENT_SERVER_MODE=production start_agent_if_needed
  start_web_if_needed
  sleep 8
  verify_all

  node "$REPO_ROOT/scripts/diagnose-workbench-path.mjs" --fresh-check --expected-commit "$WORKBENCH_BUILD_SHA" || die "Freshness verification failed"

  local new_agent_pid new_web_pid new_container_id new_image_id new_build_id
  new_agent_pid="$(lsof -tiTCP:"$AGENT_PORT" -sTCP:LISTEN 2>/dev/null || true)"
  new_web_pid="$(lsof -tiTCP:"$WEB_PORT" -sTCP:LISTEN 2>/dev/null || true)"
  new_container_id="$(docker inspect workbench-relay --format '{{.Id}}' 2>/dev/null || true)"
  new_image_id="$(docker inspect workbench-relay --format '{{.Image}}' 2>/dev/null || true)"
  new_build_id="$(cat "$REPO_ROOT/apps/web/.next/BUILD_ID" 2>/dev/null || true)"

  log "Fresh agent PID: ${new_agent_pid:-missing}"
  log "Fresh web PID: ${new_web_pid:-missing}"
  log "Fresh relay container: ${new_container_id:-missing}"
  log "Fresh relay image: ${new_image_id:-missing}"
  log "Fresh web build ID: ${new_build_id:-missing}"

  [ -z "$previous_agent_pid" ] || [ "$previous_agent_pid" != "$new_agent_pid" ] || die "Agent PID did not change"
  [ -z "$previous_web_pid" ] || [ "$previous_web_pid" != "$new_web_pid" ] || die "Web PID did not change"
  [ -z "$previous_container_id" ] || [ "$previous_container_id" != "$new_container_id" ] || die "Relay container ID did not change"
  [ -z "$previous_build_id" ] || [ "$previous_build_id" != "$new_build_id" ] || die "Web build ID did not change"
}

cmd="${1:-}"
case "$cmd" in
  status)
    status_all
    ;;
  start)
    wait_for_docker
    start_relay
    start_agent_if_needed
    start_web_if_needed
    sleep 8
    verify_all
    ;;
  stop)
    stop_web
    stop_agent
    stop_relay
    ;;
  rebuild-web)
    rebuild_web
    ;;
  verify)
    verify_all
    ;;
  restart)
    restart_all
    ;;
  restart-fresh)
    restart_fresh
    ;;
  *)
    cat <<EOF
Usage: $0 {status|start|stop|rebuild-web|verify|restart|restart-fresh}

Rules:
- Never run pnpm --dir apps/web build while pnpm --dir apps/web dev is running.
- Stop web first, clear apps/web/.next if needed, build, then restart web.
EOF
    exit 1
    ;;
esac
