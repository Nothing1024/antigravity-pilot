import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import { WebSocketServer } from "ws";

import { POLL_INTERVAL } from "@ag/shared";

import { authMiddleware, authRouter } from "./api/auth";
import { parseCookies, verifyToken } from "./auth/token";
import { config } from "./config";
import { discover } from "./cdp/discovery";
import { updateSnapshots, updateCdpTasks } from "./loop/snapshot";
import { globalRateLimit, completionsRateLimit } from "./middleware/ratelimit";
import { updatePhases } from "./monitor/phase";
import { runHealthChecks } from "./pool/health";
import { setupConversationWebSocket } from "./rpc/ws-poller";
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

  // Deprecated: use /api/conversations for session and conversation management.
  try {
    const mod: any = await import("./api/session");
    routers.push(mod.sessionRouter || mod.router || mod.default);
  } catch {}

  // Workspace API
  try {
    const mod: any = await import("./api/workspace");
    routers.push(mod.workspaceRouter || mod.router || mod.default);
  } catch {}

  try {
    const mod: any = await import("./api/conversations");
    routers.push(mod.conversationsRouter || mod.router || mod.default);
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
  const wss = new WebSocketServer({ noServer: true });

  // Broadcast WS: /ws
  // Use noServer mode so it doesn't reject other WS upgrade paths (e.g. /api/conversations/:id/ws).
  server.on("upgrade", (req, socket, head) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      if (url.pathname !== "/ws") return;

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } catch {
      socket.destroy();
    }
  });

  initBroadcast(wss);
  // Phase 4: per-conversation WS delta polling
  setupConversationWebSocket(server, config.port);

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
    // ── Startup Banner ──
    const rpcEnabled = config.rpc.enabled;
    const fallback = config.rpc.fallbackToCDP;
    const mode = rpcEnabled ? "RPC Mode" : "CDP Mode (Legacy)";

    console.log(``);
    console.log(`╔══════════════════════════════════════════════════╗`);
    console.log(`║          🚀 Antigravity Pilot v3.0               ║`);
    console.log(`╠══════════════════════════════════════════════════╣`);
    console.log(`║  Mode:      ${mode.padEnd(37)}║`);
    console.log(`║  Port:      ${String(config.port).padEnd(37)}║`);
    console.log(`╠══════════════════════════════════════════════════╣`);
    if (rpcEnabled) {
      console.log(`║  RPC:       ✅ enabled (消息/状态/Steps)         ║`);
      console.log(`║    fallback → CDP:  ${(fallback ? 'yes' : 'no').padEnd(28)}║`);
      console.log(`║    discovery:       ${(config.rpc.discoveryInterval / 1000 + 's').padEnd(28)}║`);
      console.log(`║    active poll:     ${(config.rpc.activePollInterval + 'ms').padEnd(28)}║`);
      console.log(`║    idle poll:       ${(config.rpc.idlePollInterval / 1000 + 's').padEnd(28)}║`);
    } else {
      console.log(`║  RPC:       ❌ disabled                         ║`);
    }
    console.log(`║  CDP:       ✅ always on (UI 镜像/点击转发)       ║`);
    console.log(`║    ports:           ${config.cdp.ports.join(', ').padEnd(28)}║`);
    console.log(`╠══════════════════════════════════════════════════╣`);
    if (config.api.openaiCompat) {
      console.log(`║  OpenAI API: http://0.0.0.0:${config.port}/v1/chat/completions`);
    }
    if (config.apiKeys.length > 0) {
      console.log(`║  API Keys:  ${(config.apiKeys.length + ' key(s) configured').padEnd(37)}║`);
    }
    console.log(`╚══════════════════════════════════════════════════╝`);
    console.log(``);
  });

  // F6: Initialize webhook listeners
  initWebhooks();

  // Start loops
  discover();
  const discoveryIntervalMs = Math.max(1000, config.rpc.discoveryInterval);
  setInterval(discover, discoveryIntervalMs);

  // Self-scheduling poll loop: prevents overlapping when CDP calls are slow
  async function pollLoop(): Promise<void> {
    await updateSnapshots();      // HTML capture (only when enableSnapshot=true)
    await updateCdpTasks();       // CSS refresh, quota, auto-actions (always)
    // F2: Phase detection piggybacks on poll loop
    await updatePhases();
    setTimeout(() => void pollLoop(), POLL_INTERVAL);
  }
  void pollLoop();

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
