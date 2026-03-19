import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import express from "express";

import { autoActionSettings } from "../autoaction/index";
import { config } from "../config";
import { addSubscription, removeSubscription } from "../push/sender";
import { cascadeStore } from "../store/cascades";

export const cascadeRouter: express.Router = express.Router();
export const router: express.Router = cascadeRouter;
export default router;

// API Routes
cascadeRouter.get("/cascades", (req, res) => {
  res.json(
    cascadeStore.getAll().map((c) => ({
      id: c.id,
      title: c.metadata.chatTitle,
      active: c.metadata.isActive
    }))
  );
});

cascadeRouter.get("/snapshot/:id", (req, res) => {
  const c = cascadeStore.get(req.params.id);
  if (!c || !c.snapshot) return res.status(404).json({ error: "Not found" });
  res.json(c.snapshot);
});

cascadeRouter.get("/api/quota/:id", (req, res) => {
  const c = cascadeStore.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Not found" });
  res.json(c.quota || { statusText: "", planName: null, models: [] });
});

// --- Active Tab Name API (lightweight, for before/after click detection) ---
cascadeRouter.get("/api/active-tab-name/:id", async (req, res) => {
  const c = cascadeStore.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Cascade not found" });

  try {
    const allContexts = c.cdp.contexts || [];
    for (const ctx of allContexts) {
      try {
        const r = await c.cdp.call("Runtime.evaluate", {
          expression: `(() => {
                            const tab = document.querySelector('.tab.active.selected[data-resource-name]');
                            return tab ? tab.getAttribute('data-resource-name') : null;
                        })()`,
          returnByValue: true,
          contextId: ctx.id
        });
        if (r.result?.value) {
          return res.json({ name: r.result.value });
        }
      } catch (e) {
        continue;
      }
    }
    res.json({ name: null });
  } catch (e) {
    res.json({ name: null });
  }
});

