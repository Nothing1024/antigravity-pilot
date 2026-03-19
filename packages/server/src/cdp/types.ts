import type WebSocket from "ws";

export type CDPExecutionContext = {
  id: number;
  [k: string]: unknown;
};

export type CDPCall = (method: string, params: unknown) => Promise<any>;

export type CDPConnection = {
  ws: WebSocket;
  call: CDPCall;
  contexts: CDPExecutionContext[];
  rootContextId: number | null;
};

