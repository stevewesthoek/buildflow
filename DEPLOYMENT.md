# ProChat Workbench Deployment Readiness

This document describes the runtime contract and deployment workflow for ProChat Workbench, powered by the BuildFlow relay engine.

## Current URL ownership and migration safety

`https://workbench.prochat.tools` is the canonical public endpoint for ProChat Workbench and is available through the active Cloudflare tunnel.

`https://buildflow.prochat.tools` is the legacy compatibility endpoint. Keep it functional for existing Custom GPT action schemas, bookmarks, and integrations until a separate compatibility retirement is approved. Prefer a proxy or alias to the same service rather than relying on redirects for authenticated POST requests.

Steve's current local Workbench setup must remain untouched while any Dokploy deployment is prepared and tested. Do not stop, restart, clean up, reconfigure, or decommission the local runtime as part of deployment planning.

Protected local configuration:
- Do not edit `apps/web/.env.local`.
- Do not read or print secret values from `apps/web/.env.local`.
- Do not change Steve's current local `BUILDFLOW_ACTION_TOKEN`.
- Do not reuse, regenerate, replace, or copy Steve's local `BUILDFLOW_ACTION_TOKEN` into Dokploy.

Endpoint policy:
1. **Canonical public endpoint:** `workbench.prochat.tools`.
2. **Legacy compatibility endpoint:** `buildflow.prochat.tools` must continue reaching the same service during the migration period.
3. **Staging:** use a clearly separate staging hostname before any production infrastructure cutover.
4. **Production cutover:** only after staging is proven and Steve explicitly approves the cutover.
5. **Local cleanup:** only after production is proven stable and Steve explicitly approves decommissioning the old local runtime.

Reserve `api.prochat.tools` for the future suite-wide ProChat API rather than using it as a Workbench-specific hostname.

## Overview

BuildFlow Relay is a WebSocket bridge that:
- Receives device connections from local agents
- Routes commands between external requesters and local devices
- Maintains session state with audit logging
- Validates configuration on startup
- Provides health and readiness probes for orchestrators

## Runtime Contract

### Environment Variables

| Variable | Type | Default | Required | Purpose |
|----------|------|---------|----------|---------|
| `BRIDGE_PORT` | int | 3053 | no | Relay server listen port |
| `RELAY_DATA_DIR` | string | `~/.buildflow` | no | Data directory for state persistence |
| `RELAY_ADMIN_TOKEN` | string | — | no | Bearer token for admin endpoints; enables auth if set |
| `BUILDFLOW_BACKEND_MODE` | string | `direct-agent` | no | Execution mode: `direct-agent` (local, no relay) or `relay-agent` (production, routes through relay) |
| `RELAY_ENABLE_DEFAULT_TOKENS` | string | `"true"` | no | Enable default development tokens for testing |
| `NODE_ENV` | string | `development` | no | Runtime environment (`development` or `production`) |

**Deprecated variables:**
- `RELAY_PROXY_TOKEN` — Historical planning variable only. Do not use for current Dokploy deployment. Hosted relay-agent routing uses incoming user/device bearer tokens; `RELAY_ADMIN_TOKEN` is for admin endpoints only.

### Data Directory

All persistent state is stored in `RELAY_DATA_DIR` (defaults to `~/.buildflow`):

```
RELAY_DATA_DIR/
├── relay-tokens.json       # Device authentication tokens
├── relay-devices.json      # Device registry (online/offline tracking)
├── relay-requests.json     # Request audit log (JSON array)
├── relay-sessions.log      # Session audit log (newline-delimited JSON)
└── relay.audit.log         # Server startup and runtime events
```

For containerized deployments, mount a persistent volume at this path.

### Required Preconditions

On startup, the relay validates:

1. **Port validity** — `BRIDGE_PORT` is 1–65535
2. **Data directory writability** — Can create/read/delete files in `RELAY_DATA_DIR`
3. **Config correctness** — All config paths are absolute or safe relative paths

If any check fails, the server exits with code 1 and logs a clear error.

### Startup Behavior

```
[Startup] Loading configuration...
[Startup] Configuration loaded:
  • bridgePort: 3053
  • dataDir: /var/lib/buildflow
  • relayAdminToken: [REDACTED]
  • enableDefaultTokens: false
  • nodeEnv: production
[Startup] Testing data directory writability...
[Startup] ✓ Data directory ready: /var/lib/buildflow
[Startup] ✓ All startup checks passed
[Bridge] Loading persisted state...
[Bridge] ✓ Default tokens disabled
[Bridge] ✓ Admin endpoint authentication enabled
[Bridge] Relay running on http://127.0.0.1:3053
```

