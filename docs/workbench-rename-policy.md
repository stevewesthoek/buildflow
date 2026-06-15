# Workbench Rename: Compatibility and Migration Policy

**Date:** 2026-06-15  
**Status:** Draft for implementation phases 2–15  
**Supersedes:** BuildFlow branding  
**Effective Through:** Compatibility removal phase (Phase 15)

---

## 1. Canonical Replacement Mapping

| Old Identifier | New Identifier | Context | Reason |
|---|---|---|---|
| `buildflow` | `workbench` | Package name, CLI command, directory | Product rename |
| `buildflow-web` | `workbench-web` | Web app package | Consistency |
| `@buildflow/*` | `@workbench/*` | NPM scope | Consistency |
| `BuildFlow` | `Workbench` | UI text, documentation | Product rename |
| `BuildFlow Local` | `Workbench Local` or `ProChat Workbench` | Product branding | Marketing alignment |
| `BUILDFLOW_*` | `WORKBENCH_*` | Environment variables | Consistency |
| `dispatchBuildFlow*` | `dispatchWorkbench*` | Function names | Consistency |
| `~/.buildflow` | `~/.workbench` | User config dir | Consistency |
| `~/.config/buildflow` | `~/.config/workbench` | XDG config dir | Consistency |
| `/var/lib/buildflow` | `/var/lib/workbench` | System data dir | Consistency |
| `buildflow.prochat.tools` | `workbench.prochat.tools` | Public endpoint | Branding |
| `workbench-relay`, `workbench-web` | Unchanged | Docker services | Already canonical |

---

## 2. Classification and Migration Strategy

### A. Rename Immediately (No Compatibility Needed)

These are internal-only identifiers with no external consumers:

- **Root package name** (`buildflow` → `workbench`)
- **Web app package name** (`buildflow-web` → `workbench-web`)
- **Shared package scope** (`@buildflow/shared` → `@workbench/shared`)
- **All package imports** (update all `import from '@buildflow/shared'` → `@workbench/shared`)
- **Internal function names** (`dispatchBuildFlowRead` → `dispatchWorkbenchRead`)
- **Local shell scripts** (rename `buildflow-local-stack.sh` → `workbench-local-stack.sh`)
- **Comments and documentation strings** referencing BuildFlow

**Rationale:** These are never exposed to external systems or users; renaming is safe and complete.

**Deprecation:** None needed.

### B. Rename with Compatibility Alias (Single Phase)

These are exposed externally but can maintain a temporary fallback:

#### CLI Command (`buildflow` → `workbench`)
**Policy:**
- **Canonical:** `workbench` CLI command
- **Deprecated Alias:** `buildflow` (same binary, with deprecation warning)
- **Strategy:** Both names in `package.json` `"bin"` entry during compatibility phase

**Implementation:**
```json
"bin": {
  "workbench": "dist/index.js",
  "buildflow": "dist/index.js"
}
```

**Behavior:**
- When invoked as `workbench`: normal operation, no warning
- When invoked as `buildflow`: print one-line warning to stderr: `"[deprecated] 'buildflow' command is deprecated; use 'workbench' instead."`
- In JSON/machine-readable mode (`--json` flag): suppress deprecation warning

**Tests:**
- `workbench --help` works correctly
- `buildflow --help` works and emits deprecation warning
- `workbench --json` output is clean (no warning)
- `buildflow --json` output includes deprecation warning to stderr only

**Removal Condition:** Remove `buildflow` binary after one release cycle or explicit user feedback indicating adoption.

#### Environment Variables (`BUILDFLOW_*` → `WORKBENCH_*`)
**Policy:**
- **Canonical:** `WORKBENCH_ACTION_TOKEN`, `WORKBENCH_BACKEND_MODE`, etc.
- **Legacy Support:** Fall back to `BUILDFLOW_*` if canonical is not set
- **Conflict Resolution:** If both are set and differ, reject with error message
- **Strategy:** Check canonical first; if not found, check legacy

