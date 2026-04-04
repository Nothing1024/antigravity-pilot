/**
 * Status API (F3) — System status, health check, and screenshot endpoints.
 */

import express from "express";

import type { SystemStatusResponse, CapabilitiesResponse } from "@ag/shared";
import { ConnectionState } from "@ag/shared";

import { cascadeStore } from "../store/cascades";
import { getPoolStats } from "../pool/health";
import { config } from "../config";

export const statusRouter: express.Router = express.Router();

const serverStartTime = Date.now();

// --- GET /api/health (public, no auth) ---
statusRouter.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// --- GET /api/capabilities ---
// Tells the frontend which server features are available, enabling conditional rendering
// of CDP-only vs RPC-only UI elements.
statusRouter.get("/api/capabilities", (_req, res) => {
  const cdpEnabled = config.cdp.enabled;
  const rpcEnabled = config.rpc.enabled;
  const snapshotEnabled = config.cdp.enableSnapshot;
  const fallbackToCDP = config.rpc.fallbackToCDP;

  // Determine the effective mode for frontend decisions
  let mode: "hybrid" | "cdp-only" | "rpc-only" | "disconnected";
  if (cdpEnabled && rpcEnabled) mode = "hybrid";
  else if (cdpEnabled) mode = "cdp-only";
  else if (rpcEnabled) mode = "rpc-only";
  else mode = "disconnected";

  // Check live connectivity
  const hasCdpConnection = cascadeStore.getAll().some((c) => c.cdp?.ws?.readyState === 1);

  const response: CapabilitiesResponse = {
    mode,
    cdp: {
      enabled: cdpEnabled,
      snapshot: snapshotEnabled,
      connected: hasCdpConnection,
    },
    rpc: {
      enabled: rpcEnabled,
      fallbackToCDP: fallbackToCDP,
    },
    features: {
      // CDP-only features
      simplify: cdpEnabled,
      screenshot: cdpEnabled,
      clickPassthrough: cdpEnabled && snapshotEnabled,
      scrollSync: cdpEnabled && snapshotEnabled,
      filePreview: cdpEnabled,
      // RPC features (available in both modes via fallback)
      messaging: rpcEnabled || cdpEnabled,
      trajectory: rpcEnabled,
      conversationHistory: rpcEnabled,
      modelSwitch: true, // works in both modes
      sessionSwitch: true, // works in both modes
      // Always available
      autoActions: true,
      pushNotifications: true,
    },
  };

  res.json(response);
});

// --- GET /api/status ---
statusRouter.get("/api/status", (_req, res) => {
  const cascades = cascadeStore.getAll();

  const response: SystemStatusResponse = {
    version: "4.0.0",
    uptime: Math.floor((Date.now() - serverStartTime) / 1000),
    cascades: cascades.map((c) => ({
      id: c.id,
      title: c.metadata.chatTitle,
      phase: c.phase,
      connected: c.connectionState === ConnectionState.CONNECTED,
      connectionState: c.connectionState,
      lastSnapshot: c.snapshotHash ? new Date().toISOString() : null,
      metadata: {
        chatTitle: c.metadata.chatTitle,
        windowTitle: c.metadata.windowTitle,
        isActive: c.metadata.isActive,
      },
    })),
    connectionPool: getPoolStats(),
  };

  res.json(response);
});

// --- GET /api/status/:cascadeId ---
statusRouter.get("/api/status/:cascadeId", (req, res) => {
  const c = cascadeStore.get(req.params.cascadeId);
  if (!c) return res.status(404).json({ error: "Cascade not found" });

  res.json({
    id: c.id,
    title: c.metadata.chatTitle,
    phase: c.phase,
    connected: c.connectionState === ConnectionState.CONNECTED,
    connectionState: c.connectionState,
    lastHealthCheck: new Date(c.lastHealthCheck).toISOString(),
    consecutiveFailures: c.consecutiveFailures,
    reconnectAttempts: c.reconnectAttempts,
    connectedAt: new Date(c.connectedAt).toISOString(),
    metadata: c.metadata,
    hasSnapshot: !!c.snapshot,
    responseText: c.responseText || "",
    lastPhaseChange: new Date(c.lastPhaseChange).toISOString(),
  });
});

// --- GET /api/screenshot/:cascadeId ---
statusRouter.get("/api/screenshot/:cascadeId", async (req, res) => {
  const c = cascadeStore.get(req.params.cascadeId);
  if (!c) return res.status(404).json({ error: "Cascade not found" });

  const format = (req.query.format as string) || "png";
  const quality = parseInt(req.query.quality as string) || 80;

  try {
    const result: any = await c.cdp.call("Page.captureScreenshot", {
      format: format === "jpeg" ? "jpeg" : "png",
      quality: format === "jpeg" ? quality : undefined,
    });

    if (result.data) {
      res.json({
        image: `data:image/${format};base64,${result.data}`,
        width: 0,   // CDP doesn't return dimensions in this call
        height: 0,
        timestamp: new Date().toISOString(),
      });
    } else {
      res.status(500).json({ error: "Screenshot capture failed" });
    }
  } catch (e: any) {
    res.status(500).json({ error: `Screenshot failed: ${e.message}` });
  }
});

// --- POST /api/stop/:cascadeId ---
statusRouter.post("/api/stop/:cascadeId", async (req, res) => {
  const c = cascadeStore.get(req.params.cascadeId);
  if (!c) return res.status(404).json({ error: "Cascade not found" });

  const previousPhase = c.phase;

  try {
    // Try to click the stop button first
    const contextId = c.cdp.rootContextId;
    if (contextId) {
      const result: any = await c.cdp.call("Runtime.evaluate", {
        expression: `(() => {
          const stopBtn = document.querySelector(
            '[data-tooltip-id*="stop"], [data-tooltip-id*="cancel"], button[aria-label*="Stop"]'
          );
          if (stopBtn) {
            stopBtn.click();
            return { clicked: true };
          }
          return { clicked: false };
        })()`,
        returnByValue: true,
        contextId,
      });

      if (result.result?.value?.clicked) {
        res.json({ success: true, previousPhase });
        return;
      }
    }

    // Fallback: send Escape key
    await c.cdp.call("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await c.cdp.call("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });

    res.json({ success: true, previousPhase, method: "escape" });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default statusRouter;
