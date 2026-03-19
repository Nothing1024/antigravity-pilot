import WebSocket from "ws";

import type { CascadeEntry } from "../store/cascades";

import { config } from "../config";
import { connectCDP } from "../cdp/connection";
import { extractMetadata } from "../cdp/metadata";
import { captureCSS, captureComputedVars } from "../capture/css";
import { cascadeStore } from "../store/cascades";
import { broadcastCascadeList } from "../ws/broadcast";
import { getJson } from "../utils/network";
import { hashString } from "../utils/hash";
import { cascadeListSignature, resolveChatTitle } from "../utils/title";

export async function discover(): Promise<void> {
  // 1. Find all targets
  const allTargets: any[] = [];
  await Promise.all(
    config.cdpPorts.map(async (port) => {
      const list = await getJson<any[]>(`http://127.0.0.1:${port}/json/list`);
      const workbenches = list.filter(
        (t) => t.url?.includes("workbench.html") || t.title?.includes("workbench")
      );
      workbenches.forEach((t) => {
        allTargets.push({ ...t, port });
      });
    })
  );

  const oldMap = new Map(cascadeStore.entries());
  const newCascades = new Map<string, CascadeEntry>();

  // 2. Connect/Refresh
  for (const target of allTargets) {
    const id = hashString(target.webSocketDebuggerUrl);

    // Reuse existing
    if (oldMap.has(id)) {
      const existing = oldMap.get(id)!;
      if (existing.cdp.ws.readyState === WebSocket.OPEN) {
        // Refresh metadata
        const meta = await extractMetadata(existing.cdp);
        if (meta) {
          const resolvedTitle = resolveChatTitle({
            extractedTitle: meta.chatTitle,
            previousTitle: existing.metadata.chatTitle,
            windowTitle: target.title || existing.metadata.windowTitle,
            cascadeId: id
          });

          existing.metadata = {
            windowTitle: target.title || existing.metadata.windowTitle,
            chatTitle: resolvedTitle.title,
            titleSource: resolvedTitle.source,
            isActive: meta.isActive,
            mode: meta.mode
          };

          if (meta.contextId) existing.cdp.rootContextId = meta.contextId; // Update optimization
          newCascades.set(id, existing);
          continue;
        }
      }
    }

    // New connection
    try {
      console.log(`🔌 Connecting to ${target.title}`);
      const cdp = await connectCDP(target.webSocketDebuggerUrl);
      const meta = await extractMetadata(cdp);

      if (meta) {
        if (meta.contextId) cdp.rootContextId = meta.contextId;
        const resolvedTitle = resolveChatTitle({
          extractedTitle: meta.chatTitle,
          previousTitle: "",
          windowTitle: target.title,
          cascadeId: id
        });
        const cascade: CascadeEntry = {
          id,
          cdp,
          metadata: {
            windowTitle: target.title,
            chatTitle: resolvedTitle.title,
            titleSource: resolvedTitle.source,
            isActive: meta.isActive,
            mode: meta.mode
          },
          snapshot: null,
          css: await captureCSS(cdp),
          computedVars: await captureComputedVars(cdp),
          cssHash: null,
          cssRefreshCounter: 0,
          snapshotHash: null,
          quota: null,
          quotaHash: null,
          stableCount: 0,
          lastFeedbackFingerprint: null
        };
        newCascades.set(id, cascade);
        console.log(
          `✅ Added cascade: ${resolvedTitle.title} (${resolvedTitle.source})`
        );
      } else {
        cdp.ws.close();
      }
    } catch {
      // console.error(`Failed to connect to ${target.title}: ${e.message}`);
    }
  }

  // 3. Cleanup old
  for (const [id, c] of oldMap.entries()) {
    if (!newCascades.has(id)) {
      console.log(`👋 Removing cascade: ${c.metadata.chatTitle}`);
      try {
        c.cdp.ws.close();
      } catch {
        // ignore
      }
    }
  }

  const prevSignature = cascadeListSignature(oldMap as any);
  const nextSignature = cascadeListSignature(newCascades as any);
  const changed = prevSignature !== nextSignature;

  cascadeStore.clear();
  for (const [id, c] of newCascades.entries()) {
    cascadeStore.set(id, c);
  }

  if (changed) broadcastCascadeList();
}

