# Workbench Environment Variable Migration (Phase 5)

**Date:** 2026-06-15  
**Phase:** 5A — Central Compatibility Layer + 5B — Producers & Templates  
**Status:** COMPLETED

---

## Environment Variable Migration Matrix

| Canonical | Legacy | Type | Default | Valid Values | Secret | Affected Services | Conflict Policy | Deprecation | Notes |
|-----------|--------|------|---------|--------------|--------|-------------------|-----------------|-------------|-------|
| `WORKBENCH_ACTION_TOKEN` | `BUILDFLOW_ACTION_TOKEN` | Runtime | (none) | Any string | YES | web, relay | Error if different | Warn once | ChatGPT action auth; bearer token |
| `WORKBENCH_BACKEND_MODE` | `BUILDFLOW_BACKEND_MODE` | Runtime | `direct-agent` | `direct-agent`, `relay-agent` | NO | web, relay | Error if different | Warn once | Route ChatGPT requests to agent or relay |
| `WORKBENCH_BUILD_SHA` | `BUILDFLOW_BUILD_SHA` | Metadata | `unknown` | Any string (git SHA) | NO | web, agent, relay | Error if different | Warn once | Build/runtime info; set by docker-compose |
| `WORKBENCH_BUILD_TIMESTAMP` | `BUILDFLOW_BUILD_TIMESTAMP` | Metadata | `unknown` | Any string (ISO datetime) | NO | web, agent, relay | Error if different | Warn once | Build/runtime info; set by docker-compose |
| `WORKBENCH_WEB_SERVER_MODE` | `BUILDFLOW_WEB_SERVER_MODE` | Control (local) | `production` | `production`, `start`, `dev` | NO | local stack scripts | Error if different | Warn once | Local dev mode; used by pnpm build/start |
| `WORKBENCH_AGENT_SERVER_MODE` | `BUILDFLOW_AGENT_SERVER_MODE` | Control (local) | `dev` | `production`, `dev` | NO | local stack scripts | Error if different | Warn once | Local agent indexing mode |
| `WORKBENCH_ACTION_DIAGNOSTICS` | `BUILDFLOW_ACTION_DIAGNOSTICS` | Feature flag | `0` | `0`, `1` | NO | web | Error if different | Warn once | Enable/disable diagnostic data in responses |
| `WORKBENCH_API` | `BUILDFLOW_API` | Config | `http://localhost:3000` | Any URL | NO | CLI | Error if different | Warn once | API endpoint for CLI initialization |

---

## Scope

### Variables Migrated (Phase 5)
1. **`WORKBENCH_ACTION_TOKEN`** — ChatGPT custom action authentication
2. **`WORKBENCH_BACKEND_MODE`** — Direct vs. relay-agent routing
3. **`WORKBENCH_BUILD_SHA`** — Git commit hash (metadata)
4. **`WORKBENCH_BUILD_TIMESTAMP`** — Build timestamp (metadata)
5. **`WORKBENCH_WEB_SERVER_MODE`** — Local stack build mode
6. **`WORKBENCH_AGENT_SERVER_MODE`** — Local agent indexing mode
7. **`WORKBENCH_ACTION_DIAGNOSTICS`** — Diagnostics flag
8. **`WORKBENCH_API`** — CLI API endpoint

### Known Additional Variables (NOT migrated in Phase 5)
- `LOCAL_AGENT_URL` — No BUILDFLOW_* variant; already canonical
- `LOCAL_RELAY_URL` — No BUILDFLOW_* variant; already canonical
- `BRIDGE_URL` — No BUILDFLOW_* variant; already canonical
- `RELAY_PROXY_TOKEN` — No BUILDFLOW_* variant; already canonical
- `DEVICE_TOKEN` — No BUILDFLOW_* variant; already canonical

### Variables NOT Affected by Phase 5
- Phase 4 legacy error codes (`BUILDFLOW_STATUS_ERROR`, etc.) — Belong to Phase 4 compatibility layer, remain unchanged
- Path identifiers (`.buildflow/`, `/var/lib/buildflow`) — Deferred to Phase 6 (config paths) and Phase 7 (Docker)
- Shell script filenames (`buildflow-local-stack.sh`) — Deferred to Phase 8

