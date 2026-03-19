import type { WSMessage } from "@ag/shared";
import { useEffect } from "react";

import { wsManager } from "../services/ws";
import { useCascadeStore } from "../stores/cascadeStore";
import { useUIStore } from "../stores/uiStore";

function handleMessage(msg: WSMessage): void {
  switch (msg.type) {
    case "cascade_list":
      useCascadeStore.getState().setCascades(msg.cascades);
      console.info(`[ws] cascade_list (${msg.cascades.length})`);
      return;
    case "snapshot_update":
      // Handled directly by useSnapshot hook via WS push
      return;
    case "css_update":
      console.info(`[ws] css_update ${msg.cascadeId}`);
      return;
    case "ai_complete":
      console.info(`[ws] ai_complete ${msg.cascadeId} ${msg.title}`);
      useUIStore.getState().addToast({
        message: `AI completed: ${msg.title || "Task finished"}`,
        type: "success",
        duration: 6000
      });
      return;
    case "quota_update":
      useCascadeStore.getState().setQuota(msg.cascadeId, msg.quota);
      console.info(`[ws] quota_update ${msg.cascadeId}`);
      return;
    case "auto_action": {
      const label =
        msg.action === "accept_all" ? "Auto Accept All" : "Auto Retry";
      console.info(`[ws] auto_action ${msg.action} on ${msg.cascadeId}`);
      useUIStore.getState().addToast({
        message: `${label}: ${msg.title || ""}`,
        type: "info",
        duration: 4000
      });
      return;
    }
    default: {
      const _exhaustive: never = msg;
      return _exhaustive;
    }
  }
}

export function useWebSocket(): void {
  useEffect(() => {
    wsManager.connect();
    const off = wsManager.onMessage(handleMessage);
    return () => off();
  }, []);
}
