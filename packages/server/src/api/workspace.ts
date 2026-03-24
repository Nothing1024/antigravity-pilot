/**
 * Workspace API — Query and manage Antigravity IDE working directories.
 *
 * Endpoints:
 *   GET  /api/workspace/:cascadeId  — Get current workspace folder
 *   POST /api/workspace/launch      — Launch new IDE instance with a specific folder
 *   GET  /api/workspaces            — List all cascades with their workspace folders
 */

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

import express from "express";

import { cascadeStore } from "../store/cascades";
import { config } from "../config";
import { getDefaultAntigravityPath } from "../utils/process";

export const workspaceRouter: express.Router = express.Router();

// --- CDP script to extract workspace folder ---

const GET_WORKSPACE_SCRIPT = `(() => {
  // Strategy 1: Extract from window title (most reliable)
  // Format: "filename — projectName — Antigravity" or "projectFolder — Antigravity"
  const title = document.title || '';
  const parts = title.split(/\\s*[—–-]\\s*/);

  // Strategy 2: Look for breadcrumb or path indicators in the UI
  const pathSelectors = [
    '[class*="breadcrumb"] [class*="path"]',
    '[class*="workspace"][class*="name"]',
    '[class*="folder"][class*="name"]',
    '[data-tooltip-id*="workspace"]',
    '.explorer-viewlet .title',
  ];

  let workspacePath = null;

  for (const sel of pathSelectors) {
    const el = document.querySelector(sel);
    if (el) {
      const text = (el.textContent || '').trim();
      if (text && text.length < 200) {
        workspacePath = text;
        break;
      }
    }
  }

  // Strategy 3: Extract from title bar
  // "projectName — Antigravity" → projectName is last before "Antigravity"
  let titleFolder = null;
  if (parts.length >= 2) {
    // Remove "Antigravity" label from the end
    const clean = parts.filter(p => !p.toLowerCase().includes('antigravity'));
    if (clean.length > 0) {
      titleFolder = clean[clean.length - 1].trim();
    }
  }

  return {
    windowTitle: title,
    workspacePath: workspacePath,
    titleFolder: titleFolder,
    parts: parts,
  };
})()`;

// --- GET /api/workspace/:cascadeId — Get workspace info for a cascade ---
workspaceRouter.get("/api/workspace/:cascadeId", async (req, res) => {
  const c = cascadeStore.get(req.params.cascadeId);
  if (!c) return res.status(404).json({ error: "Cascade not found" });

  const contextId = c.cdp.rootContextId;

  // Try to extract workspace from DOM
  let workspaceInfo: any = null;
  if (contextId) {
    try {
      const result: any = await c.cdp.call("Runtime.evaluate", {
        expression: GET_WORKSPACE_SCRIPT,
        returnByValue: true,
        contextId,
      });
      workspaceInfo = result.result?.value;
    } catch {
      // ignore
    }
  }

  // Also extract from CDP target info
  const reconnectTarget = c.reconnectTarget;

  res.json({
    cascadeId: c.id,
    chatTitle: c.metadata.chatTitle,
    windowTitle: c.metadata.windowTitle,
    workspace: {
      fromTitle: workspaceInfo?.titleFolder || null,
      fromDOM: workspaceInfo?.workspacePath || null,
      cdpTarget: reconnectTarget?.title || null,
    },
  });
});

// --- GET /api/workspaces — List all cascades with workspace info ---
workspaceRouter.get("/api/workspaces", (_req, res) => {
  const cascades = cascadeStore.getAll();

  const workspaces = cascades.map((c) => {
    // Extract folder name from window title
    const parts = c.metadata.windowTitle.split(/\s*[—–-]\s*/);
    const clean = parts.filter(
      (p) => !p.toLowerCase().includes("antigravity")
    );
    const folder = clean.length > 0 ? clean[clean.length - 1].trim() : null;

    return {
      cascadeId: c.id,
      chatTitle: c.metadata.chatTitle,
      windowTitle: c.metadata.windowTitle,
      folder,
      phase: c.phase,
      connectionState: c.connectionState,
    };
  });

  res.json({ workspaces });
});

