import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path, { join } from "node:path";

import express from "express";

import { config } from "../config";
import { cascadeStore } from "../store/cascades";
import { checkPort } from "../utils/network";
import { checkProcessRunning } from "../utils/process";

export const projectRouter: express.Router = express.Router();
export const router: express.Router = projectRouter;
export default router;

// --- Project Browser APIs ---

// Get starting directory (parent of current workspace)
projectRouter.get("/api/workspace-root", (req, res) => {
  try {
    // Try to extract workspace path from connected cascades' windowTitle
    for (const c of cascadeStore.getAll()) {
      const title = c.metadata.windowTitle || "";
      // windowTitle format varies: "file.ext — ProjectName" or contains path info
      // Try to find a path-like segment
      const parts = title.split(" — ");
      if (parts.length >= 2) {
        const projectName = parts[parts.length - 1].replace(/\s*\[.*\]\s*$/, "").trim();
        // Check common workspace locations
        const candidates = [
          join(os.homedir(), "Documents", projectName),
          join(os.homedir(), "Projects", projectName),
          join(os.homedir(), "Desktop", projectName),
          join(os.homedir(), projectName)
        ];
        for (const candidate of candidates) {
          if (existsSync(candidate)) {
            const parent = path.dirname(candidate);
            return res.json({ root: parent, source: "cascade", projectName });
          }
        }
      }
    }
    // Fallback: home directory
    res.json({ root: os.homedir(), source: "fallback" });
  } catch (e) {
    res.json({ root: os.homedir(), source: "error" });
  }
});

// Browse directories
projectRouter.get("/api/browse", (req, res) => {
  try {
    const targetPath = path.resolve((req.query.path as string) || os.homedir());

    // Security: block sensitive system directories
    const blocked =
      process.platform === "darwin"
        ? ["/System", "/private", "/sbin", "/usr/sbin"]
        : ["C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)"];
    if (blocked.some((b) => targetPath.startsWith(b))) {
      return res.status(403).json({ error: "Access to system directories is restricted" });
    }

    if (!existsSync(targetPath)) {
      return res.status(404).json({ error: "Directory not found" });
    }

    const entries = readdirSync(targetPath, { withFileTypes: true });
    const folders = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => ({
        name: e.name,
        path: join(targetPath, e.name)
      }));

    const parentPath = path.dirname(targetPath);
    res.json({
      currentPath: targetPath,
      parentPath: parentPath !== targetPath ? parentPath : null,
      items: folders
    });
  } catch (e: any) {
    if (e.code === "EACCES" || e.code === "EPERM") {
      return res.status(403).json({ error: "Permission denied" });
    }
    res.status(500).json({ error: e.message });
  }
});