All logs go to stderr. Status info goes to stdout.

### Endpoints

#### Health Probe
```
GET /health
```

Returns 200 with operational status (public endpoint, no sensitive data):
```json
{
  "status": "ok",
  "port": 3053,
  "connectedDevices": 2
}
```

**Response fields:**
- `status` — Operational state ("ok" if relay running and ready)
- `port` — Relay listening port
- `connectedDevices` — Count only, no device IDs or timestamps (privacy by design)

**Use case:** Monitoring, dashboards, manual checks, load balancer health verification

**Privacy note:** Device IDs, connection times, and heartbeat timestamps are available only via `/api/admin/devices` endpoint with `RELAY_ADMIN_TOKEN` authentication (ops/monitoring use only).

#### Readiness Probe
```
GET /ready
```

Returns 200 if relay is ready for traffic:
```json
{
  "ready": true,
  "dataDir": "/var/lib/buildflow"
}
```

Returns 503 if not ready:
```json
{
  "ready": false,
  "reason": "data_dir_not_writable"
}
```

**Use case:** Kubernetes readiness probes, load balancer health checks, orchestrator startup validation

The readiness check:
- Validates the relay completed startup
- Tests that the data directory is still writable (creates and deletes a temp file)
- Confirms the relay can persist state

#### Device Registration
```
POST /api/register
```

Registers a new device with a one-time token. Returns WebSocket URL and device ID.

#### Admin Endpoints
```
POST   /api/sessions              # Create session
GET    /api/sessions              # List sessions
GET    /api/sessions/{id}         # Get session details
POST   /api/sessions/{id}/close   # Close session
GET    /api/admin/devices         # List all devices
GET    /api/admin/requests        # View request audit log
```

These endpoints require `Authorization: Bearer <token>` if `RELAY_ADMIN_TOKEN` is set.

#### Command Execution
```
POST /api/commands              # Route command to device (legacy)
POST /api/commands/session      # Route command via session (new)
```

## Deployment Workflows

### 1. Local Hosted (No Docker)

**Setup:**

```bash
# Clone and install
git clone <repo> buildflow
cd buildflow
pnpm install

# Configure environment
export BRIDGE_PORT=3053
export RELAY_DATA_DIR=~/.buildflow
export RELAY_ADMIN_TOKEN=dev-token-123
export RELAY_ENABLE_DEFAULT_TOKENS=false

# Build
pnpm build

# Start relay (in foreground for testing)
cd packages/bridge
pnpm start
```

**Verify:**

```bash
# Health check
curl http://localhost:3053/health

# Readiness check (should pass after startup)
curl http://localhost:3053/ready

# Admin endpoint with auth
curl -H "Authorization: Bearer dev-token-123" \
  http://localhost:3053/api/sessions
```

**For production persistence:**

```bash
# Create persistent data directory
mkdir -p /var/lib/buildflow
chmod 700 /var/lib/buildflow

# Set environment
export RELAY_DATA_DIR=/var/lib/buildflow
export RELAY_ADMIN_TOKEN=<generate-strong-token>
export RELAY_ENABLE_DEFAULT_TOKENS=false
export NODE_ENV=production

# Run
cd packages/bridge
pnpm start
```

> Migration safety note: the Docker and Docker Compose examples below are local-development/reference examples only. They are not the current Dokploy migration procedure and must not be used to stop, replace, or clean up Steve's working local BuildFlow setup.

### 2. Docker Hosted

**Build and run:**

```bash
# Build image
docker build -t buildflow:latest .

# Run container
docker run -d \
  --name buildflow-relay \
  -p 3053:3053 \
  -e RELAY_ADMIN_TOKEN=prod-token-123 \
  -e RELAY_ENABLE_DEFAULT_TOKENS=false \
  -v buildflow-data:/var/lib/buildflow \
  buildflow:latest

# Verify
docker logs buildflow-relay
docker exec buildflow-relay curl -s http://localhost:3053/ready | jq .
```

**With environment file:**

```bash
# Create .env.deployment
cat > .env.deployment << 'EOF'
BRIDGE_PORT=3053
RELAY_ADMIN_TOKEN=prod-token-123
RELAY_ENABLE_DEFAULT_TOKENS=false
NODE_ENV=production
EOF

# Run with env file
docker run -d \
  --name buildflow-relay \
  -p 3053:3053 \
  --env-file .env.deployment \
  -v buildflow-data:/var/lib/buildflow \
  buildflow:latest
```

