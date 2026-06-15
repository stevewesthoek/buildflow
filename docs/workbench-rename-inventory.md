# BuildFlow → Workbench: Complete Rename Inventory

**Date:** 2026-06-15  
**Repository:** `/Users/Office/Repos/stevewesthoek/buildflow`  
**Starting Commit:** `ab0e136d47e81827ec7877cfb7044f0545226cc8`  
**Total BuildFlow References Found:** ~1,419 across tracked files

## Executive Summary

This inventory catalogs all active BuildFlow identifiers that must be renamed to Workbench terminology. References are classified by runtime impact, external dependencies, and compatibility considerations.

---

## Inventory by Category

### 1. Package and Workspace Identity

| Reference | Files | Category | Runtime Risk | Proposed Action | Compatibility | Phase |
|-----------|-------|----------|--------------|-----------------|---------------|----|
| `buildflow` (root package) | `./package.json` | Active package identity | HIGH | Rename to `workbench` | None—root is internal | 2 |
| `buildflow-web` (web app) | `./apps/web/package.json` | Active package identity | HIGH | Rename to `workbench-web` | None—internal dep | 2 |
| `@buildflow/shared` | `./packages/shared/package.json` | Workspace scope | HIGH | Rename to `@workbench/shared` | Update all imports | 2 |
| `buildflow` (CLI package) | `./packages/cli/package.json` | CLI binary name | HIGH | Rename to `workbench` | Retain compatibility alias | 2,3 |
| `@buildflow/shared` imports | 50+ files (`apps/web`, `packages/cli`) | Active code imports | HIGH | Update all to `@workbench/shared` | None—internal only | 2 |

**Files affected:** All `package.json`, `tsconfig.base.json`, `pnpm-lock.yaml` (generated), source imports

---

### 2. CLI Command and Executable

| Reference | Files | Category | Runtime Risk | Proposed Action | Compatibility | Phase |
|-----------|-------|----------|--------------|-----------------|---------------|----|
| `"bin": { "buildflow": ... }` | `./packages/cli/package.json` | CLI entry point | HIGH | Canonical: `workbench` | Retain `buildflow` as alias | 3 |
| `buildflow` command in scripts | `./package.json` (4 scripts) | Script invocations | MEDIUM | Update to `workbench` | None | 3 |
| buildflow CLI help text | `./packages/cli/src/index.ts` | Command UX | LOW | Update description | None | 3 |
| buildflow version output | `./packages/cli/src/index.ts` | Command UX | LOW | Update product name | None | 3 |

**Files affected:** `package.json`, `packages/cli/src/index.ts`, all scripts

---

### 3. Environment Variables

| Reference | Files/Count | Category | Runtime Risk | Proposed Action | Compatibility | Phase |
|-----------|-----------|----------|--------------|-----------------|---------------|----|
| `BUILDFLOW_ACTION_TOKEN` | `.env.example`, `apps/web/src/**` (15+) | Env var | MEDIUM | Migrate to `WORKBENCH_ACTION_TOKEN` | Read canonical first, fallback | 5 |
| `BUILDFLOW_BACKEND_MODE` | `.env.example`, `apps/web/src/**` (8+) | Env var | MEDIUM | Migrate to `WORKBENCH_BACKEND_MODE` | Read canonical first, fallback | 5 |
| `BUILDFLOW_BUILD_SHA` | `apps/web/src/api/unified-health/route.ts` | Env var (metadata) | LOW | Migrate to `WORKBENCH_BUILD_SHA` | Already has fallback | 5 |
| `BUILDFLOW_BUILD_TIMESTAMP` | `apps/web/src/api/unified-health/route.ts` | Env var (metadata) | LOW | Migrate to `WORKBENCH_BUILD_TIMESTAMP` | Already has fallback | 5 |

**Files affected:** `.env.example`, all source files reading env

---

### 4. Source Code Symbols and Identifiers

