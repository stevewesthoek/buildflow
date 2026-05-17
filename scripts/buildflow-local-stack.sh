#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_PORT="${AGENT_PORT:-3052}"
RELAY_PORT="${RELAY_PORT:-3053}"
WEB_PORT="${WEB_PORT:-3054}"
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
    python3 - "$REPO_ROOT/packages/cli" "$AGENT_PORT" "$AGENT_LOG" "$AGENT_ERR_LOG" <<'PY'
import os
import subprocess
import sys

cli_dir, port, log_path, err_path = sys.argv[1:5]
env = os.environ.copy()
env["AGENT_PORT"] = port

with open(log_path, "ab", buffering=0) as log_file, open(err_path, "ab", buffering=0) as err_file:
    proc = subprocess.Popen(
        ["pnpm", "--dir", cli_dir, "dev"],
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
}

start_relay() {
  wait_for_docker
  log "Starting relay via docker compose."
  (cd "$REPO_ROOT" && docker compose up -d)
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
  local pid
  pid="$(
    python3 - "$REPO_ROOT/apps/web" "$WEB_PORT" "$WEB_LOG" "$WEB_ERR_LOG" "$next_bin" <<'PY'
import os
import subprocess
import sys

web_dir, port, log_path, err_path, next_bin = sys.argv[1:6]
env = os.environ.copy()
env["HOST"] = "127.0.0.1"
env["PORT"] = port
with open(log_path, "ab", buffering=0) as log_file, open(err_path, "ab", buffering=0) as err_file:
    proc = subprocess.Popen(
        [next_bin, "dev", "-H", "127.0.0.1", "-p", port],
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
  *)
    cat <<EOF
Usage: $0 {status|start|stop|rebuild-web|verify|restart}

Rules:
- Never run pnpm --dir apps/web build while pnpm --dir apps/web dev is running.
- Stop web first, clear apps/web/.next if needed, build, then restart web.
EOF
    exit 1
    ;;
esac
