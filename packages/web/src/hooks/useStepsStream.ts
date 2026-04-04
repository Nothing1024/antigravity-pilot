import type { ConversationWSMessage, TrajectoryStep } from "@ag/shared";
import { useCallback, useEffect, useRef, useState } from "react";

type Result = {
  steps: TrajectoryStep[];
  stepCount: number | null;
  running: boolean;
  connected: boolean;
  error: string | null;
  /** Switch to a different conversation UUID over the existing WS */
  switchTo: (conversationId: string) => void;
};

function stepsWsUrl(cascadeId: string): string {
  const apiOrigin = import.meta.env.VITE_API_ORIGIN as string | undefined;
  const base = apiOrigin || window.location.origin;
  const url = new URL(
    `/api/conversations/${encodeURIComponent(cascadeId)}/ws`,
    base,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function useStepsStream(cascadeId: string | null): Result {
  const [steps, setSteps] = useState<TrajectoryStep[]>([]);
  const [stepCount, setStepCount] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    wsRef.current?.close();
    wsRef.current = null;

    setSteps([]);
    setStepCount(null);
    setRunning(false);
    setConnected(false);
    setError(null);

    if (!cascadeId) return;

    const url = stepsWsUrl(cascadeId);
    // React StrictMode (dev) 会 double-invoke effects，导致 WS “未建立即关闭”的噪音警告。
    // 延迟到下一个 tick 创建 WS：如果立即被卸载，我们会 cancel 掉，避免创建无用连接。
    let cancelled = false;
    let ws: WebSocket | null = null;

    const timer = window.setTimeout(() => {
      if (cancelled) return;

      console.info(`[steps-ws] connect ${url}`);
      ws = new WebSocket(url);
      wsRef.current = ws;

      ws.addEventListener("open", () => {
        setConnected(true);
        setError(null);
        // 主动刷新一次，确保立刻拿到完整 steps（兼容服务端 IDLE→ACTIVE 切换）
        ws?.send(JSON.stringify({ type: "refresh" }));
      });

      ws.addEventListener("message", (ev) => {
        if (typeof ev.data !== "string") return;
        let msg: ConversationWSMessage;
        try {
          msg = JSON.parse(ev.data) as ConversationWSMessage;
        } catch {
          return;
        }
        if (!msg || typeof (msg as any).type !== "string") return;

        if (msg.type === "ready") {
          setStepCount(typeof msg.stepCount === "number" ? msg.stepCount : null);
          return;
        }

        if (msg.type === "status") {
          setRunning(!!msg.running);
          return;
        }

        if (msg.type === 'steps') {
          if (!Array.isArray(msg.steps) || typeof msg.offset !== "number") return;

          setStepCount((prev) =>
            Math.max(prev ?? 0, msg.offset + msg.steps.length),
          );

          // enriched=true means full content from GetCascadeTrajectory — replace entirely
          if ((msg as any).enriched && msg.offset === 0) {
            setSteps(msg.steps);
            return;
          }

          setSteps((prev) => {
            const endOffset = msg.offset + msg.steps.length;

            // ① offset 在已有数组内：替换重叠部分（用新数据覆盖旧数据）
            if (msg.offset < prev.length) {
              const next = prev.slice();
              if (endOffset > next.length) next.length = endOffset;
              for (let i = 0; i < msg.steps.length; i += 1) {
                // Only overwrite if the new step has more content
                const existing = next[msg.offset + i];
                const incoming = msg.steps[i];
                if (!existing?.content?.text && incoming?.content?.text) {
                  next[msg.offset + i] = incoming;
                } else if (!existing) {
                  next[msg.offset + i] = incoming;
                }
                // Otherwise keep the enriched version
              }
              return next;
            }

            // ② offset 在末尾或更远：直接追加（保持简单；gap 理论上不应出现）
            if (msg.offset > prev.length) {
              const padded = prev.slice();
              for (let i = padded.length; i < msg.offset; i += 1) {
                padded.push({
                  stepId: `missing-${i}`,
                  type: "PLANNER_RESPONSE",
                  status: "ERROR",
                  content: { text: "[missing step]" },
                  _corrupted: true,
                });
              }
              return padded.concat(msg.steps);
            }

            return prev.concat(msg.steps);
          });
        }
      });

      ws.addEventListener("close", () => {
        setConnected(false);
        if (wsRef.current === ws) wsRef.current = null;
      });

      ws.addEventListener("error", () => {
        setError("WebSocket error");
      });
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      ws?.close();
      if (wsRef.current === ws) wsRef.current = null;
    };
  }, [cascadeId]);

  const switchTo = useCallback((conversationId: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // Reset local state
    setSteps([]);
    setStepCount(null);
    setRunning(false);
    // Tell server to switch
    ws.send(JSON.stringify({ type: "switchTo", conversationId }));
  }, []);

  return { steps, stepCount, running, connected, error, switchTo };
}