// --- Used CDP ports tracker ---
const launchedPorts = new Set<number>();

/**
 * Find an available CDP port (not in config.cdp.ports and not already launched).
 */
function findAvailablePort(): number {
  const usedPorts = new Set([...config.cdp.ports, ...launchedPorts]);
  // Start from 9100 to avoid conflicts with default ports
  for (let port = 9100; port < 9200; port++) {
    if (!usedPorts.has(port)) return port;
  }
  throw new Error("No available CDP ports in range 9100-9200");
}

// --- POST /api/workspace/launch — Launch new IDE with specific folder ---
workspaceRouter.post("/api/workspace/launch", async (req, res) => {
  const { folder, cdpPort } = req.body;

  if (!folder) {
    return res.status(400).json({ error: "folder is required" });
  }

  // Validate folder exists
  const resolvedFolder = path.resolve(folder);
  if (!existsSync(resolvedFolder)) {
    return res.status(400).json({
      error: `Folder does not exist: ${resolvedFolder}`,
    });
  }

  const stat = statSync(resolvedFolder);
  if (!stat.isDirectory()) {
    return res.status(400).json({
      error: `Path is not a directory: ${resolvedFolder}`,
    });
  }

  // Check if any existing cascade already has this folder open
  const existing = cascadeStore.getAll().find((c) => {
    const title = c.metadata.windowTitle.toLowerCase();
    const folderName = path.basename(resolvedFolder).toLowerCase();
    return title.includes(folderName);
  });

  if (existing) {
    return res.json({
      success: true,
      action: "existing",
      message: `Folder appears to be already open in cascade "${existing.metadata.chatTitle}"`,
      cascadeId: existing.id,
      chatTitle: existing.metadata.chatTitle,
    });
  }

  // Determine CDP port
  let port: number;
  try {
    port = cdpPort || findAvailablePort();
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }

  // Get Antigravity executable path
  const antigravityPath =
    config.antigravityPath || getDefaultAntigravityPath();

  if (!antigravityPath || !existsSync(antigravityPath)) {
    return res.status(500).json({
      error: `Antigravity executable not found at: ${antigravityPath}`,
    });
  }

  try {
    // Launch Antigravity IDE with the folder and CDP port
    if (process.platform === "darwin") {
      // macOS: use `open -a` for proper .app bundle handling
      const appPath = antigravityPath.includes(".app")
        ? antigravityPath.replace(/\/Contents\/MacOS\/.*$/, "")
        : antigravityPath;

      spawn("open", ["-a", appPath, resolvedFolder, "--args", `--remote-debugging-port=${port}`], {
        detached: true,
        stdio: "ignore",
      }).unref();
    } else {
      // Linux/Windows: direct launch
      spawn(antigravityPath, [resolvedFolder, `--remote-debugging-port=${port}`], {
        detached: true,
        stdio: "ignore",
      }).unref();
    }

    // Track the port and add to config.cdp.ports for discovery
    launchedPorts.add(port);
    if (!config.cdp.ports.includes(port)) {
      config.cdp.ports.push(port);
    }

    console.log(
      `🚀 Launched Antigravity IDE for "${resolvedFolder}" on CDP port ${port}`
    );

    res.json({
      success: true,
      action: "launched",
      folder: resolvedFolder,
      cdpPort: port,
      message: `Antigravity IDE launching. It will appear in /api/status within ~10s after startup.`,
      hint: "Use GET /api/status to check when the cascade is discovered.",
    });
  } catch (e: any) {
    return res.status(500).json({
      error: `Failed to launch Antigravity IDE: ${e.message}`,
    });
  }
});

export default workspaceRouter;
