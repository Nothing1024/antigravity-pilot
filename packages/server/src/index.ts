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

  // WebSocket auth check
  wss.on("connection", (ws, req) => {
    const cookies = parseCookies(req.headers.cookie);
    if (!verifyToken(cookies.auth)) {
      ws.close(4001, "Unauthorized");
      return;
    }
    broadcastCascadeList(); // Send list on connect
  });

  server.listen(config.port, "0.0.0.0", () => {
    console.log(`🚀 Server running on port ${config.port}`);
  });

  // Start loops
  discover();
  setInterval(discover, DISCOVERY_INTERVAL);

  // Self-scheduling snapshot loop: prevents overlapping when CDP calls are slow
  async function snapshotLoop(): Promise<void> {
    await updateSnapshots();
    setTimeout(() => void snapshotLoop(), POLL_INTERVAL);
  }
  void snapshotLoop();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