**Implementation Pattern:**
```typescript
const actionToken = process.env.WORKBENCH_ACTION_TOKEN 
  ?? process.env.BUILDFLOW_ACTION_TOKEN;

if (process.env.WORKBENCH_ACTION_TOKEN && process.env.BUILDFLOW_ACTION_TOKEN &&
    process.env.WORKBENCH_ACTION_TOKEN !== process.env.BUILDFLOW_ACTION_TOKEN) {
  throw new Error(
    'Conflicting env vars: WORKBENCH_ACTION_TOKEN and BUILDFLOW_ACTION_TOKEN differ. ' +
    'Remove the legacy BUILDFLOW_ACTION_TOKEN.'
  );
}
```

**Tests:**
- Canonical variable only → works
- Legacy variable only → works with safe warning (if applicable)
- Both identical → works silently
- Both conflicting → error with clear message
- Neither set → error or sensible default (context-dependent)

**Warning:** Never print the value of secret variables (tokens, keys, credentials).

**Removal Condition:** Remove legacy fallback after two release cycles and documentation update.

---

### C. Safe Path Migration (Multi-Step with User Choice)

These involve user-owned filesystem state and require explicit migration:

#### Local Configuration Paths
**Current:** `~/.buildflow/`, `~/.config/buildflow/`  
**Target:** `~/.workbench/`, `~/.config/workbench/`

**Policy:**
1. **Canonical path preferred:** All new writes go to Workbench paths
2. **Detection:** Read canonical first; if absent, check legacy path
3. **Migration:**
   - Provide explicit `workbench migrate-config-paths --dry-run` command
   - User reviews and approves with `workbench migrate-config-paths --apply`
   - Automatic backup created before migration
4. **Fallback:** If canonical path absent and legacy exists, use legacy temporarily with warning

**Implementation:**
- Never move directories automatically
- Never merge two directories
- Preserve all file permissions and ownership
- Verify file counts and checksums before/after
- Provide rollback: `workbench migrate-config-paths --rollback`

**Tests:**
- Dry-run shows what will be copied
- Apply safely copies without duplicating
- Both paths exist after migration is optional
- Rollback restores original state

**Removal Condition:** Remove legacy path reading after three release cycles; document in migration guide.

---

### D. Docker Data Volume Migration (Staged, No Automatic Move)

**Current:** External volume `buildflow_buildflow-data` mounting to `/var/lib/buildflow`  
**Target:** New volume with Workbench naming, mounting to `/var/lib/workbench`

**Policy:**
1. **Preserve existing volume:** Never delete old volume
2. **Create new infrastructure:** Workbench paths in code
3. **Staged migration:**
   - **Stage A:** Code uses new paths; old paths accepted as fallback
   - **Stage B:** Separate migration operation (not automatic)
   - **Stage C:** New volume created, data copied with verification
   - **Stage D:** Old volume retained as rollback backup indefinitely

**Implementation:**
- Detect if `/var/lib/buildflow` exists and has data
- If Workbench path absent but legacy exists: mount legacy temporarily
- Provide documentation for manual volume migration
- Do NOT run `docker volume rm` automatically

**Tests:**
- Old volume remains readable
- New path preferred if both exist
- Data migration can be verified with hashes
- No data loss on failed migration attempt

**Removal Condition:** Remove old volume fallback only after explicit user approval and successful migration verification.

---

### E. OpenAPI Schema and ChatGPT Contract

**Current:** Operation IDs like `readBuildFlowContext`, `applyBuildFlowFileChange`  
**Target:** Canonical operation IDs like `readWorkbenchContext`, `applyWorkbenchFileChange`

**Policy:**
1. **Operation IDs are stable:** Once published, they become part of ChatGPT's schema
2. **New operations use Workbench names:** No legacy fallback for operation IDs
3. **Schema update:** Regenerate OpenAPI schema with new names
4. **ChatGPT Reimport:** Manual step—user must reimport schema into ChatGPT Custom GPT