### 3. Docker Compose

**Start stack:**

```bash
# Configure env
cat > .env.deployment << 'EOF'
RELAY_ADMIN_TOKEN=prod-token-123
RELAY_ENABLE_DEFAULT_TOKENS=false
NODE_ENV=production
EOF

# Start
docker-compose up -d

# View logs
docker-compose logs relay

# Verify readiness
docker-compose exec relay curl http://localhost:3053/ready
```

**Stop stack:**

```bash
docker-compose down
# Data persists in Docker volume
```

## Verification Checklist

After deployment, verify:

- [ ] Relay starts without errors
- [ ] `/health` returns 200
- [ ] `/ready` returns 200
- [ ] Data directory exists and is writable
- [ ] Admin endpoints require token if `RELAY_ADMIN_TOKEN` set
- [ ] Logs show "Startup checks passed"
- [ ] No sensitive values (like tokens) in stdout

## Troubleshooting

### Startup Fails: "Data directory not writable"

**Cause:** The relay cannot write to `RELAY_DATA_DIR`.

**Fix:**
```bash
# Verify directory exists and is writable
ls -la $(echo $RELAY_DATA_DIR)
chmod 700 $RELAY_DATA_DIR

# If running in container, check volume mount
docker inspect buildflow-relay | grep -A 5 Mounts
```

### Readiness Check Returns 503

**Cause:** Data directory became read-only after startup.

**Fix:**
```bash
# Check filesystem permissions
df -h $RELAY_DATA_DIR
ls -la $RELAY_DATA_DIR

# Restart relay
docker restart buildflow-relay
```

### Admin Endpoint Returns 403

**Cause:** Token is missing or invalid.

**Fix:**
```bash
# Verify token env var is set
echo $RELAY_ADMIN_TOKEN

# Check bearer token header
curl -v -H "Authorization: Bearer $RELAY_ADMIN_TOKEN" \
  http://localhost:3053/api/sessions
```

### High Memory or Disk Usage

**Cause:** Request or session audit logs grew too large.

**Fix:**
```bash
# Check log sizes
ls -lh $RELAY_DATA_DIR/*.json

# Manually clean old logs (optional, auto-rotate coming in next phase)
rm $RELAY_DATA_DIR/relay-requests.json
# Relay will recreate on next write
```

## Known Limitations

1. **No multi-instance clustering** — Single relay per deployment; horizontal scaling TBD
2. **No external secret management** — Tokens via env vars only (use container secrets for prod)
3. **No structured logging** — Plain text logs; structured logging TBD
4. **No log rotation policy** — Request audit may grow indefinitely; rotation coming in 2E
5. **No database persistence** — State lost on relay restart (in-memory only); persistence TBD
6. **Development tokens optional** — Can be disabled via `RELAY_ENABLE_DEFAULT_TOKENS=false`

## Web App (Next.js on port 3054)

The web app provides ChatGPT Custom Actions endpoints and a dashboard.

### Environment Setup (NEW DEVELOPMENT ONLY)

**⚠️ Current local setup note:** Steve's current local `apps/web/.env.local` contains the active local `BUILDFLOW_ACTION_TOKEN`. **Do not edit this file during Dokploy migration.** The current local setup must remain stable and unchanged.

**For new non-Steve development environments only:**

```bash
# New development environment only — do not run on Steve's current machine.
# Do not edit Steve's current apps/web/.env.local.
# Generate a new token for this new development environment only.
NEW_BUILDFLOW_ACTION_TOKEN="[generate-new-token-for-this-new-environment-only]"
# Example .env.local values for a new dev environment only:
# BUILDFLOW_ACTION_TOKEN="[new-dev-token-only]"
# LOCAL_AGENT_URL="http://127.0.0.1:3052"
```

### ChatGPT Actions Contract

**Public endpoints** (require `Authorization: Bearer <BUILDFLOW_ACTION_TOKEN>`):

- `POST /api/actions/search` — Search local vault
- `POST /api/actions/read` — Read file from vault
- `POST /api/actions/search-and-read` — Combined search + read

**Public schema:**
- `GET /api/openapi` — Returns OpenAPI 3.1.0 schema for ChatGPT import

### Runtime Architecture