| Reference | Files | Category | Runtime Risk | Proposed Action | Compatibility | Phase |
|-----------|-------|----------|--------------|-----------------|---------------|----|
| `dispatchBuildFlowRead` | `apps/web/src/app/api/actions/**` (10+) | Function names | HIGH | Rename to `dispatchWorkbenchRead` | Refactor call sites | 4 |
| `dispatchBuildFlowInspect` | `apps/web/src/app/api/actions/**` (5+) | Function names | HIGH | Rename to `dispatchWorkbenchInspect` | Refactor call sites | 4 |
| `BuildFlow` (in comments/strings) | `apps/web/src/**`, `packages/cli/src/**` (100+) | Documentation/copy | LOW | Rename to `Workbench` or `ProChat Workbench` | None | 4 |
| `buildFlow` (in identifiers) | `apps/web/src/app/dashboard/**` (5+) | Variable names | LOW | Rename to `workbench` or camelCase equivalent | None | 4 |
| BuildFlowError classes | Source files (if any) | Error types | MEDIUM | Rename to `WorkbenchError` | Update throw/catch sites | 4 |

**Files affected:** All source files under `apps/web/src/app/api/`, `apps/web/src/app/dashboard/`, `packages/cli/src/`

---

### 5. Logging, Diagnostics, and Metrics

| Reference | Files | Category | Runtime Risk | Proposed Action | Compatibility | Phase |
|-----------|-------|----------|--------------|-----------------|---------------|----|
| "BuildFlow" log labels | `apps/web/src/app/dashboard/**` (20+) | User-facing labels | LOW | Rename to "Workbench" | None | 4 |
| BuildFlow error codes (if any) | Source (to inventory) | Error codes | MEDIUM | Migrate to WORKBENCH_* prefix | Legacy normalization layer | 4 |
| "BuildFlow completed" messages | `apps/web/src/app/api/actions/**` (5+) | User-facing messages | LOW | Rename to "Workbench completed" | None | 4 |

**Files affected:** Dashboard components, action handlers

---

### 6. OpenAPI Schema and ChatGPT Contract

| Reference | Files | Category | Runtime Risk | Proposed Action | Compatibility | Phase |
|-----------|-------|----------|--------------|-----------------|---------------|----|
| `title: 'BuildFlow API'` | `apps/web/src/app/api/openapi/route.ts` | OpenAPI metadata | MEDIUM | Change to `Workbench API` | ChatGPT requires reimport | 9 |
| `description: '..BuildFlow..'` | `apps/web/src/app/api/openapi/route.ts` (5+ occurrences) | OpenAPI metadata | LOW | Update descriptions | ChatGPT requires reimport | 9 |
| `operationId: 'readBuildFlowContext'` | `apps/web/src/app/api/openapi/route.ts` (10+) | Operation identifiers | HIGH | Keep canonical: `readWorkbenchContext` etc. | Stable external contract | 9 |
| Custom GPT instructions | External (not in repo) | GPT config | EXTERNAL | Will reimport after schema update | ChatGPT UI only | 9 |

**Files affected:** `apps/web/src/app/api/openapi/route.ts`, generated schema

---

### 7. Filesystem Paths and Persistent State

| Reference | Files | Category | Runtime Risk | Proposed Action | Compatibility | Phase |
|-----------|-------|----------|--------------|-----------------|---------------|----|
| `~/.buildflow/` | Source code, docs (5+) | Config directory | MEDIUM | Migrate to `~/.workbench/` | Safe migration handler | 6 |
| `~/.config/buildflow/` | `.env.example`, docs (5+) | Config directory | MEDIUM | Migrate to `~/.config/workbench/` | Safe migration handler | 6 |
| `/var/lib/buildflow/` | `Dockerfile`, `docker-compose.yml`, source (8+) | Persistent data | MEDIUM | Migrate to `/var/lib/workbench/` | Docker volume migration | 7 |
| `.buildflow/` (local directory) | `.gitignore`, source (3+) | Local state dir | LOW | Rename to `.workbench/` | Update gitignore | 6 |

**Files affected:** `.gitignore`, `Dockerfile`, `docker-compose.yml`, `apps/web/src/**`, docs

---

### 8. Docker Identities and Compose

| Reference | Files | Category | Runtime Risk | Proposed Action | Compatibility | Phase |
|-----------|-------|----------|--------------|-----------------|---------------|----|
| Compose project: `buildflow` | `docker-compose.yml` (implicit) | Docker project | LOW | Already uses `workbench` | No change needed | — |
| Dockerfile USER `buildflow` | `Dockerfile` (2×) | Docker user | MEDIUM | Change to `workbench` | Preserve UID/GID | 7 |
| Volume name: `buildflow_buildflow-data` | `docker-compose.yml` (1×) | Docker volume | HIGH | Migrate to `workbench_workbench-data` | Safe migration phase | 7 |
| Mount path: `/var/lib/buildflow` | `Dockerfile`, `docker-compose.yml` (3×) | Mount target | MEDIUM | Change to `/var/lib/workbench` | Consistent with migration | 7 |
| `RELAY_DATA_DIR=/var/lib/buildflow` | `docker-compose.yml` (1×) | ENV var | MEDIUM | Change to `/var/lib/workbench` | Update Dockerfile | 7 |