**Why No Alias?** Operation IDs are part of ChatGPT's stored configuration. Supporting old IDs would require ChatGPT API federation or a proxy layer, which is out of scope.

**Action (Phase 9):**
- Update `apps/web/src/app/api/openapi/route.ts` with new operation IDs
- Regenerate schema: `pnpm generate:openapi-chatgpt`
- Document: "Reimport schema in ChatGPT Custom GPT settings"
- Keep old schema available for reference during transition

**Tests:**
- Schema validates against OpenAPI 3.1.0
- All operation IDs are canonical
- ChatGPT successfully imports schema

**Removal Condition:** Retire old schema documentation after all users have upgraded.

---

## 3. Naming Conventions Going Forward

### UI/User-Facing Text
- Use **"Workbench"** or **"ProChat Workbench"** consistently
- Avoid: "BuildFlow", "build-flow", "buildflow"
- Examples:
  - ✅ "Workbench is running"
  - ✅ "ProChat Workbench scans your sources"
  - ❌ "BuildFlow is running"

### Package/Command Names
- Use **kebab-case lowercase** for command-line tools: `workbench`, `workbench-relay`
- Use **`@workbench/*`** for NPM scopes
- Avoid: `@buildflow`, `BuildFlow-cli`, `workbench-CLI`

### Environment Variables
- Use **UPPERCASE_SNAKE_CASE** with `WORKBENCH_` prefix
- Examples: `WORKBENCH_ACTION_TOKEN`, `WORKBENCH_BACKEND_MODE`
- Avoid: `WORKBENCH_actionToken`, `Workbench_*`

### Code Symbols
- Function names: `dispatchWorkbenchRead`, `readWorkbenchContext`
- Class names: `WorkbenchAction`, `WorkbenchError`
- Type names: `WorkbenchRequest`, `WorkbenchResponse`
- Avoid camelCase mixing: `dispatchWorkbench_read`, `Workbench_Read`

### Paths
- Home directory: `~/.workbench/` or `~/.config/workbench/`
- System directory: `/var/lib/workbench/`
- Avoid: `~/.buildflow`, `/opt/buildflow`

---

## 4. Communication and Deprecation

### Deprecation Warning Format

When printing a deprecation warning (e.g., for `buildflow` CLI):

```
[deprecated] 'buildflow' command is deprecated; use 'workbench' instead.
```

**Rules:**
- Single-line format for terminal output
- Emit to stderr (not stdout)
- Never include secrets or sensitive values
- Suppress in JSON/machine-readable modes
- Print during first invocation only (not every time)

### Release Notes

For each phase that introduces compatibility aliases:

```markdown
## Compatibility Notes

- `buildflow` CLI command is deprecated; use `workbench` instead. The deprecated
  command will be removed in version 2.0.
- Environment variables `BUILDFLOW_*` are deprecated; use `WORKBENCH_*` instead.
  Legacy variables are supported temporarily but will be removed in v2.0.
- Configuration paths `~/.buildflow/` are deprecated; run
  `workbench migrate-config-paths --apply` to migrate to `~/.workbench/`.
```

---

## 5. Testing Requirements

### Unit Tests
- Every compatibility layer must have a test
- Test canonical behavior (new names)
- Test legacy behavior (old names)
- Test error cases (conflicts, missing, etc.)
- Test that deprecation warnings are emitted correctly

### Integration Tests
- End-to-end with old env variables → verify fallback works
- End-to-end with new env variables → verify canonical works
- End-to-end with both identical → verify no error
- End-to-end with both conflicting → verify error message

### Manual Verification Checklist (Before Removing Alias)
- [ ] Canonical command works: `workbench --help`, `workbench --version`
- [ ] Legacy command works: `buildflow --help` (with deprecation warning)
- [ ] New env variables work
- [ ] Legacy env variables fall back correctly
- [ ] Conflicting env variables are rejected
- [ ] All documentation uses canonical names
- [ ] No new users are expected to use legacy names

---

## 6. Removal Timeline (Phase 15)