// Open a project folder in a new Antigravity window
projectRouter.post("/api/open-project", async (req, res) => {
  const { folder } = req.body;
  if (!folder) return res.status(400).json({ error: "folder is required" });

  if (!existsSync(folder)) {
    return res.status(404).json({ error: "Folder not found" });
  }

  try {
    const alreadyRunning = await checkProcessRunning("Antigravity");
    console.log(
      `📂 Open project: "${folder}" (Antigravity ${alreadyRunning ? "running" : "cold start"})`
    );

    let child;
    if (alreadyRunning) {
      // Already running → open folder in a new window
      // Strategy: try CLI tool first, then CDP, then `open -n -a` fallback
      let opened = false;
      let method = "none";

      // 1. Try the `antigravity` CLI tool (most reliable, like `code` for VS Code)
      try {
        child = spawn("antigravity", [folder, "--new-window"], {
          detached: true,
          stdio: "ignore",
          env: { ...process.env }
        });
        (child as any).on("error", () => {}); // suppress
        child.unref();
        opened = true;
        method = "cli";
        console.log(`✅ Opened via 'antigravity' CLI`);
      } catch (e: any) {
        console.warn("⚠️ antigravity CLI failed:", e.message);
      }

      // 2. Fallback: CDP spawn from within Electron renderer
      if (!opened && cascadeStore.getAll().length > 0) {
        const anyCascade = cascadeStore.getAll()[0];
        const escapedFolder = JSON.stringify(folder);
        try {
          for (const ctx of anyCascade.cdp.contexts || []) {
            try {
              const r = await anyCascade.cdp.call("Runtime.evaluate", {
                expression: `(() => {
                                        try {
                                            const cp = require('child_process');
                                            cp.spawn('antigravity', [${escapedFolder}, '--new-window'], {
                                                detached: true, stdio: 'ignore'
                                            }).unref();
                                            return { ok: true };
                                        } catch(e) { return { ok: false, error: e.message }; }
                                    })()`,
                returnByValue: true,
                contextId: ctx.id
              });
              if (r.result?.value?.ok) {
                opened = true;
                method = "cdp";
                console.log(`✅ CDP open-project succeeded via context ${ctx.id}`);
                break;
              }
            } catch (e) {
              continue;
            }
          }
        } catch (e: any) {
          console.warn("⚠️ CDP open-project failed:", e.message);
        }
      }

      // 3. Last resort: macOS `open` with -n (force new instance)
      if (!opened && process.platform === "darwin") {
        try {
          child = spawn("open", ["-n", "-a", "Antigravity", "--args", folder], {
            detached: true,
            stdio: "ignore"
          });
          (child as any).on("error", () => {});
          child.unref();
          opened = true;
          method = "open-n";
          console.log(`✅ Opened via 'open -n -a Antigravity'`);
        } catch (e: any) {
          console.error("❌ All open methods failed:", e.message);
        }
      }

      return res.json({ success: opened, alreadyRunning: true, method });
    } else {
      // Cold start → use port 9000
      const port = 9000;
      if (process.platform === "darwin") {
        child = spawn(
          "open",
          ["-a", "Antigravity", "--args", folder, `--remote-debugging-port=${port}`],
          {
            detached: true,
            stdio: "ignore"
          }
        );
      } else {
        child = spawn(config.antigravityPath as string, [folder, `--remote-debugging-port=${port}`], {
          detached: true,
          stdio: "ignore",
          windowsHide: false
        });
      }
      if (child) child.unref();

      // Wait for port to open
      let attempts = 15;
      while (attempts-- > 0) {
        await new Promise((r) => setTimeout(r, 1000));
        if (await checkPort(port)) {
          console.log(`🔥 Antigravity port ${port} is now open!`);
          return res.json({ success: true, alreadyRunning: false, port });
        }
      }
      res.json({ success: false, error: "TIMEOUT" });
    }
  } catch (e: any) {
    console.error("Open project failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// --- Antigravity-Manager Proxy ---
const managerHeaders = () => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${config.managerPassword}`,
  "x-api-key": config.managerPassword
});

projectRouter.get("/api/manager/accounts", async (req, res) => {
  if (!config.managerPassword) return res.status(501).json({ error: "Manager not configured" });
  try {
    const resp = await fetch(`${config.managerUrl}/api/accounts`, { headers: managerHeaders() });
    if (!resp.ok) return res.status(resp.status).json({ error: `Manager returned ${resp.status}` });
    res.json(await resp.json());
  } catch (e: any) {
    console.error("Manager accounts error:", e.message);
    res.status(502).json({ error: "Cannot reach Antigravity-Manager" });
  }
});

projectRouter.get("/api/manager/current", async (req, res) => {
  if (!config.managerPassword) return res.status(501).json({ error: "Manager not configured" });
  try {
    const resp = await fetch(`${config.managerUrl}/api/accounts/current`, { headers: managerHeaders() });
    if (!resp.ok) return res.status(resp.status).json({ error: `Manager returned ${resp.status}` });
    res.json(await resp.json());
  } catch (e) {
    res.status(502).json({ error: "Cannot reach Antigravity-Manager" });
  }
});

projectRouter.post("/api/manager/switch", async (req, res) => {
  if (!config.managerPassword) return res.status(501).json({ error: "Manager not configured" });
  const { accountId } = req.body;
  if (!accountId) return res.status(400).json({ error: "accountId required" });
  try {
    const resp = await fetch(`${config.managerUrl}/api/accounts/switch`, {
      method: "POST",
      headers: managerHeaders(),
      body: JSON.stringify({ accountId })
    });
    if (!resp.ok) return res.status(resp.status).json({ error: `Manager returned ${resp.status}` });
    // Verify switch
    const currentResp = await fetch(`${config.managerUrl}/api/accounts/current`, {
      headers: managerHeaders()
    });
    if (!currentResp.ok) {
      return res
        .status(currentResp.status)
        .json({ error: `Manager returned ${currentResp.status} during verification` });
    }
    const current = await currentResp.json();
    const verifiedId =
      current?.accountId ||
      current?.account_id ||
      current?.id ||
      current?.account?.id ||
      current?.current_account?.id ||
      current?.currentAccount?.id;
    if (verifiedId && verifiedId !== accountId) {
      return res
        .status(502)
        .json({ error: "Manager verification did not match requested account" });
    }
    const verifiedEmail =
      current?.email ||
      current?.account?.email ||
      current?.current_account?.email ||
      current?.currentAccount?.email ||
      verifiedId ||
      "unknown";
    console.log(`🔄 Account switched to: ${verifiedEmail}`);
    res.json({ success: true, current });
  } catch (e: any) {
    console.error("Manager switch error:", e.message);
    res.status(502).json({ error: "Cannot reach Antigravity-Manager" });
  }
});
