#!/bin/bash
# Environment variable compatibility resolver for shell scripts
# Enforces conflict detection and deprecation warnings for canonical/legacy pairs

set -euo pipefail

# Emit a deprecation warning once per shell session
# Using global variable to track which warnings have been emitted
_env_compat_warnings=""

# Helper to check if a warning has been emitted
_has_warning() {
  local var="$1"
  if echo "$_env_compat_warnings" | grep -q "^$var\$"; then
    return 0
  fi
  return 1
}

# Helper to record a warning
_record_warning() {
  local var="$1"
  _env_compat_warnings="${_env_compat_warnings}${var}"$'\n'
}

# Resolve an environment variable with canonical/legacy conflict detection
# Usage: resolve_env_var CANONICAL LEGACY DEFAULT [is_secret]
# Returns: the selected value; exits 1 if conflict detected
resolve_env_var() {
  local canonical="$1"
  local legacy="$2"
  local default="${3:-}"
  local is_secret="${4:-0}"

  local canonical_value canonical_set legacy_value legacy_set
  eval "canonical_value=\${$canonical:-}"
  [ -n "${canonical_value}" ] && canonical_set=1 || canonical_set=0
  eval "legacy_value=\${$legacy:-}"
  [ -n "${legacy_value}" ] && legacy_set=1 || legacy_set=0

  # Both set: check for conflict
  if [ "$canonical_set" = "1" ] && [ "$legacy_set" = "1" ]; then
    if [ "$canonical_value" != "$legacy_value" ]; then
      echo "ERROR: Conflicting environment variables: $canonical and $legacy are both set with different values. Remove the legacy $legacy." >&2
      return 1
    fi
    # Both identical: use canonical
    echo "$canonical_value"
    return 0
  fi

  # Canonical only: use it
  if [ "$canonical_set" = "1" ]; then
    echo "$canonical_value"
    return 0
  fi

  # Legacy only: use it with deprecation warning (once per session)
  if [ "$legacy_set" = "1" ]; then
    if ! _has_warning "$legacy"; then
      _record_warning "$legacy"
      echo "[deprecated] $legacy is supported temporarily; use $canonical." >&2
    fi
    echo "$legacy_value"
    return 0
  fi

  # Neither: use default
  if [ -n "$default" ]; then
    echo "$default"
    return 0
  fi

  # Neither and no default: return empty
  return 0
}

# Validate and export resolved build metadata for Docker Compose
# Ensures fresh restart metadata is never contaminated by stale inherited values
validate_build_metadata() {
  local should_refresh="${1:-0}"  # 1 for fresh restart, 0 for normal start

  if [ "$should_refresh" = "1" ]; then
    # Fresh restart: always derive from current repository state
    local fresh_sha fresh_ts
    fresh_sha="$(cd "$(git rev-parse --show-toplevel)" && git rev-parse HEAD || echo 'unknown')"
    fresh_ts="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"

    # Never allow inherited canonical or legacy to override freshness
    export WORKBENCH_BUILD_SHA="$fresh_sha"
    export WORKBENCH_BUILD_TIMESTAMP="$fresh_ts"
    # Clear any legacy values to prevent accidental use
    unset BUILDFLOW_BUILD_SHA 2>/dev/null || true
    unset BUILDFLOW_BUILD_TIMESTAMP 2>/dev/null || true
  else
    # Normal start: resolve with conflict detection
    local resolved_sha resolved_ts
    resolved_sha="$(resolve_env_var 'WORKBENCH_BUILD_SHA' 'BUILDFLOW_BUILD_SHA' 'unknown')" || return 1
    resolved_ts="$(resolve_env_var 'WORKBENCH_BUILD_TIMESTAMP' 'BUILDFLOW_BUILD_TIMESTAMP' 'unknown')" || return 1

    export WORKBENCH_BUILD_SHA="$resolved_sha"
    export WORKBENCH_BUILD_TIMESTAMP="$resolved_ts"
  fi
}

# Validate and resolve server modes
validate_server_modes() {
  local web_mode agent_mode

  web_mode="$(resolve_env_var 'WORKBENCH_WEB_SERVER_MODE' 'BUILDFLOW_WEB_SERVER_MODE' 'production')" || return 1
  case "$web_mode" in
    production|start|dev) ;;
    *)
      echo "ERROR: Invalid web server mode: $web_mode (must be production, start, or dev)" >&2
      return 1
      ;;
  esac
  export WORKBENCH_WEB_SERVER_MODE="$web_mode"

  agent_mode="$(resolve_env_var 'WORKBENCH_AGENT_SERVER_MODE' 'BUILDFLOW_AGENT_SERVER_MODE' 'dev')" || return 1
  case "$agent_mode" in
    production|dev) ;;
    *)
      echo "ERROR: Invalid agent server mode: $agent_mode (must be production or dev)" >&2
      return 1
      ;;
  esac
  export WORKBENCH_AGENT_SERVER_MODE="$agent_mode"
}