After full rollout and sufficient adoption of Workbench names, remove compatibility aliases:

### Release 2.0 (planned date TBD)
- [ ] Remove `buildflow` CLI binary
- [ ] Remove `BUILDFLOW_*` environment variable fallbacks
- [ ] Remove `~/.buildflow` path fallback
- [ ] Remove legacy config migration code
- [ ] Remove old Docker volume fallback

**Before removal:**
- Announce in release notes for v1.5, v1.7
- Provide migration guide
- Monitor adoption metrics
- Gather user feedback

**Removal process:**
- Create dedicated commits for each removed compatibility layer
- Add tests confirming removal (e.g., `buildflow` command fails with clear error)
- Update all documentation
- No force-push or history rewriting

---

## 7. Error Handling

### Scenario: User has `~/.buildflow/` but not `~/.workbench/`

**Current behavior (Phase 1–3):**
```
Workbench starting...
[info] Configuration directory not found at ~/.workbench/
[info] Found legacy configuration at ~/.buildflow/
[notice] Using legacy path temporarily. Migrate with: workbench migrate-config-paths --apply
```

**After Phase 6 (migration available):**
```
workbench migrate-config-paths --dry-run
# Shows: Would copy ~/.buildflow/ → ~/.workbench/
# Does NOT execute

workbench migrate-config-paths --apply
# Copies with progress, creates backup, verifies hashes
# Output: "Migrated 127 files. Backup at ~/.workbench/.backup-2026-06-15"
```

**After Phase 15 (legacy removed):**
```
workbench start
# Error: Configuration directory ~/.workbench/ not found
# Create one with: workbench init --config
```

### Scenario: User sets both `WORKBENCH_ACTION_TOKEN` and `BUILDFLOW_ACTION_TOKEN`

**Current behavior:**
- If identical: silently accept (same token for both)
- If different: error with message directing to remove legacy variable
- If only one set: use whichever is set

---

## 8. Exceptions and Special Cases

### Exception: Graphify and Analysis Tools
- Graphify may generate output referencing old paths
- This is acceptable; archives are historical
- No regeneration required unless explicitly run

### Exception: Docker Compose Project Name
- Already correctly configured as `workbench` in `docker-compose.yml`
- No compatibility alias needed

### Exception: Git History
- Never rewrite Git history
- Old commits may reference BuildFlow; this is intentional
- Git blame and history remain accurate

### Exception: GitHub Actions and CI
- Old CI workflow history preserves BuildFlow references
- New workflows use Workbench names
- No history cleanup needed

---

## 9. External System Dependencies

### ChatGPT Custom GPT
**Status:** Requires manual reimport after schema changes  
**Timeline:** Phase 9  
**Action:** User reimports schema through ChatGPT UI  
**No automated fallback possible** (ChatGPT stores operation IDs permanently)

### Cloudflare Tunnel
**Current:** `buildflow.prochat.tools` configured externally  
**Target:** `workbench.prochat.tools` (Phase 13+)  
**Policy:** Update only after full code rename complete

### GitHub Repository
**Current:** `github.com/stevewesthoek/buildflow`  
**Target:** `github.com/stevewesthoek/workbench` (Phase 14)  
**Old URL Behavior:** GitHub redirects old URL to new automatically

---

## 10. Acceptance Criteria

The compatibility policy is **complete** when:

- [ ] All package identities use Workbench names
- [ ] All CLI commands are canonical `workbench`
- [ ] All env variables default to `WORKBENCH_*`
- [ ] All source code uses Workbench function/type names
- [ ] OpenAPI schema updated with Workbench names
- [ ] Local paths migrate safely with user confirmation
- [ ] Docker identities consistent with Workbench
- [ ] All tests pass (both canonical and legacy paths)
- [ ] Documentation is clear about deprecation timelines
- [ ] Release notes explain each compatibility layer
- [ ] No secrets exposed in deprecation messages
- [ ] Rollback and recovery documented

---

**Next Step:** Phase 2 — Rename workspace packages and dependencies
