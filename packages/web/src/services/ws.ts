import type { WSMessage } from "@ag/shared";

type MessageListener = (msg: WSMessage) => void;

function wsUrl(): string {
  const override = import.meta.env.VITE_WS_URL as string | undefined;
  if (override) return override;

  const apiOrigin = import.meta.env.VITE_API_ORIGIN as string | undefined;
  const base = apiOrigin || window.location.origin;
  const url = new URL("/ws", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

class WsManager {
  #ws: WebSocket | null = null;
  #listeners = new Set<MessageListener>();
  #reconnectTimer: number | null = null;
  #backoffMs = 500;

  connect(): void {
    if (this.#ws && (this.#ws.readyState === WebSocket.OPEN || this.#ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const url = wsUrl();
    console.info(`[ws] connect ${url}`);
    const ws = new WebSocket(url);
    this.#ws = ws;

    ws.addEventListener("open", () => {
      console.info("[ws] open");
      this.#backoffMs = 500;
    });

    ws.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") return;
      let msg: WSMessage;
      try {
        msg = JSON.parse(ev.data) as WSMessage;
      } catch {
        return;
      }
      if (!msg || typeof (msg as any).type !== "string") return;
      this.#listeners.forEach((fn) => fn(msg));
    });

    ws.addEventListener("close", (ev) => {
      console.warn(`[ws] close ${ev.code} ${ev.reason || ""}`.trim());
      if (this.#ws === ws) this.#ws = null;
      this.#scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // "error" usually precedes "close"; keep logging minimal.
      console.warn("[ws] error");
    });
  }

  onMessage(fn: MessageListener): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer) return;
    const delay = this.#backoffMs;
    this.#backoffMs = Math.min(5000, this.#backoffMs * 2);

    this.#reconnectTimer = window.setTimeout(() => {
      this.#reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

export const wsManager = new WsManager();
