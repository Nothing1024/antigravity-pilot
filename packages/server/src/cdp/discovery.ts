import WebSocket from "ws";

import type { CascadeEntry } from "../store/cascades";

import { ConnectionState, ResponsePhase } from "@ag/shared";
import { config } from "../config";
import { connectCDP } from "./connection";
import { extractMetadata } from "./metadata";
import { injectSimplify } from "./simplify";
import { getSimplifyMode } from "./simplifyState";
import { captureCSS, captureComputedVars } from "../capture/css";
import { cascadeStore } from "../store/cascades";
import { broadcastCascadeList } from "../ws/broadcast";
import { getJson } from "../utils/network";
import { hashString } from "../utils/hash";
import { cascadeListSignature, resolveChatTitle } from "../utils/title";

// Tracks targets we've already attempted connecting to, to suppress repeated log messages.
// Entries are removed when the target connects successfully or disappears from CDP.
const pendingTargets = new Set<string>();

/**
 * Discover and maintain CDP-connected cascades (Antigravity IDE sessions).
 *
 * Note: CDP is still required for UI mirror (Shadow DOM snapshot) and as a
 * degradation fallback when RPC is unavailable.
 */
export async function discover(): Promise<void> {
  if (!config.cdp.enabled) {
    // CDP disabled: close existing connections and clear store to avoid leaking resources.
    const oldMap = new Map(cascadeStore.entries());
    if (oldMap.size > 0) {
      for (const [, c] of oldMap.entries()) {
        try {
          c.cdp.ws.close();
        } catch {
          // ignore
        }
      }
      cascadeStore.clear();
      broadcastCascadeList();
    }
    return;
  }

  // 1. Find all targets
  const allTargets: any[] = [];
  await Promise.all(
    config.cdp.ports.map(async (port) => {
      const list = await getJson<any[]>(`http://127.0.0.1:${port}/json/list`);
      // Match real workbench pages but exclude jetski-agent pages
      // (Settings, Manager, Launchpad use workbench-jetski-agent.html or
      //  workbench-jetski.html — we only want regular workbench.html)
      const isRealWorkbench = (t: any) => {
        const url = t.url || "";
        // Must contain workbench.html but NOT jetski variants
        if (url.includes("workbench-jetski")) return false;
        return url.includes("workbench.html") || t.title?.includes("workbench");
      };
      list
        .filter(isRealWorkbench)
        .forEach((t) => {
          allTargets.push({ ...t, port });
        });
    }),
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
            cascadeId: id,
          });

          existing.metadata = {
            windowTitle: target.title || existing.metadata.windowTitle,
            chatTitle: resolvedTitle.title,
            titleSource: resolvedTitle.source,
            isActive: meta.isActive,
            mode: meta.mode,
          };

          // Update connection state to CONNECTED (it was open)
          existing.connectionState = ConnectionState.CONNECTED;
          existing.consecutiveFailures = 0;

          if (meta.contextId) existing.cdp.rootContextId = meta.contextId; // Update optimization
          newCascades.set(id, existing);
          continue;
        }
      }
    }

    // New connection
    try {
      // Only log first connection attempt per target to avoid log spam
      // (targets without chat panel return null metadata every cycle)
      if (!pendingTargets.has(id)) {
        console.log(`🔌 Connecting to ${target.title}`);
        pendingTargets.add(id);
      }
      const cdp = await connectCDP(target.webSocketDebuggerUrl);
      const meta = await extractMetadata(cdp);

      if (meta) {
        if (meta.contextId) cdp.rootContextId = meta.contextId;
        const resolvedTitle = resolveChatTitle({
          extractedTitle: meta.chatTitle,
          previousTitle: "",
          windowTitle: target.title,
          cascadeId: id,
        });
        const now = Date.now();
        const cascade: CascadeEntry = {
          id,
          cdp,
          metadata: {
            windowTitle: target.title,
            chatTitle: resolvedTitle.title,
            titleSource: resolvedTitle.source,
            isActive: meta.isActive,
            mode: meta.mode,
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
          lastFeedbackFingerprint: null,

          // F1: Connection Pool fields
          connectionState: ConnectionState.CONNECTED,
          lastHealthCheck: now,
          consecutiveFailures: 0,
          reconnectAttempts: 0,
          connectedAt: now,
          reconnectTarget: {
            webSocketDebuggerUrl: target.webSocketDebuggerUrl,
            port: target.port,
            title: target.title,
          },

          // F2: Response Monitor fields
          phase: ResponsePhase.IDLE,
          responseText: "",
          lastPhaseChange: now,
        };
        newCascades.set(id, cascade);
        pendingTargets.delete(id); // connected successfully
        console.log(`✅ Added cascade: ${resolvedTitle.title} (${resolvedTitle.source})`);

        // Auto-apply simplify mode to newly discovered cascades
        const simplifyMode = getSimplifyMode();
        if (simplifyMode !== "off") {
          try {
            const result = await injectSimplify(cdp, simplifyMode);
            if (result.ok) {
              console.log(
                `🎨 Auto-applied simplify (${simplifyMode}) to new cascade "${resolvedTitle.title}"`,
              );
            }
          } catch {
            // Non-critical: simplify failure shouldn't block discovery
          }
        }
      } else {
        cdp.ws.close();
      }
    } catch {
      // silently retry next cycle
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

  // Clean up pending tracking for targets that disappeared from CDP
  const currentTargetIds = new Set(
    allTargets.map((t) => hashString(t.webSocketDebuggerUrl)),
  );
  for (const id of pendingTargets) {
    if (!currentTargetIds.has(id)) pendingTargets.delete(id);
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