ChatGPT Actions flow:
```
ChatGPT Custom GPT
    ↓ (HTTPS with Bearer token)
    ↓
Web App (3054)
    ↓ (HTTP POST to local agent)
    ↓
Local Agent (3052)
    ↓ (responds with search results / file content)
    ↓
Web App (3054)
    ↓ (returns to ChatGPT)
    ↓
ChatGPT Custom GPT
```

**Note:** Web app forwards directly to local agent (3052) via HTTP. Relay (3053) is NOT in the ChatGPT request path. Relay is only for agent coordination and WebSocket connections.

### Local Testing

Start all three surfaces:

```bash
# Terminal 1: Start relay (requires docker/docker-compose)
docker compose up -d

# Terminal 2: Start agent
cd packages/cli
BRIDGE_URL=ws://localhost:3053 \
DEVICE_TOKEN=local-test-token \
npx tsx src/index.ts serve

# Terminal 3: Start web app with token
cd apps/web
export BUILDFLOW_ACTION_TOKEN="test-action-token-from-openssl"
export LOCAL_AGENT_URL="http://127.0.0.1:3052"
npm run start
```

Test endpoint:
```bash
curl -X POST http://localhost:3054/api/actions/search \
  -H "Authorization: Bearer test-action-token-from-openssl" \
  -H "Content-Type: application/json" \
  -d '{"query":"brain","limit":5}'
```

Expected response (if agent is running):
```json
{
  "results": [
    {
      "path": "path/to/file.md",
      "title": "File Title",
      "snippet": "...",
      "score": 0.95,
      "modifiedAt": "2026-04-19T..."
    }
  ]
}
```

### Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| `"Server configuration error: BUILDFLOW_ACTION_TOKEN not set"` | Token not in env | Set `BUILDFLOW_ACTION_TOKEN` before starting web app |
| `"Unauthorized"` | Wrong or missing Bearer token | Verify `Authorization: Bearer <token>` header matches env var |
| `"Search error: TypeError: fetch failed"` | Agent not running on 3052 | Ensure agent is running with `BRIDGE_URL=ws://localhost:3053` |
| `"Search failed: 500"` | Agent error | Check agent logs for vault path or permission errors |

### Backend Modes (Phase 5B+)

**Token model:** RELAY_ADMIN_TOKEN is for admin endpoints only. Hosted relay-agent routing uses incoming user/device bearer tokens. RELAY_PROXY_TOKEN is historical/planning/deprecated only and must not be used as current deployment guidance. Steve's current local BUILDFLOW_ACTION_TOKEN is local-only and must not be reused, regenerated, replaced, edited, or copied into Dokploy.

The web app supports configurable backend modes for action execution:

**direct-agent (default):**
- Web app (3054) forwards requests directly to local agent (3052)
- Set: `BUILDFLOW_BACKEND_MODE=direct-agent` or leave unset
- Status: Fully supported and tested
- Use case: Local-only deployments, development
- Authentication: None required (direct local connection)

**relay-agent (production on Dokploy):**
- Web app routes requests through relay (3053) to connected device
- **Relay IS in the ChatGPT request path** (request path: ChatGPT → proxy 3054 → web 3055 → relay 3053 → device)
- Set: `BUILDFLOW_BACKEND_MODE=relay-agent`
- Status: Fully supported with request-token passthrough authentication
- Use case: Production deployment on Dokploy, multi-device support
- Authentication: Web layer forwards incoming user/device bearer tokens to relay (token passthrough, no global validation)
- When needed: Ensure relay is running on 3053 and at least one device is connected via WebSocket

**Request flow in relay-agent mode (production):**
1. ChatGPT sends: `POST https://buildflow-staging.prochat.tools/api/actions/search` with user bearer token
2. Dokploy proxy routes to web app (3055) internally
3. Web app reads incoming bearer token and forwards to relay (3053) as `Authorization: Bearer <user-token>`
4. Relay validates token against registered devices and routes to matching WebSocket connection
5. Local device processes request and responds via WebSocket
6. Response returned to ChatGPT

To enable relay-backed execution (production):
1. Set `BUILDFLOW_BACKEND_MODE=relay-agent` on web app
2. Relay is running on port 3053 (inside same container)
3. Each user's agent connects to relay with its own registered device token
4. Relay validates tokens and routes each request to the corresponding user's device

## Next Phase

Deployment 2E will add:
- Database-backed session persistence
- Structured JSON logging with log rotation
- Horizontal scaling support
- External secret store integration
- Kubernetes manifests and Helm charts
