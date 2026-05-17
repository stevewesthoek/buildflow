import * as http from "http";
import HttpProxy from "http-proxy";
import { spawn, ChildProcess } from "child_process";

const PORT = parseInt(process.env.PORT || "3054", 10);
const RELAY_PORT = parseInt(process.env.BRIDGE_PORT || "3053", 10);
const WEB_PORT = parseInt(process.env.WEB_PORT || "3055", 10);
const NODE_ENV = process.env.NODE_ENV || "development";

// Proxy instances
const relayProxy = HttpProxy.createProxyServer({
  target: `http://127.0.0.1:${RELAY_PORT}`,
  ws: true,
  proxyTimeout: 30000,
});

const webProxy = HttpProxy.createProxyServer({
  target: `http://127.0.0.1:${WEB_PORT}`,
  proxyTimeout: 30000,
});

// Child processes
let relayProcess: ChildProcess | null = null;
let webProcess: ChildProcess | null = null;

// Proxy timing headers help separate proxy overhead from web/relay/backend work.
function markProxyStart(req: any) {
  req.__buildflowProxyStartedAt = Date.now();
}

function attachProxyTimingHeader(proxyRes: any, req: any) {
  const startedAt = typeof req.__buildflowProxyStartedAt === "number" ? req.__buildflowProxyStartedAt : undefined;
  if (startedAt) {
    proxyRes.headers["x-buildflow-proxy-duration-ms"] = String(Date.now() - startedAt);
  }
}

relayProxy.on("proxyRes", attachProxyTimingHeader);
webProxy.on("proxyRes", attachProxyTimingHeader);

// Error handlers for proxies
relayProxy.on("error", (err: Error, req: any, res: any) => {
  console.error(`[proxy] relay error:`, err.message);
  if (!res.headersSent) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ error: "Relay service unavailable", status: 503 })
    );
  }
});

webProxy.on("error", (err: Error, req: any, res: any) => {
  console.error(`[proxy] web error:`, err.message);
  if (!res.headersSent) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Web service unavailable", status: 503 }));
  }
});

// Strict readiness check: confirm both relay and web are healthy
async function checkReadiness(): Promise<{ ready: boolean; reason?: string }> {
  return new Promise((resolve) => {
    // Check relay /ready
    const relayReq = http.get(
      `http://127.0.0.1:${RELAY_PORT}/ready`,
      { timeout: 2000 },
      (res) => {
        if (res.statusCode === 200) {
          resolve({ ready: true });
        } else {
          resolve({ ready: false, reason: `relay /ready returned ${res.statusCode}` });
        }
        res.resume();
      }
    );
    relayReq.on("error", (err) => {
      resolve({ ready: false, reason: "relay unreachable" });
    });
  });
}

// Create main proxy server
const server = http.createServer(async (req, res) => {
  const url = req.url || "/";
  const method = req.method || "GET";

  // Proxy's own health/ready endpoints - strict readiness check
  if (url === "/ready" && method === "GET") {
    const result = await checkReadiness();
    if (result.ready) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ready", timestamp: new Date().toISOString() }));
    } else {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "not_ready" }));
    }
    return;
  }

  if (url === "/health" && method === "GET") {
    const result = await checkReadiness();
    const statusCode = result.ready ? 200 : 503;
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: result.ready ? "healthy" : "unhealthy",
      relay: relayProcess ? "running" : "stopped",
      web: webProcess ? "running" : "stopped",
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  // Relay routes
  if (
    url.startsWith("/api/register") ||
    url.startsWith("/api/bridge/ws") ||
    url.startsWith("/api/admin")
  ) {
    markProxyStart(req);
    relayProxy.web(req, res);
    return;
  }

  // Web app routes
  if (
    url.startsWith("/api/openapi") ||
    url.startsWith("/api/actions") ||
    url.startsWith("/dashboard")
  ) {
    markProxyStart(req);
    webProxy.web(req, res);
    return;
  }

  // Default to web app
  markProxyStart(req);
  webProxy.web(req, res);
});

// WebSocket upgrade handler
server.on("upgrade", (req, socket, head) => {
  const url = req.url || "/";

  // Relay WebSocket routes
  if (url.startsWith("/api/bridge/ws")) {
    relayProxy.ws(req, socket, head);
    return;
  }

  // Default to web
  webProxy.ws(req, socket, head);
});

// Start child services
function startRelayService(): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`[services] Starting relay on port ${RELAY_PORT}...`);

    relayProcess = spawn("node", ["./packages/bridge/dist/server.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BRIDGE_PORT: String(RELAY_PORT),
        NODE_ENV,
      },
      stdio: "inherit",
    });

    relayProcess.on("error", (err) => {
      console.error(`[services] relay process error:`, err);
      reject(err);
    });

    relayProcess.on("exit", (code, signal) => {
      console.warn(
        `[services] relay exited with code ${code}, signal ${signal}`
      );
    });

    // Wait a bit for relay to start listening
    setTimeout(resolve, 2000);
  });
}

function startWebService(): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`[services] Starting web on port ${WEB_PORT}...`);

    webProcess = spawn("node", ["node_modules/next/dist/bin/next", "start"], {
      cwd: `${process.cwd()}/apps/web`,
      env: {
        ...process.env,
        PORT: String(WEB_PORT),
        NODE_ENV,
      },
      stdio: "inherit",
    });

    webProcess.on("error", (err) => {
      console.error(`[services] web process error:`, err);
      reject(err);
    });

    webProcess.on("exit", (code, signal) => {
      console.warn(`[services] web exited with code ${code}, signal ${signal}`);
    });

    // Wait a bit for web to start listening
    setTimeout(resolve, 2000);
  });
}

// Graceful shutdown
async function shutdown(signal: string) {
  console.log(`[proxy] Received ${signal}, shutting down gracefully...`);

  server.close(() => {
    console.log("[proxy] Server closed");
  });

  if (relayProcess && !relayProcess.killed) {
    console.log("[services] Stopping relay...");
    relayProcess.kill("SIGTERM");
  }

  if (webProcess && !webProcess.killed) {
    console.log("[services] Stopping web...");
    webProcess.kill("SIGTERM");
  }

  // Wait for processes to exit
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Force kill if still running
  if (relayProcess && !relayProcess.killed) {
    console.warn("[services] Force killing relay");
    relayProcess.kill("SIGKILL");
  }

  if (webProcess && !webProcess.killed) {
    console.warn("[services] Force killing web");
    webProcess.kill("SIGKILL");
  }

  console.log("[proxy] Shutdown complete");
  process.exit(0);
}

// Main startup
async function main() {
  try {
    console.log(`[buildflow] Starting production topology on port ${PORT}`);
    console.log(
      `[buildflow] NODE_ENV=${NODE_ENV}, relay=${RELAY_PORT}, web=${WEB_PORT}`
    );

    await startRelayService();
    await startWebService();

    server.listen(PORT, "0.0.0.0", () => {
      console.log(`[proxy] Proxy listening on 0.0.0.0:${PORT}`);
      console.log(
        `[buildflow] Production topology ready: relay←3053, web←3055, proxy→${PORT}`
      );
    });

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  } catch (err) {
    console.error("[buildflow] Startup failed:", err);
    process.exit(1);
  }
}

main();
