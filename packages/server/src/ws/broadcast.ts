import WebSocket, { type WebSocketServer } from "ws";

import type { CascadeListItem, QuotaInfo, WSMessage } from "@ag/shared";

import { eventBus } from "../events/bus";
import { cascadeStore } from "../store/cascades";

let wss: WebSocketServer | null = null;

export function initBroadcast(next: WebSocketServer): void {
  wss = next;

  // --- Wire EventBus → WebSocket broadcast ---
  eventBus.on("phase_change", (ev) => {
    broadcast({
      type: "phase_change",
      cascadeId: ev.cascadeId,
      phase: ev.phase,
      previousPhase: ev.previousPhase,
    });
  });

  eventBus.on("connection_state", (ev) => {
    broadcast({
      type: "connection_state",
      cascadeId: ev.cascadeId,
      state: ev.state,
      previousState: ev.previousState,
    });
  });
}

export function broadcast(msg: WSMessage): void {
  if (!wss) return;
  const payload = JSON.stringify(msg);

  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) c.send(payload);
  });
}

export function broadcastCascadeList(): void {
  const list: Array<CascadeListItem & { quota: QuotaInfo | null }> = cascadeStore
    .getAll()
    .map((c) => {
      const wt = c.metadata.windowTitle ?? "";
      const workspace = wt.split(" — ")[0]?.trim() || wt.split(" - ")[0]?.trim() || "";
      return {
        id: c.id,
        title: c.metadata.chatTitle,
        window: c.metadata.windowTitle,
        workspace,
        active: c.metadata.isActive,
        phase: c.phase,
        connectionState: c.connectionState,
        quota: c.quota || null,
      };
    });

  broadcast({ type: "cascade_list", cascades: list });
}

