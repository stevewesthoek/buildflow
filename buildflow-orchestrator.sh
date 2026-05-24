#!/bin/bash

# BuildFlow Unified Service Orchestrator
# Replaces restart-all.sh, stop-all.sh, start-all.sh
# Provides robust state management, graceful shutdown, and fact-checking

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILDFLOW_CONFIG_DIR="$REPO_ROOT/.buildflow"
STATE_FILE="$BUILDFLOW_CONFIG_DIR/services.state.json"
EVENTS_LOG="$BUILDFLOW_CONFIG_DIR/events.log"

# Service lookup functions instead of associative array (for bash 3 compatibility)
get_service_port() {
  case "${1:?service}" in
    agent) echo "3052" ;;
    web) echo "3054" ;;
    relay) echo "3053" ;;
  esac
}
get_service_type() {
  case "${1:?service}" in
    agent) echo "tsx" ;;
    web) echo "next" ;;
    relay) echo "docker" ;;
  esac
}
get_service_dir() {
  case "${1:?service}" in
    agent) echo "$REPO_ROOT/packages/cli" ;;
    web) echo "$REPO_ROOT/apps/web" ;;
    relay) echo "$REPO_ROOT" ;;
  esac
}
get_service_cmd() {
  case "${1:?service}" in
    agent) echo "src/index.ts serve" ;;
    web) echo "dev" ;;
    relay) echo "relay" ;;
  esac
}
get_service_health_url() {
  case "${1:?service}" in
    agent) echo "http://localhost:3052/health" ;;
    web) echo "http://localhost:3054/api/openapi" ;;
    relay) echo "http://localhost:3053/health" ;;
  esac
}

# Timeout configurations (seconds)
GRACEFUL_STOP_TIMEOUT=10
HARD_KILL_TIMEOUT=3
START_WAIT_TIMEOUT=30
HEALTH_CHECK_TIMEOUT=5
HEALTH_CHECK_RETRIES=10  # Increased for relay docker startup

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Logging functions
log_info() {
  local msg="$1"
  local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
  echo -e "${GREEN}[${timestamp}]${NC} ${msg}"
  echo "[${timestamp}] INFO: ${msg}" >> "$EVENTS_LOG"
}

log_warn() {
  local msg="$1"
  local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
  echo -e "${YELLOW}[${timestamp}]${NC} ${msg}"
  echo "[${timestamp}] WARN: ${msg}" >> "$EVENTS_LOG"
}

log_error() {
  local msg="$1"
  local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
  echo -e "${RED}[${timestamp}]${NC} ${msg}"
  echo "[${timestamp}] ERROR: ${msg}" >> "$EVENTS_LOG"
}

log_debug() {
  local msg="$1"
  if [[ "${DEBUG:-0}" == "1" ]]; then
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo -e "${BLUE}[${timestamp}]${NC} ${msg}"
  fi
  local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
  echo "[${timestamp}] DEBUG: ${msg}" >> "$EVENTS_LOG"
}

# Initialize configuration directories
init_config() {
  mkdir -p "$BUILDFLOW_CONFIG_DIR"
  touch "$EVENTS_LOG"

  # Initialize state file if missing
  if [[ ! -f "$STATE_FILE" ]]; then
    cat > "$STATE_FILE" << 'EOF'
{
  "agent": {"status": "unknown", "port": 3052, "pid": null, "last_checked": null, "health": "unknown"},
  "web": {"status": "unknown", "port": 3054, "pid": null, "last_checked": null, "health": "unknown"},
  "relay": {"status": "unknown", "port": 3053, "pid": null, "last_checked": null, "health": "unknown"},
  "last_action": null,
  "last_action_time": null,
  "last_action_status": null
}
EOF
    log_info "Initialized state file at $STATE_FILE"
  fi
}

# Get current state of all services by checking ports
get_service_state() {
  local service=$1
  local port=$(get_service_port "$service")

  # Check what's using the port
  local actual_pid=$(lsof -ti :$port 2>/dev/null || echo "")

  if [[ -z "$actual_pid" ]]; then
    echo "stopped"
    return 0
  fi

  # Port is in use, check if process is alive
  if ps -p "$actual_pid" > /dev/null 2>&1; then
    echo "running:$actual_pid"
    return 0
  else
    # Zombie process
    echo "zombie:$actual_pid"
    return 0
  fi
}

