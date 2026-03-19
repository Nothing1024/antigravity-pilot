import WebSocket, { type WebSocketServer } from "ws";

import type { CascadeListItem, QuotaInfo, WSMessage } from "@ag/shared";

import { cascadeStore } from "../store/cascades";

let wss: WebSocketServer | null = null;

export function initBroadcast(next: WebSocketServer): void {
  wss = next;
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
    .map((c) => ({
      id: c.id,
      title: c.metadata.chatTitle,
      window: c.metadata.windowTitle,
      active: c.metadata.isActive,
      quota: c.quota || null
    }));

  broadcast({ type: "cascade_list", cascades: list });
}