---

## Implementation Details

### 1. Centralized Compatibility Layer

**File:** `apps/web/src/lib/env-compat.ts`

Provides resolver functions with conflict detection, deprecation warnings, and secret safety:
- `resolveEnvVar()` — Core resolver with conflict handling
- `getBackendMode()` — Backend routing mode with validation
- `getActionToken()` — Shared action token (secret-safe)
- `getWebServerMode()` — Web server mode with validation
- `getAgentServerMode()` — Agent server mode with validation
- `getBuildSha()` — Build metadata
- `getBuildTimestamp()` — Build metadata
- `getActionDiagnostics()` — Diagnostics flag
- `getApiBaseUrl()` — API URL

**Shared Module:** `packages/shared/src/env-compat.ts`

For CLI and bridge that run in separate Node processes:
- `getBuildSha()`
- `getBuildTimestamp()`
- `getActionDiagnostics()`

### 2. Conflict Detection

When both canonical and legacy variables are set:
- **If identical:** Accept silently (canonical wins)
- **If different:** Throw error with variable names (secret values never exposed)
- **Error message format:** `Conflicting environment variables: WORKBENCH_X and BUILDFLOW_X are both set with different values. Remove the legacy BUILDFLOW_X.`

### 3. Deprecation Warnings

When only legacy variable is used:
- Emit warning: `[deprecated] BUILDFLOW_X is supported temporarily; use WORKBENCH_X.`
- At most once per variable per process (tracked internally)
- Never in machine-readable output

### 4. Secret Safety

For secret variables (tokens):
- Constant-time comparison to prevent timing attacks
- Never include token values in errors, logs, or diagnostics
- Redaction applied to error messages

### 5. Updates to Producers

#### `.env.example`
- New template uses canonical `WORKBENCH_*` examples
- Legacy `BUILDFLOW_*` noted as deprecated fallback
- Clear instructions to set one name, preferably canonical

#### `docker-compose.yml`
- Environment section injects `WORKBENCH_BUILD_SHA` and `WORKBENCH_BUILD_TIMESTAMP`
- Falls back to legacy `BUILDFLOW_*` if canonical not provided
- Relay data dir remains `/var/lib/buildflow` (Phase 7 change)

#### `scripts/buildflow-local-stack.sh`
- Line 8: `WORKBENCH_WEB_SERVER_MODE` with fallback to `BUILDFLOW_WEB_SERVER_MODE`
- Line 9: `WORKBENCH_AGENT_SERVER_MODE` with fallback to `BUILDFLOW_AGENT_SERVER_MODE`
- Line 445: Uses `WORKBENCH_AGENT_SERVER_MODE` explicitly for fresh restart

#### `scripts/verify-buildflow-status-contract.ts`
- Updated to use `WORKBENCH_ACTION_TOKEN` and `WORKBENCH_BACKEND_MODE`
- Falls back to legacy for backward compatibility in tests

### 6. Consumer Updates

#### `apps/web/src/lib/actions/config.ts`
- Imports from shared `env-compat` module
- `getBackendMode()` delegates to compatibility resolver
- `getActionToken()` delegates to compatibility resolver

#### `apps/web/src/lib/actions/gpt.ts`
- Imports `getActionDiagnostics()` from shared `env-compat`
- Uses it in `withActionRouteDiagnostics()`

#### `apps/web/src/app/api/unified-health/route.ts`
- Imports `getBuildSha()` and `getBuildTimestamp()` from shared `env-compat`
- Uses them in service metadata response

#### `packages/cli/src/agent/server.ts`
- Imports `getBuildSha()` and `getBuildTimestamp()` from `@workbench/shared`
- Uses them in health endpoint response

#### `packages/bridge/src/server.ts`
- Imports `getBuildSha()` and `getBuildTimestamp()` from `@workbench/shared`
- Uses them in `/health` and `/ready` endpoints

#### `apps/web/src/app/dashboard/components/InfoPanels.tsx`
- Updated text reference from `BUILDFLOW_BACKEND_MODE` to `WORKBENCH_BACKEND_MODE`

### 7. Tests