# Perform health check
health_check() {
  local service=$1
  local health_url=$(get_service_health_url "$service")

  if [[ -z "$health_url" ]]; then
    echo "unchecked"
    return 0
  fi

  local response=$(curl -s -m "$HEALTH_CHECK_TIMEOUT" "$health_url" 2>/dev/null || echo "")

  if [[ -n "$response" ]]; then
    echo "healthy"
  else
    echo "unhealthy"
  fi
}

# Gracefully stop service
stop_service() {
  local service=$1
  local state=$(get_service_state "$service")
  local port=$(get_service_port "$service")

  if [[ "$state" == "stopped" ]]; then
    log_info "✓ $service (port $port) already stopped"
    return 0
  fi

  if [[ "$state" == "zombie:"* ]]; then
    local pid=$(echo "$state" | cut -d: -f2)
    log_warn "$service (port $port) has zombie process PID $pid"
    force_release_port "$service"
    return 0
  fi

  local pid=$(echo "$state" | cut -d: -f2)
  log_info "Stopping $service (port $port, PID $pid)..."

  # Service-specific graceful shutdown
  case $service in
    agent)
      # Send SIGTERM to agent parent process
      pkill -TERM -P "$pid" 2>/dev/null || true
      kill -TERM "$pid" 2>/dev/null || true
      ;;
    web)
      # Send SIGTERM to next start process tree
      pkill -TERM -P "$pid" 2>/dev/null || true
      kill -TERM "$pid" 2>/dev/null || true
      ;;
    relay)
      # Use docker compose down
      cd "$REPO_ROOT"
      docker compose down 2>/dev/null || true
      ;;
  esac

  # Wait for graceful shutdown
  local elapsed=0
  while [[ $elapsed -lt $GRACEFUL_STOP_TIMEOUT ]]; do
    local current_state=$(get_service_state "$service")
    if [[ "$current_state" == "stopped" ]]; then
      log_info "✓ $service stopped gracefully"
      return 0
    fi
    sleep 1
    ((elapsed++))
  done

  # Force kill if graceful stop failed
  log_warn "$service did not stop gracefully after ${GRACEFUL_STOP_TIMEOUT}s, force killing..."

  # Kill all children and parent
  pkill -9 -f "$service" 2>/dev/null || true
  lsof -ti :$port 2>/dev/null | xargs kill -9 2>/dev/null || true

  sleep 1

  # Verify hard kill worked
  local final_state=$(get_service_state "$service")
  if [[ "$final_state" != "stopped" ]]; then
    log_error "$service failed to stop even after SIGKILL!"
    return 1
  fi

  log_info "✓ $service force killed and port $port released"
  return 0
}

# Force release port if zombie process
force_release_port() {
  local service=$1
  local port=$(get_service_port "$service")

  log_warn "Force-releasing port $port for $service..."

  # Kill all processes using this port
  lsof -ti :$port 2>/dev/null | while read pid; do
    log_debug "Killing process $pid on port $port"
    kill -9 "$pid" 2>/dev/null || true
  done

  sleep 1
}

# Detached process launcher for pnpm/tsx/next services.
# Uses Python so the child survives this script without keeping shell job state attached.
launch_detached() {
  local log_path="$1"
  local workdir="$2"
  shift 2

  python3 - "$log_path" "$workdir" "$@" <<'PY'
import subprocess
import sys

log_path = sys.argv[1]
workdir = sys.argv[2]
command = sys.argv[3:]
if not command:
    raise SystemExit('missing command')

with open(log_path, 'ab', buffering=0) as log_file:
    subprocess.Popen(
        command,
        cwd=workdir,
        stdin=subprocess.DEVNULL,
        stdout=log_file,
        stderr=log_file,
        start_new_session=True,
        close_fds=True,
    )
PY
}