**Files affected:** `Dockerfile`, `docker-compose.yml`

---

### 9. Shell Scripts and Automation

| Reference | Files | Category | Runtime Risk | Proposed Action | Compatibility | Phase |
|-----------|-------|----------|--------------|-----------------|---------------|----|
| `buildflow-local-stack.sh` | `scripts/`, `package.json` | Shell script | HIGH | Rename to `workbench-local-stack.sh` | Update all references | 8 |
| `restart-buildflow-local.sh` | `scripts/`, `package.json` | Shell script | MEDIUM | Rename to `restart-workbench-local.sh` | Update references | 8 |
| `buildflow-orchestrator.sh` | Likely exists, check | Shell script | MEDIUM | Rename to `workbench-orchestrator.sh` | Update references | 8 |
| Script invocations in `package.json` | `package.json` (4+ script refs) | Script calls | HIGH | Update all shell script names | No runtime impact | 8 |
| buildflow references in scripts | Within shell scripts (10+) | Variable/comment | LOW | Update to workbench | None | 8 |

**Files affected:** All shell scripts, `package.json`, any CI config

---

### 10. Generated Output and Verification

| Reference | Files | Category | Runtime Risk | Proposed Action | Compatibility | Phase |
|-----------|-------|----------|--------------|-----------------|---------------|----|
| `docs/openapi.chatgpt.json` | Generated output | Generated schema | MEDIUM | Regenerate with new names | ChatGPT reimport required | 9 |
| `scripts/verify-buildflow-status-contract.ts` | `scripts/` | Test/verification | LOW | Rename to `verify-workbench-...` | Update references | 8 |
| Generated dist/ files | Excluded from tracking | Build artifacts | NONE | Will regenerate automatically | None needed | — |
| pnpm-lock.yaml | Excluded (generated) | Lock file | NONE | Will regenerate with `pnpm install` | None needed | — |

**Files affected:** Generated files, test scripts

---

### 11. Documentation and Configuration Examples

| Reference | Files | Category | Runtime Risk | Proposed Action | Compatibility | Phase |
|-----------|-------|----------|--------------|-----------------|---------------|----|
| `.env.example` | `.env.example` (5 refs) | Example config | LOW | Update all variable names | None | 5 |
| README references | `SETUP.md`, other docs (20+) | Current docs | LOW | Update to Workbench | Archive old | 10 |
| CLAUDE.md | `./CLAUDE.md` | Repo instructions | LOW | Update for Workbench | None | 10 |
| Historical docs | `PHASE*.md`, `IMPLEMENTATION.md` | Historical reference | NONE | Archive without modification | Preserve as historical | 10 |

**Files affected:** `.env.example`, all `.md` files

---

### 12. Git History and External State

| Reference | Files | Category | Runtime Risk | Proposed Action | Compatibility | Phase |
|-----------|-------|----------|--------------|-----------------|---------------|----|
| Git remote URL | `git remote -v` | External configuration | N/A | Rename GitHub repo (Phase 14) | Requires explicit approval | 14 |
| `.git/` directory | Excluded | Git internals | NONE | Do not rewrite history | Never touch | — |
| Commit messages | Git history | Historical | NONE | Preserve as-is | Not rewritten | — |

---

## Summary Table: Scope by Phase

| Phase | Category | Count | Risk | Action |
|-------|----------|-------|------|--------|
| 0 | Inventory | 1,419 refs | — | Document (THIS REPORT) |
| 1 | Policy | — | — | Define compatibility rules |
| 2 | Packages | 5 packages | HIGH | Rename `buildflow` → `workbench` ecosystem |
| 3 | CLI | 6 refs | HIGH | CLI canonical name + deprecation alias |
| 4 | Source | 150+ refs | HIGH | Function names, messages, symbols |
| 5 | Env vars | 4 core vars | MEDIUM | Read canonical, fallback legacy |
| 6 | Config paths | 4 paths | MEDIUM | Safe migration of local state |
| 7 | Docker | 5 refs | MEDIUM | User, volumes, mount paths |
| 8 | Scripts | 5 scripts | HIGH | Rename shell scripts |
| 9 | OpenAPI/GPT | 15 refs | MEDIUM | Schema update, ChatGPT reimport |
| 10 | Docs | 50+ refs | LOW | Archive old, update current |
| 11 | Scan | 1,419 refs | — | Verify no active refs remain |
| 12 | Fresh stack | — | — | Full validation before checkout rename |
| 13 | Checkout rename | 1 path | EXTERNAL | `/buildflow/` → `/workbench/` |
| 14 | GitHub rename | 1 repo | EXTERNAL | `buildflow` → `workbench` |

