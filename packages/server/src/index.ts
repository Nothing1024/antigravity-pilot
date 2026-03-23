import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import { WebSocketServer } from "ws";

import { DISCOVERY_INTERVAL, POLL_INTERVAL } from "@ag/shared";

import { authMiddleware, authRouter } from "./api/auth";
import { parseCookies, verifyToken } from "./auth/token";
import { config } from "./config";
import { discover } from "./loop/discovery";
import { updateSnapshots } from "./loop/snapshot";
import { globalRateLimit, completionsRateLimit } from "./middleware/ratelimit";
import { updatePhases } from "./monitor/phase";
import { runHealthChecks } from "./pool/health";
import { initWebhooks } from "./webhooks/notify";
import { broadcastCascadeList, initBroadcast } from "./ws/broadcast";

function repoRootFromHere(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../");
}

async function loadApiRouters(): Promise<express.Router[]> {
  // Task#26 now provides these routers. Keep this as plain imports if possible,
  // but tolerate missing exports during iterative migration.
  const routers: express.Router[] = [];

  try {
    const mod: any = await import("./api/process");
    routers.push(mod.processRouter || mod.router || mod.default);
  } catch {}

  try {
    const mod: any = await import("./api/project");
    routers.push(mod.projectRouter || mod.router || mod.default);
  } catch {}

  try {
    const mod: any = await import("./api/cascade");
    routers.push(mod.cascadeRouter || mod.router || mod.default);
  } catch {}

  try {
    const mod: any = await import("./api/interaction");
    routers.push(mod.interactionRouter || mod.router || mod.default);
  } catch {}

  // F3: Status API
  try {
    const mod: any = await import("./api/status");
    routers.push(mod.statusRouter || mod.router || mod.default);
  } catch {}

  // Phase 2: Session & Model API
  try {
    const mod: any = await import("./api/session");
    routers.push(mod.sessionRouter || mod.router || mod.default);
  } catch {}

  // Workspace API
  try {
    const mod: any = await import("./api/workspace");
    routers.push(mod.workspaceRouter || mod.router || mod.default);
  } catch {}

  // F4: OpenAI-Compatible API
  if (config.api.openaiCompat) {
    try {
      const mod: any = await import("./api/openai-compat");
      routers.push(mod.openaiRouter || mod.router || mod.default);
    } catch {}
  }

  return routers.filter(Boolean);
}

async function main(): Promise<void> {
  const app = express();
  app.set("trust proxy", true);

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  initBroadcast(wss);

  app.use(express.json());

  // --- Auth routes (no auth required) ---
  app.use(authRouter);

  const repoRoot = repoRootFromHere();

  // Auth middleware — protects everything else
  app.use(authMiddleware);

  // F7: Rate limiting (after auth so we can identify clients by API key)
  app.use(globalRateLimit);
  // Stricter limit for completions endpoint
  app.use("/v1/chat/completions", completionsRateLimit);

  // Task#26 routers (modularized API)
  for (const r of await loadApiRouters()) app.use(r);

  // Serve React build output (production mode)
  const webDistDir = path.join(repoRoot, "packages", "web", "dist");
  const hasWebDist = fs.existsSync(path.join(webDistDir, "index.html"));

  if (hasWebDist) {
    app.use(express.static(webDistDir));
    // SPA fallback: send index.html for any unmatched GET request
    app.get("*", (req, res) => {
      res.sendFile(path.join(webDistDir, "index.html"));
    });
    console.log(`📦 Serving React build from ${webDistDir}`);
  } else {
    console.log(`ℹ️  No React build found — run 'pnpm build' for production, or use Vite dev server`);
  }

  // WebSocket auth check — supports Cookie auth AND Bearer token
  wss.on("connection", (ws, req) => {
    const cookies = parseCookies(req.headers.cookie);
    const isAuthed = verifyToken(cookies.auth);

    // Also check query param for WS Bearer auth: /ws?token=sk-xxx
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const queryToken = url.searchParams.get("token");
    const apiKeys = config.apiKeys || [];
    const isApiAuthed = queryToken
      ? apiKeys.some((k) => k.key === queryToken)
      : false;

    if (!isAuthed && !isApiAuthed) {
      ws.close(4001, "Unauthorized");
      return;
    }
    broadcastCascadeList(); // Send list on connect
  });

  server.listen(config.port, "0.0.0.0", () => {
    console.log(`🚀 Server running on port ${config.port}`);
    if (config.api.openaiCompat) {
      console.log(`🤖 OpenAI-compatible API: http://0.0.0.0:${config.port}/v1/chat/completions`);
    }
    if (config.apiKeys.length > 0) {
      console.log(`🔑 API Keys configured: ${config.apiKeys.length} key(s)`);
    }
  });

  // F6: Initialize webhook listeners
  initWebhooks();

  // Start loops
  discover();
  setInterval(discover, DISCOVERY_INTERVAL);

  // Self-scheduling snapshot loop: prevents overlapping when CDP calls are slow
  async function snapshotLoop(): Promise<void> {
    await updateSnapshots();
    // F2: Phase detection piggybacks on snapshot loop
    await updatePhases();
    setTimeout(() => void snapshotLoop(), POLL_INTERVAL);
  }
  void snapshotLoop();

  // F1: Connection Pool health checks
  const healthCheckInterval = config.connectionPool.healthCheckInterval;
  setInterval(() => {
    runHealthChecks().catch((e) => {
      console.error("Health check error:", e.message);
    });
  }, healthCheckInterval);
  console.log(`💓 Health check loop: every ${healthCheckInterval / 1000}s`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