# Start service
start_service() {
  local service=$1
  local port=$(get_service_port "$service")

  # Verify port is actually free
  local state=$(get_service_state "$service")
  if [[ "$state" != "stopped" ]]; then
    log_error "$service port $port in use but state is: $state"
    return 1
  fi

  log_info "Starting $service (port $port)..."

  local service_type=$(get_service_type "$service")
  local dir=$(get_service_dir "$service")
  local cmd=$(get_service_cmd "$service")

  # Clear old log
  rm -f "$BUILDFLOW_CONFIG_DIR/${service}.log"

  case $service_type in
    tsx)
      launch_detached "$BUILDFLOW_CONFIG_DIR/${service}.log" "$dir" pnpm exec tsx $cmd
      log_debug "Started $service via detached launcher: pnpm exec tsx $cmd"
      ;;

    next)
      # Production mode: auto-build if no .next/BUILD_ID exists, then run next start
      if [[ ! -f "$REPO_ROOT/apps/web/.next/BUILD_ID" ]]; then
        log_info "No production build found; building apps/web (BUILDFLOW_WEB_SERVER_MODE=production)..."
        (cd "$dir" && BUILDFLOW_WEB_SERVER_MODE=production pnpm build)
      fi
      export BUILDFLOW_WEB_SERVER_MODE=production
      launch_detached "$BUILDFLOW_CONFIG_DIR/${service}.log" "$dir" pnpm start
      log_debug "Started $service via detached launcher: pnpm start (BUILDFLOW_WEB_SERVER_MODE=production)"
      ;;

    docker)
      cd "$dir"
      export RELAY_ENV_FILE=~/.config/buildflow/.env.relay
      docker compose up -d > "$BUILDFLOW_CONFIG_DIR/${service}.log" 2>&1
      log_debug "Started $service via docker compose"
      ;;
  esac

  return 0
}

# Wait for service to be healthy
wait_healthy() {
  local service=$1
  local port=$(get_service_port "$service")
  local attempt=0

  log_info "Waiting for $service (port $port) to be healthy..."

  # First wait for port to be in use (longer for web/relay)
  local wait_for_port=0
  local max_port_wait=30
  if [[ "$service" == "agent" ]]; then
    max_port_wait=10
  fi

  while [[ $wait_for_port -lt $max_port_wait ]]; do
    local state=$(get_service_state "$service")
    if [[ "$state" == "running:"* ]]; then
      break
    fi
    sleep 0.5
    ((wait_for_port++))
  done

  local state=$(get_service_state "$service")
  if [[ "$state" == "stopped" ]]; then
    log_error "$service failed to start (port never became in use after ${max_port_wait}s)"
    tail -20 "$BUILDFLOW_CONFIG_DIR/${service}.log"
    return 1
  fi

  # Now wait for health check
  while [[ $attempt -lt $HEALTH_CHECK_RETRIES ]]; do
    local health=$(health_check "$service")

    if [[ "$health" == "healthy" ]]; then
      log_info "✓ $service is healthy"
      return 0
    fi

    log_debug "$service health: $health (attempt $((attempt+1))/$HEALTH_CHECK_RETRIES)"
    sleep 1
    ((attempt++))
  done

  log_error "$service failed to become healthy after $((HEALTH_CHECK_RETRIES))s"
  log_error "Service log:"
  cat "$BUILDFLOW_CONFIG_DIR/${service}.log" | tail -30
  return 1
}

# Main orchestration commands
command_status() {
  log_info "Checking BuildFlow service status..."
  echo ""
  echo "SERVICE STATUS:"
  echo "==============="

  for service in agent web relay; do
    local state=$(get_service_state "$service")
    local port=$(get_service_port "$service")

    if [[ "$state" == "stopped" ]]; then
      echo -e "${RED}● $service${NC} (port $port) - STOPPED"
    elif [[ "$state" == "running:"* ]]; then
      local pid=$(echo "$state" | cut -d: -f2)
      local health=$(health_check "$service")

      if [[ "$health" == "healthy" ]]; then
        echo -e "${GREEN}● $service${NC} (port $port, PID $pid) - RUNNING (healthy)"
      else
        echo -e "${YELLOW}● $service${NC} (port $port, PID $pid) - RUNNING (unhealthy)"
      fi
    else
      echo -e "${RED}● $service${NC} (port $port) - ERROR: $state"
    fi
  done

  echo ""
  echo "Configuration: $BUILDFLOW_CONFIG_DIR"
  echo "Log file: $EVENTS_LOG"
  echo ""
}