---

## Remaining BuildFlow References by File Type

### Source Code Files (~300 refs)
- `apps/web/src/app/**/*.ts(x)` — function names, UI text, log labels, comments
- `packages/cli/src/**/*.ts` — CLI help, symbols
- Tests: `apps/web/src/__tests__/**/*.ts`

### Configuration Files (~80 refs)
- `package.json` (root, apps/web, packages/cli, packages/shared)
- `tsconfig.base.json`
- `.env.example`
- `.gitignore`
- `docker-compose.yml`
- `Dockerfile`

### Scripts (~30 refs)
- `scripts/buildflow-local-stack.sh`
- `scripts/restart-buildflow-local.sh`
- Script references in `package.json`

### Documentation (~200+ refs)
- Current guides: `SETUP.md`, `README.md`, operational docs
- Historical reports: `PHASE*.md`, `IMPLEMENTATION.md`, `FINAL_HARDENING_REPORT.md`
- `.github/` templates: issue templates, config.yml

### Runtime Artifacts (~800+ refs)
- `.buildflow/` state directory (local, not version-controlled)
- `pnpm-lock.yaml` (generated, will regenerate)
- Generated OpenAPI schema (will regenerate)

---

## External Dependencies

### GitHub Repository
- Current: `https://github.com/stevewesthoek/buildflow`
- Target: `https://github.com/stevewesthoek/workbench`
- **Status:** Not renamed yet (Phase 14)

### ChatGPT Custom GPT
- Current custom action URLs reference `buildflow.prochat.tools`
- Canonical operation IDs: `readBuildFlowContext`, etc.
- **Action Required (Phase 9):** Regenerate schema and reimport into ChatGPT UI

### Cloudflare Tunnel
- Current: `buildflow.prochat.tools`
- Target: `workbench.prochat.tools`
- **Status:** External configuration (not in repo)

### Docker Hub / Registry
- No published images found in repo
- If used externally, will need separate update

---

## Compatibility Considerations

### Must Retain Temporary Aliases
1. **CLI:** `buildflow` command as fallback (with deprecation warning)
2. **Env vars:** Read `WORKBENCH_*` first, fall back to `BUILDFLOW_*`
3. **Config paths:** Detect `~/.buildflow/` and offer safe migration or fallback
4. **Shell scripts:** Small wrapper scripts with forwarding behavior

### Must NOT Break
1. **Persistent data:** Docker volumes, local cache, Git history
2. **External contracts:** ChatGPT operation IDs (already canonical)
3. **Cloudflare tunnel:** Continue working until Phase 3.5 testing complete

### Safe to Remove Immediately
1. Old comment text without semantics
2. Internal package naming (not exposed)
3. Build artifacts (will regenerate)

---

## Acceptance Criteria (Phase 11)

The rename is **complete** when:

- [ ] Zero active public-facing `buildflow` references
- [ ] Zero active package imports under `@buildflow`
- [ ] Zero canonical CLI instructions using `buildflow`
- [ ] Zero new writes to `~/.buildflow` or `/var/lib/buildflow`
- [ ] Zero canonical env variables using `BUILDFLOW_`
- [ ] OpenAPI title and descriptions use "Workbench"
- [ ] All operation IDs updated to canonical Workbench names
- [ ] All shell scripts use `workbench-` prefix
- [ ] Current documentation uses "Workbench" exclusively
- [ ] Historical docs clearly marked as archived
- [ ] Test suite passes with zero `buildflow` references in active code
- [ ] Local checkout path is `/Users/Office/Repos/stevewesthoek/workbench`
- [ ] Git remote is `https://github.com/stevewesthoek/workbench`

---

**Next Step:** Phase 1 — Define detailed compatibility policy