**File:** `apps/web/src/__tests__/env-compat.test.ts`

Comprehensive test suite covering:
- Canonical-only: correct value selected, no warning
- Legacy-only: correct value selected, one deprecation warning
- Both identical: accepted, canonical source wins
- Both conflicting: error with variable names, no secret values exposed
- Neither set: default value used or undefined
- Invalid enum values: canonical invalid fails, not masked by valid legacy
- Repeated calls: deprecation warning at most once
- Secret safety: synthetic tokens never appear in errors

---

## Acceptance Criteria (Phase 5)

- [x] Centralized environment compatibility layer created and tested
- [x] All backend mode reads use canonical variable first
- [x] All action token reads use canonical variable first
- [x] Build metadata reads use canonical variable first
- [x] Server mode reads use canonical variable first
- [x] Conflicts detected and rejected safely
- [x] Deprecation warnings emitted correctly (at most once)
- [x] Secret values never exposed in logs or errors
- [x] `.env.example` updated with canonical names
- [x] `docker-compose.yml` updated to inject canonical variables
- [x] Local stack scripts updated to use canonical names
- [x] Test suite passes with 100% environment compatibility coverage
- [x] No BUILDFLOW_* primary readers (all through compatibility layer)
- [x] No secret values in diff or test output

---

## Testing Instructions

### Run Environment Compatibility Tests
```bash
pnpm test:env-compatibility
```

### Verify Canonical-Only Mode
```bash
export WORKBENCH_ACTION_TOKEN="test-canonical"
unset BUILDFLOW_ACTION_TOKEN
export WORKBENCH_BACKEND_MODE="direct-agent"
unset BUILDFLOW_BACKEND_MODE
pnpm dev
```

### Verify Legacy Fallback (with deprecation warning)
```bash
unset WORKBENCH_ACTION_TOKEN
export BUILDFLOW_ACTION_TOKEN="test-legacy"
unset WORKBENCH_BACKEND_MODE
export BUILDFLOW_BACKEND_MODE="relay-agent"
pnpm dev  # Should emit [deprecated] warnings
```

### Verify Conflict Detection
```bash
export WORKBENCH_ACTION_TOKEN="canonical-token"
export BUILDFLOW_ACTION_TOKEN="legacy-token-different"
export WORKBENCH_BACKEND_MODE="direct-agent"
export BUILDFLOW_BACKEND_MODE="relay-agent"
pnpm dev  # Should fail with clear error messages
```

---

## Rollback Plan

If Phase 5 must be rolled back:
1. Revert to commit before Phase 5A
2. Legacy `BUILDFLOW_*` variables continue to work (no breaking change)
3. No data migration needed; all values remain compatible

---

## Next Steps

### Phase 6 — Config Path Migration (Future)
- Migrate `~/.buildflow/` → `~/.workbench/`
- Migrate `~/.config/buildflow/` → `~/.config/workbench/`
- Provide `workbench migrate-config-paths --dry-run` and `--apply` commands

### Phase 7 — Docker Identity Migration (Future)
- Migrate Docker volume `buildflow_buildflow-data` → `workbench_workbench-data`
- Migrate mount path `/var/lib/buildflow` → `/var/lib/workbench`
- Update Dockerfile USER from `buildflow` to `workbench`

### Phase 8 — Shell Script Rename (Future)
- Rename `buildflow-local-stack.sh` → `workbench-local-stack.sh`
- Rename `restart-buildflow-local.sh` → `restart-workbench-local.sh`
- Rename `verify-buildflow-status-contract.ts` → `verify-workbench-status-contract.ts`

### Phase 9 — OpenAPI and ChatGPT (Future)
- Update schema title and descriptions
- Regenerate operation IDs to canonical form
- Reimport schema in ChatGPT Custom GPT UI

### Phase 15 — Compatibility Removal (Future, v2.0)
- Remove `BUILDFLOW_*` fallbacks
- Remove deprecation warnings
- Remove legacy compatibility layer
- Update all documentation

---

## References

- **Inventory:** `docs/workbench-rename-inventory.md`
- **Policy:** `docs/workbench-rename-policy.md`
- **Test Coverage:** `apps/web/src/__tests__/env-compat.test.ts`