command_stop() {
  log_info "=== STOPPING ALL SERVICES ==="

  local failed=0

  # Stop in reverse dependency order: web -> relay -> agent
  for service in web relay agent; do
    if ! stop_service "$service"; then
      ((failed++))
    fi
  done

  sleep 1

  # Final verification
  echo ""
  log_info "=== STOP VERIFICATION ==="
  local all_stopped=true
  for service in agent web relay; do
    local state=$(get_service_state "$service")
    if [[ "$state" == "stopped" ]]; then
      log_info "✓ $service confirmed stopped"
    else
      log_error "✗ $service still in state: $state"
      all_stopped=false
    fi
  done

  if [[ "$all_stopped" == "true" ]]; then
    log_info "✓ All services stopped successfully"
    return 0
  else
    log_error "✗ Some services failed to stop"
    return 1
  fi
}

command_start() {
  log_info "=== STARTING ALL SERVICES ==="

  # Verify Docker is running
  if ! docker ps > /dev/null 2>&1; then
    log_error "Docker daemon not responding. Start OrbStack: orbctl start"
    return 1
  fi
  log_debug "✓ Docker daemon is available"

  local failed=0

  # Start in dependency order: agent -> relay -> web
  for service in agent relay web; do
    # Verify port is free before starting
    local state=$(get_service_state "$service")
    if [[ "$state" != "stopped" ]]; then
      log_warn "$service not in stopped state ($state), attempting cleanup..."
      if ! stop_service "$service"; then
        ((failed++))
        continue
      fi
      sleep 1
    fi

    if ! start_service "$service"; then
      log_error "Failed to start $service"
      ((failed++))
      continue
    fi

    if ! wait_healthy "$service"; then
      log_error "Failed to verify $service health"
      ((failed++))
      continue
    fi
  done

  sleep 1

  # Final verification
  echo ""
  log_info "=== START VERIFICATION ==="
  local all_healthy=true
  for service in agent web relay; do
    local state=$(get_service_state "$service")
    if [[ "$state" == "running:"* ]]; then
      local health=$(health_check "$service")
      if [[ "$health" == "healthy" ]]; then
        log_info "✓ $service confirmed running and healthy"
      else
        log_error "✗ $service running but unhealthy"
        all_healthy=false
      fi
    else
      log_error "✗ $service not running: $state"
      all_healthy=false
    fi
  done

  if [[ $failed -eq 0 ]] && [[ "$all_healthy" == "true" ]]; then
    log_info "✓ All services started and healthy"
    return 0
  else
    log_error "✗ $failed service(s) failed to start or become healthy"
    return 1
  fi
}

command_restart() {
  log_info "=== FULL RESTART SEQUENCE ==="

  if ! command_stop; then
    log_error "Failed to stop services, aborting restart"
    return 1
  fi

  sleep 2

  # Clean stale build artifacts
  log_info "Cleaning stale build artifacts..."
  rm -rf "$REPO_ROOT/apps/web/.next"
  log_debug "✓ Deleted apps/web/.next"

  # Rebuild
  log_info "Rebuilding packages..."
  cd "$REPO_ROOT"
  if ! pnpm -r build > "$BUILDFLOW_CONFIG_DIR/build.log" 2>&1; then
    log_error "Build failed. Log: $BUILDFLOW_CONFIG_DIR/build.log"
    tail -50 "$BUILDFLOW_CONFIG_DIR/build.log"
    return 1
  fi
  log_info "✓ Build completed successfully"

  sleep 1

  if ! command_start; then
    log_error "Failed to start services after rebuild"
    return 1
  fi

  log_info "✓ Full restart sequence complete"
  return 0
}

# Main
main() {
  init_config

  local cmd="${1:-status}"

  case $cmd in
    status)
      command_status
      ;;
    stop)
      command_stop
      ;;
    start)
      command_start
      ;;
    restart)
      command_restart
      ;;
    *)
      echo "Usage: $0 {status|start|stop|restart}"
      exit 1
      ;;
  esac
}

main "$@"
