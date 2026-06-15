#!/bin/bash
# Shell environment compatibility tests
# Tests the env-compat-resolver.sh in isolation

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Source the resolver
# shellcheck source=/dev/null
source "$SCRIPT_DIR/env-compat-resolver.sh"

# Test counter
tests_run=0
tests_passed=0
tests_failed=0

# Test helper
run_test() {
  local name="$1"
  local fn="$2"

  tests_run=$((tests_run + 1))
  echo -n "  [$tests_run] $name ... "

  if $fn; then
    tests_passed=$((tests_passed + 1))
    echo "✓"
  else
    tests_failed=$((tests_failed + 1))
    echo "✗"
  fi
}

# Test: Canonical only
test_canonical_only() {
  unset TEST_CANONICAL TEST_LEGACY 2>/dev/null || true
  export TEST_CANONICAL="canonical-value"
  local result
  result="$(resolve_env_var TEST_CANONICAL TEST_LEGACY default 2>&1)"
  [ "$result" = "canonical-value" ]
}

test_legacy_only() {
  unset TEST_CANONICAL TEST_LEGACY 2>/dev/null || true
  _env_compat_warnings=""
  export TEST_LEGACY="legacy-value"
  local result
  # Capture stdout only (stderr goes to warning)
  result="$(resolve_env_var TEST_CANONICAL TEST_LEGACY default 2>/dev/null)"
  [ "$result" = "legacy-value" ]
}

# Test: Both identical
test_both_identical() {
  unset TEST_CANONICAL TEST_LEGACY 2>/dev/null || true
  export TEST_CANONICAL="same-value"
  export TEST_LEGACY="same-value"
  local result
  result="$(resolve_env_var TEST_CANONICAL TEST_LEGACY default 2>&1)"
  [ "$result" = "same-value" ]
}

# Test: Both different (should fail)
test_both_different() {
  unset TEST_CANONICAL TEST_LEGACY 2>/dev/null || true
  export TEST_CANONICAL="canonical-val"
  export TEST_LEGACY="legacy-val"
  local result
  result="$(resolve_env_var TEST_CANONICAL TEST_LEGACY default 2>&1)" || true
  # Should fail and not print values
  [[ "$result" == *"ERROR"* ]] && [[ "$result" != *"canonical-val"* ]] && [[ "$result" != *"legacy-val"* ]]
}

# Test: Neither set (default)
test_neither_default() {
  unset TEST_CANONICAL TEST_LEGACY 2>/dev/null || true
  local result
  result="$(resolve_env_var TEST_CANONICAL TEST_LEGACY default 2>&1)"
  [ "$result" = "default" ]
}

# Test: Server modes validation
test_server_modes_valid() {
  unset WORKBENCH_WEB_SERVER_MODE BUILDFLOW_WEB_SERVER_MODE WORKBENCH_AGENT_SERVER_MODE BUILDFLOW_AGENT_SERVER_MODE 2>/dev/null || true
  export WORKBENCH_WEB_SERVER_MODE="production"
  export WORKBENCH_AGENT_SERVER_MODE="dev"
  validate_server_modes >/dev/null 2>&1
  [ "$WORKBENCH_WEB_SERVER_MODE" = "production" ] && [ "$WORKBENCH_AGENT_SERVER_MODE" = "dev" ]
}

# Test: Server modes validation (invalid)
test_server_modes_invalid() {
  unset WORKBENCH_WEB_SERVER_MODE BUILDFLOW_WEB_SERVER_MODE WORKBENCH_AGENT_SERVER_MODE BUILDFLOW_AGENT_SERVER_MODE 2>/dev/null || true
  export WORKBENCH_WEB_SERVER_MODE="invalid-mode"
  export WORKBENCH_AGENT_SERVER_MODE="dev"
  ! validate_server_modes >/dev/null 2>&1
}

# Test: Build metadata (fresh)
test_build_metadata_fresh() {
  unset WORKBENCH_BUILD_SHA BUILDFLOW_BUILD_SHA WORKBENCH_BUILD_TIMESTAMP BUILDFLOW_BUILD_TIMESTAMP 2>/dev/null || true
  validate_build_metadata 1 >/dev/null 2>&1
  # SHA should match current HEAD
  [ -n "$WORKBENCH_BUILD_SHA" ] && [ "$WORKBENCH_BUILD_SHA" != "unknown" ]
}

# Test: Build metadata (normal, conflict detection)
test_build_metadata_conflict() {
  unset WORKBENCH_BUILD_SHA BUILDFLOW_BUILD_SHA WORKBENCH_BUILD_TIMESTAMP BUILDFLOW_BUILD_TIMESTAMP 2>/dev/null || true
  export WORKBENCH_BUILD_SHA="canonical-sha"
  export BUILDFLOW_BUILD_SHA="legacy-sha"
  ! validate_build_metadata 0 >/dev/null 2>&1
}

# Run all tests
echo "Shell Environment Compatibility Tests"
echo "======================================"

run_test "resolve_env_var: canonical only" test_canonical_only
run_test "resolve_env_var: legacy only" test_legacy_only
run_test "resolve_env_var: both identical" test_both_identical
run_test "resolve_env_var: both different (fails)" test_both_different
run_test "resolve_env_var: neither set (default)" test_neither_default
run_test "validate_server_modes: valid" test_server_modes_valid
run_test "validate_server_modes: invalid" test_server_modes_invalid
run_test "validate_build_metadata: fresh derivation" test_build_metadata_fresh
run_test "validate_build_metadata: conflict detection" test_build_metadata_conflict

echo ""
echo "======================================"
echo "Tests run: $tests_run"
echo "Tests passed: $tests_passed"
echo "Tests failed: $tests_failed"
echo "======================================"

if [ $tests_failed -eq 0 ]; then
  echo "✓ All shell compatibility tests passed"
  exit 0
else
  echo "✗ $tests_failed test(s) failed"
  exit 1
fi