// --- Active File API (reads from Editor's active tab via CDP) ---
cascadeRouter.get("/api/active-file/:id", async (req, res) => {
  const c = cascadeStore.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Cascade not found" });

  try {
    // Step 1: Find the main window context (not the chat iframe)
    // rootContextId is the chat iframe context — tabs live in the main window
    const allContexts = c.cdp.contexts || [];
    let tabInfo = null;
    let mainContextId = null;

    for (const ctx of allContexts) {
      try {
        const r = await c.cdp.call("Runtime.evaluate", {
          expression: `(() => {
                            const tab = document.querySelector('.tab.active.selected[data-resource-name]');
                            if (!tab) return null;
                            const name = tab.getAttribute('data-resource-name') || '';
                            const iconLabel = tab.querySelector('.monaco-icon-label');
                            const ariaLabel = iconLabel?.getAttribute('aria-label') || '';
                            const labelDesc = tab.querySelector('.label-description')?.textContent?.trim() || '';
                            // title attribute often contains the full absolute path
                            const tabTitle = tab.getAttribute('title') || '';
                            const iconTitle = iconLabel?.getAttribute('title') || '';
                            // Also check the label-name element
                            const labelName = tab.querySelector('.label-name')?.getAttribute('title') || '';
                            return { name, ariaLabel, labelDesc, tabTitle, iconTitle, labelName };
                        })()`,
          returnByValue: true,
          contextId: ctx.id
        });
        if (r.result?.value) {
          tabInfo = r.result.value;
          mainContextId = ctx.id;
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (!tabInfo) {
      return res.status(404).json({ error: "No active editor tab found" });
    }

    // Step 2: Check if it's a system artifact (.resolved file)
    if (tabInfo.name.endsWith(".resolved")) {
      // Extract rendered HTML from artifact-view (also in the main context)
      const htmlResult = await c.cdp.call("Runtime.evaluate", {
        expression: `(() => {
                        const content = document.querySelector('.artifact-view .leading-relaxed.select-text');
                        if (!content) return null;
                        return content.innerHTML;
                    })()`,
        returnByValue: true,
        contextId: mainContextId
      });
      const html = htmlResult.result?.value;
      if (!html) {
        return res.status(404).json({ error: "Could not extract artifact content" });
      }
      const artifactType = tabInfo.name.replace(".md.resolved", "").replace(/_/g, " ");
      const capitalizedType = artifactType.charAt(0).toUpperCase() + artifactType.slice(1);
      return res.json({
        type: "artifact",
        name: `${capitalizedType}: ${tabInfo.labelDesc}`,
        html
      });
    }

    // Step 3: Normal file — resolve full path and read content
    console.log(`🔍 [file-preview] Raw tabInfo:`, JSON.stringify(tabInfo));

    // Clean up ariaLabel
    let filePath = (tabInfo.ariaLabel || "")
      .replace(/\s•\s.*$/, "") // strip " • Modified/Untracked" etc.
      .replace(/\s*\(preview[^)]*\)/, "") // strip "(preview ◎)"
      .trim();

    console.log(`🔍 [file-preview] ariaLabel path: "${filePath}"`);

    // If ariaLabel only has filename (no path separator), try hover tooltip
    if (filePath && !filePath.includes("/") && !filePath.includes("~")) {
      console.log(`🔍 [file-preview] ariaLabel has no path, trying hover tooltip...`);
      try {
        // Step A: Dismiss all existing hover widgets first
        await c.cdp.call("Runtime.evaluate", {
          expression: `(() => {
                            document.querySelectorAll('.monaco-hover, .workbench-hover').forEach(h => {
                                h.style.display = 'none';
                            });
                        })()`,
          contextId: mainContextId
        });
        // Move mouse to neutral position to clear hovers
        await c.cdp.call("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: 0,
          y: 0
        });
        await new Promise((r) => setTimeout(r, 300));

        // Step B: Get tab position and hover on it
        const posResult = await c.cdp.call("Runtime.evaluate", {
          expression: `(() => {
                            const tab = document.querySelector('.tab.active.selected[data-resource-name]');
                            if (!tab) return null;
                            const rect = tab.getBoundingClientRect();
                            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
                        })()`,
          returnByValue: true,
          contextId: mainContextId
        });
        const pos = posResult.result?.value;
        if (pos) {
          await c.cdp.call("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: pos.x,
            y: pos.y
          });
          // Wait for tab tooltip to appear
          await new Promise((r) => setTimeout(r, 1000));

          // Step C: Find the VISIBLE tooltip that contains a path
          const tooltipResult = await c.cdp.call("Runtime.evaluate", {
            expression: `(() => {
                                // Look for all hover containers, find one with a path-like string
                                const hovers = document.querySelectorAll(
                                    '.workbench-hover-container, .monaco-hover'
                                );
                                for (const h of hovers) {
                                    const style = getComputedStyle(h);
                                    if (style.display === 'none' || style.visibility === 'hidden') continue;
                                    const text = h.textContent?.trim() || '';
                                    // Tab tooltip contains ~ or / path, filter out code hovers
                                    if (text.includes('/') || text.startsWith('~')) {
                                        return text;
                                    }
                                }
                                return null;
                            })()`,
            returnByValue: true,
            contextId: mainContextId
          });
          const tooltipText = tooltipResult.result?.value;
          if (tooltipText) {
            const cleanedTooltip = tooltipText
              .replace(/\s•\s.*$/, "")
              .replace(/\s*\(preview[^)]*\)/, "")
              .trim();
            console.log(`🔍 [file-preview] Tooltip path: "${cleanedTooltip}"`);
            if (cleanedTooltip.includes("/") || cleanedTooltip.startsWith("~")) {
              filePath = cleanedTooltip;
            }
          } else {
            console.log(`🔍 [file-preview] No path-like tooltip found`);
          }

          // Step D: Dismiss tooltip
          await c.cdp.call("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: 0,
            y: 0
          });
        }
      } catch (e: any) {
        console.log(`🔍 [file-preview] Hover tooltip failed:`, e.message);
      }
    }

    if (!filePath) {
      return res.status(404).json({ error: "No file path in active tab" });
    }
    // Expand ~ to home directory
    if (filePath.startsWith("~")) {
      filePath = filePath.replace("~", os.homedir());
    }

    console.log(`📂 [file-preview] Resolved path: "${filePath}"`);

    try {
      const stat = statSync(filePath);
      if (stat.size > 1024 * 1024) {
        return res.status(413).json({ error: "File too large (>1MB)" });
      }
      const content = readFileSync(filePath, "utf-8");
      const ext = path.extname(filePath).toLowerCase().slice(1);
      const filename = path.basename(filePath);
      res.json({ type: "file", content, filename, ext, path: filePath });
    } catch (e: any) {
      console.error(`❌ [file-preview] Read failed: ${e.code} — "${filePath}"`);
      if (e.code === "ENOENT") return res.status(404).json({ error: `File not found: ${filePath}` });
      res.status(500).json({ error: e.message });
    }
  } catch (e: any) {
    console.error("Active file error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// --- Close Active Tab API (sync file close from web UI to IDE) ---
cascadeRouter.post("/api/close-tab/:id", async (req, res) => {
  const c = cascadeStore.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Cascade not found" });

  try {
    // Safety: check how many editor tabs are open before closing
    // If 0 tabs, skip (nothing to close). Otherwise send Cmd+W.
    const allContexts = c.cdp.contexts || [];
    let tabCount = 0;
    for (const ctx of allContexts) {
      try {
        const r = await c.cdp.call("Runtime.evaluate", {
          expression: `document.querySelectorAll('.tab[data-resource-name]').length`,
          returnByValue: true,
          contextId: ctx.id
        });
        if (r.result?.value !== undefined && r.result.value > 0) {
          tabCount = r.result.value;
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (tabCount === 0) {
      console.log(`📋 Skip close-tab: no editor tabs open`);
      return res.json({ success: false, skipped: true, reason: "no tabs open" });
    }

    // Tabs exist — send Cmd+W / Ctrl+W to close the active one
    const modifier = process.platform === "darwin" ? 4 : 2; // 4=Meta(Cmd), 2=Ctrl

    await c.cdp.call("Input.dispatchKeyEvent", {
      type: "keyDown",
      modifiers: modifier,
      windowsVirtualKeyCode: 87, // W
      key: "w",
      code: "KeyW"
    });
    await c.cdp.call("Input.dispatchKeyEvent", {
      type: "keyUp",
      modifiers: modifier,
      windowsVirtualKeyCode: 87,
      key: "w",
      code: "KeyW"
    });

    console.log(`📋 Close tab forwarded for "${c.metadata.chatTitle}" (${tabCount} tabs open)`);
    res.json({ success: true });
  } catch (e: any) {
    console.error("Close tab error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// --- Push Notification Routes ---
cascadeRouter.get("/api/push/vapid-key", (req, res) => {
  res.json({ publicKey: config.vapidKeys.publicKey });
});

cascadeRouter.post("/api/push/subscribe", (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint) return res.status(400).json({ error: "Invalid subscription" });
  addSubscription(sub);
  res.json({ success: true });
});

cascadeRouter.post("/api/push/unsubscribe", (req, res) => {
  const { endpoint } = req.body;
  removeSubscription(endpoint);
  res.json({ success: true });
});

cascadeRouter.get("/styles/:id", (req, res) => {
  const c = cascadeStore.get(req.params.id);
  if (!c) return res.status(404).json({ error: "Not found" });
  res.json({ css: c.css || "", computedVars: c.computedVars || {} });
});

// Alias for simple single-view clients (returns first active or first available)
cascadeRouter.get("/snapshot", (req, res) => {
  const all = cascadeStore.getAll();
  const active = all.find((c) => c.metadata.isActive) || all[0];
  if (!active || !active.snapshot) return res.status(503).json({ error: "No snapshot" });
  res.json(active.snapshot);
});

// --- Auto-Action Settings ---
cascadeRouter.get("/api/auto-actions", (_req, res) => {
  res.json({
    autoAcceptAll: autoActionSettings.autoAcceptAll,
    autoRetry: autoActionSettings.autoRetry,
    retryBackoff: autoActionSettings.retryBackoff
  });
});

cascadeRouter.put("/api/auto-actions", (req, res) => {
  const { autoAcceptAll, autoRetry, retryBackoff } = req.body;
  if (typeof autoAcceptAll === "boolean") autoActionSettings.autoAcceptAll = autoAcceptAll;
  if (typeof autoRetry === "boolean") autoActionSettings.autoRetry = autoRetry;
  if (typeof retryBackoff === "boolean") autoActionSettings.retryBackoff = retryBackoff;

  console.log(
    `⚙️ Auto-actions updated: acceptAll=${autoActionSettings.autoAcceptAll}, retry=${autoActionSettings.autoRetry}, backoff=${autoActionSettings.retryBackoff}`
  );

  res.json({
    autoAcceptAll: autoActionSettings.autoAcceptAll,
    autoRetry: autoActionSettings.autoRetry,
    retryBackoff: autoActionSettings.retryBackoff
  });
});
