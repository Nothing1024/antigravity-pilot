import WebSocket from "ws";

import type { CDPConnection, CDPExecutionContext } from "./types";

export async function connectCDP(url: string): Promise<CDPConnection> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", (err) => reject(err));
  });

  // 统一管理所有 pending 的 CDP 呼叫
  const pendingCalls = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  let idCounter = 1;

  const call = (method: string, params: unknown) =>
    new Promise<any>((resolve, reject) => {
      const id = idCounter++;
      pendingCalls.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const contexts: CDPExecutionContext[] = [];
  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg as any);
      // 处理 CDP 指令响应
      if (data.id && pendingCalls.has(data.id)) {
        const { resolve, reject } = pendingCalls.get(data.id)!;
        pendingCalls.delete(data.id);
        if (data.error) reject(data.error);
        else resolve(data.result);
      }
      // 处理上下文挂载/销毁广播
      if (data.method === "Runtime.executionContextCreated") {
        contexts.push(data.params.context);
      } else if (data.method === "Runtime.executionContextDestroyed") {
        const idx = contexts.findIndex((c) => c.id === data.params.executionContextId);
        if (idx !== -1) contexts.splice(idx, 1);
      }
    } catch {
      // ignore
    }
  });

  await call("Runtime.enable", {});
  await new Promise((r) => setTimeout(r, 500)); // give time for contexts to load

  return { ws, call, contexts, rootContextId: null };
}

