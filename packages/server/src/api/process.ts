import { exec, spawn } from "node:child_process";

import express from "express";

import { config } from "../config";
import { cascadeStore } from "../store/cascades";
import { checkPort } from "../utils/network";
import { checkProcessRunning } from "../utils/process";
import { broadcastCascadeList } from "../ws/broadcast";

export const processRouter: express.Router = express.Router();
export const router: express.Router = processRouter;
export default router;

// --- Launch Antigravity ---
processRouter.post("/api/launch", async (req, res) => {
  try {
    const port = req.body.port || 9000;
    const portOpen = await checkPort(port);

    console.log(`🔍 Status: port=${portOpen ? "open" : "closed"}`);

    // Port already open → already connected, nothing to do
    if (portOpen) {
      return res.json({ success: true, port, message: "Already connected" });
    }

    // Port not open → kill any existing Antigravity, then launch fresh with debug port
    const processRunning = await checkProcessRunning("Antigravity");
    if (processRunning) {
      console.log("🛑 Killing existing Antigravity (no debug port)...");
      const killCmd =
        process.platform === "darwin"
          ? 'osascript -e \'quit app "Antigravity"\' 2>/dev/null; sleep 1; pkill -f "Antigravity.app/" 2>/dev/null || true'
          : "taskkill /IM Antigravity.exe /F 2>nul || echo done";
      await new Promise((resolve) => {
        exec(killCmd, () => resolve(null));
      });
      await new Promise((r) => setTimeout(r, 1500)); // Wait for process to fully exit
    }

    console.log(`🚀 Launching Antigravity on port ${port}...`);

    let child;
    if (process.platform === "darwin") {
      child = spawn("open", ["-a", "Antigravity", "--args", `--remote-debugging-port=${port}`], {
        detached: true,
        stdio: "ignore"
      });
    } else {
      child = spawn(config.antigravityPath as string, [`--remote-debugging-port=${port}`], {
        detached: true,
        stdio: "ignore",
        windowsHide: false
      });
    }
    if (child) child.unref();

    // Wait for port to open (app startup takes a few seconds)
    let attempts = 15;
    while (attempts-- > 0) {
      await new Promise((r) => setTimeout(r, 1000));
      if (await checkPort(port)) {
        console.log(`🔥 Antigravity port ${port} is now open! (PID: ${child?.pid})`);
        return res.json({ success: true, pid: child?.pid, port });
      }
    }

    res.json({ success: false, error: "TIMEOUT" });
  } catch (e: any) {
    console.error("Launch failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// --- Kill All Antigravity ---
processRouter.post("/api/kill-all", async (req, res) => {
  try {
    console.log("🛑 Kill-all requested: closing all Antigravity instances...");

    // 1. Close all CDP WebSocket connections
    let closedCount = 0;
    for (const [id, c] of cascadeStore.entries()) {
      try {
        c.cdp.ws.close();
        closedCount++;
      } catch (e) {}
    }
    cascadeStore.clear();
    broadcastCascadeList(); // Notify frontend immediately

    // 2. Kill OS processes
    const killCmd =
      process.platform === "darwin"
        ? 'osascript -e \'quit app "Antigravity"\' 2>/dev/null; sleep 1; pkill -f "Antigravity.app/" 2>/dev/null || true'
        : "taskkill /IM Antigravity.exe /F 2>nul || echo done";

    await new Promise((resolve) => {
      exec(killCmd, (err, stdout, stderr) => {
        if (err) console.warn("Kill command warning:", err.message);
        resolve(null);
      });
    });

    // 3. Wait a moment and verify
    await new Promise((r) => setTimeout(r, 1000));
    const stillRunning = await checkProcessRunning("Antigravity");

    console.log(
      `🛑 Kill-all complete: ${closedCount} CDP connections closed, process ${stillRunning ? "still running" : "stopped"}`
    );
    res.json({
      success: !stillRunning,
      closedConnections: closedCount,
      processKilled: !stillRunning
    });
  } catch (e: any) {
    console.error("Kill-all failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// --- Close Single Cascade ---
processRouter.post("/api/close-cascade/:id", async (req, res) => {
  const { id } = req.params;
  const cascade = cascadeStore.get(id);
  if (!cascade) return res.status(404).json({ error: "Cascade not found" });

  try {
    console.log(`🔴 Closing cascade: "${cascade.metadata.chatTitle}" (${id})`);

    // Send window.close() via CDP to close the Electron window
    try {
      await cascade.cdp.call("Runtime.evaluate", {
        expression: "window.close()",
        contextId: cascade.cdp.rootContextId
      });
    } catch (e) {
      /* window may already be closing */
    }

    // Close CDP WebSocket connection
    try {
      cascade.cdp.ws.close();
    } catch (e) {}

    // Remove from cascades map
    cascadeStore.delete(id);
    broadcastCascadeList();

    console.log(`🔴 Cascade closed: ${id}`);
    res.json({ success: true, closedId: id });
  } catch (e: any) {
    console.error("Close cascade failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});
